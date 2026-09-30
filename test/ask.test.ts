// Quick Ask through the real server with test/fake-cli.ts standing in for `claude` and `codex`.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ASK_SYSTEM_PROMPT, parseClaude, parseCodex } from '../src/ask.ts';
import type { Ask, ServerEvent } from '../src/protocol.ts';
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

const post = (body: unknown, token = bridge.token): Promise<Response> =>
  fetch(`${bridge.base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
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
  assert.deepEqual(args, [
    ...['-p', '--output-format', 'json', '--model', 'haiku', '--max-turns', '1', '--no-session-persistence', '--tools', '', '--permission-prompts', 'none', '--strict-mcp-config'],
    ...['--session-id', sessionId, '--append-system-prompt', ASK_SYSTEM_PROMPT, '--safe-mode', '--', 'Reply with the single word OK'],
  ]);
  const [ask] = await asks();
  assert.deepEqual(ask, { id, provider: 'claude-code', question: 'Reply with the single word OK', status: 'done', answer: 'OK', model: 'Haiku 4.5', durationMs: 1389, createdAt: '2026-09-29T10:00:00.000Z' });
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
  assert.deepEqual(args, ['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '-C', cwd, '-m', 'gpt-6-astra', '--', `${ASK_SYSTEM_PROMPT}\n\nReply with the single word OK`]);
  // A model in the request beats the configured one.
  await accepted(await post({ provider: 'codex', text: 'again', model: 'gpt-6-mini' }));
  await askEvent(ws, 'running');
  assert.equal((await askEvent(ws, 'done')).model, 'gpt-6-mini');
  assert.deepEqual(argv().slice(8, 10), ['-m', 'gpt-6-mini']);
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
  for (const body of [{ provider: 'gemini', text: 'x' }, { provider: 'codex', text: '' }, { provider: 'codex', text: '   ' }, { provider: 'codex' }, { provider: 'codex', text: 'x', model: 1 }, 'text']) {
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
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ws.pending(), 0, 'no alert for the ask');
  assert.equal((await cancel(id)).status, 204);
  assert.equal((await askEvent(ws, 'error')).error, 'cancelled');
  fakeEnv.FAKE_MODE = 'ok';
});
