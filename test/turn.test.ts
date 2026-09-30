// The prompt of a human-typed turn from a Claude Code transcript (docs/protocol.md, `alert done`).
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { humanPrompt } from '../src/providers/claude-code/turn.ts';

const dir = mkdtempSync(join(tmpdir(), 'wristline-turn-'));
let n = 0;

function transcript(lines: unknown[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

const human = (content: unknown, promptId = 'p1'): Record<string, unknown> => ({ type: 'user', message: { role: 'user', content }, promptId, origin: { kind: 'human' } });
const assistant = (text: string): unknown => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
// Its command echoes `"type":"user"` and `origin` so the cheap line filter must not trip over tool lines.
const toolUse = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'echo "origin":{"kind":"human"}' } }] } };
const toolResult = (promptId: string): unknown => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '"type":"user" origin human <task-notification>' }] },
  promptId,
});

test('a human turn yields its prompt with reminders, pasted content and command wrappers stripped', async () => {
  assert.equal(
    await humanPrompt(transcript([human('Please fix the build.\n<system-reminder>\nINTERNAL\n</system-reminder>\nAnd run tests.'), toolUse, toolResult('p1'), assistant('done')])),
    'Please fix the build.\n\nAnd run tests.',
  );
  assert.equal(await humanPrompt(transcript([human('<pasted_content id="1">\nLONG LOG\n</pasted_content>\nwhat is wrong here?'), assistant('x')])), '\nwhat is wrong here?');
  assert.equal(
    await humanPrompt(transcript([human([{ type: 'image', source: {} }, { type: 'text', text: 'what is in this screenshot?' }]), assistant('x')])),
    'what is in this screenshot?',
  );
  const skill = human('<command-message>code-review</command-message>\n<command-name>/code-review</command-name>\n<command-args>high</command-args>');
  const expansion = { type: 'user', message: { role: 'user', content: 'SKILL EXPANSION BODY' }, promptId: 'p1', isMeta: true };
  assert.equal(await humanPrompt(transcript([skill, expansion, toolUse, toolResult('p1'), assistant('review done')])), '\n/code-review\nhigh', 'the origin line of the same promptId');
});

test('turns not typed by the user yield undefined', async () => {
  const older = [human('earlier question'), assistant('a1')];
  const notification = { type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>abc</task-id>\n</task-notification>' }, promptId: 'p2', origin: { kind: 'task-notification' } };
  assert.equal(await humanPrompt(transcript([...older, notification, toolUse, toolResult('p2'), assistant('final')])), undefined, 'task notification');
  assert.equal(await humanPrompt(transcript([...older, { ...human('peer says hello', 'p2'), origin: { kind: 'peer' }, isMeta: true }, assistant('b')])), undefined, 'peer, isMeta');
  const scheduled = { type: 'user', message: { role: 'user', content: 'LOOP PROMPT' }, promptId: 'p9', isMeta: true };
  assert.equal(await humanPrompt(transcript([...older, { type: 'system', subtype: 'scheduled_task_fire' }, scheduled, toolUse, toolResult('p9'), assistant('c')])), undefined, 'no origin line of promptId p9');
  assert.equal(await humanPrompt(transcript([human('<system-reminder>x</system-reminder>\nhello'), assistant('x')])), undefined, 'starts with an injected tag');
  assert.equal(await humanPrompt(transcript([human('<local-command-stdout>ok</local-command-stdout>'), assistant('x')])), undefined);
  assert.equal(await humanPrompt(transcript([{ ...human('hi'), isMeta: true }, assistant('x')])), undefined, 'isMeta on a human line');
  assert.equal(await humanPrompt(transcript([human([{ type: 'image', source: {} }]), assistant('x')])), '', 'no text block');
  assert.equal(await humanPrompt(transcript([assistant('nothing before')])), undefined);
});

test('a missing or absent transcript yields undefined', async () => {
  assert.equal(await humanPrompt(join(dir, 'missing.jsonl')), undefined);
  assert.equal(await humanPrompt(undefined), undefined);
  assert.equal(await humanPrompt(dir), undefined, 'a directory');
});

test('the transcript is read from its end in chunks; lines across chunk boundaries stay whole', async () => {
  const padding = 'y'.repeat(700 * 1024);
  const prompt = `한글 프롬프트 ${'x'.repeat(600 * 1024)} end`;
  const path = transcript([human('older'), assistant(padding), human(prompt), toolUse, toolResult('p1'), assistant(padding), assistant(padding), assistant('final')]);
  assert.equal(await humanPrompt(path), prompt);
});
