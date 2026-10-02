import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ItemLog } from '../src/jsonl.ts';
import { TEXT_MAX } from '../src/protocol.ts';
import {
  ClaudeMetaScan,
  claudeModelName,
  classifyUserText,
  parseClaudeLine,
  sessionTitle,
  statuslineModel,
  statuslineUsage,
  statuslineContext,
  toolText,
} from '../src/providers/claude-code/parse.ts';

const lines = readFileSync(new URL('./fixtures/claude/transcript.jsonl', import.meta.url), 'utf8').trimEnd().split('\n');

function parseAll(input: string[]): ItemLog {
  const log = new ItemLog();
  for (const line of input) parseClaudeLine(line, log);
  return log;
}

test('turns transcript blocks into items and skips meta, sidechain, thinking and command output', () => {
  const { items } = parseAll(lines).page(undefined, 100);
  assert.deepEqual(
    items.map((i) => [i.seq, i.kind, i.text]),
    [
      [1, 'user', '/model opus'],
      [2, 'user', '빌드 스크립트가 CI에서 실패하는데 원인을 찾아서 고쳐줘. 로그는 build.log에 있어.'],
      [3, 'assistant', '로그부터 확인할게요.'],
      [4, 'tool', 'Bash(npm test)'],
      [5, 'tool', 'Edit(/work/demo/build.sh)'],
      [6, 'tool', 'mcp__docs__search({"query":"build script","limit":5})'],
      [7, 'notice', 'Agent "Review build" finished'],
      [8, 'user', '!git status'],
      [9, 'assistant', '완료했습니다.'],
      [10, 'assistant', 'No response requested.'],
    ],
  );
  assert.equal(items[0]?.ts, '2026-09-29T10:00:01.000Z');
});

test('tool_result updates the tool_use item in place and re-emits it with the same seq', () => {
  const log = new ItemLog();
  const bashIndex = lines.findIndex((l) => l.includes('toolu_bash') && l.includes('tool_use'));
  for (const line of lines.slice(0, bashIndex + 1)) parseClaudeLine(line, log);
  const pending = log.drain().at(-1);
  assert.deepEqual(pending && { seq: pending.seq, pending: pending.pending }, { seq: 4, pending: true });

  parseClaudeLine(lines[bashIndex + 1] ?? '', log);
  const updated = log.drain();
  assert.equal(updated.length, 1);
  assert.deepEqual(updated[0], {
    seq: 4,
    kind: 'tool',
    ts: '2026-09-29T10:00:06.000Z',
    text: 'Bash(npm test)',
    pending: false,
    detail: '3 passing\n1 failing',
  });

  const edit = parseAll(lines).page(undefined, 100).items.find((i) => i.text.startsWith('Edit('));
  assert.equal(edit?.error, true);
  assert.equal(edit?.detail, 'old_string not found in file');
});

test('ExitPlanMode: the plan is an assistant item marked plan, before its tool row', () => {
  const input = { plan: '# Plan\n\n- one\n', planFilePath: '/home/u/.claude/plans/p.md' };
  const message = { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_plan', name: 'ExitPlanMode', input }] };
  const ts = '2026-10-01T10:44:58.556Z';
  const { items } = parseAll([JSON.stringify({ type: 'assistant', uuid: 'u-plan', timestamp: ts, message })]).page(undefined, 10);
  assert.deepEqual(items, [
    { seq: 1, kind: 'assistant', ts, text: '# Plan\n\n- one', plan: true },
    { seq: 2, kind: 'tool', ts, text: 'ExitPlanMode(/home/u/.claude/plans/p.md)', pending: true },
  ]);
});

test('summarizes tools by their most telling argument', () => {
  assert.equal(toolText('Read', { file_path: '/a.ts' }), 'Read(/a.ts)');
  assert.equal(toolText('Grep', { pattern: 'TODO', path: 'src' }), 'Grep(TODO)');
  assert.equal(toolText('Agent', { description: 'Review', prompt: 'long' }), 'Agent(Review)');
  assert.equal(toolText('TaskList', {}), 'TaskList');
  const long = toolText('Other', { value: 'x'.repeat(500) });
  assert.equal(long.length, 'Other()'.length + 120);
});

test('classifies wrapped user input', () => {
  assert.deepEqual(classifyUserText('<command-message>review</command-message>\n<command-name>/review</command-name>'), {
    kind: 'command',
    text: '/review',
  });
  assert.equal(classifyUserText('<local-command-stdout>ok</local-command-stdout>'), undefined);
  assert.equal(classifyUserText('   '), undefined);
});

test('clips long text to the protocol limit', () => {
  const line = JSON.stringify({
    type: 'user',
    uuid: 'u-long',
    timestamp: '2026-09-29T10:00:00.000Z',
    message: { role: 'user', content: '가'.repeat(TEXT_MAX + 10) },
  });
  const item = parseAll([line]).page(undefined, 1).items[0];
  assert.equal(item?.text.length, TEXT_MAX);
  assert.ok(item?.text.endsWith('…'));
});

function scan(input: string[]): ClaudeMetaScan {
  const meta = new ClaudeMetaScan();
  for (const line of input) meta.line(line);
  return meta;
}

test('title precedence: custom-title > registry name > ai-title > first prompt', () => {
  const all = scan(lines);
  assert.equal(sessionTitle(all, 'registry-name'), 'CI 빌드 수정');

  const noCustom = scan(lines.filter((l) => !l.includes('"custom-title"')));
  assert.equal(sessionTitle(noCustom, 'registry-name'), 'registry-name');
  assert.equal(sessionTitle(noCustom, 'registry-name', 'user'), 'registry-name');
  assert.equal(sessionTitle(noCustom, 'project-2a', 'derived'), 'Fix failing CI build', 'a derived name is a placeholder');
  assert.equal(sessionTitle(noCustom, undefined), 'Fix failing CI build');

  const promptOnly = scan(lines.filter((l) => !l.includes('"custom-title"') && !l.includes('"ai-title"')));
  assert.equal(sessionTitle(promptOnly, undefined), '빌드 스크립트가 CI에서 실패하는데 원인을 찾아서 고쳐줘. 로그는 bu…');
  assert.equal(sessionTitle(promptOnly, undefined).length, 40);
  assert.equal(sessionTitle(undefined, undefined), '');
  assert.equal(all.cwd, '/work/demo');
});

test('context usage comes from the last non-synthetic assistant usage', () => {
  assert.equal(scan(lines).contextUsed, 10 + 200 + 5000);
  const meta = scan(lines);
  meta.reset();
  assert.equal(meta.contextUsed, undefined);
});

test('model and effort come from the last real assistant turn; model ids map to names', () => {
  const assistant = (model: string, extra: object = {}): string =>
    JSON.stringify({ type: 'assistant', uuid: `a-${model}`, timestamp: '2026-09-29T10:05:00.000Z', message: { role: 'assistant', model, content: [] }, ...extra });
  assert.deepEqual([scan(lines).model, scan(lines).effort], [undefined, undefined], 'the fixture predates model/effort and has a synthetic message');
  const meta = scan([...lines, assistant('claude-fable-5-1', { effort: 'xhigh' })]);
  assert.deepEqual([meta.model, meta.effort], ['claude-fable-5-1', 'xhigh']);
  meta.line(assistant('<synthetic>'));
  meta.line(assistant('claude-sonnet-5-5', { effort: 'low', isSidechain: true }));
  assert.deepEqual([meta.model, meta.effort], ['claude-fable-5-1', 'xhigh'], 'synthetic and sidechain messages are skipped');
  meta.line(assistant('claude-haiku-4-5-20251001'));
  assert.deepEqual([meta.model, meta.effort], ['claude-haiku-4-5-20251001', undefined], 'a model without effort levels writes none');
  meta.reset();
  assert.deepEqual([meta.model, meta.effort], [undefined, undefined]);

  assert.deepEqual(
    ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-fable-5', 'claude-fable-5-10'].map(claudeModelName),
    ['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5', 'fable-5', 'fable-5-10'],
  );
});

test('a compaction resets the context to its post-compaction size', () => {
  const boundary = (extra: object): string =>
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: '2026-09-29T11:00:00.000Z', uuid: 's-c', ...extra });
  const meta = scan([...lines, boundary({ compactMetadata: { trigger: 'manual', preTokens: 5210, postTokens: 8387 } })]);
  assert.equal(meta.contextUsed, 8387);
  assert.equal(meta.compactedAt, Date.parse('2026-09-29T11:00:00.000Z'));
  assert.equal(scan([...lines, boundary({})]).contextUsed, undefined);
  meta.reset();
  assert.equal(meta.compactedAt, undefined);
});

test('statusLine rate limits become 5h/7d usage with ISO reset times', () => {
  const input = {
    session_id: 'abc',
    context_window: { context_window_size: 1_000_000, used_percentage: 12 },
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: 1790683200 },
      seven_day: { used_percentage: 12.5, resets_at: '2026-10-05T00:00:00Z' },
    },
  };
  assert.deepEqual(statuslineUsage(input, Date.parse('2026-09-29T10:00:00Z')), {
    provider: 'claude-code',
    updatedAt: '2026-09-29T10:00:00.000Z',
    windows: [
      { id: '5h', label: '5h', usedPercent: 42, resetsAt: new Date(1790683200 * 1000).toISOString(), minutes: 300 },
      { id: '7d', label: '7d', usedPercent: 12.5, resetsAt: '2026-10-05T00:00:00.000Z', minutes: 10080 },
    ],
  });
  assert.deepEqual(statuslineContext(input), { sessionId: 'abc', window: 1_000_000 });
  assert.equal(statuslineUsage({ rate_limits: null }, 0), undefined);
});

test('statusLine rate limits: every window with used_percentage, model-scoped weekly and spend limits labelled', () => {
  const input = {
    rate_limits: {
      five_hour: { used_percentage: 9, resets_at: 1790701800 },
      seven_day: { used_percentage: 5, resets_at: 1791244800 },
      seven_day_fable: { used_percentage: 61, resets_at: 1791244800 },
      seven_day_oauth_apps: { used_percentage: 0 },
      spend_limit: { used_percentage: 104, resets_at: 1791244800, used_usd: 52, limit_usd: 50, period: 'weekly' },
      monthly: { used_percentage: 7 },
      seven_day_opus: null,
      extra_usage: { is_enabled: true },
    },
  };
  assert.deepEqual(statuslineUsage(input, 0)?.windows, [
    { id: '5h', label: '5h', usedPercent: 9, resetsAt: '2026-09-29T17:10:00.000Z', minutes: 300 },
    { id: '7d', label: '7d', usedPercent: 5, resetsAt: '2026-10-06T00:00:00.000Z', minutes: 10080 },
    { id: '7d_fable', label: '7d Fable', usedPercent: 61, resetsAt: '2026-10-06T00:00:00.000Z', minutes: 10080 },
    { id: '7d_oauth_apps', label: '7d Oauth apps', usedPercent: 0, minutes: 10080 },
    { id: 'spend', label: 'Spend', usedPercent: 104, resetsAt: '2026-10-06T00:00:00.000Z' },
    { id: 'monthly', usedPercent: 7 },
  ]);
  assert.equal(statuslineUsage({ rate_limits: { extra_usage: { is_enabled: true } } }, 0), undefined);
});

// Shape recorded from Claude Code 2.1.284 (docs/spikes.md); paths shortened.
const realStatusline = {
  session_id: 'eeba9f38-1111-44d6-b54f-db8b9d506da0',
  transcript_path: '/home/dev/.claude/projects/-work/eeba9f38-1111-44d6-b54f-db8b9d506da0.jsonl',
  cwd: '/work',
  model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
  workspace: { current_dir: '/work', project_dir: '/work', added_dirs: [] },
  version: '2.1.284',
  output_style: { name: 'default' },
  cost: { total_cost_usd: 0, total_duration_ms: 11937, total_api_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0 },
  context_window: {
    total_input_tokens: 0,
    total_output_tokens: 0,
    context_window_size: 200000,
    current_usage: null,
    used_percentage: null,
    remaining_percentage: null,
  },
  exceeds_200k_tokens: false,
  fast_mode: false,
  thinking: { enabled: true },
  rate_limits: { five_hour: { used_percentage: 9, resets_at: 1790701800 }, seven_day: { used_percentage: 5, resets_at: 1791244800 } },
};

test('real statusLine JSON: rate limits to 5h/7d with ISO resets, context before and after the first call', () => {
  assert.deepEqual(statuslineUsage(realStatusline, Date.parse('2026-09-29T14:09:41Z'))?.windows, [
    { id: '5h', label: '5h', usedPercent: 9, resetsAt: '2026-09-29T17:10:00.000Z', minutes: 300 },
    { id: '7d', label: '7d', usedPercent: 5, resetsAt: '2026-10-06T00:00:00.000Z', minutes: 10080 },
  ]);
  assert.deepEqual(statuslineContext(realStatusline), { sessionId: realStatusline.session_id, window: 200000 });
  const after = {
    ...realStatusline,
    context_window: {
      ...realStatusline.context_window,
      current_usage: { input_tokens: 8500, output_tokens: 1200, cache_creation_input_tokens: 5000, cache_read_input_tokens: 2000 },
    },
  };
  assert.deepEqual(statuslineContext(after), { sessionId: realStatusline.session_id, window: 200000, used: 15500 });
  const { rate_limits: _, ...noLimits } = realStatusline;
  assert.equal(statuslineUsage(noLimits, 0), undefined);
});

test('statusLine model and effort: display_name (else the id\'s name) and effort.level', () => {
  assert.deepEqual(statuslineModel(realStatusline), { model: 'Haiku 4.5' }, 'Haiku has no effort levels');
  assert.deepEqual(statuslineModel({ ...realStatusline, model: { id: 'claude-fable-5-1', display_name: 'Fable 5.1' }, effort: { level: 'xhigh' } }), {
    model: 'Fable 5.1',
    effort: 'xhigh',
  });
  assert.deepEqual(statuslineModel({ session_id: 'x', model: { id: 'claude-opus-5-5' } }), { model: 'Opus 5.5' });
  assert.equal(statuslineModel({ session_id: 'x' }), undefined);
});

/** Transcript records as Claude Code 2.1.287 writes them: a turn's user records (its prompt and tool results) share one `promptId`. */
const user = (promptId: string | undefined, ts: string, content: unknown, extra: object = {}): string =>
  JSON.stringify({ type: 'user', uuid: `u-${ts}`, timestamp: ts, ...(promptId && { promptId }), message: { role: 'user', content }, ...extra });
const toolUses = (ts: string, uses: { id: string; name: string; input: object }[], extra: object = {}): string =>
  JSON.stringify({ type: 'assistant', uuid: `a-${ts}`, timestamp: ts, message: { role: 'assistant', model: 'claude-fable-5-1', content: uses.map((u) => ({ type: 'tool_use', ...u })) }, ...extra });
const result = (promptId: string, ts: string, toolUseId: string, text: string, toolUseResult?: object): string =>
  user(promptId, ts, [{ type: 'tool_result', tool_use_id: toolUseId, content: text }], toolUseResult && { toolUseResult });

test('task list (TaskCreate/TaskUpdate): progress counts completed tasks and names the task in progress; a new turn starts with none until the list is touched again', () => {
  const meta = new ClaudeMetaScan();
  meta.line(user('p1', '2026-09-29T10:00:00.000Z', 'Port the build to the new CI'));
  assert.equal(meta.turnStartedAt, '2026-09-29T10:00:00.000Z');
  assert.equal(meta.progress, undefined);

  // Task 5 has no subject: its title is its description's first line.
  const creates = Array.from({ length: 7 }, (_, i) => ({ id: `toolu_c${i + 1}`, name: 'TaskCreate', input: i === 4 ? { description: '\nUpdate the deploy docs\nwith details' } : { subject: `Step ${i + 1}`, description: 'd' } }));
  meta.line(toolUses('2026-09-29T10:00:05.000Z', creates));
  assert.equal(meta.progress, undefined, 'a task exists once its result names its id');
  for (let i = 1; i <= 7; i++) {
    // The id comes from toolUseResult, else from the result's text.
    const text = `Task #${i} created successfully: Step ${i}`;
    meta.line(result('p1', '2026-09-29T10:00:06.000Z', `toolu_c${i}`, text, i % 2 === 0 ? undefined : { task: { id: String(i), subject: `Step ${i}` } }));
  }
  assert.deepEqual(meta.progress, { done: 0, total: 7 });
  const update = (n: number, ts: string, input: object): string => toolUses(ts, [{ id: `toolu_u${n}`, name: 'TaskUpdate', input }]);
  meta.line(update(1, '2026-09-29T10:01:00.000Z', { taskId: '1', status: 'completed' }));
  meta.line(update(2, '2026-09-29T10:02:00.000Z', { taskId: '2', status: 'completed' }));
  assert.deepEqual(meta.progress, { done: 2, total: 7 }, 'no task in progress: no current');
  meta.line(update(3, '2026-09-29T10:03:00.000Z', { taskId: '4', status: 'in_progress' }));
  assert.deepEqual(meta.progress, { done: 2, total: 7, current: 'Step 4' });
  meta.line(update(4, '2026-09-29T10:04:00.000Z', { taskId: '3', status: 'completed' }));
  meta.line(update(5, '2026-09-29T10:04:01.000Z', { taskId: '5', owner: 'me' }));
  meta.line(result('p1', '2026-09-29T10:04:02.000Z', 'toolu_u4', 'Updated task #3 status'));
  meta.line(user('p1', '2026-09-29T10:04:03.000Z', [{ type: 'text', text: '[Request interrupted by user]' }]));
  assert.deepEqual(meta.progress, { done: 3, total: 7, current: 'Step 4' }, 'an update without a status, tool results and an interruption change nothing');
  assert.equal(meta.turnStartedAt, '2026-09-29T10:00:00.000Z', 'records of the same turn keep its start');
  meta.line(toolUses('2026-09-29T10:04:04.000Z', [{ id: 'toolu_s1', name: 'TaskCreate', input: { subject: 'Side', description: 'd' } }], { isSidechain: true }));
  meta.line(toolUses('2026-09-29T10:04:05.000Z', [{ id: 'toolu_s2', name: 'TaskUpdate', input: { taskId: '6', status: 'completed' } }], { isSidechain: true }));
  assert.deepEqual(meta.progress, { done: 3, total: 7, current: 'Step 4' }, 'a sub-agent\'s task calls are its own');

  // The next turn (here a task notification) starts without progress; the list itself carries on.
  meta.line(user('p2', '2026-09-29T11:00:00.000Z', '<task-notification>\n<summary>Agent "Review" finished</summary>\n</task-notification>'));
  assert.equal(meta.turnStartedAt, '2026-09-29T11:00:00.000Z');
  assert.equal(meta.progress, undefined);
  meta.line(update(6, '2026-09-29T11:00:10.000Z', { taskId: '4', status: 'completed' }));
  assert.deepEqual(meta.progress, { done: 4, total: 7 }, 'the task in progress completed and none other is: no current');
  meta.line(update(7, '2026-09-29T11:00:11.000Z', { taskId: '7', status: 'deleted' }));
  assert.deepEqual(meta.progress, { done: 4, total: 6 });
  meta.line(update(8, '2026-09-29T11:00:12.000Z', { taskId: '5', status: 'in_progress' }));
  assert.deepEqual(meta.progress, { done: 4, total: 6, current: 'Update the deploy docs' });
  meta.line(update(9, '2026-09-29T11:00:13.000Z', { taskId: '5', subject: `Rename  ${'x'.repeat(90)}` }));
  assert.deepEqual(meta.progress, { done: 4, total: 6, current: `Rename ${'x'.repeat(72)}…` }, 'a new subject renames the task, clipped to 80');
  meta.line(update(10, '2026-09-29T11:00:14.000Z', { taskId: '5', status: 'completed' }));
  assert.deepEqual(meta.progress, { done: 5, total: 6 });

  meta.reset();
  assert.deepEqual([meta.turnStartedAt, meta.turnId, meta.progress], [undefined, undefined, undefined]);
});

test('task list (TodoWrite): each call replaces the list; without promptId a typed prompt opens the turn, a tool result or meta record does not', () => {
  const meta = new ClaudeMetaScan();
  const todos = (ts: string, statuses: string[]): string =>
    toolUses(ts, [{ id: `toolu_${ts}`, name: 'TodoWrite', input: { todos: statuses.map((status, i) => ({ content: `Task ${i}`, status, activeForm: `Doing ${i}` })) } }]);
  meta.line(user(undefined, '2026-09-29T10:00:00.000Z', 'Refactor the parser'));
  assert.equal(meta.turnStartedAt, '2026-09-29T10:00:00.000Z');
  meta.line(todos('2026-09-29T10:00:01.000Z', ['in_progress', 'pending', 'pending']));
  assert.deepEqual(meta.progress, { done: 0, total: 3, current: 'Task 0' });
  meta.line(result('x', '2026-09-29T10:00:02.000Z', 'toolu_2026-09-29T10:00:01.000Z', 'Todos have been modified successfully.').replace(/"promptId":"x",/, ''));
  meta.line(user(undefined, '2026-09-29T10:00:03.000Z', 'Caveat: the messages below were generated by the user while running local commands.', { isMeta: true }));
  meta.line(user(undefined, '2026-09-29T10:00:04.000Z', '<command-name>/login</command-name>'));
  meta.line(todos('2026-09-29T10:01:00.000Z', ['completed', 'completed', 'in_progress', 'pending']));
  assert.deepEqual(meta.progress, { done: 2, total: 4, current: 'Task 2' });
  assert.equal(meta.turnStartedAt, '2026-09-29T10:00:00.000Z');
  meta.line(todos('2026-09-29T10:02:00.000Z', []));
  assert.equal(meta.progress, undefined, 'an emptied list is no progress');
  meta.line(todos('2026-09-29T10:03:00.000Z', ['completed', 'completed', 'completed']));
  assert.deepEqual(meta.progress, { done: 3, total: 3 }, 'all done: no current');
  meta.line(user(undefined, '2026-09-29T10:10:00.000Z', 'Now the docs'));
  assert.deepEqual([meta.turnStartedAt, meta.progress], ['2026-09-29T10:10:00.000Z', undefined]);
});

test('sub-agents: without a task list, progress counts the Agent/Task launches of the turn and names the first unfinished one', () => {
  const meta = new ClaudeMetaScan();
  const agent = (id: string, description: string, name = 'Agent') => ({ id, name, input: { subagent_type: 'Explore', description, prompt: 'p' } });
  meta.line(user('p1', '2026-09-29T10:00:00.000Z', 'Review the release'));
  meta.line(toolUses('2026-09-29T10:00:01.000Z', [agent('toolu_a1', 'Check the changelog'), agent('toolu_a2', `Audit  the\ndeploy ${'x'.repeat(90)}`, 'Task')]));
  assert.deepEqual(meta.progress, { kind: 'agents', done: 0, total: 2, current: 'Check the changelog' });
  meta.line(result('p1', '2026-09-29T10:00:30.000Z', 'toolu_a1', 'The changelog is complete.'));
  assert.deepEqual(meta.progress, { kind: 'agents', done: 1, total: 2, current: `Audit the` }, 'a result finishes a sub-agent; current is its description\'s first line');
  meta.line(user('p1', '2026-09-29T10:01:00.000Z', [{ type: 'tool_result', tool_use_id: 'toolu_a2', content: 'Failed', is_error: true }]));
  assert.deepEqual(meta.progress, { kind: 'agents', done: 2, total: 2 }, 'an error result finishes it too');
  meta.line(toolUses('2026-09-29T10:01:01.000Z', [agent('toolu_s1', 'Nested')], { isSidechain: true }));
  assert.deepEqual(meta.progress, { kind: 'agents', done: 2, total: 2 }, 'a sub-agent\'s own launches are its own');
  meta.line(user('p2', '2026-09-29T10:05:00.000Z', 'Thanks'));
  assert.equal(meta.progress, undefined, 'the next turn starts without progress');

  // Background sub-agents: the result only says one started; each reports back in a task notification, a turn of its own.
  const launched = (id: string): object => ({ isAsync: true, status: 'async_launched', agentId: `a-${id}`, description: 'd' });
  meta.line(toolUses('2026-09-29T10:05:01.000Z', [agent('toolu_b1', 'Scan the logs'), agent('toolu_b2', 'Read the docs')]));
  meta.line(result('p2', '2026-09-29T10:05:02.000Z', 'toolu_b1', 'Async agent launched successfully.', launched('b1')));
  meta.line(result('p2', '2026-09-29T10:05:02.000Z', 'toolu_b2', 'Async agent launched successfully.', launched('b2')));
  assert.deepEqual(meta.progress, { kind: 'agents', done: 0, total: 2, current: 'Scan the logs' });
  const notification = (promptId: string, ts: string, toolUseId: string): string =>
    user(promptId, ts, `<task-notification>\n<task-id>a-x</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Agent "x" completed</summary>\n</task-notification>`);
  meta.line(notification('p3', '2026-09-29T10:06:00.000Z', 'toolu_b1'));
  assert.equal(meta.turnStartedAt, '2026-09-29T10:06:00.000Z');
  assert.deepEqual(meta.progress, { kind: 'agents', done: 1, total: 2, current: 'Read the docs' });
  meta.line(user('p4', '2026-09-29T10:06:30.000Z', '<task-notification>\n<tool-use-id>toolu_bash</tool-use-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>'));
  assert.equal(meta.progress, undefined, 'a notification about something else is a turn without progress');
  meta.line(notification('p5', '2026-09-29T10:07:00.000Z', 'toolu_b2'));
  assert.deepEqual(meta.progress, { kind: 'agents', done: 2, total: 2 });
  meta.line(toolUses('2026-09-29T10:07:01.000Z', [agent('toolu_c1', 'Write the notes')]));
  assert.deepEqual(meta.progress, { kind: 'agents', done: 0, total: 1, current: 'Write the notes' }, 'a launch after all finished starts a new count');
  meta.line(user('p6', '2026-09-29T10:08:00.000Z', 'Stop waiting'));
  meta.line(notification('p7', '2026-09-29T10:09:00.000Z', 'toolu_c1'));
  assert.equal(meta.progress, undefined, 'a prompt drops the sub-agents still out');

  meta.line(toolUses('2026-09-29T10:09:01.000Z', [agent('toolu_d1', 'Run it again')]));
  meta.reset();
  assert.equal(meta.progress, undefined);
});

test('sub-agents and a task list in the same turn: the task list wins', () => {
  const meta = new ClaudeMetaScan();
  meta.line(user('p1', '2026-09-29T10:00:00.000Z', 'Ship it'));
  meta.line(toolUses('2026-09-29T10:00:01.000Z', [{ id: 'toolu_a1', name: 'Agent', input: { description: 'Review', prompt: 'p' } }]));
  assert.deepEqual(meta.progress, { kind: 'agents', done: 0, total: 1, current: 'Review' });
  meta.line(toolUses('2026-09-29T10:00:02.000Z', [{ id: 'toolu_t1', name: 'TodoWrite', input: { todos: [{ content: 'Build', status: 'in_progress' }, { content: 'Tag', status: 'pending' }] } }]));
  assert.deepEqual(meta.progress, { done: 0, total: 2, current: 'Build' });
  meta.line(result('p1', '2026-09-29T10:00:30.000Z', 'toolu_a1', 'Looks good.'));
  assert.deepEqual(meta.progress, { done: 0, total: 2, current: 'Build' });
});
