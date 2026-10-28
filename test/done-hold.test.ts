// A Claude Code `done` alert waits up to 3 s for the suggested next prompt (POST /hooks/prompt-suggestion)
// and carries it; timers are driven by hand, so nothing here depends on the clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Alert, ServerEvent, Session } from '../src/protocol.ts';
import { clip } from '../src/util.ts';
import { FakeProvider, TestSocket, startBridge, waitFor, type Bridge } from './helpers.ts';

const SID = '6f1c2d3e-0000-4000-8000-000000000001';
const ID = `claude-code:${SID}`;
const T1 = '2026-09-29T09:58:00.000Z';
const T2 = '2026-09-29T10:00:30.000Z';
const running: Session = { id: ID, provider: 'claude-code', title: 't', cwd: '/w', status: 'running', lastActivity: '2026-09-29T10:00:00.000Z', turnStartedAt: T1 };
const codex: Session = { id: 'codex:th1', provider: 'codex', title: 'c', cwd: '/w', status: 'running', lastActivity: '2026-09-29T10:00:00.000Z' };
const ANSWER = 'The build is green again, all tests pass.';

interface Timers {
  schedule: (fn: () => void, ms: number) => () => void;
  /** Delays of the timers scheduled so far. */
  scheduled: number[];
  /** Timers neither run nor cancelled. */
  live: () => number;
  /** Runs every live timer: their time has come. */
  fire: () => void;
}

function manualTimers(): Timers {
  const timers: { fn: () => void; live: boolean }[] = [];
  const scheduled: number[] = [];
  return {
    scheduled,
    schedule: (fn, ms) => {
      const t = { fn, live: true };
      timers.push(t);
      scheduled.push(ms);
      return () => void (t.live = false);
    },
    live: () => timers.filter((t) => t.live).length,
    fire: () => {
      for (const t of timers.splice(0)) {
        if (!t.live) continue;
        t.live = false;
        t.fn();
      }
    },
  };
}

async function setup(): Promise<{ bridge: Bridge; timers: Timers; claude: FakeProvider }> {
  const claude = new FakeProvider();
  claude.sessions = [running];
  const other = new FakeProvider('codex');
  other.sessions = [codex];
  const timers = manualTimers();
  const bridge = await startBridge([claude, other], undefined, undefined, undefined, undefined, { schedule: timers.schedule });
  return { bridge, timers, claude };
}

async function connect(bridge: Bridge): Promise<TestSocket> {
  const ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
  assert.equal((await ws.next()).type, 'snapshot');
  return ws;
}

async function snapshotAlerts(bridge: Bridge): Promise<Alert[]> {
  const ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
  const snapshot = await ws.next();
  ws.close();
  return snapshot.type === 'snapshot' ? snapshot.alerts : [];
}

/** Everything the bridge has sent so far, without the session updates. */
async function drain(ws: TestSocket): Promise<ServerEvent[]> {
  await ws.settle();
  const events: ServerEvent[] = [];
  while (ws.pending() > 0) {
    const event = await ws.next();
    if (event.type !== 'session') events.push(event);
  }
  return events;
}

/** An alert event without its `id` and `at`. */
function bare(event: ServerEvent | undefined): unknown {
  if (event?.type !== 'alert') return event;
  const { id: _id, at: _at, ...rest } = event;
  return rest;
}

function hook(bridge: Bridge, name: string, body: unknown): Promise<Response> {
  return fetch(`${bridge.local}/hooks/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bridge.hookToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('the Stop hook\'s done alert waits for the suggestion and goes out once, with it (trimmed, at most 300 code units)', async () => {
  const { bridge, timers } = await setup();
  try {
    const ws = await connect(bridge);
    assert.equal((await hook(bridge, 'stop', { session_id: SID, hook_event_name: 'Stop', last_assistant_message: ANSWER })).status, 200);
    assert.deepEqual(await drain(ws), [], 'held');
    assert.deepEqual(timers.scheduled, [3000]);
    const long = 'x'.repeat(400);
    assert.equal((await hook(bridge, 'prompt-suggestion', { session_id: SID, text: `  ${long} \n`, shown: true })).status, 200);
    const [alert, ...rest] = await drain(ws);
    assert.deepEqual(bare(alert), { type: 'alert', sessionId: ID, alert: 'done', text: ANSWER, title: 't', suggestion: clip(long, 300) });
    assert.deepEqual(rest, []);
    assert.equal(timers.live(), 0, 'its timer is cancelled');
    timers.fire();
    await hook(bridge, 'prompt-suggestion', { session_id: SID, text: 'run the tests', shown: true });
    assert.deepEqual(await drain(ws), [], 'one alert only');
    ws.close();
  } finally {
    await bridge.close();
  }
});

test('a suggestion that is blank or was not shown does not end the hold', async () => {
  const { bridge, timers } = await setup();
  try {
    const ws = await connect(bridge);
    bridge.hub.alert(ID, 'done', ANSWER, 't');
    await hook(bridge, 'prompt-suggestion', { session_id: SID, text: 'run the tests', shown: false });
    await hook(bridge, 'prompt-suggestion', { session_id: SID, text: '   ', shown: true });
    assert.deepEqual(await drain(ws), []);
    timers.fire();
    assert.deepEqual((await drain(ws)).map(bare), [{ type: 'alert', sessionId: ID, alert: 'done', text: ANSWER, title: 't' }]);
    ws.close();
  } finally {
    await bridge.close();
  }
});

test('without a suggestion within 3 s the alert goes out without one; a later suggestion raises no second alert', async () => {
  const { bridge, timers } = await setup();
  try {
    const ws = await connect(bridge);
    bridge.hub.alert(ID, 'done', ANSWER, 't');
    assert.deepEqual(await drain(ws), []);
    timers.fire();
    assert.deepEqual((await drain(ws)).map(bare), [{ type: 'alert', sessionId: ID, alert: 'done', text: ANSWER, title: 't' }]);
    bridge.hub.suggestion(ID, 'run the tests');
    assert.deepEqual(await drain(ws), [], 'the suggestion is only the session\'s now');
    ws.close();
  } finally {
    await bridge.close();
  }
});

test('a new turn, a dialog, a request or another alert of the session sends the held alert at once, without a suggestion', async () => {
  const { bridge, timers } = await setup();
  const plain = { type: 'alert', sessionId: ID, alert: 'done', text: ANSWER, title: 't' };
  try {
    const ws = await connect(bridge);

    // Refreshes that still show the finished turn (or none) do not; a running session with another turn start does.
    bridge.hub.alert(ID, 'done', ANSWER, 't');
    bridge.hub.session({ ...running, status: 'idle', turnStartedAt: undefined });
    bridge.hub.session(running);
    bridge.hub.session({ ...running, turnStartedAt: undefined });
    assert.deepEqual(await drain(ws), [], 'the turn that just ended');
    bridge.hub.session({ ...running, turnStartedAt: T2 });
    assert.deepEqual((await drain(ws)).map(bare), [plain], 'a new turn');
    bridge.hub.suggestion(ID, 'run the tests');
    assert.deepEqual(await drain(ws), []);

    bridge.hub.alert(ID, 'done', ANSWER, 't');
    bridge.hub.session({ ...running, status: 'needs_input' });
    assert.deepEqual((await drain(ws)).map(bare), [plain], 'a dialog');

    bridge.hub.alert(ID, 'done', ANSWER, 't');
    const answered = bridge.hub.pending.open({ sessionId: ID, kind: 'question', title: 'Question', questions: [] });
    const events = await drain(ws);
    assert.deepEqual(
      events.map((e) => e.type),
      ['alert', 'request'],
      'the alert before the request',
    );
    assert.deepEqual(bare(events[0]), plain);
    bridge.hub.pending.dismiss('req-1', 'terminal');
    await answered;
    await drain(ws);

    bridge.hub.alert(ID, 'done', ANSWER, 't');
    bridge.hub.alert(ID, 'needs_input', 'Claude needs your permission');
    assert.deepEqual((await drain(ws)).map(bare), [plain, { type: 'alert', sessionId: ID, alert: 'needs_input', text: 'Claude needs your permission' }]);

    bridge.hub.alert(ID, 'done', 'The first answer of the two turns.', 't');
    bridge.hub.alert(ID, 'done', ANSWER, 't');
    assert.deepEqual((await drain(ws)).map(bare), [{ ...plain, text: 'The first answer of the two turns.' }], 'the next turn\'s done is held in its place');
    bridge.hub.suggestion(ID, 'run the tests');
    assert.deepEqual((await drain(ws)).map(bare), [{ ...plain, suggestion: 'run the tests' }]);
    assert.equal(timers.live(), 0);
    ws.close();
  } finally {
    await bridge.close();
  }
});

test('Codex done alerts and needs_input or limit alerts are not held', async () => {
  const { bridge, timers } = await setup();
  try {
    const ws = await connect(bridge);
    bridge.hub.alert('codex:th1', 'done', ANSWER, 'c');
    bridge.hub.alert(ID, 'needs_input', 'Claude needs your permission');
    bridge.hub.alert(ID, 'limit', "You've hit your session limit", 't', { resetsAt: '2026-09-29T10:40:00.000Z', limitKind: 'window' });
    assert.deepEqual(
      (await drain(ws)).map((e) => e.type === 'alert' && `${e.sessionId} ${e.alert}`),
      ['codex:th1 done', `${ID} needs_input`, `${ID} limit`],
    );
    assert.deepEqual(timers.scheduled, []);
    ws.close();
  } finally {
    await bridge.close();
  }
});

test('a held done alert is replayed by presence at the Stop, when a Slack-style Stop hook decided, not at its sending', async () => {
  const { bridge, timers } = await setup();
  const noWatch = (): Promise<true> => waitFor(() => (bridge.hub.presence().watch ? undefined : true));
  try {
    // Present at the Stop, gone by the time it is sent: kept (no Stop hook posted it).
    const ws = await connect(bridge);
    bridge.hub.alert(ID, 'done', 'Answered while the watch was there.', 't');
    ws.close();
    await noWatch();
    timers.fire();
    assert.deepEqual(
      (await snapshotAlerts(bridge)).map((a) => a.text),
      ['Answered while the watch was there.'],
    );
    await noWatch();

    // Absent at the Stop (a Stop hook posted it), connected by the time it is sent: sent live, never replayed.
    bridge.hub.alert(ID, 'done', 'Answered while no watch was there.', 't');
    const late = await connect(bridge);
    timers.fire();
    assert.deepEqual((await drain(late)).map((e) => e.type === 'alert' && e.text), ['Answered while no watch was there.']);
    assert.deepEqual(
      (await snapshotAlerts(bridge)).map((a) => a.text),
      ['Answered while the watch was there.'],
    );
    late.close();
  } finally {
    await bridge.close();
  }
});
