import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { LoginEntry } from '../src/config.ts';
import type { Session, Usage } from '../src/protocol.ts';
import { ClaudeCodeProvider } from '../src/providers/claude-code/provider.ts';
import { recordingHub } from './helpers.ts';

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

test('claude-code: statusLine usage goes to the learned fingerprint\'s account, else to the current login (an estimate for older processes)', async () => {
  let clock = Date.now();
  const { home, login, entry } = accountHome('claude-fingerprint', () => clock);
  const [older, newer, peer] = ['eeeeeeee-0000-4000-8000-000000000011', 'eeeeeeee-0000-4000-8000-000000000012', 'eeeeeeee-0000-4000-8000-000000000013'];
  login('acc-a', 'a@example.com');
  entry(process.pid, older, clock - 60_000); // Born before the bridge saw any login here.
  entry(2147483646, peer, clock - 30_000);
  const hub = recordingHub();
  const provider = new ClaudeCodeProvider({ home, historyDays: 7, now: () => clock });
  await provider.start(hub);
  provider.stop();
  clock += 1000;
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
  await provider.statusline({ session_id: older, rate_limits: fOld });
  assert.deepEqual(last(), { id: 'acc-b', label: 'bob@example.com', estimated: true }, 'unknown fingerprint from an older process: current login, estimated');
  await provider.refresh();
  assert.deepEqual(account(newer), { id: 'acc-b', label: 'bob@example.com' }, 'the session keeps the exact account');
  assert.deepEqual(account(older), { id: 'acc-a', label: 'a@example.com', estimated: true });

  clock += 1000;
  login('acc-c', 'carol@example.com'); // statusline() itself notices the switch.
  await provider.statusline({ session_id: peer, rate_limits: fB });
  assert.deepEqual(last(), { id: 'acc-b', label: 'bob@example.com' }, 'the learned fingerprint wins over the current login');
  await provider.statusline({ session_id: older, rate_limits: fOld });
  assert.deepEqual(last(), { id: 'acc-c', label: 'carol@example.com', estimated: true });
  await provider.statusline({ session_id: 'unknown', rate_limits: fOld });
  assert.deepEqual(last(), { id: 'acc-c', label: 'carol@example.com', estimated: true });
  assert.equal(provider.hasSession(newer), true);
  assert.equal(provider.hasSession(peer), false, 'a dead registry entry is not a session');
  assert.equal(provider.home, home);
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
  clock += 1000;
  login('acc-b', 'bob@example.com');
  entry(process.pid, switched, clock - 1000); // Active again, same process.
  await provider.statusline({ session_id: switched, rate_limits: fB });
  assert.deepEqual(hub.usages.at(-1)?.account, { id: 'acc-b', label: 'bob@example.com', estimated: true });
  await provider.refresh();
  assert.deepEqual(account(switched), { id: 'acc-b', label: 'bob@example.com', estimated: true }, 'no longer A for certain');

  // A process born after login B teaches B's fingerprint; the switched session is then B for certain.
  clock += 1000;
  entry(process.ppid, fresh);
  await provider.refresh();
  await provider.statusline({ session_id: fresh, rate_limits: fB });
  await provider.statusline({ session_id: switched, rate_limits: fB });
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
    await provider.start(recordingHub());
    provider.stop();
    await provider.refresh();
    await provider.statusline({ session_id: 'x' });
    await provider.refresh();
    assert.equal(errors.filter((e) => e.includes(`login poll of ${home} failed`)).length, 1, errors.join('\n'));
    // A session labelled by the timeline still gets the previous login.
    writeFileSync(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'aaaaaaaa-0000-4000-8000-0000000000aa', cwd: '/w', status: 'idle', startedAt: Date.now(), updatedAt: Date.now() }));
    await provider.refresh();
    assert.deepEqual(provider.listSessions()[0]?.account, { id: 'acc-a', label: 'a@example.com' });
  } finally {
    console.error = original;
  }
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
