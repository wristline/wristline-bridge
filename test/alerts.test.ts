// Missed alerts: the hub buffers the last few and the snapshot replays them, except a `done` alert
// raised while no watch was present (a Stop hook such as a Slack notifier posted that one).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Alert, ServerEvent } from '../src/protocol.ts';
import { FakeProvider, TestSocket, startBridge, waitFor, type Bridge } from './helpers.ts';

const T = Date.parse('2026-09-29T10:00:00Z');
let clock = T;
let bridge: Bridge;

before(async () => {
  bridge = await startBridge(new FakeProvider(), () => clock);
});
after(() => bridge.close());

async function snapshotAlerts(): Promise<Alert[]> {
  const ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
  const snapshot = await ws.next();
  ws.close();
  assert.equal(snapshot.type, 'snapshot');
  return snapshot.type === 'snapshot' ? snapshot.alerts : [];
}

/** A watch connected now (so `presence` says `watch: true`), past its snapshot. */
async function connect(): Promise<TestSocket> {
  const ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
  assert.equal((await ws.next()).type, 'snapshot');
  return ws;
}

/** Until the bridge has seen every earlier socket close. */
async function noWatch(): Promise<void> {
  await waitFor(() => (bridge.hub.presence().watch ? undefined : true));
}

test('an alert event carries a stable id and time; the snapshot replays it unchanged, oldest first', async () => {
  const ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
  assert.deepEqual((await ws.next()).type === 'snapshot' && (await snapshotAlerts()), [], 'nothing buffered yet');
  bridge.hub.alert('claude-code:s1', 'needs_input', 'Claude needs your permission');
  clock = T + 1000;
  bridge.hub.alert('claude-code:s1', 'done', 'All green.', 'Fix the build');
  const first = (await ws.next()) as ServerEvent & { type: 'alert' };
  const second = (await ws.next()) as ServerEvent & { type: 'alert' };
  ws.close();
  const { type: _t1, ...one } = first;
  const { type: _t2, ...two } = second;
  assert.match(one.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(one.id, two.id);
  assert.equal(two.at, '2026-09-29T10:00:01.000Z');
  assert.deepEqual(first, { type: 'alert', id: one.id, at: '2026-09-29T10:00:00.000Z', sessionId: 'claude-code:s1', alert: 'needs_input', text: 'Claude needs your permission' });
  assert.deepEqual(await snapshotAlerts(), [one, two]);
  assert.deepEqual(await snapshotAlerts(), [one, two], 'the same ids on every reconnect, so a watch dedups');
});

test('the buffer keeps the last 10', async () => {
  const watch = await connect();
  for (let i = 1; i <= 11; i++) bridge.hub.alert(`claude-code:s${i}`, 'done', `answer ${i}`);
  watch.close();
  const alerts = await snapshotAlerts();
  assert.equal(alerts.length, 10);
  assert.deepEqual(
    alerts.map((a) => a.text),
    Array.from({ length: 10 }, (_, i) => `answer ${i + 2}`),
    'the two earlier ones and answer 1 fell off',
  );
  assert.equal(new Set(alerts.map((a) => a.id)).size, 10);
});

test('alerts older than 10 minutes are not replayed', async () => {
  clock = T + 5 * 60_000;
  const watch = await connect();
  bridge.hub.alert('claude-code:late', 'done', 'answer 12');
  watch.close();
  assert.equal((await snapshotAlerts()).length, 10);
  clock = T + 11 * 60_000;
  assert.deepEqual(
    (await snapshotAlerts()).map((a) => a.text),
    ['answer 12'],
    'only the one raised within the last 10 minutes',
  );
  clock = T + 16 * 60_000;
  assert.deepEqual(await snapshotAlerts(), []);
});

test('a done alert raised while no watch is connected is not replayed: a Stop hook posted it (e.g. to Slack)', async () => {
  clock = T + 30 * 60_000;
  await noWatch();
  bridge.hub.alert('claude-code:away', 'done', 'answer while away');
  bridge.hub.alert('claude-code:away', 'needs_input', 'Claude is waiting for your input');
  bridge.hub.alert('claude-code:away', 'limit', "You've hit your session limit");
  clock += 5000;
  assert.deepEqual(
    (await snapshotAlerts()).map((a) => a.alert),
    ['needs_input', 'limit'],
    'no Stop hook stands in for these: a reconnecting watch still shows them',
  );
});

test('nor is one raised in the grace after a disconnect, or into a socket whose watch stopped answering pings', async () => {
  clock = T + 45 * 60_000;
  (await connect()).close();
  await noWatch();
  assert.ok(bridge.hub.presence().graceUntil, 'within the 90 s grace');
  bridge.hub.alert('claude-code:grace', 'done', 'answer in the grace');
  const silent = await connect();
  clock += 36_000;
  assert.equal(bridge.hub.presence().watch, false, 'no pong for 36 s');
  bridge.hub.alert('claude-code:stale', 'done', 'answer into a dead socket');
  assert.equal((await silent.next()).type, 'alert', 'still sent: the socket may yet deliver it');
  silent.close();
  await noWatch();
  assert.deepEqual(await snapshotAlerts(), []);
});

test('an alert sent to a connected watch is replayed with the same id when it reconnects within 10 minutes', async () => {
  clock = T + 60 * 60_000;
  const watch = await connect();
  bridge.hub.alert('claude-code:here', 'done', 'answer while connected');
  const live = await watch.next();
  assert.equal(live.type, 'alert');
  // E.g. the socket died right after the send: the watch may never have got it.
  watch.close();
  await noWatch();
  clock += 9 * 60_000;
  const first = await snapshotAlerts();
  assert.deepEqual(first.map((a) => a.id), [live.type === 'alert' ? live.id : '']);
  assert.deepEqual(await snapshotAlerts(), first, 'the same id on every reconnect: the watch shows it once');
});
