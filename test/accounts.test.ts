import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { LoginEntry } from '../src/config.ts';
import {
  LOGINS_MAX,
  appendLogin,
  claudeJsonPath,
  isDefaultClaudeHome,
  isEstimated,
  loginAt,
  readClaudeAccount,
  statuslineFingerprint,
} from '../src/providers/claude-code/account.ts';
import { CodexAccounts, readCodexLogin } from '../src/providers/codex/account.ts';

const root = mkdtempSync(join(tmpdir(), 'wristline-accounts-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('claudeJsonPath: inside a custom home; beside the default home even when that home holds a copy (as Claude Code without CLAUDE_CONFIG_DIR)', async () => {
  const homeDir = join(root, 'home');
  const home = join(homeDir, '.claude');
  mkdirSync(home, { recursive: true });
  assert.equal(claudeJsonPath('/x/.claude-school', homeDir), '/x/.claude-school/.claude.json');
  assert.equal(claudeJsonPath(home, homeDir), join(homeDir, '.claude.json'));
  assert.equal(claudeJsonPath(`${home}/`, homeDir), join(homeDir, '.claude.json'));
  assert.ok(isDefaultClaudeHome(`${home}/`, homeDir) && !isDefaultClaudeHome('/x/.claude-school', homeDir));
  // A copy left by a run with CLAUDE_CONFIG_DIR=~/.claude is not where a plain `claude` records its /login.
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-stale', emailAddress: 'old@example.com' } }));
  writeFileSync(join(homeDir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-live', emailAddress: 'new@example.com' } }));
  assert.equal(claudeJsonPath(home, homeDir), join(homeDir, '.claude.json'));
  assert.deepEqual(await readClaudeAccount(home, homeDir), { id: 'uuid-live', label: 'new@example.com' });
});

test('readClaudeAccount: email, organization and id fallbacks; no oauthAccount or file → undefined; bad JSON rejects', async () => {
  const homeDir = join(root, 'home2');
  const home = join(homeDir, '.claude');
  mkdirSync(home, { recursive: true });
  const write = (value: unknown): void => writeFileSync(join(homeDir, '.claude.json'), typeof value === 'string' ? value : JSON.stringify(value));
  assert.equal(await readClaudeAccount(home, homeDir), undefined);
  write({ numStartups: 3, oauthAccount: { accountUuid: 'uuid-a', emailAddress: 'a@example.com', organizationName: 'Org A' } });
  assert.deepEqual(await readClaudeAccount(home, homeDir), { id: 'uuid-a', label: 'a@example.com' });
  write({ oauthAccount: { accountUuid: 'uuid-a', organizationName: 'Org A' } });
  assert.deepEqual(await readClaudeAccount(home, homeDir), { id: 'uuid-a', label: 'Org A' });
  write({ oauthAccount: { accountUuid: 'uuid-abcdef', emailAddress: '' } });
  assert.deepEqual(await readClaudeAccount(home, homeDir), { id: 'uuid-abcdef', label: 'uuid-abc' });
  // setup and accounts print the label: control characters could rewrite the prompt that asks to enrol a directory.
  write({ oauthAccount: { accountUuid: 'uuid-a', emailAddress: 'ok@x.y\r\u001b[KAdd ~/.claude (login: me@x.y)?' } });
  assert.deepEqual(await readClaudeAccount(home, homeDir), { id: 'uuid-a', label: 'ok@x.y [KAdd ~/.claude (login: me@x.y)?' }, 'the escape byte is gone; its tail is plain text');
  write({ oauthAccount: { accountUuid: 'uuid-a', emailAddress: '\u0007', organizationName: 'Org A' } });
  assert.deepEqual(await readClaudeAccount(home, homeDir), { id: 'uuid-a', label: 'Org A' });
  write({ numStartups: 3 });
  assert.equal(await readClaudeAccount(home, homeDir), undefined);
  write({ oauthAccount: { emailAddress: 'a@example.com' } });
  assert.equal(await readClaudeAccount(home, homeDir), undefined);
  write('{');
  await assert.rejects(readClaudeAccount(home, homeDir), /not valid JSON/);
  const custom = join(root, 'custom');
  mkdirSync(custom);
  writeFileSync(join(custom, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-b', emailAddress: 'b@example.com' } }));
  assert.deepEqual(await readClaudeAccount(custom, homeDir), { id: 'uuid-b', label: 'b@example.com' });
});

test('appendLogin, loginAt and isEstimated follow the observed login timeline', () => {
  const t0 = Date.parse('2026-09-30T00:00:00Z');
  const hour = 3600_000;
  const a = { id: 'acc-a', label: 'a@example.com' };
  const b = { id: 'acc-b', label: 'b@example.com' };
  let logins: LoginEntry[] = [];
  logins = appendLogin(logins, a, t0);
  assert.deepEqual(logins, [{ at: '2026-09-30T00:00:00.000Z', id: 'acc-a', label: 'a@example.com' }]);
  assert.equal(appendLogin(logins, a, t0 + 1000), logins, 'same id and label: the same array');
  assert.deepEqual(appendLogin(logins, { id: 'acc-a', label: 'me' }, t0 + 1000), [{ at: '2026-09-30T00:00:00.000Z', id: 'acc-a', label: 'me' }]);
  assert.equal(isEstimated([]), false);
  assert.equal(isEstimated([], t0 - 1), false);
  assert.equal(isEstimated(logins), false);
  assert.equal(isEstimated(logins, t0), false);
  assert.equal(isEstimated(logins, t0 - 1), true, 'a process older than the first observation');
  logins = appendLogin(logins, b, t0 + hour);
  assert.deepEqual(logins.map((l) => l.id), ['acc-a', 'acc-b']);
  assert.equal(isEstimated(logins, t0 + 2 * hour), true, 'two ids: every time-based attribution is a guess');
  assert.equal(loginAt(logins, t0 - 1), undefined);
  assert.equal(loginAt(logins, t0)?.id, 'acc-a');
  assert.equal(loginAt(logins, t0 + hour - 1)?.id, 'acc-a');
  assert.equal(loginAt(logins, t0 + hour)?.id, 'acc-b');
  assert.equal(loginAt(logins, t0 + 99 * hour)?.id, 'acc-b');
  for (let i = 0; i < LOGINS_MAX + 5; i++) logins = appendLogin(logins, i % 2 ? a : b, t0 + (i + 2) * hour);
  assert.equal(logins.length, LOGINS_MAX);
  assert.equal(logins.at(-1)?.at, new Date(t0 + (LOGINS_MAX + 6) * hour).toISOString(), 'the newest is kept');
  assert.ok(Date.parse(logins[0]?.at ?? '') > t0 + hour, 'the oldest are dropped');
});

test('statuslineFingerprint: the 7d reset time, else the 5h one, as ISO', () => {
  const limits = { five_hour: { used_percentage: 9, resets_at: 1790701800 }, seven_day: { used_percentage: 5, resets_at: 1791244800 } };
  assert.equal(statuslineFingerprint({ session_id: 'x', rate_limits: limits }), '2026-10-06T00:00:00.000Z');
  assert.equal(statuslineFingerprint({ rate_limits: { five_hour: { used_percentage: 9, resets_at: '2026-09-29T17:10:00Z' } } }), '2026-09-29T17:10:00.000Z');
  assert.equal(statuslineFingerprint({ rate_limits: { five_hour: { used_percentage: 9 }, seven_day: null } }), undefined);
  assert.equal(statuslineFingerprint({ session_id: 'x' }), undefined);
});

function unsignedJwt(claims: unknown): string {
  const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${segment({ alg: 'none', typ: 'JWT' })}.${segment(claims)}.signature`;
}

test('readCodexLogin: only the account id and email leave auth.json; API-key, missing and broken logins → undefined; a file that is not JSON (e.g. half-written) rejects', async () => {
  const home = join(root, 'codex');
  mkdirSync(home);
  const write = (value: unknown): void => writeFileSync(join(home, 'auth.json'), typeof value === 'string' ? value : JSON.stringify(value));
  assert.equal(await readCodexLogin(home), undefined);
  const idToken = unsignedJwt({
    email: 'c@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1234567890', chatgpt_plan_type: 'plus', user_id: 'user-1' },
    exp: 1_800_000_000,
  });
  const auth = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: idToken, access_token: 'ACCESS-SECRET', refresh_token: 'REFRESH-SECRET', account_id: 'acct-1234567890' },
    last_refresh: '2026-09-30T00:00:00Z',
  };
  write(auth);
  const login = await readCodexLogin(home);
  assert.deepEqual(login, { id: 'acct-1234567890', label: 'c@example.com' });
  const text = JSON.stringify(login);
  for (const secret of [idToken, 'ACCESS-SECRET', 'REFRESH-SECRET', 'user-1']) assert.equal(text.includes(secret), false, `leaks ${secret.slice(0, 6)}`);
  write({ ...auth, auth_mode: 'apikey' });
  assert.equal(await readCodexLogin(home), undefined);
  write({ auth_mode: 'chatgpt', tokens: { access_token: 'ACCESS-SECRET' } });
  assert.equal(await readCodexLogin(home), undefined);
  write({ tokens: { id_token: unsignedJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1234567890' } }) } });
  assert.deepEqual(await readCodexLogin(home), { id: 'acct-1234567890', label: 'acct-123' }, 'no email claim: short id');
  write({ tokens: { id_token: unsignedJwt({ email: 'c@example.com' }) } });
  assert.equal(await readCodexLogin(home), undefined, 'no account claim');
  write({ tokens: { id_token: unsignedJwt({ email: 'c@x.y\n\u001b[2K', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1234567890' } }) } });
  assert.deepEqual(await readCodexLogin(home), { id: 'acct-1234567890', label: 'c@x.y [2K' }, 'control characters never reach the terminal');
  write({ tokens: { id_token: 'not.a.jwt' } });
  assert.equal(await readCodexLogin(home), undefined);
  write('{');
  await assert.rejects(readCodexLogin(home), /not valid JSON/);
  write('');
  await assert.rejects(readCodexLogin(home), /not valid JSON/);
});

test('codex login timeline: a login is noted when first seen and saved, a repeat only now and then as still seen; loginAt is the login in effect, none before the first one seen or while unknown', () => {
  const saved: unknown[] = [];
  const accounts = new CodexAccounts({ saveLogins: async (logins) => void saved.push(logins) });
  const t = (hm: string): number => Date.parse(`2026-09-29T${hm}:00.000Z`);
  accounts.noteLogin('', t('08:00')); // Nothing known yet: an unknown start is no entry.
  accounts.noteLogin('A', t('09:00'));
  accounts.noteLogin('A', t('09:05'));
  accounts.noteLogin('A', t('09:10')); // Ten minutes on: saved as still seen.
  accounts.noteLogin('', t('09:20')); // E.g. the daemon still serves A after auth.json switched to B.
  accounts.noteLogin('', t('09:25'));
  accounts.noteLogin('B', t('09:30'));
  const a = { at: '2026-09-29T09:00:00.000Z', id: 'A' };
  const seen = { ...a, seen: '2026-09-29T09:10:00.000Z' };
  assert.deepEqual(saved, [
    [a],
    [seen],
    [seen, { at: '2026-09-29T09:20:00.000Z', id: '' }],
    [seen, { at: '2026-09-29T09:20:00.000Z', id: '' }, { at: '2026-09-29T09:30:00.000Z', id: 'B' }],
  ]);
  assert.deepEqual(['08:59', '09:00', '09:19', '09:25', '09:30', '23:00'].map((hm) => accounts.loginAt(t(hm))), [undefined, 'A', 'A', undefined, 'B', 'B']);
});

test('codex login timeline after a restart: the same login goes on; another one changed while the bridge was not running, so the login is unknown from when the saved one was last seen', () => {
  const t = (hm: string): number => Date.parse(`2026-09-29T${hm}:00.000Z`);
  const b = { at: '2026-09-29T09:30:00.000Z', id: 'B', seen: '2026-09-29T09:50:00.000Z' };
  const run = (logins: { at: string; id: string; seen?: string }[], ...noted: [string, string][]): { saved: unknown[]; accounts: CodexAccounts } => {
    const saved: unknown[] = [];
    const accounts = new CodexAccounts({ logins, saveLogins: async (l) => void saved.push(l) });
    for (const [id, hm] of noted) accounts.noteLogin(id, t(hm));
    return { saved, accounts };
  };
  const same = run([b], ['B', '09:55'], ['B', '10:00']);
  assert.deepEqual(same.saved, [[{ ...b, seen: '2026-09-29T10:00:00.000Z' }]]);
  assert.equal(same.accounts.loginAt(t('09:29')), undefined);
  const other = run([b], ['A', '10:00'], ['B', '10:05']);
  assert.deepEqual(other.saved.at(0), [b, { at: '2026-09-29T09:50:00.000Z', id: '' }, { at: '2026-09-29T10:00:00.000Z', id: 'A' }]);
  assert.deepEqual(['09:49', '09:50', '09:59', '10:00', '10:05'].map((hm) => other.accounts.loginAt(t(hm))), ['B', undefined, undefined, 'A', 'B'], 'a later change is seen when it happens');
  // Not known at the start either (the daemon's login is not read yet): one unknown entry, from when B was last seen.
  assert.deepEqual(run([b], ['', '10:00']).saved, [[b, { at: '2026-09-29T09:50:00.000Z', id: '' }]]);
  // Saved before `seen` existed: from its own time on.
  const old = { at: b.at, id: b.id };
  assert.deepEqual(run([old], ['A', '10:00']).saved, [[old, { at: '2026-09-29T09:30:00.000Z', id: '' }, { at: '2026-09-29T10:00:00.000Z', id: 'A' }]]);
  // Unknown already: nothing to add before the login.
  assert.deepEqual(run([b, { at: '2026-09-29T09:40:00.000Z', id: '' }], ['A', '10:00']).saved, [[b, { at: '2026-09-29T09:40:00.000Z', id: '' }, { at: '2026-09-29T10:00:00.000Z', id: 'A' }]]);
});

test('account labels: an id named like an Object.prototype member gets a string label, never the prototype function', () => {
  const accounts = new CodexAccounts({ labels: { 'acc-a': 'me' }, accounts: { toString: 't@example.com' } });
  assert.deepEqual(accounts.account('acc-a'), { id: 'acc-a', label: 'me' });
  assert.deepEqual(accounts.account('constructor'), { id: 'constructor', label: 'construc' });
  assert.deepEqual(accounts.account('toString'), { id: 'toString', label: 't@example.com' });
  assert.equal(JSON.stringify(accounts.account('valueOf')).includes('label'), true);
});
