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

test('two instances of one provider: resolve picks the one listing the session, and items are served from it', async () => {
  const a = new FakeProvider();
  a.sessions = [session('s1')];
  a.items.set('s1', [{ seq: 1, kind: 'user', ts: '2026-09-29T10:00:00.000Z', text: 'from a' }]);
  const b = new FakeProvider();
  b.sessions = [session('s2')];
  b.items.set('s2', []);
  const bridge = await startBridge([a, b]);
  try {
    assert.equal(bridge.hub.resolve('claude-code:s1')?.provider, a);
    assert.equal(bridge.hub.resolve('claude-code:s2')?.provider, b);
    assert.equal(bridge.hub.resolve('claude-code:s3'), undefined);
    assert.equal(bridge.hub.resolve('codex:s1'), undefined);
    assert.deepEqual(
      bridge.hub.sessions().map((s) => s.id),
      ['claude-code:s1', 'claude-code:s2'],
    );
    assert.deepEqual(bridge.hub.providerHealth().map((h) => h.id), ['claude-code', 'claude-code']);
    const items = (id: string): Promise<Response> => fetch(`${bridge.base}/api/sessions/${id}/items`, { headers: { authorization: `Bearer ${bridge.token}` } });
    assert.deepEqual(await (await items('claude-code:s1')).json(), { items: [{ seq: 1, kind: 'user', ts: '2026-09-29T10:00:00.000Z', text: 'from a' }], hasMore: false });
    assert.deepEqual(await (await items('claude-code:s2')).json(), { items: [], hasMore: false });
    assert.equal((await items('claude-code:s3')).status, 404);
  } finally {
    await bridge.close();
  }
});

test('usage is kept per provider and account; a labelled entry retires the unlabelled one; only changed numbers are broadcast', async () => {
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

  calls.length = 0;
  statuslineRouter([a])({ session_id: 'anything' });
  await waitFor(() => calls[0]);
  assert.deepEqual(calls, [[homeA, 'anything']]);
});
