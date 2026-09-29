import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { JsonlTail, Transcript, TranscriptCache } from '../../jsonl.ts';
import type { Item, ItemPage, PromptBlock, ProviderHealth, Session, SessionStatus } from '../../protocol.ts';
import { PromptBlocked, sessionKey, type Hub, type SessionProvider } from '../../provider.ts';
import { isNotFound, isObject, num, str } from '../../util.ts';
import { ClaudeMetaScan, parseClaudeLine, sessionTitle, statuslineContext, statuslineUsage } from './parse.ts';

const REFRESH_MS = 2000;
const LIVE_MAX_AGE_MS = 24 * 3600_000;
const DAY_MS = 24 * 3600_000;
const HISTORY_MAX = 50;
const DEFAULT_WINDOW = 200_000;
const EXTENDED_WINDOW = 1_000_000;
const TMUX_TIMEOUT_MS = 5000;
/** Without procfs (macOS) the registry's pid is trusted; with it, an unreadable process has exited. */
const HAS_PROCFS = existsSync('/proc/self/stat');

interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string | undefined;
  name: string | undefined;
  nameSource: string | undefined;
  status: string | undefined;
  tmux: string | undefined;
  updatedAt: number;
  statusUpdatedAt: number;
  procStart: string | undefined;
  version: string | undefined;
}

interface TranscriptFile {
  path: string;
  mtimeMs: number;
  size: number;
}

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
}

export class ClaudeCodeProvider implements SessionProvider {
  readonly id = 'claude-code';
  readonly #home: string;
  readonly #historyDays: number;
  readonly #now: () => number;
  readonly #tmux: string;
  readonly #exec: Exec;
  readonly #transcripts = new TranscriptCache();
  readonly #metas = new Map<string, Meta>();
  /** Context reported by the statusLine, by session id; `at` is when the report arrived. */
  readonly #statusContext = new Map<string, { used?: number; window?: number; at: number }>();
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
    this.#home = options.home;
    this.#historyDays = options.historyDays;
    this.#now = options.now ?? Date.now;
    this.#tmux = options.tmux ?? 'tmux';
    this.#exec = options.exec ?? defaultExec;
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
    const entry = await readEntry(join(this.#home, 'sessions', `${pane.pid}.json`));
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

  /** Receives the statusLine JSON relayed to the local listener. */
  statusline(input: unknown): void {
    if (!isObject(input)) return;
    const usage = statuslineUsage(input, this.#now());
    if (usage) this.#hub?.usage(usage);
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
    const [registry, files] = await Promise.all([readRegistry(join(this.#home, 'sessions')), scanTranscripts(join(this.#home, 'projects'))]);
    const now = this.#now();
    this.#found = files !== undefined;
    this.#files = files ?? new Map();

    const newest = new Map<string, RegistryEntry>();
    const live = new Map<string, RegistryEntry>();
    for (const entry of registry) {
      if ((newest.get(entry.sessionId)?.updatedAt ?? -1) < entry.updatedAt) newest.set(entry.sessionId, entry);
      if (isLive(entry, now) && (live.get(entry.sessionId)?.updatedAt ?? -1) < entry.updatedAt) live.set(entry.sessionId, entry);
    }
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
    return cwd ? join(this.#home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${nativeId}.jsonl`) : undefined;
  }
}

function promptBlock(status: SessionStatus, hasPane: boolean): PromptBlock | undefined {
  if (status === 'ended') return 'not_live';
  if (!hasPane) return 'no_tmux';
  if (status === 'needs_input') return 'awaiting_input';
  return undefined;
}

/** The registry's `tmux` is `"<session>:@<window>.%<pane>"`; prompts target the `%<pane>` id. */
export function tmuxPane(value: string | undefined): string | undefined {
  const pane = value?.slice(value.lastIndexOf('.') + 1);
  return pane && /^%\d+$/.test(pane) ? pane : undefined;
}

/** Walks the parent chain in /proc; without procfs (macOS) the registry is trusted. */
function descendsFrom(pid: number, ancestor: number): boolean {
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

function mapStatus(status: string | undefined): SessionStatus {
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
function isLive(entry: RegistryEntry, now: number): boolean {
  if (!pidAlive(entry.pid)) return false;
  return entry.procStart && HAS_PROCFS ? sameProcess(entry) : now - entry.updatedAt < LIVE_MAX_AGE_MS;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isObject(err) && err.code === 'EPERM';
  }
}

/** Guards against pid reuse: `procStart` is field 22 (starttime) of /proc/<pid>/stat. */
function sameProcess(entry: { pid: number; procStart: string | undefined }): boolean {
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
async function readRegistry(dir: string): Promise<RegistryEntry[]> {
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

async function readEntry(path: string): Promise<RegistryEntry | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined; // Removed or half-written; the next refresh sees it.
  }
  if (!isObject(raw)) return undefined;
  const pid = num(raw.pid);
  const sessionId = str(raw.sessionId);
  const updatedAt = num(raw.updatedAt) ?? num(raw.startedAt);
  if (pid === undefined || !sessionId || updatedAt === undefined) return undefined;
  return {
    pid,
    sessionId,
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
async function scanTranscripts(dir: string): Promise<Map<string, TranscriptFile> | undefined> {
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
