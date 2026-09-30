import { randomUUID } from 'node:crypto';
import {
  PERMISSION_QUESTION,
  type Answers,
  type PendingRequest,
  type PermissionOption,
  type ResolvedBy,
} from './protocol.ts';

/** How long after the last watch disconnects the bridge still treats the user as away from the PC. */
const WATCH_GRACE_MS = 90_000;
const DEFER: PermissionOption = 'defer';

export type RequestDraft = Omit<PendingRequest, 'id' | 'createdAt'>;
/** `GET /local/presence` body. */
export interface Presence {
  watch: boolean;
  since: string | null;
}
export type AnswerResult = 'ok' | 'already_resolved' | 'invalid';

export interface OpenOptions {
  timeoutMs?: number;
  /** Aborting means the agent stopped waiting (e.g. the user answered in the terminal). */
  signal?: AbortSignal;
}

export interface PendingOptions {
  onRequest(request: PendingRequest): void;
  onResolved(request: PendingRequest, by: ResolvedBy): void;
  now?: () => number;
  newId?: () => string;
}

interface Entry {
  request: PendingRequest;
  finish(answers: Answers | null, by: ResolvedBy): void;
}

export class PendingRegistry {
  readonly #open = new Map<string, Entry>();
  readonly #onRequest: PendingOptions['onRequest'];
  readonly #onResolved: PendingOptions['onResolved'];
  readonly #now: () => number;
  readonly #newId: () => string;
  #watches = 0;
  #lastWatchSeen = Number.NEGATIVE_INFINITY;
  /** When the current presence run began; undefined until the first watch connects. */
  #presentSince: number | undefined;

  constructor(options: PendingOptions) {
    this.#onRequest = options.onRequest;
    this.#onResolved = options.onResolved;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
  }

  /**
   * Publishes a request and waits for the watch. Resolves null on timeout, abort, or when the
   * watch chose to answer on the PC instead.
   */
  open(draft: RequestDraft, options: OpenOptions = {}): Promise<Answers | null> {
    const { signal, timeoutMs } = options;
    if (signal?.aborted) return Promise.resolve(null);
    const request: PendingRequest = { id: this.#newId(), ...draft, createdAt: new Date(this.#now()).toISOString() };
    return new Promise((resolve) => {
      const onAbort = (): void => entry.finish(null, 'terminal');
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => entry.finish(null, 'timeout'), timeoutMs);
      const entry: Entry = {
        request,
        finish: (answers, by) => {
          if (!this.#open.delete(request.id)) return;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          this.#onResolved(request, by);
          resolve(answers);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#open.set(request.id, entry);
      this.#onRequest(request);
    });
  }

  /** The first valid answer wins; later ones get `already_resolved`. */
  answer(id: string, answers: Answers): AnswerResult {
    const entry = this.#open.get(id);
    if (!entry) return 'already_resolved';
    if (!isValid(entry.request, answers)) return 'invalid';
    const deferred = entry.request.kind === 'permission' && answers[PERMISSION_QUESTION]?.[0] === DEFER;
    entry.finish(deferred ? null : answers, 'watch');
    return 'ok';
  }

  /** Resolves a request the agent stopped waiting on without telling us (e.g. answered in the terminal). */
  dismiss(id: string, by: ResolvedBy): void {
    this.#open.get(id)?.finish(null, by);
  }

  list(): PendingRequest[] {
    return [...this.#open.values()].map((e) => e.request);
  }

  hasSession(sessionId: string): boolean {
    for (const e of this.#open.values()) if (e.request.sessionId === sessionId) return true;
    return false;
  }

  watchConnected(): void {
    if (!this.watchPresent()) this.#presentSince = this.#now();
    this.#watches++;
  }

  watchDisconnected(): void {
    this.#watches = Math.max(0, this.#watches - 1);
    this.#lastWatchSeen = this.#now();
  }

  /** True while a watch is connected or disconnected less than 90 s ago ("monitoring on" = away mode). */
  watchPresent(): boolean {
    return this.#watches > 0 || this.#now() - this.#lastWatchSeen <= WATCH_GRACE_MS;
  }

  /** `watchPresent()` plus when that state began: the first connect of this run, or the last disconnect (null before any watch). */
  presence(): Presence {
    const watch = this.watchPresent();
    const since = watch ? this.#presentSince : this.#watches === 0 && this.#lastWatchSeen > Number.NEGATIVE_INFINITY ? this.#lastWatchSeen : undefined;
    return { watch, since: since === undefined ? null : new Date(since).toISOString() };
  }
}

function isValid(request: PendingRequest, answers: Answers): boolean {
  const keys = Object.keys(answers);
  if (keys.length !== request.questions.length) return false;
  return request.questions.every((q) => {
    const picked = answers[q.id];
    if (!Array.isArray(picked) || picked.length === 0) return false;
    if (!q.multi && picked.length !== 1) return false;
    if (new Set(picked).size !== picked.length) return false;
    return picked.every((id) => q.options.some((o) => o.id === id));
  });
}
