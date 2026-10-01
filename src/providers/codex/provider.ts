import { join } from 'node:path';
import { JsonlTail, Transcript, TranscriptCache, type JsonlHead } from '../../jsonl.ts';
import type { Item, ItemKind, ItemPage, PromptBlock, ProviderHealth, Session, SessionStatus, Usage } from '../../protocol.ts';
import { PromptBlocked, doneText, doneTitle, sessionKey, type Hub, type SessionProvider } from '../../provider.ts';
import { isObject, str } from '../../util.ts';
import { CodexAccounts, type AccountsOptions } from './account.ts';
import { codexAsk } from './ask.ts';
import { LoadedThreads, daemonStatus, loadedThreadIds, type Ask } from './daemon.ts';
import { historyHead, readRolloutStart, scanRollouts, type RolloutFile, type RolloutStart } from './home.ts';
import {
  CodexMetaScan,
  SessionIndex,
  applyItemCompleted,
  itemDraft,
  mergeRateLimits,
  normalizeItem,
  normalizeItemCompleted,
  normalizeRateLimits,
  parseCodexLine,
  usageOf,
} from './parse.ts';
import type { CodexRpc, ItemCompletedNotification, RateLimitSnapshot, RequestId, ServerRequest, ThreadStatus } from './rpc.ts';

const REFRESH_MS = 2000;
const DAY_MS = 24 * 3600_000;
const IDLE_MS = 10 * 60_000;
const HISTORY_MAX = 50;
/** How long a thread may wait on an approval without the watch being asked before it raises `needs_input`: the daemon sends the request right after the status. */
const NEEDS_INPUT_DELAY_MS = 1000;

const awaitsApproval = (status: ThreadStatus | undefined): boolean => status?.type === 'active' && status.activeFlags.includes('waitingOnApproval');

/** What a thread's current turn has said so far, from its `item/completed` notifications (the `turn.items` of `turn/completed` may be empty). */
interface TurnText {
  turnId: string;
  /** The first user message: typed in the TUI or sent from the watch. */
  prompt?: string;
  /** The last agent message. */
  answer?: string;
}

interface Meta {
  path: string;
  size: number;
  scan: CodexMetaScan;
  tail: JsonlTail;
  /** Earlier files this rollout continues (rewinds), oldest first. */
  head: JsonlHead[];
  /** The thread the history was taken from, when it is another one (a fork). */
  baseThreadId: string | undefined;
  /** The first line was not complete yet, so `head` and `baseThreadId` are unknown. */
  startless: boolean;
}

export interface CodexOptions extends AccountsOptions {
  home: string;
  historyDays: number;
  now?: () => number;
  /** Connection to the app-server daemon; without it the provider is read-only. */
  rpc?: CodexRpc;
  /** True for a thread id that is a Quick Ask thread (src/ask.ts): never listed, its requests never opened. */
  isAsk?: (nativeId: string) => boolean;
  /** The Quick Ask scratch directory (resolved): a rollout made there is an ask's even before `isAsk` knows its id. */
  askCwd?: string;
  /** Default NEEDS_INPUT_DELAY_MS; tests shorten it. */
  needsInputDelayMs?: number;
}

/**
 * Codex threads from rollout files, overlaid with the app-server daemon's live state when it runs:
 * status of loaded threads, approvals and questions, prompts (`turn/start`) and plan usage. Only
 * threads the daemon already has loaded are ever rejoined; resuming an unloaded thread would load
 * a second writer for its rollout.
 */
export class CodexProvider implements SessionProvider {
  readonly id = 'codex';
  readonly home: string;
  readonly #historyDays: number;
  readonly #now: () => number;
  readonly #accounts: CodexAccounts;
  readonly #isAsk: (nativeId: string) => boolean;
  readonly #askCwd: string | undefined;
  readonly #needsInputDelayMs: number;
  readonly #transcripts = new TranscriptCache();
  readonly #metas = new Map<string, Meta>();
  /** First lines of rollouts seen, by path; a rollout's first line never changes. */
  readonly #starts = new Map<string, Promise<RolloutStart | undefined>>();
  readonly #index = new SessionIndex();
  readonly #indexTail: JsonlTail;
  readonly #rpc: CodexRpc | undefined;
  readonly #loaded = new LoadedThreads();
  readonly #asks = new Map<RequestId, Ask>();
  /** What running items do (e.g. the files of a file change), for approvals that do not say. */
  readonly #itemText = new Map<string, string>();
  /** Per loaded thread. */
  readonly #turns = new Map<string, TurnText>();
  /** Threads that began waiting on an approval, until NEEDS_INPUT_DELAY_MS tells whether the watch was asked. */
  readonly #waiting = new Map<string, NodeJS.Timeout>();
  #sessions = new Map<string, Session>();
  #files = new Map<string, RolloutFile>();
  #recent: [string, RolloutFile][] = [];
  /** Last usage published per account id (`''` without one). */
  readonly #usage = new Map<string, Usage>();
  #daemonLimits: RateLimitSnapshot | undefined;
  /** The daemon's login (account id): null without one, undefined while unknown (disconnected, being re-read, or the read failed). */
  #daemonAccount: string | null | undefined;
  /** Reads of the daemon's login in flight, and the number of the newest one: only it applies. */
  #syncing = 0;
  #syncGen = 0;
  #version: string | undefined;
  #found = false;
  #hub: Hub | undefined;
  #timer: NodeJS.Timeout | undefined;
  #refreshing = false;

  constructor(options: CodexOptions) {
    this.home = options.home;
    this.#historyDays = options.historyDays;
    this.#now = options.now ?? Date.now;
    this.#indexTail = new JsonlTail(join(this.home, 'session_index.jsonl'), this.#index);
    this.#rpc = options.rpc;
    this.#accounts = new CodexAccounts(options);
    this.#isAsk = options.isAsk ?? (() => false);
    this.#askCwd = options.askCwd;
    this.#needsInputDelayMs = options.needsInputDelayMs ?? NEEDS_INPUT_DELAY_MS;
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
    await rpc.start();
  }

  stop(): void {
    clearInterval(this.#timer);
    for (const timer of this.#waiting.values()) clearTimeout(timer);
    this.#waiting.clear();
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

  async readItems(nativeId: string, before: number | undefined, limit: number, kinds?: ReadonlySet<ItemKind>): Promise<ItemPage | undefined> {
    return this.#transcript(nativeId)?.page(before, limit, kinds);
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
    if (!this.#rpc || !(await this.#loaded.join(nativeId, this.#rpc))) throw new PromptBlocked('unsupported');
    try {
      await this.#rpc.request('turn/start', { threadId: nativeId, input: [{ type: 'text', text, text_elements: [] }] });
    } catch (err) {
      // Lost the connection or the thread meanwhile; anything else is a bug worth a 500.
      if (!this.#rpc.ready || !this.#loaded.has(nativeId)) throw new PromptBlocked('unsupported');
      throw err;
    }
  }

  /** The bridge hears a turn finish (and raises `done`) only while the daemon is connected and this client rejoined the thread. */
  covers(nativeId: string): boolean {
    return this.#rpc?.ready === true && this.#loaded.get(nativeId)?.joined === true;
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
    const files = await scanRollouts(join(this.home, 'sessions'));
    this.#found = files !== undefined;
    this.#files = files ?? new Map();
    await this.#indexTail.sync();
    // Rollouts of other accounts still name their threads' accounts; the hub sends only the current login's usage.
    if (await this.#accounts.poll(this.home)) this.#reportLogin();
    const now = this.#now();

    const cutoff = now - this.#historyDays * DAY_MS;
    // Sub-agents (known from a rollout's first line, memoised) are left out before the cap: they take none of its places.
    const listable: [string, RolloutFile][] = [];
    for (const [id, f] of this.#files) {
      if (f.mtimeMs < cutoff || this.#isAsk(id)) continue;
      const start = await this.#start(f.path).catch(() => undefined);
      if (!start?.subagent) listable.push([id, f]);
    }
    const recent = listable.sort(([, a], [, b]) => b.mtimeMs - a.mtimeMs).slice(0, HISTORY_MAX);
    const ids = new Set(recent.map(([id]) => id));
    for (const id of this.#metas.keys()) if (!ids.has(id)) this.#metas.delete(id);
    const paths = new Set([...this.#files.values()].flatMap((f) => [f, ...f.previous].map((x) => x.path)));
    for (const path of this.#starts.keys()) if (!paths.has(path)) this.#starts.delete(path);

    // The newest rate-limit snapshot per account (the thread's creator; `''` for rollouts naming none).
    const latest = new Map<string, NonNullable<CodexMetaScan['rateLimits']>>();
    this.#version = undefined;
    for (const [id, file] of recent) {
      const meta = await this.#scan(id, file);
      if (meta.subagent) continue;
      this.#version ??= meta.version;
      const key = meta.accountId ?? '';
      if (meta.rateLimits && (latest.get(key)?.at ?? '') < meta.rateLimits.at) latest.set(key, meta.rateLimits);
    }
    this.#recent = recent;
    this.#publish();

    // The daemon's numbers are live for its own account; rollouts fill in the others and while it is not connected.
    const daemonKey = this.#daemonLimits ? (this.#daemonAccount ?? '') : undefined;
    for (const [key, limits] of latest) {
      if (key === daemonKey || limits.at <= (this.#usage.get(key)?.updatedAt ?? '')) continue;
      const usage = usageOf(limits.snapshot, limits.at, key ? this.#accounts.account(key) : undefined);
      this.#usage.set(key, usage);
      this.#hub?.usage(usage);
    }
    this.#rejoin();
  }

  /**
   * The home's login for the hub: the one `auth.json` names; without the file (logged out, or the
   * credentials are kept in the OS keyring), the daemon's while it is connected and has said whose
   * limits it sends.
   */
  #reportLogin(): void {
    const file = this.#accounts.current;
    this.#hub?.login(this, file === null ? (this.#daemonAccount ?? undefined) : file);
  }

  /** A thread created by a TUI has no rollout until its first turn, so rejoining waits for it. */
  #rejoin(): void {
    for (const id of this.#loaded.ids()) if (this.#files.has(id)) void this.#loaded.join(id, this.#rpc);
  }

  /** Rebuilds the list from the last scan plus the daemon's state and publishes what changed. */
  #publish(): void {
    const now = this.#now();
    const next = new Map<string, Session>();
    for (const [id, file] of this.#recent) {
      const meta = this.#metas.get(id)?.scan;
      // An ask's rollout exists before the bridge has read its id from the CLI: its cwd tells it apart meanwhile.
      if (!meta || meta.subagent || (meta.cwd !== undefined && meta.cwd === this.#askCwd)) continue;
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
    // A rollout first scanned before its first line was complete (a rewind or fork being created) has
    // no history head: once the line is there, it is scanned afresh with it.
    if (!meta || meta.path !== file.path || (meta.startless && (await this.#start(file.path)))) {
      const startless = (await this.#start(file.path)) === undefined;
      const { head, baseThreadId } = await historyHead(file, this.#files, (path) => this.#start(path));
      const scan = new CodexMetaScan();
      meta = { path: file.path, size: -1, scan, tail: new JsonlTail(file.path, scan, head), head, baseThreadId, startless };
      this.#metas.set(id, meta);
      // The thread went on in a new file (a rewind), or its head is known now: a transcript being read follows.
      this.#transcripts.peek(id)?.rebase(file.path, head);
    }
    // A sub-agent rollout is recognised from its first line; the rest is never needed.
    if (meta.size !== file.size && !meta.scan.subagent) {
      await meta.tail.sync();
      meta.size = file.size;
    }
    return meta.scan;
  }

  #start(path: string): Promise<RolloutStart | undefined> {
    let start = this.#starts.get(path);
    if (!start) {
      start = readRolloutStart(path);
      this.#starts.set(path, start);
      // Not memoised until the line is there (a rollout being created) or the read worked.
      start.then((s) => s === undefined && this.#starts.delete(path), () => this.#starts.delete(path));
    }
    return start;
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
      title: this.#index.titles.get(id) ?? this.#baseTitle(id) ?? meta.firstPrompt ?? '',
      cwd: meta.cwd ?? '',
      status,
      lastActivity: new Date(file.mtimeMs).toISOString(),
    };
    if (promptBlock) session.promptBlock = promptBlock;
    if (meta.context) session.context = meta.context;
    if (meta.accountId) session.account = this.#accounts.account(meta.accountId);
    // The daemon's configured model is newer than the rollout's last turn (e.g. changed for the next one).
    const settings = loaded?.model ? loaded : meta;
    if (settings.model) session.model = settings.model;
    if (settings.effort) session.effort = settings.effort;
    return session;
  }

  /** A thread forked from another one keeps that one's name until it gets its own. */
  #baseTitle(id: string): string | undefined {
    const base = this.#metas.get(id)?.baseThreadId;
    return base && base !== id ? this.#index.titles.get(base) : undefined;
  }

  // App-server daemon

  async #connected(): Promise<void> {
    const rpc = this.#rpc;
    if (!rpc) return;
    const ids = await loadedThreadIds(rpc);
    this.#loaded.clear();
    for (const id of ids) {
      let read: unknown;
      try {
        read = await rpc.request('thread/read', { threadId: id });
      } catch {
        // No rollout before the first turn; its status arrives by notification.
      }
      this.#loaded.track(id, isObject(read) ? read.thread : undefined);
    }
    await this.#syncAccount();
    this.#publish();
    this.#rejoin();
  }

  #disconnected(): void {
    this.#loaded.clear();
    this.#itemText.clear();
    this.#turns.clear();
    for (const timer of this.#waiting.values()) clearTimeout(timer);
    this.#waiting.clear();
    // Request ids belong to the lost connection; the agent can no longer take these answers.
    for (const ask of this.#asks.values()) ask.abort.abort();
    this.#asks.clear();
    this.#daemonLimits = undefined;
    this.#daemonAccount = undefined;
    this.#reportLogin();
    this.#publish();
  }

  /**
   * Re-reads the daemon's login and its full limits. Meanwhile the login is unknown, so a sparse
   * `account/rateLimits/updated` that arrives cannot be attributed and is dropped; the full
   * snapshot read here carries its numbers again. Reads overlap when `account/updated` arrives
   * while connecting; only the newest one applies.
   */
  async #syncAccount(): Promise<void> {
    if (!this.#rpc) return;
    const gen = ++this.#syncGen;
    this.#daemonAccount = undefined;
    this.#daemonLimits = undefined;
    this.#syncing++;
    try {
      const daemon = await this.#accounts.daemon(this.#rpc);
      if (gen !== this.#syncGen || !daemon) return; // Superseded, or failed: the next update triggers another read.
      this.#daemonAccount = daemon.accountId;
      this.#reportLogin();
      this.#limits(daemon.rateLimits);
    } finally {
      this.#syncing--;
    }
  }

  #limits(raw: unknown): void {
    const snapshot = normalizeRateLimits(raw);
    // Other limit ids (e.g. a reserve model) are not the plan windows the TUI shows.
    if (!snapshot || (snapshot.limitId !== null && snapshot.limitId !== 'codex')) return;
    if (this.#daemonAccount === undefined) {
      // Whose limits these are is unknown: a read in flight will carry these numbers, or the last read failed and is retried now.
      if (this.#syncing === 0) this.#syncAccount().catch((err: unknown) => console.error('wristline: codex account sync failed:', err));
      return;
    }
    this.#daemonLimits = mergeRateLimits(this.#daemonLimits, snapshot);
    const id = this.#daemonAccount;
    // The label is resolved now, not at sync time, so an email learned since (auth.json, account/read) shows.
    const usage = usageOf(this.#daemonLimits, new Date(this.#now()).toISOString(), id ? this.#accounts.account(id) : undefined);
    this.#usage.set(id ?? '', usage);
    this.#hub?.usage(usage);
  }

  #notification(method: string, params: unknown): void {
    if (method === 'account/updated' || method === 'account/login/completed') {
      this.#syncAccount().catch((err: unknown) => console.error('wristline: codex account sync failed:', err));
      return;
    }
    if (!isObject(params)) return;
    const threadId = str(params.threadId);
    switch (method) {
      case 'thread/started': {
        const thread = isObject(params.thread) ? params.thread : undefined;
        const id = str(thread?.id);
        if (!id) return;
        this.#loaded.track(id, thread);
        this.#publish();
        return;
      }
      case 'thread/status/changed': {
        if (!threadId || this.#loaded.isEphemeral(threadId)) return;
        const waited = awaitsApproval(this.#loaded.get(threadId)?.status);
        this.#loaded.track(threadId, { status: params.status });
        if (!waited && awaitsApproval(this.#loaded.get(threadId)?.status)) this.#approvalWait(threadId);
        if (this.#loaded.has(threadId) && this.#files.has(threadId)) void this.#loaded.join(threadId, this.#rpc);
        this.#publish();
        return;
      }
      case 'thread/settings/updated': {
        const settings = isObject(params.threadSettings) ? params.threadSettings : undefined;
        if (!threadId || !settings || !this.#loaded.has(threadId)) return;
        this.#loaded.track(threadId, { model: settings.model, reasoningEffort: settings.effort });
        this.#publish();
        return;
      }
      case 'thread/closed':
        if (!threadId) return;
        this.#loaded.forget(threadId);
        this.#turns.delete(threadId);
        this.#abortWhere((a) => a.threadId === threadId);
        this.#publish();
        return;
      case 'thread/reverted':
        // The thread continues in a new rollout file; pick it up now rather than at the next tick.
        this.refresh().catch((err: unknown) => console.error('wristline: codex refresh failed:', err));
        return;
      case 'serverRequest/resolved': {
        const id = params.requestId;
        if (typeof id === 'string' || typeof id === 'number') this.#abortWhere((_, key) => key === id);
        return;
      }
      case 'turn/completed': {
        const turn = isObject(params.turn) ? params.turn : undefined;
        const turnId = str(turn?.id);
        this.#abortWhere((a) => a.threadId === threadId && a.turnId === turnId);
        if (threadId && turnId) this.#turnCompleted(threadId, turnId, turn?.status === 'completed');
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
        this.#noteTurnText(n);
        const ts = new Date(this.#now()).toISOString();
        this.#inject(n.threadId, (sink) => applyItemCompleted(n, ts, sink));
        return;
      }
      case 'account/rateLimits/updated':
        this.#limits(params.rateLimits);
        return;
    }
  }

  #noteTurnText({ item, threadId, turnId }: ItemCompletedNotification): void {
    if ((item.type !== 'userMessage' && item.type !== 'agentMessage') || !this.#loaded.has(threadId)) return;
    let turn = this.#turns.get(threadId);
    if (turn?.turnId !== turnId) {
      turn = { turnId };
      this.#turns.set(threadId, turn);
    }
    if (item.type === 'agentMessage') turn.answer = item.text;
    else turn.prompt ??= item.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  }

  /**
   * A finished turn raises `done` by the rule of Claude Code's Stop hook: the turn's last answer,
   * titled by its user message, else the thread's title. An interrupted or failed turn raises
   * nothing, nor does a Quick Ask or sub-agent thread (neither is listed).
   */
  #turnCompleted(threadId: string, turnId: string, completed: boolean): void {
    const turn = this.#turns.get(threadId);
    this.#turns.delete(threadId);
    const session = this.#sessions.get(threadId);
    if (!completed || turn?.turnId !== turnId || !session || this.#loaded.get(threadId)?.parent || this.#isAsk(threadId)) return;
    const text = doneText(turn.answer);
    if (text !== undefined) this.#hub?.alert(session.id, 'done', text, doneTitle(turn.prompt, session.title));
  }

  /**
   * A thread waiting on an approval normally shows on the watch as a request. When no request of
   * its session is open NEEDS_INPUT_DELAY_MS later (e.g. a kind the watch cannot answer) and it
   * still waits, it raises `needs_input` instead. A sub-agent's shows on its parent's session.
   */
  #approvalWait(threadId: string): void {
    clearTimeout(this.#waiting.get(threadId));
    const timer = setTimeout(() => {
      this.#waiting.delete(threadId);
      const loaded = this.#loaded.get(threadId);
      const session = this.#sessions.get(loaded?.parent ?? threadId);
      if (!session || !awaitsApproval(loaded?.status) || this.#hub?.pending.hasSession(session.id)) return;
      this.#hub?.alert(session.id, 'needs_input');
    }, this.#needsInputDelayMs);
    this.#waiting.set(threadId, timer);
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
    if (this.#isAsk(root)) return undefined;
    const abort = new AbortController();
    this.#asks.set(request.id, { threadId: ask.threadId, turnId: ask.turnId, itemId: ask.itemId, abort });
    return pending.open({ sessionId: sessionKey(this.id, root), ...ask.draft }, { signal: abort.signal }).then((answers) => {
      this.#asks.delete(request.id);
      return answers ? ask.result(answers) : undefined;
    });
  }

  #transcript(nativeId: string): Transcript | undefined {
    const meta = this.#sessions.has(nativeId) ? this.#metas.get(nativeId) : undefined;
    return meta && this.#transcripts.get(nativeId, () => new Transcript(meta.path, parseCodexLine, meta.head));
  }
}
