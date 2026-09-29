// Rollout files of a Codex home ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl).

import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isNotFound } from '../../util.ts';

const ROLLOUT = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface RolloutFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Maps thread id to its rollout; undefined when sessions/ is missing. */
export async function scanRollouts(dir: string): Promise<Map<string, RolloutFile> | undefined> {
  let names: string[];
  try {
    names = await readdir(dir, { recursive: true });
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  const files = new Map<string, RolloutFile>();
  for (const name of names) {
    const id = ROLLOUT.exec(basename(name))?.[1];
    if (!id) continue;
    const path = join(dir, name);
    try {
      const st = await stat(path);
      files.set(id.toLowerCase(), { path, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // Deleted between readdir and stat.
    }
  }
  return files;
}
