// Claude Code settings.json: the merge that installs the hooks of hooks.ts, the generated
// statusLine relay script and the install/uninstall steps on disk. Verified against Claude Code 2.1.284.

import { chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CliError, isNotFound, isObject, parseJson, str, type JsonObject } from '../../util.ts';

const EVENTS = [
  ['PermissionRequest', 'permission-request'],
  ['Notification', 'notification'],
  ['Stop', 'stop'],
] as const;

export interface HookSettings {
  hookPort: number;
  /** Seconds Claude Code waits for the PermissionRequest hook; a little over permissionWaitSec. */
  permissionTimeoutSec: number;
  /** The statusLine command that runs the generated relay script. */
  statuslineCommand: string;
  /** `hook-header` file that the command hooks pass to curl. */
  headerFile: string;
  /** Directory of the generated files; a statusLine command or hook.sh already pointing into it is ours, not the user's. */
  configDir: string;
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

/** `<hook.sh> <name>` as ourHandler writes it; the script may be shell-quoted. */
const HOOK_SCRIPT_COMMAND = /^('(?:[^']|'\\'')*'|[^\s']+) ([a-z-]+)$/s;

/**
 * The hook name an installed handler of ours calls: the argument of our hook.sh, the URL in our
 * curl command, or the url of the http hook (with the token in a header) that earlier versions installed.
 */
function ourHook(handler: unknown, configDir: string): string | undefined {
  if (!isObject(handler)) return undefined;
  if (handler.type === 'command' && typeof handler.command === 'string') {
    const [, word, name] = HOOK_SCRIPT_COMMAND.exec(handler.command) ?? [];
    if (word && name && resolve(unquote(word)) === resolve(hookFiles(configDir).hook)) return name;
  }
  const text = handler.type === 'http' ? handler.url : handler.type === 'command' ? handler.command : undefined;
  return typeof text === 'string' ? OUR_URL.exec(text)?.[1] : undefined;
}

/**
 * PermissionRequest must answer: hook.sh prints the bridge's answer, reading the token from
 * hook-header so that settings.json holds no secret (an http hook would need it in a header).
 * Notification and Stop only inform the bridge: async curl commands never delay Claude Code and
 * stay quiet while the bridge is stopped (an http hook would print "hook error: ECONNREFUSED"
 * after every turn).
 */
function ourHandler(event: (typeof EVENTS)[number][0], name: string, url: string, opts: HookSettings): JsonObject {
  if (event === 'PermissionRequest') {
    return { type: 'command', command: `${shellQuote(hookFiles(opts.configDir).hook)} ${name}`, timeout: opts.permissionTimeoutSec };
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
    const handler = ourHandler(event, name, url, opts);
    if (hooks[event] === undefined) hooks[event] = [];
    const groups = hooks[event];
    if (!Array.isArray(groups)) throw new Error(`"hooks.${event}" in the settings file is not an array; fix it first`);
    // Re-running install refreshes our handler where it is instead of adding another one.
    const mine = (h: unknown): boolean => ourHook(h, opts.configDir) === name;
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
      // Another home's relay (a copied settings file) is replaced, not saved as the original: it would relay twice.
      statuslineOrig = isRelay(command, opts.configDir) ? undefined : command;
      line.command = opts.statuslineCommand;
    }
  }
  return { settings, statuslineOrig };
}

/** A word as shellQuote wrote it, unquoted. */
function unquote(word: string): string {
  return /^'(.*)'$/s.exec(word)?.[1]?.replace(/'\\''/g, "'") ?? word;
}

/** A statusLine command that runs one of our relay scripts (`<configDir>/statusline*.sh`), possibly shell-quoted. */
function isRelay(command: string, configDir: string): boolean {
  const word = unquote(command);
  return resolve(dirname(word)) === resolve(configDir) && /^statusline.*\.sh$/.test(basename(word));
}

/**
 * Removes only our handlers (and arrays or groups that held nothing else) and restores the
 * statusLine command saved in statusline.orig; an empty or missing one means there was none.
 */
export function withoutHooks(original: JsonObject, opts: { statuslineCommand: string; statuslineOrig: string | null; configDir: string }): JsonObject {
  const settings = structuredClone(original);
  if (isObject(settings.hooks)) {
    const hooks = settings.hooks;
    let removed = false;
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      let touched = false;
      const kept = groups.flatMap((g: unknown) => {
        if (!isObject(g) || !Array.isArray(g.hooks)) return [g];
        const rest = g.hooks.filter((h: unknown) => ourHook(h, opts.configDir) === undefined);
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
  /** `Authorization: Bearer <hookToken>` for curl's `-H @file`, so the token stays out of `ps` and settings.json. */
  header: string;
  /** The PermissionRequest command: `hook.sh <name>` posts stdin to the bridge and prints its answer. */
  hook: string;
}

/** The relay files of one Claude home: `statusline<suffix>.*` (no suffix for the primary home); `hook-header` and `hook.sh` are shared. */
export function hookFiles(configDir: string, suffix = ''): HookFiles {
  return {
    script: join(configDir, `statusline${suffix}.sh`),
    orig: join(configDir, `statusline${suffix}.orig`),
    owner: join(configDir, `statusline${suffix}.owner`),
    header: join(configDir, 'hook-header'),
    hook: join(configDir, 'hook.sh'),
  };
}

export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The relay posts the statusLine JSON in the background (at most 1 s, never blocking the status
 * line) and then pipes it to the original command. Without one it prints nothing.
 */
export function statuslineScript(configDir: string, hookPort: number, suffix = ''): string {
  const files = hookFiles(configDir, suffix);
  return `#!/bin/sh
# Generated by \`wristline-bridge hooks install\`; \`wristline-bridge hooks uninstall\` removes it.
# Sends the Claude Code statusLine JSON to the Wristline bridge (plan usage and context for the
# watch), then runs your original statusLine command, saved in ${basename(files.orig)}.
input=$(cat)
printf '%s' "$input" | curl -s -m 1 -H @${shellQuote(files.header)} -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${hookPort}/local/statusline >/dev/null 2>&1 &
[ -s ${shellQuote(files.orig)} ] || exit 0
printf '%s' "$input" | /bin/sh -c "$(cat ${shellQuote(files.orig)})"
`;
}

/**
 * `hook.sh <name>` posts the hook's JSON to `/hooks/<name>` and prints the answer, which Claude
 * Code reads like an http hook's response body. When the bridge is stopped, refuses (-f) or
 * times out it prints nothing and exits 0: no decision, so Claude Code shows its terminal dialog.
 */
export function hookScript(configDir: string, hookPort: number, timeoutSec: number): string {
  const files = hookFiles(configDir);
  return `#!/bin/sh
# Generated by \`wristline-bridge hooks install\`; \`wristline-bridge hooks uninstall\` removes it.
# Claude Code runs \`hook.sh <name>\` for a hook that must answer (PermissionRequest): it posts the
# hook's JSON to the Wristline bridge with the token from ${basename(files.header)} and prints the answer.
# On any failure it prints nothing and exits 0, so Claude Code carries on as without the hook.
out=$(curl -sf -m ${timeoutSec} -H @${shellQuote(files.header)} -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:${hookPort}/hooks/$1") || exit 0
printf '%s' "$out"
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
  hookToken: string;
  /** Names this home's relay files (`statusline<suffix>.sh`); empty for the primary home. */
  suffix?: string;
}

export async function planInstall(opts: InstallOptions): Promise<InstallPlan> {
  const before = await readText(opts.settingsPath);
  const { settings, statuslineOrig } = withHooks(parseSettings(opts.settingsPath, before), opts);
  // One statusline.orig serves one settings file; installing into a second would overwrite it. In
  // the file it came from, a command that replaced the relay (e.g. via /statusline) is the new original.
  const files = hookFiles(opts.configDir, opts.suffix);
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

export async function planUninstall(opts: { settingsPath: string; configDir: string; statuslineCommand: string; suffix?: string }): Promise<SettingsChange> {
  const before = await readText(opts.settingsPath);
  if (before === undefined) return { path: opts.settingsPath, before, after: '' };
  const statuslineOrig = (await readText(hookFiles(opts.configDir, opts.suffix).orig)) ?? null;
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

/** Atomic replace that follows a symlinked settings file and keeps its mode. */
async function replaceFile(path: string, text: string): Promise<void> {
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
  await writeFile(tmp, text, { mode: kept });
  await rename(tmp, target);
}

/** Claude Code may write the settings file (e.g. for /statusline) while the diff waits for an answer. */
async function assertUnchanged(path: string, before: string | undefined): Promise<void> {
  if ((await readText(path)) !== before) throw new CliError(`${path} changed since the diff was made; run the command again.`);
}

/** Writes the relay files, backs up the settings file and replaces it. Resolves the backup path. */
export async function applyInstall(plan: InstallPlan, opts: InstallOptions, now = new Date()): Promise<string | undefined> {
  await assertUnchanged(plan.path, plan.before);
  const files = hookFiles(opts.configDir, opts.suffix);
  await mkdir(opts.configDir, { recursive: true, mode: 0o700 });
  await writePrivate(files.header, hookHeader(opts.hookToken), 0o600);
  await writePrivate(files.hook, hookScript(opts.configDir, opts.hookPort, opts.permissionTimeoutSec), 0o700);
  await writePrivate(files.script, statuslineScript(opts.configDir, opts.hookPort, opts.suffix), 0o700);
  if (plan.statuslineOrig !== undefined) await writePrivate(files.orig, plan.statuslineOrig ?? '', 0o600);
  await writePrivate(files.owner, resolve(opts.settingsPath), 0o600);
  if (plan.after === plan.before) return undefined;
  const saved = plan.before === undefined ? undefined : await backup(opts.configDir, plan.before, now);
  await replaceFile(plan.path, plan.after);
  return saved;
}

/** Removes this home's relay files; the shared header and hook.sh go once no relay script of another home remains. */
export async function applyUninstall(change: SettingsChange, configDir: string, suffix = '', now = new Date()): Promise<string | undefined> {
  await assertUnchanged(change.path, change.before);
  let saved: string | undefined;
  if (change.before !== undefined && change.after !== change.before) {
    saved = await backup(configDir, change.before, now);
    await replaceFile(change.path, change.after);
  }
  const files = hookFiles(configDir, suffix);
  await Promise.all([files.script, files.orig, files.owner].map((f) => rm(f, { force: true })));
  const left = await readdir(configDir).catch(() => []);
  if (!left.some((name) => /^statusline.*\.sh$/.test(name))) await Promise.all([files.header, files.hook].map((f) => rm(f, { force: true })));
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
