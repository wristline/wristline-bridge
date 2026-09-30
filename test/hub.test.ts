// Several instances of one provider (one per agent home): session lookup, usage identity and statusLine routing.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { usageKey } from '../src/hub.ts';
import type { Account, Session, Usage } from '../src/protocol.ts';
import { statuslineRouter, type StatuslineTarget } from '../src/providers/claude-code/statusline.ts';
import { FakeProvider, TestSocket, startBridge, waitFor } from './helpers.ts';

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
  const bridge = await startBridge(new FakeProvider());
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
