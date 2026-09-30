// Quick Ask through the real server with test/fake-cli.ts standing in for `claude` and `codex`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { ASK_SYSTEM_PROMPT, parseClaude, parseCodex, type AskSpawn } from '../src/ask.ts';
import type { Ask, ServerEvent } from '../src/protocol.ts';
import { projectSlug } from '../src/providers/claude-code/home.ts';
import { FAKE_CLI, FakeProvider, TestSocket, fakeAskRunner, startBridge, waitFor, type Bridge } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'wristline-ask-test-'));
const argvFile = join(root, 'argv.json');
const pidFile = join(root, 'pid');
const fakeEnv: Record<string, string> = { FAKE_MODE: 'ok', FAKE_ARGV_FILE: argvFile, FAKE_PID_FILE: pidFile };
let bridge: Bridge;
let ws: TestSocket;
let clock = Date.parse('2026-09-29T10:00:00Z');

before(async () => {
  bridge = await startBridge(new FakeProvider(), undefined, undefined, undefined, (onEvent) => fakeAskRunner(onEvent, fakeEnv, { timeoutMs: 1500, now: () => clock }));
  ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
  assert.equal((await ws.next()).type, 'snapshot');
});
after(async () => {
  ws.close();
  await bridge.close();
  rmSync(root, { recursive: true, force: true });
});

const post = (body: unknown, token = bridge.token, base = bridge.base): Promise<Response> =>
  fetch(`${base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const deleteThread = (id: string, token = bridge.token, base = bridge.base): Promise<Response> =>
  fetch(`${base}/api/asks/thread/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
const asks = async (token = bridge.token): Promise<Ask[]> =>
  ((await (await fetch(`${bridge.base}/api/asks`, { headers: { authorization: `Bearer ${token}` } })).json()) as { asks: Ask[] }).asks;
const cancel = (id: string, token = bridge.token): Promise<Response> => fetch(`${bridge.base}/api/asks/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
const argv = (): string[] => JSON.parse(readFileSync(argvFile, 'utf8')) as string[];

async function askEvent(socket: TestSocket, status: string): Promise<ServerEvent & { type: 'ask' }> {
  const event = await socket.next();
  assert.equal(event.type, 'ask');
  assert.equal(event.type === 'ask' && event.status, status);
  return event as ServerEvent & { type: 'ask' };
}

async function accepted(res: Response): Promise<string> {
  assert.equal(res.status, 202);
  return ((await res.json()) as { askId: string }).askId;
}

test('Claude: the verified argv, then running and done events with the answer, model and duration', async () => {
  fakeEnv.FAKE_MODE = 'ok';
  const id = await accepted(await post({ provider: 'claude-code', text: 'Reply with the single word OK' }));
  assert.match(id, /^ask-[0-9a-f-]{36}$/);
  assert.deepEqual(await askEvent(ws, 'running'), { type: 'ask', askId: id, provider: 'claude-code', status: 'running' });
  const done = await askEvent(ws, 'done');
  assert.deepEqual(done, { type: 'ask', askId: id, provider: 'claude-code', status: 'done', text: 'OK', model: 'Haiku 4.5', durationMs: 1389 });
  const args = argv();
  const sessionId = args[args.indexOf('--session-id') + 1] ?? '';
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(sessionId, id.slice('ask-'.length), 'the session id is the thread id’s uuid');
  assert.deepEqual(args, [
    ...['-p', '--output-format', 'json', '--model', 'haiku', '--max-turns', '1', '--tools', '', '--permission-prompts', 'none', '--strict-mcp-config'],
    ...['--session-id', sessionId, '--append-system-prompt', ASK_SYSTEM_PROMPT, '--safe-mode', '--', 'Reply with the single word OK'],
  ]);
  const [ask] = await asks();
  assert.deepEqual(ask, { id, provider: 'claude-code', threadId: id, question: 'Reply with the single word OK', status: 'done', answer: 'OK', model: 'Haiku 4.5', durationMs: 1389, createdAt: '2026-09-29T10:00:00.000Z' });

  // A follow-up in the thread resumes that session; both asks carry the thread id.
  const followUp = await accepted(await post({ provider: 'claude-code', text: 'And in French?', threadId: id }));
  await askEvent(ws, 'running');
  await askEvent(ws, 'done');
  const resumed = argv();
  assert.deepEqual(resumed.slice(12, 14), ['--resume', sessionId]);
  assert.ok(!resumed.includes('--session-id') && !resumed.includes('--no-session-persistence'));
  assert.deepEqual(
    (await asks()).map((a) => [a.id, a.threadId]),
    [
      [followUp, id],
      [id, id],
    ],
  );
  assert.ok(bridge.asks.ownsClaudeSession(sessionId));

  // A thread is this device's: unknown, foreign or expired ids are 404; another provider's thread is a bad request.
  assert.equal((await post({ provider: 'claude-code', text: 'x', threadId: 'ask-unknown' })).status, 404);
  assert.equal((await post({ provider: 'codex', text: 'x', threadId: id })).status, 400);
  assert.equal((await post({ provider: 'claude-code', text: 'x', threadId: 7 })).status, 400);
  const other = await bridge.auth.issue('other watch');
  assert.equal((await post({ provider: 'claude-code', text: 'x', threadId: id }, other.token)).status, 404);
  assert.equal((await deleteThread(id, other.token)).status, 404);
});

test('Codex: the last agent_message is the answer, the system prompt heads the prompt, the model is the configured one', async () => {
  const id = await accepted(await post({ provider: 'codex', text: '  Reply with the single word OK ' }));
  await askEvent(ws, 'running');
  const done = await askEvent(ws, 'done');
  assert.equal(typeof done.durationMs, 'number');
  assert.deepEqual(done, { type: 'ask', askId: id, provider: 'codex', status: 'done', text: 'OK', model: 'gpt-6-astra', durationMs: done.durationMs });
  const args = argv();
  const cwd = args[args.indexOf('-C') + 1] ?? '';
  assert.match(cwd, /ask-cwd$/);
  assert.deepEqual(args, ['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '-C', cwd, '-m', 'gpt-6-astra', '--', `${ASK_SYSTEM_PROMPT}\n\nReply with the single word OK`]);
  // A model in the request beats the configured one.
  await accepted(await post({ provider: 'codex', text: 'again', model: 'gpt-6-mini' }));
  await askEvent(ws, 'running');
  assert.equal((await askEvent(ws, 'done')).model, 'gpt-6-mini');
  assert.deepEqual(argv().slice(7, 9), ['-m', 'gpt-6-mini']);

  // The thread id printed by `thread.started` names the Codex session; a follow-up resumes it (`exec resume` takes no -s/-C).
  const codexId = '01a0f1f1-b81c-72c0-b5d8-3ac445edb941';
  assert.ok(bridge.asks.ownsCodexThread(codexId));
  assert.ok(!bridge.asks.ownsCodexThread('someone-else'));
  await accepted(await post({ provider: 'codex', text: 'more', threadId: id }));
  await askEvent(ws, 'running');
  await askEvent(ws, 'done');
  assert.deepEqual(argv(), ['exec', 'resume', codexId, '--json', '-c', 'sandbox_mode="read-only"', '--skip-git-repo-check', '-m', 'gpt-6-astra', '--', `${ASK_SYSTEM_PROMPT}\n\nmore`]);
});

test('threads expire 24 h after their last ask or on DELETE: the CLI session files go, other files stay, and the registry survives a restart', async () => {
  const dir = mkdtempSync(join(root, 'threads-'));
  const [claudeHome, codexHome] = [join(dir, 'claude'), join(dir, 'codex')];
  const env = { ...fakeEnv, FAKE_MODE: 'ok' };
  let now = Date.parse('2026-09-29T10:00:00Z');
  const own = await startBridge(new FakeProvider(), () => now, undefined, undefined, (onEvent) => fakeAskRunner(onEvent, env, { dir, claudeHome, codexHome, now: () => now }));
  const socket = await new TestSocket(`${own.base.replace('http', 'ws')}/api/ws`, own.token).open();
  await socket.next();
  const project = join(claudeHome, 'projects', projectSlug(join(dir, 'ask-cwd')));
  const day = join(codexHome, 'sessions', '2026', '09', '29');
  const codexId = '01a0f1f1-b81c-72c0-b5d8-3ac445edb941';
  const otherCodex = '019a0000-0000-7000-8000-000000000009';
  mkdirSync(project, { recursive: true });
  mkdirSync(day, { recursive: true });
  writeFileSync(join(project, 'other.jsonl'), '');
  const ask = async (provider: string, text: string, threadId?: string): Promise<string> => {
    const id = await accepted(await post({ provider, text, ...(threadId ? { threadId } : {}) }, own.token, own.base));
    await askEvent(socket, 'running');
    await askEvent(socket, 'done');
    return id;
  };
  /** What the real CLIs leave behind for a thread. */
  const plant = (threadId: string): { transcript: string; agents: string; rollout: string } => {
    const uuid = threadId.slice('ask-'.length);
    const transcript = join(project, `${uuid}.jsonl`);
    const agents = join(project, uuid, 'subagents');
    writeFileSync(transcript, '{}\n');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'agent-1.jsonl'), '');
    const rollout = join(day, `rollout-2026-09-29T10-00-00-${codexId}.jsonl`);
    writeFileSync(rollout, '');
    writeFileSync(join(codexHome, 'session_index.jsonl'), `${JSON.stringify({ id: otherCodex, thread_name: 'keep' })}\n${JSON.stringify({ id: codexId, thread_name: 'ask' })}\n`);
    return { transcript, agents, rollout };
  };
  try {
    // Expiry: a day after the last ask the sweep deletes the transcript and its sub-agent directory.
    const t1 = await ask('claude-code', 'first');
    now += 60_000;
    await ask('claude-code', 'follow-up', t1);
    const first = plant(t1);
    now += 24 * 60 * 60_000;
    own.asks.sweep();
    assert.ok(existsSync(first.transcript), 'not yet: the last ask is a minute younger');
    now += 60_000 + 1;
    own.asks.sweep();
    await waitFor(() => (existsSync(first.transcript) ? undefined : true));
    assert.ok(!existsSync(join(project, t1.slice('ask-'.length))), 'the sub-agent directory is gone too');
    assert.ok(existsSync(join(project, 'other.jsonl')), 'a transcript of another session stays');
    await waitFor(() => (own.asks.ownsClaudeSession(t1.slice('ask-'.length)) ? undefined : true));
    assert.equal((await post({ provider: 'claude-code', text: 'x', threadId: t1 }, own.token, own.base)).status, 404, 'an expired thread cannot be continued');

    // DELETE: the same at once; a running ask is cancelled first and the files go once it exited.
    env.FAKE_MODE = 'sleep';
    const t2 = await accepted(await post({ provider: 'claude-code', text: 'slow' }, own.token, own.base));
    await askEvent(socket, 'running');
    const second = plant(t2);
    assert.equal((await deleteThread(t2, own.token, own.base)).status, 204);
    assert.equal((await askEvent(socket, 'error')).error, 'cancelled');
    await waitFor(() => (existsSync(second.transcript) ? undefined : true));
    assert.ok(!existsSync(second.agents));
    assert.equal((await deleteThread(t2, own.token, own.base)).status, 404);
    env.FAKE_MODE = 'ok';

    // Codex: `codex delete --force <thread id>` in the Codex home, when the CLI is there.
    const t3 = await ask('codex', 'codex first');
    const third = plant(t3);
    assert.equal((await deleteThread(t3, own.token, own.base)).status, 204);
    await waitFor(() => (readFileSync(argvFile, 'utf8') === JSON.stringify(['delete', '--force', codexId]) ? true : undefined));
    assert.ok(existsSync(third.rollout), 'the fake CLI deletes nothing; the real one removes the rollout and index line');

    // Deleted while its first ask still runs, before the CLI printed the thread id: the id printed on the way out is still purged.
    env.FAKE_MODE = 'late';
    writeFileSync(pidFile, '');
    const t5 = await accepted(await post({ provider: 'codex', text: 'slow start' }, own.token, own.base));
    await askEvent(socket, 'running');
    await waitFor(() => (readFileSync(pidFile, 'utf8') ? true : undefined));
    assert.ok(!own.asks.ownsCodexThread(codexId), 'the thread id is not known yet');
    writeFileSync(argvFile, '[]');
    assert.equal((await deleteThread(t5, own.token, own.base)).status, 204);
    assert.equal((await askEvent(socket, 'error')).error, 'cancelled');
    await waitFor(() => (readFileSync(argvFile, 'utf8') === JSON.stringify(['delete', '--force', codexId]) ? true : undefined));
    await waitFor(() => (own.asks.ownsCodexThread(codexId) ? undefined : true));
    env.FAKE_MODE = 'ok';

    // The registry is on disk: a runner started later (here one without the Codex CLI) still owns the thread and deletes its files by hand.
    const t4 = await ask('codex', 'codex again');
    plant(t4);
    const restarted = fakeAskRunner(() => {}, env, { dir, claudeHome, codexHome, bins: { claude: 'claude' }, now: () => now });
    try {
      assert.ok(restarted.ownsCodexThread(codexId));
      assert.ok(restarted.deleteThread(own.auth.authenticate(own.token)?.id ?? '', t4));
      await waitFor(() => (existsSync(third.rollout) ? undefined : true));
      assert.equal(readFileSync(join(codexHome, 'session_index.jsonl'), 'utf8'), `${JSON.stringify({ id: otherCodex, thread_name: 'keep' })}\n`);
      await waitFor(() => (restarted.ownsCodexThread(codexId) ? undefined : true));
    } finally {
      restarted.close();
    }
  } finally {
    socket.close();
    await own.close();
  }
});

test('one running ask per device: a second POST is 409 busy, another device may ask; cancel kills the child', async () => {
  fakeEnv.FAKE_MODE = 'sleep';
  const id = await accepted(await post({ provider: 'claude-code', text: 'slow' }));
  await askEvent(ws, 'running');
  const busy = await post({ provider: 'claude-code', text: 'another' });
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { error: 'busy' });
  const pid = Number(await waitFor(() => (readFileSync(pidFile, 'utf8') ? readFileSync(pidFile, 'utf8') : undefined)));

  const other = await bridge.auth.issue('other watch');
  const otherWs = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, other.token).open();
  await otherWs.next();
  const otherId = await accepted(await post({ provider: 'codex', text: 'slow too' }, other.token));
  await askEvent(otherWs, 'running');
  assert.equal(ws.pending(), 0, 'the other device’s ask is not sent here');

  assert.equal((await cancel(id)).status, 204);
  const cancelled = await askEvent(ws, 'error');
  assert.equal(cancelled.error, 'cancelled');
  assert.equal(typeof cancelled.durationMs, 'number');
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch {
      return true;
    }
  });
  assert.equal((await cancel(id)).status, 204, 'cancelling a finished ask is a no-op');
  assert.equal((await cancel('ask-unknown')).status, 404);
  assert.equal((await cancel(otherId)).status, 404, 'another device’s ask is unknown here');
  assert.equal((await cancel(otherId, other.token)).status, 204);
  assert.equal((await askEvent(otherWs, 'error')).error, 'cancelled');
  otherWs.close();
  assert.deepEqual((await asks()).map((a) => [a.status, a.error]).slice(0, 1), [['error', 'cancelled']]);

  // A Claude thread whose first ask failed starts over under a fresh session id: Claude Code refuses
  // `--session-id` of a transcript the failed run may have written.
  fakeEnv.FAKE_MODE = 'ok';
  const oldSession = argv()[argv().indexOf('--session-id') + 1] ?? '';
  const followUp = await accepted(await post({ provider: 'claude-code', text: 'again', threadId: id }));
  await askEvent(ws, 'running');
  await askEvent(ws, 'done');
  const args = argv();
  const fresh = args[args.indexOf('--session-id') + 1] ?? '';
  assert.match(fresh, /^[0-9a-f-]{36}$/);
  assert.notEqual(fresh, oldSession);
  assert.ok(!args.includes('--resume'));
  assert.ok(bridge.asks.ownsClaudeSession(fresh) && !bridge.asks.ownsClaudeSession(oldSession));
  assert.equal((await asks()).find((a) => a.id === followUp)?.threadId, id);
  // Answered, the thread resumes that session from then on.
  await accepted(await post({ provider: 'claude-code', text: 'more', threadId: id }));
  await askEvent(ws, 'running');
  await askEvent(ws, 'done');
  assert.deepEqual(argv().slice(12, 14), ['--resume', fresh]);
});

test('timeout ends the ask with error timeout', async () => {
  fakeEnv.FAKE_MODE = 'sleep';
  await accepted(await post({ provider: 'claude-code', text: 'never' }));
  await askEvent(ws, 'running');
  const event = await askEvent(ws, 'error');
  assert.equal(event.error, 'timeout');
});

test('validation: provider, text, size, missing CLI', async () => {
  fakeEnv.FAKE_MODE = 'ok';
  for (const body of [{ provider: 'gemini', text: 'x' }, { provider: 'codex', text: '' }, { provider: 'codex', text: '   ' }, { provider: 'codex' }, { provider: 'codex', text: 'x', model: 1 }, { provider: 'codex', text: 'x', threadId: '' }, 'text']) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  // The CLI cannot take an argument with a NUL byte: refused before anything is started or saved.
  const before = await asks();
  for (const body of [{ provider: 'claude-code', text: 'a\u0000b' }, { provider: 'codex', text: 'x', model: 'gpt\u0000' }]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(await asks(), before);
  assert.equal(ws.pending(), 0);
  assert.equal((await post({ provider: 'codex', text: 'x'.repeat(4001) })).status, 413);
  // Without a provider the bridge's configured default (claude-code) answers.
  await accepted(await post({ text: 'default provider' }));
  assert.equal((await askEvent(ws, 'running')).provider, 'claude-code');
  await askEvent(ws, 'done');

  const events: [string, ServerEvent][] = [];
  const without = fakeAskRunner((d, e) => events.push([d, e]), fakeEnv, { bins: {} });
  assert.equal(without.start('dev', { provider: 'claude-code', text: 'x' }), 'unavailable');
  assert.equal(without.start('dev', { provider: 'codex', text: 'x' }), 'unavailable');
  assert.deepEqual(events, []);
  const res = await startBridge(new FakeProvider(), undefined, undefined, undefined, () => without);
  const own = await fetch(`${res.base}/api/ask`, { method: 'POST', headers: { authorization: `Bearer ${res.token}` }, body: JSON.stringify({ provider: 'claude-code', text: 'x' }) });
  assert.equal(own.status, 503);
  assert.deepEqual(await own.json(), { error: 'ask_unavailable' });
  await res.close();
});

test('output parsing: a failed run reports the CLI’s reason, unreadable output is bad_output', async () => {
  fakeEnv.FAKE_MODE = 'fail';
  await accepted(await post({ provider: 'claude-code', text: 'x' }));
  await askEvent(ws, 'running');
  assert.equal((await askEvent(ws, 'error')).error, 'error_during_execution');
  await accepted(await post({ provider: 'codex', text: 'x' }));
  await askEvent(ws, 'running');
  assert.equal((await askEvent(ws, 'error')).error, 'stream disconnected before completion');
  fakeEnv.FAKE_MODE = 'garbage';
  for (const provider of ['claude-code', 'codex']) {
    await accepted(await post({ provider, text: 'x' }));
    await askEvent(ws, 'running');
    assert.equal((await askEvent(ws, 'error')).error, 'bad_output');
  }
  fakeEnv.FAKE_MODE = 'ok';

  assert.deepEqual(parseClaude(''), { error: 'bad_output' });
  assert.deepEqual(parseClaude('{"type":"system"}'), { error: 'bad_output' });
  assert.deepEqual(parseClaude('{"type":"result","subtype":"error_max_turns","is_error":true,"result":"","duration_ms":5}'), { durationMs: 5, error: 'error_max_turns' });
  assert.deepEqual(parseClaude('{"type":"result","subtype":"success","is_error":true,"result":"Rate limited\\nmore"}'), { error: 'Rate limited' });
  assert.deepEqual(parseClaude('{"type":"result","subtype":"success","is_error":false,"result":" hi \\n","duration_ms":7,"modelUsage":{"claude-x-1":{}}}'), { durationMs: 7, answer: 'hi', model: 'x-1' });
  assert.deepEqual(parseCodex('{"type":"error","message":"boom"}\n'), { error: 'boom' });
  assert.deepEqual(parseCodex('not json\n{"type":"item.completed","item":{"type":"agent_message","text":"a"}}\n{"type":"turn.completed"}'), { answer: 'a' });
});

test('GET /api/asks keeps the newest 10 of this device from the last 24 h, newest first', async () => {
  const device = await bridge.auth.issue('busy watch');
  const socket = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, device.token).open();
  await socket.next();
  const ids: string[] = [];
  const ask = async (text: string): Promise<void> => {
    ids.push(await accepted(await post({ provider: 'codex', text }, device.token)));
    await askEvent(socket, 'running');
    await askEvent(socket, 'done');
  };
  for (let i = 0; i < 11; i++) await ask(`q${i}`);
  const list = await asks(device.token);
  assert.equal(list.length, 10);
  assert.deepEqual(
    list.map((a) => a.id),
    ids.slice(1).reverse(),
  );
  assert.ok(!(await asks()).some((a) => a.question === 'q0'), 'lists are per device');

  const start = clock;
  clock = start + 23 * 60 * 60_000;
  assert.equal((await asks(device.token)).length, 10, 'still there before a day has passed');
  clock = start + 24 * 60 * 60_000 + 1;
  assert.deepEqual(await asks(device.token), [], 'a day later they are gone');
  await ask('q11');
  assert.deepEqual(
    (await asks(device.token)).map((a) => a.id),
    [ids[11]],
    'a new ask does not bring the old ones back',
  );
  socket.close();
  clock = start;
});

test('Claude Code hooks of an ask’s session id never reach the watch', async () => {
  fakeEnv.FAKE_MODE = 'sleep';
  const id = await accepted(await post({ provider: 'claude-code', text: 'x' }));
  await askEvent(ws, 'running');
  await waitFor(() => (readFileSync(argvFile, 'utf8').includes('--session-id') ? true : undefined));
  const args = argv();
  const sessionId = args[args.indexOf('--session-id') + 1] ?? '';
  assert.ok(bridge.asks.ownsClaudeSession(sessionId));
  assert.ok(!bridge.asks.ownsClaudeSession('someone-else'));
  const hook = (name: string, body: unknown): Promise<Response> =>
    fetch(`${bridge.local}/hooks/${name}`, { method: 'POST', headers: { authorization: `Bearer ${bridge.hookToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await hook('stop', { session_id: sessionId, last_assistant_message: 'A long enough answer to raise a done alert.' })).status, 200);
  assert.equal((await hook('notification', { session_id: sessionId, notification_type: 'permission_prompt', message: 'needs you' })).status, 200);
  const permission = await hook('permission-request', { session_id: sessionId, tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(permission.status, 200);
  assert.equal(await permission.text(), '', 'no decision: the request is not opened on the watch');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ws.pending(), 0, 'no alert or request for the ask');
  assert.deepEqual(bridge.hub.pending.list(), []);
  assert.equal((await cancel(id)).status, 204);
  assert.equal((await askEvent(ws, 'error')).error, 'cancelled');
  fakeEnv.FAKE_MODE = 'ok';
});

/** The fake CLI behind a spawn that first shows the test what the runner passed. */
function watchedSpawn(fakeEnv: Record<string, string>, seen: (bin: string, args: string[], options: Parameters<AskSpawn>[2]) => void): AskSpawn {
  return (bin, args, o) => {
    seen(bin, args, o);
    return spawn(process.execPath, [FAKE_CLI, bin, ...args], { cwd: o.cwd, env: { ...o.env, ...fakeEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  };
}

test('Claude Code runs without CLAUDE_CONFIG_DIR in the default home, so its login stays in ~/.claude.json; a custom home is passed on', async () => {
  const home = mkdtempSync(join(root, 'home-'));
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, 'inherited'); // The bridge's own environment must not leak into the default home's asks either.
  try {
    for (const [claudeHome, expected] of [
      [join(home, '.claude'), undefined],
      [join(home, '.claude-school'), join(home, '.claude-school')],
    ] as const) {
      const seen: (string | undefined)[] = [];
      const statuses: string[] = [];
      const env = { FAKE_MODE: 'ok' };
      const runner = fakeAskRunner((_, e) => e.type === 'ask' && statuses.push(e.status), env, {
        dir: mkdtempSync(join(root, 'cfg-')),
        claudeHome,
        spawn: watchedSpawn(env, (_bin, _args, o) => seen.push(o.env.CLAUDE_CONFIG_DIR)),
      });
      try {
        assert.equal(typeof runner.start('dev', { provider: 'claude-code', text: 'x' }), 'object');
        await waitFor(() => (statuses.includes('done') ? true : undefined));
        assert.deepEqual(seen, [expected], claudeHome);
      } finally {
        runner.close();
      }
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('a config dir behind a symlink: the scratch cwd is resolved once, for the spawn, Codex -C, the purge and the providers', async () => {
  const real = mkdtempSync(join(root, 'real-'));
  const link = join(root, `link-${basename(real)}`);
  symlinkSync(real, link);
  const claudeHome = join(real, 'claude');
  const cwd = join(realpathSync(real), 'wristline', 'ask-cwd');
  const cwds: string[] = [];
  const argvs: string[][] = [];
  const done: string[] = [];
  const env = { FAKE_MODE: 'ok' };
  const runner = fakeAskRunner((_, e) => e.type === 'ask' && e.status === 'done' && done.push(e.askId), env, {
    dir: join(link, 'wristline'),
    claudeHome,
    spawn: watchedSpawn(env, (_bin, args, o) => {
      cwds.push(o.cwd);
      argvs.push(args);
    }),
  });
  try {
    assert.equal(runner.cwd, cwd);
    const claude = runner.start('dev', { provider: 'claude-code', text: 'x' });
    assert.ok(typeof claude === 'object');
    await waitFor(() => (done.length === 1 ? true : undefined));
    runner.start('dev', { provider: 'codex', text: 'x' });
    await waitFor(() => (done.length === 2 ? true : undefined));
    assert.deepEqual(cwds, [cwd, cwd]);
    const codexArgs = argvs[1] ?? [];
    assert.equal(codexArgs[codexArgs.indexOf('-C') + 1], cwd, 'Codex records -C as given: the real path, as the provider compares');
    // Claude Code files the transcript under the real path; that is the one the purge deletes.
    const transcript = join(claudeHome, 'projects', projectSlug(cwd), `${claude.id.slice('ask-'.length)}.jsonl`);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, '{}\n');
    assert.ok(runner.deleteThread('dev', claude.id));
    await waitFor(() => (existsSync(transcript) ? undefined : true));
  } finally {
    runner.close();
  }
});

test('deleting a thread drops its asks from the list; a running one stays unlisted and busy until its CLI exits; the session stays owned until its files are gone', async () => {
  const env = { FAKE_MODE: 'ok' };
  const events: (ServerEvent & { type: 'ask' })[] = [];
  const runner = fakeAskRunner((_, e) => e.type === 'ask' && events.push(e), env, { dir: mkdtempSync(join(root, 'forget-')) });
  const ended = (n: number): Promise<boolean> => waitFor(() => (events.filter((e) => e.status !== 'running').length >= n ? true : undefined));
  const start = (text: string, threadId?: string): Ask => {
    const ask = runner.start('dev', { provider: 'claude-code', text, ...(threadId ? { threadId } : {}) });
    assert.ok(typeof ask === 'object', String(ask));
    return ask;
  };
  try {
    const first = start('first');
    await ended(1);
    const followUp = start('follow-up', first.id);
    await ended(2);
    const kept = start('another thread');
    await ended(3);
    assert.equal(runner.list('dev').length, 3);
    const session = first.id.slice('ask-'.length);
    assert.ok(runner.deleteThread('dev', first.id));
    assert.deepEqual(
      runner.list('dev').map((a) => a.id),
      [kept.id],
      'the thread’s asks go with it; GET /api/asks would otherwise bring the conversation back',
    );
    assert.equal(runner.cancel('dev', followUp.id), false);
    assert.ok(runner.ownsClaudeSession(session), 'owned while its files are being deleted: a refresh then must not list it');
    await waitFor(() => (runner.ownsClaudeSession(session) ? undefined : true));

    env.FAKE_MODE = 'sleep';
    const slow = start('slow');
    const slowSession = slow.id.slice('ask-'.length);
    assert.ok(runner.deleteThread('dev', slow.id));
    assert.deepEqual(
      runner.list('dev').map((a) => a.id),
      [kept.id],
    );
    assert.equal(runner.start('dev', { provider: 'claude-code', text: 'x' }), 'busy', 'its CLI has not exited yet');
    assert.ok(runner.ownsClaudeSession(slowSession));
    await ended(4);
    assert.equal(events.at(-1)?.error, 'cancelled');
    await waitFor(() => (runner.ownsClaudeSession(slowSession) ? undefined : true));
    assert.deepEqual(
      runner.list('dev').map((a) => a.id),
      [kept.id],
    );
    env.FAKE_MODE = 'ok';
    start('next');
    await ended(5);
  } finally {
    runner.close();
  }
});

test('a question spawn refuses (a NUL byte) ends the ask as an error instead of leaving it running, and is not logged', async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logged.push(args.map(String).join(' ')));
  const events: (ServerEvent & { type: 'ask' })[] = [];
  const runner = fakeAskRunner((_, e) => e.type === 'ask' && events.push(e), { FAKE_MODE: 'ok' }, { dir: mkdtempSync(join(root, 'nul-')) });
  try {
    for (const body of [
      { provider: 'claude-code', text: 'SECRET\u0000question' },
      { provider: 'codex', text: 'x', model: 'SECRET\u0000model' },
    ] as const) {
      events.length = 0;
      const ask = runner.start('dev', body);
      assert.ok(typeof ask === 'object');
      await waitFor(() => (events.length === 2 ? true : undefined));
      assert.deepEqual(
        events.map((e) => [e.askId, e.status, e.error]),
        [
          [ask.id, 'running', undefined],
          [ask.id, 'error', 'err_invalid_arg_value'],
        ],
        body.provider,
      );
      assert.equal(runner.list('dev')[0]?.status, 'error');
    }
    assert.ok(logged.length > 0 && !logged.some((line) => line.includes('SECRET')), logged.join('\n'));
    // Nothing is left running: the device can ask again.
    assert.equal(typeof runner.start('dev', { provider: 'claude-code', text: 'x' }), 'object');
    await waitFor(() => (events.at(-1)?.status === 'done' ? true : undefined));
  } finally {
    runner.close();
  }
});
