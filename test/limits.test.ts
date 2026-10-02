// Usage limits the agents write into their transcripts: error items with a reset time, and one `limit` alert per hit.
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ItemLog } from '../src/jsonl.ts';
import type { Session } from '../src/protocol.ts';
import { LimitAlerts } from '../src/provider.ts';
import { ClaudeMetaScan, parseClaudeLine, resetsFromText } from '../src/providers/claude-code/parse.ts';
import { ClaudeCodeProvider } from '../src/providers/claude-code/provider.ts';
import { CodexMetaScan, codexLineParser } from '../src/providers/codex/parse.ts';
import { CodexProvider } from '../src/providers/codex/provider.ts';
import { recordingHub } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'wristline-limits-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** The record Claude Code 2.1.286 writes when a prompt hits the 5-hour limit (fields the bridge reads). */
function claudeLimit(ts: string, resetsAt = 1790713800, uuid = `u-${ts}`): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: ts,
    isSidechain: false,
    isApiErrorMessage: true,
    error: 'rate_limit',
    apiErrorStatus: 429,
    quotaLimits: { status: 'rejected', resetsAt, rateLimitType: 'five_hour', overageStatus: 'rejected' },
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 5:30am (Asia/Seoul)" }] },
  });
}

const TRY_AGAIN = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 25th, 2026 1:21 PM.";
const NO_CREDITS = 'Your workspace is out of credits. Add credits to continue.';

/**
 * Codex 0.159: the rate-limit snapshot written just before a failed turn (`codex`), the one of
 * another limit id (`premium`, without windows; it carries `rate_limit_reached_type` when credits
 * ran out), then the turn's `task_complete` with the error.
 */
function codexLimit(ts: string, { info = 'usage_limit_exceeded', message = TRY_AGAIN, primary = 27, secondary = 100, reached = null as string | null } = {}): string[] {
  return [
    JSON.stringify({
      timestamp: ts,
      type: 'event_msg',
      payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: primary, window_minutes: 300, resets_at: 1789560980 }, secondary: { used_percent: secondary, window_minutes: 10080, resets_at: 1789810635 }, rate_limit_reached_type: null } },
    }),
    JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'premium', primary: null, secondary: null, rate_limit_reached_type: reached } } }),
    JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', turn_id: `t-${ts}`, last_agent_message: null, error: { message, codex_error_info: info } } }),
  ];
}

test('claude-code: an API error message is an error item; a usage limit carries quotaLimits.resetsAt, else the time in its text', () => {
  const log = new ItemLog();
  parseClaudeLine(claudeLimit('2026-09-29T17:26:37.846Z'), log);
  parseClaudeLine(JSON.stringify({ type: 'assistant', uuid: 'e', timestamp: '2026-09-29T17:27:00.000Z', isApiErrorMessage: true, error: 'server_error', message: { content: [{ type: 'text', text: 'API Error: 500' }] } }), log);
  parseClaudeLine(JSON.stringify({ type: 'assistant', uuid: 'a', timestamp: '2026-09-29T17:28:00.000Z', message: { content: [{ type: 'text', text: 'Done.' }] } }), log);
  // Without quotaLimits: the next 1:10am in Seoul after the record (02:29 there) is the next day's.
  parseClaudeLine(JSON.stringify({ ...JSON.parse(claudeLimit('2026-09-29T17:29:00.000Z', 0, 'q')), quotaLimits: undefined, message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 1:10am (Asia/Seoul)" }] } }), log);
  // Claude Code 2.1.285: a model that needs usage credits.
  parseClaudeLine(
    JSON.stringify({ type: 'assistant', uuid: 'c', timestamp: '2026-09-30T12:59:41.023Z', isApiErrorMessage: true, error: 'rate_limit', apiError: 'model_requires_usage_credits', apiErrorStatus: 429, message: { model: '<synthetic>', content: [{ type: 'text', text: "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model." }] } }),
    log,
  );
  assert.deepEqual(
    log.page(undefined, 10).items.map(({ text, error, resetsAt, limitKind }) => ({ text: text.slice(0, 30), error, resetsAt, limitKind })),
    [
      { text: "You've hit your session limit ", error: true, resetsAt: '2026-09-29T20:30:00.000Z', limitKind: 'window' },
      { text: 'API Error: 500', error: true, resetsAt: undefined, limitKind: undefined },
      { text: 'Done.', error: undefined, resetsAt: undefined, limitKind: undefined },
      { text: "You've hit your session limit ", error: true, resetsAt: '2026-09-30T16:10:00.000Z', limitKind: 'window' },
      { text: "You've reached your Fable limi", error: true, resetsAt: undefined, limitKind: 'credits' },
    ],
  );

  const meta = new ClaudeMetaScan();
  meta.line(claudeLimit('2026-09-29T17:26:37.846Z'));
  assert.deepEqual(meta.limit, { at: '2026-09-29T17:26:37.846Z', text: "You've hit your session limit · resets 5:30am (Asia/Seoul)", resetsAt: '2026-09-29T20:30:00.000Z', limitKind: 'window' });
  meta.reset();
  meta.line(JSON.stringify({ type: 'assistant', timestamp: '2026-09-29T17:27:00.000Z', isApiErrorMessage: true, error: 'server_error', message: { content: [{ type: 'text', text: 'API Error: 500' }] } }));
  assert.equal(meta.limit, undefined, 'only a rate_limit error is a limit');
});

test('claude-code: the reset time in a limit text is the next such time in its zone, else the machine\'s', () => {
  assert.equal(resetsFromText('resets 5:30am (Asia/Seoul)', '2026-09-29T17:26:37.846Z'), '2026-09-29T20:30:00.000Z');
  assert.equal(resetsFromText('limit · resets 12pm (UTC)', '2026-10-02T12:00:00.000Z'), '2026-10-03T12:00:00.000Z', 'not the instant itself');
  assert.equal(resetsFromText('resets 12am (UTC)', '2026-10-02T09:00:00.000Z'), '2026-10-03T00:00:00.000Z');
  assert.equal(resetsFromText('resets Oct 3, 1am (America/New_York)', '2026-10-02T00:00:00.000Z'), '2026-10-03T05:00:00.000Z');
  assert.equal(resetsFromText('resets Jan 2 at 9:15pm (UTC)', '2026-10-02T00:00:00.000Z'), '2027-01-02T21:15:00.000Z', 'a past date is next year\'s');
  const local = new Date(Date.parse('2026-10-02T00:00:00.000Z'));
  const expected = new Date(local.getFullYear(), local.getMonth(), local.getDate(), 14, 30);
  if (expected.getTime() <= local.getTime()) expected.setDate(expected.getDate() + 1);
  assert.equal(resetsFromText('resets 2:30pm', '2026-10-02T00:00:00.000Z'), expected.toISOString());
  assert.equal(resetsFromText('resets 7:40pm (No/Such_Zone)', '2026-10-02T00:00:00.000Z'), undefined);
  assert.equal(resetsFromText('API Error: 529 Overloaded', '2026-10-02T00:00:00.000Z'), undefined);
});

test('codex: a failed turn is an error item; a usage limit resets when its full window does, else as its text says, else it is out of credits', () => {
  const log = new ItemLog();
  const parse = codexLineParser();
  for (const line of [
    ...codexLimit('2026-09-16T08:00:00.000Z'),
    // Codex says "out of credits" also when a plan's weekly window is used up.
    ...codexLimit('2026-09-16T08:30:00.000Z', { message: NO_CREDITS, reached: 'workspace_owner_credits_depleted' }),
    // Credits ran out while no window was full (the 5h one at 98%).
    ...codexLimit('2026-09-16T09:00:00.000Z', { message: NO_CREDITS, primary: 98, secondary: 22, reached: 'workspace_owner_credits_depleted' }),
    ...codexLimit('2026-09-16T09:10:00.000Z', { secondary: 60 }),
    // A stale snapshot: no window full, the fullest at 97% gives an estimate; under 95% none.
    ...codexLimit('2026-09-16T09:20:00.000Z', { message: "You've hit your usage limit.", primary: 97, secondary: 60 }),
    ...codexLimit('2026-09-16T09:25:00.000Z', { message: "You've hit your usage limit.", primary: 90, secondary: 60 }),
    ...codexLimit('2026-09-16T09:30:00.000Z', { info: 'server_overloaded', message: 'Selected model is at capacity. Please try a different model.' }),
  ]) parse(line, log);
  assert.deepEqual(
    log.page(undefined, 10).items.map(({ text, error, resetsAt, resetsEstimated, limitKind }) => ({ text: text.slice(0, 28), error, resetsAt, resetsEstimated, limitKind })),
    [
      { text: "You've hit your usage limit.", error: true, resetsAt: '2026-09-19T09:37:15.000Z', resetsEstimated: undefined, limitKind: 'window' },
      { text: 'Your workspace is out of cre', error: true, resetsAt: '2026-09-19T09:37:15.000Z', resetsEstimated: undefined, limitKind: 'window' },
      { text: 'Your workspace is out of cre', error: true, resetsAt: undefined, resetsEstimated: undefined, limitKind: 'credits' },
      { text: "You've hit your usage limit.", error: true, resetsAt: new Date(2026, 8, 25, 13, 21).toISOString(), resetsEstimated: undefined, limitKind: 'window' },
      { text: "You've hit your usage limit.", error: true, resetsAt: '2026-09-16T12:16:20.000Z', resetsEstimated: true, limitKind: 'window' },
      { text: "You've hit your usage limit.", error: true, resetsAt: undefined, resetsEstimated: undefined, limitKind: 'window' },
      { text: 'Selected model is at capacit', error: true, resetsAt: undefined, resetsEstimated: undefined, limitKind: undefined },
    ],
  );

  const meta = new CodexMetaScan();
  for (const line of codexLimit('2026-09-16T08:33:07.959Z')) meta.line(line);
  assert.deepEqual([meta.limit?.at, meta.limit?.resetsAt, meta.limit?.limitKind], ['2026-09-16T08:33:07.959Z', '2026-09-19T09:37:15.000Z', 'window']);
  for (const line of codexLimit('2026-09-16T09:00:00.000Z', { message: NO_CREDITS, primary: 98, secondary: 22, reached: 'workspace_owner_credits_depleted' })) meta.line(line);
  assert.deepEqual(meta.limit, { at: '2026-09-16T09:00:00.000Z', text: NO_CREDITS, limitKind: 'credits' });
  for (const line of codexLimit('2026-09-16T09:30:00.000Z', { info: 'server_overloaded', message: 'Selected model is at capacity.' })) meta.line(line);
  assert.equal(meta.limit?.at, '2026-09-16T09:00:00.000Z', 'another error is no limit');
});

test('limit alerts: one per hit since the start, none for a retry against the same limit within an hour', () => {
  const hub = recordingHub();
  const session = { id: 'claude-code:s1', title: 'Fix CI' } as Session;
  const alerts = new LimitAlerts(Date.parse('2026-09-29T10:00:00Z'));
  const hit = (at: string, resetsAt?: string, text = 'limit') => alerts.check(hub, session, { at, text, ...(resetsAt ? { resetsAt, limitKind: 'window' } : { limitKind: 'credits' }) });
  hit('2026-09-29T09:59:59Z', 'R1');
  assert.equal(hub.alerts.length, 0, 'a hit from before the start is history');
  hit('2026-09-29T10:01:00Z', 'R1');
  hit('2026-09-29T10:01:00Z', 'R1');
  hit('2026-09-29T10:30:00Z', 'R1');
  assert.deepEqual(hub.alerts, [{ sessionId: 'claude-code:s1', alert: 'limit', text: 'limit', title: 'Fix CI', resetsAt: 'R1', limitKind: 'window' }]);
  hit('2026-09-29T10:40:00Z', 'R2');
  hit('2026-09-29T11:41:00Z', 'R2');
  hit('2026-09-29T11:42:00Z', undefined, 'out of credits');
  assert.deepEqual(hub.alerts.map((a) => a.resetsAt ?? `${a.limitKind}: ${a.text}`), ['R1', 'R2', 'R2', 'credits: out of credits']);
});

test('providers raise a limit alert for a hit appended while running, not for one already in the file', async () => {
  const claudeHome = join(root, 'claude');
  const id = '11111111-2222-4333-8444-555555555555';
  const transcript = join(claudeHome, 'projects', '-work-demo', `${id}.jsonl`);
  mkdirSync(join(claudeHome, 'projects', '-work-demo'), { recursive: true });
  mkdirSync(join(claudeHome, 'sessions'), { recursive: true });
  copyFileSync(new URL('./fixtures/claude/transcript.jsonl', import.meta.url), transcript);
  appendFileSync(transcript, `${claudeLimit('2026-09-29T09:00:00.000Z')}\n`);
  const claude = new ClaudeCodeProvider({ home: claudeHome, historyDays: 3650 });
  const claudeHub = recordingHub();
  await claude.start(claudeHub);
  try {
    assert.equal(claudeHub.alerts.length, 0);
    appendFileSync(transcript, `${claudeLimit(new Date().toISOString())}\n`);
    await claude.refresh();
    appendFileSync(transcript, `${claudeLimit(new Date().toISOString())}\n`);
    await claude.refresh();
    assert.deepEqual(claudeHub.alerts, [
      { sessionId: `claude-code:${id}`, alert: 'limit', text: "You've hit your session limit · resets 5:30am (Asia/Seoul)", title: 'CI 빌드 수정', resetsAt: '2026-09-29T20:30:00.000Z', limitKind: 'window' },
    ]);
  } finally {
    claude.stop();
  }

  const codexHome = join(root, 'codex');
  const thread = '019a0000-0000-7000-8000-000000000001';
  const day = join(codexHome, 'sessions', '2026', '09', '29');
  const rollout = join(day, `rollout-2026-09-29T09-00-00-${thread}.jsonl`);
  mkdirSync(day, { recursive: true });
  copyFileSync(new URL('./fixtures/codex/rollout.jsonl', import.meta.url), rollout);
  const codex = new CodexProvider({ home: codexHome, historyDays: 3650 });
  const codexHub = recordingHub();
  await codex.start(codexHub);
  try {
    appendFileSync(rollout, `${codexLimit(new Date().toISOString()).join('\n')}\n`);
    await codex.refresh();
    appendFileSync(rollout, `${codexLimit(new Date(Date.now() + 1000).toISOString(), { message: NO_CREDITS, primary: 98, secondary: 22, reached: 'workspace_owner_credits_depleted' }).join('\n')}\n`);
    await codex.refresh();
    assert.deepEqual(
      codexHub.alerts.map((a) => [a.sessionId, a.alert, a.resetsAt, a.limitKind]),
      [
        [`codex:${thread}`, 'limit', '2026-09-19T09:37:15.000Z', 'window'],
        [`codex:${thread}`, 'limit', undefined, 'credits'],
      ],
    );
    const page = await codex.readItems(thread, undefined, 2);
    assert.deepEqual(
      page?.items.map((i) => [i.error, i.resetsAt, i.limitKind]),
      [
        [true, '2026-09-19T09:37:15.000Z', 'window'],
        [true, undefined, 'credits'],
      ],
    );
  } finally {
    codex.stop();
  }
});
