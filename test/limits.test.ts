// Usage limits the agents write into their transcripts: error items with a reset time, and one `limit` alert per hit.
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ItemLog } from '../src/jsonl.ts';
import type { Session } from '../src/protocol.ts';
import { LimitAlerts } from '../src/provider.ts';
import { ClaudeMetaScan, parseClaudeLine } from '../src/providers/claude-code/parse.ts';
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

/** Codex 0.159: the rate-limit snapshot written just before a failed turn, then its `task_complete` with the error. */
function codexLimit(ts: string, info = 'usage_limit_exceeded', message = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 25th, 2026 1:21 PM.", secondary = 100): string[] {
  return [
    JSON.stringify({
      timestamp: ts,
      type: 'event_msg',
      payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: 27, window_minutes: 300, resets_at: 1789560980 }, secondary: { used_percent: secondary, window_minutes: 10080, resets_at: 1789810635 } } },
    }),
    JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'premium', primary: null, secondary: null } } }),
    JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', turn_id: `t-${ts}`, last_agent_message: null, error: { message, codex_error_info: info } } }),
  ];
}

test('claude-code: an API error message is an error item; a usage limit carries quotaLimits.resetsAt', () => {
  const log = new ItemLog();
  parseClaudeLine(claudeLimit('2026-09-29T17:26:37.846Z'), log);
  parseClaudeLine(JSON.stringify({ type: 'assistant', uuid: 'e', timestamp: '2026-09-29T17:27:00.000Z', isApiErrorMessage: true, error: 'server_error', message: { content: [{ type: 'text', text: 'API Error: 500' }] } }), log);
  parseClaudeLine(JSON.stringify({ type: 'assistant', uuid: 'a', timestamp: '2026-09-29T17:28:00.000Z', message: { content: [{ type: 'text', text: 'Done.' }] } }), log);
  assert.deepEqual(
    log.page(undefined, 10).items.map(({ kind, text, error, resetsAt }) => ({ kind, text, error, resetsAt })),
    [
      { kind: 'assistant', text: "You've hit your session limit · resets 5:30am (Asia/Seoul)", error: true, resetsAt: '2026-09-29T20:30:00.000Z' },
      { kind: 'assistant', text: 'API Error: 500', error: true, resetsAt: undefined },
      { kind: 'assistant', text: 'Done.', error: undefined, resetsAt: undefined },
    ],
  );

  const meta = new ClaudeMetaScan();
  meta.line(claudeLimit('2026-09-29T17:26:37.846Z'));
  assert.deepEqual(meta.limit, { at: '2026-09-29T17:26:37.846Z', text: "You've hit your session limit · resets 5:30am (Asia/Seoul)", resetsAt: '2026-09-29T20:30:00.000Z' });
  meta.reset();
  meta.line(JSON.stringify({ type: 'assistant', timestamp: '2026-09-29T17:27:00.000Z', isApiErrorMessage: true, error: 'server_error', message: { content: [{ type: 'text', text: 'API Error: 500' }] } }));
  assert.equal(meta.limit, undefined, 'only a rate_limit error is a limit');
});

test('codex: a failed turn is an error item; a usage limit resets when the full window does', () => {
  const log = new ItemLog();
  const parse = codexLineParser();
  for (const line of [
    ...codexLimit('2026-09-16T08:33:07.959Z'),
    ...codexLimit('2026-09-16T09:00:00.000Z', 'usage_limit_exceeded', 'Your workspace is out of credits. Add credits to continue.', 44),
    ...codexLimit('2026-09-16T09:30:00.000Z', 'server_overloaded', 'Selected model is at capacity. Please try a different model.'),
  ]) parse(line, log);
  assert.deepEqual(
    log.page(undefined, 10).items.map(({ kind, text, error, resetsAt }) => ({ kind, text: text.slice(0, 28), error, resetsAt })),
    [
      { kind: 'assistant', text: "You've hit your usage limit.", error: true, resetsAt: '2026-09-19T09:37:15.000Z' },
      { kind: 'assistant', text: 'Your workspace is out of cre', error: true, resetsAt: undefined },
      { kind: 'assistant', text: 'Selected model is at capacit', error: true, resetsAt: undefined },
    ],
  );

  const meta = new CodexMetaScan();
  for (const line of codexLimit('2026-09-16T08:33:07.959Z')) meta.line(line);
  assert.equal(meta.limit?.resetsAt, '2026-09-19T09:37:15.000Z');
  assert.equal(meta.limit?.at, '2026-09-16T08:33:07.959Z');
  for (const line of codexLimit('2026-09-16T09:30:00.000Z', 'server_overloaded', 'Selected model is at capacity.')) meta.line(line);
  assert.equal(meta.limit?.at, '2026-09-16T08:33:07.959Z', 'another error is no limit');
});

test('limit alerts: one per hit since the start, none for a retry against the same limit within an hour', () => {
  const hub = recordingHub();
  const session = { id: 'claude-code:s1', title: 'Fix CI' } as Session;
  const alerts = new LimitAlerts(Date.parse('2026-09-29T10:00:00Z'));
  const hit = (at: string, resetsAt?: string, text = 'limit') => alerts.check(hub, session, { at, text, ...(resetsAt && { resetsAt }) });
  hit('2026-09-29T09:59:59Z', 'R1');
  assert.equal(hub.alerts.length, 0, 'a hit from before the start is history');
  hit('2026-09-29T10:01:00Z', 'R1');
  hit('2026-09-29T10:01:00Z', 'R1');
  hit('2026-09-29T10:30:00Z', 'R1');
  assert.deepEqual(hub.alerts, [{ sessionId: 'claude-code:s1', alert: 'limit', text: 'limit', title: 'Fix CI', resetsAt: 'R1' }]);
  hit('2026-09-29T10:40:00Z', 'R2');
  hit('2026-09-29T11:41:00Z', 'R2');
  hit('2026-09-29T11:42:00Z', undefined, 'out of credits');
  assert.deepEqual(hub.alerts.map((a) => a.resetsAt ?? a.text), ['R1', 'R2', 'R2', 'out of credits']);
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
      { sessionId: `claude-code:${id}`, alert: 'limit', text: "You've hit your session limit · resets 5:30am (Asia/Seoul)", title: 'CI 빌드 수정', resetsAt: '2026-09-29T20:30:00.000Z' },
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
    assert.deepEqual(
      codexHub.alerts.map((a) => [a.sessionId, a.alert, a.resetsAt]),
      [[`codex:${thread}`, 'limit', '2026-09-19T09:37:15.000Z']],
    );
    const page = await codex.readItems(thread, undefined, 1);
    assert.deepEqual([page?.items[0]?.error, page?.items[0]?.resetsAt], [true, '2026-09-19T09:37:15.000Z']);
  } finally {
    codex.stop();
  }
});
