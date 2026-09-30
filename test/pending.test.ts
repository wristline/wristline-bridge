import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PendingRegistry, type RequestDraft } from '../src/pending.ts';
import type { PendingRequest, ResolvedBy } from '../src/protocol.ts';

const permission: RequestDraft = {
  sessionId: 'claude-code:s1',
  kind: 'permission',
  title: 'Bash(rm -rf build)',
  questions: [
    {
      id: 'decision',
      text: 'rm -rf build',
      multi: false,
      options: ['allow', 'always', 'deny', 'defer'].map((id) => ({ id, label: id })),
    },
  ],
};

function registry(clock = { now: 0 }): { reg: PendingRegistry; events: string[]; opened: PendingRequest[] } {
  const events: string[] = [];
  const opened: PendingRequest[] = [];
  let n = 0;
  const reg = new PendingRegistry({
    onRequest: (r) => {
      opened.push(r);
      events.push(`request:${r.id}`);
    },
    onResolved: (r, by: ResolvedBy) => events.push(`resolved:${r.id}:${by}`),
    now: () => clock.now,
    newId: () => `r${++n}`,
  });
  return { reg, events, opened };
}

test('the first valid answer wins', async () => {
  const { reg, events } = registry();
  const result = reg.open(permission);
  assert.equal(reg.hasSession('claude-code:s1'), true);
  assert.equal(reg.answer('r1', { decision: ['allow'] }), 'ok');
  assert.equal(reg.answer('r1', { decision: ['deny'] }), 'already_resolved');
  assert.deepEqual(await result, { decision: ['allow'] });
  assert.deepEqual(events, ['request:r1', 'resolved:r1:watch']);
  assert.deepEqual(reg.list(), []);
  assert.equal(reg.hasSession('claude-code:s1'), false);
});

test('answers are validated against the questions', () => {
  const { reg } = registry();
  void reg.open({
    ...permission,
    kind: 'question',
    questions: [
      { id: 'q1', text: 'Pick', multi: false, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { id: 'q2', text: 'Many', multi: true, options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] },
    ],
  });
  assert.equal(reg.answer('r1', { q1: ['a'] }), 'invalid', 'missing question');
  assert.equal(reg.answer('r1', { q1: ['a', 'b'], q2: ['x'] }), 'invalid', 'two picks on a single choice');
  assert.equal(reg.answer('r1', { q1: ['c'], q2: ['x'] }), 'invalid', 'unknown option');
  assert.equal(reg.answer('r1', { q1: ['a'], q2: [] }), 'invalid', 'empty pick');
  assert.equal(reg.answer('r1', { q1: ['a'], q2: ['x'], q3: ['x'] }), 'invalid', 'extra key');
  assert.equal(reg.list().length, 1);
  assert.equal(reg.answer('r1', { q1: ['b'], q2: ['x', 'y'] }), 'ok');
});

test('timeout resolves null', async () => {
  const { reg, events } = registry();
  assert.equal(await reg.open(permission, { timeoutMs: 10 }), null);
  assert.deepEqual(events, ['request:r1', 'resolved:r1:timeout']);
});

test('abort resolves null as answered in the terminal', async () => {
  const { reg, events } = registry();
  const ctrl = new AbortController();
  const result = reg.open(permission, { signal: ctrl.signal, timeoutMs: 60_000 });
  ctrl.abort();
  assert.equal(await result, null);
  assert.deepEqual(events, ['request:r1', 'resolved:r1:terminal']);

  assert.equal(await reg.open(permission, { signal: AbortSignal.abort() }), null);
  assert.equal(events.length, 2, 'an already aborted request is never published');
});

test('"answer on PC" resolves null', async () => {
  const { reg, events } = registry();
  const result = reg.open(permission);
  assert.equal(reg.answer('r1', { decision: ['defer'] }), 'ok');
  assert.equal(await result, null);
  assert.deepEqual(events, ['request:r1', 'resolved:r1:watch']);
});

test('the request carries an id and creation time', () => {
  const clock = { now: Date.parse('2026-09-29T10:00:00Z') };
  const { reg, opened } = registry(clock);
  void reg.open(permission);
  assert.deepEqual(opened[0], { ...permission, id: 'r1', createdAt: '2026-09-29T10:00:00.000Z' });
});

test('a watch counts as present while connected and for 90 s after it leaves', () => {
  const clock = { now: 1_000_000 };
  const { reg } = registry(clock);
  assert.equal(reg.watchPresent(), false);
  assert.deepEqual(reg.presence(), { watch: false, since: null });
  reg.watchConnected();
  reg.watchConnected();
  reg.watchDisconnected();
  clock.now += 3_600_000;
  assert.equal(reg.watchPresent(), true, 'one watch still connected');
  assert.deepEqual(reg.presence(), { watch: true, since: '1970-01-01T00:16:40.000Z' }, 'since the first connect of the run');
  reg.watchDisconnected();
  clock.now += 90_000;
  assert.equal(reg.watchPresent(), true);
  assert.deepEqual(reg.presence(), { watch: true, since: '1970-01-01T00:16:40.000Z' }, 'the grace period continues the run');
  clock.now += 1;
  assert.equal(reg.watchPresent(), false);
  assert.deepEqual(reg.presence(), { watch: false, since: '1970-01-01T01:16:40.000Z' }, 'absent since the last disconnect');
  reg.watchConnected();
  assert.deepEqual(reg.presence(), { watch: true, since: '1970-01-01T01:18:10.001Z' }, 'a new run');
});
