// Generates protocol/v1/*.json from a fake provider through the real server and checks that the
// committed fixtures match. Regenerate with `UPDATE_FIXTURES=1 npm test`.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import type { ClientEvent, Item, Session, Usage } from '../src/protocol.ts';
import { FakeProvider, TestSocket, startBridge, type Bridge } from './helpers.ts';

const DIR = new URL('../protocol/v1/', import.meta.url);
const UPDATE = process.env.UPDATE_FIXTURES === '1';
const produced = new Set<string>();

function fixture(name: string, value: unknown): void {
  const file = `${name}.json`;
  produced.add(file);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (UPDATE) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(new URL(file, DIR), text);
    return;
  }
  let committed: string;
  try {
    committed = readFileSync(new URL(file, DIR), 'utf8');
  } catch {
    assert.fail(`protocol/v1/${file} is missing; run UPDATE_FIXTURES=1 npm test`);
  }
  assert.equal(text, committed, `protocol/v1/${file} is stale; run UPDATE_FIXTURES=1 npm test and update docs/protocol.md`);
}

const running: Session = {
  id: 'claude-code:6f1c2d3e-0000-4000-8000-000000000001',
  provider: 'claude-code',
  title: 'Fix failing CI build',
  cwd: '/home/dev/app',
  status: 'running',
  lastActivity: '2026-09-29T09:59:30.000Z',
  promptBlock: 'unsupported',
  context: { used: 86000, window: 200000 },
};
const ended: Session = {
  id: 'claude-code:6f1c2d3e-0000-4000-8000-000000000002',
  provider: 'claude-code',
  title: '',
  cwd: '/home/dev/site',
  status: 'ended',
  lastActivity: '2026-09-28T18:00:00.000Z',
  promptBlock: 'not_live',
};
const items: Item[] = [
  { seq: 1, kind: 'user', ts: '2026-09-29T09:58:00.000Z', text: 'CI 빌드가 실패해. 고쳐줘.' },
  { seq: 2, kind: 'assistant', ts: '2026-09-29T09:58:05.000Z', text: 'Checking the build log first.' },
  { seq: 3, kind: 'tool', ts: '2026-09-29T09:58:06.000Z', text: 'Bash(npm test)', detail: '3 passing\n1 failing', pending: false, error: true },
  { seq: 4, kind: 'notice', ts: '2026-09-29T09:58:30.000Z', text: 'Agent "Review build" finished' },
  { seq: 5, kind: 'tool', ts: '2026-09-29T09:59:30.000Z', text: 'Edit(/home/dev/app/build.sh)', pending: true },
];
const usage: Usage = {
  provider: 'codex',
  updatedAt: '2026-09-29T09:59:00.000Z',
  windows: [
    { id: 'primary', usedPercent: 12.5, resetsAt: '2026-09-29T13:00:00.000Z', minutes: 300 },
    { id: 'secondary', usedPercent: 40, resetsAt: '2026-10-05T00:00:00.000Z', minutes: 10080 },
  ],
};

let bridge: Bridge;
const provider = new FakeProvider();
provider.sessions = [running, ended];
provider.items.set('6f1c2d3e-0000-4000-8000-000000000001', items);
provider.items.set('6f1c2d3e-0000-4000-8000-000000000002', []);

before(async () => {
  bridge = await startBridge(provider);
  bridge.hub.usage(usage);
});
after(() => bridge.close());

const get = (path: string, token: string | null = bridge.token): Promise<Response> =>
  fetch(`${bridge.base}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
const post = (path: string, body: unknown, token: string | null = bridge.token): Promise<Response> =>
  fetch(`${bridge.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

test('REST responses', async () => {
  const unauth = await get('/api/health', null);
  assert.equal(unauth.status, 401);
  assert.equal(unauth.headers.get('www-authenticate'), 'Bearer realm="wristline"');
  fixture('error-401', await unauth.json());

  const health = await get('/api/health');
  assert.equal(health.status, 200);
  fixture('health', await health.json());

  const { code } = bridge.auth.startPairing();
  const paired = await post('/api/pair', { code, deviceName: 'Galaxy Watch Ultra' }, null);
  assert.equal(paired.status, 200);
  const pair = (await paired.json()) as { token: string; deviceId: string };
  assert.ok(bridge.auth.authenticate(pair.token));
  fixture('pair', { ...pair, token: 'dG9rZW4tZm9yLWRvY3VtZW50YXRpb24tb25seS0xMjM0NTY', deviceId: '9f86d081' });

  const sessions = await get('/api/sessions');
  fixture('sessions', await sessions.json());

  const page = await get(`/api/sessions/${encodeURIComponent(running.id)}/items?limit=40`);
  assert.equal(page.status, 200);
  fixture('items', await page.json());
  const older = (await (await get(`/api/sessions/${running.id}/items?before=3&limit=1`)).json()) as { items: Item[]; hasMore: boolean };
  assert.deepEqual([older.items.map((i) => i.seq), older.hasMore], [[2], true]);
  assert.equal((await get('/api/sessions/claude-code:nope/items')).status, 404);
  assert.equal((await get(`/api/sessions/${running.id}/items?limit=0`)).status, 400);

  fixture('usage', await (await get('/api/usage')).json());

  const blocked = await post(`/api/sessions/${encodeURIComponent(ended.id)}/prompt`, { text: 'hello' });
  assert.equal(blocked.status, 409);
  fixture('error-409-prompt-blocked', await blocked.json());
  const unsafe = await post(`/api/sessions/${encodeURIComponent(running.id)}/prompt`, { text: '!rm -rf build' });
  assert.equal(unsafe.status, 409);
  fixture('error-409-unsafe-prefix', await unsafe.json());
});

test('requests: list, answer, already resolved', async () => {
  const answer = bridge.hub.pending.open(
    {
      sessionId: running.id,
      kind: 'permission',
      title: 'Bash',
      questions: [
        {
          id: 'decision',
          text: 'rm -rf build && npm run build',
          multi: false,
          options: [
            { id: 'allow', label: 'Allow' },
            { id: 'always', label: 'Always allow', description: 'Bash(npm run build:*)' },
            { id: 'deny', label: 'Deny' },
            { id: 'defer', label: 'Answer on PC' },
          ],
        },
      ],
    },
    { timeoutMs: 60_000 },
  );
  fixture('requests', await (await get('/api/requests')).json());
  assert.equal((await post('/api/requests/req-1', { answers: { decision: ['nope'] } })).status, 400);
  const ok = await post('/api/requests/req-1', { answers: { decision: ['allow'] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await answer, { decision: ['allow'] });
  const again = await post('/api/requests/req-1', { answers: { decision: ['deny'] } });
  assert.equal(again.status, 409);
  fixture('error-409-already-resolved', await again.json());
});

test('WebSocket events', async () => {
  const other = new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token);
  const ws = new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token);
  await Promise.all([other.open(), ws.open()]);
  const snapshot = await ws.next();
  assert.equal(snapshot.type, 'snapshot');
  fixture('event-snapshot', snapshot);
  await other.next();

  const subscribe: ClientEvent = { type: 'subscribe', sessionId: running.id };
  fixture('client-subscribe', subscribe);
  ws.send(subscribe);
  other.send({ type: 'subscribe', sessionId: ended.id });
  other.send({ type: 'future_message', value: 1 });
  await new Promise((r) => setTimeout(r, 100));

  const next: Item = { seq: 6, kind: 'assistant', ts: '2026-09-29T10:00:01.000Z', text: '빌드 스크립트를 고쳤습니다. 다시 테스트할게요.' };
  provider.emit('6f1c2d3e-0000-4000-8000-000000000001', next);
  const item = await ws.next();
  fixture('event-item', item);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(other.pending(), 0, 'items only reach subscribers of that session');

  bridge.hub.session({ ...running, status: 'idle', lastActivity: '2026-09-29T10:00:02.000Z' });
  fixture('event-session', await ws.next());
  bridge.hub.removed(ended.id);
  fixture('event-session-removed', await ws.next());
  bridge.hub.usage({ ...usage, updatedAt: '2026-09-29T10:00:03.000Z', windows: [{ id: 'primary', usedPercent: 13, resetsAt: '2026-09-29T13:00:00.000Z', minutes: 300 }] });
  fixture('event-usage', await ws.next());
  bridge.hub.alert(running.id, 'done', 'Fixed the build script; all tests pass.');
  fixture('event-alert', await ws.next());

  const question = bridge.hub.pending.open({
    sessionId: running.id,
    kind: 'question',
    title: 'Question',
    questions: [
      {
        id: 'q1',
        header: 'Package manager',
        text: 'Which package manager should the build use?',
        multi: false,
        options: [
          { id: '0', label: 'npm', description: 'Keep package-lock.json' },
          { id: '1', label: 'pnpm', description: 'Faster installs' },
        ],
      },
      {
        id: 'q2',
        text: 'Which checks should run in CI?',
        multi: true,
        options: [
          { id: '0', label: 'lint' },
          { id: '1', label: 'test' },
          { id: '2', label: 'typecheck' },
        ],
      },
    ],
  });
  fixture('event-request-question', await ws.next());
  bridge.hub.pending.answer('req-2', { q1: ['1'], q2: ['0', '1'] });
  fixture('event-resolved', await ws.next());
  assert.deepEqual(await question, { q1: ['1'], q2: ['0', '1'] });

  const ctrl = new AbortController();
  const permission = bridge.hub.pending.open(
    {
      sessionId: running.id,
      kind: 'permission',
      title: 'Edit',
      questions: [
        {
          id: 'decision',
          text: '/home/dev/app/build.sh',
          multi: false,
          options: [
            { id: 'allow', label: 'Allow' },
            { id: 'deny', label: 'Deny' },
            { id: 'defer', label: 'Answer on PC' },
          ],
        },
      ],
    },
    { signal: ctrl.signal },
  );
  fixture('event-request-permission', await ws.next());
  ctrl.abort();
  assert.equal(await permission, null);
  assert.deepEqual(await ws.next(), { type: 'resolved', requestId: 'req-3', by: 'terminal' });

  ws.close();
  other.close();
});

test('every committed fixture is produced by this test', () => {
  const committed = readdirSync(DIR).filter((f) => f.endsWith('.json'));
  assert.deepEqual(committed.sort(), [...produced].sort());
});
