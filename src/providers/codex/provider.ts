import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { JsonlTail, Transcript, TranscriptCache } from '../../jsonl.ts';
import type { Item, ItemPage, PromptBlock, ProviderHealth, Session, SessionStatus, Usage } from '../../protocol.ts';
import { PromptBlocked, sessionKey, type Hub, type SessionProvider } from '../../provider.ts';
import { isNotFound, isObject, str } from '../../util.ts';
import {
  CodexMetaScan,
  SessionIndex,
  applyItemCompleted,
  codexAsk,
  itemDraft,
  mergeRateLimits,
  normalizeItem,
  normalizeItemCompleted,
  normalizeRateLimits,
  normalizeThreadStatus,
  parseCodexLine,
  usageOf,
} from './parse.ts';
import type { CodexRpc, RateLimitSnapshot, RequestId, ServerRequest, ThreadStatus } from './rpc.ts';

const REFRESH_MS = 2000;
const DAY_MS = 24 * 3600_000;
const IDLE_MS = 10 * 60_000;
const HISTORY_MAX = 50;
const ROLLOUT = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

interface RolloutFile {
  path: string;
  mtimeMs: number;
  size: number;
}

interface Meta {
  path: string;
  size: number;
  scan: CodexMetaScan;
  tail: JsonlTail;
}

/** What the app-server daemon reports about a thread it has loaded. */
interface Loaded {
  status: ThreadStatus;
  /** The thread that spawned this one (sub-agents); requests are shown on the parent's session. */
  parent: string | undefined;
  /** True once this client rejoined the thread (`thread/resume`) and receives its requests. */
  joined: boolean;
  joining?: Promise<boolean>;
}

/** An approval or question the watch was asked; aborted when the agent stops waiting. */
interface Ask {
  threadId: string;
  turnId: string;
  itemId: string;
  abort: AbortController;
}

export interface CodexOptions {
  home: string;
  historyDays: number;
  now?: () => number;
  /** Connection to the app-server daemon; without it the provider is read-only. */
  rpc?: CodexRpc;
}

/**
 * Codex threads from rollout files, overlaid with the app-server daemon's live state when it runs:
 * status of loaded threads, approvals and questions, prompts (`turn/start`) and plan usage. Only
 * threads the daemon already has loaded are ever rejoined; resuming an unloaded thread would load
 * a second writer for its rollout.
 */
export class CodexProvider implements SessionProvider {
  readonly id = 'codex';
  readonly #home: string;
  readonly #historyDays: number;
  readonly #now: () => number;
  readonly #transcripts = new TranscriptCache();
  readonly #metas = new Map<string, Meta>();
  readonly #index = new SessionIndex();
  readonly #indexTail: JsonlTail;
  readonly #rpc: CodexRpc | undefined;
  /** Threads loaded in the daemon, by id; empty while disconnected. */
  readonly #loaded = new Map<string, Loaded>();
  /** Title-generation and other throwaway threads, which never get a rollout. */
  readonly #ephemeral = new Set<string>();
  readonly #asks = new Map<RequestId, Ask>();
  /** What running items do (e.g. the files of a file change), for approvals that do not say. */
  readonly #itemText = new Map<string, string>();
  #sessions = new Map<string, Session>();
  #files = new Map<string, RolloutFile>();
  #recent: [string, RolloutFile][] = [];
  #usage: Usage | undefined;
  #daemonLimits: RateLimitSnapshot | undefined;
  #version: string | undefined;
  #found = false;
  #hub: Hub | undefined;
  #timer: NodeJS.Timeout | undefined;
  #refreshing = false;

  constructor(options: CodexOptions) {
    this.#home = options.home;
    this.#historyDays = options.historyDays;
    this.#now = options.now ?? Date.now;
    this.#indexTail = new JsonlTail(join(this.#home, 'session_index.jsonl'), this.#index);
    this.#rpc = options.rpc;
  }

  async start(hub: Hub): Promise<void> {
    this.#hub = hub;
    await this.refresh();
    this.#timer = setInterval(() => {
      this.refresh().catch((err: unknown) => console.error('wristline: codex refresh failed:', err));
    }, REFRESH_MS);
    const rpc = this.#rpc;
    if (!rpc) return;
    rpc.on('ready', () => {
      this.#connected().catch((err: unknown) => console.error('wristline: codex app-server sync failed:', err));
    });
    rpc.on('closed', () => this.#disconnected());
    rpc.on('notification', (method: string, params: unknown) => this.#notification(method, params));
    rpc.onRequest((request) => this.#serverRequest(request));
    rpc.start();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#rpc?.stop();
    this.#transcripts.clear();
  }

  health(): ProviderHealth {
    const health: ProviderHealth = { id: this.id, status: this.#found ? 'ok' : 'not_found' };
    if (this.#version) health.version = this.#version;
    if (this.#rpc) health.detail = this.#rpc.detail;
    return health;
  }

  listSessions(): Session[] {
    return [...this.#sessions.values()];
  }

  async readItems(nativeId: string, before: number | undefined, limit: number): Promise<ItemPage | undefined> {
    return this.#transcript(nativeId)?.page(before, limit);
  }

  watch(nativeId: string, onItem: (item: Item) => void): () => void {
    return this.#transcript(nativeId)?.subscribe(onItem) ?? (() => {});
  }

  /** Starts a turn in a thread the daemon has loaded; it shows in the TUI like a typed prompt. */
  async sendPrompt(nativeId: string, text: string): Promise<void> {
    const session = this.#sessions.get(nativeId);
    if (!session) throw new PromptBlocked('not_live');
    if (session.promptBlock) throw new PromptBlocked(session.promptBlock);
    if (this.#hub?.pending.hasSession(session.id)) throw new PromptBlocked('awaiting_input');
    if (!this.#rpc || !(await this.#join(nativeId))) throw new PromptBlocked('unsupported');
    try {
      await this.#rpc.request('turn/start', { threadId: nativeId, input: [{ type: 'text', text, text_elements: [] }] });
    } catch (err) {
      // Lost the connection or the thread meanwhile; anything else is a bug worth a 500.
      if (!this.#rpc.ready || !this.#loaded.has(nativeId)) throw new PromptBlocked('unsupported');
      throw err;
    }
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      await this.#refresh();
    } finally {
      this.#refreshing = false;
    }
  }

  async #refresh(): Promise<void> {
    const files = await scanRollouts(join(this.#home, 'sessions'));
    this.#found = files !== undefined;
    this.#files = files ?? new Map();
    await this.#indexTail.sync();
    const now = this.#now();

    const cutoff = now - this.#historyDays * DAY_MS;
    const recent = [...this.#files]
      .filter(([, f]) => f.mtimeMs >= cutoff)
      .sort(([, a], [, b]) => b.mtimeMs - a.mtimeMs)
      .slice(0, HISTORY_MAX);
    const ids = new Set(recent.map(([id]) => id));
    for (const id of this.#metas.keys()) if (!ids.has(id)) this.#metas.delete(id);

    let latest: CodexMetaScan['rateLimits'];
    this.#version = undefined;
    for (const [id, file] of recent) {
      const meta = await this.#scan(id, file);
      if (meta.subagent) continue;
      this.#version ??= meta.version;
      if (meta.rateLimits && (!latest || latest.at < meta.rateLimits.at)) latest = meta.rateLimits;
    }
    this.#recent = recent;
    this.#publish();

    // The daemon's numbers are live; rollouts only fill in while it is not connected.
    if (latest && !this.#daemonLimits && (!this.#usage || latest.at > this.#usage.updatedAt)) {
      this.#usage = usageOf(latest.snapshot, latest.at);
      this.#hub?.usage(this.#usage);
    }
    // A thread created by a TUI has no rollout until its first turn, so rejoining waits for it.
    for (const id of this.#loaded.keys()) if (this.#files.has(id)) void this.#join(id);
  }

  /** Rebuilds the list from the last scan plus the daemon's state and publishes what changed. */
  #publish(): void {
    const now = this.#now();
    const next = new Map<string, Session>();
    for (const [id, file] of this.#recent) {
      const meta = this.#metas.get(id)?.scan;
      if (!meta || meta.subagent) continue;
      next.set(id, this.#build(id, file, meta, now));
    }
    const previous = this.#sessions;
    this.#sessions = next;
    for (const [id, session] of next) {
      const old = previous.get(id);
      if (!old || JSON.stringify(old) !== JSON.stringify(session)) this.#hub?.session(session);
    }
    for (const id of previous.keys()) if (!next.has(id)) this.#hub?.removed(sessionKey(this.id, id));
  }

  async #scan(id: string, file: RolloutFile): Promise<CodexMetaScan> {
    let meta = this.#metas.get(id);
    if (!meta || meta.path !== file.path) {
      const scan = new CodexMetaScan();
      meta = { path: file.path, size: -1, scan, tail: new JsonlTail(file.path, scan) };
      this.#metas.set(id, meta);
    }
    // A sub-agent rollout is recognised from its first line; the rest is never needed.
    if (meta.size !== file.size && !meta.scan.subagent) {
      await meta.tail.sync();
      meta.size = file.size;
    }
    return meta.scan;
  }

  #build(id: string, file: RolloutFile, meta: CodexMetaScan, now: number): Session {
    const loaded = this.#loaded.get(id);
    let status: SessionStatus;
    let promptBlock: PromptBlock | undefined;
    if (loaded) {
      status = daemonStatus(loaded.status);
      promptBlock = status === 'running' ? 'busy' : status === 'needs_input' ? 'awaiting_input' : undefined;
    } else {
      // A turn without task_complete (e.g. a killed TUI) counts as running only while the file moves.
      const recent = now - file.mtimeMs < IDLE_MS;
      status = !recent ? 'ended' : meta.turnOpen ? 'running' : 'idle';
      promptBlock = status === 'ended' ? 'not_live' : 'unsupported';
    }
    const session: Session = {
      id: sessionKey(this.id, id),
      provider: this.id,
      title: this.#index.titles.get(id) ?? meta.firstPrompt ?? '',
      cwd: meta.cwd ?? '',
      status,
      lastActivity: new Date(file.mtimeMs).toISOString(),
    };
    if (promptBlock) session.promptBlock = promptBlock;
    if (meta.context) session.context = meta.context;
    return session;
  }

  // App-server daemon

  async #connected(): Promise<void> {
    const rpc = this.#rpc;
    if (!rpc) return;
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await rpc.request('thread/loaded/list', cursor ? { cursor } : {});
      if (!isObject(page)) break;
      if (Array.isArray(page.data)) ids.push(...page.data.filter((x): x is string => typeof x === 'string'));
      cursor = str(page.nextCursor);
    } while (cursor);
    this.#loaded.clear();
    for (const id of ids) {
      let read: unknown;
      try {
        read = await rpc.request('thread/read', { threadId: id });
      } catch {
        // No rollout before the first turn; its status arrives by notification.
      }
      this.#track(id, isObject(read) ? read.thread : undefined);
    }
    try {
      const limits = await rpc.request('account/rateLimits/read');
      if (isObject(limits)) this.#limits(limits.rateLimits);
    } catch (err) {
      console.error('wristline: codex account/rateLimits/read failed:', err instanceof Error ? err.message : err);
    }
    this.#publish();
    for (const id of this.#loaded.keys()) if (this.#files.has(id)) void this.#join(id);
  }

  #disconnected(): void {
    this.#loaded.clear();
    this.#itemText.clear();
    // Request ids belong to the lost connection; the agent can no longer take these answers.
    for (const ask of this.#asks.values()) ask.abort.abort();
    this.#asks.clear();
    this.#daemonLimits = undefined;
    this.#publish();
  }

  /** Records a loaded thread from a Thread object (or just its id); ephemeral threads are skipped. */
  #track(id: string, thread: unknown): void {
    const t = isObject(thread) ? thread : {};
    if (t.ephemeral === true || this.#ephemeral.has(id)) {
      this.#ephemeral.add(id);
      return;
    }
    const status = normalizeThreadStatus(t.status) ?? this.#loaded.get(id)?.status ?? { type: 'idle' };
    if (status.type === 'notLoaded') {
      this.#loaded.delete(id);
      return;
    }
    const previous = this.#loaded.get(id);
    this.#loaded.set(id, { status, parent: str(t.parentThreadId) ?? previous?.parent, joined: previous?.joined ?? false });
  }

  /** Rejoins a thread the daemon has loaded so this client receives its requests. */
  #join(id: string): Promise<boolean> {
    const loaded = this.#loaded.get(id);
    const rpc = this.#rpc;
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

  #limits(raw: unknown): void {
    const snapshot = normalizeRateLimits(raw);
    // Other limit ids (e.g. a reserve model) are not the plan windows the TUI shows.
    if (!snapshot || (snapshot.limitId !== null && snapshot.limitId !== 'codex')) return;
    this.#daemonLimits = mergeRateLimits(this.#daemonLimits, snapshot);
    this.#usage = usageOf(this.#daemonLimits, new Date(this.#now()).toISOString());
    this.#hub?.usage(this.#usage);
  }

  #notification(method: string, params: unknown): void {
    if (!isObject(params)) return;
    const threadId = str(params.threadId);
    switch (method) {
      case 'thread/started': {
        const thread = isObject(params.thread) ? params.thread : undefined;
        const id = str(thread?.id);
        if (!id) return;
        this.#track(id, thread);
        this.#publish();
        return;
      }
      case 'thread/status/changed':
        if (!threadId || this.#ephemeral.has(threadId)) return;
        this.#track(threadId, { status: params.status });
        if (this.#loaded.has(threadId) && this.#files.has(threadId)) void this.#join(threadId);
        this.#publish();
        return;
      case 'thread/closed':
        if (!threadId) return;
        this.#loaded.delete(threadId);
        this.#ephemeral.delete(threadId);
        this.#abortWhere((a) => a.threadId === threadId);
        this.#publish();
        return;
      case 'serverRequest/resolved': {
        const id = params.requestId;
        if (typeof id === 'string' || typeof id === 'number') this.#abortWhere((_, key) => key === id);
        return;
      }
      case 'turn/completed': {
        const turnId = isObject(params.turn) ? str(params.turn.id) : undefined;
        this.#abortWhere((a) => a.threadId === threadId && a.turnId === turnId);
        return;
      }
      case 'item/started': {
        const item = normalizeItem(params.item);
        if (!item || !threadId) return;
        if (item.type === 'fileChange') this.#itemText.set(item.id, item.changes.map((c) => c.path).join('\n'));
        // Only a running tool is news; messages arrive complete.
        if (item.type !== 'commandExecution' && item.type !== 'fileChange') return;
        const ts = new Date(this.#now()).toISOString();
        this.#inject(threadId, (sink) => {
          const draft = itemDraft(item, ts);
          if (draft) sink.add(item.id, draft);
        });
        return;
      }
      case 'item/completed': {
        const n = normalizeItemCompleted(params);
        if (!n) return;
        this.#itemText.delete(n.item.id);
        this.#abortWhere((a) => a.threadId === n.threadId && a.itemId === n.item.id);
        const ts = new Date(this.#now()).toISOString();
        this.#inject(n.threadId, (sink) => applyItemCompleted(n, ts, sink));
        return;
      }
      case 'account/rateLimits/updated':
        this.#limits(params.rateLimits);
        return;
    }
  }

  /** Live items reach a watched transcript at once; the rollout confirms them later. */
  #inject(threadId: string, apply: Parameters<Transcript['inject']>[0]): void {
    const transcript = this.#transcripts.peek(threadId);
    if (!transcript?.watched) return;
    transcript.inject(apply).catch((err: unknown) => console.error('wristline: codex live item failed:', err));
  }

  #abortWhere(match: (ask: Ask, id: RequestId) => boolean): void {
    for (const [id, ask] of this.#asks) {
      if (!match(ask, id)) continue;
      this.#asks.delete(id);
      ask.abort.abort();
    }
  }

  /**
   * Approvals and questions go to the watch while the TUI shows them too; whoever answers first
   * wins. No timeout: the daemon waits for an answer indefinitely, and a late one is ignored.
   */
  #serverRequest(request: ServerRequest): Promise<unknown> | undefined {
    const ask = codexAsk(request.method, request.params, (itemId) => this.#itemText.get(itemId));
    const pending = this.#hub?.pending;
    if (!ask || !pending) return undefined;
    const root = this.#loaded.get(ask.threadId)?.parent ?? ask.threadId;
    const abort = new AbortController();
    this.#asks.set(request.id, { threadId: ask.threadId, turnId: ask.turnId, itemId: ask.itemId, abort });
    return pending.open({ sessionId: sessionKey(this.id, root), ...ask.draft }, { signal: abort.signal }).then((answers) => {
      this.#asks.delete(request.id);
      return answers ? ask.result(answers) : undefined;
    });
  }

  #transcript(nativeId: string): Transcript | undefined {
    const file = this.#sessions.has(nativeId) ? this.#files.get(nativeId) : undefined;
    return file && this.#transcripts.get(nativeId, () => new Transcript(file.path, parseCodexLine));
  }
}

function daemonStatus(status: ThreadStatus): SessionStatus {
  if (status.type !== 'active') return 'idle';
  return status.activeFlags.length > 0 ? 'needs_input' : 'running';
}

/** Maps thread id to its rollout; undefined when sessions/ is missing. */
async function scanRollouts(dir: string): Promise<Map<string, RolloutFile> | undefined> {
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
