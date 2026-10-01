import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { BridgeHub } from '../src/hub.ts';
import type { Item, Session, Usage } from '../src/protocol.ts';
import { PromptBlocked } from '../src/provider.ts';
import { projectSlug, tmuxPane } from '../src/providers/claude-code/home.ts';
import { ClaudeCodeProvider } from '../src/providers/claude-code/provider.ts';
import { CodexProvider } from '../src/providers/codex/provider.ts';
import { quiet, recordingHub, waitFor } from './helpers.ts';

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

/** A rollout of one thread with one rate-limit snapshot written at `at`; `creator` is absent in rollouts of codex < 0.157. */
function codexRollout(id: string, creator: string | undefined, usedPercent: number, at = '2026-09-29T09:10:01.000Z'): string {
  const lines = [
    { timestamp: '2026-09-29T09:10:00.000Z', type: 'session_meta', payload: { id, cwd: '/w', cli_version: '0.159.0', ...(creator ? { creator_account_id: creator } : {}) } },
    {
      timestamp: at,
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

/** A home's login timeline as the bridge saved it: A from 09:00, B from 09:05 (Sept 29). */
const CODEX_LOGINS = [
  { at: '2026-09-29T09:00:00.000Z', id: CODEX_A },
  { at: '2026-09-29T09:05:00.000Z', id: CODEX_B },
];

test('codex: rollouts with index titles, sub-agents hidden, threads labelled by creator account, usage by the login it was recorded under', async () => {
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
  // A thread of a second account (the home's current login) and one from an older codex that names no creator,
  // whose snapshot is older than the first login the bridge saw in the home.
  const [other, legacy] = ['019a0000-0000-7000-8000-000000000003', '019a0000-0000-7000-8000-000000000004'];
  writeFileSync(join(day, `rollout-2026-09-29T09-10-00-${other}.jsonl`), codexRollout(other, CODEX_B, 55));
  writeFileSync(join(day, `rollout-2026-09-29T09-10-00-${legacy}.jsonl`), codexRollout(legacy, undefined, 7, '2026-09-29T08:59:00.000Z'));
  writeFileSync(join(home, 'auth.json'), codexAuth(CODEX_B, 'b@example.com'));
  writeFileSync(join(home, 'session_index.jsonl'), `${JSON.stringify({ id, thread_name: 'Fix API tests', updated_at: '2026-09-29T09:00:00Z' })}\n`);

  const saved: Record<string, string>[] = [];
  const savedLogins: unknown[] = [];
  const provider = new CodexProvider({
    home,
    historyDays: 7,
    accounts: { [CODEX_A]: 'a@example.com' },
    labels: { [CODEX_A]: 'me' },
    logins: CODEX_LOGINS,
    saveAccounts: async (a) => void saved.push(a),
    saveLogins: async (l) => void savedLogins.push(l),
  });
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
    // One usage entry per account, from the newest snapshot written while it was the home's login; the legacy one counts for nobody.
    const usages = hub.usages.map((u) => [u.account?.id ?? '', u.account?.label, u.windows.map((w) => [w.id, w.usedPercent])]).sort();
    assert.deepEqual(usages, [
      [CODEX_A, 'me', [['primary', 12.5], ['secondary', 40]]],
      [CODEX_B, 'b@example.com', [['primary', 55]]],
    ]);
    assert.equal(JSON.stringify([sessions, hub.usages, saved, savedLogins]).includes('SECRET'), false, 'no token value leaves auth.json');
    await provider.refresh();
    assert.equal(hub.usages.length, 2, 'unchanged snapshots are not re-published');
    assert.deepEqual(hub.logins, [CODEX_B], 'the home\'s login, reported when auth.json was read');
    const entries = (savedLogins as { at: string; id: string }[][]).map((l) => l.map(({ at, id }) => ({ at, id })));
    assert.deepEqual(entries, [CODEX_LOGINS], 'the newest login of the timeline already: only saved as still seen');
    const page = await provider.readItems(id, undefined, 40);
    assert.equal(page?.items.length, 6);
  } finally {
    provider.stop();
  }
});

test('codex: only the usage of the home\'s current login reaches the watch; the rollouts of other accounts still name their threads\' accounts', async () => {
  const home = join(root, 'codex-current');
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  const [mine, theirs] = ['019a0000-0000-7000-8000-0000000000d1', '019a0000-0000-7000-8000-0000000000d2'];
  writeFileSync(join(day, `rollout-2026-09-29T09-10-00-${mine}.jsonl`), codexRollout(mine, CODEX_B, 55));
  writeFileSync(join(day, `rollout-2026-09-29T09-10-00-${theirs}.jsonl`), codexRollout(theirs, CODEX_A, 20, '2026-09-29T09:04:00.000Z'));
  const auth = join(home, 'auth.json');
  writeFileSync(auth, codexAuth(CODEX_B, 'b@example.com'));
  const provider = new CodexProvider({ home, historyDays: 7, logins: CODEX_LOGINS });
  const hub = new BridgeHub({ providers: [provider], alerts: { now: () => Date.parse('2026-09-29T10:00:00Z') }, log: quiet });
  try {
    await provider.start(hub);
    const shown = (): unknown[] => hub.usageList().map((u) => [u.account?.id, u.windows.map((w) => w.usedPercent)]);
    assert.deepEqual(shown(), [[CODEX_B, [55]]]);
    assert.equal(provider.listSessions().find((s) => s.id === `codex:${theirs}`)?.account?.id, CODEX_A, 'the thread keeps its account');
    // `codex login` into A: A's numbers show, B's go.
    writeFileSync(auth, codexAuth(CODEX_A, 'alice@example.com'));
    await provider.refresh();
    assert.deepEqual(shown(), [[CODEX_A, [20]]]);
    rmSync(auth); // `codex logout`
    await provider.refresh();
    assert.deepEqual(shown(), []);
  } finally {
    provider.stop();
    hub.close();
  }
});

test('codex: a snapshot counts for the login in effect when it was written, in a thread of that account only: a thread A created that ran on after the switch to B counts for nobody, never A; a snapshot from before the first login seen neither; the timeline survives a restart', async () => {
  const home = join(root, 'codex-timeline');
  const auth = join(home, 'auth.json');
  mkdirSync(home, { recursive: true });
  writeFileSync(auth, codexAuth(CODEX_A, 'a@example.com'));
  let now = Date.parse('2026-09-29T09:00:00.000Z');
  const saved: unknown[][] = [];
  const first = new CodexProvider({ home, historyDays: 3650, now: () => now, saveLogins: async (l) => void saved.push(l) });
  await first.start(recordingHub());
  now = Date.parse('2026-09-29T09:30:00.000Z');
  writeFileSync(auth, codexAuth(CODEX_B, 'b@example.com')); // `codex login` as B
  await first.refresh();
  first.stop();
  const timeline = [
    { at: '2026-09-29T09:00:00.000Z', id: CODEX_A },
    { at: '2026-09-29T09:30:00.000Z', id: CODEX_B },
  ];
  assert.deepEqual(saved, [timeline.slice(0, 1), timeline], 'each login with the time it was first seen; no token or email');

  // The rollouts the restarted bridge finds.
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  const [switched, mine, before, early] = ['019a0000-0000-7000-8000-0000000000f1', '019a0000-0000-7000-8000-0000000000f4', '019a0000-0000-7000-8000-0000000000f2', '019a0000-0000-7000-8000-0000000000f3'];
  // A's thread, resumed under B (B's numbers) or run on by a process still logged in as A (A's): whose is not certain.
  writeFileSync(join(day, `rollout-2026-09-29T09-10-00-${switched}.jsonl`), codexRollout(switched, CODEX_A, 55, '2026-09-29T09:45:00.000Z'));
  writeFileSync(join(day, `rollout-2026-09-29T09-10-00-${mine}.jsonl`), codexRollout(mine, CODEX_B, 33, '2026-09-29T09:40:00.000Z'));
  writeFileSync(join(day, `rollout-2026-09-29T09-10-00-${before}.jsonl`), codexRollout(before, CODEX_A, 20, '2026-09-29T09:20:00.000Z'));
  writeFileSync(join(day, `rollout-2026-09-29T09-10-00-${early}.jsonl`), codexRollout(early, CODEX_A, 90, '2026-09-29T08:30:00.000Z'));
  now = Date.parse('2026-09-29T10:00:00.000Z');
  const restarted = new CodexProvider({ home, historyDays: 3650, now: () => now, logins: saved.at(-1) as typeof timeline, saveLogins: async (l) => void saved.push(l) });
  const hub = recordingHub();
  await restarted.start(hub);
  restarted.stop();
  assert.deepEqual(saved.slice(2), [[timeline[0], { ...timeline[1], seen: '2026-09-29T10:00:00.000Z' }]], 'the same login after the restart is no new entry, only seen again');
  assert.deepEqual(hub.usages.map((u) => [u.account?.id, u.windows.map((w) => w.usedPercent)]).sort(), [
    [CODEX_A, [20]],
    [CODEX_B, [33]],
  ]);
  assert.equal(restarted.listSessions().find((s) => s.id === `codex:${switched}`)?.account?.id, CODEX_A, 'the thread keeps its creator');
});

test('codex: a login that changed while the bridge was not running counts for nobody from when the old one was last seen until the bridge saw the new one', async () => {
  const home = join(root, 'codex-downtime');
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(home, 'auth.json'), codexAuth(CODEX_B, 'b@example.com')); // `codex login` as B at some time after 09:20
  const stored = [{ at: '2026-09-29T09:00:00.000Z', id: CODEX_A, seen: '2026-09-29T09:20:00.000Z' }];
  const [resumed, fresh, old] = ['019a0000-0000-7000-8000-0000000000c1', '019a0000-0000-7000-8000-0000000000c2', '019a0000-0000-7000-8000-0000000000c3'];
  writeFileSync(join(day, `rollout-2026-09-29T09-10-00-${resumed}.jsonl`), codexRollout(resumed, CODEX_A, 66, '2026-09-29T09:40:00.000Z')); // A's thread, resumed under B
  writeFileSync(join(day, `rollout-2026-09-29T09-10-00-${fresh}.jsonl`), codexRollout(fresh, CODEX_B, 44, '2026-09-29T09:50:00.000Z'));
  writeFileSync(join(day, `rollout-2026-09-29T09-10-00-${old}.jsonl`), codexRollout(old, CODEX_A, 15, '2026-09-29T09:15:00.000Z'));
  const saved: unknown[] = [];
  const provider = new CodexProvider({ home, historyDays: 3650, now: () => Date.parse('2026-09-29T10:00:00.000Z'), logins: stored, saveLogins: async (l) => void saved.push(l) });
  const hub = recordingHub();
  await provider.start(hub);
  provider.stop();
  assert.deepEqual(saved, [[stored[0], { at: '2026-09-29T09:20:00.000Z', id: '' }, { at: '2026-09-29T10:00:00.000Z', id: CODEX_B }]]);
  assert.deepEqual(hub.usages.map((u) => [u.account?.id, u.windows.map((w) => w.usedPercent)]), [[CODEX_A, [15]]]);
});

test('codex: a half-written auth.json keeps the current login; a first read that fails shows no account until the file can be read (a chmod is noticed)', async (t) => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
  t.after(() => void (console.error = original));
  const home = join(root, 'codex-auth-states');
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  const [mine, theirs] = ['019a0000-0000-7000-8000-0000000000e1', '019a0000-0000-7000-8000-0000000000e2'];
  writeFileSync(join(day, `rollout-2026-09-29T09-10-00-${mine}.jsonl`), codexRollout(mine, CODEX_B, 55));
  writeFileSync(join(day, `rollout-2026-09-29T09-10-00-${theirs}.jsonl`), codexRollout(theirs, CODEX_A, 20, '2026-09-29T09:04:00.000Z'));
  const auth = join(home, 'auth.json');
  writeFileSync(auth, codexAuth(CODEX_B, 'b@example.com'));
  chmodSync(auth, 0o000);
  const provider = new CodexProvider({ home, historyDays: 7, logins: CODEX_LOGINS });
  const hub = new BridgeHub({ providers: [provider], alerts: { now: () => Date.parse('2026-09-29T10:00:00Z') }, log: quiet });
  const sent: { type: string; usage?: Usage }[] = [];
  const ws = { readyState: 1, send: (data: string) => void sent.push(JSON.parse(data) as { type: string; usage?: Usage }), on: () => {}, ping: () => {}, terminate: () => {}, close: () => {} };
  try {
    await provider.start(hub);
    provider.stop();
    const shown = (): unknown[] => hub.usageList().map((u) => [u.account?.id, u.windows.map((w) => w.usedPercent)]);
    if (process.getuid?.() !== 0) {
      assert.deepEqual(shown(), [], 'unreadable at the first read: no account vouched for, A\'s rollout included');
      assert.equal(errors.filter((e) => e.includes(`reading the login of ${home} failed`)).length, 1);
      await provider.refresh();
      assert.equal(errors.filter((e) => e.includes(`reading the login of ${home} failed`)).length, 1, 'reported once, not on every poll');
    }
    chmodSync(auth, 0o600); // Neither mtime nor size changes.
    await provider.refresh();
    assert.deepEqual(shown(), [[CODEX_B, [55]]]);

    hub.attach(ws as unknown as Parameters<BridgeHub['attach']>[0], 'device');
    sent.length = 0;
    writeFileSync(auth, codexAuth(CODEX_B, 'b@example.com').slice(0, 40)); // Codex rewrites it in place: caught half-written.
    await provider.refresh();
    assert.deepEqual(shown(), [[CODEX_B, [55]]], 'the previous login stays');
    writeFileSync(auth, '');
    await provider.refresh();
    assert.deepEqual(shown(), [[CODEX_B, [55]]]);
    writeFileSync(auth, codexAuth(CODEX_B, 'b@example.com'));
    await provider.refresh();
    assert.deepEqual(shown(), [[CODEX_B, [55]]]);
    assert.deepEqual(sent, [], 'no removal went out');
  } finally {
    hub.close();
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

test('a Quick Ask thread is never listed: its Claude Code transcript and registry entry, and its Codex rollout, are skipped', async () => {
  const claude = join(root, 'claude-ask');
  const askId = '7a000000-2222-4333-8444-555555555555';
  const other = '7b000000-2222-4333-8444-555555555555';
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  mkdirSync(join(claude, 'projects', '-home-u--config-wristline-ask-cwd'), { recursive: true });
  for (const id of [askId, other]) copyFileSync(new URL('./fixtures/claude/transcript.jsonl', import.meta.url), join(claude, 'projects', '-home-u--config-wristline-ask-cwd', `${id}.jsonl`));
  writeFileSync(join(claude, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: askId, cwd: '/home/u/.config/wristline/ask-cwd', status: 'busy', updatedAt: Date.now() }));
  const claudeProvider = new ClaudeCodeProvider({ home: claude, historyDays: 7, isAsk: (id) => id === askId });
  const claudeHub = recordingHub();
  await claudeProvider.start(claudeHub);
  try {
    assert.deepEqual(claudeProvider.listSessions().map((s) => s.id), [`claude-code:${other}`]);
    assert.ok(!claudeProvider.hasSession(askId));
    assert.equal(await claudeProvider.readItems(askId, undefined, 3), undefined);
    assert.ok(!claudeHub.sessions.some((s) => s.id === `claude-code:${askId}`));
  } finally {
    claudeProvider.stop();
  }

  const codex = join(root, 'codex-ask');
  const day = join(codex, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  const [thread, keep, early] = ['019a0000-0000-7000-8000-00000000000a', '019a0000-0000-7000-8000-00000000000b', '019a0000-0000-7000-8000-00000000000c'];
  for (const id of [thread, keep]) copyFileSync(new URL('./fixtures/codex/rollout.jsonl', import.meta.url), join(day, `rollout-2026-09-29T09-00-00-${id}.jsonl`));
  // An ask whose thread id the bridge has not read yet: its rollout is known by the scratch cwd it was made in.
  const askCwd = '/home/u/.config/wristline/ask-cwd';
  writeFileSync(join(day, `rollout-2026-09-29T09-00-00-${early}.jsonl`), readFileSync(new URL('./fixtures/codex/rollout.jsonl', import.meta.url), 'utf8').replaceAll('/work/api', askCwd));
  const codexProvider = new CodexProvider({ home: codex, historyDays: 3650, isAsk: (id) => id === thread, askCwd });
  const codexHub = recordingHub();
  await codexProvider.start(codexHub);
  try {
    assert.deepEqual(codexProvider.listSessions().map((s) => s.id), [`codex:${keep}`]);
    assert.equal(await codexProvider.readItems(thread, undefined, 3), undefined);
    assert.equal(await codexProvider.readItems(early, undefined, 3), undefined);
    assert.ok(!codexHub.sessions.some((s) => s.id === `codex:${thread}` || s.id === `codex:${early}`));
  } finally {
    codexProvider.stop();
  }
});

test('claude-code: Quick Asks are left out before the 50-session cap; a session in the ask scratch directory is an ask even when its id is not known', async () => {
  const home = join(root, 'claude-cap');
  const project = join(home, 'projects', '-work-api');
  const askCwd = '/home/u/.config/wristline/ask-cwd';
  const askProject = join(home, 'projects', projectSlug(askCwd));
  for (const dir of [project, askProject, join(home, 'sessions')]) mkdirSync(dir, { recursive: true });
  const fixture = readFileSync(new URL('./fixtures/claude/transcript.jsonl', import.meta.url), 'utf8');
  const nowSec = Date.now() / 1000;
  const sessions = Array.from({ length: 50 }, (_, i) => `5e550000-2222-4333-8444-${String(i).padStart(12, '0')}`);
  sessions.forEach((id, i) => {
    const path = join(project, `${id}.jsonl`);
    writeFileSync(path, fixture);
    utimesSync(path, nowSec - 3600 - i, nowSec - 3600 - i);
  });
  // Ask transcripts, newer than every session.
  const asks = Array.from({ length: 3 }, (_, i) => `a5c00000-2222-4333-8444-${String(i).padStart(12, '0')}`);
  for (const id of asks) writeFileSync(join(askProject, `${id}.jsonl`), fixture);
  const listed = (provider: ClaudeCodeProvider): string[] => provider.listSessions().map((s) => s.id.slice('claude-code:'.length));

  const byId = new ClaudeCodeProvider({ home, historyDays: 7, isAsk: (id) => asks.includes(id) });
  await byId.start(recordingHub());
  try {
    assert.deepEqual(listed(byId).sort(), [...sessions].sort(), 'all 50 sessions: the asks take none of their places');
  } finally {
    byId.stop();
  }

  // The runner no longer knows these ids (e.g. a thread being deleted): the scratch directory still marks them, and a live process there too.
  const running = 'a5c10000-2222-4333-8444-555555555555';
  writeFileSync(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: running, cwd: askCwd, status: 'busy', updatedAt: Date.now() }));
  const byCwd = new ClaudeCodeProvider({ home, historyDays: 7, askCwd });
  const hub = recordingHub();
  await byCwd.start(hub);
  try {
    assert.deepEqual(listed(byCwd).sort(), [...sessions].sort());
    assert.ok(!hub.sessions.some((s) => [...asks, running].some((id) => s.id === `claude-code:${id}`)));
  } finally {
    byCwd.stop();
  }
});

test('claude-code: an unreadable transcript (e.g. root-owned after `sudo claude`) is logged once and its session listed without it; the others still load', { skip: process.getuid?.() === 0 && 'root reads any file' }, async () => {
  const home = join(root, 'claude-unreadable-transcript');
  const [readable, locked] = ['ffffffff-1111-4000-8000-000000000001', 'ffffffff-1111-4000-8000-000000000002'];
  mkdirSync(join(home, 'sessions'), { recursive: true });
  mkdirSync(join(home, 'projects', '-w'), { recursive: true });
  const fixture = new URL('./fixtures/claude/transcript.jsonl', import.meta.url);
  copyFileSync(fixture, join(home, 'projects', '-w', `${readable}.jsonl`));
  copyFileSync(fixture, join(home, 'projects', '-w', `${locked}.jsonl`));
  chmodSync(join(home, 'projects', '-w', `${locked}.jsonl`), 0o000);
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
  try {
    const provider = new ClaudeCodeProvider({ home, historyDays: 7 });
    await provider.start(recordingHub());
    provider.stop();
    await provider.refresh();
    const title = (id: string): string | undefined => provider.listSessions().find((s) => s.id === `claude-code:${id}`)?.title;
    assert.equal(title(readable), 'CI 빌드 수정');
    assert.equal(title(locked), '');
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0] ?? '', /cannot read .*ffffffff-1111-4000-8000-000000000002\.jsonl.*EACCES/);
  } finally {
    console.error = original;
  }
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
  const claude = await ptyProcess(t);
  const now = Date.now();
  const [older, newer, waiting] = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003'];
  const entry = (pid: number, sessionId: string, tmux: string, status: string, at: number): void =>
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: '/w', tmux, status, updatedAt: at, statusUpdatedAt: at }));
  // Two live entries claim pane %5 (a stale one left behind); only the newer may type there.
  entry(process.pid, older, 'old:@1.%5', 'idle', now - 60_000);
  entry(claude.pid, newer, 'work:@2.%5', 'idle', now);
  entry(sleeper.pid ?? 0, waiting, 'work:@3.%9', 'waiting', now);

  const calls: string[][] = [];
  let panePid = claude.pid;
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
      ['/usr/bin/tmux', 'display-message', '-p', '-t', '%5', '#{pane_pid} #{pane_in_mode} #{pane_synchronized}'],
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
    panePid = claude.pid;

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

/**
 * A process in the foreground of its own terminal, as Claude Code runs in a tmux pane (`script`
 * gives it a pseudo-terminal). `sh -c` runs `command` with `$0` set to `exe`, and the pid it
 * prints first is returned. Killed when the test ends.
 */
async function ptyProcess(t: TestContext, command = 'echo $$; exec "$0" 30', exe = 'sleep'): Promise<{ pid: number; child: ChildProcess }> {
  const child = spawn('script', ['-qfec', `sh -c '${command}' '${exe}'`, '/dev/null'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  const pid = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', (data: Buffer) => {
      out += data.toString();
      const printed = /(\d+)\r?\n/.exec(out)?.[1];
      if (printed) resolve(Number(printed));
    });
  });
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    child.kill('SIGKILL');
  });
  return { pid, child };
}

/** The state letter of /proc/<pid>/stat (`T` when stopped). */
function procState(pid: number): string | undefined {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
}

/** A live registry entry for `pid` in pane %5 and a provider whose tmux is faked (`probe` is what display-message answers). The refresh timer is stopped so the snapshot only changes on `refresh()`. */
async function tmuxProvider(name: string, sid: string, pid: number, status = 'idle') {
  const home = join(root, name);
  const dir = join(home, 'sessions');
  mkdirSync(dir, { recursive: true });
  const entry = (patch: Record<string, unknown> = {}): void =>
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd: '/w', tmux: 'work:@2.%5', status, updatedAt: Date.now(), ...patch }));
  entry();
  const calls: string[][] = [];
  const probe = { pid, inMode: 0, synchronized: 0 };
  const provider = new ClaudeCodeProvider({
    home,
    historyDays: 7,
    tmux: 'tmux',
    exec: async (file, args) => {
      calls.push([file, ...args]);
      return args[0] === 'display-message' ? `${probe.pid} ${probe.inMode} ${probe.synchronized}\n` : '';
    },
  });
  await provider.start(recordingHub());
  provider.stop();
  const typed = (): string[][] => calls.filter((c) => c[1] === 'send-keys');
  return { provider, calls, typed, entry, probe, file: join(dir, `${pid}.json`) };
}

test('claude-code: a session whose process exited since the last refresh gets no keystrokes', async (t) => {
  const sleeper = await ptyProcess(t);
  const sid = 'cccccccc-0000-4000-8000-000000000001';
  const { provider, typed, probe } = await tmuxProvider('claude-dead', sid, sleeper.pid);
  probe.pid = process.pid; // The pane's shell is this process; the session runs inside it.
  await provider.sendPrompt(sid, 'hi');
  assert.equal(typed().length, 2);
  process.kill(sleeper.pid, 'SIGKILL');
  await once(sleeper.child, 'exit');
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

test('claude-code: a pane in copy mode refuses prompts as busy', async (t) => {
  const sid = 'cccccccc-0000-4000-8000-000000000003';
  const { provider, calls, typed, probe } = await tmuxProvider('claude-copy-mode', sid, (await ptyProcess(t)).pid);
  probe.inMode = 1;
  await assert.rejects(provider.sendPrompt(sid, 'continue'), (e: unknown) => e instanceof PromptBlocked && e.code === 'busy');
  assert.deepEqual(calls, [['tmux', 'display-message', '-p', '-t', '%5', '#{pane_pid} #{pane_in_mode} #{pane_synchronized}']]);
  probe.inMode = 0;
  await provider.sendPrompt(sid, 'continue');
  assert.equal(typed().length, 2);
});

test('claude-code: a pane whose window has synchronize-panes on refuses prompts as busy (tmux would type them into every pane)', async (t) => {
  const sid = 'cccccccc-0000-4000-8000-000000000005';
  const { provider, typed, probe } = await tmuxProvider('claude-synchronized', sid, (await ptyProcess(t)).pid);
  probe.synchronized = 1;
  await assert.rejects(provider.sendPrompt(sid, 'continue'), (e: unknown) => e instanceof PromptBlocked && e.code === 'busy');
  assert.deepEqual(typed(), []);
  probe.synchronized = 0;
  await provider.sendPrompt(sid, 'continue');
  assert.equal(typed().length, 2);
});

test('claude-code: a session stopped with Ctrl-Z or sent to the background refuses prompts as busy (its shell would run them)', async (t) => {
  const busy = (e: unknown): boolean => e instanceof PromptBlocked && e.code === 'busy';
  const claude = await ptyProcess(t);
  const sid = 'cccccccc-0000-4000-8000-000000000006';
  const { provider, typed } = await tmuxProvider('claude-stopped', sid, claude.pid);
  await provider.sendPrompt(sid, 'hi');
  assert.equal(typed().length, 2);
  process.kill(claude.pid, 'SIGSTOP');
  await waitFor(() => (procState(claude.pid) === 'T' ? true : undefined));
  await assert.rejects(provider.sendPrompt(sid, 'rm -rf build'), busy);
  assert.equal(typed().length, 2);
  process.kill(claude.pid, 'SIGCONT');
  await waitFor(() => (procState(claude.pid) !== 'T' ? true : undefined));
  await provider.sendPrompt(sid, 'hi');
  assert.equal(typed().length, 4);

  // Running (e.g. resumed with `bg`) but not the terminal's foreground job: the shell reads the keys.
  const background = await ptyProcess(t, 'set -m; "$0" 30 & echo $!; wait');
  const other = 'cccccccc-0000-4000-8000-000000000007';
  const bg = await tmuxProvider('claude-background', other, background.pid);
  assert.notEqual(procState(background.pid), 'T');
  await assert.rejects(bg.provider.sendPrompt(other, 'rm -rf build'), busy);
  assert.deepEqual(bg.typed(), []);

  // The command name in /proc/<pid>/stat is parenthesised and may itself hold ") T ": fields are read after the last ")".
  const exe = join(root, 'x) T 1 2 (');
  symlinkSync('/usr/bin/sleep', exe);
  const odd = await ptyProcess(t, undefined, exe);
  const third = 'cccccccc-0000-4000-8000-000000000008';
  const named = await tmuxProvider('claude-odd-name', third, odd.pid);
  await named.provider.sendPrompt(third, 'hi');
  assert.equal(named.typed().length, 2);
});

test('claude-code: a trailing ";" is padded so tmux does not strip it as a command separator', async (t) => {
  const sid = 'cccccccc-0000-4000-8000-000000000004';
  const { provider, typed } = await tmuxProvider('claude-semicolon', sid, (await ptyProcess(t)).pid);
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
