// Several instances of one provider (one per agent home): session lookup, usage identity and statusLine routing.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { BridgeHub, usageKey } from '../src/hub.ts';
import type { Account, Session, Usage, UsageList } from '../src/protocol.ts';
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

test('background mode: only requests, resolutions, alerts, status, turn-start and progress transitions and removals reach the client; foreground gets everything', async () => {
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
    await Promise.all([fg.settle(), bg.settle()]);
    const types = async (ws: TestSocket, n: number): Promise<string[]> => {
      const out: string[] = [];
      for (let i = 0; i < n; i++) out.push((await ws.next()).type);
      return out;
    };

    // A session's first event is a change: the bridge has sent no status for it yet.
    bridge.hub.session({ ...s1, status: 'running' });
    assert.equal((await bg.next()).type, 'session');
    assert.equal((await fg.next()).type, 'session');
    await new Promise((r) => setTimeout(r, 2100)); // the per-session throttle

    // Churn a background client must not hear: a lastActivity and title change, an item, usage, a Quick Ask event.
    bridge.hub.session({ ...s1, status: 'running', title: 'renamed', lastActivity: '2026-09-29T10:00:01.000Z' });
    p.emit('s1', { seq: 1, kind: 'assistant', ts: '2026-09-29T10:00:01.000Z', text: 'hi' });
    bridge.hub.usage({ provider: 'codex', updatedAt: '2026-09-29T10:00:00.000Z', windows: [{ id: 'primary', usedPercent: 5 }] });
    bridge.hub.sendToDevice(bridge.auth.authenticate(bridge.token)?.id ?? '', { type: 'ask', askId: 'ask-1', provider: 'codex', status: 'running' });
    assert.deepEqual(await types(fg, 4), ['session', 'item', 'usage', 'ask']);
    await bg.settle();
    assert.equal(bg.pending(), 0);

    // A turn's Live Update: its start and progress changes reach the background client, a lastActivity-only update does not.
    const turn = { ...s1, status: 'running' as const, title: 'renamed', turnStartedAt: '2026-09-29T10:00:00.000Z' };
    for (const done of [2, 3]) {
      await new Promise((r) => setTimeout(r, 2100));
      bridge.hub.session({ ...turn, progress: { done, total: 7 } });
      const heard = await bg.next();
      assert.deepEqual(heard.type === 'session' && [heard.session.turnStartedAt, heard.session.progress], ['2026-09-29T10:00:00.000Z', { done, total: 7 }]);
      assert.equal((await fg.next()).type, 'session');
    }
    await new Promise((r) => setTimeout(r, 2100));
    bridge.hub.session({ ...turn, progress: { done: 3, total: 7 }, lastActivity: '2026-09-29T10:05:00.000Z' });
    assert.equal((await fg.next()).type, 'session');
    await bg.settle();
    assert.equal(bg.pending(), 0, 'a lastActivity-only change stays in the foreground');

    // running -> idle: the background client's running count changes.
    await new Promise((r) => setTimeout(r, 2100));
    bridge.hub.session(s1);
    const idle = await bg.next();
    assert.equal(idle.type === 'session' && idle.session.status, 'idle');
    assert.equal((await fg.next()).type, 'session');
    await new Promise((r) => setTimeout(r, 2100));

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
    assert.equal((await bg.next()).type, 'session_removed');
    assert.deepEqual(await types(fg, 6), ['request', 'session', 'resolved', 'session', 'alert', 'session_removed']);
    await bg.settle();
    assert.equal(bg.pending(), 0, 'no other session churn');

    // A session removed while it needs input: without this the background client would keep its badge.
    await new Promise((r) => setTimeout(r, 2100));
    const dangling = bridge.hub.pending.open({ sessionId: s1.id, kind: 'permission', title: 'Bash', questions: [{ id: 'decision', text: 'rm', multi: false, options: [{ id: 'allow', label: 'Allow' }] }] }, { timeoutMs: 60_000 });
    assert.deepEqual(await types(bg, 2), ['request', 'session']);
    bridge.hub.removed(s1.id);
    assert.equal((await bg.next()).type, 'session_removed');
    assert.deepEqual(await types(fg, 3), ['request', 'session', 'session_removed']);
    assert.equal(bridge.hub.pending.answer('req-2', { decision: ['allow'] }), 'ok');
    await dangling;
    // The removal forgot the session's last status: its next session event is a first one again.
    assert.deepEqual(await types(fg, 2), ['resolved', 'session']);
    assert.deepEqual(await types(bg, 2), ['resolved', 'session']);
    await bg.settle();
    assert.equal(bg.pending(), 0);

    // Back in the foreground the client hears everything again.
    bg.send({ type: 'mode', mode: 'foreground' });
    await bg.settle();
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

test('live usage (a connected daemon) replaces its entry, a stale window with a later reset time too; other reports of it are ignored until the hold ends, then merge again', () => {
  const [home1, home2] = [new FakeProvider('codex'), new FakeProvider('codex')];
  const hub = new BridgeHub({ providers: [home1, home2], alerts: { now: () => Date.parse('2026-09-29T10:00:00Z') }, log: quiet });
  try {
    const a = { id: 'acc-a', label: 'A' };
    const b = { id: 'acc-b', label: 'B' };
    const report = (updatedAt: string, usedPercent: number, resetsAt: string, account = a): Usage => ({ provider: 'codex', updatedAt, account, windows: [{ id: 'primary', usedPercent, resetsAt }] });
    const shown = (): unknown[] => hub.usageList().map((u) => [u.account?.id, u.windows.map((w) => [w.id, w.usedPercent, w.resetsAt])]);
    const ofA = (): unknown => shown().find((e) => Array.isArray(e) && e[0] === 'acc-a');
    const [OCT5, OCT6] = ['2026-10-05T08:00:00.000Z', '2026-10-06T09:46:19.000Z'];
    hub.usage({ ...report('2026-09-29T09:00:00.000Z', 4, OCT6), windows: [{ id: 'primary', usedPercent: 4, resetsAt: OCT6 }, { id: 'secondary', usedPercent: 40 }] });
    hub.liveUsage(home1, report('2026-09-29T09:59:00.000Z', 0, OCT5));
    assert.deepEqual(shown(), [['acc-a', [['primary', 0, OCT5]]]], 'replaced, not merged: no later reset time or omitted window survives');
    assert.equal(hub.usage(report('2026-09-29T09:59:30.000Z', 9, OCT6)), false, 'set aside: to be offered again');
    assert.deepEqual(shown(), [['acc-a', [['primary', 0, OCT5]]]], 'a newer rollout of the held account is ignored');
    assert.equal(hub.usage(report('2026-09-29T09:59:30.000Z', 9, OCT6, b)), true);
    hub.liveUsage(home2, report('2026-09-29T09:59:40.000Z', 1, OCT5));
    hub.liveUsage(home1, report('2026-09-29T09:59:50.000Z', 2, OCT5, b)); // home1's daemon now serves B: home2 still holds A
    hub.usage(report('2026-09-29T09:59:55.000Z', 9, OCT6));
    hub.liveUsage(home2, undefined);
    hub.usage(report('2026-09-29T09:59:35.000Z', 9, OCT6));
    assert.deepEqual(ofA(), ['acc-a', [['primary', 1, OCT5]]], 'released: a report older than the live numbers is still stale');
    hub.usage(report('2026-09-29T10:00:00.000Z', 3, OCT5));
    assert.deepEqual(ofA(), ['acc-a', [['primary', 3, OCT5]]], 'released: newer reports merge again');
  } finally {
    hub.close();
  }
});

test('usage from processes that alternate (an idle one repeats the limits of its last API call): the later reset time wins, then the higher number, and nothing churns', async () => {
  let clock = Date.parse('2026-09-29T10:00:00Z');
  const bridge = await startBridge(new FakeProvider(), () => clock);
  try {
    const ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
    assert.equal((await ws.next()).type, 'snapshot');
    const report = (windows: Usage['windows']): Usage => ({ provider: 'claude-code', updatedAt: new Date(clock).toISOString(), windows, account: { id: 'acc-a', label: 'me' } });
    const fiveHour = { id: '5h', label: '5h', usedPercent: 40, resetsAt: '2026-09-29T12:00:00.000Z', minutes: 300 };
    const sevenDay = { id: '7d', label: '7d', usedPercent: 12, resetsAt: '2026-10-03T00:00:00.000Z', minutes: 10080 };
    // Merged windows by id: a report listing fewer windows puts the ones it names first.
    const stored = (): Record<string, Usage['windows'][number]> => Object.fromEntries((bridge.hub.usageList()[0]?.windows ?? []).map((w) => [w.id, w]));
    // The working session, an idle one whose last call was earlier in the same windows, and one idle since before the last 5h reset.
    const busy = (): Usage => report([fiveHour, sevenDay]);
    const idle = (): Usage => report([{ ...fiveHour, usedPercent: 25 }, { ...sevenDay, usedPercent: 10 }]);
    const older = (): Usage => report([{ ...fiveHour, usedPercent: 90, resetsAt: '2026-09-29T07:00:00.000Z' }, { ...sevenDay, usedPercent: 9 }]);

    bridge.hub.usage(busy());
    assert.equal((await ws.next()).type, 'usage');
    for (const next of [idle, busy, older, idle, busy, older]) {
      clock += 60_000; // Past the throttle each time: a change would be sent at once.
      bridge.hub.usage(next());
      assert.deepEqual(stored(), { '5h': fiveHour, '7d': sevenDay });
    }
    // A window with an earlier (not yet passed) reset time is an older one too.
    bridge.hub.usage(report([{ ...sevenDay, usedPercent: 99, resetsAt: '2026-09-30T00:00:00.000Z' }]));
    assert.deepEqual(stored(), { '5h': fiveHour, '7d': sevenDay });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ws.pending(), 0, 'the numbers never changed, so nothing was sent');

    // More usage in the same window shows at once.
    clock += 60_000;
    bridge.hub.usage(report([{ ...fiveHour, usedPercent: 41 }, sevenDay]));
    const grown = await ws.next();
    assert.deepEqual(grown.type === 'usage' && grown.usage.windows, [{ ...fiveHour, usedPercent: 41 }, sevenDay]);

    // After the 5h reset the new window wins although its number is lower; the idle session's old window is past its reset and dropped.
    clock = Date.parse('2026-09-29T12:05:00Z');
    const newFiveHour = { ...fiveHour, usedPercent: 3, resetsAt: '2026-09-29T17:00:00.000Z' };
    bridge.hub.usage(report([newFiveHour, sevenDay]));
    const reset = await ws.next();
    assert.deepEqual(reset.type === 'usage' && reset.usage.windows, [newFiveHour, sevenDay]);
    clock += 60_000;
    bridge.hub.usage(idle());
    assert.deepEqual(stored(), { '5h': newFiveHour, '7d': sevenDay });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ws.pending(), 0);
    ws.close();
  } finally {
    await bridge.close();
  }
});

test('usage windows with reset times at most 5 minutes apart are one window (the higher number wins); further apart, the later reset time wins; without one, the newer report', () => {
  let clock = Date.parse('2026-09-29T10:00:00Z');
  const hub = new BridgeHub({ providers: [new FakeProvider()], alerts: { now: () => clock }, log: quiet });
  try {
    const at = (iso: string, seconds: number): string => new Date(Date.parse(iso) + seconds * 1000).toISOString();
    const window = (provider: Usage['provider'], id: string): Usage['windows'][number] | undefined =>
      hub.usageList().find((u) => u.provider === provider)?.windows.find((w) => w.id === id);
    const report = (provider: Usage['provider'], windows: Usage['windows']): void => {
      clock += 1000;
      hub.usage({ provider, updatedAt: new Date(clock).toISOString(), windows, account: { id: 'acc-a', label: 'me' } });
    };

    // Codex jitters resets_at by about a second between reports: the latest (higher) number shows, with the later reset time.
    const T = '2026-09-29T12:00:00.000Z';
    for (const [jitter, usedPercent, latest] of [[0, 10, 0], [1, 11, 1], [-1, 12, 1], [1, 13, 1], [-1, 14, 1]] as const) {
      report('codex', [{ id: 'primary', usedPercent, resetsAt: at(T, jitter), minutes: 300 }]);
      assert.deepEqual(window('codex', 'primary'), { id: 'primary', usedPercent, resetsAt: at(T, latest), minutes: 300 });
    }

    // A stale Claude Code reporter (an idle process) repeats an older, lower number for the same reset time: ignored.
    const fiveHour = { id: '5h', label: '5h', usedPercent: 40, resetsAt: T, minutes: 300 };
    report('claude-code', [fiveHour]);
    report('claude-code', [{ ...fiveHour, usedPercent: 25 }]);
    assert.deepEqual(window('claude-code', '5h'), fiveHour);

    // A new window (reset time 5 h later) replaces the old one although its number is lower, even while the old reset time
    // has not passed on the bridge's clock; the stale reporter's old window then loses to it.
    clock = Date.parse('2026-09-29T11:59:00Z');
    const next = { ...fiveHour, usedPercent: 2, resetsAt: at(T, 5 * 3600) };
    report('claude-code', [next]);
    assert.deepEqual(window('claude-code', '5h'), next);
    report('claude-code', [{ ...fiveHour, usedPercent: 45 }]);
    assert.deepEqual(window('claude-code', '5h'), next);
    // Codex's new window: its reset time is 5 h later, jittered.
    report('codex', [{ id: 'primary', usedPercent: 1, resetsAt: at(T, 5 * 3600 - 1), minutes: 300 }]);
    assert.deepEqual(window('codex', 'primary'), { id: 'primary', usedPercent: 1, resetsAt: at(T, 5 * 3600 - 1), minutes: 300 });

    // Without a reset time on either side nothing tells a stale report from a reset (Codex sends resetsAt: null for some
    // limits): the newer report wins, also when lower, so the number can go down after a real reset; a known reset time is kept.
    report('codex', [{ id: 'secondary', usedPercent: 30, minutes: 10080 }]);
    report('codex', [{ id: 'secondary', usedPercent: 20, minutes: 10080 }]);
    assert.deepEqual(window('codex', 'secondary'), { id: 'secondary', usedPercent: 20, minutes: 10080 });
    report('codex', [{ id: 'secondary', usedPercent: 35, minutes: 10080 }]);
    assert.deepEqual(window('codex', 'secondary'), { id: 'secondary', usedPercent: 35, minutes: 10080 });
    const weekly = { id: 'secondary', usedPercent: 36, resetsAt: '2026-10-03T00:00:00.000Z', minutes: 10080 };
    report('codex', [weekly]);
    assert.deepEqual(window('codex', 'secondary'), weekly);
    report('codex', [{ id: 'secondary', usedPercent: 37, minutes: 10080 }]);
    assert.deepEqual(window('codex', 'secondary'), { ...weekly, usedPercent: 37 });
    report('codex', [{ id: 'secondary', usedPercent: 5, minutes: 10080 }]);
    assert.deepEqual(window('codex', 'secondary'), { ...weekly, usedPercent: 5 });
  } finally {
    hub.close();
  }
});

test('a merged window keeps the optional fields either report carries; the same numbers without them are no change', async () => {
  let clock = Date.parse('2026-09-29T10:00:00Z');
  const bridge = await startBridge(new FakeProvider(), () => clock);
  try {
    const ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
    assert.equal((await ws.next()).type, 'snapshot');
    const report = (windows: Usage['windows']): Usage => ({ provider: 'claude-code', updatedAt: new Date(clock).toISOString(), windows, account: { id: 'acc-a', label: 'me' } });
    const stored = (): Usage['windows'] | undefined => bridge.hub.usageList()[0]?.windows;
    const fiveHour = { id: '5h', label: '5h', usedPercent: 40, resetsAt: '2026-09-29T12:00:00.000Z', minutes: 300 };
    const weekly = { id: '7d', label: '7d', usedPercent: 12, minutes: 10080 };
    bridge.hub.usage(report([fiveHour, weekly]));
    assert.equal((await ws.next()).type, 'usage');

    // The same numbers without label or minutes (with a jittered reset time, and with none): unchanged, so nothing is sent.
    clock += 60_000;
    bridge.hub.usage(report([{ id: '5h', usedPercent: 40, resetsAt: '2026-09-29T11:59:59.000Z' }, { id: '7d', usedPercent: 12 }]));
    assert.deepEqual(stored(), [fiveHour, weekly]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ws.pending(), 0, 'the numbers never changed, so nothing was sent');

    // New numbers without them keep them too; a field only the newer report carries is added.
    clock += 60_000;
    bridge.hub.usage(report([{ id: '5h', usedPercent: 42, resetsAt: fiveHour.resetsAt }, { id: '7d', usedPercent: 13, resetsAt: '2026-10-03T00:00:00.000Z' }]));
    const grown = await ws.next();
    assert.deepEqual(grown.type === 'usage' && grown.usage.windows, [{ ...fiveHour, usedPercent: 42 }, { ...weekly, usedPercent: 13, resetsAt: '2026-10-03T00:00:00.000Z' }]);
    ws.close();
  } finally {
    await bridge.close();
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

test('usage goes out only for the accounts logged in now: the others stay out of the snapshot and GET /api/usage; a login change removes them at once, throttle or not, and brings back the new login\'s entry; entries without an account pass', async () => {
  let clock = Date.parse('2026-09-29T10:00:00Z');
  const [homeA, homeB, codexHome] = [new FakeProvider(), new FakeProvider(), new FakeProvider('codex')];
  const hub = new BridgeHub({ providers: [homeA, homeB, codexHome], alerts: { now: () => clock }, usageThrottleMs: 200, log: quiet });
  const auth = new Auth({ devices: [], save: async () => {}, now: () => clock });
  const server = await startServer({ hub, auth, bridge: { name: 'devbox', version: '0.1.0', apiVersion: 1 }, hookToken: 'h', apiPort: 0, hookPort: 0, onStatusline: () => {}, asks: fakeAskRunner(() => {}, {}) });
  try {
    const { token } = await auth.issue('w');
    const url = `ws://127.0.0.1:${server.apiPort}/api/ws`;
    // Two Claude Code homes with a login each; acc-c is an earlier login of home A whose old process still reports its limits. The Codex home uses an API key.
    hub.login(homeA, 'acc-a');
    hub.login(homeB, 'acc-b');
    hub.login(codexHome, undefined);
    const ws = await new TestSocket(url, token).open();
    await ws.next();
    const report = (provider: Usage['provider'], account: string | undefined, used: number): Usage => ({
      provider,
      updatedAt: new Date(clock).toISOString(),
      windows: [{ id: '5h', usedPercent: used, resetsAt: '2026-09-29T12:00:00.000Z' }],
      ...(account ? { account: { id: account, label: account } } : {}),
    });
    const [a, b, c, codex] = [report('claude-code', 'acc-a', 10), report('claude-code', 'acc-b', 20), report('claude-code', 'acc-c', 30), report('codex', undefined, 5)];
    // Home A is the primary home: its login is marked.
    const primary = (u: Usage): Usage => ({ ...u, account: { id: u.account?.id ?? '', label: u.account?.label ?? '', primary: true } });
    hub.usage(a);
    assert.deepEqual(await ws.next(), { type: 'usage', usage: primary(a) });
    hub.usage(c);
    hub.usage(b);
    assert.deepEqual(await ws.next(), { type: 'usage', usage: b }, 'nothing for acc-c');
    hub.usage(codex);
    assert.deepEqual(await ws.next(), { type: 'usage', usage: codex }, 'no account: sent although no Codex account is logged in');

    const keys = (list: Usage[]): string[] => list.map(usageKey);
    const current = ['claude-code:acc-a', 'claude-code:acc-b', 'codex:'];
    assert.deepEqual(keys(hub.usageList()), current);
    const rest = await fetch(`http://127.0.0.1:${server.apiPort}/api/usage`, { headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual(keys(((await rest.json()) as UsageList).usage), current);
    const later = await new TestSocket(url, token).open();
    const snapshot = await later.next();
    assert.deepEqual(snapshot.type === 'snapshot' && keys(snapshot.usage), current);
    later.close();

    // A change held back by the throttle, then home A logs into acc-c: acc-a is removed at once (no windows) and acc-c's kept entry comes back at once.
    hub.usage(report('claude-code', 'acc-a', 11));
    hub.login(homeA, 'acc-c');
    assert.deepEqual(await ws.next(), { type: 'usage', usage: { ...a, windows: [] } });
    assert.deepEqual(await ws.next(), { type: 'usage', usage: primary(c) });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ws.pending(), 0, 'the change held back for acc-a does not follow its removal');
    assert.deepEqual(keys(hub.usageList()), ['claude-code:acc-c', 'claude-code:acc-b', 'codex:']);

    // An account no home is logged into keeps its numbers without sending them; a home that logs back in shows them at once.
    hub.usage(report('claude-code', 'acc-a', 12));
    hub.login(homeA, 'acc-c'); // unchanged
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ws.pending(), 0);
    hub.login(homeA, undefined); // logged out
    assert.deepEqual(await ws.next(), { type: 'usage', usage: { ...c, windows: [] } });
    hub.login(homeA, 'acc-a');
    assert.deepEqual(await ws.next(), { type: 'usage', usage: primary(report('claude-code', 'acc-a', 12)) });
    // Removals go first, whatever order the entries were stored in: acc-c (stored before acc-b) comes back after acc-b goes.
    hub.login(homeB, 'acc-c');
    assert.deepEqual(await ws.next(), { type: 'usage', usage: { ...b, windows: [] } });
    assert.deepEqual(await ws.next(), { type: 'usage', usage: c });
    hub.login(homeB, 'acc-b');
    assert.deepEqual(await ws.next(), { type: 'usage', usage: { ...c, windows: [] } });
    assert.deepEqual(await ws.next(), { type: 'usage', usage: b });

    // An entry whose last window has reset is removed the same way once a report shows it.
    clock = Date.parse('2026-09-29T12:00:01Z');
    hub.usage(report('claude-code', 'acc-b', 20));
    assert.deepEqual(await ws.next(), { type: 'usage', usage: { ...report('claude-code', 'acc-b', 20), windows: [] } });
    assert.deepEqual(hub.usageList(), [], 'every window has reset');
    ws.close();
  } finally {
    hub.close();
    await server.close();
  }
});

test('primary marks the current login of the primary home (the first instance) in sessions and usage, in every home; a change of that login moves it at once', async () => {
  let clock = Date.parse('2026-09-29T10:00:00Z');
  const [home, extra, codexHome] = [new FakeProvider(), new FakeProvider(), new FakeProvider('codex')];
  const me: Account = { id: 'acc-me', label: 'me' };
  const school: Account = { id: 'acc-school', label: 'school', estimated: true };
  const mine = { ...session('mine'), account: me };
  const theirs = { ...session('theirs'), account: school };
  home.sessions = [mine, { ...session('old'), status: 'ended', account: me }];
  extra.sessions = [theirs, { ...session('shared'), account: me }];
  codexHome.sessions = [{ ...session('x'), id: 'codex:x', provider: 'codex', account: { id: 'cx', label: 'cx' } }];
  const bridge = await startBridge([home, extra, codexHome], () => clock);
  try {
    const report = (account: Account): Usage => ({ provider: 'claude-code', updatedAt: new Date(clock).toISOString(), windows: [{ id: '5h', usedPercent: 1, resetsAt: '2026-09-29T12:00:00.000Z' }], account });
    const mark = (x: { account?: Account }): unknown[] => [x.account?.id, x.account?.primary];
    const marked = (shown: { account?: Account }[]): unknown[] => shown.map(mark);
    // Before the primary home's login is known nobody is marked.
    bridge.hub.usage(report(me));
    assert.deepEqual(marked(bridge.hub.sessions()), [['acc-me', undefined], ['acc-school', undefined], ['acc-me', undefined], ['cx', undefined]]);
    bridge.hub.login(home, 'acc-me');
    bridge.hub.login(extra, 'acc-school');
    bridge.hub.login(codexHome, undefined);
    bridge.hub.usage(report(school));
    // The account, not the home: the extra home's session of acc-me is marked too; estimated stays.
    assert.deepEqual(marked(bridge.hub.sessions()), [['acc-me', true], ['acc-school', undefined], ['acc-me', true], ['cx', undefined]]);
    assert.deepEqual(bridge.hub.usageList().map((u) => u.account), [{ ...me, primary: true }, school]);
    const ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
    const snapshot = await ws.next();
    assert.ok(snapshot.type === 'snapshot');
    assert.deepEqual(marked(snapshot.usage), [['acc-me', true], ['acc-school', undefined]]);
    assert.deepEqual(marked(snapshot.sessions), [['acc-me', true], ['acc-school', undefined], ['acc-me', true], ['cx', undefined]]);

    // The extra home's login changing moves nothing; the primary home's does, at once (usage first, then the live sessions it concerns).
    bridge.hub.login(extra, 'acc-me');
    assert.deepEqual(await ws.next(), { type: 'usage', usage: { ...report(school), windows: [] } });
    bridge.hub.login(extra, 'acc-school');
    assert.equal((await ws.next()).type, 'usage');
    bridge.hub.login(home, 'acc-school');
    const events = [await ws.next(), await ws.next(), await ws.next(), await ws.next()];
    assert.deepEqual(events.map((e) => [e.type, e.type === 'usage' ? mark(e.usage) : e.type === 'session' ? [e.session.title, ...mark(e.session)] : undefined]), [
      ['usage', ['acc-me', undefined]],
      ['usage', ['acc-school', true]],
      ['session', ['mine', 'acc-me', undefined]],
      ['session', ['theirs', 'acc-school', true]],
    ]);
    const shared = await ws.next();
    assert.deepEqual(shared.type === 'session' && [shared.session.title, shared.session.account], ['shared', me]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ws.pending(), 0, 'nothing for the ended session or the other provider');
    assert.deepEqual(bridge.hub.usageList().map((u) => u.account), [{ ...school, primary: true }]);
    ws.close();
  } finally {
    await bridge.close();
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

test('presence counts a watch only while it answers pings: one silent for more than 35 s is gone though its socket is still open', async () => {
  const clock = { now: Date.parse('2026-09-29T10:00:00Z') };
  const bridge = await startBridge(new FakeProvider(), () => clock.now);
  try {
    const presence = async (): Promise<unknown> => (await fetch(`${bridge.local}/local/presence`, { headers: { authorization: `Bearer ${bridge.hookToken}` } })).json();
    const ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
    await ws.next();
    clock.now += 35_000;
    assert.deepEqual(await presence(), { watch: true, since: '2026-09-29T10:00:00.000Z' }, 'connected 35 s ago: within one ping interval plus 5 s');
    clock.now += 1;
    assert.deepEqual(await presence(), { watch: false, since: '2026-09-29T10:00:35.000Z' }, 'no pong since: gone, from 35 s after connecting');
    ws.ws.pong();
    await waitFor(() => bridge.hub.presence().watch || undefined);
    clock.now += 35_000;
    assert.equal(bridge.hub.presence().watch, true, 'the pong counts like a connect');
    clock.now += 1;
    assert.deepEqual(bridge.hub.presence(), { watch: false, since: '2026-09-29T10:01:10.001Z' });
    ws.close();
    await waitFor(() => (bridge.hub.pending.presence().watch ? undefined : true));
    assert.equal(bridge.hub.presence().graceUntil, '2026-09-29T10:02:40.002Z', 'closed: the registry\'s answer as before');
  } finally {
    await bridge.close();
  }
});

test('presence?codexThread= says whether a Codex provider hears that thread\'s turns finish (raises done), with or without a watch', async () => {
  const codex = Object.assign(new FakeProvider('codex'), { covers: (id: string) => id === 'th-joined' });
  const bridge = await startBridge([new FakeProvider(), codex]);
  try {
    const presence = async (query: string): Promise<unknown> => (await fetch(`${bridge.local}/local/presence${query}`, { headers: { authorization: `Bearer ${bridge.hookToken}` } })).json();
    assert.deepEqual(await presence('?codexThread=th-joined'), { watch: false, since: null, covered: true });
    assert.deepEqual(await presence('?codexThread=th-embedded'), { watch: false, since: null, covered: false }, 'a thread no provider hears (e.g. an embedded-server TUI)');
    assert.deepEqual(await presence('?codexThread='), { watch: false, since: null, covered: false });
    assert.deepEqual(await presence(''), { watch: false, since: null }, 'no covered without the query');
    const ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
    await ws.next();
    assert.deepEqual(await presence('?codexThread=th-embedded'), { watch: true, since: '2026-09-29T10:00:00.000Z', covered: false });
    ws.close();
  } finally {
    await bridge.close();
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
