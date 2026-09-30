// Claude Code hooks: the HTTP handlers served on the local port. The settings.json merge that
// installs them and the statusLine relay script live in settings.ts. Verified against Claude Code 2.1.284.

import { PERMISSION_QUESTION, type Option, type Question } from '../../protocol.ts';
import type { BridgeHub } from '../../hub.ts';
import { sessionKey, type Hub } from '../../provider.ts';
import type { HookHandler } from '../../server.ts';
import { clip, isObject, oneLine, str, type JsonObject } from '../../util.ts';
import { toolSummary } from './parse.ts';
import { humanPrompt } from './turn.ts';

export const HOOK_NAMES = ['permission-request', 'pre-tool-use', 'notification', 'stop'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/** Longest tool description (e.g. an ExitPlanMode plan) shown on a permission request. */
const PERMISSION_TEXT_MAX = 1500;
const ALERT_TEXT_MAX = 120;
/** The `done` alert carries more of the answer, and a title; answers shorter than DONE_MIN (or "No response requested.") raise none. */
const DONE_TEXT_MAX = 500;
const DONE_TITLE_MAX = 60;
const DONE_MIN = 20;
const NO_RESPONSE = /^no response requested\.?$/i;
/** Notifications that mean "the session waits for you" when no request is open for it. */
const NEEDS_INPUT = new Set(['permission_prompt', 'agent_needs_input']);

export interface HookContext {
  hub: Pick<Hub, 'pending' | 'alert'> & Pick<BridgeHub, 'sessions'>;
  /** How long to wait for the watch before handing the decision back to the terminal. */
  waitMs: number;
  /** Aborted when Claude Code drops the hook request. */
  signal: AbortSignal;
  /** True for a session id that is a Quick Ask thread (src/ask.ts), whose hooks must not reach the watch: no decision, no alert. */
  isAsk?: (sessionId: string) => boolean;
}

/** Handlers for the local listener's `/hooks/<name>` routes. */
export function hookHandlers(hub: HookContext['hub'], waitMs: number, isAsk?: HookContext['isAsk']): Map<string, HookHandler> {
  return new Map(HOOK_NAMES.map((name) => [name, (input, signal) => handleHook(name, input, { hub, waitMs, signal, ...(isAsk ? { isAsk } : {}) })]));
}

/** Resolves the hook's JSON output, or undefined for "no decision" (an empty 200). */
export async function handleHook(name: HookName, input: JsonObject, ctx: HookContext): Promise<JsonObject | undefined> {
  switch (name) {
    case 'permission-request':
      return permissionRequest(input, ctx);
    case 'pre-tool-use':
      return preToolUse(input, ctx);
    case 'notification':
      notification(input, ctx);
      return undefined;
    case 'stop':
      await stop(input, ctx);
      return undefined;
  }
}

function sessionOf(input: JsonObject): string | undefined {
  const id = str(input.session_id);
  return id ? sessionKey('claude-code', id) : undefined;
}

function toolInputOf(input: JsonObject): JsonObject {
  return isObject(input.tool_input) ? input.tool_input : {};
}

function decision(value: JsonObject): JsonObject {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: value } };
}

/**
 * Without a watch the hook answers at once and the terminal dialog works as usual. Otherwise the
 * request goes to the watch while the terminal shows its dialog too; "answer on PC" and a timeout
 * leave it to the terminal. An answer in the terminal is noticed by the provider (registry status).
 */
async function permissionRequest(input: JsonObject, ctx: HookContext): Promise<JsonObject | undefined> {
  if (ctx.isAsk?.(str(input.session_id) ?? '')) return undefined;
  const sessionId = sessionOf(input);
  const tool = str(input.tool_name);
  if (!sessionId || !tool || !ctx.hub.pending.watchPresent()) return undefined;
  const toolInput = toolInputOf(input);
  if (tool === 'AskUserQuestion') {
    const answers = await ask(sessionId, toolInput, ctx);
    return answers && decision({ behavior: 'allow', updatedInput: { ...toolInput, answers } });
  }
  const suggestions = Array.isArray(input.permission_suggestions) ? input.permission_suggestions : [];
  const options: Option[] = [{ id: 'allow', label: 'Allow' }];
  if (suggestions.length > 0) {
    const description = describeSuggestions(suggestions);
    options.push(description ? { id: 'always', label: 'Always allow', description } : { id: 'always', label: 'Always allow' });
  }
  options.push({ id: 'deny', label: 'Deny' }, { id: 'defer', label: 'Answer on PC' });
  const answers = await ctx.hub.pending.open(
    {
      sessionId,
      kind: 'permission',
      title: tool,
      questions: [{ id: PERMISSION_QUESTION, text: permissionText(tool, toolInput), multi: false, options }],
    },
    { timeoutMs: ctx.waitMs, signal: ctx.signal },
  );
  switch (answers?.[PERMISSION_QUESTION]?.[0]) {
    case 'allow':
      return decision({ behavior: 'allow' });
    case 'always':
      return decision({ behavior: 'allow', updatedPermissions: suggestions });
    case 'deny':
      return decision({ behavior: 'deny', message: 'Denied from watch' });
    default:
      return undefined; // defer, timeout, or answered in the terminal
  }
}

/** Answers AskUserQuestion before it runs; used only where PermissionRequest does not fire for it. */
async function preToolUse(input: JsonObject, ctx: HookContext): Promise<JsonObject | undefined> {
  if (ctx.isAsk?.(str(input.session_id) ?? '')) return undefined;
  const sessionId = sessionOf(input);
  if (!sessionId || str(input.tool_name) !== 'AskUserQuestion' || !ctx.hub.pending.watchPresent()) return undefined;
  const toolInput = toolInputOf(input);
  const answers = await ask(sessionId, toolInput, ctx);
  return answers && { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...toolInput, answers } } };
}

/**
 * Turns AskUserQuestion's `questions` into a question request. The answers go back as
 * `{"<question text>": "<label>"}`, several labels of a multi-select joined by ", ".
 */
async function ask(sessionId: string, toolInput: JsonObject, ctx: HookContext): Promise<Record<string, string> | undefined> {
  const raw = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  const questions: Question[] = [];
  const texts: string[] = [];
  for (const [i, q] of raw.entries()) {
    const text = isObject(q) ? str(q.question) : undefined;
    if (!isObject(q) || !text) return undefined;
    const options: Option[] = [];
    for (const [j, o] of (Array.isArray(q.options) ? q.options : []).entries()) {
      const label = isObject(o) ? str(o.label) : undefined;
      if (!label) continue;
      const description = isObject(o) ? str(o.description) : undefined;
      options.push(description ? { id: String(j), label, description } : { id: String(j), label });
    }
    // A question the watch cannot show is left to the terminal.
    if (options.length === 0) return undefined;
    const id = `q${i + 1}`;
    const header = str(q.header);
    const shown = clip(text, PERMISSION_TEXT_MAX);
    const multi = q.multiSelect === true;
    questions.push(header ? { id, header, text: shown, multi, options } : { id, text: shown, multi, options });
    texts.push(text);
  }
  if (questions.length === 0) return undefined;
  const answers = await ctx.hub.pending.open({ sessionId, kind: 'question', title: 'Question', questions }, { timeoutMs: ctx.waitMs, signal: ctx.signal });
  if (!answers) return undefined;
  const out: Record<string, string> = {};
  questions.forEach((q, i) => {
    const picked = answers[q.id] ?? [];
    out[texts[i] ?? q.text] = q.options
      .filter((o) => picked.includes(o.id))
      .map((o) => o.label)
      .join(', ');
  });
  return out;
}

function permissionText(tool: string, input: JsonObject): string {
  const text = tool === 'ExitPlanMode' ? str(input.plan) : toolSummary(tool, input, PERMISSION_TEXT_MAX);
  return clip(text?.trim() || tool, PERMISSION_TEXT_MAX);
}

/** A short description of what "always allow" would add, e.g. `Bash(npm run build:*)`. */
export function describeSuggestions(suggestions: unknown[]): string | undefined {
  const parts: string[] = [];
  for (const s of suggestions) {
    if (!isObject(s)) continue;
    if (s.type === 'addRules' && Array.isArray(s.rules)) {
      for (const rule of s.rules) {
        const tool = isObject(rule) ? str(rule.toolName) : undefined;
        const content = isObject(rule) ? str(rule.ruleContent) : undefined;
        if (tool) parts.push(content ? `${tool}(${content})` : tool);
      }
    } else if (s.type === 'setMode' && str(s.mode)) {
      parts.push(`mode: ${str(s.mode)}`);
    } else if (s.type === 'addDirectories' && Array.isArray(s.directories)) {
      parts.push(...s.directories.filter((d) => typeof d === 'string'));
    }
  }
  return parts.length > 0 ? clip(parts.join(', '), ALERT_TEXT_MAX) : undefined;
}

function notification(input: JsonObject, ctx: HookContext): void {
  if (ctx.isAsk?.(str(input.session_id) ?? '')) return;
  const sessionId = sessionOf(input);
  if (!sessionId || !NEEDS_INPUT.has(str(input.notification_type) ?? '')) return;
  // An open request already told the watch.
  if (ctx.hub.pending.hasSession(sessionId)) return;
  const message = str(input.message);
  ctx.hub.alert(sessionId, 'needs_input', message ? clip(oneLine(message), ALERT_TEXT_MAX) : undefined);
}

/**
 * Same rule as the user's Slack Stop hook: nothing for an empty, short or "No response requested."
 * answer; otherwise the answer's head, titled by the prompt of a human-typed turn, else the session title.
 */
async function stop(input: JsonObject, ctx: HookContext): Promise<void> {
  if (ctx.isAsk?.(str(input.session_id) ?? '')) return;
  const sessionId = sessionOf(input);
  if (!sessionId) return;
  const answer = (str(input.last_assistant_message) ?? '').trim();
  if ([...answer].length < DONE_MIN || NO_RESPONSE.test(answer)) return;
  const prompt = oneLine((await humanPrompt(str(input.transcript_path))) ?? '');
  const title = prompt ? clip(prompt, DONE_TITLE_MAX) : ctx.hub.sessions().find((s) => s.id === sessionId)?.title;
  ctx.hub.alert(sessionId, 'done', clip(answer, DONE_TEXT_MAX), title || undefined);
}
