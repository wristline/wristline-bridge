import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BridgeHub } from '../src/hub.ts';
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

function recordingHub(): Hub & { requests: PendingRequest[]; resolved: string[]; usages: Usage[]; alerts: unknown[][] } {
  const requests: PendingRequest[] = [];
  const resolved: string[] = [];
  const usages: Usage[] = [];
  const alerts: unknown[][] = [];
  return {
    requests,
    resolved,
    usages,
    alerts,
    session: () => {},
    removed: () => {},
    usage: (u) => usages.push(u),
    liveUsage: (_provider, u) => void (u && usages.push(u)),
    login: () => {},
    alert: (sessionId, kind, text, title) => void alerts.push([sessionId, kind, text, title]),
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
  const logins = [{ at: '2026-09-29T08:00:00.000Z', id: A }]; // A was this home's login when the rollout was written.
  const provider = new CodexProvider({ home, historyDays: 3650, rpc, logins, labels: { [B]: 'school' }, saveAccounts: async (a) => void saved.push(a) });
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

test('codex provider: without auth.json (credentials kept in the OS keyring) the daemon\'s account is the home\'s login; no account is shown while no daemon says', async (t) => {
  const [A, B] = ['a1a1a1a1-0000-4000-8000-00000000000a', 'b2b2b2b2-0000-4000-8000-00000000000b'];
  const limits = (usedPercent: number): unknown => ({ limitId: 'codex', primary: { usedPercent, windowDurationMins: 10080, resetsAt: null }, secondary: null });
  const { rpc, home, daemon } = fakeRpc('keyring', { account: { type: 'chatgpt', email: 'a@example.com', planType: 'plus' }, accountId: A, rateLimits: limits(2) });
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  const thread = '019a0000-0000-7000-8000-00000000000d';
  copyFileSync(new URL('./fixtures/codex/rollout.jsonl', import.meta.url), join(day, `rollout-2026-09-29T09-00-00-${thread}.jsonl`)); // A thread of A.
  captureLog(t);
  const provider = new CodexProvider({ home, historyDays: 3650, rpc, logins: [{ at: '2026-09-29T08:00:00.000Z', id: A }] });
  const hub = new BridgeHub({ providers: [provider], alerts: { now: () => Date.parse('2026-09-29T10:00:00Z') }, log: () => {} });
  t.after(() => {
    provider.stop();
    hub.close();
  });
  const shown = (): unknown[] => hub.usageList().map((u) => [u.account?.id, u.windows.map((w) => [w.id, w.usedPercent])]);
  const showing = (expected: unknown[]): Promise<true> => waitFor(() => JSON.stringify(shown()) === JSON.stringify(expected) || undefined);
  await provider.start(hub);
  // The rollout's numbers (A's) wait for the daemon to say whose login this is; the daemon's live ones then replace them.
  await showing([[A, [['primary', 2]]]]);
  await rpc.request('fake/state', { account: { type: 'chatgpt', email: 'b@example.com', planType: 'plus' }, accountId: B, rateLimits: limits(50) });
  await rpc.request('fake/notify', { method: 'account/updated', params: { authMode: 'chatgpt' } });
  await showing([[B, [['primary', 50]]]]);
  // The daemon goes away: nothing vouches for B any more.
  daemon(undefined);
  await assert.rejects(rpc.request('fake/exit'), /closed/);
  await showing([]);
});

/** An `auth.json` naming a ChatGPT login (an unsigned id_token; no token value is ever read out). */
function authJson(accountId: string, email: string): string {
  const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const idToken = `${segment({ alg: 'none' })}.${segment({ email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.sig`;
  return JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: idToken, access_token: 'ACCESS-SECRET' } });
}

/** Rollout lines: a thread created by `creator`, then a rate-limit snapshot (primary window only) written at `at`. */
function limitsRollout(id: string, creator: string, at: string, usedPercent: number, resetsAt: number): string {
  return [
    { timestamp: '2026-09-29T09:00:00.000Z', type: 'session_meta', payload: { id, cwd: '/w', cli_version: '0.159.2', creator_account_id: creator } },
    snapshotLine(at, usedPercent, resetsAt),
  ].map((l) => `${JSON.stringify(l)}\n`).join('');
}

function snapshotLine(at: string, usedPercent: number, resetsAt: number): unknown {
  return { timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: resetsAt }, secondary: null } } };
}

test('codex provider: the daemon\'s live numbers replace what rollouts said of its account (a stale window with a later reset time too); no rollout of any home changes them while it is connected; once it is gone, snapshots written under that login count again', async (t) => {
  const A = 'a1a1a1a1-0000-4000-8000-00000000000a';
  const logins = [{ at: '2026-09-29T08:00:00.000Z', id: A }];
  const [OCT5, OCT6] = [1791190000, 1791279979]; // 2026-10-05T08:46:40Z and 2026-10-06T09:46:19Z
  const { rpc, home, daemon } = fakeRpc('live-wins', {
    account: { type: 'chatgpt', email: 'a@example.com', planType: 'plus' },
    accountId: A,
    rateLimits: { limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: OCT5 }, secondary: { usedPercent: 6, windowDurationMins: 300, resetsAt: OCT5 } },
  });
  writeFileSync(join(home, 'auth.json'), authJson(A, 'a@example.com'));
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  const rollout = join(day, 'rollout-2026-09-29T09-00-00-019a0000-0000-7000-8000-0000000000f1.jsonl');
  // A's own snapshot, with another window's reset time: merged, the later reset time would win.
  writeFileSync(rollout, limitsRollout('019a0000-0000-7000-8000-0000000000f1', A, '2026-09-29T09:30:00.000Z', 4, OCT6));
  // A second home, also logged into A (no daemon there), with a snapshot newer than anything the daemon said.
  const other = join(root, 'live-wins-other');
  mkdirSync(join(other, 'sessions', '2026', '09', '29'), { recursive: true });
  const newer = new Date(Date.now() + 3600_000).toISOString();
  writeFileSync(join(other, 'sessions', '2026', '09', '29', 'rollout-2026-09-29T09-00-00-019a0000-0000-7000-8000-0000000000f2.jsonl'), limitsRollout('019a0000-0000-7000-8000-0000000000f2', A, newer, 9, OCT6));
  writeFileSync(join(other, 'auth.json'), authJson(A, 'a@example.com'));

  const provider = new CodexProvider({ home, historyDays: 3650, rpc, logins });
  const second = new CodexProvider({ home: other, historyDays: 3650, logins });
  const reports: unknown[] = [];
  const hub = new BridgeHub({ providers: [provider, second], alerts: { now: () => Date.parse('2026-09-29T10:00:00Z') }, log: () => {} });
  const report = hub.usage.bind(hub);
  hub.usage = (u) => {
    reports.push([u.account?.id, u.windows.map((w) => w.usedPercent)]);
    report(u);
  };
  t.after(() => {
    provider.stop();
    second.stop();
    hub.close();
  });
  const shown = (): unknown[] => hub.usageList().map((u) => [u.account?.id, u.windows.map((w) => [w.id, w.usedPercent, w.resetsAt])]);
  const showing = (expected: unknown[]): Promise<true> => waitFor(() => JSON.stringify(shown()) === JSON.stringify(expected) || undefined);
  const live = [[A, [['primary', 0, '2026-10-05T08:46:40.000Z'], ['secondary', 6, '2026-10-05T08:46:40.000Z']]]];
  await provider.start(hub);
  await showing(live);
  assert.deepEqual(reports, [[A, [4]]], 'the rollout came first');
  await second.start(hub);
  assert.deepEqual(reports, [[A, [4]], [A, [9]]]);
  assert.deepEqual(shown(), live, 'another home\'s newer rollout of A is ignored while the daemon is connected');

  // The daemon goes away: a snapshot written after its last numbers counts for A again.
  daemon(undefined);
  await assert.rejects(rpc.request('fake/exit'), /closed/);
  await waitFor(() => provider.health().detail !== 'app-server connected');
  appendFileSync(rollout, `${JSON.stringify(snapshotLine(new Date(Date.now() + 7200_000).toISOString(), 7, OCT5))}\n`);
  await provider.refresh();
  assert.deepEqual(shown(), [[A, [['primary', 7, '2026-10-05T08:46:40.000Z'], ['secondary', 6, '2026-10-05T08:46:40.000Z']]]]);
});

test('codex provider: while the daemon serves another account than auth.json names, the home\'s timeline marks its login unknown until they agree', async (t) => {
  const [A, B] = ['a1a1a1a1-0000-4000-8000-00000000000a', 'b2b2b2b2-0000-4000-8000-00000000000b'];
  const limits = { limitId: 'codex', primary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: null }, secondary: null };
  const { rpc, home } = fakeRpc('disagree', { account: { type: 'chatgpt', email: 'a@example.com', planType: 'plus' }, accountId: A, rateLimits: limits });
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(join(home, 'auth.json'), authJson(B, 'b@example.com')); // `codex login` as B; the daemon has not taken it up
  const saved: { at: string; id: string }[][] = [];
  const provider = new CodexProvider({ home, historyDays: 3650, rpc, saveLogins: async (l) => void saved.push(l) });
  t.after(() => provider.stop());
  const ids = (): string[] => (saved.at(-1) ?? []).map((l) => l.id);
  await provider.start(recordingHub());
  await waitFor(() => ids().length === 2);
  assert.deepEqual(ids(), [B, '']);
  await rpc.request('fake/state', { account: { type: 'chatgpt', email: 'b@example.com', planType: 'plus' }, accountId: B });
  await rpc.request('fake/notify', { method: 'account/updated', params: { authMode: 'chatgpt' } });
  await waitFor(() => ids().length === 3);
  assert.deepEqual(ids(), [B, '', B]);
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

test('codex provider: a fork scanned before its first line was complete gets the kept history and title once the line is there', async (t) => {
  const home = join(root, 'codex-fork-partial');
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  const origin = '019a0000-0000-7000-8000-000000000022';
  const fork = '019a0000-0000-7000-8000-000000000023';
  const lines = rollout(origin, 0, 'medium', [['first prompt', 'reply one'], ['second prompt', 'reply two']]);
  writeFileSync(join(day, `rollout-2026-09-29T09-00-00-${origin}.jsonl`), lines.join(''));
  const cut = lines.slice(0, 6);
  const forked = rollout(fork, cut.length, 'low', [['forked prompt', 'forked reply']], { threadId: origin, endOrdinal: cut.length, endByteOffset: Buffer.byteLength(cut.join('')) });
  const forkPath = join(day, `rollout-2026-09-29T09-30-00-${fork}.jsonl`);
  writeFileSync(forkPath, (forked[0] ?? '').slice(0, 80)); // Codex is still writing the first line.
  writeFileSync(join(home, 'session_index.jsonl'), `${JSON.stringify({ id: origin, thread_name: 'Origin name' })}\n`);
  const provider = new CodexProvider({ home, historyDays: 3650 });
  await provider.start(recordingHub());
  t.after(() => provider.stop());
  const texts = async (): Promise<string[]> => ((await provider.readItems(fork, undefined, 10))?.items ?? []).map((i) => i.text);
  assert.deepEqual(await texts(), [], 'a transcript opened meanwhile');
  writeFileSync(forkPath, forked.join(''));
  await provider.refresh();
  assert.equal(provider.listSessions().find((s) => s.id === `codex:${fork}`)?.title, 'Origin name');
  assert.deepEqual(await texts(), ['first prompt', 'reply one', 'forked prompt', 'forked reply']);
});

test('codex provider: sub-agent rollouts take none of the 50 places of the list', async (t) => {
  const home = join(root, 'codex-subagent-cap');
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  const id = (n: number): string => `019a0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const older = new Date(Math.floor(Date.now() / 1000) * 1000 - 3600_000);
  const parents = [id(1), id(2)];
  for (const parent of parents) {
    const path = join(day, `rollout-2026-09-29T09-00-00-${parent}.jsonl`);
    writeFileSync(path, rollout(parent, 0, 'low', [['first prompt', 'reply one']]).join(''));
    utimesSync(path, older, older);
  }
  // Fifty sub-agents, all written after their parents.
  for (let n = 100; n < 150; n++) {
    const lines = rollout(id(n), 0, 'low', [['task', 'report']]);
    lines[0] = `${JSON.stringify({ timestamp: '2026-09-29T09:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: id(n), cwd: '/w', source: { subagent: { thread_spawn: { parent_thread_id: id(1), depth: 1 } } } } })}\n`;
    writeFileSync(join(day, `rollout-2026-09-29T09-10-00-${id(n)}.jsonl`), lines.join(''));
  }
  const provider = new CodexProvider({ home, historyDays: 3650 });
  await provider.start(recordingHub());
  t.after(() => provider.stop());
  assert.deepEqual(provider.listSessions().map((s) => s.id).sort(), parents.map((p) => `codex:${p}`));
});

test('codex provider: covers a thread (its finished turns raise done) only while the daemon is connected and the bridge rejoined it', async (t) => {
  const home = join(root, 'codex-covers');
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  // `joined` is loaded and has a rollout; `embedded` has a rollout the daemon never loaded (a TUI with its own server); `fresh` is loaded with no rollout yet (before its first turn).
  const [joined, embedded, fresh] = ['40', '41', '42'].map((n) => `019a0000-0000-7000-8000-0000000000${n}`) as [string, string, string];
  for (const id of [joined, embedded]) writeFileSync(join(day, `rollout-2026-09-29T09-00-00-${id}.jsonl`), rollout(id, 0, 'low', [['first prompt', 'reply one']]).join(''));
  const { rpc } = fakeRpc('covers', { loaded: [joined, fresh], threads: { [joined]: { status: { type: 'idle' } } } });
  const provider = new CodexProvider({ home, historyDays: 3650, rpc });
  t.after(() => provider.stop());
  assert.equal(provider.covers(joined), false, 'before the daemon is connected');
  let up = ready(rpc);
  await provider.start(recordingHub());
  await up;
  await waitFor(() => provider.covers(joined));
  assert.equal(provider.covers(embedded), false);
  assert.equal(provider.covers(fresh), false, 'loaded but not rejoined');

  up = ready(rpc);
  await assert.rejects(rpc.request('fake/exit'));
  assert.equal(provider.covers(joined), false, 'the connection is lost: a turn finishing now is never heard of');
  await up;
  await waitFor(() => provider.covers(joined));
  await rpc.request('fake/notify', { method: 'thread/closed', params: { threadId: joined } });
  assert.equal(provider.covers(joined), false, 'closed');
});

test('codex provider: a completed turn raises done by the Stop hook rule; an approval nobody was asked about raises needs_input', async (t) => {
  const home = join(root, 'codex-alerts');
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  const [named, other, sub, ask] = ['30', '31', '32', '33'].map((n) => `019a0000-0000-7000-8000-0000000000${n}`) as [string, string, string, string];
  for (const id of [named, other, ask]) writeFileSync(join(day, `rollout-2026-09-29T09-00-00-${id}.jsonl`), rollout(id, 0, 'low', [['first prompt', 'reply one']]).join(''));
  const subLines = rollout(sub, 0, 'low', [['task', 'report']]);
  subLines[0] = `${JSON.stringify({ timestamp: '2026-09-29T09:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: sub, cwd: '/w', source: { subagent: { thread_spawn: { parent_thread_id: named, depth: 1 } } } } })}\n`;
  writeFileSync(join(day, `rollout-2026-09-29T09-00-00-${sub}.jsonl`), subLines.join(''));
  writeFileSync(join(home, 'session_index.jsonl'), `${JSON.stringify({ id: named, thread_name: 'Named thread' })}\n`);
  const idle = { status: { type: 'idle' } };
  const { rpc, log } = fakeRpc('alerts', { loaded: [named, other, sub, ask], threads: { [named]: idle, [other]: idle, [sub]: { ...idle, parentThreadId: named }, [ask]: idle } });
  const provider = new CodexProvider({ home, historyDays: 3650, rpc, isAsk: (id) => id === ask, needsInputDelayMs: 100 });
  const hub = recordingHub();
  t.after(() => provider.stop());
  const up = ready(rpc);
  await provider.start(hub);
  await up;
  await waitFor(() => log().some((m) => m.method === 'thread/resume' && (m.params as { threadId: string }).threadId === named));
  assert.deepEqual(provider.listSessions().map((s) => s.id).sort(), [`codex:${named}`, `codex:${other}`]);

  const notify = (method: string, params: unknown): Promise<unknown> => rpc.request('fake/notify', { method, params });
  const said = async (threadId: string, turnId: string, prompt: string | undefined, answers: string[], status = 'completed'): Promise<void> => {
    if (prompt !== undefined) await notify('item/completed', { threadId, turnId, item: { type: 'userMessage', id: `${turnId}-u`, content: [{ type: 'text', text: prompt }] } });
    for (const [i, text] of answers.entries()) await notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `${turnId}-a${i}`, text } });
    await notify('turn/completed', { threadId, turn: { id: turnId, items: [], status } });
  };
  const long = 'x'.repeat(600);

  // The last answer of the turn, titled by its user message (one line, 60 characters at most).
  await said(named, 't1', 'run the tests\nand tell me what failed', ['Running them now.', '  All 164 tests pass and the build is green.  ']);
  // No user message: the thread's title; the answer is cut to 500 characters.
  await said(named, 't2', undefined, [long]);
  await said(other, 't3', 'a'.repeat(80), [long]);
  // Nothing for a short answer, "No response requested.", a turn that did not complete, a sub-agent or a Quick Ask thread.
  await said(named, 't4', 'hi', ['Done.']);
  await said(named, 't5', 'hi', ['No response requested.']);
  await said(named, 't6', 'hi', [long], 'interrupted');
  await said(sub, 't7', 'task', [long]);
  await said(ask, 't8', 'question', [long]);
  assert.deepEqual(hub.alerts, [
    [`codex:${named}`, 'done', 'All 164 tests pass and the build is green.', 'run the tests and tell me what failed'],
    [`codex:${named}`, 'done', `${'x'.repeat(499)}…`, 'Named thread'],
    [`codex:${other}`, 'done', `${'x'.repeat(499)}…`, `${'a'.repeat(59)}…`],
  ]);

  // Waiting on an approval: the request that follows the status is the notification; without one, needs_input.
  // Each thread's wait starts a timer of the same length, so they fire in the order the waits began:
  // once the last one has alerted, the earlier ones have had their say.
  hub.alerts.length = 0;
  const waiting = { type: 'active', activeFlags: ['waitingOnApproval'] };
  const working = { type: 'active', activeFlags: [] };
  const [, { id: approval }] = (await Promise.all([
    notify('thread/status/changed', { threadId: named, status: waiting }),
    rpc.request('fake/request', { method: 'item/commandExecution/requestApproval', params: { threadId: named, turnId: 't9', itemId: 'i9', command: 'ls' } }),
  ])) as [unknown, { id: number }];
  // A sub-agent that waits shows on its parent, which already has a request open.
  await notify('thread/status/changed', { threadId: sub, status: waiting });
  await notify('thread/status/changed', { threadId: other, status: waiting });
  await waitFor(() => hub.alerts.length > 0);
  assert.deepEqual(hub.alerts, [[`codex:${other}`, 'needs_input', undefined, undefined]]);
  assert.equal(hub.pending.list().length, 1);

  // Answered in the terminal within the delay: no alert. Then, with the parent's request answered,
  // a sub-agent that waits raises needs_input on its parent.
  await notify('serverRequest/resolved', { threadId: named, requestId: approval });
  await waitFor(() => hub.pending.list().length === 0);
  await Promise.all([
    notify('thread/status/changed', { threadId: other, status: working }),
    notify('thread/status/changed', { threadId: other, status: waiting }),
    notify('thread/status/changed', { threadId: other, status: working }),
  ]);
  await notify('thread/status/changed', { threadId: sub, status: working });
  await notify('thread/status/changed', { threadId: sub, status: waiting });
  await waitFor(() => hub.alerts.length > 1);
  assert.deepEqual(hub.alerts.slice(1), [[`codex:${named}`, 'needs_input', undefined, undefined]]);
});
