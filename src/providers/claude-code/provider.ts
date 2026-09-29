import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LoginEntry } from '../../config.ts';
import { JsonlTail, Transcript, TranscriptCache } from '../../jsonl.ts';
import type { Account, Item, ItemPage, PromptBlock, ProviderHealth, Session, SessionStatus } from '../../protocol.ts';
import { PromptBlocked, sessionKey, type Hub, type SessionProvider } from '../../provider.ts';
import { isNotFound, isObject, own, str } from '../../util.ts';
import { appendLogin, claudeJsonPath, isEstimated, loginAt, readClaudeAccount, statuslineFingerprint } from './account.ts';
import { ClaudeMetaScan, parseClaudeLine, sessionTitle, statuslineContext, statuslineUsage } from './parse.ts';
import {
  descendsFrom,
  isLive,
  mapStatus,
  pidAlive,
  readEntry,
  readRegistry,
  sameProcess,
  scanTranscripts,
  tmuxPane,
  type RegistryEntry,
  type TranscriptFile,
} from './home.ts';

const REFRESH_MS = 2000;
const DAY_MS = 24 * 3600_000;
const HISTORY_MAX = 50;
const DEFAULT_WINDOW = 200_000;
const EXTENDED_WINDOW = 1_000_000;
const TMUX_TIMEOUT_MS = 5000;

interface Meta {
  path: string;
  size: number;
  scan: ClaudeMetaScan;
  tail: JsonlTail;
}

/** Runs a program without a shell and resolves its stdout. */
export type Exec = (file: string, args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);
const defaultExec: Exec = async (file, args) => (await execFileAsync(file, args, { timeout: TMUX_TIMEOUT_MS })).stdout;

interface Pane {
  /** `%<n>`: tmux keeps this id for the pane's whole life, wherever it moves. */
  id: string;
  pid: number;
  procStart: string | undefined;
}

export interface ClaudeOptions {
  home: string;
  historyDays: number;
  /** tmux binary for prompts (default `tmux` on PATH). */
  tmux?: string;
  exec?: Exec;
  now?: () => number;
  /** Logins observed in this home so far (`config.claudeLogins[home]`), oldest first. */
  logins?: LoginEntry[];
  /** Called with the whole list whenever a login is added or relabelled. */
  saveLogins?: (logins: LoginEntry[]) => Promise<void>;
  /** Account id → label chosen by the user (`config.labels`). */
  labels?: Record<string, string>;
}

export class ClaudeCodeProvider implements SessionProvider {
  readonly id = 'claude-code';
  readonly home: string;
  readonly #historyDays: number;
  readonly #now: () => number;
  readonly #tmux: string;
  readonly #exec: Exec;
  readonly #saveLogins: ((logins: LoginEntry[]) => Promise<void>) | undefined;
  readonly #labels: Record<string, string>;
  readonly #transcripts = new TranscriptCache();
  readonly #metas = new Map<string, Meta>();
  /** Context reported by the statusLine, by session id; `at` is when the report arrived. */
  readonly #statusContext = new Map<string, { used?: number; window?: number; at: number }>();
  /** statusLine fingerprint (`resets_at`) → account id, learned from processes born after the login was observed. */
  readonly #fingerprints = new Map<string, string>();
  /** Session id → account id known for certain (via a learned fingerprint). */
  readonly #sessionAccounts = new Map<string, string>();
  #logins: LoginEntry[];
  /** Path, mtime and size of `.claude.json` as last read; it is re-parsed only when these change. */
  #loginStat: string | undefined;
  #polling: Promise<void> | undefined;
  /** Newest registry entry per session id, from the last refresh. */
  #registry = new Map<string, RegistryEntry>();
  #sessions = new Map<string, Session>();
  /** tmux panes of live sessions that can take a prompt, by session id. */
  #panes = new Map<string, Pane>();
  #files = new Map<string, TranscriptFile>();
  #liveCwd = new Map<string, string>();
  #version: string | undefined;
  #found = false;
  #hub: Hub | undefined;
  #timer: NodeJS.Timeout | undefined;
  #refreshing = false;

  constructor(options: ClaudeOptions) {
    this.home = options.home;
    this.#historyDays = options.historyDays;
    this.#now = options.now ?? Date.now;
    this.#tmux = options.tmux ?? 'tmux';
    this.#exec = options.exec ?? defaultExec;
    this.#logins = options.logins ?? [];
    this.#saveLogins = options.saveLogins;
    this.#labels = options.labels ?? {};
  }

  async start(hub: Hub): Promise<void> {
    this.#hub = hub;
    await this.refresh();
    this.#timer = setInterval(() => {
      this.refresh().catch((err: unknown) => console.error('wristline: claude-code refresh failed:', err));
    }, REFRESH_MS);
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#transcripts.clear();
  }

  health(): ProviderHealth {
    const health: ProviderHealth = { id: this.id, status: this.#found ? 'ok' : 'not_found' };
    if (this.#version) health.version = this.#version;
    return health;
  }

  listSessions(): Session[] {
    return [...this.#sessions.values()];
  }

  hasSession(nativeId: string): boolean {
    return this.#sessions.has(nativeId);
  }

  async readItems(nativeId: string, before: number | undefined, limit: number): Promise<ItemPage | undefined> {
    const transcript = this.#transcript(nativeId);
    return transcript?.page(before, limit);
  }

  watch(nativeId: string, onItem: (item: Item) => void): () => void {
    return this.#transcript(nativeId)?.subscribe(onItem) ?? (() => {});
  }

  /**
   * Types the prompt into the session's tmux pane and presses Enter, as if typed there. Text
   * already in the input box stays in front of it. A leading `!` would switch the input box to
   * shell mode and run the text as a command, so it is refused; `/` commands are allowed.
   */
  async sendPrompt(nativeId: string, text: string): Promise<void> {
    const session = this.#sessions.get(nativeId);
    if (!session) throw new PromptBlocked('not_live');
    if (session.promptBlock) throw new PromptBlocked(session.promptBlock);
    if (this.#hub?.pending.hasSession(session.id)) throw new PromptBlocked('awaiting_input');
    if (/^[\s\u0000-\u001f\u007f]*!/.test(text)) throw new PromptBlocked('unsafe_prefix');
    const pane = this.#panes.get(nativeId);
    if (!pane) throw new PromptBlocked('no_tmux');
    // The snapshot is up to 2 s old: since then the process may have exited (the pane then shows
    // a shell) or a dialog may have opened, which Enter would answer with its default option.
    if (!pidAlive(pane.pid) || !sameProcess(pane)) throw new PromptBlocked('not_live');
    const entry = await readEntry(join(this.home, 'sessions', `${pane.pid}.json`));
    if (entry?.sessionId !== nativeId) throw new PromptBlocked('not_live');
    const block = promptBlock(mapStatus(entry.status), tmuxPane(entry.tmux) === pane.id);
    if (block) throw new PromptBlocked(block);
    await this.#checkPane(pane);
    // Control characters would act as keys (Enter, Esc, Ctrl-C) in the agent's input box. tmux
    // strips a trailing `;` from an argument (command separator); Claude Code trims the space.
    const line = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/;$/, '; ');
    await this.#exec(this.#tmux, ['send-keys', '-t', pane.id, '-l', '--', line]);
    await this.#exec(this.#tmux, ['send-keys', '-t', pane.id, 'Enter']);
  }

  /** Guards against typing into the wrong pane (the session's process must run inside it) or into copy mode. */
  async #checkPane(pane: Pane): Promise<void> {
    let probe: string;
    try {
      probe = await this.#exec(this.#tmux, ['display-message', '-p', '-t', pane.id, '#{pane_pid} #{pane_in_mode}']);
    } catch {
      throw new PromptBlocked('no_tmux'); // No tmux, no server on the default socket, or the pane is gone.
    }
    const [pid, inMode] = probe.trim().split(' ');
    const panePid = Number(pid);
    if (!Number.isInteger(panePid) || !descendsFrom(pane.pid, panePid)) throw new PromptBlocked('no_tmux');
    // In copy mode (e.g. scrolled back) keys run copy-mode bindings and never reach the process.
    if (inMode === '1') throw new PromptBlocked('busy');
  }

  /** Receives the statusLine JSON relayed to the local listener. Never rejects. */
  async statusline(input: unknown): Promise<void> {
    if (!isObject(input)) return;
    await this.#pollLogin();
    const usage = statuslineUsage(input, this.#now());
    if (usage) {
      const account = this.#usageAccount(str(input.session_id), statuslineFingerprint(input));
      if (account) usage.account = account;
      this.#hub?.usage(usage);
    }
    const ctx = statuslineContext(input);
    if (!ctx) return;
    const window = ctx.window ?? this.#statusContext.get(ctx.sessionId)?.window;
    this.#statusContext.set(ctx.sessionId, { used: ctx.used, window, at: this.#now() });
    const session = this.#sessions.get(ctx.sessionId);
    const context = this.#context(ctx.sessionId, this.#metas.get(ctx.sessionId)?.scan);
    if (session && context && JSON.stringify(session.context) !== JSON.stringify(context)) {
      session.context = context;
      this.#hub?.session(session);
    }
  }

  /** A learned fingerprint names the account for certain; otherwise the report goes to the home's current login. */
  #usageAccount(sessionId: string | undefined, fingerprint: string | undefined): Account | undefined {
    let id = fingerprint === undefined ? undefined : this.#fingerprints.get(fingerprint);
    let exact = id !== undefined;
    if (id === undefined) {
      const current = this.#logins.at(-1);
      if (!current) return undefined;
      id = current.id;
      const startedAt = sessionId === undefined ? undefined : this.#registry.get(sessionId)?.startedAt;
      // Only a process born after the login was observed teaches its fingerprint; an older one may still run under an earlier login.
      if (fingerprint !== undefined && startedAt !== undefined && startedAt >= Date.parse(current.at)) {
        this.#fingerprints.set(fingerprint, id);
        exact = true;
      }
    }
    if (exact && sessionId !== undefined) this.#sessionAccounts.set(sessionId, id);
    return this.#account(id, !exact);
  }

  #account(id: string, estimated: boolean): Account {
    const label = own(this.#labels, id) ?? this.#logins.findLast((login) => login.id === id)?.label ?? id.slice(0, 8);
    return estimated ? { id, label, estimated: true } : { id, label };
  }

  /** Records a changed login in the home's timeline; one poll at a time, and a failure keeps the previous value. */
  #pollLogin(): Promise<void> {
    this.#polling ??= this.#readLogin()
      .catch((err: unknown) => console.error(`wristline: claude-code: login poll of ${this.home} failed:`, err))
      .finally(() => {
        this.#polling = undefined;
      });
    return this.#polling;
  }

  async #readLogin(): Promise<void> {
    const path = await claudeJsonPath(this.home);
    let key = `${path}:missing`;
    try {
      const st = await stat(path);
      key = `${path}:${st.mtimeMs}:${st.size}`;
    } catch (err) {
      if (!isNotFound(err)) key = `${path}:unreadable`;
    }
    if (key === this.#loginStat) return;
    this.#loginStat = key; // Set first: a broken or unreadable file is reported once, not every 2 s.
    const account = await readClaudeAccount(this.home);
    if (!account) return;
    const logins = appendLogin(this.#logins, account, this.#now());
    if (logins === this.#logins) return;
    this.#logins = logins;
    await this.#saveLogins?.(logins);
  }

  /** The statusLine's live numbers when present, else the transcript's last assistant usage. */
  #context(id: string, meta: ClaudeMetaScan | undefined): Session['context'] {
    const reported = this.#statusContext.get(id);
    // A compaction since the last report outdates its count; the statusLine may not report again before the next turn.
    const fresh = reported && reported.at > (meta?.compactedAt ?? -Infinity);
    const used = (fresh ? reported.used : undefined) ?? meta?.contextUsed;
    if (used === undefined) return undefined;
    // Without a statusLine report, a count above 200k can only come from a 1M-context model.
    return { used, window: reported?.window ?? (used > DEFAULT_WINDOW ? EXTENDED_WINDOW : DEFAULT_WINDOW) };
  }

  /** Re-reads the live registry and recent transcripts; publishes sessions that changed. */
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
    const [registry, files] = await Promise.all([readRegistry(join(this.home, 'sessions')), scanTranscripts(join(this.home, 'projects')), this.#pollLogin()]);
    const now = this.#now();
    this.#found = files !== undefined;
    this.#files = files ?? new Map();

    const newest = new Map<string, RegistryEntry>();
    const live = new Map<string, RegistryEntry>();
    for (const entry of registry) {
      if ((newest.get(entry.sessionId)?.updatedAt ?? -1) < entry.updatedAt) newest.set(entry.sessionId, entry);
      if (isLive(entry, now) && (live.get(entry.sessionId)?.updatedAt ?? -1) < entry.updatedAt) live.set(entry.sessionId, entry);
    }
    this.#registry = newest;
    this.#version = [...newest.values()].sort((a, b) => b.updatedAt - a.updatedAt).find((e) => e.version)?.version;
    this.#liveCwd = new Map([...live].flatMap(([id, e]) => (e.cwd ? [[id, e.cwd] as const] : [])));
    // Several live entries can name the same pane (e.g. a stale one); only the newest may type there.
    const paneOwner = new Map<string, RegistryEntry>();
    for (const e of live.values()) {
      const pane = tmuxPane(e.tmux);
      if (pane && (paneOwner.get(pane)?.updatedAt ?? -1) < e.updatedAt) paneOwner.set(pane, e);
    }
    this.#panes = new Map([...paneOwner].map(([id, e]) => [e.sessionId, { id, pid: e.pid, procStart: e.procStart }]));

    const cutoff = now - this.#historyDays * DAY_MS;
    const history = [...this.#files]
      .filter(([, f]) => f.mtimeMs >= cutoff)
      .sort(([, a], [, b]) => b.mtimeMs - a.mtimeMs)
      .slice(0, HISTORY_MAX)
      .map(([id]) => id);
    const ids = new Set([...live.keys(), ...history]);

    for (const id of this.#metas.keys()) if (!ids.has(id)) this.#metas.delete(id);
    for (const id of this.#statusContext.keys()) if (!ids.has(id)) this.#statusContext.delete(id);
    for (const id of this.#sessionAccounts.keys()) if (!ids.has(id)) this.#sessionAccounts.delete(id);
    const next = new Map<string, Session>();
    for (const id of ids) {
      const file = this.#files.get(id);
      const meta = file ? await this.#scan(id, file) : undefined;
      next.set(id, this.#build(id, live.get(id), newest.get(id), file, meta));
    }

    const previous = this.#sessions;
    this.#sessions = next;
    for (const [id, session] of next) {
      const old = previous.get(id);
      if (!old || JSON.stringify(old) !== JSON.stringify(session)) this.#hub?.session(session);
    }
    for (const id of previous.keys()) if (!next.has(id)) this.#hub?.removed(sessionKey(this.id, id));
    this.#dismissAnswered(newest, live);
  }

  /**
   * Claude Code keeps a hook request open after the dialog was answered in the terminal, so the
   * registry decides: the status is `waiting` while a dialog is up and changes once it is answered.
   */
  #dismissAnswered(newest: Map<string, RegistryEntry>, live: Map<string, RegistryEntry>): void {
    const pending = this.#hub?.pending;
    if (!pending) return;
    const prefix = `${this.id}:`;
    for (const request of pending.list()) {
      if (!request.sessionId.startsWith(prefix)) continue;
      const id = request.sessionId.slice(prefix.length);
      const entry = newest.get(id);
      if (!entry) continue; // Not in the registry (e.g. headless); the timeout applies.
      const moved = entry.status !== 'waiting' && entry.statusUpdatedAt > Date.parse(request.createdAt);
      if (!live.has(id) || moved) pending.dismiss(request.id, 'terminal');
    }
  }

  async #scan(id: string, file: TranscriptFile): Promise<ClaudeMetaScan> {
    let meta = this.#metas.get(id);
    if (!meta || meta.path !== file.path) {
      const scan = new ClaudeMetaScan();
      meta = { path: file.path, size: -1, scan, tail: new JsonlTail(file.path, scan) };
      this.#metas.set(id, meta);
    }
    if (meta.size !== file.size) {
      await meta.tail.sync();
      meta.size = file.size;
    }
    return meta.scan;
  }

  #build(
    id: string,
    live: RegistryEntry | undefined,
    newest: RegistryEntry | undefined,
    file: TranscriptFile | undefined,
    meta: ClaudeMetaScan | undefined,
  ): Session {
    const status: SessionStatus = live ? mapStatus(live.status) : 'ended';
    const lastActivity = Math.max(file?.mtimeMs ?? 0, (live ?? newest)?.updatedAt ?? 0);
    const session: Session = {
      id: sessionKey(this.id, id),
      provider: this.id,
      title: sessionTitle(meta, newest?.name, newest?.nameSource),
      cwd: live?.cwd ?? newest?.cwd ?? meta?.cwd ?? '',
      status,
      lastActivity: new Date(lastActivity).toISOString(),
    };
    const block = promptBlock(status, this.#panes.has(id));
    if (block) session.promptBlock = block;
    const context = this.#context(id, meta);
    if (context) session.context = context;
    const known = this.#sessionAccounts.get(id);
    if (known) session.account = this.#account(known, false);
    else {
      // The login observed at the session's last activity; none for activity before the first observation.
      const login = loginAt(this.#logins, lastActivity);
      if (login) session.account = this.#account(login.id, isEstimated(this.#logins, newest?.startedAt));
    }
    return session;
  }

  #transcript(nativeId: string): Transcript | undefined {
    if (!this.#sessions.has(nativeId)) return undefined;
    const path = this.#files.get(nativeId)?.path ?? this.#expectedPath(nativeId);
    if (!path) return undefined;
    return this.#transcripts.get(nativeId, () => new Transcript(path, parseClaudeLine));
  }

  /** A live session writes its transcript only after the first message. */
  #expectedPath(nativeId: string): string | undefined {
    const cwd = this.#liveCwd.get(nativeId);
    return cwd ? join(this.home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${nativeId}.jsonl`) : undefined;
  }
}

function promptBlock(status: SessionStatus, hasPane: boolean): PromptBlock | undefined {
  if (status === 'ended') return 'not_live';
  if (!hasPane) return 'no_tmux';
  if (status === 'needs_input') return 'awaiting_input';
  return undefined;
}
