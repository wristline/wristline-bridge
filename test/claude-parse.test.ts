import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ItemLog } from '../src/jsonl.ts';
import { TEXT_MAX } from '../src/protocol.ts';
import {
  ClaudeMetaScan,
  classifyUserText,
  parseClaudeLine,
  sessionTitle,
  statuslineUsage,
  statuslineWindow,
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
      { id: '5h', usedPercent: 42, resetsAt: new Date(1790683200 * 1000).toISOString(), minutes: 300 },
      { id: '7d', usedPercent: 12.5, resetsAt: '2026-10-05T00:00:00.000Z', minutes: 10080 },
    ],
  });
  assert.deepEqual(statuslineWindow(input), { sessionId: 'abc', window: 1_000_000 });
  assert.equal(statuslineUsage({ rate_limits: null }, 0), undefined);
});
