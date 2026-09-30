// What a Claude Code home keeps on disk for the bridge to read: the live-session registry
// (`sessions/<pid>.json`) with the process checks behind it, and the transcripts under `projects/`.
// Verified against Claude Code 2.1.284.

import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SessionStatus } from '../../protocol.ts';
import { isNotFound, isObject, num, str } from '../../util.ts';

const LIVE_MAX_AGE_MS = 24 * 3600_000;
/** Without procfs (macOS) the registry's pid is trusted; with it, an unreadable process has exited. */
const HAS_PROCFS = existsSync('/proc/self/stat');

export interface TranscriptFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/** The name of a cwd's directory under `projects/`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string | undefined;
  name: string | undefined;
  nameSource: string | undefined;
  status: string | undefined;
  tmux: string | undefined;
  startedAt: number | undefined;
  updatedAt: number;
  statusUpdatedAt: number;
  procStart: string | undefined;
  version: string | undefined;
}

/** The registry's `tmux` is `"<session>:@<window>.%<pane>"`; prompts target the `%<pane>` id. */
export function tmuxPane(value: string | undefined): string | undefined {
  const pane = value?.slice(value.lastIndexOf('.') + 1);
  return pane && /^%\d+$/.test(pane) ? pane : undefined;
}

/** Walks the parent chain in /proc; without procfs (macOS) the registry is trusted. */
export function descendsFrom(pid: number, ancestor: number): boolean {
  for (let p = pid, hops = 0; p > 1 && hops < 64; hops++) {
    if (p === ancestor) return true;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${p}/stat`, 'utf8');
    } catch {
      return !HAS_PROCFS && hops === 0;
    }
    p = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  }
  return false;
}

export function mapStatus(status: string | undefined): SessionStatus {
  switch (status) {
    case 'busy':
    case 'running':
    case 'shell':
      return 'running';
    case 'waiting':
    case 'needs_input':
      return 'needs_input';
    case 'exited':
      return 'ended';
    default:
      return 'idle';
  }
}

/** `updatedAt` is not a heartbeat (an idle session keeps it for days), so the age cap only applies without a pid-reuse guard. */
export function isLive(entry: RegistryEntry, now: number): boolean {
  if (!pidAlive(entry.pid)) return false;
  return entry.procStart && HAS_PROCFS ? sameProcess(entry) : now - entry.updatedAt < LIVE_MAX_AGE_MS;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isObject(err) && err.code === 'EPERM';
  }
}

/** Guards against pid reuse: `procStart` is field 22 (starttime) of /proc/<pid>/stat. */
export function sameProcess(entry: { pid: number; procStart: string | undefined }): boolean {
  if (!entry.procStart) return true;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${entry.pid}/stat`, 'utf8');
  } catch {
    return !HAS_PROCFS; // No procfs (macOS): fall back to the pid check alone.
  }
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return fields[19] === entry.procStart;
}

/** Reads `<pid>.json` entries only; the neighbouring `*.key` files are secrets and never opened. */
export async function readRegistry(dir: string): Promise<RegistryEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const entries = await Promise.all(names.filter((name) => /^\d+\.json$/.test(name)).map((name) => readEntry(join(dir, name))));
  return entries.filter((e) => e !== undefined);
}

export async function readEntry(path: string): Promise<RegistryEntry | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined; // Removed or half-written; the next refresh sees it.
  }
  if (!isObject(raw)) return undefined;
  const pid = num(raw.pid);
  const sessionId = str(raw.sessionId);
  const startedAt = num(raw.startedAt);
  const updatedAt = num(raw.updatedAt) ?? startedAt;
  if (pid === undefined || !sessionId || updatedAt === undefined) return undefined;
  return {
    pid,
    sessionId,
    startedAt,
    updatedAt,
    statusUpdatedAt: num(raw.statusUpdatedAt) ?? updatedAt,
    cwd: str(raw.cwd),
    name: str(raw.name),
    nameSource: str(raw.nameSource),
    status: str(raw.status),
    tmux: str(raw.tmux),
    procStart: str(raw.procStart),
    version: str(raw.version),
  };
}

/** Maps session id to `projects/<slug>/<sessionId>.jsonl`; undefined when projects/ is missing. */
export async function scanTranscripts(dir: string): Promise<Map<string, TranscriptFile> | undefined> {
  let slugs;
  try {
    slugs = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  const files = new Map<string, TranscriptFile>();
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    let names: string[];
    try {
      names = await readdir(join(dir, slug.name));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, slug.name, name);
      try {
        const st = await stat(path);
        const id = basename(name, '.jsonl');
        const prev = files.get(id);
        if (!prev || prev.mtimeMs < st.mtimeMs) files.set(id, { path, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // Deleted between readdir and stat.
      }
    }
  }
  return files;
}
