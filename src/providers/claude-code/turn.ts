// The prompt that started the current turn of a Claude Code transcript, for the `done` alert's
// title. Mirrors the user's Slack Stop hook: the turn starts at the newest non-tool_result user
// line; a line without `origin` (skill expansion, reminder) belongs to the `origin` line of the
// same promptId; a turn without such a line (scheduled task, local command) is not a human turn.

import { open } from 'node:fs/promises';
import { isObject, parseJson, str, type JsonObject } from '../../util.ts';

const CHUNK_BYTES = 1 << 20;
const NEWLINE = 0x0a;

/** Prompts injected by Claude Code rather than typed by the user. */
const INJECTED = ['<task-notification', '<system-reminder', '<local-command'];

async function* linesFromEnd(path: string): AsyncGenerator<string> {
  const file = await open(path, 'r');
  try {
    let pos = (await file.stat()).size;
    let carry = Buffer.alloc(0);
    while (pos > 0) {
      const n = Math.min(CHUNK_BYTES, pos);
      pos -= n;
      const chunk = Buffer.alloc(n);
      await file.read(chunk, 0, n, pos);
      const data = Buffer.concat([chunk, carry]);
      let end = data.length;
      for (let i = data.lastIndexOf(NEWLINE, end - 1); i >= 0; i = data.lastIndexOf(NEWLINE, i - 1)) {
        yield data.subarray(i + 1, end).toString('utf8');
        end = i;
        if (i === 0) break;
      }
      carry = data.subarray(0, end);
    }
    yield carry.toString('utf8');
  } finally {
    await file.close();
  }
}

/** The user line that started the newest turn, or undefined when it has no `origin` line. */
async function turnStart(path: string): Promise<JsonObject | undefined> {
  let last: JsonObject | undefined;
  for await (const line of linesFromEnd(path)) {
    if (!line.includes('"type":"user"') || line.includes('"type":"tool_result"')) continue;
    const o = parseJson(line);
    if (!o || o.type !== 'user') continue;
    last ??= o;
    if (isObject(o.origin)) {
      const same = Boolean(o.promptId) && o.promptId === last.promptId;
      return o === last || same ? o : undefined;
    }
  }
  return undefined;
}

/** The text of a user line's message content. */
function contentText(o: JsonObject): string | undefined {
  const content = isObject(o.message) ? o.message.content : undefined;
  if (!Array.isArray(content)) return str(content);
  return content
    .filter((b): b is JsonObject => isObject(b) && b.type === 'text')
    .map((b) => str(b.text) ?? '')
    .join('\n');
}

/**
 * The cleaned prompt of a human-typed turn (reminders, pasted content and command wrappers
 * stripped); undefined for any other turn, or when the transcript cannot be read.
 */
export async function humanPrompt(transcriptPath: string | undefined): Promise<string | undefined> {
  if (!transcriptPath) return undefined;
  let o: JsonObject | undefined;
  try {
    o = await turnStart(transcriptPath);
  } catch {
    return undefined;
  }
  if (!o || !isObject(o.origin) || o.origin.kind !== 'human' || o.isMeta) return undefined;
  const text = contentText(o);
  if (text === undefined || INJECTED.some((tag) => text.trimStart().startsWith(tag))) return undefined;
  return text
    .replace(/<(system-reminder|pasted_content|command-message)\b[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<\/?command-(?:name|args)>/g, '')
    .replace(/\n{3,}/g, '\n\n');
}
