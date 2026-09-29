// Which account a Claude Code home is logged into, and the pure timeline rules that attribute
// sessions to logins. Only `oauthAccount` of `.claude.json` is read; `.credentials.json` never is.
// Verified against Claude Code 2.1.284.

import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LoginEntry } from '../../config.ts';
import type { Account } from '../../protocol.ts';
import { isNotFound, isObject, printable, str, toIso, type JsonObject } from '../../util.ts';

/** Logins remembered per home; older ones are forgotten. */
export const LOGINS_MAX = 20;

/**
 * Claude Code writes `.claude.json` into `$CLAUDE_CONFIG_DIR`, or into `$HOME` when the variable
 * is unset (the default `~/.claude` home): the file inside the home wins when it exists.
 */
export async function claudeJsonPath(home: string, homeDir = homedir()): Promise<string> {
  const inHome = join(home, '.claude.json');
  if (resolve(home) !== join(homeDir, '.claude')) return inHome;
  try {
    await access(inHome);
    return inHome;
  } catch {
    return join(homeDir, '.claude.json');
  }
}

/** The home's current login, or undefined when logged out or using an API key. Rejects on invalid JSON. */
export async function readClaudeAccount(home: string, homeDir = homedir()): Promise<Account | undefined> {
  const path = await claudeJsonPath(home, homeDir);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const oauth = isObject(raw) && isObject(raw.oauthAccount) ? raw.oauthAccount : undefined;
  const id = str(oauth?.accountUuid);
  if (!id) return undefined;
  // The label is printed by `setup` and `accounts`: control characters in it could rewrite a prompt line.
  return { id, label: printable(str(oauth?.emailAddress) ?? '') || printable(str(oauth?.organizationName) ?? '') || id.slice(0, 8) };
}

/**
 * Records `account` as the home's newest login when it differs from the last entry; the same id
 * only refreshes the label. Returns `logins` itself when nothing changed.
 */
export function appendLogin(logins: LoginEntry[], account: Account, now: number): LoginEntry[] {
  const last = logins.at(-1);
  if (last?.id === account.id) {
    return last.label === account.label ? logins : [...logins.slice(0, -1), { ...last, label: account.label }];
  }
  return [...logins, { at: new Date(now).toISOString(), id: account.id, label: account.label }].slice(-LOGINS_MAX);
}

/** The login in effect at `atMs`: the last entry observed at or before it; none before the first observation. */
export function loginAt(logins: LoginEntry[], atMs: number): LoginEntry | undefined {
  return logins.findLast((entry) => Date.parse(entry.at) <= atMs);
}

/**
 * A time-based attribution is a guess when the home has been logged into more than one account,
 * or when the process started before the bridge first observed a login there.
 */
export function isEstimated(logins: LoginEntry[], startedAt?: number): boolean {
  const first = logins[0];
  if (!first) return false;
  if (new Set(logins.map((entry) => entry.id)).size > 1) return true;
  return startedAt !== undefined && startedAt < Date.parse(first.at);
}

/** A statusLine's `resets_at` (7d, else 5h) as ISO: the same for every process of one account, different across accounts. */
export function statuslineFingerprint(input: JsonObject): string | undefined {
  const limits = input.rate_limits;
  if (!isObject(limits)) return undefined;
  for (const key of ['seven_day', 'five_hour']) {
    const window = limits[key];
    const resetsAt = isObject(window) ? toIso(window.resets_at) : undefined;
    if (resetsAt) return resetsAt;
  }
  return undefined;
}
