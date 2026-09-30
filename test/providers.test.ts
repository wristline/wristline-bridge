import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Item, Session } from '../src/protocol.ts';
import { PromptBlocked } from '../src/provider.ts';
import { tmuxPane } from '../src/providers/claude-code/home.ts';
import { ClaudeCodeProvider } from '../src/providers/claude-code/provider.ts';
import { CodexProvider } from '../src/providers/codex/provider.ts';
import { recordingHub, waitFor } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'wristline-providers-'));
after(() => rmSync(root, { recursive: true, force: true }));

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

    await provider.statusline({ session_id: live, context_window: { context_window_size: 1_000_000 }, rate_limits: { five_hour: { used_percentage: 7 } } });
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

/** The `creator_account_id` of the fixture rollout. */
const CODEX_A = 'a1a1a1a1-0000-4000-8000-00000000000a';
const CODEX_B = 'b2b2b2b2-0000-4000-8000-00000000000b';

/** A rollout of one thread with one rate-limit snapshot; `creator` is absent in rollouts of codex < 0.157. */
function codexRollout(id: string, creator: string | undefined, usedPercent: number): string {
  const lines = [
    { timestamp: '2026-09-29T09:10:00.000Z', type: 'session_meta', payload: { id, cwd: '/w', cli_version: '0.159.0', ...(creator ? { creator_account_id: creator } : {}) } },
    {
      timestamp: '2026-09-29T09:10:01.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 1790683200 }, secondary: null } },
    },
  ];
  return lines.map((l) => `${JSON.stringify(l)}\n`).join('');
}

/** An `auth.json` like Codex writes for a ChatGPT login, with an unsigned id_token; the other token values must never surface. */
function codexAuth(accountId: string, email: string): string {
  const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const idToken = `${segment({ alg: 'none', typ: 'JWT' })}.${segment({ email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.signature`;
  return JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: idToken, access_token: 'ACCESS-SECRET', refresh_token: 'REFRESH-SECRET' } });
}

test('codex: rollouts with index titles, sub-agents hidden, threads and usage labelled by creator account', async () => {
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
  // A thread of a second account (the home's current login) and one from an older codex that names no creator.
  const [other, legacy] = ['019a0000-0000-7000-8000-000000000003', '019a0000-0000-7000-8000-000000000004'];
  writeFileSync(join(day, `rollout-2026-09-29T09-10-00-${other}.jsonl`), codexRollout(other, CODEX_B, 55));
  writeFileSync(join(day, `rollout-2026-09-29T09-10-00-${legacy}.jsonl`), codexRollout(legacy, undefined, 7));
  writeFileSync(join(home, 'auth.json'), codexAuth(CODEX_B, 'b@example.com'));
  writeFileSync(join(home, 'session_index.jsonl'), `${JSON.stringify({ id, thread_name: 'Fix API tests', updated_at: '2026-09-29T09:00:00Z' })}\n`);

  const saved: Record<string, string>[] = [];
  const provider = new CodexProvider({ home, historyDays: 7, accounts: { [CODEX_A]: 'a@example.com' }, labels: { [CODEX_A]: 'me' }, saveAccounts: async (a) => void saved.push(a) });
  const hub = recordingHub();
  await provider.start(hub);
  try {
    const sessions = provider.listSessions();
    assert.equal(sessions.length, 3);
    assert.deepEqual(
      { ...sessions.find((s) => s.id === `codex:${id}`), lastActivity: undefined },
      {
        id: `codex:${id}`,
        provider: 'codex',
        title: 'Fix API tests',
        cwd: '/work/api',
        status: 'idle',
        lastActivity: undefined,
        promptBlock: 'unsupported',
        context: { used: 40500, window: 258400 },
        account: { id: CODEX_A, label: 'me' },
        model: 'gpt-6-astra',
        effort: 'medium',
      },
    );
    const account = (tid: string): Session['account'] => sessions.find((s) => s.id === `codex:${tid}`)?.account;
    assert.deepEqual(account(other), { id: CODEX_B, label: 'b@example.com' }, 'the email learned from auth.json');
    assert.equal(account(legacy), undefined, 'no creator id: no guess');
    assert.deepEqual(saved, [{ [CODEX_A]: 'a@example.com', [CODEX_B]: 'b@example.com' }]);
    assert.deepEqual(provider.health(), { id: 'codex', status: 'ok', version: '0.159.0' });
    // One usage entry per account, from that account's newest snapshot.
    const usages = hub.usages.map((u) => [u.account?.id ?? '', u.account?.label, u.windows.map((w) => [w.id, w.usedPercent])]).sort();
    assert.deepEqual(usages, [
      ['', undefined, [['primary', 7]]],
      [CODEX_A, 'me', [['primary', 12.5], ['secondary', 40]]],
      [CODEX_B, 'b@example.com', [['primary', 55]]],
    ]);
    assert.equal(JSON.stringify([sessions, hub.usages, saved]).includes('SECRET'), false, 'no token value leaves auth.json');
    await provider.refresh();
    assert.equal(hub.usages.length, 3, 'unchanged snapshots are not re-published');
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
      ['/usr/bin/tmux', 'display-message', '-p', '-t', '%5', '#{pane_pid} #{pane_in_mode}'],
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
    await provider.statusline({
      session_id: newer,
      context_window: { context_window_size: 1_000_000, current_usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 3 } },
    });
    assert.deepEqual(provider.listSessions().find((s) => s.id === `claude-code:${newer}`)?.context, { used: 123, window: 1_000_000 });
  } finally {
    provider.stop();
  }
});

/** A live registry entry for `pid` in pane %5 and a provider whose tmux is faked (`probe` is what display-message answers). The refresh timer is stopped so the snapshot only changes on `refresh()`. */
async function tmuxProvider(name: string, sid: string, pid: number, status = 'idle') {
  const home = join(root, name);
  const dir = join(home, 'sessions');
  mkdirSync(dir, { recursive: true });
  const entry = (patch: Record<string, unknown> = {}): void =>
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd: '/w', tmux: 'work:@2.%5', status, updatedAt: Date.now(), ...patch }));
  entry();
  const calls: string[][] = [];
  const probe = { pid, inMode: 0 };
  const provider = new ClaudeCodeProvider({
    home,
    historyDays: 7,
    tmux: 'tmux',
    exec: async (file, args) => {
      calls.push([file, ...args]);
      return args[0] === 'display-message' ? `${probe.pid} ${probe.inMode}\n` : '';
    },
  });
  await provider.start(recordingHub());
  provider.stop();
  const typed = (): string[][] => calls.filter((c) => c[1] === 'send-keys');
  return { provider, calls, typed, entry, probe, file: join(dir, `${pid}.json`) };
}

test('claude-code: a session whose process exited since the last refresh gets no keystrokes', async (t) => {
  const sleeper = spawn('sleep', ['30']);
  t.after(() => sleeper.kill());
  const sid = 'cccccccc-0000-4000-8000-000000000001';
  const { provider, typed, probe } = await tmuxProvider('claude-dead', sid, sleeper.pid ?? 0);
  probe.pid = process.pid; // The pane's shell is this process; the session runs inside it.
  await provider.sendPrompt(sid, 'hi');
  assert.equal(typed().length, 2);
  sleeper.kill('SIGKILL');
  await once(sleeper, 'exit');
  // The registry still names the session and no refresh ran, but the pane now shows the shell.
  await assert.rejects(provider.sendPrompt(sid, 'rm -rf build'), (e: unknown) => e instanceof PromptBlocked && e.code === 'not_live');
  assert.equal(typed().length, 2);
});

test('claude-code: an alive session stays live however old its registry entry is; without procStart the 24 h cap applies', async () => {
  const home = join(root, 'claude-old');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const old = Date.now() - 25 * 3600_000;
  const [guarded, unguarded] = ['dddddddd-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000002'];
  writeFileSync(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: guarded, cwd: '/w', status: 'idle', procStart, updatedAt: old }));
  writeFileSync(join(home, 'sessions', `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, sessionId: unguarded, cwd: '/w', status: 'idle', updatedAt: old }));
  const provider = new ClaudeCodeProvider({ home, historyDays: 7 });
  await provider.start(recordingHub());
  provider.stop();
  const status = (id: string): string | undefined => provider.listSessions().find((s) => s.id === `claude-code:${id}`)?.status;
  assert.equal(status(guarded), 'idle');
  assert.equal(status(unguarded), undefined, 'an old entry without a pid-reuse guard is not trusted');
});

test('claude-code: a dialog that opened since the last refresh blocks the prompt', async () => {
  const sid = 'cccccccc-0000-4000-8000-000000000002';
  const { provider, typed, entry, file } = await tmuxProvider('claude-stale', sid, process.pid, 'busy');
  assert.equal(provider.listSessions()[0]?.promptBlock, undefined);
  entry({ status: 'waiting' });
  await assert.rejects(provider.sendPrompt(sid, 'also run the tests'), (e: unknown) => e instanceof PromptBlocked && e.code === 'awaiting_input');
  entry({ tmux: 'work:@2.%9' });
  await assert.rejects(provider.sendPrompt(sid, 'hi'), (e: unknown) => e instanceof PromptBlocked && e.code === 'no_tmux');
  rmSync(file);
  await assert.rejects(provider.sendPrompt(sid, 'hi'), (e: unknown) => e instanceof PromptBlocked && e.code === 'not_live');
  assert.deepEqual(typed(), []);
});

test('claude-code: a pane in copy mode refuses prompts as busy', async () => {
  const sid = 'cccccccc-0000-4000-8000-000000000003';
  const { provider, calls, typed, probe } = await tmuxProvider('claude-copy-mode', sid, process.pid);
  probe.inMode = 1;
  await assert.rejects(provider.sendPrompt(sid, 'continue'), (e: unknown) => e instanceof PromptBlocked && e.code === 'busy');
  assert.deepEqual(calls, [['tmux', 'display-message', '-p', '-t', '%5', '#{pane_pid} #{pane_in_mode}']]);
  probe.inMode = 0;
  await provider.sendPrompt(sid, 'continue');
  assert.equal(typed().length, 2);
});

test('claude-code: a trailing ";" is padded so tmux does not strip it as a command separator', async () => {
  const sid = 'cccccccc-0000-4000-8000-000000000004';
  const { provider, typed } = await tmuxProvider('claude-semicolon', sid, process.pid);
  for (const text of ['a;', 'b\\;', ';', 'semi;colon']) await provider.sendPrompt(sid, text);
  assert.deepEqual(typed().filter((c) => c[4] === '-l').map((c) => c.at(-1)), ['a; ', 'b\\; ', '; ', 'semi;colon']);
});

test('claude-code: a compaction newer than the statusLine report outdates its context', async () => {
  const home = join(root, 'claude-compact');
  const sid = 'eeeeeeee-0000-4000-8000-000000000001';
  mkdirSync(join(home, 'sessions'), { recursive: true });
  mkdirSync(join(home, 'projects', '-w'), { recursive: true });
  const transcript = join(home, 'projects', '-w', `${sid}.jsonl`);
  copyFileSync(new URL('./fixtures/claude/transcript.jsonl', import.meta.url), transcript);
  let clock = Date.now();
  writeFileSync(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, cwd: '/w', status: 'idle', updatedAt: clock }));
  const provider = new ClaudeCodeProvider({ home, historyDays: 7, now: () => clock });
  await provider.start(recordingHub());
  provider.stop();
  const context = (): Session['context'] => provider.listSessions().find((s) => s.id === `claude-code:${sid}`)?.context;
  await provider.statusline({ session_id: sid, context_window: { context_window_size: 200_000, current_usage: { input_tokens: 123 } } });
  assert.deepEqual(context(), { used: 123, window: 200_000 });
  appendFileSync(
    transcript,
    `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: new Date(clock + 1000).toISOString(), compactMetadata: { preTokens: 5210, postTokens: 8387 } })}\n`,
  );
  await provider.refresh();
  assert.deepEqual(context(), { used: 8387, window: 200_000 }, 'the report predates the compaction');
  clock += 2000;
  await provider.statusline({ session_id: sid, context_window: { context_window_size: 200_000, current_usage: { input_tokens: 456 } } });
  assert.deepEqual(context(), { used: 456, window: 200_000 });
});

test('claude-code: model and effort follow the transcript\'s last turn; a statusLine report wins and is published at once', async () => {
  const home = join(root, 'claude-model');
  const sid = 'eeeeeeee-0000-4000-8000-000000000002';
  mkdirSync(join(home, 'sessions'), { recursive: true });
  mkdirSync(join(home, 'projects', '-w'), { recursive: true });
  const transcript = join(home, 'projects', '-w', `${sid}.jsonl`);
  const turn = (model: string, effort: string): string =>
    `${JSON.stringify({ type: 'assistant', uuid: model, timestamp: '2026-09-29T10:00:00.000Z', effort, message: { role: 'assistant', model, content: [] } })}\n`;
  writeFileSync(transcript, turn('claude-opus-5-5', 'high'));
  writeFileSync(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, cwd: '/w', status: 'idle', updatedAt: Date.now() }));
  const provider = new ClaudeCodeProvider({ home, historyDays: 7 });
  const hub = recordingHub();
  await provider.start(hub);
  provider.stop();
  const latest = (): unknown[] => [hub.sessions.at(-1)?.model, hub.sessions.at(-1)?.effort];
  assert.deepEqual(latest(), ['Opus 5.5', 'high']);
  appendFileSync(transcript, turn('claude-sonnet-5-5', 'medium'));
  await provider.refresh();
  assert.deepEqual(latest(), ['Sonnet 5.5', 'medium'], 'a model change is a session change');
  await provider.statusline({ session_id: sid, model: { id: 'claude-fable-5-1', display_name: 'Fable 5.1' }, effort: { level: 'xhigh' } });
  assert.deepEqual(latest(), ['Fable 5.1', 'xhigh']);
  await provider.statusline({ session_id: sid, model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' } });
  assert.deepEqual(latest(), ['Haiku 4.5', undefined], 'the report wins as a whole: no effort, not the transcript\'s');
  const published = hub.sessions.length;
  await provider.refresh();
  assert.equal(hub.sessions.length, published, 'a refresh rebuilds the same session');
});
