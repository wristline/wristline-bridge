// Missed done/needs_input alerts: the hub buffers the last few and the snapshot replays them.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Alert, ServerEvent } from '../src/protocol.ts';
import { FakeProvider, TestSocket, startBridge, type Bridge } from './helpers.ts';

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
  for (let i = 1; i <= 11; i++) bridge.hub.alert(`claude-code:s${i}`, 'done', `answer ${i}`);
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
  bridge.hub.alert('claude-code:late', 'done', 'answer 12');
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
