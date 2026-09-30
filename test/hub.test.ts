// Several instances of one provider (one per agent home): session lookup, usage identity and statusLine routing.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { BridgeHub, usageKey } from '../src/hub.ts';
import type { Account, Session, Usage } from '../src/protocol.ts';
import { statuslineRouter, type StatuslineTarget } from '../src/providers/claude-code/statusline.ts';
import { startServer } from '../src/server.ts';
import { FakeProvider, TestSocket, fakeAskRunner, quiet, startBridge, waitFor } from './helpers.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'wristline-hub-')));
after(() => rmSync(root, { recursive: true, force: true }));

const session = (n: string): Session => ({ id: `claude-code:${n}`, provider: 'claude-code', title: n, cwd: '/w', status: 'idle', lastActivity: '2026-09-29T10:00:00.000Z' });

test('two instances of one provider: resolve picks the one listing the session, items are served from it, a duplicate id is listed once', async () => {
  const a = new FakeProvider();
  a.sessions = [session('s1')];
  a.items.set('s1', [{ seq: 1, kind: 'user', ts: '2026-09-29T10:00:00.000Z', text: 'from a' }]);
  const b = new FakeProvider();
  b.sessions = [session('s2')];
  b.items.set('s2', []);
  const c = new FakeProvider(); // A copied home lists a's session too.
  c.sessions = [{ ...session('s1'), title: 'copy' }];
  const bridge = await startBridge([a, b, c]);
  try {
    assert.equal(bridge.hub.resolve('claude-code:s1')?.provider, a);
    assert.equal(bridge.hub.resolve('claude-code:s2')?.provider, b);
    assert.equal(bridge.hub.resolve('claude-code:s3'), undefined);
    assert.equal(bridge.hub.resolve('codex:s1'), undefined);
    assert.deepEqual(
      bridge.hub.sessions().map((s) => [s.id, s.title]),
      [
        ['claude-code:s1', 's1'],
        ['claude-code:s2', 's2'],
      ],
      'a duplicate id counts once, from the first instance (as resolve picks it)',
    );
    assert.deepEqual(bridge.hub.providerHealth().map((h) => h.id), ['claude-code', 'claude-code', 'claude-code']);
    const items = (id: string): Promise<Response> => fetch(`${bridge.base}/api/sessions/${id}/items`, { headers: { authorization: `Bearer ${bridge.token}` } });
    assert.deepEqual(await (await items('claude-code:s1')).json(), { items: [{ seq: 1, kind: 'user', ts: '2026-09-29T10:00:00.000Z', text: 'from a' }], hasMore: false });
    assert.deepEqual(await (await items('claude-code:s2')).json(), { items: [], hasMore: false });
    assert.equal((await items('claude-code:s3')).status, 404);
  } finally {
    await bridge.close();
  }
});

test('snapshot and GET /api/sessions list live sessions only; a session that ends is sent as session_removed and its items stay readable', async () => {
  const p = new FakeProvider();
  const running: Session = { ...session('run'), status: 'running' };
  const waiting: Session = { ...session('wait'), status: 'needs_input', lastActivity: '2026-09-29T09:00:00.000Z' };
  const idle = session('idle');
  const ended: Session = { ...session('old'), status: 'ended', promptBlock: 'not_live', lastActivity: '2026-09-29T11:00:00.000Z' };
  p.sessions = [ended, idle, running, waiting];
  p.items.set('old', [{ seq: 1, kind: 'user', ts: '2026-09-29T09:00:00.000Z', text: 'still here' }]);
  const bridge = await startBridge(p);
  const get = (path: string): Promise<Response> => fetch(`${bridge.base}${path}`, { headers: { authorization: `Bearer ${bridge.token}` } });
  try {
    const ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
    const snapshot = await ws.next();
    const live = ['claude-code:wait', 'claude-code:run', 'claude-code:idle'];
    assert.deepEqual(snapshot.type === 'snapshot' && snapshot.sessions.map((s) => s.id), live);
    assert.deepEqual(((await (await get('/api/sessions')).json()) as { sessions: Session[] }).sessions.map((s) => s.id), live);

    // A change to a live session is a session event; the end of one is session_removed.
    const renamed = { ...idle, title: 'renamed' };
    bridge.hub.session(renamed);
    assert.deepEqual(await ws.next(), { type: 'session', session: renamed });
    p.sessions = [ended, idle, { ...running, status: 'ended', promptBlock: 'not_live' }, waiting];
    bridge.hub.session(p.sessions[2] as Session);
    assert.deepEqual(await ws.next(), { type: 'session_removed', sessionId: running.id });
    assert.deepEqual(((await (await get('/api/sessions')).json()) as { sessions: Session[] }).sessions.map((s) => s.id), ['claude-code:wait', 'claude-code:idle']);

    // An update held back by the 2 s throttle must not follow the removal and bring the session back.
    bridge.hub.session({ ...idle, title: 'held back' });
    bridge.hub.session({ ...idle, status: 'ended' });
    assert.deepEqual(await ws.next(), { type: 'session_removed', sessionId: idle.id });
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(ws.pending(), 0);

    // An ended session the provider still lists keeps serving items (an open detail screen); unknown ids are 404.
    const items = await get('/api/sessions/claude-code:old/items');
    assert.equal(items.status, 200);
    assert.deepEqual(((await items.json()) as { items: unknown[] }).items.length, 1);
    assert.equal((await get('/api/sessions/claude-code:gone/items')).status, 404);
    ws.close();
  } finally {
    await bridge.close();
  }
});

test('usage is kept per provider and account; a labelled entry retires the unlabelled one for good; stale snapshots are ignored; changed numbers or accounts are broadcast', async () => {
  let clock = Date.parse('2026-09-29T10:00:00Z');
  const bridge = await startBridge(new FakeProvider(), () => clock);
  try {
    const ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
    assert.equal((await ws.next()).type, 'snapshot');
    let t = 0;
    const claude = (account: Account | undefined, used: number): Usage => ({
      provider: 'claude-code',
      updatedAt: new Date(Date.parse('2026-09-29T10:00:00Z') + ++t * 1000).toISOString(),
      windows: [{ id: '5h', usedPercent: used }],
      ...(account ? { account } : {}),
    });
    const [A, B] = [{ id: 'acc-a', label: 'me' }, { id: 'acc-b', label: 'school', estimated: true }];
    const keys = (): string[] => bridge.hub.usageList().map(usageKey);

    bridge.hub.usage(claude(undefined, 10));
    assert.equal((await ws.next()).type, 'usage');
    assert.deepEqual(keys(), ['claude-code:']);
    const a10 = claude(A, 10);
    bridge.hub.usage(a10);
    assert.deepEqual(await ws.next(), { type: 'usage', usage: a10 });
    assert.deepEqual(keys(), ['claude-code:acc-a'], 'the unlabelled entry is retired');
    bridge.hub.usage(claude(B, 20));
    assert.deepEqual((await ws.next()).type, 'usage');
    bridge.hub.usage({ provider: 'codex', updatedAt: '2026-09-29T10:00:00.000Z', windows: [{ id: 'primary', usedPercent: 5 }] });
    assert.deepEqual((await ws.next()).type, 'usage');
    assert.deepEqual(keys(), ['claude-code:acc-a', 'claude-code:acc-b', 'codex:'], 'another provider\'s unlabelled entry stays');

    const same = claude(A, 10);
    bridge.hub.usage(same);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ws.pending(), 0, 'unchanged numbers are not broadcast');
    assert.equal(bridge.hub.usageList().find((u) => u.account?.id === 'acc-a')?.updatedAt, same.updatedAt, 'but the entry is refreshed');
    clock += 60_000; // past the usage throttle
    bridge.hub.usage(claude(A, 11));
    const event = await ws.next();
    assert.equal(event.type === 'usage' && event.usage.windows[0]?.usedPercent, 11);

    // Once labelled, an unlabelled report of the provider is stale: neither stored nor broadcast.
    bridge.hub.usage(claude(undefined, 99));
    // A snapshot older than the stored entry (another home's rollout of this account) must not replace live numbers.
    bridge.hub.usage({ ...claude(A, 50), updatedAt: '2026-09-29T09:00:00.000Z' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ws.pending(), 0);
    assert.deepEqual(keys(), ['claude-code:acc-a', 'claude-code:acc-b', 'codex:']);
    assert.equal(bridge.hub.usageList().find((u) => u.account?.id === 'acc-a')?.windows[0]?.usedPercent, 11);
    // Same numbers, but the account is now known for certain (or relabelled): worth an event.
    const exact = claude({ id: 'acc-b', label: 'school' }, 20);
    clock += 60_000;
    bridge.hub.usage(exact);
    assert.deepEqual(await ws.next(), { type: 'usage', usage: exact });

    const other = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
    const snapshot = await other.next();
    assert.equal(snapshot.type === 'snapshot' && snapshot.usage.length, 3);
    ws.close();
    other.close();
  } finally {
    await bridge.close();
  }
});

test('background mode: only requests, resolutions, alerts and needs_input transitions reach the client; foreground gets everything', async () => {
  const p = new FakeProvider();
  const s1 = session('s1');
  p.sessions = [s1];
  p.items.set('s1', []);
  const bridge = await startBridge(p);
  try {
    const url = `${bridge.base.replace('http', 'ws')}/api/ws`;
    const fg = await new TestSocket(url, bridge.token).open();
    const bg = await new TestSocket(url, bridge.token).open();
    assert.equal((await fg.next()).type, 'snapshot');
    assert.equal((await bg.next()).type, 'snapshot');
    for (const ws of [fg, bg]) ws.send({ type: 'subscribe', sessionId: s1.id });
    bg.send({ type: 'mode', mode: 'background' });
    bg.send({ type: 'mode', mode: 'sideways' }); // Unknown modes are ignored.
    await new Promise((r) => setTimeout(r, 100));
    const types = async (ws: TestSocket, n: number): Promise<string[]> => {
      const out: string[] = [];
      for (let i = 0; i < n; i++) out.push((await ws.next()).type);
      return out;
    };

    // Churn a background client must not hear: a title change, an item, usage, a Quick Ask event.
    bridge.hub.session({ ...s1, title: 'renamed' });
    p.emit('s1', { seq: 1, kind: 'assistant', ts: '2026-09-29T10:00:01.000Z', text: 'hi' });
    bridge.hub.usage({ provider: 'codex', updatedAt: '2026-09-29T10:00:00.000Z', windows: [{ id: 'primary', usedPercent: 5 }] });
    bridge.hub.sendToDevice(bridge.auth.authenticate(bridge.token)?.id ?? '', { type: 'ask', askId: 'ask-1', provider: 'codex', status: 'running' });
    assert.deepEqual(await types(fg, 4), ['session', 'item', 'usage', 'ask']);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(bg.pending(), 0);

    // What it must hear: a request and its session turning needs_input, the resolution and the way back, an alert.
    const answers = bridge.hub.pending.open({ sessionId: s1.id, kind: 'permission', title: 'Bash', questions: [{ id: 'decision', text: 'ls', multi: false, options: [{ id: 'allow', label: 'Allow' }] }] }, { timeoutMs: 60_000 });
    assert.deepEqual(await types(bg, 2), ['request', 'session']);
    await new Promise((r) => setTimeout(r, 2100)); // the per-session throttle
    assert.equal(bridge.hub.pending.answer('req-1', { decision: ['allow'] }), 'ok');
    assert.deepEqual(await answers, { decision: ['allow'] });
    assert.deepEqual(await types(bg, 2), ['resolved', 'session']);
    bridge.hub.alert(s1.id, 'done', 'Finished the task as requested.');
    assert.equal((await bg.next()).type, 'alert');
    bridge.hub.removed(s1.id);
    assert.deepEqual(await types(fg, 6), ['request', 'session', 'resolved', 'session', 'alert', 'session_removed']);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(bg.pending(), 0, 'no session_removed, no other session churn');

    // A session removed while it needs input: without this the background client would keep its badge.
    await new Promise((r) => setTimeout(r, 2100));
    const dangling = bridge.hub.pending.open({ sessionId: s1.id, kind: 'permission', title: 'Bash', questions: [{ id: 'decision', text: 'rm', multi: false, options: [{ id: 'allow', label: 'Allow' }] }] }, { timeoutMs: 60_000 });
    assert.deepEqual(await types(bg, 2), ['request', 'session']);
    bridge.hub.removed(s1.id);
    assert.equal((await bg.next()).type, 'session_removed');
    assert.deepEqual(await types(fg, 3), ['request', 'session', 'session_removed']);
    assert.equal(bridge.hub.pending.answer('req-2', { decision: ['allow'] }), 'ok');
    await dangling;
    // The removal forgot the session's last status: its idle session event is not a change from needs_input any more.
    assert.deepEqual(await types(fg, 2), ['resolved', 'session']);
    assert.deepEqual(await types(bg, 1), ['resolved']);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(bg.pending(), 0);

    // Back in the foreground the client hears everything again.
    bg.send({ type: 'mode', mode: 'foreground' });
    await new Promise((r) => setTimeout(r, 100));
    bridge.hub.session({ ...s1, title: 'again' });
    assert.equal((await bg.next()).type, 'session');
    fg.close();
    bg.close();
  } finally {
    await bridge.close();
  }
});

test('usage windows are merged per entry: a report without a window keeps it until its reset time passes; events are throttled to one per minute', async () => {
  const base = Date.parse('2026-09-29T10:00:00Z');
  let clock = base;
  const bridge = await startBridge(new FakeProvider(), () => clock);
  try {
    const ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
    assert.equal((await ws.next()).type, 'snapshot');
    const report = (windows: Usage['windows']): Usage => ({ provider: 'claude-code', updatedAt: new Date(clock).toISOString(), windows, account: { id: 'acc-a', label: 'me' } });
    const fiveHour = { id: '5h', label: '5h', usedPercent: 40, resetsAt: '2026-09-29T12:00:00.000Z', minutes: 300 };
    const sevenDay = { id: '7d', label: '7d', usedPercent: 12, resetsAt: '2026-10-03T00:00:00.000Z', minutes: 10080 };
    const stored = (): Usage['windows'] | undefined => bridge.hub.usageList()[0]?.windows;

    // First appearance: sent at once.
    bridge.hub.usage(report([fiveHour, sevenDay]));
    assert.deepEqual((await ws.next()).type, 'usage');

    // A report lacking the 5h window (Claude Code reports the ones it happens to carry) keeps the stored 5h; the event waits for the throttle window.
    clock += 1000;
    bridge.hub.usage(report([{ ...sevenDay, usedPercent: 13 }]));
    assert.deepEqual(stored(), [{ ...sevenDay, usedPercent: 13 }, fiveHour]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ws.pending(), 0, 'throttled: not sent within a minute of the last event');

    // Past the throttle window the next change goes out at once, carrying the merged state.
    clock = base + 60_000;
    bridge.hub.usage(report([{ ...sevenDay, usedPercent: 14 }]));
    const event = await ws.next();
    assert.deepEqual(event.type === 'usage' && event.usage.windows, [{ ...sevenDay, usedPercent: 14 }, fiveHour]);
    assert.equal(ws.pending(), 0, 'the change held back before was superseded, not sent twice');

    // Once the 5h reset time has passed the window is gone from GET /api/usage, the snapshot and the next event.
    clock = Date.parse('2026-09-29T12:00:01Z');
    assert.deepEqual(stored(), [{ ...sevenDay, usedPercent: 14 }]);
    const later = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
    const snapshot = await later.next();
    assert.deepEqual(snapshot.type === 'snapshot' && snapshot.usage[0]?.windows, [{ ...sevenDay, usedPercent: 14 }]);
    later.close();
    bridge.hub.usage(report([{ ...sevenDay, usedPercent: 15 }]));
    const afterReset = await ws.next();
    assert.deepEqual(afterReset.type === 'usage' && afterReset.usage.windows, [{ ...sevenDay, usedPercent: 15 }]);
    // A report whose window has already reset is not stored either.
    bridge.hub.usage(report([{ ...fiveHour, usedPercent: 1 }, { ...sevenDay, usedPercent: 15 }]));
    assert.deepEqual(stored(), [{ ...sevenDay, usedPercent: 15 }]);
    // A fresh 5h window comes back at once when reported.
    clock += 60_000;
    const fresh = { ...fiveHour, usedPercent: 2, resetsAt: '2026-09-29T17:00:00.000Z' };
    bridge.hub.usage(report([fresh]));
    const back = await ws.next();
    assert.deepEqual(back.type === 'usage' && back.usage.windows, [fresh, { ...sevenDay, usedPercent: 15 }]);
    ws.close();
  } finally {
    await bridge.close();
  }
});

test('windows reported before the account was known are folded into the first labelled entry', () => {
  const hub = new BridgeHub({ providers: [new FakeProvider()], alerts: { now: () => Date.parse('2026-09-29T10:00:00Z') }, log: quiet });
  try {
    const fiveHour = { id: '5h', usedPercent: 40, resetsAt: '2026-09-29T12:00:00.000Z' };
    const sevenDay = { id: '7d', usedPercent: 12, resetsAt: '2026-10-03T00:00:00.000Z' };
    hub.usage({ provider: 'claude-code', updatedAt: '2026-09-29T10:00:00.000Z', windows: [fiveHour, sevenDay] });
    hub.usage({ provider: 'claude-code', updatedAt: '2026-09-29T10:00:01.000Z', windows: [{ ...sevenDay, usedPercent: 13 }], account: { id: 'acc-a', label: 'me' } });
    assert.deepEqual(
      hub.usageList().map((u) => [usageKey(u), u.windows]),
      [['claude-code:acc-a', [{ ...sevenDay, usedPercent: 13 }, fiveHour]]],
    );
  } finally {
    hub.close();
  }
});

test('a usage change inside the throttle window is sent when the window ends, in its then-current state', async () => {
  const clock = Date.parse('2026-09-29T10:00:00Z');
  const hub = new BridgeHub({ providers: [new FakeProvider()], alerts: { now: () => clock }, usageThrottleMs: 200, log: quiet });
  const auth = new Auth({ devices: [], save: async () => {}, now: () => clock });
  const server = await startServer({ hub, auth, bridge: { name: 'devbox', version: '0.1.0', apiVersion: 1 }, hookToken: 'h', apiPort: 0, hookPort: 0, onStatusline: () => {}, asks: fakeAskRunner(() => {}, {}) });
  try {
    const { token } = await auth.issue('w');
    const ws = await new TestSocket(`ws://127.0.0.1:${server.apiPort}/api/ws`, token).open();
    await ws.next();
    const report = (used: number): Usage => ({ provider: 'codex', updatedAt: '2026-09-29T10:00:00.000Z', windows: [{ id: 'primary', usedPercent: used }] });
    hub.usage(report(1));
    assert.equal((await ws.next()).type, 'usage');
    hub.usage(report(2));
    hub.usage(report(3));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ws.pending(), 0);
    const event = await ws.next(1000);
    assert.deepEqual(event.type === 'usage' && event.usage.windows, [{ id: 'primary', usedPercent: 3 }], 'one event with the latest numbers');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ws.pending(), 0, 'nothing more without a change');
    ws.close();
  } finally {
    hub.close();
    await server.close();
  }
});

test('connections, alerts and requests are logged with ids and client counts, never their text', async () => {
  const clock = Date.parse('2026-09-29T10:00:00Z');
  const lines: string[] = [];
  let n = 0;
  const hub = new BridgeHub({ providers: [new FakeProvider()], alerts: { now: () => clock, newId: () => `alert-${++n}` }, pending: { newId: () => 'req-1' }, log: (line) => lines.push(line) });
  const auth = new Auth({ devices: [], save: async () => {}, now: () => clock });
  const server = await startServer({ hub, auth, bridge: { name: 'devbox', version: '0.1.0', apiVersion: 1 }, hookToken: 'h', apiPort: 0, hookPort: 0, onStatusline: () => {}, asks: fakeAskRunner(() => {}, {}) });
  try {
    const { token, device } = await auth.issue('w');
    const url = `ws://127.0.0.1:${server.apiPort}/api/ws`;
    const fg = await new TestSocket(url, token).open();
    const bg = await new TestSocket(url, token).open();
    await fg.next();
    await bg.next();
    bg.send({ type: 'mode', mode: 'background' });
    await new Promise((r) => setTimeout(r, 100));
    hub.alert('claude-code:s1', 'done', 'the secret answer', 'secret title');
    const answered = hub.pending.open({ sessionId: 'claude-code:s1', kind: 'question', title: 'secret question', questions: [] });
    hub.pending.dismiss('req-1', 'terminal');
    await answered;
    fg.close();
    bg.close();
    await waitFor(() => (hub.pending.presence().watch ? undefined : true));
    const short = device.id.slice(0, 6);
    assert.deepEqual(lines, [
      `wristline: watch ${short} connected`,
      `wristline: watch ${short} connected`,
      'wristline: alert done id=alert-1 clients=2 bg=1',
      'wristline: request req-1 broadcast clients=2',
      `wristline: watch ${short} disconnected`,
      `wristline: watch ${short} disconnected`,
    ]);
  } finally {
    hub.close();
    await server.close();
  }
});

test('statusLine reports go to the home holding the transcript, else to the instance listing the session, else to the only instance', async () => {
  const homeA = join(root, 'a');
  const homeB = join(root, 'b-real');
  mkdirSync(join(homeA, 'projects', '-w'), { recursive: true });
  mkdirSync(join(homeB, 'projects', '-w'), { recursive: true });
  symlinkSync(homeB, join(root, 'b-link'));
  writeFileSync(join(homeB, 'projects', '-w', 's2.jsonl'), '');
  const calls: [string, unknown][] = [];
  const instance = (home: string, sessions: string[]): StatuslineTarget => ({
    home,
    hasSession: (id) => sessions.includes(id),
    statusline: async (input) => void calls.push([home, (input as { session_id: string }).session_id]),
  });
  const [a, b] = [instance(homeA, ['s1']), instance(homeB, ['s2'])];
  const logs: string[] = [];
  const route = statuslineRouter([a, b], (line) => logs.push(line));

  route({ session_id: 'x', transcript_path: join(root, 'b-link', 'projects', '-w', 's2.jsonl') }); // Through a symlinked home.
  route({ session_id: 's1', transcript_path: '/nowhere/projects/-w/s1.jsonl' }); // Unknown path: by session.
  route({ session_id: 'new', transcript_path: join(homeA, 'projects', '-w', 'new.jsonl') }); // Not written yet: by prefix.
  route({ session_id: 'zz' });
  route({ session_id: 'zz' });
  route('not an object');
  await waitFor(() => (calls.length === 3 && logs.length === 1 ? true : undefined));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls.sort(), [
    [homeA, 'new'],
    [homeA, 's1'],
    [homeB, 'x'],
  ]);
  assert.deepEqual(logs.length, 1, 'an unroutable session is logged once');
  assert.match(logs[0] ?? '', /zz/);

  // A single instance takes reports without a path, but not one whose transcript lies under another home's projects/.
  calls.length = 0;
  logs.length = 0;
  const single = statuslineRouter([a], (line) => logs.push(line));
  single({ session_id: 'anything' });
  single({ session_id: 'foreign', transcript_path: join(root, 'elsewhere', 'projects', '-w', 'foreign.jsonl') });
  await waitFor(() => (calls.length === 1 && logs.length === 1 ? true : undefined));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls, [[homeA, 'anything']]);
  assert.match(logs[0] ?? '', /foreign/);
});
