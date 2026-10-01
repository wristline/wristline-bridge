// Pure parsing of Claude Code transcripts (~/.claude/projects/<slug>/<sessionId>.jsonl) and
// statusLine input. Verified against Claude Code 2.1.284 (ExitPlanMode: 2.1.286).

import type { ItemDraft, ItemSink, LineHandler } from '../../jsonl.ts';
import { DETAIL_MAX, TEXT_MAX, type Session, type Usage, type UsageWindow } from '../../protocol.ts';
import { clip, isObject, num, oneLine, parseJson, str, toIso, type JsonObject } from '../../util.ts';

const TITLE_MAX = 40;
const TOOL_JSON_MAX = 120;

type UserText = { kind: 'prompt' | 'command' | 'notice'; text: string };

/** Claude Code wraps non-prompt input (slash commands, `!` shell, task notifications) in tags. */
export function classifyUserText(raw: string): UserText | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (/^<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>/.test(text)) return undefined;
  if (/^<command-(name|message)>/.test(text)) {
    const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
    if (!name) return undefined;
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    const slash = name.startsWith('/') ? name : `/${name}`;
    return { kind: 'command', text: args ? `${slash} ${args}` : slash };
  }
  const bash = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(text);
  if (bash) return { kind: 'command', text: `!${bash[1] ?? ''}` };
  if (text.startsWith('<task-notification>')) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
    return summary ? { kind: 'notice', text: summary } : undefined;
  }
  return { kind: 'prompt', text };
}

export function toolText(name: string, input: unknown): string {
  const summary = toolSummary(name, input, TOOL_JSON_MAX);
  return summary ? `${name}(${summary})` : name;
}

/** The most telling argument of a tool call, or its JSON input cut to `jsonMax`. */
export function toolSummary(name: string, input: unknown, jsonMax: number): string | undefined {
  const args = isObject(input) ? input : {};
  let summary: string | undefined;
  switch (name) {
    case 'Bash':
      summary = str(args.command);
      break;
    case 'Edit':
    case 'Write':
    case 'Read':
      summary = str(args.file_path);
      break;
    case 'Grep':
    case 'Glob':
      summary = str(args.pattern);
      break;
    case 'Task':
    case 'Agent':
      summary = str(args.description);
      break;
    case 'ExitPlanMode':
      // The plan itself is its own item.
      summary = str(args.planFilePath);
      break;
  }
  if (summary === undefined && Object.keys(args).length > 0) summary = clip(JSON.stringify(args), jsonMax);
  return summary || undefined;
}

/** Applies one transcript line to the session's items. */
export function parseClaudeLine(line: string, sink: ItemSink): void {
  const rec = parseJson(line);
  if (!rec || rec.isSidechain === true || rec.isMeta === true) return;
  const ts = str(rec.timestamp);
  const message = rec.message;
  if (!ts || !isObject(message)) return;
  const uuid = str(rec.uuid) ?? ts;
  if (rec.type === 'user') applyUser(uuid, message, ts, sink);
  else if (rec.type === 'assistant') applyAssistant(uuid, message, ts, sink);
}

function applyUser(uuid: string, message: JsonObject, ts: string, sink: ItemSink): void {
  const { content } = message;
  if (typeof content === 'string') {
    addUserText(uuid, content, ts, sink);
    return;
  }
  if (!Array.isArray(content)) return;
  const texts: string[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === 'text') {
      const text = str(block.text);
      if (text) texts.push(text);
    } else if (block.type === 'tool_result') {
      const id = str(block.tool_use_id);
      if (id) sink.update(id, resultPatch(block));
    }
  }
  if (texts.length > 0) addUserText(uuid, texts.join('\n'), ts, sink);
}

function addUserText(key: string, raw: string, ts: string, sink: ItemSink): void {
  const user = classifyUserText(raw);
  if (!user) return;
  sink.add(key, { kind: user.kind === 'notice' ? 'notice' : 'user', ts, text: clip(user.text, TEXT_MAX) });
}

function resultPatch(block: JsonObject): Partial<ItemDraft> {
  const patch: Partial<ItemDraft> = { pending: false };
  const text = textOf(block.content).trim();
  if (text) patch.detail = clip(text, DETAIL_MAX);
  if (block.is_error === true) patch.error = true;
  return patch;
}

function applyAssistant(uuid: string, message: JsonObject, ts: string, sink: ItemSink): void {
  const { content } = message;
  if (!Array.isArray(content)) return;
  content.forEach((block: unknown, index) => {
    if (!isObject(block)) return;
    if (block.type === 'text') {
      const text = str(block.text)?.trim();
      if (text) sink.add(`${uuid}:${index}`, { kind: 'assistant', ts, text: clip(text, TEXT_MAX) });
    } else if (block.type === 'tool_use') {
      const id = str(block.id);
      const name = str(block.name) ?? 'tool';
      // A plan put up for approval is conversation, shown even where tool rows are hidden. Claude
      // Code writes the plan (read from the plan file) into the transcript's input.
      const plan = name === 'ExitPlanMode' && isObject(block.input) ? str(block.input.plan)?.trim() : undefined;
      if (plan) sink.add(`${uuid}:${index}`, { kind: 'assistant', ts, text: clip(plan, TEXT_MAX), plan: true });
      if (id) sink.add(id, { kind: 'tool', ts, text: clip(toolText(name, block.input), TEXT_MAX), pending: true });
    }
  });
}

/** Text of a string or of the `text` blocks in a content array. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) => (isObject(block) && block.type === 'text' ? (str(block.text) ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/** Tokens occupying the context window after an assistant turn. */
export function contextTokens(message: JsonObject): number | undefined {
  const usage = message.usage;
  if (!isObject(usage)) return undefined;
  const total =
    (num(usage.input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0);
  // Synthetic messages (API errors, interrupts) report all zeros.
  return total > 0 ? total : undefined;
}

/**
 * Collects what the session list needs from a transcript without keeping its items. Lines are
 * filtered by substring before JSON.parse; escaped quotes inside string values never match.
 */
export class ClaudeMetaScan implements LineHandler {
  customTitle: string | undefined;
  aiTitle: string | undefined;
  firstPrompt: string | undefined;
  cwd: string | undefined;
  contextUsed: number | undefined;
  /** When the last compaction happened (its record's timestamp, ms). */
  compactedAt: number | undefined;
  /** Model id (`message.model`) and `effort` of the last assistant turn. */
  model: string | undefined;
  effort: string | undefined;

  line(line: string): void {
    if (line.includes('"custom-title"')) {
      const rec = parseJson(line);
      if (rec?.type === 'custom-title') this.customTitle = str(rec.customTitle) || this.customTitle;
    } else if (line.includes('"ai-title"')) {
      const rec = parseJson(line);
      if (rec?.type === 'ai-title') this.aiTitle = str(rec.aiTitle) || this.aiTitle;
    } else if (line.includes('"type":"assistant"')) {
      const rec = parseJson(line);
      if (rec?.type !== 'assistant' || rec.isSidechain === true || !isObject(rec.message)) return;
      this.contextUsed = contextTokens(rec.message) ?? this.contextUsed;
      const model = str(rec.message.model);
      // Synthetic messages (API errors, interrupts) name no real model; models without effort levels (Haiku) write no `effort`.
      if (model && model !== '<synthetic>') {
        this.model = model;
        this.effort = str(rec.effort);
      }
    } else if (line.includes('"subtype":"compact_boundary"')) {
      // /compact writes no assistant usage; the boundary carries the size the context shrank to.
      const rec = parseJson(line);
      if (rec?.type !== 'system' || rec.subtype !== 'compact_boundary') return;
      this.contextUsed = isObject(rec.compactMetadata) ? num(rec.compactMetadata.postTokens) : undefined;
      this.compactedAt = Date.parse(str(rec.timestamp) ?? '') || this.compactedAt;
    } else if ((this.firstPrompt === undefined || this.cwd === undefined) && line.includes('"type":"user"')) {
      const rec = parseJson(line);
      if (rec?.type !== 'user' || rec.isSidechain === true) return;
      this.cwd ??= str(rec.cwd);
      if (this.firstPrompt !== undefined || rec.isMeta === true || !isObject(rec.message)) return;
      const user = classifyUserText(textOf(rec.message.content));
      if (user?.kind === 'prompt') this.firstPrompt = clip(oneLine(user.text), TITLE_MAX);
    }
  }

  reset(): void {
    this.customTitle = this.aiTitle = this.firstPrompt = this.cwd = undefined;
    this.contextUsed = this.compactedAt = undefined;
    this.model = this.effort = undefined;
  }
}

/**
 * custom-title > registry name > ai-title > first prompt (40 chars). A registry name with
 * `nameSource: "derived"` is a generated placeholder such as `project-2a` and is skipped.
 */
export function sessionTitle(meta: ClaudeMetaScan | undefined, registryName: string | undefined, nameSource?: string): string {
  const name = nameSource === 'derived' ? undefined : registryName;
  return meta?.customTitle || name || meta?.aiTitle || meta?.firstPrompt || '';
}

const MODEL_NAMES = [
  ['claude-fable-5-1', 'Fable 5.1'],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-haiku-4-5', 'Haiku 4.5'],
] as const;

/** Name for people of a transcript's model id (a dated id matches too); unknown ids lose their `claude-` prefix. */
export function claudeModelName(id: string): string {
  const known = MODEL_NAMES.find(([prefix]) => id === prefix || id.startsWith(`${prefix}-`));
  return known?.[1] ?? id.replace(/^claude-/, '');
}

/** `rate_limits` keys with a fixed id; `seven_day_<model>` becomes `7d_<model>`, any other key keeps its name. */
const LIMITS = new Map<string, { id: string; label: string; minutes?: number }>([
  ['five_hour', { id: '5h', label: '5h', minutes: 300 }],
  ['seven_day', { id: '7d', label: '7d', minutes: 10080 }],
  ['spend_limit', { id: 'spend', label: 'Spend' }],
]);

function limitWindow(key: string): { id: string; label?: string; minutes?: number } {
  const known = LIMITS.get(key);
  if (known) return known;
  const model = /^seven_day_(.+)$/.exec(key)?.[1];
  if (!model) return { id: key };
  const name = model.replace(/_/g, ' ');
  return { id: `7d_${model}`, label: `7d ${name.charAt(0).toUpperCase()}${name.slice(1)}`, minutes: 10080 };
}

/** `rate_limits` of the statusLine JSON (every window with a `used_percentage`); the only official source of the plan limits. */
export function statuslineUsage(input: JsonObject, now: number): Usage | undefined {
  const limits = input.rate_limits;
  if (!isObject(limits)) return undefined;
  const windows: UsageWindow[] = [];
  for (const [key, window] of Object.entries(limits)) {
    if (!isObject(window)) continue;
    const usedPercent = num(window.used_percentage);
    if (usedPercent === undefined) continue;
    const { id, label, minutes } = limitWindow(key);
    const resetsAt = toIso(window.resets_at);
    windows.push({ id, ...(label && { label }), usedPercent, ...(resetsAt && { resetsAt }), ...(minutes && { minutes }) });
  }
  if (windows.length === 0) return undefined;
  return { provider: 'claude-code', updatedAt: new Date(now).toISOString(), windows };
}

export interface StatuslineContext {
  sessionId: string;
  window?: number;
  /** Input tokens of the last API call; absent before the first call and right after /compact. */
  used?: number;
}

/** `context_window` of the statusLine JSON: the window size and, when known, the tokens in it. */
export function statuslineContext(input: JsonObject): StatuslineContext | undefined {
  const sessionId = str(input.session_id);
  const ctx = input.context_window;
  if (!sessionId || !isObject(ctx)) return undefined;
  const out: StatuslineContext = { sessionId };
  const window = num(ctx.context_window_size);
  if (window) out.window = window;
  const used = isObject(ctx.current_usage) ? contextTokens({ usage: ctx.current_usage }) : undefined;
  if (used !== undefined) out.used = used;
  return out.window || out.used !== undefined ? out : undefined;
}

/** `model` and `effort` of the statusLine JSON; `effort` is absent for models without effort levels. */
export function statuslineModel(input: JsonObject): Pick<Session, 'model' | 'effort'> | undefined {
  const model = isObject(input.model) ? input.model : {};
  const id = str(model.id);
  const out: Pick<Session, 'model' | 'effort'> = {};
  const name = str(model.display_name) || (id ? claudeModelName(id) : undefined);
  if (name) out.model = name;
  const effort = isObject(input.effort) ? str(input.effort.level) : undefined;
  if (effort) out.effort = effort;
  return out.model || out.effort ? out : undefined;
}
