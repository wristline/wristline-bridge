import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ItemLog } from '../src/jsonl.ts';
import {
  CodexMetaScan,
  SessionIndex,
  contextOf,
  itemDraft,
  normalizeItem,
  normalizeRateLimits,
  normalizeTokenUsage,
  parseCodexLine,
  planProgress,
  usageOf,
} from '../src/providers/codex/parse.ts';

const lines = readFileSync(new URL('./fixtures/codex/rollout.jsonl', import.meta.url), 'utf8').trimEnd().split('\n');

test('item_completed records become items; reasoning and response_item are skipped', () => {
  const log = new ItemLog();
  for (const line of lines) parseCodexLine(line, log);
  const { items } = log.page(undefined, 100);
  assert.deepEqual(
    items.map((i) => [i.kind, i.text, i.error ?? false]),
    [
      ['user', '테스트가 왜 실패하는지 확인하고 고쳐줘', false],
      ['tool', 'Shell(npm test)', false],
      ['tool', 'Shell(git diff --stat)', true],
      ['tool', 'Edit(/work/api/src/app.ts, /work/api/src/new.ts)', false],
      ['assistant', '테스트를 고쳤습니다.', false],
      ['assistant', '1. Reproduce\n2. Fix', false],
    ],
  );
  const shell = items[1];
  assert.equal(shell?.detail?.length, 600);
  assert.ok(shell?.detail?.startsWith('…') && shell.detail.endsWith('All tests passed'));
  assert.equal(items[0]?.ts, '2026-09-29T09:00:02.000Z');
});

test('app-server camelCase items normalize to the same drafts as rollout snake_case', () => {
  const rpc = normalizeItem({
    type: 'commandExecution',
    id: 'exec-1',
    command: 'npm test',
    status: 'inProgress',
    aggregatedOutput: null,
    exitCode: null,
    commandActions: [],
  });
  assert.deepEqual(rpc && itemDraft(rpc, 't'), { kind: 'tool', ts: 't', text: 'Shell(npm test)', pending: true });

  const rollout = normalizeItem({ type: 'CommandExecution', id: 'exec-1', command: ['/bin/bash', '-lc', 'npm test'], status: 'in_progress' });
  assert.deepEqual(rollout && itemDraft(rollout, 't'), { kind: 'tool', ts: 't', text: 'Shell(npm test)', pending: true });

  // The live app-server sends the shell wrapper as one string; it reads the same as the rollout's argv.
  const wrapped = normalizeItem({ type: 'commandExecution', id: 'exec-1', command: "/bin/bash -lc 'npm test'", status: 'completed', exitCode: 0 });
  assert.deepEqual(wrapped && itemDraft(wrapped, 't'), { kind: 'tool', ts: 't', text: 'Shell(npm test)', pending: false });

  const agent = normalizeItem({ type: 'AGENTMESSAGE', id: 'm', text: 'hi' });
  assert.deepEqual(agent && itemDraft(agent, 't'), { kind: 'assistant', ts: 't', text: 'hi' });

  const change = normalizeItem({ type: 'fileChange', id: 'p', changes: [{ path: '/a.ts', kind: { type: 'add' }, diff: '' }], status: 'failed' });
  assert.deepEqual(change && itemDraft(change, 't'), { kind: 'tool', ts: 't', text: 'Edit(/a.ts)', pending: false, error: true });

  assert.equal(normalizeItem({ type: 'reasoning', id: 'r' }), undefined);
  assert.equal(normalizeItem({ type: 'userMessage' }), undefined);
});

test('token_count gives context and primary/secondary usage windows', () => {
  const payload = JSON.parse(lines.find((l) => l.includes('token_count')) ?? '{}').payload;
  const usage = normalizeTokenUsage(payload.info);
  assert.deepEqual(usage && contextOf(usage), { used: 40500, window: 258400 });

  const camel = normalizeTokenUsage({
    total: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    last: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    modelContextWindow: null,
  });
  assert.equal(camel && contextOf(camel), undefined);

  const limits = normalizeRateLimits(payload.rate_limits);
  assert.ok(limits);
  assert.deepEqual(usageOf(limits, '2026-09-29T09:00:09.000Z'), {
    provider: 'codex',
    updatedAt: '2026-09-29T09:00:09.000Z',
    windows: [
      { id: 'primary', usedPercent: 12.5, resetsAt: new Date(1790683200 * 1000).toISOString(), minutes: 300 },
      { id: 'secondary', usedPercent: 40, resetsAt: new Date(1791201600 * 1000).toISOString(), minutes: 10080 },
    ],
  });
  const rpcLimits = normalizeRateLimits({ limitId: 'codex', primary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: null }, secondary: null });
  assert.deepEqual(rpcLimits && usageOf(rpcLimits, 'x').windows, [{ id: 'primary', usedPercent: 2, minutes: 10080 }]);
  assert.deepEqual(rpcLimits && usageOf(rpcLimits, 'x', { id: 'acct', label: 'me' }).account, { id: 'acct', label: 'me' });
  assert.equal(normalizeRateLimits({ primary: null, secondary: null }), undefined);
});

test('meta scan reads id, cwd, first prompt, turn state and latest rate limits', () => {
  const meta = new CodexMetaScan();
  for (const line of lines.slice(0, 4)) meta.line(line);
  assert.equal(meta.turnOpen, true);
  for (const line of lines.slice(4)) meta.line(line);
  assert.equal(meta.id, '019a0000-0000-7000-8000-000000000001');
  assert.equal(meta.cwd, '/work/api');
  assert.equal(meta.version, '0.159.0');
  assert.equal(meta.accountId, 'a1a1a1a1-0000-4000-8000-00000000000a');
  assert.equal(meta.subagent, false);
  assert.equal(meta.firstPrompt, '테스트가 왜 실패하는지 확인하고 고쳐줘');
  assert.equal(meta.turnOpen, false);
  assert.deepEqual(meta.context, { used: 40500, window: 258400 });
  assert.equal(meta.rateLimits?.at, '2026-09-29T09:00:09.000Z');
  assert.deepEqual([meta.model, meta.effort], ['gpt-6-astra', 'medium']);
  meta.reset();
  assert.equal(meta.accountId, undefined);
  assert.deepEqual([meta.model, meta.effort], [undefined, undefined]);

  const sub = new CodexMetaScan();
  sub.line(JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: '/w', source: { subagent: { thread_spawn: { depth: 1 } } } } }));
  assert.equal(sub.subagent, true);
  assert.equal(sub.accountId, undefined, 'an older codex names no creator');
});

test('meta scan: model and effort follow the latest turn_context; a null effort is unset', () => {
  const meta = new CodexMetaScan();
  const turn = (payload: object): string =>
    JSON.stringify({ timestamp: '2026-09-29T09:00:01.000Z', type: 'turn_context', payload: { cwd: '/w', sandbox_policy: { type: 'read-only' }, ...payload } });
  meta.line(turn({ model: 'gpt-6-astra', effort: 'low' }));
  assert.deepEqual([meta.model, meta.effort], ['gpt-6-astra', 'low']);
  meta.line(turn({ model: 'gpt-6-astra-mini', effort: null }));
  assert.deepEqual([meta.model, meta.effort], ['gpt-6-astra-mini', undefined]);
});

test('session_index: the last name per thread wins', () => {
  const index = new SessionIndex();
  index.line('{"id":"a","thread_name":"first","updated_at":"2026-09-29T00:00:00Z"}');
  index.line('{"id":"a","thread_name":"renamed","updated_at":"2026-09-29T00:01:00Z"}');
  index.line('not json');
  assert.equal(index.titles.get('a'), 'renamed');
});

test('meta scan: a turn\'s start time and its update_plan progress; the plan stays after the turn until the next one starts', () => {
  const meta = new CodexMetaScan();
  const event = (ts: string, payload: object): string => JSON.stringify({ timestamp: ts, type: 'event_msg', payload });
  const plan = (ts: string, statuses: string[]): string =>
    JSON.stringify({
      timestamp: ts,
      type: 'response_item',
      payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ explanation: 'x', plan: statuses.map((status, i) => ({ step: `Step ${i}`, status })) }), call_id: `call-${ts}` },
    });
  meta.line(event('2026-09-29T09:00:01.500Z', { type: 'task_started', turn_id: 't1', started_at: 1790672401 }));
  assert.equal(meta.turnStartedAt, '2026-09-29T09:00:01.000Z', 'started_at (epoch seconds) wins over the record time');
  assert.equal(meta.progress, undefined);
  meta.line(plan('2026-09-29T09:00:02.000Z', ['completed', 'completed', 'in_progress', 'pending', 'pending', 'pending', 'pending']));
  assert.deepEqual(meta.progress, { done: 2, total: 7 });
  meta.line(plan('2026-09-29T09:00:03.000Z', ['completed', 'completed', 'completed', 'in_progress', 'pending', 'pending', 'pending']));
  assert.deepEqual(meta.progress, { done: 3, total: 7 });
  meta.line(JSON.stringify({ timestamp: '2026-09-29T09:00:04.000Z', type: 'response_item', payload: { type: 'function_call', name: 'update_plan', arguments: '{not json' } }));
  assert.deepEqual(meta.progress, { done: 3, total: 7 }, 'unreadable arguments change nothing');
  meta.line(event('2026-09-29T09:00:05.000Z', { type: 'task_complete', turn_id: 't1' }));
  assert.deepEqual([meta.turnOpen, meta.turnStartedAt, meta.progress], [false, undefined, { done: 3, total: 7 }]);
  meta.line(event('2026-09-29T09:10:00.000Z', { type: 'task_started', turn_id: 't2' }));
  assert.deepEqual([meta.turnStartedAt, meta.progress], ['2026-09-29T09:10:00.000Z', undefined], 'without started_at, the record time');
  meta.line(plan('2026-09-29T09:10:01.000Z', []));
  assert.equal(meta.progress, undefined);
  meta.reset();
  assert.deepEqual([meta.turnStartedAt, meta.progress], [undefined, undefined]);
  assert.deepEqual(planProgress([{ step: 'a', status: 'completed' }, { step: 'b', status: 'inProgress' }, 'junk']), { done: 1, total: 2 }, 'app-server steps (camelCase status)');
});
