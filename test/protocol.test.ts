// Generates protocol/v1/*.json from a fake provider through the real server and checks that the
// committed fixtures match. Regenerate with `UPDATE_FIXTURES=1 npm test`.
// The watch app's demo mode loads event-snapshot.json and items.json, so the snapshot carries one
// request of each kind and one replayed alert. The ended session is not listed (live sessions only); it still answers a prompt with 409.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import type { Answers, AskBody, ClientEvent, Item, Session, Usage } from '../src/protocol.ts';
import { FakeProvider, TestSocket, fakeAskRunner, startBridge, type Bridge } from './helpers.ts';

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
  turnStartedAt: '2026-09-29T09:58:00.000Z',
  progress: { done: 3, total: 7 },
  context: { used: 86000, window: 200000 },
  account: { id: 'acc-school', label: 'school', estimated: true },
  model: 'Fable 5.1',
  effort: 'xhigh',
};
const codex: Session = {
  id: 'codex:019a0000-0000-7000-8000-000000000001',
  provider: 'codex',
  title: 'Add rate limiting to the API',
  cwd: '/home/dev/api',
  status: 'idle',
  lastActivity: '2026-09-29T09:52:00.000Z',
  context: { used: 38500, window: 272000 },
  account: { id: 'c0a1b2c3-0000-4000-8000-000000000001', label: 'dev@example.com' },
  model: 'gpt-6-astra',
  effort: 'medium',
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
  account: { id: 'c0a1b2c3-0000-4000-8000-000000000001', label: 'dev@example.com' },
};
/** Two Claude Code accounts: one attributed for certain (the primary home's login), one estimated from the home's login timeline (an extra home's login). */
const claudeUsage: Usage[] = [
  {
    provider: 'claude-code',
    updatedAt: '2026-09-29T09:58:00.000Z',
    windows: [
      { id: '5h', label: '5h', usedPercent: 42, resetsAt: '2026-09-29T14:00:00.000Z', minutes: 300 },
      { id: '7d', label: '7d', usedPercent: 12, resetsAt: '2026-10-03T00:00:00.000Z', minutes: 10080 },
      { id: '7d_fable', label: '7d Fable', usedPercent: 61, resetsAt: '2026-10-03T00:00:00.000Z', minutes: 10080 },
    ],
    account: { id: 'acc-school', label: 'school', estimated: true },
  },
  {
    provider: 'claude-code',
    updatedAt: '2026-09-29T09:57:00.000Z',
    windows: [
      { id: '5h', usedPercent: 10, resetsAt: '2026-09-29T12:00:00.000Z' },
      { id: '7d', usedPercent: 3, resetsAt: '2026-10-02T00:00:00.000Z' },
    ],
    account: { id: 'acc-me', label: 'dev@example.com' },
  },
];

let bridge: Bridge;
const provider = new FakeProvider();
provider.sessions = [running, ended];
provider.items.set('6f1c2d3e-0000-4000-8000-000000000001', items);
provider.items.set('6f1c2d3e-0000-4000-8000-000000000002', []);
const codexProvider = new FakeProvider('codex');
codexProvider.sessions = [codex];
/** An extra Claude Code home (`accounts add`), logged into acc-school; `provider` is the primary home, logged into acc-me. */
const schoolHome = new FakeProvider();
/** The Codex session as the watch sees it: its account is the primary Codex home's login. */
const codexShown: Session = { ...codex, account: { id: 'c0a1b2c3-0000-4000-8000-000000000001', label: 'dev@example.com', primary: true } };
/** Opened before the snapshot is taken and resolved after it, one from the watch and one in the terminal. */
let permission: Promise<Answers | null>;
let question: Promise<Answers | null>;
const terminal = new AbortController();
let clock = Date.parse('2026-09-29T10:00:00Z');
const now = (): number => clock;
/** The fake `claude` only: a Codex ask is `ask_unavailable`. */
const fakeEnv = { FAKE_MODE: 'ok' };

before(async () => {
  bridge = await startBridge([provider, codexProvider, schoolHome], now, undefined, undefined, (onEvent) => fakeAskRunner(onEvent, fakeEnv, { bins: { claude: 'claude' }, now }));
  bridge.hub.login(provider, 'acc-me');
  bridge.hub.login(schoolHome, 'acc-school');
  bridge.hub.login(codexProvider, usage.account?.id);
  for (const u of claudeUsage) bridge.hub.usage(u);
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
  // Hiding tool rows: the page counts matching items only, so it skips seq 3 and 5; seq 1 is still older.
  const filtered = await get(`/api/sessions/${encodeURIComponent(running.id)}/items?kinds=user,assistant,notice&limit=2`);
  assert.equal(filtered.status, 200);
  fixture('items-filtered', await filtered.json());
  const rest = (await (await get(`/api/sessions/${running.id}/items?kinds=user,assistant,notice&before=2&limit=2`)).json()) as { items: Item[]; hasMore: boolean };
  assert.deepEqual([rest.items.map((i) => i.seq), rest.hasMore], [[1], false]);
  assert.equal((await get(`/api/sessions/${running.id}/items?kinds=user,thinking`)).status, 400);
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

test('requests: open and list', async () => {
  // A connected watch receives each request as it opens and the session that now waits on it.
  const ws = new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token);
  await ws.open();
  await ws.next();

  permission = bridge.hub.pending.open(
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
  fixture('event-request-permission', await ws.next());
  // A session waiting on an answer is not running: it reports no turn start.
  const { turnStartedAt: _t, ...waiting } = running;
  assert.deepEqual(await ws.next(), { type: 'session', session: { ...waiting, status: 'needs_input', promptBlock: 'awaiting_input' } });

  question = bridge.hub.pending.open(
    {
      sessionId: codex.id,
      kind: 'question',
      title: 'Question',
      questions: [
        {
          id: 'q1',
          header: 'Counter store',
          text: 'Where should the rate-limit counters live?',
          multi: false,
          options: [
            { id: '0', label: 'In memory', description: 'Per process; resets on restart' },
            { id: '1', label: 'Redis', description: 'Shared by all instances' },
            { id: '2', label: 'Postgres', description: 'No new dependency' },
          ],
        },
        {
          id: 'q2',
          text: 'Which routes should be limited?',
          multi: true,
          options: [
            { id: '0', label: '/login' },
            { id: '1', label: '/api/search' },
            { id: '2', label: '/api/upload' },
          ],
        },
      ],
    },
    { signal: terminal.signal },
  );
  fixture('event-request-question', await ws.next());
  assert.deepEqual(await ws.next(), { type: 'session', session: { ...codexShown, status: 'needs_input', promptBlock: 'awaiting_input' } });

  // Raised before the snapshot below is taken, which replays it for a watch that was offline.
  bridge.hub.alert(running.id, 'done', 'Fixed the build script; all tests pass.', 'Fix the build script');
  fixture('event-alert', await ws.next());
  ws.close();

  fixture('requests', await (await get('/api/requests')).json());
  assert.equal((await post('/api/requests/req-1', { answers: { decision: ['nope'] } })).status, 400);
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
  // The other watch leaves the screen: from now on it hears only requests, resolutions, alerts and needs_input transitions.
  const mode: ClientEvent = { type: 'mode', mode: 'background' };
  fixture('client-mode', mode);
  other.send(mode);
  const talk = new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token);
  await talk.open();
  await talk.next();
  const subscribeKinds: ClientEvent = { type: 'subscribe', sessionId: running.id, kinds: ['user', 'assistant', 'notice'] };
  fixture('client-subscribe-kinds', subscribeKinds);
  talk.send(subscribeKinds);
  await new Promise((r) => setTimeout(r, 100));

  // The pending Edit finishes: only the unfiltered subscriber hears of it.
  const done: Item = { ...(items[4] as Item), pending: false };
  provider.emit('6f1c2d3e-0000-4000-8000-000000000001', done);
  assert.deepEqual(await ws.next(), { type: 'item', sessionId: running.id, item: done });
  const next: Item = { seq: 6, kind: 'assistant', ts: '2026-09-29T10:00:01.000Z', text: '빌드 스크립트를 고쳤습니다. 다시 테스트할게요.' };
  provider.emit('6f1c2d3e-0000-4000-8000-000000000001', next);
  const item = await ws.next();
  fixture('event-item', item);
  assert.deepEqual(await talk.next(), item, 'the tool update was not sent to the kinds subscription');
  // A plan is an assistant item: the subscription without tool rows gets it too.
  const plan: Item = { seq: 7, kind: 'assistant', ts: '2026-09-29T10:00:05.000Z', text: '# Plan: fix the build\n\n1. Pin Node in build.sh\n2. Re-run npm test', plan: true };
  provider.emit('6f1c2d3e-0000-4000-8000-000000000001', plan);
  const planItem = await ws.next();
  fixture('event-item-plan', planItem);
  assert.deepEqual(await talk.next(), planItem);
  // A usage limit the agent hit: an error assistant item, with the reset time when known; the subscription without tool rows gets it too.
  const limit: Item = {
    seq: 8,
    kind: 'assistant',
    ts: '2026-09-29T10:00:09.000Z',
    text: "You've hit your session limit · resets 7:40pm (Asia/Seoul)",
    error: true,
    resetsAt: '2026-09-29T10:40:00.000Z',
    limitKind: 'window',
  };
  provider.emit('6f1c2d3e-0000-4000-8000-000000000001', limit);
  const limitItem = await ws.next();
  fixture('event-item-limit', limitItem);
  assert.deepEqual(await talk.next(), limitItem);
  // Usage credits ran out (with no plan window to go by): no reset time.
  const credits: Item = { seq: 9, kind: 'assistant', ts: '2026-09-29T10:00:10.000Z', text: 'Your workspace is out of credits. Add credits to continue.', error: true, limitKind: 'credits' };
  provider.emit('6f1c2d3e-0000-4000-8000-000000000001', credits);
  const creditsItem = await ws.next();
  fixture('event-item-limit-credits', creditsItem);
  assert.deepEqual(await talk.next(), creditsItem);
  talk.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(other.pending(), 0, 'items only reach subscribers of that session');
  // Its alert reaches every client, the one in background mode too.
  bridge.hub.alert(running.id, 'limit', limit.text, running.title, { resetsAt: limit.resetsAt, limitKind: limit.limitKind });
  const limitAlert = await ws.next();
  fixture('event-alert-limit', limitAlert);
  assert.deepEqual(await other.next(), limitAlert);

  // The watch allows the command: the request resolves and the session goes back to running.
  assert.equal((await post('/api/requests/req-1', { answers: { decision: ['allow'] } })).status, 200);
  assert.deepEqual(await permission, { decision: ['allow'] });
  fixture('event-resolved', await ws.next());
  fixture('event-session', await ws.next());
  const again = await post('/api/requests/req-1', { answers: { decision: ['deny'] } });
  assert.equal(again.status, 409);
  fixture('error-409-already-resolved', await again.json());

  bridge.hub.removed(ended.id);
  fixture('event-session-removed', await ws.next());
  // A minute later (usage events are throttled to one per minute per entry) the primary window moved; the secondary one is kept from the earlier report.
  clock += 60_000;
  bridge.hub.usage({ ...usage, updatedAt: '2026-09-29T10:01:00.000Z', windows: [{ id: 'primary', usedPercent: 13, resetsAt: '2026-09-29T13:00:00.000Z', minutes: 300 }] });
  const changed = await ws.next();
  fixture('event-usage', changed);
  clock -= 60_000;
  // The Codex home logs into another account: the entry is removed at once (empty windows), throttle or not, and the session of that account is no longer marked primary; logging back in brings both back.
  bridge.hub.login(codexProvider, 'c0a1b2c3-0000-4000-8000-000000000002');
  fixture('event-usage-removed', await ws.next());
  assert.deepEqual(await ws.next(), { type: 'session', session: { ...codex, status: 'needs_input', promptBlock: 'awaiting_input' } });
  bridge.hub.login(codexProvider, usage.account?.id);
  assert.deepEqual(await ws.next(), changed);
  assert.deepEqual(await ws.next(), { type: 'session', session: { ...codexShown, status: 'needs_input', promptBlock: 'awaiting_input' } });

  // The question is answered in the Codex terminal instead.
  terminal.abort();
  assert.equal(await question, null);
  assert.deepEqual(await ws.next(), { type: 'resolved', requestId: 'req-2', by: 'terminal' });
  assert.deepEqual(await ws.next(), { type: 'session', session: codexShown });

  await new Promise((r) => setTimeout(r, 100));
  const heard: string[] = [];
  while (other.pending() > 0) heard.push((await other.next()).type);
  assert.deepEqual(heard, ['resolved', 'session', 'resolved', 'session'], 'the background watch heard the two resolutions and the sessions leaving needs_input, not the item, session_removed or usage');
  ws.close();
  other.close();
});

test('Quick Ask: request, events, list and its errors', async () => {
  const ws = new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token);
  await ws.open();
  await ws.next();
  const ids = new Map<string, string>();
  // Ask ids are random; the fixtures show fixed ones.
  const fixed = (value: unknown): unknown => JSON.parse([...ids].reduce((text, [id, shown]) => text.replaceAll(id, shown), JSON.stringify(value)));
  const del = (id: string): Promise<Response> => fetch(`${bridge.base}/api/asks/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${bridge.token}` } });

  const ask: AskBody = { provider: 'claude-code', text: 'Reply with the single word OK' };
  fixture('ask', ask);
  const accepted = await post('/api/ask', ask);
  assert.equal(accepted.status, 202);
  const { askId } = (await accepted.json()) as { askId: string };
  ids.set(askId, 'ask-3f6a1c2e-0000-4000-8000-000000000001');
  fixture('ask-accepted', fixed({ askId }));
  fixture('event-ask-running', fixed(await ws.next()));
  fixture('event-ask-done', fixed(await ws.next()));
  // A follow-up in the same thread: the first ask's id is the thread id.
  const followUp: AskBody = { provider: 'claude-code', text: 'And in French?', threadId: 'ask-3f6a1c2e-0000-4000-8000-000000000001' };
  fixture('ask-thread', followUp);
  const continued = await post('/api/ask', { ...followUp, threadId: askId });
  assert.equal(continued.status, 202);
  ids.set(((await continued.json()) as { askId: string }).askId, 'ask-3f6a1c2e-0000-4000-8000-000000000002');
  assert.equal((await ws.next()).type, 'ask');
  assert.equal((await ws.next()).type, 'ask');

  fakeEnv.FAKE_MODE = 'sleep';
  const slow = await post('/api/ask', { provider: 'claude-code', text: 'What is the capital of France?' });
  assert.equal(slow.status, 202);
  ids.set(((await slow.json()) as { askId: string }).askId, 'ask-3f6a1c2e-0000-4000-8000-000000000003');
  assert.equal((await ws.next()).type, 'ask');
  const busy = await post('/api/ask', { provider: 'claude-code', text: 'another' });
  assert.equal(busy.status, 409);
  fixture('error-409-ask-busy', await busy.json());
  assert.equal((await del([...ids.keys()][2] ?? '')).status, 204);
  fixture('event-ask-error', fixed(await ws.next()));
  assert.equal((await del('ask-unknown')).status, 404);
  fakeEnv.FAKE_MODE = 'ok';
  assert.equal((await fetch(`${bridge.base}/api/asks/thread/ask-unknown`, { method: 'DELETE', headers: { authorization: `Bearer ${bridge.token}` } })).status, 404);

  const unavailable = await post('/api/ask', { provider: 'codex', text: 'x' });
  assert.equal(unavailable.status, 503);
  fixture('error-503-ask-unavailable', await unavailable.json());
  fixture('asks', fixed(await (await get('/api/asks')).json()));
  ws.close();
});

test('every committed fixture is produced by this test', () => {
  const committed = readdirSync(DIR).filter((f) => f.endsWith('.json'));
  assert.deepEqual(committed.sort(), [...produced].sort());
});
