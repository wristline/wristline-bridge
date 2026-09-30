import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PendingRegistry } from '../src/pending.ts';
import type { Item, PendingRequest, Session, Usage } from '../src/protocol.ts';
import { PromptBlocked, type Hub } from '../src/provider.ts';
import { codexAsk } from '../src/providers/codex/ask.ts';
import { CodexProvider } from '../src/providers/codex/provider.ts';
import { CodexRpc, RpcError, type ServerRequest } from '../src/providers/codex/rpc.ts';

const root = mkdtempSync(join(tmpdir(), 'wristline-codex-rpc-'));
after(() => rmSync(root, { recursive: true, force: true }));
const FAKE = new URL('./fake-codex-proxy.ts', import.meta.url).pathname;

interface Fake {
  rpc: CodexRpc;
  home: string;
  log: () => Record<string, unknown>[];
  /** Pids of every proxy started, in order. */
  pids: () => number[];
  /** Points the control socket symlink at `daemon` (a file standing in for the daemon's socket), or removes it. */
  daemon: (name: string | undefined) => void;
}

/** A Codex home whose control socket links to a stand-in file (`daemon('d1')`), plus an rpc that runs the fake proxy. */
function fakeRpc(name: string, state: unknown, options: { retryMs?: number; socket?: boolean } = {}): Fake {
  const home = join(root, name);
  mkdirSync(join(home, 'app-server-control'), { recursive: true });
  const socket = join(home, 'app-server-control', 'app-server-control.sock');
  const daemon = (target: string | undefined): void => {
    if (existsSync(socket)) unlinkSync(socket);
    if (!target) return;
    writeFileSync(join(home, target), '');
    symlinkSync(join(home, target), socket);
  };
  if (options.socket !== false) daemon('d1');
  const logFile = join(home, 'proxy.log');
  const pidFile = join(home, 'proxy.pids');
  const rpc = new CodexRpc({
    codexHome: home,
    clientVersion: '0.1.0',
    command: { file: process.execPath, args: [FAKE, JSON.stringify(state), logFile, pidFile] },
    retryMs: options.retryMs ?? 50,
  });
  const read = (path: string): string[] => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);
  return { rpc, home, log: () => read(logFile).map((l) => JSON.parse(l) as Record<string, unknown>), pids: () => read(pidFile).map(Number), daemon };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Captures `wristline: codex ...` connection log lines. */
function captureLog(t: { after: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  t.after(() => void (console.log = original));
  return lines;
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
  await rpc.start();
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

test('rpc: retries after the proxy exits, handshakes again, and leaves no proxy behind', async (t) => {
  const { rpc, log, pids } = fakeRpc('reconnect', {});
  t.after(() => rpc.stop());
  const lines = captureLog(t);
  let closed = 0;
  rpc.on('closed', () => closed++);
  let up = ready(rpc);
  await rpc.start();
  await up;
  up = ready(rpc);
  await assert.rejects(rpc.request('fake/exit'), /closed/);
  assert.equal(rpc.ready, false);
  assert.equal(rpc.detail, 'app-server reconnecting (connection lost); read-only');
  await assert.rejects(rpc.request('thread/loaded/list'), /not connected/);
  await up;
  assert.equal(closed, 1);
  assert.equal(log().filter((m) => m.method === 'initialize').length, 2);
  assert.deepEqual(await rpc.request('thread/loaded/list'), { data: [], nextCursor: null });
  await waitFor(() => pids().length === 2 && !alive(pids()[0] ?? 0));
  assert.deepEqual(pids().map(alive), [false, true], 'only the current proxy runs');
  assert.deepEqual(lines, [
    'wristline: codex app-server connected',
    'wristline: codex app-server reconnecting (connection lost); read-only',
    'wristline: codex app-server connected',
  ]);
});

test('rpc: without the daemon socket it retries, spawns nothing, logs once, and connects as soon as the socket appears', async (t) => {
  // A retry interval far beyond the test: only the socket watch can connect it in time.
  const { rpc, pids, daemon } = fakeRpc('no-daemon', {}, { socket: false, retryMs: 60_000 });
  t.after(() => rpc.stop());
  const lines = captureLog(t);
  await rpc.start();
  assert.equal(rpc.detail, 'app-server reconnecting (not running); read-only');
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(pids(), [], 'no proxy without a socket');
  assert.equal(rpc.ready, false);
  const up = ready(rpc);
  daemon('d1');
  await up;
  assert.equal(rpc.detail, 'app-server connected');
  assert.deepEqual(lines, ['wristline: codex app-server reconnecting (not running); read-only', 'wristline: codex app-server connected']);

  // The daemon goes away with its socket: one log line, and nothing spawned without a socket.
  daemon(undefined);
  await assert.rejects(rpc.request('fake/exit'));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(rpc.detail, 'app-server reconnecting (connection lost); read-only');
  assert.equal(lines.length, 3);
  assert.equal(pids().length, 1);
});

test('rpc: repeated retries without a socket log nothing further', async (t) => {
  const { rpc, pids } = fakeRpc('quiet', {}, { socket: false, retryMs: 20 });
  t.after(() => rpc.stop());
  const lines = captureLog(t);
  await rpc.start();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(lines, ['wristline: codex app-server reconnecting (not running); read-only']);
  assert.deepEqual(pids(), []);
});

test('rpc: a replaced socket reconnects at once through a single new proxy', async (t) => {
  const { rpc, log, pids, daemon } = fakeRpc('replaced', {}, { retryMs: 60_000 });
  t.after(() => rpc.stop());
  let up = ready(rpc);
  await rpc.start();
  await up;
  const [first] = pids();
  up = ready(rpc);
  daemon('d2');
  await up;
  await waitFor(() => pids().length === 2 && !alive(first ?? 0));
  assert.deepEqual(pids().map(alive), [false, true]);
  assert.equal(log().filter((m) => m.method === 'initialize').length, 2);
  assert.deepEqual(await rpc.request('thread/loaded/list'), { data: [], nextCursor: null });
  assert.equal(rpc.detail, 'app-server connected');
});

test('rpc: a missing codex binary is reported and retried without piling up', async (t) => {
  const home = join(root, 'no-binary');
  mkdirSync(join(home, 'app-server-control'), { recursive: true });
  writeFileSync(join(home, 'd1'), '');
  symlinkSync(join(home, 'd1'), join(home, 'app-server-control', 'app-server-control.sock'));
  const rpc = new CodexRpc({ codexHome: home, bin: join(root, 'no-such-codex'), clientVersion: '0.1.0', retryMs: 30 });
  t.after(() => rpc.stop());
  const lines = captureLog(t);
  await rpc.start();
  await waitFor(() => rpc.detail === 'app-server reconnecting (codex CLI not found); read-only');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(rpc.ready, false);
  assert.deepEqual(lines, ['wristline: codex app-server reconnecting (codex CLI not found); read-only']);
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
    threads: { [loaded]: { status: { type: 'idle' }, model: 'gpt-6-astra', reasoningEffort: 'xhigh' } },
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
  const model = (id: string): unknown[] => [session(id)?.model, session(id)?.effort];
  assert.deepEqual(model(loaded), ['gpt-6-astra', 'xhigh'], 'thread/read wins over the rollout');
  assert.deepEqual(model(other), ['gpt-6-astra', 'medium'], 'the rollout\'s last turn_context');

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

  // Model and effort from thread/settings/updated; a null effort is unset.
  await notify('thread/settings/updated', { threadId: loaded, threadSettings: { cwd: '/work/api', model: 'gpt-6-astra-mini', effort: null } });
  assert.deepEqual(model(loaded), ['gpt-6-astra-mini', undefined]);

  // Status overlay from thread/status/changed.
  const status = (value: unknown): Promise<unknown> => notify('thread/status/changed', { threadId: loaded, status: value });
  await status({ type: 'active', activeFlags: ['waitingOnApproval'] });
  assert.deepEqual([session(loaded)?.status, session(loaded)?.promptBlock], ['needs_input', 'awaiting_input']);
  await status({ type: 'active', activeFlags: [] });
  assert.deepEqual([session(loaded)?.status, session(loaded)?.promptBlock], ['running', 'busy']);
  assert.deepEqual(model(loaded), ['gpt-6-astra-mini', undefined], 'a status change keeps the model');
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

test('codex provider: a failed rate-limit read is retried on the next update, the usage label follows a later-learned email, and only the newest login read applies', async (t) => {
  const home = join(root, 'codex-retry');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const [A, B] = ['a1a1a1a1-0000-4000-8000-00000000000a', 'b2b2b2b2-0000-4000-8000-00000000000b'];
  const limits = (usedPercent: number): unknown => ({ limitId: 'codex', primary: { usedPercent, windowDurationMins: 10080, resetsAt: null }, secondary: null });
  const sparse = { rateLimits: { limitId: 'codex', primary: null, secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null } } };
  const { rpc, log } = fakeRpc('retry', { accountId: A, rateLimits: limits(2), rateLimitsError: 'fetch failed' });
  const provider = new CodexProvider({ home, historyDays: 3650, rpc });
  const hub = recordingHub();
  t.after(() => provider.stop());
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
  t.after(() => void (console.error = original));
  const failures = (): number => errors.filter((e) => e.includes('account/rateLimits/read failed')).length;
  const reads = (): number => log().filter((m) => m.method === 'account/rateLimits/read').length;
  const brief = (u: Usage): unknown => [u.account?.id ?? '', u.account?.label, u.windows.map((w) => [w.id, w.usedPercent])];
  const notify = (method: string, params: unknown): Promise<unknown> => rpc.request('fake/notify', { method, params });
  await provider.start(hub);
  await waitFor(() => reads() === 1 && failures() === 1);

  // The read failed at connect: the next sparse update triggers another read instead of being dropped for good.
  await notify('account/rateLimits/updated', sparse);
  await waitFor(() => reads() === 2 && failures() === 2);
  assert.deepEqual(hub.usages, [], 'nothing is attributed while the login is unknown');
  await rpc.request('fake/state', { rateLimitsError: null });
  await notify('account/rateLimits/updated', sparse);
  await waitFor(() => hub.usages.length === 1);
  assert.deepEqual(hub.usages.map(brief), [[A, 'a1a1a1a1', [['primary', 2]]]], 'the full snapshot read carries the numbers');

  // The email learned from auth.json afterwards labels the next daemon update; the label is not frozen at sync time.
  const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const idToken = `${segment({ alg: 'none' })}.${segment({ email: 'a@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: A } })}.sig`;
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: idToken, access_token: 'ACCESS-SECRET' } }));
  await provider.refresh();
  await notify('account/rateLimits/updated', sparse);
  assert.deepEqual(hub.usages.slice(-1).map(brief), [[A, 'a@example.com', [['primary', 2], ['secondary', 40]]]]);
  assert.equal(JSON.stringify([hub.usages, errors]).includes('SECRET'), false);

  // Overlapping reads: the one issued last applies, even though the earlier one (for A) answers later.
  await rpc.request('fake/state', { accountDelayMs: 300 });
  await notify('account/updated', { authMode: 'chatgpt' });
  await rpc.request('fake/state', { accountId: B, rateLimits: limits(50), accountDelayMs: 0 });
  await notify('account/updated', { authMode: 'chatgpt' });
  await waitFor(() => hub.usages.at(-1)?.account?.id === B);
  await new Promise((r) => setTimeout(r, 400));
  await notify('account/rateLimits/updated', sparse);
  assert.deepEqual(hub.usages.slice(-2).map(brief), [
    [B, 'b2b2b2b2', [['primary', 50]]],
    [B, 'b2b2b2b2', [['primary', 50], ['secondary', 40]]],
  ]);
});

/** Rollout lines of `turns` (prompt and reply per turn) with ordinals from `first`; a `base` makes it a rewind segment. */
function rollout(id: string, first: number, effort: string, turns: [string, string][], base?: { threadId: string; endOrdinal: number; endByteOffset: number }): string[] {
  const meta: Record<string, unknown> = { id, cwd: '/w', cli_version: '0.159.2', history_mode: 'paginated' };
  if (base) meta.history_base = { thread_id: base.threadId, end_ordinal_exclusive: base.endOrdinal, end_byte_offset: base.endByteOffset };
  const records: unknown[] = [
    { type: 'session_meta', payload: meta },
    { type: 'turn_context', payload: { cwd: '/w', model: 'gpt-6-astra', effort } },
  ];
  turns.forEach(([prompt, reply], i) => {
    const turn = `turn-${first}-${i}`;
    const item = (item: unknown): unknown => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: id, turn_id: turn, item } });
    records.push(
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
      item({ type: 'UserMessage', id: `${turn}-user`, content: [{ type: 'text', text: prompt }] }),
      item({ type: 'AgentMessage', id: `${turn}-reply`, content: [{ type: 'Text', text: reply }] }),
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } },
    );
  });
  return records.map((r, i) => `${JSON.stringify({ timestamp: '2026-09-29T09:00:00.000Z', ordinal: first + i, ...(r as object) })}\n`);
}

test('codex provider: a rewound thread stays one session under its thread id, with the kept history and the new segment', async (t) => {
  const home = join(root, 'codex-rewind');
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  const thread = '019a0000-0000-7000-8000-000000000010';
  const segment = '019a0000-0000-7000-8000-000000000011';
  const origin = rollout(thread, 0, 'medium', [['first prompt', 'reply one'], ['second prompt', 'reply two']]);
  const originPath = join(day, `rollout-2026-09-29T09-00-00-${thread}.jsonl`);
  writeFileSync(originPath, origin.join(''));
  writeFileSync(join(home, 'session_index.jsonl'), `${JSON.stringify({ id: thread, thread_name: 'Named thread' })}\n`);
  const { rpc, log } = fakeRpc('rewind', { loaded: [thread], threads: { [thread]: { status: { type: 'idle' }, model: null } } });
  const provider = new CodexProvider({ home, historyDays: 3650, rpc });
  const hub = recordingHub();
  const published: string[] = [];
  hub.session = (s) => void published.push(s.id);
  t.after(() => provider.stop());
  const up = ready(rpc);
  await provider.start(hub);
  await up;
  const texts = async (): Promise<string[]> => ((await provider.readItems(thread, undefined, 10))?.items ?? []).map((i) => i.text);
  assert.deepEqual(await texts(), ['first prompt', 'reply one', 'second prompt', 'reply two']);
  const seen: Item[] = [];
  t.after(provider.watch(thread, (item) => seen.push(item)));

  // The rewind keeps turn 1 (lines 0-5) and goes on in a new file that carries the thread id and a segment id.
  const cut = origin.slice(0, 6);
  const rewound = rollout(thread, cut.length, 'high', [['third prompt', 'reply three']], { threadId: thread, endOrdinal: cut.length, endByteOffset: Buffer.byteLength(cut.join('')) });
  const segmentPath = join(day, `rollout-2026-09-29T09-30-00-${thread}_${segment}.jsonl`);
  writeFileSync(segmentPath, rewound.join(''));
  const later = new Date(Math.ceil(Date.now() / 1000) * 1000 + 5000); // Whole seconds: mtimeMs is a float.
  utimesSync(segmentPath, later, later);
  await rpc.request('fake/notify', { method: 'thread/reverted', params: { threadId: thread } });
  const session = await waitFor(() => provider.listSessions().find((s) => s.lastActivity === later.toISOString()));
  assert.equal(session.id, `codex:${thread}`);
  assert.equal(provider.listSessions().length, 1, 'the segment is not a session of its own');
  assert.ok(!published.includes(`codex:${segment}`));
  assert.deepEqual([session.title, session.effort, session.promptBlock], ['Named thread', 'high', undefined]);
  assert.deepEqual(await texts(), ['first prompt', 'reply one', 'third prompt', 'reply three']);
  await waitFor(() => seen.some((i) => i.text === 'reply three'));
  assert.deepEqual(seen.map((i) => [i.seq, i.text]), [[1, 'first prompt'], [2, 'reply one'], [3, 'third prompt'], [4, 'reply three']]);

  // Prompts and live items address the thread id the daemon knows.
  await provider.sendPrompt(thread, 'go on');
  assert.equal((log().find((m) => m.method === 'turn/start')?.params as { threadId: string }).threadId, thread);
  await rpc.request('fake/notify', { method: 'item/completed', params: { threadId: thread, turnId: 't', item: { type: 'agentMessage', id: 'live-1', text: 'live reply' } } });
  await waitFor(() => seen.some((i) => i.text === 'live reply'));
  assert.equal(seen.at(-1)?.seq, 5);

  // A restart sees both files and still lists the thread once, from the segment.
  provider.stop();
  const again = new CodexProvider({ home, historyDays: 3650 });
  await again.start(recordingHub());
  t.after(() => again.stop());
  assert.deepEqual(again.listSessions().map((s) => [s.id, s.title, s.effort]), [[`codex:${thread}`, 'Named thread', 'high']]);
  assert.deepEqual(((await again.readItems(thread, undefined, 10))?.items ?? []).map((i) => i.text), ['first prompt', 'reply one', 'third prompt', 'reply three']);
});

test('codex provider: a thread forked from another keeps that history and, unnamed, its title', async (t) => {
  const home = join(root, 'codex-fork');
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  const origin = '019a0000-0000-7000-8000-000000000020';
  const fork = '019a0000-0000-7000-8000-000000000021';
  const lines = rollout(origin, 0, 'medium', [['first prompt', 'reply one'], ['second prompt', 'reply two']]);
  writeFileSync(join(day, `rollout-2026-09-29T09-00-00-${origin}.jsonl`), lines.join(''));
  const cut = lines.slice(0, 6);
  const forked = rollout(fork, cut.length, 'low', [['forked prompt', 'forked reply']], { threadId: origin, endOrdinal: cut.length, endByteOffset: Buffer.byteLength(cut.join('')) });
  writeFileSync(join(day, `rollout-2026-09-29T09-30-00-${fork}.jsonl`), forked.join(''));
  writeFileSync(join(home, 'session_index.jsonl'), `${JSON.stringify({ id: origin, thread_name: 'Origin name' })}\n`);
  const provider = new CodexProvider({ home, historyDays: 3650 });
  await provider.start(recordingHub());
  t.after(() => provider.stop());
  const brief = provider.listSessions().map((s) => [s.id, s.title, s.effort]).sort();
  assert.deepEqual(brief, [
    [`codex:${origin}`, 'Origin name', 'medium'],
    [`codex:${fork}`, 'Origin name', 'low'],
  ]);
  assert.deepEqual(((await provider.readItems(fork, undefined, 10))?.items ?? []).map((i) => i.text), ['first prompt', 'reply one', 'forked prompt', 'forked reply']);
  assert.deepEqual(((await provider.readItems(origin, undefined, 10))?.items ?? []).map((i) => i.text), ['first prompt', 'reply one', 'second prompt', 'reply two']);
});
