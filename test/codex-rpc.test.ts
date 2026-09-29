import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PendingRegistry } from '../src/pending.ts';
import type { PendingRequest, Session, Usage } from '../src/protocol.ts';
import { PromptBlocked, type Hub } from '../src/provider.ts';
import { codexAsk } from '../src/providers/codex/ask.ts';
import { CodexProvider } from '../src/providers/codex/provider.ts';
import { CodexRpc, RpcError, type ServerRequest } from '../src/providers/codex/rpc.ts';

const root = mkdtempSync(join(tmpdir(), 'wristline-codex-rpc-'));
after(() => rmSync(root, { recursive: true, force: true }));
const FAKE = new URL('./fake-codex-proxy.ts', import.meta.url).pathname;

function fakeRpc(name: string, state: unknown): { rpc: CodexRpc; log: () => Record<string, unknown>[] } {
  const logFile = join(root, `${name}.log`);
  const rpc = new CodexRpc({
    codexHome: root,
    clientVersion: '0.1.0',
    command: { file: process.execPath, args: [FAKE, JSON.stringify(state), logFile] },
    backoffMs: { min: 20, max: 80 },
  });
  const log = (): Record<string, unknown>[] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  return { rpc, log };
}

async function waitFor<T>(get: () => T | undefined | false, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const ready = (rpc: CodexRpc): Promise<void> => new Promise((resolve) => rpc.once('ready', () => resolve()));

test('rpc: handshake, requests, errors, notifications and server requests over the proxy', async (t) => {
  const { rpc, log } = fakeRpc('basic', { loaded: ['th-1'] });
  t.after(() => rpc.stop());
  const notes: [string, unknown][] = [];
  rpc.on('notification', (method: string, params: unknown) => notes.push([method, params]));
  const seen: ServerRequest[] = [];
  rpc.onRequest((request) => {
    seen.push(request);
    // Answer approvals; leave everything else to the daemon's other clients.
    return request.method === 'item/commandExecution/requestApproval' ? Promise.resolve({ decision: 'accept' }) : undefined;
  });
  const up = ready(rpc);
  rpc.start();
  await up;
  assert.equal(rpc.ready, true);
  assert.equal(rpc.detail, 'app-server connected');

  const [init, initialized] = await waitFor(() => log().length >= 2 && log());
  assert.equal(init?.method, 'initialize');
  assert.equal(init?.jsonrpc, undefined);
  assert.deepEqual((init?.params as { clientInfo: unknown }).clientInfo, { name: 'wristline-bridge', title: 'Wristline', version: '0.1.0' });
  assert.deepEqual(initialized, { method: 'initialized' });

  assert.deepEqual(await rpc.request('thread/loaded/list'), { data: ['th-1'], nextCursor: null });
  await assert.rejects(rpc.request('nope'), (e: unknown) => e instanceof RpcError && e.code === -32601);

  await rpc.request('fake/notify', { method: 'thread/status/changed', params: { threadId: 'th-1', status: { type: 'idle' } } });
  assert.deepEqual(notes, [['thread/status/changed', { threadId: 'th-1', status: { type: 'idle' } }]]);

  await rpc.request('fake/request', { method: 'item/commandExecution/requestApproval', params: { threadId: 'th-1' } });
  await rpc.request('fake/request', { method: 'item/tool/call', params: { threadId: 'th-1' } });
  assert.deepEqual(
    seen.map((r) => [r.id, r.method]),
    [
      [0, 'item/commandExecution/requestApproval'],
      [1, 'item/tool/call'],
    ],
  );
  await waitFor(() => log().some((m) => m.id === 0 && m.method === undefined));
  const answers = log().filter((m) => m.method === undefined);
  assert.deepEqual(answers, [{ id: 0, result: { decision: 'accept' } }], 'only the handled request is answered');
});

test('rpc: reconnects with backoff and handshakes again after the proxy exits', async (t) => {
  const { rpc, log } = fakeRpc('reconnect', {});
  t.after(() => rpc.stop());
  let closed = 0;
  rpc.on('closed', () => closed++);
  let up = ready(rpc);
  rpc.start();
  await up;
  up = ready(rpc);
  await assert.rejects(rpc.request('fake/exit'), /closed/);
  assert.equal(rpc.ready, false);
  await assert.rejects(rpc.request('thread/loaded/list'), /not connected/);
  await up;
  assert.equal(closed, 1);
  assert.equal(log().filter((m) => m.method === 'initialize').length, 2);
  assert.deepEqual(await rpc.request('thread/loaded/list'), { data: [], nextCursor: null });
});

test('rpc: without the daemon socket it stays read-only and spawns nothing', async (t) => {
  const home = join(root, 'no-daemon');
  mkdirSync(home);
  const rpc = new CodexRpc({ codexHome: home, bin: join(root, 'no-such-codex'), clientVersion: '0.1.0', backoffMs: { min: 20, max: 40 } });
  t.after(() => rpc.stop());
  rpc.start();
  // A spawn attempt would report "codex CLI not found".
  await waitFor(() => rpc.detail === 'app-server not running; read-only');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(rpc.detail, 'app-server not running; read-only');
  assert.equal(rpc.ready, false);
});

test('codexAsk: decisions follow availableDecisions; questions map to labels', () => {
  const offered = codexAsk('item/commandExecution/requestApproval', {
    threadId: 't',
    turnId: 'u',
    itemId: 'i',
    command: "/bin/bash -lc 'touch x'",
    commandActions: [{ type: 'unknown', command: 'touch x' }],
    reason: 'Allow creating x?',
    availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'x'] } }, 'cancel'],
  });
  const question = offered?.draft.questions[0];
  assert.equal(offered?.draft.title, 'Shell');
  assert.equal(question?.text, 'touch x\n\nAllow creating x?');
  assert.deepEqual(question?.options, [
    { id: 'allow', label: 'Allow' },
    { id: 'always', label: 'Always allow', description: 'touch x' },
    { id: 'deny', label: 'Deny' },
  ]);
  assert.deepEqual(offered?.result({ decision: ['allow'] }), { decision: 'accept' });
  assert.deepEqual(offered?.result({ decision: ['always'] }), { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'x'] } } });
  assert.deepEqual(offered?.result({ decision: ['deny'] }), { decision: 'cancel' });

  const file = codexAsk('item/fileChange/requestApproval', { threadId: 't', turnId: 'u', itemId: 'f1' }, (id) => (id === 'f1' ? 'src/a.ts' : undefined));
  assert.equal(file?.draft.questions[0]?.text, 'src/a.ts');
  assert.deepEqual(file?.draft.questions[0]?.options.map((o) => o.id), ['allow', 'always', 'deny']);
  assert.deepEqual(file?.result({ decision: ['always'] }), { decision: 'acceptForSession' });
  assert.deepEqual(file?.result({ decision: ['deny'] }), { decision: 'decline' });

  const perms = { network: { enabled: true } };
  const permission = codexAsk('item/permissions/requestApproval', { threadId: 't', turnId: 'u', itemId: 'p', permissions: perms, cwd: '/w' });
  assert.equal(permission?.draft.questions[0]?.text, 'Network access');
  assert.deepEqual(permission?.result({ decision: ['allow'] }), { permissions: perms, scope: 'turn' });
  assert.deepEqual(permission?.result({ decision: ['always'] }), { permissions: perms, scope: 'session' });
  assert.deepEqual(permission?.result({ decision: ['deny'] }), { permissions: {} });

  const input = {
    threadId: 't',
    turnId: 'u',
    itemId: 'q',
    isBlocking: true,
    questions: [
      { id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'red', description: 'Warm' }, { label: 'blue', description: 'Cool' }] },
    ],
  };
  const ask = codexAsk('item/tool/requestUserInput', input);
  assert.deepEqual(ask?.draft, {
    kind: 'question',
    title: 'Question',
    questions: [
      {
        id: 'color',
        header: 'Color',
        text: 'Which color?',
        multi: false,
        options: [
          { id: '0', label: 'red', description: 'Warm' },
          { id: '1', label: 'blue', description: 'Cool' },
        ],
      },
    ],
  });
  assert.deepEqual(ask?.result({ color: ['1'] }), { answers: { color: { answers: ['blue'] } } });
  // Free-text and secret questions stay in the terminal.
  assert.equal(codexAsk('item/tool/requestUserInput', { ...input, questions: [{ id: 'x', header: 'X', question: 'Name?', options: null }] }), undefined);
  assert.equal(codexAsk('item/tool/requestUserInput', { ...input, questions: [{ ...input.questions[0], isSecret: true }] }), undefined);
  assert.equal(codexAsk('item/tool/call', { threadId: 't' }), undefined);
});

function recordingHub(): Hub & { requests: PendingRequest[]; resolved: string[]; usages: Usage[] } {
  const requests: PendingRequest[] = [];
  const resolved: string[] = [];
  const usages: Usage[] = [];
  return {
    requests,
    resolved,
    usages,
    session: () => {},
    removed: () => {},
    usage: (u) => usages.push(u),
    alert: () => {},
    pending: new PendingRegistry({ onRequest: (r) => requests.push(r), onResolved: (r, by) => resolved.push(`${r.id}:${by}`) }),
  };
}

test('codex provider: daemon status, usage, approvals, questions and prompts for loaded threads only', async (t) => {
  const home = join(root, 'codex-home');
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  const loaded = '019a0000-0000-7000-8000-00000000000a';
  const other = '019a0000-0000-7000-8000-00000000000b';
  for (const id of [loaded, other]) copyFileSync(new URL('./fixtures/codex/rollout.jsonl', import.meta.url), join(day, `rollout-2026-09-29T09-00-00-${id}.jsonl`));
  const { rpc, log } = fakeRpc('provider', {
    loaded: [loaded],
    threads: { [loaded]: { status: { type: 'idle' } } },
    rateLimits: { limitId: 'codex', primary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1791279979 }, secondary: null },
  });
  const provider = new CodexProvider({ home, historyDays: 3650, rpc });
  const hub = recordingHub();
  t.after(() => provider.stop());
  const up = ready(rpc);
  await provider.start(hub);
  await up;
  const resumes = (): string[] => log().flatMap((m) => (m.method === 'thread/resume' ? [String((m.params as { threadId: string }).threadId)] : []));
  await waitFor(() => resumes().includes(loaded));
  const session = (id: string): Session | undefined => provider.listSessions().find((s) => s.id === `codex:${id}`);
  assert.equal(session(loaded)?.status, 'idle');
  assert.equal(session(loaded)?.promptBlock, undefined);
  assert.equal(session(other)?.promptBlock, 'unsupported');
  assert.equal(provider.health().detail, 'app-server connected');

  // Usage from account/rateLimits/read, merged with sparse updates of the plan's limit only.
  await waitFor(() => hub.usages.length > 0);
  assert.deepEqual(hub.usages.at(-1)?.windows, [{ id: 'primary', usedPercent: 2, resetsAt: '2026-10-06T09:46:19.000Z', minutes: 10080 }]);
  const notify = (method: string, params: unknown): Promise<unknown> => rpc.request('fake/notify', { method, params });
  await notify('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: null, secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null } } });
  await notify('account/rateLimits/updated', { rateLimits: { limitId: 'base_model_inference', primary: { usedPercent: 99 }, secondary: null } });
  assert.deepEqual(
    hub.usages.at(-1)?.windows.map((w) => [w.id, w.usedPercent]),
    [
      ['primary', 2],
      ['secondary', 40],
    ],
  );

  // Status overlay from thread/status/changed.
  const status = (value: unknown): Promise<unknown> => notify('thread/status/changed', { threadId: loaded, status: value });
  await status({ type: 'active', activeFlags: ['waitingOnApproval'] });
  assert.deepEqual([session(loaded)?.status, session(loaded)?.promptBlock], ['needs_input', 'awaiting_input']);
  await status({ type: 'active', activeFlags: [] });
  assert.deepEqual([session(loaded)?.status, session(loaded)?.promptBlock], ['running', 'busy']);
  await assert.rejects(provider.sendPrompt(loaded, 'hi'), (e: unknown) => e instanceof PromptBlocked && e.code === 'busy');

  // A command approval: allow/always/deny, no defer; "always" becomes acceptForSession.
  const request = (method: string, params: unknown): Promise<unknown> => rpc.request('fake/request', { method, params });
  await request('item/commandExecution/requestApproval', { threadId: loaded, turnId: 't1', itemId: 'i1', command: 'ls', reason: null });
  const [approval] = hub.pending.list();
  assert.equal(approval?.sessionId, `codex:${loaded}`);
  assert.deepEqual(approval?.questions[0]?.options.map((o) => o.id), ['allow', 'always', 'deny']);
  assert.equal(hub.pending.answer(approval?.id ?? '', { decision: ['always'] }), 'ok');
  await waitFor(() => log().find((m) => m.id === 0 && m.method === undefined));
  assert.deepEqual(log().find((m) => m.id === 0 && m.method === undefined), { id: 0, result: { decision: 'acceptForSession' } });

  // requestUserInput: the chosen label goes back per question id.
  await request('item/tool/requestUserInput', {
    threadId: loaded,
    turnId: 't1',
    itemId: 'u1',
    isBlocking: true,
    questions: [{ id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'red', description: '' }, { label: 'blue', description: '' }] }],
  });
  const [question] = hub.pending.list();
  assert.equal(question?.kind, 'question');
  hub.pending.answer(question?.id ?? '', { color: ['1'] });
  await waitFor(() => log().find((m) => m.id === 1 && m.method === undefined));
  assert.deepEqual(log().find((m) => m.id === 1 && m.method === undefined), { id: 1, result: { answers: { color: { answers: ['blue'] } } } });

  // Answered in the TUI: the item completes, or the daemon says the request was resolved.
  await request('item/commandExecution/requestApproval', { threadId: loaded, turnId: 't1', itemId: 'i2', command: 'rm x' });
  const byItem = hub.pending.list()[0]?.id;
  await notify('item/completed', { threadId: loaded, turnId: 't1', item: { type: 'commandExecution', id: 'i2', command: 'rm x', status: 'completed', aggregatedOutput: '', exitCode: 0 } });
  await request('item/fileChange/requestApproval', { threadId: loaded, turnId: 't1', itemId: 'f1' });
  const byResolved = hub.pending.list()[0]?.id;
  await notify('serverRequest/resolved', { threadId: loaded, requestId: 3 });
  await request('item/commandExecution/requestApproval', { threadId: loaded, turnId: 't2', itemId: 'i3', command: 'x' });
  const byTurn = hub.pending.list()[0]?.id;
  await notify('turn/completed', { threadId: loaded, turn: { id: 't2', items: [], status: 'interrupted' } });
  assert.deepEqual(hub.resolved.slice(-3), [`${byItem}:terminal`, `${byResolved}:terminal`, `${byTurn}:terminal`]);
  assert.equal(hub.pending.list().length, 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(
    log().flatMap((m) => (m.method === undefined ? [m.id] : [])),
    [0, 1],
    'requests resolved elsewhere are never answered',
  );

  // Prompts: turn/start for the loaded, idle thread; unsupported for a thread the daemon has not loaded.
  await status({ type: 'idle' });
  await provider.sendPrompt(loaded, 'run the tests');
  const start = log().find((m) => m.method === 'turn/start');
  assert.deepEqual(start?.params, { threadId: loaded, input: [{ type: 'text', text: 'run the tests', text_elements: [] }] });
  await assert.rejects(provider.sendPrompt(other, 'hi'), (e: unknown) => e instanceof PromptBlocked && e.code === 'unsupported');
  await notify('thread/status/changed', { threadId: other, status: { type: 'notLoaded' } });

  // Losing the daemon resolves open requests and makes every thread read-only until it is back.
  const back = ready(rpc);
  await request('item/commandExecution/requestApproval', { threadId: loaded, turnId: 't3', itemId: 'i4', command: 'y' });
  const lost = hub.pending.list()[0]?.id;
  await assert.rejects(rpc.request('fake/exit'));
  assert.equal(hub.resolved.at(-1), `${lost}:terminal`);
  assert.equal(session(loaded)?.promptBlock, 'unsupported');
  await back;
  await waitFor(() => resumes().filter((id) => id === loaded).length === 2);
  await waitFor(() => session(loaded)?.promptBlock === undefined);

  assert.ok(!resumes().includes(other), 'a thread the daemon has not loaded is never resumed');
});

test('codex provider: daemon usage carries the login\'s account; an update during a login change waits for the re-read', async (t) => {
  const home = join(root, 'codex-accounts');
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  const thread = '019a0000-0000-7000-8000-00000000000c';
  copyFileSync(new URL('./fixtures/codex/rollout.jsonl', import.meta.url), join(day, `rollout-2026-09-29T09-00-00-${thread}.jsonl`));
  const [A, B] = ['a1a1a1a1-0000-4000-8000-00000000000a', 'b2b2b2b2-0000-4000-8000-00000000000b'];
  const limits = (usedPercent: number): unknown => ({ limitId: 'codex', primary: { usedPercent, windowDurationMins: 10080, resetsAt: null }, secondary: null });
  const sparse = { rateLimits: { limitId: 'codex', primary: null, secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null } } };
  const { rpc } = fakeRpc('accounts', { account: { type: 'chatgpt', email: 'a@example.com', planType: 'plus' }, accountId: A, rateLimits: limits(2), accountDelayMs: 150 });
  const saved: Record<string, string>[] = [];
  const provider = new CodexProvider({ home, historyDays: 3650, rpc, labels: { [B]: 'school' }, saveAccounts: async (a) => void saved.push(a) });
  const hub = recordingHub();
  t.after(() => provider.stop());
  await provider.start(hub);
  const brief = (u: Usage): unknown => [u.account?.id ?? '', u.account?.label, u.windows.map((w) => [w.id, w.usedPercent])];
  // The rollout's snapshot goes out first (the email is not known yet), then the daemon's, labelled with account/read's email.
  await waitFor(() => hub.usages.length >= 2);
  assert.deepEqual(hub.usages.map(brief), [
    [A, 'a1a1a1a1', [['primary', 12.5], ['secondary', 40]]],
    [A, 'a@example.com', [['primary', 2]]],
  ]);
  assert.deepEqual(saved, [{ [A]: 'a@example.com' }]);
  await waitFor(() => provider.listSessions()[0]?.account?.label === 'a@example.com');

  // Another login: the sparse update that arrives before the new login is read is dropped rather than attributed to A.
  await rpc.request('fake/state', { account: { type: 'chatgpt', email: 'b@example.com', planType: 'plus' }, accountId: B, rateLimits: limits(50) });
  const notify = (method: string, params: unknown): Promise<unknown> => rpc.request('fake/notify', { method, params });
  await notify('account/updated', { authMode: 'chatgpt' });
  await notify('account/rateLimits/updated', sparse);
  await waitFor(() => hub.usages.at(-1)?.account?.id === B);
  assert.deepEqual(hub.usages.slice(2).map(brief), [[B, 'school', [['primary', 50]]]]);
  await notify('account/rateLimits/updated', sparse);
  assert.deepEqual(hub.usages.slice(2).map(brief), [
    [B, 'school', [['primary', 50]]],
    [B, 'school', [['primary', 50], ['secondary', 40]]],
  ]);
  assert.deepEqual(saved.at(-1), { [A]: 'a@example.com', [B]: 'b@example.com' });
});
