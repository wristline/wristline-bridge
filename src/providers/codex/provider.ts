import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { JsonlTail, Transcript, TranscriptCache } from '../../jsonl.ts';
import type { Item, ItemPage, ProviderHealth, Session, SessionStatus, Usage } from '../../protocol.ts';
import { PromptBlocked, sessionKey, type Hub, type SessionProvider } from '../../provider.ts';
import { isNotFound } from '../../util.ts';
import { CodexMetaScan, SessionIndex, parseCodexLine, usageOf } from './parse.ts';

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

export interface CodexOptions {
  home: string;
  historyDays: number;
  now?: () => number;
}

/**
 * Read-only view of Codex threads from rollout files. Status is inferred from turn events and
 * file age because the app-server daemon is not consulted yet.
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
  #sessions = new Map<string, Session>();
  #files = new Map<string, RolloutFile>();
  #usage: Usage | undefined;
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
  }

  async start(hub: Hub): Promise<void> {
    this.#hub = hub;
    await this.refresh();
    this.#timer = setInterval(() => {
      this.refresh().catch((err: unknown) => console.error('wristline: codex refresh failed:', err));
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
    return this.#transcript(nativeId)?.page(before, limit);
  }

  watch(nativeId: string, onItem: (item: Item) => void): () => void {
    return this.#transcript(nativeId)?.subscribe(onItem) ?? (() => {});
  }

  async sendPrompt(nativeId: string): Promise<void> {
    // Prompts go through the app-server (`turn/start`), which is not wired up yet.
    throw new PromptBlocked(this.#sessions.get(nativeId)?.promptBlock ?? 'not_live');
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

    const next = new Map<string, Session>();
    let latest: CodexMetaScan['rateLimits'];
    this.#version = undefined;
    for (const [id, file] of recent) {
      const meta = await this.#scan(id, file);
      if (meta.subagent) continue;
      this.#version ??= meta.version;
      if (meta.rateLimits && (!latest || latest.at < meta.rateLimits.at)) latest = meta.rateLimits;
      next.set(id, this.#build(id, file, meta, now));
    }

    const previous = this.#sessions;
    this.#sessions = next;
    for (const [id, session] of next) {
      const old = previous.get(id);
      if (!old || JSON.stringify(old) !== JSON.stringify(session)) this.#hub?.session(session);
    }
    for (const id of previous.keys()) if (!next.has(id)) this.#hub?.removed(sessionKey(this.id, id));

    if (latest && latest.at !== this.#usage?.updatedAt) {
      this.#usage = usageOf(latest.snapshot, latest.at);
      this.#hub?.usage(this.#usage);
    }
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
    const status: SessionStatus = meta.turnOpen ? 'running' : now - file.mtimeMs < IDLE_MS ? 'idle' : 'ended';
    const session: Session = {
      id: sessionKey(this.id, id),
      provider: this.id,
      title: this.#index.titles.get(id) ?? meta.firstPrompt ?? '',
      cwd: meta.cwd ?? '',
      status,
      lastActivity: new Date(file.mtimeMs).toISOString(),
      promptBlock: status === 'ended' ? 'not_live' : 'unsupported',
    };
    if (meta.context) session.context = meta.context;
    return session;
  }

  #transcript(nativeId: string): Transcript | undefined {
    const file = this.#sessions.has(nativeId) ? this.#files.get(nativeId) : undefined;
    return file && this.#transcripts.get(nativeId, () => new Transcript(file.path, parseCodexLine));
  }
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
