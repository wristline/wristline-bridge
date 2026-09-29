// Routes a relayed statusLine report (POST /local/statusline) to the provider instance of the
// Claude Code home it came from, when the bridge watches more than one.

import { realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { isObject, str, type JsonObject } from '../../util.ts';

/** What the router needs of a ClaudeCodeProvider. */
export interface StatuslineTarget {
  readonly home: string;
  hasSession(nativeId: string): boolean;
  statusline(input: unknown): Promise<void>;
}

/**
 * The home whose `projects/` holds `transcript_path` (real paths compared) gets the report; else
 * the instance that lists `session_id`; else the only instance. Anything else is dropped, logged
 * once per session.
 */
export function statuslineRouter(instances: StatuslineTarget[], log: (line: string) => void = console.error): (input: unknown) => void {
  const dropped = new Set<string>();
  const route = async (input: JsonObject): Promise<void> => {
    const transcript = str(input.transcript_path);
    const path = transcript === undefined ? undefined : await realpath(transcript).catch(() => transcript);
    for (const instance of instances) {
      const projects = join(instance.home, 'projects');
      const root = await realpath(projects).catch(() => resolve(projects));
      if (path?.startsWith(root + sep)) return instance.statusline(input);
    }
    const id = str(input.session_id);
    const target = (id === undefined ? undefined : instances.find((i) => i.hasSession(id))) ?? (instances.length === 1 ? instances[0] : undefined);
    if (target) return target.statusline(input);
    if (dropped.has(id ?? '')) return;
    dropped.add(id ?? '');
    log(`wristline: statusLine of session ${id ?? '(no id)'} matches no Claude Code home; ignored`);
  };
  return (input) => {
    if (isObject(input)) route(input).catch((err: unknown) => log(`wristline: statusLine routing failed: ${err instanceof Error ? err.message : String(err)}`));
  };
}
