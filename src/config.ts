import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

export interface Config {
  apiPort: number;
  hookPort: number;
  publicUrl?: string;
  hookToken?: string;
  devices: Device[];
  claudeHome: string;
  codexHome: string;
  bins: Bins;
  permissionWaitSec: number;
  historyDays: number;
}

/** What `config.json` holds; every key is optional. */
export type StoredConfig = Partial<Config>;

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
  return {
    apiPort: flags.apiPort ?? stored.apiPort ?? 47770,
    hookPort: flags.hookPort ?? stored.hookPort ?? 47771,
    publicUrl: stored.publicUrl,
    hookToken: stored.hookToken,
    devices: stored.devices ?? [],
    claudeHome: flags.claudeHome ?? (env.CLAUDE_CONFIG_DIR || undefined) ?? stored.claudeHome ?? join(home, '.claude'),
    codexHome: flags.codexHome ?? (env.CODEX_HOME || undefined) ?? stored.codexHome ?? join(home, '.codex'),
    bins: stored.bins ?? {},
    permissionWaitSec: stored.permissionWaitSec ?? 590,
    historyDays: stored.historyDays ?? 7,
  };
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

/** Read-modify-write so a running bridge and `setup` only replace the keys they own. */
export async function updateStored(dir: string, patch: StoredConfig): Promise<StoredConfig> {
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
