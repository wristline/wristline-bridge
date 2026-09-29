import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { JsonlTail, Transcript, TranscriptCache } from '../../jsonl.ts';
import type { Item, ItemPage, ProviderHealth, Session, SessionStatus } from '../../protocol.ts';
import { PromptBlocked, sessionKey, type Hub, type SessionProvider } from '../../provider.ts';
import { isNotFound, isObject, num, str } from '../../util.ts';
import { ClaudeMetaScan, parseClaudeLine, sessionTitle, statuslineUsage, statuslineWindow } from './parse.ts';

const REFRESH_MS = 2000;
const LIVE_MAX_AGE_MS = 24 * 3600_000;
const DAY_MS = 24 * 3600_000;
const HISTORY_MAX = 50;
const DEFAULT_WINDOW = 200_000;
const EXTENDED_WINDOW = 1_000_000;

interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string | undefined;
  name: string | undefined;
  status: string | undefined;
  updatedAt: number;
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

export interface ClaudeOptions {
  home: string;
  historyDays: number;
  now?: () => number;
}

export class ClaudeCodeProvider implements SessionProvider {
  readonly id = 'claude-code';
  readonly #home: string;
  readonly #historyDays: number;
  readonly #now: () => number;
  readonly #transcripts = new TranscriptCache();
  readonly #metas = new Map<string, Meta>();
  /** Context window sizes reported by the statusLine, by session id. */
  readonly #windows = new Map<string, number>();
  #sessions = new Map<string, Session>();
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

  async sendPrompt(nativeId: string): Promise<void> {
    // tmux delivery arrives with the hooks integration; until then every session is read-only.
    throw new PromptBlocked(this.#sessions.get(nativeId)?.promptBlock ?? 'not_live');
  }

  /** Receives the statusLine JSON relayed to the local listener. */
  statusline(input: unknown): void {
    if (!isObject(input)) return;
    const usage = statuslineUsage(input, this.#now());
    if (usage) this.#hub?.usage(usage);
    const ctx = statuslineWindow(input);
    if (ctx && this.#windows.get(ctx.sessionId) !== ctx.window) {
      this.#windows.set(ctx.sessionId, ctx.window);
      const session = this.#sessions.get(ctx.sessionId);
      if (session?.context) {
        session.context = { used: session.context.used, window: ctx.window };
        this.#hub?.session(session);
      }
    }
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

    const cutoff = now - this.#historyDays * DAY_MS;
    const history = [...this.#files]
      .filter(([, f]) => f.mtimeMs >= cutoff)
      .sort(([, a], [, b]) => b.mtimeMs - a.mtimeMs)
      .slice(0, HISTORY_MAX)
      .map(([id]) => id);
    const ids = new Set([...live.keys(), ...history]);

    for (const id of this.#metas.keys()) if (!ids.has(id)) this.#metas.delete(id);
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
      title: sessionTitle(meta, newest?.name),
      cwd: live?.cwd ?? newest?.cwd ?? meta?.cwd ?? '',
      status,
      lastActivity: new Date(lastActivity).toISOString(),
      promptBlock: status === 'ended' ? 'not_live' : 'unsupported',
    };
    const used = meta?.contextUsed;
    if (used !== undefined) {
      // Without a statusLine report, a count above 200k can only come from a 1M-context model.
      const window = this.#windows.get(id) ?? (used > DEFAULT_WINDOW ? EXTENDED_WINDOW : DEFAULT_WINDOW);
      session.context = { used, window };
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
    return cwd ? join(this.#home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${nativeId}.jsonl`) : undefined;
  }
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

function isLive(entry: RegistryEntry, now: number): boolean {
  return now - entry.updatedAt < LIVE_MAX_AGE_MS && pidAlive(entry.pid) && sameProcess(entry);
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
function sameProcess(entry: RegistryEntry): boolean {
  if (!entry.procStart) return true;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${entry.pid}/stat`, 'utf8');
  } catch {
    return true; // No procfs (macOS): fall back to the pid check alone.
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
  const entries = await Promise.all(
    names
      .filter((name) => /^\d+\.json$/.test(name))
      .map(async (name): Promise<RegistryEntry | undefined> => {
        let raw: unknown;
        try {
          raw = JSON.parse(await readFile(join(dir, name), 'utf8'));
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
          cwd: str(raw.cwd),
          name: str(raw.name),
          status: str(raw.status),
          procStart: str(raw.procStart),
          version: str(raw.version),
        };
      }),
  );
  return entries.filter((e) => e !== undefined);
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
