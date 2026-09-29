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
  isEstimated,
  loginAt,
  readClaudeAccount,
  statuslineFingerprint,
} from '../src/providers/claude-code/account.ts';
import { readCodexLogin } from '../src/providers/codex/account.ts';

const root = mkdtempSync(join(tmpdir(), 'wristline-accounts-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('claudeJsonPath: inside a custom home; beside the default home unless that home has its own', async () => {
  const homeDir = join(root, 'home');
  const home = join(homeDir, '.claude');
  mkdirSync(home, { recursive: true });
  assert.equal(await claudeJsonPath('/x/.claude-school', homeDir), '/x/.claude-school/.claude.json');
  assert.equal(await claudeJsonPath(home, homeDir), join(homeDir, '.claude.json'));
  assert.equal(await claudeJsonPath(`${home}/`, homeDir), join(homeDir, '.claude.json'));
  writeFileSync(join(home, '.claude.json'), '{}');
  assert.equal(await claudeJsonPath(home, homeDir), join(home, '.claude.json'));
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

test('readCodexLogin: only the account id and email leave auth.json; API-key, missing and broken logins → undefined', async () => {
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
  write({ tokens: { id_token: 'not.a.jwt' } });
  assert.equal(await readCodexLogin(home), undefined);
  write('{');
  assert.equal(await readCodexLogin(home), undefined);
});
