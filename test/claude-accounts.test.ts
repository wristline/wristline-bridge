import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { LoginEntry } from '../src/config.ts';
import { BridgeHub } from '../src/hub.ts';
import type { Session, Usage } from '../src/protocol.ts';
import { ClaudeCodeProvider } from '../src/providers/claude-code/provider.ts';
import { quiet, recordingHub } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'wristline-claude-accounts-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** A Claude home whose `.claude.json` holds only the `oauthAccount` fields the bridge reads; registry entries carry `startedAt`. */
function accountHome(name: string, clock: () => number) {
  const home = join(root, name);
  mkdirSync(join(home, 'sessions'), { recursive: true });
  return {
    home,
    login: (accountUuid: string, emailAddress: string): void =>
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 1, oauthAccount: { accountUuid, emailAddress } })),
    entry: (pid: number, sessionId: string, startedAt = clock()): void =>
      writeFileSync(join(home, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: '/w', status: 'idle', startedAt, updatedAt: clock() })),
  };
}

test('claude-code: sessions follow the home\'s login timeline; a second login turns time-based labels into estimates', async () => {
  let clock = Date.now();
  const { home, login, entry } = accountHome('claude-accounts', () => clock);
  const [s1, s2, past] = ['ffffffff-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000002', 'ffffffff-0000-4000-8000-000000000003'];
  mkdirSync(join(home, 'projects', '-w'), { recursive: true });
  writeFileSync(join(home, 'projects', '-w', `${past}.jsonl`), '');
  utimesSync(join(home, 'projects', '-w', `${past}.jsonl`), new Date(clock - 60_000), new Date(clock - 60_000));
  login('acc-a', 'a@example.com');
  entry(process.pid, s1);
  entry(process.ppid, s2);
  const saved: LoginEntry[][] = [];
  const provider = new ClaudeCodeProvider({ home, historyDays: 7, now: () => clock, labels: { 'acc-b': 'school' }, saveLogins: async (l) => void saved.push(l) });
  await provider.start(recordingHub());
  provider.stop();
  const account = (id: string): Session['account'] => provider.listSessions().find((s) => s.id === `claude-code:${id}`)?.account;
  assert.deepEqual(account(s1), { id: 'acc-a', label: 'a@example.com' });
  assert.deepEqual(account(s2), { id: 'acc-a', label: 'a@example.com' });
  assert.equal(account(past), undefined, 'only active before the first observed login: no guess');

  clock += 5000;
  login('acc-b', 'bob@example.com');
  entry(process.ppid, s2); // Active after the switch; s1 is not.
  await provider.refresh();
  assert.deepEqual(account(s2), { id: 'acc-b', label: 'school', estimated: true });
  assert.deepEqual(account(s1), { id: 'acc-a', label: 'a@example.com', estimated: true });
  assert.deepEqual(saved, [
    [{ at: new Date(clock - 5000).toISOString(), id: 'acc-a', label: 'a@example.com' }],
    [{ at: new Date(clock - 5000).toISOString(), id: 'acc-a', label: 'a@example.com' }, { at: new Date(clock).toISOString(), id: 'acc-b', label: 'bob@example.com' }],
  ]);
  await provider.refresh();
  assert.equal(saved.length, 2, 'an unchanged file is not re-read');
});

test('claude-code: statusLine usage goes to the learned fingerprint\'s account, else to the current login for a process born after it was observed, else to the login an older process started under (an estimate)', async () => {
  let clock = Date.now();
  const start = clock;
  const { home, login, entry } = accountHome('claude-fingerprint', () => clock);
  const [older, newer, peer, mid] = ['eeeeeeee-0000-4000-8000-000000000011', 'eeeeeeee-0000-4000-8000-000000000012', 'eeeeeeee-0000-4000-8000-000000000013', 'eeeeeeee-0000-4000-8000-000000000014'];
  login('acc-a', 'a@example.com');
  entry(process.pid, older, clock - 60_000); // Born before the bridge saw any login here.
  entry(2147483646, peer, clock - 30_000);
  const hub = recordingHub();
  const provider = new ClaudeCodeProvider({ home, historyDays: 7, now: () => clock });
  await provider.start(hub);
  provider.stop();
  clock += 1000;
  entry(2147483645, mid, start + 500); // Born under login A, after it was observed.
  login('acc-b', 'bob@example.com');
  await provider.refresh();
  clock += 1000;
  entry(process.ppid, newer); // Born after login B was observed.
  await provider.refresh();
  const account = (id: string): Session['account'] => provider.listSessions().find((s) => s.id === `claude-code:${id}`)?.account;
  const last = (): Usage['account'] => hub.usages.at(-1)?.account;
  const fB = { five_hour: { used_percentage: 10, resets_at: 1790701800 }, seven_day: { used_percentage: 5, resets_at: '2026-10-06T00:00:00Z' } };
  const fOld = { five_hour: { used_percentage: 3, resets_at: 1790000000 } };

  await provider.statusline({ session_id: newer, rate_limits: fB });
  assert.deepEqual(last(), { id: 'acc-b', label: 'bob@example.com' }, 'a process born after the login: exact, fingerprint learned');
  const reported = hub.usages.length;
  await provider.statusline({ session_id: mid, rate_limits: fOld });
  assert.deepEqual(last(), { id: 'acc-a', label: 'a@example.com', estimated: true }, 'unknown fingerprint from an older process: the login it started under, estimated');
  await provider.statusline({ session_id: older, rate_limits: fOld });
  await provider.statusline({ session_id: 'unknown', rate_limits: fOld });
  assert.equal(hub.usages.length, reported + 1, 'started before any login was observed, or not in the registry: whose limits these are is unknown, so they are dropped');
  await provider.refresh();
  assert.deepEqual(account(newer), { id: 'acc-b', label: 'bob@example.com' }, 'the session keeps the exact account');
  assert.deepEqual(account(older), { id: 'acc-a', label: 'a@example.com', estimated: true });

  clock += 1000;
  login('acc-c', 'carol@example.com'); // statusline() itself notices the switch.
  await provider.statusline({ session_id: peer, rate_limits: fB });
  assert.deepEqual(last(), { id: 'acc-b', label: 'bob@example.com' }, 'the learned fingerprint wins over the current login');
  await provider.statusline({ session_id: newer, rate_limits: fOld });
  assert.deepEqual(last(), { id: 'acc-b', label: 'bob@example.com', estimated: true }, 'born under B, before C was observed');
  assert.equal(provider.hasSession(newer), true);
  assert.equal(provider.hasSession(peer), false, 'a dead registry entry is not a session');
  assert.equal(provider.home, home);
});

test('claude-code: only the usage of the home\'s current login reaches the watch; a login change or logout takes the previous account\'s off', async () => {
  let clock = Date.now();
  const { home, login, entry } = accountHome('claude-current', () => clock);
  const [id, next] = ['cccccccc-2222-4000-8000-000000000001', 'cccccccc-2222-4000-8000-000000000002'];
  login('acc-a', 'a@example.com');
  const provider = new ClaudeCodeProvider({ home, historyDays: 7, now: () => clock });
  const hub = new BridgeHub({ providers: [provider], alerts: { now: () => clock }, log: quiet });
  try {
    await provider.start(hub);
    provider.stop();
    clock += 1000;
    entry(process.pid, id);
    await provider.refresh();
    const limits = (used: number): unknown => ({ five_hour: { used_percentage: used, resets_at: Math.floor(clock / 1000) + 3600 } });
    const shown = (): unknown[] => hub.usageList().map((u) => [u.account?.id, u.windows.map((w) => w.usedPercent)]);
    await provider.statusline({ session_id: id, rate_limits: limits(10) });
    assert.deepEqual(shown(), [['acc-a', [10]]]);
    clock += 1000;
    login('acc-b', 'bob@example.com');
    await provider.refresh();
    assert.deepEqual(shown(), [], 'A is logged out; B has not reported yet');
    await provider.statusline({ session_id: id, rate_limits: limits(40) });
    assert.deepEqual(shown(), [], 'a process that started under A reports for A');
    clock += 1000;
    entry(process.ppid, next);
    await provider.refresh();
    await provider.statusline({ session_id: next, rate_limits: limits(40) });
    assert.deepEqual(shown(), [['acc-b', [40]]]);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 1 })); // `claude auth logout`
    await provider.refresh();
    assert.deepEqual(shown(), []);
  } finally {
    hub.close();
  }
});

test('claude-code: after a login switch, an old process whose weekly window reset (new fingerprint) never shows its numbers as the new login\'s, also after a bridge restart', async () => {
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const { home, login, entry } = accountHome('claude-rollover', () => clock);
  const [oldProcess, newProcess] = ['abababab-0000-4000-8000-000000000001', 'abababab-0000-4000-8000-000000000002'];
  login('acc-x', 'x@example.com');
  let saved: LoginEntry[] = [];
  const options = { home, historyDays: 7, now: () => clock, saveLogins: async (l: LoginEntry[]): Promise<void> => void (saved = l) };
  const limits = (fiveHour: number, fiveHourResets: string, sevenDay: number, sevenDayResets: string): unknown => ({
    five_hour: { used_percentage: fiveHour, resets_at: fiveHourResets },
    seven_day: { used_percentage: sevenDay, resets_at: sevenDayResets },
  });
  const run = async (provider: ClaudeCodeProvider, steps: (hub: BridgeHub) => Promise<void>): Promise<void> => {
    const hub = new BridgeHub({ providers: [provider], alerts: { now: () => clock }, log: quiet });
    try {
      await provider.start(hub);
      provider.stop();
      await steps(hub);
    } finally {
      hub.close();
    }
  };
  const shown = (hub: BridgeHub): unknown[] => hub.usageList().map((u) => [u.account?.id, u.windows.map((w) => `${w.id}=${w.usedPercent}`)]);
  const y = limits(5, '2026-10-01T04:00:00Z', 2, '2026-10-07T00:00:00Z');
  const xRolledOver = limits(90, '2026-10-01T05:00:00Z', 1, '2026-10-12T00:00:00Z');

  const provider = new ClaudeCodeProvider(options);
  await run(provider, async (hub) => {
    clock += 1000;
    entry(process.pid, oldProcess); // Born under X, after it was observed: teaches X's fingerprint.
    await provider.refresh();
    await provider.statusline({ session_id: oldProcess, rate_limits: limits(80, '2026-10-01T03:00:00Z', 60, '2026-10-05T00:00:00Z') });
    assert.deepEqual(shown(hub), [['acc-x', ['5h=80', '7d=60']]]);
    clock += 1000;
    login('acc-y', 'y@example.com');
    await provider.refresh();
    clock += 1000;
    entry(process.ppid, newProcess); // Born under Y.
    await provider.refresh();
    await provider.statusline({ session_id: newProcess, rate_limits: y });
    assert.deepEqual(shown(hub), [['acc-y', ['5h=5', '7d=2']]]);
    // X's weekly window resets: the old process reports a fingerprint never seen. It started under X, so these are X's numbers (not shown).
    await provider.statusline({ session_id: oldProcess, rate_limits: xRolledOver });
    assert.deepEqual(shown(hub), [['acc-y', ['5h=5', '7d=2']]]);
    await provider.statusline({ session_id: newProcess, rate_limits: limits(6, '2026-10-01T04:00:00Z', 3, '2026-10-07T00:00:00Z') });
    assert.deepEqual(shown(hub), [['acc-y', ['5h=6', '7d=3']]]);
  });

  // After a restart no fingerprint is known; the timeline still tells which login each process started under.
  const restarted = new ClaudeCodeProvider({ ...options, logins: saved });
  await run(restarted, async (hub) => {
    await restarted.statusline({ session_id: oldProcess, rate_limits: xRolledOver });
    assert.deepEqual(shown(hub), []);
    await restarted.statusline({ session_id: newProcess, rate_limits: y });
    assert.deepEqual(shown(hub), [['acc-y', ['5h=5', '7d=2']]]);
  });
});

test('claude-code: a session that switches accounts with /login loses its exact account until the new fingerprint is known', async () => {
  let clock = Date.now();
  const { home, login, entry } = accountHome('claude-relogin', () => clock);
  const [switched, fresh] = ['dddddddd-1111-4000-8000-000000000001', 'dddddddd-1111-4000-8000-000000000002'];
  login('acc-a', 'a@example.com');
  const hub = recordingHub();
  const provider = new ClaudeCodeProvider({ home, historyDays: 7, now: () => clock });
  await provider.start(hub);
  provider.stop();
  clock += 1000;
  entry(process.pid, switched); // Born after login A was observed.
  await provider.refresh();
  const account = (id: string): Session['account'] => provider.listSessions().find((s) => s.id === `claude-code:${id}`)?.account;
  const fA = { five_hour: { used_percentage: 10, resets_at: 1790701800 }, seven_day: { used_percentage: 5, resets_at: '2026-10-06T00:00:00Z' } };
  const fB = { five_hour: { used_percentage: 40, resets_at: 1790705400 }, seven_day: { used_percentage: 30, resets_at: '2026-10-04T00:00:00Z' } };
  await provider.statusline({ session_id: switched, rate_limits: fA });
  await provider.refresh();
  assert.deepEqual(account(switched), { id: 'acc-a', label: 'a@example.com' }, 'exact: learned from its own fingerprint');

  // The same process logs into B: the home's login changes and its statusLine now carries B's limits.
  // Nothing tells them from A's next window (an old process of A whose limits reset), so they count as A's until B's fingerprint is known.
  clock += 1000;
  login('acc-b', 'bob@example.com');
  entry(process.pid, switched, clock - 1000); // Active again, same process.
  await provider.statusline({ session_id: switched, rate_limits: fB });
  assert.deepEqual(hub.usages.at(-1)?.account, { id: 'acc-a', label: 'a@example.com', estimated: true });
  await provider.refresh();
  assert.deepEqual(account(switched), { id: 'acc-b', label: 'bob@example.com', estimated: true }, 'no longer A for certain');

  // A process born after login B teaches B's fingerprint; the switched session is then B for certain.
  clock += 1000;
  entry(process.ppid, fresh);
  await provider.refresh();
  await provider.statusline({ session_id: fresh, rate_limits: fB });
  await provider.statusline({ session_id: switched, rate_limits: fB });
  assert.deepEqual(hub.usages.at(-1)?.account, { id: 'acc-b', label: 'bob@example.com' });
  await provider.refresh();
  assert.deepEqual(account(switched), { id: 'acc-b', label: 'bob@example.com' });
});

test('claude-code: an unreadable .claude.json keeps the previous login and is logged once, not on every poll', async () => {
  const home = join(root, 'claude-unreadable');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  symlinkSync('.claude.json', join(home, '.claude.json')); // A symlink loop: stat fails with ELOOP, not ENOENT.
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
  try {
    const provider = new ClaudeCodeProvider({ home, historyDays: 7, logins: [{ at: '2026-01-01T00:00:00.000Z', id: 'acc-a', label: 'a@example.com' }] });
    const hub = recordingHub();
    await provider.start(hub);
    provider.stop();
    await provider.refresh();
    await provider.statusline({ session_id: 'x' });
    await provider.refresh();
    assert.equal(errors.filter((e) => e.includes(`login poll of ${home} failed`)).length, 1, errors.join('\n'));
    assert.deepEqual(hub.logins, ['acc-a'], 'a failed first read reports the newest login of the timeline, not a logout');
    // A session labelled by the timeline still gets the previous login.
    writeFileSync(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'aaaaaaaa-0000-4000-8000-0000000000aa', cwd: '/w', status: 'idle', startedAt: Date.now(), updatedAt: Date.now() }));
    await provider.refresh();
    assert.deepEqual(provider.listSessions()[0]?.account, { id: 'acc-a', label: 'a@example.com' });
  } finally {
    console.error = original;
  }
});

test('claude-code: a .claude.json unreadable at the first read reports the newest login of the timeline, and is read again once a chmod makes it readable', { skip: process.getuid?.() === 0 }, async (t) => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
  t.after(() => void (console.error = original));
  const { home, login } = accountHome('claude-chmod', () => Date.now());
  login('acc-b', 'bob@example.com');
  chmodSync(join(home, '.claude.json'), 0o000);
  const provider = new ClaudeCodeProvider({ home, historyDays: 7, logins: [{ at: '2026-01-01T00:00:00.000Z', id: 'acc-a', label: 'a@example.com' }] });
  const hub = recordingHub();
  await provider.start(hub);
  provider.stop();
  await provider.refresh();
  assert.deepEqual(hub.logins, ['acc-a']);
  assert.equal(errors.filter((e) => e.includes(`login poll of ${home} failed`)).length, 1, errors.join('\n'));
  chmodSync(join(home, '.claude.json'), 0o600); // Neither mtime nor size changes.
  await provider.refresh();
  assert.deepEqual(hub.logins, ['acc-a', 'acc-b']);
});

test('claude-code: a login whose id is an Object.prototype member is labelled by its email, not a prototype function', async () => {
  const clock = Date.now();
  const { home, login, entry } = accountHome('claude-proto', () => clock);
  login('constructor', 'c@example.com');
  entry(process.pid, 'bbbbbbbb-0000-4000-8000-0000000000bb');
  const provider = new ClaudeCodeProvider({ home, historyDays: 7, now: () => clock, labels: {} });
  await provider.start(recordingHub());
  provider.stop();
  assert.deepEqual(provider.listSessions()[0]?.account, { id: 'constructor', label: 'c@example.com' });
});
