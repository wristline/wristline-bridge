// Rollout files of a Codex home ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl).
//
// A rewind (`thread/revert`) keeps the thread id but continues it in a new file named
// `rollout-<time>-<thread id>_<segment id>.jsonl`, whose `session_meta.history_base` says which
// prefix of the earlier file (thread id, ordinal and byte offset) still counts. The old file gets
// no further writes. The thread's current file is therefore its newest one, and its full history
// is the chain of `history_base` prefixes followed by the current file.

import { readdir, stat, open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { JsonlHead } from '../../jsonl.ts';
import { isNotFound, isObject, num, parseJson, str } from '../../util.ts';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROLLOUT = new RegExp(`^rollout-.*?(${UUID})(?:_${UUID})?\\.jsonl$`, 'i');
const FIRST_LINE_MAX = 1 << 20;
const CHAIN_MAX = 16;

export interface RolloutFile {
  path: string;
  mtimeMs: number;
  size: number;
  /** Earlier files of the same thread (before a rewind), newest first. */
  previous: RolloutFile[];
}

/** Maps thread id to its current rollout; undefined when sessions/ is missing. */
export async function scanRollouts(dir: string): Promise<Map<string, RolloutFile> | undefined> {
  let names: string[];
  try {
    names = await readdir(dir, { recursive: true });
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  const files = new Map<string, RolloutFile>();
  for (const name of names.sort()) {
    const id = ROLLOUT.exec(basename(name))?.[1]?.toLowerCase();
    if (!id) continue;
    const path = join(dir, name);
    let file: RolloutFile;
    try {
      const st = await stat(path);
      file = { path, mtimeMs: st.mtimeMs, size: st.size, previous: [] };
    } catch {
      continue; // Deleted between readdir and stat.
    }
    const current = files.get(id);
    // Later start time wins a tie: the rewound file is written after the original.
    if (!current || file.mtimeMs >= current.mtimeMs) {
      file.previous = current ? [current, ...current.previous] : [];
      files.set(id, file);
    } else {
      current.previous.unshift(file);
      current.previous.sort((a, b) => b.mtimeMs - a.mtimeMs);
    }
  }
  return files;
}

/** What the first line (`session_meta`) of a rollout says about where its history starts. */
export interface RolloutStart {
  /** `ordinal` of the first line; 0 for rollouts that number nothing. */
  ordinal: number;
  base: { threadId: string; endOrdinal: number; endByteOffset: number } | undefined;
}

/** Undefined while the file has no complete first line yet. */
export async function readRolloutStart(path: string): Promise<RolloutStart | undefined> {
  const line = await readFirstLine(path);
  if (line === undefined) return undefined;
  const rec = parseJson(line);
  const payload = rec && isObject(rec.payload) ? rec.payload : undefined;
  const hb = payload && isObject(payload.history_base) ? payload.history_base : undefined;
  const threadId = str(hb?.thread_id)?.toLowerCase();
  const endOrdinal = num(hb?.end_ordinal_exclusive);
  const endByteOffset = num(hb?.end_byte_offset);
  return {
    ordinal: num(rec?.ordinal) ?? 0,
    base: threadId && endOrdinal !== undefined && endByteOffset !== undefined ? { threadId, endOrdinal, endByteOffset } : undefined,
  };
}

async function readFirstLine(path: string): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, 'r');
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < FIRST_LINE_MAX) {
      const chunk = Buffer.allocUnsafe(1 << 16);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      const nl = chunk.indexOf(0x0a);
      if (nl !== -1 && nl < bytesRead) {
        chunks.push(chunk.subarray(0, nl));
        return Buffer.concat(chunks).toString('utf8');
      }
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    return undefined;
  } finally {
    await file.close();
  }
}

/**
 * The files whose lines precede `file`'s own, oldest first, each cut where the next one's
 * history starts. The base of a file is, among the rollouts of the thread `history_base` names,
 * the newest one that starts before the base's end ordinal and holds its end offset; the chain
 * follows the base's own `history_base` in turn. `starts` memoises first lines by path.
 */
export async function historyHead(file: RolloutFile, files: ReadonlyMap<string, RolloutFile>, starts: (path: string) => Promise<RolloutStart | undefined>): Promise<{ head: JsonlHead[]; baseThreadId: string | undefined }> {
  const head: JsonlHead[] = [];
  let current = file;
  let baseThreadId: string | undefined;
  for (let depth = 0; depth < CHAIN_MAX; depth++) {
    const base = (await starts(current.path))?.base;
    if (!base) break;
    baseThreadId ??= base.threadId;
    const thread = files.get(base.threadId);
    let found: RolloutFile | undefined;
    let foundOrdinal = -1;
    for (const candidate of thread ? [thread, ...thread.previous] : []) {
      if (candidate.path === current.path || candidate.size < base.endByteOffset || head.some((h) => h.path === candidate.path)) continue;
      const ordinal = (await starts(candidate.path))?.ordinal ?? 0;
      // Newest first: among equal starts the later file was current when the rewind happened.
      if (ordinal < base.endOrdinal && ordinal > foundOrdinal) {
        found = candidate;
        foundOrdinal = ordinal;
      }
    }
    if (!found) break;
    head.unshift({ path: found.path, end: base.endByteOffset });
    current = found;
  }
  return { head, baseThreadId };
}
