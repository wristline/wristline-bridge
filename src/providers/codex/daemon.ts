// The app-server daemon's view of threads: what it reports about a loaded thread, and the
// requests it has open with the watch.

import type { SessionStatus } from '../../protocol.ts';
import { isObject, str } from '../../util.ts';
import type { CodexRpc, ThreadStatus } from './rpc.ts';

/** What the app-server daemon reports about a thread it has loaded. */
export interface Loaded {
  status: ThreadStatus;
  /** The thread that spawned this one (sub-agents); requests are shown on the parent's session. */
  parent: string | undefined;
  /** True once this client rejoined the thread (`thread/resume`) and receives its requests. */
  joined: boolean;
  joining?: Promise<boolean>;
}

/** An approval or question the watch was asked; aborted when the agent stops waiting. */
export interface Ask {
  threadId: string;
  turnId: string;
  itemId: string;
  abort: AbortController;
}

export function daemonStatus(status: ThreadStatus): SessionStatus {
  if (status.type !== 'active') return 'idle';
  return status.activeFlags.length > 0 ? 'needs_input' : 'running';
}

/** Ids of the threads the daemon has loaded (`thread/loaded/list`, all pages). */
export async function loadedThreadIds(rpc: CodexRpc): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await rpc.request('thread/loaded/list', cursor ? { cursor } : {});
    if (!isObject(page)) break;
    if (Array.isArray(page.data)) ids.push(...page.data.filter((x): x is string => typeof x === 'string'));
    cursor = str(page.nextCursor);
  } while (cursor);
  return ids;
}
