import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isNotFound, isObject, num, str, type JsonObject } from './util.ts';

export interface Device {
  id: string;
  name: string;
  tokenSha256: string;
  createdAt: string;
}

export interface Bins {
  codex?: string;
  tmux?: string;
  tailscale?: string;
}

/** A login the bridge saw in a Claude Code home; `at` is when the bridge first observed it (not a file mtime). */
export interface LoginEntry {
  at: string;
  id: string;
  label: string;
}

export interface Config {
  apiPort: number;
  hookPort: number;
  publicUrl?: string;
  hookToken?: string;
  devices: Device[];
  claudeHome: string;
  codexHome: string;
  /** `[claudeHome, ...extraClaudeHomes]` without duplicates; one provider instance runs per home. */
  claudeHomes: string[];
  codexHomes: string[];
  /** Claude home → logins observed there, oldest first. */
  claudeLogins: Record<string, LoginEntry[]>;
  /** Codex `chatgpt_account_id` → email. */
  codexAccounts: Record<string, string>;
  /** Account id → short label chosen by the user. */
  labels: Record<string, string>;
  bins: Bins;
  permissionWaitSec: number;
  historyDays: number;
}

/** What `config.json` holds; every key is optional. */
export interface StoredConfig extends Partial<Omit<Config, 'claudeHomes' | 'codexHomes'>> {
  extraClaudeHomes?: string[];
  extraCodexHomes?: string[];
}

/** Values given on the command line; they beat env, config.json and defaults. */
export interface Flags {
  apiPort?: number;
  hookPort?: number;
  claudeHome?: string;
  codexHome?: string;
}

export type Env = Record<string, string | undefined>;

export function configDir(env: Env = process.env, home = homedir()): string {
  const base = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(base, 'wristline');
}

export function configPath(dir: string): string {
  return join(dir, 'config.json');
}

/** Precedence: CLI flag > env (CLAUDE_CONFIG_DIR, CODEX_HOME) > config.json > default. */
export function resolveConfig(stored: StoredConfig, flags: Flags = {}, env: Env = process.env, home = homedir()): Config {
  const claudeHome = flags.claudeHome ?? (env.CLAUDE_CONFIG_DIR || undefined) ?? stored.claudeHome ?? join(home, '.claude');
  const codexHome = flags.codexHome ?? (env.CODEX_HOME || undefined) ?? stored.codexHome ?? join(home, '.codex');
  return {
    apiPort: flags.apiPort ?? stored.apiPort ?? 47770,
    hookPort: flags.hookPort ?? stored.hookPort ?? 47771,
    publicUrl: stored.publicUrl,
    hookToken: stored.hookToken,
    devices: stored.devices ?? [],
    claudeHome,
    codexHome,
    claudeHomes: homes(claudeHome, stored.extraClaudeHomes),
    codexHomes: homes(codexHome, stored.extraCodexHomes),
    claudeLogins: stored.claudeLogins ?? {},
    codexAccounts: stored.codexAccounts ?? {},
    labels: stored.labels ?? {},
    bins: stored.bins ?? {},
    permissionWaitSec: stored.permissionWaitSec ?? 590,
    historyDays: stored.historyDays ?? 7,
  };
}

/** The primary first, then the extras that name a different directory (compared as resolved paths). */
function homes(primary: string, extra: string[] | undefined): string[] {
  const out: string[] = [];
  for (const home of [primary, ...(extra ?? [])]) {
    if (!out.some((h) => resolve(h) === resolve(home))) out.push(home);
  }
  return out;
}

export async function readStored(dir: string): Promise<StoredConfig> {
  let text: string;
  try {
    text = await readFile(configPath(dir), 'utf8');
  } catch (err) {
    if (isNotFound(err)) return {};
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${configPath(dir)} is not valid JSON`);
  }
  if (!isObject(raw)) throw new Error(`${configPath(dir)} must contain a JSON object`);
  return pickStored(raw);
}

/** Saves run one after another: concurrent ones (a revoke racing a pair) would share the temp file and lose a patch. */
let saving: Promise<unknown> = Promise.resolve();

/** Read-modify-write so a running bridge and `setup` only replace the keys they own. */
export function updateStored(dir: string, patch: StoredConfig): Promise<StoredConfig> {
  const result = saving.then(() => writeStored(dir, patch));
  saving = result.catch(() => {});
  return result;
}

async function writeStored(dir: string, patch: StoredConfig): Promise<StoredConfig> {
  const next = { ...(await readStored(dir)), ...patch };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = configPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return next;
}

function pickStored(raw: JsonObject): StoredConfig {
  const out: StoredConfig = {};
  const port = (v: unknown): number | undefined => {
    const n = num(v);
    return n !== undefined && Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
  };
  const positive = (v: unknown): number | undefined => {
    const n = num(v);
    return n !== undefined && n > 0 ? n : undefined;
  };
  const set = <K extends keyof StoredConfig>(key: K, value: StoredConfig[K] | undefined): void => {
    if (value !== undefined) out[key] = value;
  };
  set('apiPort', port(raw.apiPort));
  set('hookPort', port(raw.hookPort));
  set('publicUrl', str(raw.publicUrl));
  set('hookToken', str(raw.hookToken));
  set('claudeHome', str(raw.claudeHome));
  set('codexHome', str(raw.codexHome));
  set('permissionWaitSec', positive(raw.permissionWaitSec));
  set('historyDays', positive(raw.historyDays));
  if (Array.isArray(raw.devices)) set('devices', raw.devices.filter(isDevice));
  if (Array.isArray(raw.extraClaudeHomes)) set('extraClaudeHomes', raw.extraClaudeHomes.filter(isString));
  if (Array.isArray(raw.extraCodexHomes)) set('extraCodexHomes', raw.extraCodexHomes.filter(isString));
  if (isObject(raw.claudeLogins)) set('claudeLogins', pickRecord(raw.claudeLogins, (v) => (Array.isArray(v) ? v.filter(isLoginEntry) : undefined)));
  if (isObject(raw.codexAccounts)) set('codexAccounts', pickRecord(raw.codexAccounts, str));
  if (isObject(raw.labels)) set('labels', pickRecord(raw.labels, str));
  if (isObject(raw.bins)) {
    const bins = raw.bins;
    const picked: Bins = {};
    for (const key of ['codex', 'tmux', 'tailscale'] as const) {
      const value = str(bins[key]);
      if (value) picked[key] = value;
    }
    set('bins', picked);
  }
  return out;
}

function isDevice(value: unknown): value is Device {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.tokenSha256 === 'string' &&
    typeof value.createdAt === 'string'
  );
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isLoginEntry(value: unknown): value is LoginEntry {
  return isObject(value) && typeof value.at === 'string' && typeof value.id === 'string' && typeof value.label === 'string';
}

/** Keeps the keys whose value `pick` accepts. */
function pickRecord<T>(raw: JsonObject, pick: (value: unknown) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(raw)) {
    const picked = pick(value);
    if (picked !== undefined) out[key] = picked;
  }
  return out;
}
