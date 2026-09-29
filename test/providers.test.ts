import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PendingRegistry } from '../src/pending.ts';
import type { Item, ResolvedBy, Session, Usage } from '../src/protocol.ts';
import { PromptBlocked, type Hub } from '../src/provider.ts';
import { ClaudeCodeProvider, tmuxPane } from '../src/providers/claude-code/provider.ts';
import { CodexProvider } from '../src/providers/codex/provider.ts';

const root = mkdtempSync(join(tmpdir(), 'wristline-providers-'));
after(() => rmSync(root, { recursive: true, force: true }));

function recordingHub(): Hub & { sessions: Session[]; usages: Usage[]; removedIds: string[]; resolved: string[] } {
  const sessions: Session[] = [];
  const usages: Usage[] = [];
  const removedIds: string[] = [];
  const resolved: string[] = [];
  return {
    sessions,
    usages,
    removedIds,
    resolved,
    session: (s) => sessions.push(s),
    removed: (id) => removedIds.push(id),
    usage: (u) => usages.push(u),
    alert: () => {},
    pending: new PendingRegistry({ onRequest: () => {}, onResolved: (r, by: ResolvedBy) => resolved.push(`${r.id}:${by}`) }),
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

test('codex without the daemon: an unfinished turn counts as running only while the rollout changes', async () => {
  const home = join(root, 'codex-stale');
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  const [fresh, stale] = ['019a0000-0000-7000-8000-0000000000c1', '019a0000-0000-7000-8000-0000000000c2'];
  const lines = [
    { timestamp: '2026-09-29T09:00:00.000Z', type: 'session_meta', payload: { id: fresh, cwd: '/w', cli_version: '0.159.0' } },
    { timestamp: '2026-09-29T09:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
  ];
  for (const id of [fresh, stale]) writeFileSync(join(day, `rollout-2026-09-29T09-00-00-${id}.jsonl`), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  const hourAgo = new Date(Date.now() - 3600_000);
  utimesSync(join(day, `rollout-2026-09-29T09-00-00-${stale}.jsonl`), hourAgo, hourAgo);
  const provider = new CodexProvider({ home, historyDays: 3650 });
  await provider.start(recordingHub());
  provider.stop();
  const status = (id: string): [string | undefined, string | undefined] => {
    const s = provider.listSessions().find((x) => x.id === `codex:${id}`);
    return [s?.status, s?.promptBlock];
  };
  assert.deepEqual(status(fresh), ['running', 'unsupported']);
  assert.deepEqual(status(stale), ['ended', 'not_live']);
});

test('a missing agent home is reported as not_found', async () => {
  const provider = new CodexProvider({ home: join(root, 'nowhere'), historyDays: 7 });
  await provider.start(recordingHub());
  provider.stop();
  assert.deepEqual(provider.health(), { id: 'codex', status: 'not_found' });
  assert.deepEqual(provider.listSessions(), []);
});

test('tmux target: the %pane id after the last dot', () => {
  assert.equal(tmuxPane('work:@2.%15'), '%15');
  assert.equal(tmuxPane('my.session:@2.%4'), '%4');
  assert.equal(tmuxPane('%7'), '%7');
  assert.equal(tmuxPane('work:@2'), undefined);
  assert.equal(tmuxPane(undefined), undefined);
});

test('claude-code: prompts go to the newest live owner of a tmux pane; answered dialogs are dismissed', async (t) => {
  const home = join(root, 'claude-tmux');
  const dir = join(home, 'sessions');
  mkdirSync(dir, { recursive: true });
  const sleeper = spawn('sleep', ['30']);
  t.after(() => sleeper.kill());
  const now = Date.now();
  const [older, newer, waiting] = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003'];
  const entry = (pid: number, sessionId: string, tmux: string, status: string, at: number): void =>
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: '/w', tmux, status, updatedAt: at, statusUpdatedAt: at }));
  // Two live entries claim pane %5 (a stale one left behind); only the newer may type there.
  entry(process.pid, older, 'old:@1.%5', 'idle', now - 60_000);
  entry(process.ppid, newer, 'work:@2.%5', 'idle', now);
  entry(sleeper.pid ?? 0, waiting, 'work:@3.%9', 'waiting', now);

  const calls: string[][] = [];
  let panePid = process.ppid;
  const provider = new ClaudeCodeProvider({
    home,
    historyDays: 7,
    tmux: '/usr/bin/tmux',
    exec: async (file, args) => {
      calls.push([file, ...args]);
      return args[0] === 'display-message' ? `${panePid}\n` : '';
    },
  });
  const hub = recordingHub();
  await provider.start(hub);
  try {
    const block = (id: string): string | undefined => provider.listSessions().find((s) => s.id === `claude-code:${id}`)?.promptBlock;
    assert.deepEqual([block(older), block(newer), block(waiting)], ['no_tmux', undefined, 'awaiting_input']);
    await assert.rejects(provider.sendPrompt(older, 'hi'), (e: unknown) => e instanceof PromptBlocked && e.code === 'no_tmux');
    await assert.rejects(provider.sendPrompt(waiting, 'hi'), (e: unknown) => e instanceof PromptBlocked && e.code === 'awaiting_input');
    assert.deepEqual(calls, []);

    await provider.sendPrompt(newer, 'fix the build\nthen run tests\u001b');
    assert.deepEqual(calls, [
      ['/usr/bin/tmux', 'display-message', '-p', '-t', '%5', '#{pane_pid}'],
      ['/usr/bin/tmux', 'send-keys', '-t', '%5', '-l', '--', 'fix the build then run tests '],
      ['/usr/bin/tmux', 'send-keys', '-t', '%5', 'Enter'],
    ]);

    // A leading "!" would switch Claude Code's input box to shell mode; "/" commands are fine.
    await assert.rejects(provider.sendPrompt(newer, ' \u0001!rm -rf build'), (e: unknown) => e instanceof PromptBlocked && e.code === 'unsafe_prefix');
    assert.equal(calls.length, 3);
    await provider.sendPrompt(newer, '/compact');
    assert.deepEqual(calls.at(-2), ['/usr/bin/tmux', 'send-keys', '-t', '%5', '-l', '--', '/compact']);

    // A pane whose process tree does not contain the session is someone else's.
    calls.length = 0;
    panePid = 1;
    await assert.rejects(provider.sendPrompt(newer, 'hi'), (e: unknown) => e instanceof PromptBlocked && e.code === 'no_tmux');
    assert.equal(calls.length, 1);
    panePid = process.ppid;

    // An open request blocks prompts; the terminal answering the dialog (status leaves "waiting") resolves it.
    const answer = hub.pending.open({ sessionId: `claude-code:${waiting}`, kind: 'permission', title: 'Bash', questions: [] });
    const [request] = hub.pending.list();
    await provider.refresh();
    assert.equal(hub.pending.list().length, 1, 'still waiting');
    entry(sleeper.pid ?? 0, waiting, 'work:@3.%9', 'busy', Date.now() + 1000);
    await provider.refresh();
    assert.equal(await answer, null);
    assert.deepEqual(hub.resolved, [`${request?.id}:terminal`]);

    // statusLine context replaces the transcript estimate.
    provider.statusline({
      session_id: newer,
      context_window: { context_window_size: 1_000_000, current_usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 3 } },
    });
    assert.deepEqual(provider.listSessions().find((s) => s.id === `claude-code:${newer}`)?.context, { used: 123, window: 1_000_000 });
  } finally {
    provider.stop();
  }
});
