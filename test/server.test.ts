import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { CLOSE_REVOKED, type Session } from '../src/protocol.ts';
import { FakeProvider, TestSocket, startBridge, type Bridge } from './helpers.ts';

const session: Session = {
  id: 'claude-code:s1',
  provider: 'claude-code',
  title: 't',
  cwd: '/w',
  status: 'idle',
  lastActivity: '2026-09-29T10:00:00.000Z',
};
const provider = new FakeProvider();
provider.sessions = [session];
provider.items.set('s1', []);
let bridge: Bridge;

before(async () => {
  bridge = await startBridge(provider);
});
after(() => bridge.close());

const auth = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });

test('prompt: 202 when accepted, 413 when too long, 400 without text', async () => {
  const url = `${bridge.base}/api/sessions/claude-code:s1/prompt`;
  const send = (body: unknown): Promise<Response> =>
    fetch(url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify(body) });
  assert.equal((await send({ text: 'hi' })).status, 202);
  assert.equal((await send({ text: 'x'.repeat(4001) })).status, 413);
  assert.equal((await send({})).status, 400);
  const huge = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: 'x'.repeat(70 * 1024) });
  assert.equal(huge.status, 413);
});

test('the local listener requires the hook token and manages devices', async () => {
  assert.equal((await fetch(`${bridge.local}/local/devices`)).status, 401);
  assert.equal((await fetch(`${bridge.local}/local/devices`, auth(bridge.token))).status, 401);
  const pair = await fetch(`${bridge.local}/local/pair`, { method: 'POST', ...auth(bridge.hookToken) });
  const { code } = (await pair.json()) as { code: string };
  assert.match(code, /^\d{6}$/);
  const issued = await fetch(`${bridge.local}/local/pair`, { method: 'POST', ...auth(bridge.hookToken), body: JSON.stringify({ token: true, name: 'manual' }) });
  const { token, deviceId } = (await issued.json()) as { token: string; deviceId: string };
  assert.equal((await fetch(`${bridge.base}/api/sessions`, auth(token))).status, 200);

  const ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, token).open();
  const closed = once(ws.ws, 'close');
  const list = (await (await fetch(`${bridge.local}/local/devices`, auth(bridge.hookToken))).json()) as { devices: { id: string }[] };
  assert.ok(list.devices.some((d) => d.id === deviceId));
  assert.equal((await fetch(`${bridge.local}/local/devices/${deviceId}`, { method: 'DELETE', ...auth(bridge.hookToken) })).status, 204);
  const [codeClosed] = (await closed) as [number];
  assert.equal(codeClosed, CLOSE_REVOKED);
  assert.equal((await fetch(`${bridge.base}/api/sessions`, auth(token))).status, 401);
  assert.equal((await fetch(`${bridge.local}/local/devices/${deviceId}`, { method: 'DELETE', ...auth(bridge.hookToken) })).status, 404);
});

test('DELETE /api/device revokes the calling device', async () => {
  const { token } = await bridge.auth.issue('temp');
  assert.equal((await fetch(`${bridge.base}/api/device`, { method: 'DELETE', ...auth(token) })).status, 204);
  assert.equal((await fetch(`${bridge.base}/api/health`, auth(token))).status, 401);
});

test('a WebSocket upgrade without a valid token is refused with 401', async () => {
  const ws = new WebSocket(`${bridge.base.replace('http', 'ws')}/api/ws`);
  ws.on('error', () => {});
  const [, res] = (await once(ws, 'unexpected-response')) as [unknown, { statusCode: number; headers: Record<string, string> }];
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['www-authenticate'], 'Bearer realm="wristline"');
  ws.terminate();
});

test('pairing: 401 for a wrong code, 404 once the window closed', async () => {
  const pair = (code: string): Promise<Response> =>
    fetch(`${bridge.base}/api/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName: 'w' }) });
  const { code } = bridge.auth.startPairing();
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await pair('12')).status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await pair(wrong)).status, 401);
  assert.equal((await pair(code)).status, 404);
});

// Runs last: it locks the listener for 60 s.
test('more than 20 failed attempts a minute answer 429, but valid tokens still pass', async () => {
  let last = 0;
  for (let i = 0; i < 25; i++) last = (await fetch(`${bridge.base}/api/health`, auth('wrong'))).status;
  assert.equal(last, 429);
  const locked = await fetch(`${bridge.base}/api/health`);
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal((await fetch(`${bridge.base}/api/health`, auth(bridge.token))).status, 200);
  const pair = await fetch(`${bridge.base}/api/pair`, { method: 'POST', body: '{}' });
  assert.equal(pair.status, 429);
});
