// Quick Ask through the real server with test/fake-cli.ts standing in for `claude` and `codex`.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ASK_SYSTEM_PROMPT, parseClaude, parseCodex } from '../src/ask.ts';
import type { Ask, ServerEvent } from '../src/protocol.ts';
import { projectSlug } from '../src/providers/claude-code/home.ts';
import { FakeProvider, TestSocket, fakeAskRunner, startBridge, waitFor, type Bridge } from './helpers.ts';

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
    assert.ok(!own.asks.ownsClaudeSession(t1.slice('ask-'.length)));
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
    assert.ok(!own.asks.ownsCodexThread(codexId));
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
      assert.ok(!restarted.ownsCodexThread(codexId));
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
