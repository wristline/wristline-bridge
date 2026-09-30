import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { CLOSE_REVOKED, type Item, type ItemKind, type ItemPage, type Session } from '../src/protocol.ts';
import { FakeProvider, TestSocket, startBridge, waitFor, type Bridge } from './helpers.ts';

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
  assert.equal((await fetch(`${bridge.local}/local/presence`, auth(bridge.token))).status, 401);
  assert.deepEqual(await (await fetch(`${bridge.local}/local/presence`, auth(bridge.hookToken))).json(), { watch: false, since: null });
  const pair = await fetch(`${bridge.local}/local/pair`, { method: 'POST', ...auth(bridge.hookToken) });
  const { code } = (await pair.json()) as { code: string };
  assert.match(code, /^\d{6}$/);
  const issued = await fetch(`${bridge.local}/local/pair`, { method: 'POST', ...auth(bridge.hookToken), body: JSON.stringify({ token: true, name: 'manual' }) });
  const { token, deviceId } = (await issued.json()) as { token: string; deviceId: string };
  assert.equal((await fetch(`${bridge.base}/api/sessions`, auth(token))).status, 200);

  const ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, token).open();
  const closed = once(ws.ws, 'close');
  assert.deepEqual(await (await fetch(`${bridge.local}/local/presence`, auth(bridge.hookToken))).json(), { watch: true, since: '2026-09-29T10:00:00.000Z' });
  const list = (await (await fetch(`${bridge.local}/local/devices`, auth(bridge.hookToken))).json()) as { devices: { id: string }[] };
  assert.ok(list.devices.some((d) => d.id === deviceId));
  assert.equal((await fetch(`${bridge.local}/local/devices/${deviceId}`, { method: 'DELETE', ...auth(bridge.hookToken) })).status, 204);
  const [codeClosed] = (await closed) as [number];
  assert.equal(codeClosed, CLOSE_REVOKED);
  await waitFor(() => !bridge.hub.pending.presence().watch || undefined);
  assert.deepEqual(
    await (await fetch(`${bridge.local}/local/presence`, auth(bridge.hookToken))).json(),
    { watch: false, graceUntil: '2026-09-29T10:01:30.000Z', since: '2026-09-29T10:00:00.000Z' },
    'gone at once; the permission grace runs on',
  );
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

const item = (seq: number, kind: ItemKind, extra: Partial<Item> = {}): Item => ({ seq, kind, ts: '2026-09-29T10:00:00.000Z', text: `${kind} ${seq}`, ...extra });

test('items?kinds= pages over the matching items only; an unknown kind answers 400', async () => {
  const kinds: ItemKind[] = ['user', 'tool', 'assistant', 'tool', 'tool', 'notice', 'tool', 'user', 'tool', 'assistant', 'tool'];
  provider.items.set('s1', kinds.map((kind, i) => item(i + 1, kind)));
  const page = async (query: string): Promise<[number[], boolean]> => {
    const res = await fetch(`${bridge.base}/api/sessions/claude-code:s1/items?${query}`, auth(bridge.token));
    assert.equal(res.status, 200, query);
    const body = (await res.json()) as ItemPage;
    return [body.items.map((i) => i.seq), body.hasMore];
  };
  try {
    const talk = 'kinds=user,assistant,notice';
    assert.deepEqual(await page(`${talk}&limit=2`), [[8, 10], true], 'the trailing tool item is skipped');
    assert.deepEqual(await page(`${talk}&limit=2&before=8`), [[3, 6], true], 'before is the smallest seq of the previous page');
    assert.deepEqual(await page(`${talk}&limit=2&before=3`), [[1], false]);
    assert.deepEqual(await page(`${talk}&limit=5`), [[1, 3, 6, 8, 10], false], 'exactly the matching items: no more');
    assert.deepEqual(await page(`kinds=assistant&limit=1&before=10`), [[3], false], 'hasMore stays false when only other kinds are older');
    assert.deepEqual(await page('kinds=tool,tool&limit=3'), [[7, 9, 11], true]);
    assert.deepEqual(await page('limit=3'), [[9, 10, 11], true], 'without kinds, every item counts');
    for (const bad of ['bogus', 'user,bogus', '', 'user,', 'user,%20assistant', 'USER']) {
      const res = await fetch(`${bridge.base}/api/sessions/claude-code:s1/items?kinds=${bad}`, auth(bridge.token));
      assert.equal(res.status, 400, `kinds=${bad}`);
      assert.deepEqual(await res.json(), { error: 'bad_request' });
    }
  } finally {
    provider.items.set('s1', []);
  }
});

test('a subscription with kinds receives only item events of those kinds; without, every item', async () => {
  const url = `${bridge.base.replace('http', 'ws')}/api/ws`;
  const open = (): Promise<TestSocket> => new TestSocket(url, bridge.token).open();
  const [filtered, all, malformed] = await Promise.all([open(), open(), open()]);
  try {
    for (const ws of [filtered, all, malformed]) assert.equal((await ws.next()).type, 'snapshot');
    filtered.send({ type: 'subscribe', sessionId: session.id, kinds: ['user', 'assistant', 'notice', 'future_kind'] });
    all.send({ type: 'subscribe', sessionId: session.id });
    malformed.send({ type: 'subscribe', sessionId: session.id, kinds: 'user' }); // Ignored like any malformed subscribe.
    await new Promise((r) => setTimeout(r, 100));

    const [user, tool, assistant, done, notice] = [item(1, 'user'), item(2, 'tool', { pending: true }), item(3, 'assistant'), item(2, 'tool', { pending: false }), item(4, 'notice')];
    const sent = [user, tool, assistant, done, notice];
    for (const i of sent) provider.emit('s1', i);
    for (const i of sent) assert.deepEqual(await all.next(), { type: 'item', sessionId: session.id, item: i });
    for (const i of [user, assistant, notice]) assert.deepEqual(await filtered.next(), { type: 'item', sessionId: session.id, item: i });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(filtered.pending(), 0, 'the tool item and its update are not sent');
    assert.equal(malformed.pending(), 0);

    // Subscribing again without kinds drops the filter.
    filtered.send({ type: 'subscribe', sessionId: session.id, kinds: null });
    await new Promise((r) => setTimeout(r, 100));
    provider.emit('s1', item(5, 'tool'));
    assert.deepEqual(await filtered.next(), { type: 'item', sessionId: session.id, item: item(5, 'tool') });
  } finally {
    for (const ws of [filtered, all, malformed]) ws.close();
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
