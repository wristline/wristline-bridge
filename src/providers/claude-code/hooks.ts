// Claude Code hooks: the HTTP handlers served on the local port, the settings.json merge that
// installs them, and the statusLine relay script. Verified against Claude Code 2.1.284.

import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PERMISSION_QUESTION, type Option, type Question } from '../../protocol.ts';
import { sessionKey, type Hub } from '../../provider.ts';
import type { HookHandler } from '../../server.ts';
import { CliError, clip, isNotFound, isObject, oneLine, parseJson, str, type JsonObject } from '../../util.ts';
import { toolSummary } from './parse.ts';

export const HOOK_NAMES = ['permission-request', 'pre-tool-use', 'notification', 'stop'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/** Longest tool description (e.g. an ExitPlanMode plan) shown on a permission request. */
const PERMISSION_TEXT_MAX = 1500;
const ALERT_TEXT_MAX = 120;
/** Notifications that mean "the session waits for you" when no request is open for it. */
const NEEDS_INPUT = new Set(['permission_prompt', 'agent_needs_input']);

export interface HookContext {
  hub: Pick<Hub, 'pending' | 'alert'>;
  /** How long to wait for the watch before handing the decision back to the terminal. */
  waitMs: number;
  /** Aborted when Claude Code drops the hook request. */
  signal: AbortSignal;
}

/** Handlers for the local listener's `/hooks/<name>` routes. */
export function hookHandlers(hub: Hub, waitMs: number): Map<string, HookHandler> {
  return new Map(HOOK_NAMES.map((name) => [name, (input, signal) => handleHook(name, input, { hub, waitMs, signal })]));
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
      stop(input, ctx);
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
  const sessionId = sessionOf(input);
  if (!sessionId || !NEEDS_INPUT.has(str(input.notification_type) ?? '')) return;
  // An open request already told the watch.
  if (ctx.hub.pending.hasSession(sessionId)) return;
  const message = str(input.message);
  ctx.hub.alert(sessionId, 'needs_input', message ? clip(oneLine(message), ALERT_TEXT_MAX) : undefined);
}

function stop(input: JsonObject, ctx: HookContext): void {
  const sessionId = sessionOf(input);
  if (!sessionId) return;
  const last = str(input.last_assistant_message);
  ctx.hub.alert(sessionId, 'done', last ? clip(oneLine(last), ALERT_TEXT_MAX) : undefined);
}

// settings.json

const EVENTS = [
  ['PermissionRequest', 'permission-request'],
  ['Notification', 'notification'],
  ['Stop', 'stop'],
] as const;

export interface HookSettings {
  hookPort: number;
  hookToken: string;
  /** Seconds Claude Code waits for the PermissionRequest hook; a little over permissionWaitSec. */
  permissionTimeoutSec: number;
  /** The statusLine command that runs the generated relay script. */
  statuslineCommand: string;
  /** `hook-header` file that the command hooks pass to curl. */
  headerFile: string;
}

export interface Merged {
  settings: JsonObject;
  /**
   * The statusLine command replaced by the relay: a string to save in statusline.orig, null when
   * there was no statusLine, undefined when the relay was already installed (keep the saved one).
   */
  statuslineOrig: string | null | undefined;
}

/** The URL our handlers call, followed by the hook name. */
export function hookUrlPrefix(hookPort: number): string {
  return `http://127.0.0.1:${hookPort}/hooks/`;
}

/** Ours at any port: an installed handler keeps the port the bridge used at the time. */
const OUR_URL = /(?:^|\s)http:\/\/127\.0\.0\.1:\d+\/hooks\/(\S+)/;

/** The hook name an installed handler of ours calls: from an http hook's url, or the URL in our curl command. */
function ourHook(handler: unknown): string | undefined {
  if (!isObject(handler)) return undefined;
  const text = handler.type === 'http' ? handler.url : handler.type === 'command' ? handler.command : undefined;
  return typeof text === 'string' ? OUR_URL.exec(text)?.[1] : undefined;
}

function isOurs(handler: unknown): boolean {
  return ourHook(handler) !== undefined;
}

/**
 * PermissionRequest must answer, so it is an http hook. Notification and Stop only inform the
 * bridge: async curl commands never delay Claude Code and stay quiet while the bridge is stopped
 * (an http hook would print "hook error: ECONNREFUSED" after every turn).
 */
function ourHandler(event: (typeof EVENTS)[number][0], url: string, opts: HookSettings): JsonObject {
  if (event === 'PermissionRequest') {
    return { type: 'http', url, headers: { Authorization: `Bearer ${opts.hookToken}` }, timeout: opts.permissionTimeoutSec };
  }
  const command = `curl -s -m 2 -H @${shellQuote(opts.headerFile)} -H 'Content-Type: application/json' --data-binary @- ${url} >/dev/null 2>&1 || true`;
  return { type: 'command', command, async: true };
}

function hooksObject(settings: JsonObject): JsonObject {
  if (settings.hooks === undefined) settings.hooks = {};
  if (!isObject(settings.hooks)) throw new Error('"hooks" in the settings file is not an object; fix it first');
  return settings.hooks;
}

/** Appends our handlers (updating them in place when present) and wraps the statusLine command. */
export function withHooks(original: JsonObject, opts: HookSettings): Merged {
  const settings = structuredClone(original);
  const prefix = hookUrlPrefix(opts.hookPort);
  const hooks = hooksObject(settings);
  for (const [event, name] of EVENTS) {
    const url = `${prefix}${name}`;
    const handler = ourHandler(event, url, opts);
    if (hooks[event] === undefined) hooks[event] = [];
    const groups = hooks[event];
    if (!Array.isArray(groups)) throw new Error(`"hooks.${event}" in the settings file is not an array; fix it first`);
    // Re-running install refreshes our handler where it is instead of adding another one.
    const mine = (h: unknown): boolean => ourHook(h) === name;
    const group = groups.find((g: unknown) => isObject(g) && Array.isArray(g.hooks) && g.hooks.some(mine));
    if (isObject(group) && Array.isArray(group.hooks)) group.hooks = group.hooks.map((h: unknown) => (mine(h) ? handler : h));
    else groups.push({ hooks: [handler] });
  }

  let statuslineOrig: string | null | undefined;
  const line = settings.statusLine;
  if (line === undefined) {
    settings.statusLine = { type: 'command', command: opts.statuslineCommand };
    statuslineOrig = null;
  } else {
    const command = isObject(line) ? str(line.command) : undefined;
    if (!isObject(line) || command === undefined) throw new Error('"statusLine" in the settings file has no command; fix it first');
    if (command !== opts.statuslineCommand) {
      statuslineOrig = command;
      line.command = opts.statuslineCommand;
    }
  }
  return { settings, statuslineOrig };
}

/**
 * Removes only our handlers (and arrays or groups that held nothing else) and restores the
 * statusLine command saved in statusline.orig; an empty or missing one means there was none.
 */
export function withoutHooks(original: JsonObject, opts: { statuslineCommand: string; statuslineOrig: string | null }): JsonObject {
  const settings = structuredClone(original);
  if (isObject(settings.hooks)) {
    const hooks = settings.hooks;
    let removed = false;
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      let touched = false;
      const kept = groups.flatMap((g: unknown) => {
        if (!isObject(g) || !Array.isArray(g.hooks)) return [g];
        const rest = g.hooks.filter((h: unknown) => !isOurs(h));
        if (rest.length === g.hooks.length) return [g];
        touched = true;
        return rest.length === 0 ? [] : [{ ...g, hooks: rest }];
      });
      if (!touched) continue;
      removed = true;
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
    if (removed && Object.keys(hooks).length === 0) delete settings.hooks;
  }
  const line = settings.statusLine;
  if (isObject(line) && line.command === opts.statuslineCommand) {
    if (opts.statuslineOrig) line.command = opts.statuslineOrig;
    else delete settings.statusLine;
  }
  return settings;
}

// Generated files in the config directory.

export interface HookFiles {
  /** statusLine command: relays stdin to the bridge, then runs the original command. */
  script: string;
  /** The original statusLine command (empty when there was none). */
  orig: string;
  /** The settings file whose statusLine command `orig` holds. */
  owner: string;
  /** `Authorization: Bearer <hookToken>` for curl's `-H @file`, so the token stays out of `ps`. */
  header: string;
}

export function hookFiles(configDir: string): HookFiles {
  return {
    script: join(configDir, 'statusline.sh'),
    orig: join(configDir, 'statusline.orig'),
    owner: join(configDir, 'statusline.owner'),
    header: join(configDir, 'hook-header'),
  };
}

export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The relay posts the statusLine JSON in the background (at most 1 s, never blocking the status
 * line) and then pipes it to the original command. Without one it prints nothing.
 */
export function statuslineScript(configDir: string, hookPort: number): string {
  const files = hookFiles(configDir);
  return `#!/bin/sh
# Generated by \`wristline-bridge hooks install\`; \`wristline-bridge hooks uninstall\` removes it.
# Sends the Claude Code statusLine JSON to the Wristline bridge (plan usage and context for the
# watch), then runs your original statusLine command, saved in statusline.orig.
input=$(cat)
printf '%s' "$input" | curl -s -m 1 -H @${shellQuote(files.header)} -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${hookPort}/local/statusline >/dev/null 2>&1 &
[ -s ${shellQuote(files.orig)} ] || exit 0
printf '%s' "$input" | /bin/sh -c "$(cat ${shellQuote(files.orig)})"
`;
}

export function hookHeader(hookToken: string): string {
  return `Authorization: Bearer ${hookToken}\n`;
}

export interface SettingsChange {
  path: string;
  before: string | undefined;
  after: string;
}

export interface InstallPlan extends SettingsChange {
  statuslineOrig: string | null | undefined;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

function parseSettings(path: string, text: string | undefined): JsonObject {
  if (text === undefined || text.trim() === '') return {};
  const parsed = parseJson(text);
  if (!parsed) throw new Error(`${path} is not a JSON object; fix it before installing hooks`);
  return parsed;
}

function render(settings: JsonObject): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export interface InstallOptions extends HookSettings {
  settingsPath: string;
  configDir: string;
}

export async function planInstall(opts: InstallOptions): Promise<InstallPlan> {
  const before = await readText(opts.settingsPath);
  const { settings, statuslineOrig } = withHooks(parseSettings(opts.settingsPath, before), opts);
  // One statusline.orig serves one settings file; installing into a second would overwrite it. In
  // the file it came from, a command that replaced the relay (e.g. via /statusline) is the new original.
  const files = hookFiles(opts.configDir);
  if (statuslineOrig !== undefined && (await readText(files.orig)) !== undefined) {
    const owner = await readText(files.owner);
    if (owner !== resolve(opts.settingsPath)) {
      throw new Error(
        `The statusLine relay is already installed for another settings file (${owner ?? `${files.orig} exists`}). Uninstall it there first.`,
      );
    }
  }
  return { path: opts.settingsPath, before, after: render(settings), statuslineOrig };
}

export async function planUninstall(opts: { settingsPath: string; configDir: string; statuslineCommand: string }): Promise<SettingsChange> {
  const before = await readText(opts.settingsPath);
  if (before === undefined) return { path: opts.settingsPath, before, after: '' };
  const statuslineOrig = (await readText(hookFiles(opts.configDir).orig)) ?? null;
  const settings = withoutHooks(parseSettings(opts.settingsPath, before), { ...opts, statuslineOrig });
  return { path: opts.settingsPath, before, after: render(settings) };
}

async function writePrivate(path: string, text: string, mode: number): Promise<void> {
  await writeFile(path, text, { mode });
  await chmod(path, mode);
}

/** Copies the settings file to `<configDir>/backups/settings-<timestamp>.json`. */
async function backup(configDir: string, text: string, now: Date): Promise<string> {
  const dir = join(configDir, 'backups');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `settings-${now.toISOString().replace(/[:.]/g, '-')}.json`);
  await writePrivate(path, text, 0o600);
  return path;
}

/** Atomic replace that follows a symlinked settings file and keeps its mode unless one is given. */
async function replaceFile(path: string, text: string, mode?: number): Promise<void> {
  let target = path;
  let kept = 0o644;
  try {
    target = await realpath(path);
    kept = (await stat(target)).mode & 0o777;
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await mkdir(dirname(path), { recursive: true });
  }
  const tmp = `${target}.wristline-${process.pid}.tmp`;
  await writeFile(tmp, text, { mode: mode ?? kept });
  await rename(tmp, target);
}

/** Claude Code may write the settings file (e.g. for /statusline) while the diff waits for an answer. */
async function assertUnchanged(path: string, before: string | undefined): Promise<void> {
  if ((await readText(path)) !== before) throw new CliError(`${path} changed since the diff was made; run the command again.`);
}

/** Writes the relay files, backs up the settings file and replaces it. Resolves the backup path. */
export async function applyInstall(plan: InstallPlan, opts: InstallOptions, now = new Date()): Promise<string | undefined> {
  await assertUnchanged(plan.path, plan.before);
  const files = hookFiles(opts.configDir);
  await mkdir(opts.configDir, { recursive: true, mode: 0o700 });
  await writePrivate(files.header, hookHeader(opts.hookToken), 0o600);
  await writePrivate(files.script, statuslineScript(opts.configDir, opts.hookPort), 0o700);
  if (plan.statuslineOrig !== undefined) await writePrivate(files.orig, plan.statuslineOrig ?? '', 0o600);
  await writePrivate(files.owner, resolve(opts.settingsPath), 0o600);
  // The settings file holds the hook token, so it is private like config.json.
  if (plan.after === plan.before) {
    await chmod(plan.path, 0o600);
    return undefined;
  }
  const saved = plan.before === undefined ? undefined : await backup(opts.configDir, plan.before, now);
  await replaceFile(plan.path, plan.after, 0o600);
  return saved;
}

export async function applyUninstall(change: SettingsChange, configDir: string, now = new Date()): Promise<string | undefined> {
  await assertUnchanged(change.path, change.before);
  let saved: string | undefined;
  if (change.before !== undefined && change.after !== change.before) {
    saved = await backup(configDir, change.before, now);
    await replaceFile(change.path, change.after);
  }
  const files = hookFiles(configDir);
  await Promise.all([files.script, files.orig, files.owner, files.header].map((f) => rm(f, { force: true })));
  return saved;
}

/** A line diff of two texts with `context` unchanged lines around each change. */
export function lineDiff(before: string, after: string, context = 3): string {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  const at = (i: number, j: number): number => lcs[i]?.[j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    for (let j = b.length - 1; j >= 0; j--) row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  }
  const ops: [string, string][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push([' ', a[i] ?? '']);
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || at(i + 1, j) >= at(i, j + 1))) {
      ops.push(['-', a[i++] ?? '']);
    } else {
      ops.push(['+', b[j++] ?? '']);
    }
  }
  const changed = ops.map(([op]) => op !== ' ');
  const out: string[] = [];
  let gap = false;
  ops.forEach(([op, line], k) => {
    if (changed.slice(Math.max(0, k - context), k + context + 1).some(Boolean)) {
      out.push(`${op} ${line}`);
      gap = false;
    } else if (!gap) {
      out.push('  …');
      gap = true;
    }
  });
  return out.join('\n');
}
