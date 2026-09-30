// The app-server daemon's view of threads: what it reports about a loaded thread, and the
// requests it has open with the watch.

import type { SessionStatus } from '../../protocol.ts';
import { isObject, str } from '../../util.ts';
import { normalizeThreadStatus } from './parse.ts';
import type { CodexRpc, ThreadStatus } from './rpc.ts';

/** What the app-server daemon reports about a thread it has loaded. */
export interface Loaded {
  status: ThreadStatus;
  /** The thread that spawned this one (sub-agents); requests are shown on the parent's session. */
  parent: string | undefined;
  /** Model and reasoning effort the thread is configured with (`Thread.model`/`reasoningEffort`, `thread/settings/updated`). */
  model: string | undefined;
  effort: string | undefined;
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

/** The threads the daemon has loaded (empty while disconnected), and which of them this client has rejoined. */
export class LoadedThreads {
  readonly #threads = new Map<string, Loaded>();
  /** Title-generation and other throwaway threads, which never get a rollout. */
  readonly #ephemeral = new Set<string>();

  get(id: string): Loaded | undefined {
    return this.#threads.get(id);
  }

  has(id: string): boolean {
    return this.#threads.has(id);
  }

  isEphemeral(id: string): boolean {
    return this.#ephemeral.has(id);
  }

  ids(): string[] {
    return [...this.#threads.keys()];
  }

  clear(): void {
    this.#threads.clear();
  }

  forget(id: string): void {
    this.#threads.delete(id);
    this.#ephemeral.delete(id);
  }

  /** Records a loaded thread from a Thread object (or just its id or status); ephemeral threads are skipped. */
  track(id: string, thread: unknown): void {
    const t = isObject(thread) ? thread : {};
    if (t.ephemeral === true || this.#ephemeral.has(id)) {
      this.#ephemeral.add(id);
      return;
    }
    const status = normalizeThreadStatus(t.status) ?? this.#threads.get(id)?.status ?? { type: 'idle' };
    if (status.type === 'notLoaded') {
      this.#threads.delete(id);
      return;
    }
    const previous = this.#threads.get(id);
    // A Thread object names its model (null when unavailable); a status change keeps the last one.
    const named = t.model !== undefined;
    this.#threads.set(id, {
      status,
      parent: str(t.parentThreadId) ?? previous?.parent,
      model: named ? str(t.model) : previous?.model,
      effort: named ? str(t.reasoningEffort) : previous?.effort,
      joined: previous?.joined ?? false,
    });
  }

  /** Rejoins a thread the daemon has loaded so this client receives its requests. */
  join(id: string, rpc: CodexRpc | undefined): Promise<boolean> {
    const loaded = this.#threads.get(id);
    // Never resume a thread the daemon has not loaded: that would open its rollout a second time.
    if (!loaded || !rpc?.ready) return Promise.resolve(false);
    if (loaded.joined) return Promise.resolve(true);
    loaded.joining ??= rpc.request('thread/resume', { threadId: id, excludeTurns: true }).then(
      () => {
        loaded.joined = true;
        loaded.joining = undefined;
        console.log(`wristline: codex rejoined loaded thread ${id}`);
        return true;
      },
      () => {
        loaded.joining = undefined;
        return false;
      },
    );
    return loaded.joining;
  }
}
