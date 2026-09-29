import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PendingRegistry } from '../src/pending.ts';
import type { Item, Session, Usage } from '../src/protocol.ts';
import type { Hub } from '../src/provider.ts';
import { ClaudeCodeProvider } from '../src/providers/claude-code/provider.ts';
import { CodexProvider } from '../src/providers/codex/provider.ts';

const root = mkdtempSync(join(tmpdir(), 'wristline-providers-'));
after(() => rmSync(root, { recursive: true, force: true }));

function recordingHub(): Hub & { sessions: Session[]; usages: Usage[]; removedIds: string[] } {
  const sessions: Session[] = [];
  const usages: Usage[] = [];
  const removedIds: string[] = [];
  return {
    sessions,
    usages,
    removedIds,
    session: (s) => sessions.push(s),
    removed: (id) => removedIds.push(id),
    usage: (u) => usages.push(u),
    alert: () => {},
    pending: new PendingRegistry({ onRequest: () => {}, onResolved: () => {} }),
  };
}

async function waitFor<T>(get: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('claude-code: live registry entries, history, titles and live items', async () => {
  const home = join(root, 'claude');
  const live = '11111111-2222-4333-8444-555555555555';
  const old = '99999999-2222-4333-8444-555555555555';
  mkdirSync(join(home, 'sessions'), { recursive: true });
  mkdirSync(join(home, 'projects', '-work-demo'), { recursive: true });
  const now = Date.now();
  const transcript = join(home, 'projects', '-work-demo', `${live}.jsonl`);
  copyFileSync(new URL('./fixtures/claude/transcript.jsonl', import.meta.url), transcript);
  writeFileSync(join(home, 'projects', '-work-demo', `${old}.jsonl`), '');
  writeFileSync(
    join(home, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: live, cwd: '/work/demo', name: 'demo-1', status: 'busy', updatedAt: now }),
  );
  // A dead pid and a secret key file that must never be treated as registry data.
  writeFileSync(join(home, 'sessions', '2147483646.json'), JSON.stringify({ pid: 2147483646, sessionId: old, cwd: '/work/old', status: 'idle', updatedAt: now }));
  writeFileSync(
    join(home, 'sessions', `${process.pid}.abcdef.key`),
    JSON.stringify({ pid: process.pid, sessionId: 'from-key-file', updatedAt: now }),
  );

  const provider = new ClaudeCodeProvider({ home, historyDays: 7 });
  const hub = recordingHub();
  await provider.start(hub);
  try {
    const sessions = provider.listSessions();
    assert.deepEqual(sessions.map((s) => s.id).sort(), [`claude-code:${live}`, `claude-code:${old}`]);
    const s = sessions.find((x) => x.id === `claude-code:${live}`);
    assert.equal(s?.status, 'running');
    assert.equal(s?.title, 'CI 빌드 수정');
    assert.equal(s?.cwd, '/work/demo');
    assert.deepEqual(s?.context, { used: 5210, window: 200_000 });
    assert.equal(provider.listSessions().find((x) => x.id === `claude-code:${old}`)?.status, 'ended');
    assert.deepEqual(provider.health().status, 'ok');

    provider.statusline({ session_id: live, context_window: { context_window_size: 1_000_000 }, rate_limits: { five_hour: { used_percentage: 7 } } });
    assert.deepEqual(provider.listSessions().find((x) => x.id === `claude-code:${live}`)?.context, { used: 5210, window: 1_000_000 });
    assert.equal(hub.usages.at(-1)?.windows[0]?.id, '5h');

    const page = await provider.readItems(live, undefined, 3);
    assert.deepEqual(page?.items.map((i) => i.seq), [8, 9, 10]);
    assert.equal(page?.hasMore, true);
    assert.equal(await provider.readItems('unknown', undefined, 3), undefined);

    const seen: Item[] = [];
    const stop = provider.watch(live, (item) => seen.push(item));
    appendFileSync(
      transcript,
      `${JSON.stringify({ type: 'assistant', uuid: 'a-new', timestamp: '2026-09-29T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '새 메시지' }] } })}\n`,
    );
    const item = await waitFor(() => seen[0]);
    stop();
    assert.deepEqual(item, { seq: 11, kind: 'assistant', ts: '2026-09-29T10:01:00.000Z', text: '새 메시지' });
  } finally {
    provider.stop();
  }
});

test('codex: rollouts with index titles, sub-agents hidden, usage from token_count', async () => {
  const home = join(root, 'codex');
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  const id = '019a0000-0000-7000-8000-000000000001';
  copyFileSync(new URL('./fixtures/codex/rollout.jsonl', import.meta.url), join(day, `rollout-2026-09-29T09-00-00-${id}.jsonl`));
  const sub = '019a0000-0000-7000-8000-000000000002';
  writeFileSync(
    join(day, `rollout-2026-09-29T09-05-00-${sub}.jsonl`),
    `${JSON.stringify({ type: 'session_meta', payload: { id: sub, cwd: '/work/api', source: { subagent: { thread_spawn: { depth: 1 } } } } })}\n`,
  );
  writeFileSync(join(home, 'session_index.jsonl'), `${JSON.stringify({ id, thread_name: 'Fix API tests', updated_at: '2026-09-29T09:00:00Z' })}\n`);

  const provider = new CodexProvider({ home, historyDays: 7 });
  const hub = recordingHub();
  await provider.start(hub);
  try {
    const sessions = provider.listSessions();
    assert.equal(sessions.length, 1);
    assert.deepEqual(
      { ...sessions[0], lastActivity: undefined },
      {
        id: `codex:${id}`,
        provider: 'codex',
        title: 'Fix API tests',
        cwd: '/work/api',
        status: 'idle',
        lastActivity: undefined,
        promptBlock: 'unsupported',
        context: { used: 40500, window: 258400 },
      },
    );
    assert.deepEqual(provider.health(), { id: 'codex', status: 'ok', version: '0.159.0' });
    assert.deepEqual(hub.usages.map((u) => u.windows.map((w) => w.id)), [['primary', 'secondary']]);
    const page = await provider.readItems(id, undefined, 40);
    assert.equal(page?.items.length, 6);
  } finally {
    provider.stop();
  }
});

test('a missing agent home is reported as not_found', async () => {
  const provider = new CodexProvider({ home: join(root, 'nowhere'), historyDays: 7 });
  await provider.start(recordingHub());
  provider.stop();
  assert.deepEqual(provider.health(), { id: 'codex', status: 'not_found' });
  assert.deepEqual(provider.listSessions(), []);
});
