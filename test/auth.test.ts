import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auth, sha256 } from '../src/auth.ts';
import type { Device } from '../src/config.ts';

function setup(): { auth: Auth; saved: Device[][]; clock: { now: number } } {
  const clock = { now: Date.parse('2026-09-29T10:00:00Z') };
  const saved: Device[][] = [];
  const auth = new Auth({ devices: [], save: async (d) => void saved.push(d), now: () => clock.now });
  return { auth, saved, clock };
}

test('a pairing code issues a token once; only its sha256 is stored', async () => {
  const { auth, saved } = setup();
  const { code, expiresAt } = auth.startPairing();
  assert.match(code, /^\d{6}$/);
  assert.equal(expiresAt, '2026-09-29T10:05:00.000Z');
  const issued = await auth.pair(code, 'Galaxy Watch');
  assert.ok(typeof issued === 'object');
  assert.equal(issued.device.name, 'Galaxy Watch');
  assert.equal(issued.device.tokenSha256, sha256(issued.token).toString('hex'));
  assert.ok(!JSON.stringify(saved).includes(issued.token));
  assert.equal(auth.authenticate(issued.token)?.id, issued.device.id);
  assert.equal(await auth.pair(code, 'again'), 'no_window');
});

test('the code expires after 5 minutes', async () => {
  const { auth, clock } = setup();
  const { code } = auth.startPairing();
  clock.now += 5 * 60_000;
  assert.equal(await auth.pair(code, 'late'), 'no_window');
});

test('5 wrong codes close the window', async () => {
  const { auth } = setup();
  const { code } = auth.startPairing();
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal(await auth.pair(wrong, 'x'), 'invalid_code');
  assert.equal(await auth.pair(code, 'x'), 'no_window');
});

test('pairing attempts while no window is open count towards the lockout', async () => {
  const { auth } = setup();
  for (let i = 0; i < 20; i++) assert.equal(await auth.pair('000000', 'x'), 'no_window');
  assert.equal(auth.locked(), false);
  assert.equal(await auth.pair('000000', 'x'), 'no_window');
  assert.equal(auth.locked(), true);
});

test('tokens are compared in constant time and revocation takes effect', async () => {
  const { auth } = setup();
  const one = await auth.issue('one');
  const two = await auth.issue('two');
  assert.equal(auth.authenticate(two.token)?.name, 'two');
  assert.equal(auth.authenticate(undefined), undefined);
  assert.equal(auth.authenticate(''), undefined);
  assert.equal(auth.authenticate(one.token.slice(1)), undefined);
  assert.equal(auth.authenticate(one.device.tokenSha256), undefined, 'the stored hash is not a credential');
  assert.equal(await auth.revoke(one.device.id), true);
  assert.equal(auth.authenticate(one.token), undefined);
  assert.equal(await auth.revoke(one.device.id), false);
  assert.deepEqual(
    auth.devices().map((d) => d.name),
    ['two'],
  );
});

test('more than 20 failures per minute lock for 60 s', () => {
  const { auth, clock } = setup();
  for (let i = 0; i < 20; i++) auth.recordFailure();
  assert.equal(auth.locked(), false);
  auth.recordFailure();
  assert.equal(auth.locked(), true);
  assert.equal(auth.retryAfterSec(), 60);
  clock.now += 60_000;
  assert.equal(auth.locked(), false);
});

test('failures older than a minute do not count', () => {
  const { auth, clock } = setup();
  for (let i = 0; i < 20; i++) auth.recordFailure();
  clock.now += 60_000;
  auth.recordFailure();
  assert.equal(auth.locked(), false);
});
