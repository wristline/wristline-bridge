import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
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

/** Sends one raw request (undici would normalise the target) and resolves the status line. */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.on('data', (chunk: Buffer) => (data += chunk.toString()));
    socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

const UPGRADE_HEADERS = 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n';

test('a request-target URL cannot parse answers 400, also on the upgrade path', async () => {
  const port = bridge.server.apiPort;
  assert.equal(await raw(port, 'GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), 'HTTP/1.1 400 Bad Request');
  assert.equal(await raw(port, `GET //[ HTTP/1.1\r\nHost: x\r\n${UPGRADE_HEADERS}\r\n`), 'HTTP/1.1 400 Bad Request');
  assert.equal(await raw(bridge.server.hookPort, 'GET //[ HTTP/1.1\r\nHost: x\r\nauthorization: Bearer hook-token\r\nConnection: close\r\n\r\n'), 'HTTP/1.1 400 Bad Request');
  assert.equal((await fetch(`${bridge.base}/api/health`, auth(bridge.token))).status, 200);
});

test('a refused upgrade survives a peer reset and does not linger when the peer never closes', async () => {
  const own = await startBridge(new FakeProvider());
  try {
    const port = own.server.apiPort;
    const upgrade = `GET /api/ws HTTP/1.1\r\nHost: x\r\n${UPGRADE_HEADERS}\r\n`;
    for (let i = 0; i < 10; i++) {
      const socket = connect(port, '127.0.0.1');
      socket.on('error', () => {});
      await once(socket, 'connect');
      socket.write(upgrade);
      socket.resetAndDestroy(); // Reaches the bridge with the request: its reply hits a reset socket.
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal((await fetch(`${own.base}/api/health`, auth(own.token))).status, 200);

    // Half-open peer: reads the 401, never sends its own FIN. The bridge must close its side anyway.
    const peer = connect({ port, host: '127.0.0.1', allowHalfOpen: true });
    peer.resume();
    let closed = false;
    peer.on('error', () => {});
    peer.on('close', () => (closed = true));
    await once(peer, 'connect');
    peer.write(upgrade);
    await once(peer, 'end');
    for (let i = 0; i < 30 && !closed; i++) {
      peer.write('x'); // A destroyed server socket answers with RST; the next write then fails.
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(closed, true, 'the bridge kept the refused socket open');
    peer.destroy();
  } finally {
    await own.close();
  }
});

test('malformed percent-encoding in an id answers 400, not 500', async () => {
  const headers = auth(bridge.token);
  assert.equal((await fetch(`${bridge.base}/api/sessions/%zz/items`, headers)).status, 400);
  assert.equal((await fetch(`${bridge.base}/api/sessions/%zz/prompt`, { method: 'POST', ...headers, body: JSON.stringify({ text: 'hi' }) })).status, 400);
  assert.equal((await fetch(`${bridge.base}/api/requests/%zz`, { method: 'POST', ...headers, body: JSON.stringify({ answers: {} }) })).status, 400);
  assert.equal((await fetch(`${bridge.local}/local/devices/%zz`, { method: 'DELETE', ...auth(bridge.hookToken) })).status, 400);
});

test('revoking closes the device connections even when saving the device list fails', async () => {
  let failSave = false;
  const own = await startBridge(new FakeProvider(), undefined, undefined, async () => {
    if (failSave) throw new Error('disk full');
  });
  try {
    const first = await own.auth.issue('via local');
    const second = await own.auth.issue('via public');
    const sockets = await Promise.all([first, second].map((d) => new TestSocket(`${own.base.replace('http', 'ws')}/api/ws`, d.token).open()));
    const closes = sockets.map((s) => once(s.ws, 'close'));
    failSave = true;
    assert.equal((await fetch(`${own.local}/local/devices/${first.device.id}`, { method: 'DELETE', ...auth(own.hookToken) })).status, 500);
    assert.equal((await fetch(`${own.base}/api/device`, { method: 'DELETE', ...auth(second.token) })).status, 500);
    for (const close of closes) assert.equal(((await close) as [number])[0], CLOSE_REVOKED);
    assert.equal((await fetch(`${own.base}/api/sessions`, auth(first.token))).status, 401);
    assert.equal((await fetch(`${own.base}/api/sessions`, auth(second.token))).status, 401);
  } finally {
    await own.close();
  }
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
