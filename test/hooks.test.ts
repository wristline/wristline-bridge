// Claude Code hook handlers served on the local listener, driven over real HTTP like Claude Code does.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { PendingRequest, ServerEvent, Session } from '../src/protocol.ts';
import { FakeProvider, TestSocket, startBridge, type Bridge } from './helpers.ts';

const SID = '6f1c2d3e-0000-4000-8000-000000000001';
const session: Session = {
  id: `claude-code:${SID}`,
  provider: 'claude-code',
  title: 't',
  cwd: '/w',
  status: 'running',
  lastActivity: '2026-09-29T10:00:00.000Z',
};
const provider = new FakeProvider();
provider.sessions = [session];

// Recorded from Claude Code 2.1.284 (docs/spikes.md).
const bashInput = {
  session_id: SID,
  hook_event_name: 'PermissionRequest',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'touch s1.txt', description: 'Create a new file named s1.txt' },
  permission_suggestions: [
    { type: 'addDirectories', directories: ['/work/spike'], destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ],
};
const askInput = {
  session_id: SID,
  hook_event_name: 'PermissionRequest',
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      {
        question: 'Which color do you prefer?',
        header: 'Color',
        options: [
          { label: 'red', description: 'The color red' },
          { label: 'blue', description: 'The color blue' },
        ],
        multiSelect: false,
      },
      {
        question: 'Which fruits do you like?',
        header: 'Fruit',
        options: [{ label: 'apple' }, { label: 'banana' }, { label: 'cherry' }],
        multiSelect: true,
      },
    ],
  },
};

let absent: Bridge;
let bridge: Bridge;
let quick: Bridge;
let ws: TestSocket;
let quickWs: TestSocket;

before(async () => {
  absent = await startBridge(provider);
  bridge = await startBridge(provider);
  quick = await startBridge(provider, undefined, 100);
  ws = await new TestSocket(`${bridge.base.replace('http', 'ws')}/api/ws`, bridge.token).open();
  quickWs = await new TestSocket(`${quick.base.replace('http', 'ws')}/api/ws`, quick.token).open();
  assert.equal((await ws.next()).type, 'snapshot');
  assert.equal((await quickWs.next()).type, 'snapshot');
});
after(async () => {
  ws.close();
  quickWs.close();
  await Promise.all([absent.close(), bridge.close(), quick.close()]);
});

function hook(b: Bridge, name: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${b.local}/hooks/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${b.hookToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

async function nextOf(socket: TestSocket, type: ServerEvent['type']): Promise<ServerEvent> {
  for (;;) {
    const event = await socket.next();
    if (event.type === type) return event;
  }
}

/** An alert event without its replay `id` and `at` (checked in alerts.test.ts). */
function bare(event: ServerEvent): unknown {
  if (event.type !== 'alert') return event;
  const { id: _id, at: _at, ...rest } = event;
  return rest;
}

async function nextRequest(socket: TestSocket = ws): Promise<PendingRequest> {
  const event = await nextOf(socket, 'request');
  assert.equal(event.type, 'request');
  return event.request;
}

function answer(b: Bridge, id: string, answers: Record<string, string[]>): Promise<Response> {
  return fetch(`${b.base}/api/requests/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${b.token}` },
    body: JSON.stringify({ answers }),
  });
}

async function emptyOk(res: Response): Promise<void> {
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), '0');
  assert.equal(await res.text(), '');
}

test('without a watch the hook answers at once with an empty 200 (terminal dialog as usual)', async () => {
  const started = Date.now();
  await emptyOk(await hook(absent, 'permission-request', bashInput));
  await emptyOk(await hook(absent, 'permission-request', askInput));
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(absent.hub.pending.list(), []);
});

test('hooks need the hook token; unknown hooks are 404', async () => {
  const res = await fetch(`${bridge.local}/hooks/permission-request`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  assert.equal((await hook(bridge, 'session-start', {})).status, 404);
  assert.equal((await hook(bridge, 'constructor', {})).status, 404);
});

test('permission request: published to the watch with allow/always/deny/defer; allow maps to behavior allow', async () => {
  const pending = hook(bridge, 'permission-request', bashInput);
  const request = await nextRequest();
  assert.deepEqual({ ...request, id: undefined }, {
    id: undefined,
    sessionId: session.id,
    kind: 'permission',
    title: 'Bash',
    questions: [
      {
        id: 'decision',
        text: 'touch s1.txt',
        multi: false,
        options: [
          { id: 'allow', label: 'Allow' },
          { id: 'always', label: 'Always allow', description: '/work/spike, mode: acceptEdits' },
          { id: 'deny', label: 'Deny' },
          { id: 'defer', label: 'Answer on PC' },
        ],
      },
    ],
    createdAt: '2026-09-29T10:00:00.000Z',
  });
  const listed = (await (await fetch(`${bridge.base}/api/sessions`, { headers: { authorization: `Bearer ${bridge.token}` } })).json()) as {
    sessions: Session[];
  };
  assert.deepEqual([listed.sessions[0]?.status, listed.sessions[0]?.promptBlock], ['needs_input', 'awaiting_input']);

  assert.equal((await answer(bridge, request.id, { decision: ['allow'] })).status, 200);
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.equal((await answer(bridge, request.id, { decision: ['deny'] })).status, 409, 'a second answer is already_resolved');
});

test('always passes the suggestions back as updatedPermissions; deny carries a message; defer answers empty', async () => {
  const always = hook(bridge, 'permission-request', bashInput);
  await answer(bridge, (await nextRequest()).id, { decision: ['always'] });
  assert.deepEqual(await (await always).json(), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: bashInput.permission_suggestions } },
  });

  const deny = hook(bridge, 'permission-request', bashInput);
  await answer(bridge, (await nextRequest()).id, { decision: ['deny'] });
  assert.deepEqual(await (await deny).json(), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from watch' } },
  });

  const defer = hook(bridge, 'permission-request', bashInput);
  await answer(bridge, (await nextRequest()).id, { decision: ['defer'] });
  await emptyOk(await defer);
});

test('no "always" option without suggestions', async () => {
  const pending = hook(bridge, 'permission-request', { session_id: SID, tool_name: 'Bash', tool_input: { command: 'ls' } });
  const request = await nextRequest();
  assert.deepEqual(request.questions[0]?.options.map((o) => o.id), ['allow', 'deny', 'defer']);
  await answer(bridge, request.id, { decision: ['defer'] });
  await emptyOk(await pending);
});

test('ExitPlanMode: the plan is the text; approving hands the input back, "always" also auto-accepts edits', async () => {
  // Recorded from Claude Code 2.1.286 (no permission_suggestions). A bare allow leaves its dialog up.
  const toolInput = { plan: `# Plan\n${'x'.repeat(5000)}`, planFilePath: '/home/u/.claude/plans/p.md' };
  const plan = { session_id: SID, hook_event_name: 'PermissionRequest', permission_mode: 'plan', tool_name: 'ExitPlanMode', tool_input: toolInput };
  const allow = hook(bridge, 'permission-request', plan);
  const request = await nextRequest();
  const question = request.questions[0];
  assert.deepEqual(question?.options.map((o) => o.id), ['allow', 'always', 'deny', 'defer']);
  assert.equal(question?.options[1]?.description, 'mode: acceptEdits');
  assert.equal(question?.text.length, 4000);
  assert.ok(question?.text.startsWith('# Plan\nxxx'));
  await answer(bridge, request.id, { decision: ['allow'] });
  assert.deepEqual(await (await allow).json(), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: toolInput } },
  });

  const always = hook(bridge, 'permission-request', plan);
  await answer(bridge, (await nextRequest()).id, { decision: ['always'] });
  assert.deepEqual(await (await always).json(), {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: toolInput, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] },
    },
  });
});

test('timeout hands the dialog back to the terminal with an empty 200', async () => {
  const res = hook(quick, 'permission-request', bashInput);
  const request = await nextRequest(quickWs);
  await emptyOk(await res);
  assert.deepEqual(await nextOf(quickWs, 'resolved'), { type: 'resolved', requestId: request.id, by: 'timeout' });
});

test('a dropped hook request is resolved as answered in the terminal', async () => {
  const ctrl = new AbortController();
  const res = hook(bridge, 'permission-request', bashInput, ctrl.signal).catch(() => undefined);
  const request = await nextRequest();
  ctrl.abort();
  await res;
  assert.deepEqual(await nextOf(ws, 'resolved'), { type: 'resolved', requestId: request.id, by: 'terminal' });
  assert.deepEqual(bridge.hub.pending.list(), []);
});

test('AskUserQuestion becomes a question request; answers go back as labels in updatedInput', async () => {
  const pending = hook(bridge, 'permission-request', askInput);
  const request = await nextRequest();
  assert.equal(request.kind, 'question');
  assert.deepEqual(request.questions, [
    {
      id: 'q1',
      header: 'Color',
      text: 'Which color do you prefer?',
      multi: false,
      options: [
        { id: '0', label: 'red', description: 'The color red' },
        { id: '1', label: 'blue', description: 'The color blue' },
      ],
    },
    {
      id: 'q2',
      header: 'Fruit',
      text: 'Which fruits do you like?',
      multi: true,
      options: [
        { id: '0', label: 'apple' },
        { id: '1', label: 'banana' },
        { id: '2', label: 'cherry' },
      ],
    },
  ]);
  assert.equal((await answer(bridge, request.id, { q1: ['1'] })).status, 400, 'every question must be answered');
  assert.equal((await answer(bridge, request.id, { q1: ['1'], q2: ['2', '0'] })).status, 200);
  assert.deepEqual(await (await pending).json(), {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        updatedInput: {
          ...askInput.tool_input,
          answers: { 'Which color do you prefer?': 'blue', 'Which fruits do you like?': 'apple, cherry' },
        },
      },
    },
  });
  assert.equal((await answer(bridge, request.id, { q1: ['0'], q2: ['0'] })).status, 409);
});

test('pre-tool-use answers AskUserQuestion and ignores other tools', async () => {
  await emptyOk(await hook(bridge, 'pre-tool-use', { ...bashInput, hook_event_name: 'PreToolUse' }));
  const pending = hook(bridge, 'pre-tool-use', { ...askInput, hook_event_name: 'PreToolUse' });
  const request = await nextRequest();
  await answer(bridge, request.id, { q1: ['0'], q2: ['1'] });
  assert.deepEqual(await (await pending).json(), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...askInput.tool_input, answers: { 'Which color do you prefer?': 'red', 'Which fruits do you like?': 'banana' } },
    },
  });
});

test('notification: needs_input alert only when no request is open', async () => {
  const notify = { session_id: SID, hook_event_name: 'Notification', message: 'Claude needs your permission', notification_type: 'permission_prompt' };
  await emptyOk(await hook(bridge, 'notification', notify));
  assert.deepEqual(bare(await nextOf(ws, 'alert')), { type: 'alert', sessionId: session.id, alert: 'needs_input', text: 'Claude needs your permission' });

  await emptyOk(await hook(bridge, 'notification', { ...notify, notification_type: 'idle_prompt' }));
  const open = hook(bridge, 'permission-request', bashInput);
  const request = await nextRequest();
  await emptyOk(await hook(bridge, 'notification', notify));
  await answer(bridge, request.id, { decision: ['allow'] });
  await open;
  await emptyOk(await hook(bridge, 'stop', { session_id: SID, hook_event_name: 'Stop', last_assistant_message: 'The build is green again, all tests pass.' }));
  const done = await nextOf(ws, 'alert');
  assert.equal(done.type === 'alert' && done.alert, 'done', 'the ignored notifications produced no alert');
});

test('stop: no alert for an empty, short or "No response requested." answer', async () => {
  const stop = (last: unknown): Promise<Response> => hook(bridge, 'stop', { session_id: SID, hook_event_name: 'Stop', last_assistant_message: last });
  for (const last of [undefined, '', '   \n\t ', 'a'.repeat(19), 'Done.', '가'.repeat(7), '完了しました', 'No response requested.', ' no response requested \n', 'NO RESPONSE REQUESTED.']) {
    await emptyOk(await stop(last));
  }
  // Hangul, Han or Kana say as much in fewer characters: 8 suffice.
  for (const text of ['빌드 다 통과했어요', '測試已經全部通過', 'テストは全部通った']) {
    await emptyOk(await stop(text));
    assert.deepEqual(bare(await nextOf(ws, 'alert')), { type: 'alert', sessionId: session.id, alert: 'done', text, title: 't' });
  }
  await emptyOk(await stop('No response requested. Pushed the fix anyway.'));
  assert.equal((await nextOf(ws, 'alert')).type === 'alert' && ws.pending(), 0);
});

test('stop: up to 500 characters of the answer, titled by the human prompt or else the session title', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wristline-hooks-'));
  const write = (lines: unknown[]): string => {
    const path = join(dir, `${Math.random()}.jsonl`);
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return path;
  };
  const answer = `Done.\n\n${'y'.repeat(600)}`;
  const stop = (transcript_path?: string): Promise<Response> =>
    hook(bridge, 'stop', { session_id: SID, hook_event_name: 'Stop', last_assistant_message: answer, ...(transcript_path ? { transcript_path } : {}) });

  await emptyOk(await stop());
  let done = await nextOf(ws, 'alert');
  assert.deepEqual(bare(done), { type: 'alert', sessionId: session.id, alert: 'done', text: `${'Done.\n\n' + 'y'.repeat(492)}…`, title: 't' });

  const humanPrompt = `Please fix the build.\n<system-reminder>\nINTERNAL\n</system-reminder>\nAnd then ${'z'.repeat(80)}`;
  await emptyOk(await stop(write([{ type: 'user', message: { role: 'user', content: humanPrompt }, promptId: 'p1', origin: { kind: 'human' } }, { type: 'assistant' }])));
  done = await nextOf(ws, 'alert');
  assert.equal(done.type === 'alert' && done.title, `Please fix the build. And then ${'z'.repeat(28)}…`);

  const notification = { type: 'user', message: { role: 'user', content: '<task-notification>x</task-notification>' }, promptId: 'p2', origin: { kind: 'task-notification' } };
  await emptyOk(await stop(write([{ type: 'user', message: { role: 'user', content: 'hi' }, promptId: 'p1', origin: { kind: 'human' } }, notification, { type: 'assistant' }])));
  done = await nextOf(ws, 'alert');
  assert.equal(done.type === 'alert' && done.title, 't', 'not a human turn: the session title');

  await emptyOk(await stop(write([{ type: 'user', message: { role: 'user', content: [{ type: 'image' }] }, promptId: 'p1', origin: { kind: 'human' } }])));
  done = await nextOf(ws, 'alert');
  assert.equal(done.type === 'alert' && done.title, 't', 'an empty prompt falls back to the session title');

  await emptyOk(await hook(bridge, 'stop', { session_id: 'unknown-session', hook_event_name: 'Stop', last_assistant_message: answer, transcript_path: join(dir, 'missing.jsonl') }));
  done = await nextOf(ws, 'alert');
  assert.deepEqual(bare(done), { type: 'alert', sessionId: 'claude-code:unknown-session', alert: 'done', text: `${'Done.\n\n' + 'y'.repeat(492)}…` }, 'no title without a session or prompt');
});
