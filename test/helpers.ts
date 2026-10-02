import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { AskRunner, type AskRunnerOptions } from '../src/ask.ts';
import { Auth, type AuthOptions } from '../src/auth.ts';
import { BridgeHub } from '../src/hub.ts';
import { pageItems } from '../src/jsonl.ts';
import { PendingRegistry } from '../src/pending.ts';
import type { Item, ItemKind, ItemPage, LimitReset, ProviderHealth, ProviderId, ResolvedBy, ServerEvent, Session, Usage } from '../src/protocol.ts';
import { PromptBlocked, type Hub, type SessionProvider } from '../src/provider.ts';
import { hookHandlers } from '../src/providers/claude-code/hooks.ts';
import { startServer, type RunningServer } from '../src/server.ts';

/** A logger that drops everything: the hub logs connections and deliveries to the console by default. */
export const quiet = (): void => {};

/** In-memory provider with deterministic data. */
export class FakeProvider implements SessionProvider {
  readonly id: ProviderId;
  sessions: Session[] = [];
  items = new Map<string, Item[]>();
  #watchers = new Map<string, Set<(item: Item) => void>>();

  constructor(id: ProviderId = 'claude-code') {
    this.id = id;
  }

  async start(_hub: Hub): Promise<void> {}
  stop(): void {}
  health(): ProviderHealth {
    return { id: this.id, status: 'ok', version: this.id === 'codex' ? '0.159.0' : '2.1.284' };
  }
  listSessions(): Session[] {
    return this.sessions;
  }
  async readItems(nativeId: string, before: number | undefined, limit: number, kinds?: ReadonlySet<ItemKind>): Promise<ItemPage | undefined> {
    const all = this.items.get(nativeId);
    return all && pageItems(all, before, limit, kinds);
  }
  watch(nativeId: string, onItem: (item: Item) => void): () => void {
    const set = this.#watchers.get(nativeId) ?? new Set();
    set.add(onItem);
    this.#watchers.set(nativeId, set);
    return () => set.delete(onItem);
  }
  emit(nativeId: string, item: Item): void {
    for (const fn of this.#watchers.get(nativeId) ?? []) fn(item);
  }
  async sendPrompt(nativeId: string, text: string): Promise<void> {
    if (text.startsWith('!')) throw new PromptBlocked('unsafe_prefix');
    const block = this.sessions.find((s) => s.id.endsWith(nativeId))?.promptBlock;
    if (block) throw new PromptBlocked(block);
  }
}

/** A hub that records what a provider publishes (`usages`: live numbers too); `logins` holds the account ids of its login reports, `null` for logged out. */
export function recordingHub(): Hub & {
  sessions: Session[];
  usages: Usage[];
  logins: (string | null)[];
  removedIds: string[];
  resolved: string[];
  alerts: ({ sessionId: string; alert: string; text?: string; title?: string } & LimitReset)[];
} {
  const sessions: Session[] = [];
  const usages: Usage[] = [];
  const logins: (string | null)[] = [];
  const removedIds: string[] = [];
  const resolved: string[] = [];
  const alerts: ({ sessionId: string; alert: string; text?: string; title?: string } & LimitReset)[] = [];
  return {
    sessions,
    usages,
    logins,
    removedIds,
    resolved,
    alerts,
    session: (s) => sessions.push(s),
    removed: (id) => removedIds.push(id),
    usage: (u) => {
      usages.push(u);
      return true;
    },
    liveUsage: (_provider, u) => void (u && usages.push(u)),
    login: (_provider, id) => logins.push(id ?? null),
    alert: (sessionId, alert, text, title, reset) => void alerts.push({ sessionId, alert, ...(text !== undefined && { text }), ...(title !== undefined && { title }), ...reset }),
    pending: new PendingRegistry({ onRequest: () => {}, onResolved: (r, by: ResolvedBy) => resolved.push(`${r.id}:${by}`) }),
  };
}

export async function waitFor<T>(get: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const FAKE_CLI = fileURLToPath(new URL('./fake-cli.ts', import.meta.url));

/**
 * An AskRunner whose `claude` and `codex` are test/fake-cli.ts (no real CLI); `fakeEnv` reaches it
 * (FAKE_MODE, FAKE_ARGV_FILE, FAKE_PID_FILE) and can be changed between asks. Its agent homes are
 * empty directories next to its config dir (`options.dir`, a fresh temp dir by default).
 */
export function fakeAskRunner(onEvent: AskRunnerOptions['onEvent'], fakeEnv: Record<string, string>, options: Partial<AskRunnerOptions> = {}): AskRunner {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'wristline-ask-'));
  return new AskRunner({
    dir,
    bins: { claude: 'claude', codex: 'codex' },
    claudeHome: join(dir, 'claude'),
    codexHome: join(dir, 'codex'),
    ask: { provider: 'claude-code', claudeModel: 'haiku', codexModel: 'gpt-6-astra' },
    onEvent,
    spawn: (bin, args, o) => spawn(process.execPath, [FAKE_CLI, bin, ...args], { cwd: o.cwd, env: { ...o.env, ...fakeEnv }, stdio: ['ignore', 'pipe', 'pipe'] }),
    ...options,
  });
}

export interface Bridge {
  hub: BridgeHub;
  auth: Auth;
  asks: AskRunner;
  server: RunningServer;
  base: string;
  local: string;
  token: string;
  hookToken: string;
  close(): Promise<void>;
}

export async function startBridge(
  provider: SessionProvider | SessionProvider[],
  now = () => Date.parse('2026-09-29T10:00:00Z'),
  waitMs = 60_000,
  save: AuthOptions['save'] = async () => {},
  asks?: (onEvent: AskRunnerOptions['onEvent']) => AskRunner,
): Promise<Bridge> {
  let n = 0;
  let a = 0;
  const hub = new BridgeHub({
    providers: Array.isArray(provider) ? provider : [provider],
    pending: { now, newId: () => `req-${++n}` },
    alerts: { now, newId: () => `a1e47c00-0000-4000-8000-${String(++a).padStart(12, '0')}` },
    log: quiet,
  });
  const auth = new Auth({ devices: [], save, now });
  const hookToken = 'hook-token';
  const onEvent: AskRunnerOptions['onEvent'] = (deviceId, event) => hub.sendToDevice(deviceId, event);
  const runner = asks ? asks(onEvent) : fakeAskRunner(onEvent, { FAKE_MODE: 'ok' });
  const server = await startServer({
    hub,
    auth,
    bridge: { name: 'devbox', version: '0.1.0', apiVersion: 1 },
    hookToken,
    apiPort: 0,
    hookPort: 0,
    onStatusline: () => {},
    hooks: hookHandlers(hub, waitMs, (id) => runner.ownsClaudeSession(id)),
    asks: runner,
  });
  const { token } = await auth.issue('test watch');
  return {
    hub,
    auth,
    asks: runner,
    server,
    token,
    hookToken,
    base: `http://127.0.0.1:${server.apiPort}`,
    local: `http://127.0.0.1:${server.hookPort}`,
    close: async () => {
      runner.close();
      hub.close();
      await server.close();
    },
  };
}

/** WebSocket client that buffers events so none are lost between awaits. */
export class TestSocket {
  readonly ws: WebSocket;
  readonly #queue: ServerEvent[] = [];
  #waiter: (() => void) | undefined;

  constructor(url: string, token: string) {
    this.ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    this.ws.on('message', (data) => {
      this.#queue.push(JSON.parse(data.toString()) as ServerEvent);
      this.#waiter?.();
    });
  }

  async open(): Promise<this> {
    await once(this.ws, 'open');
    return this;
  }

  async next(timeoutMs = 3000): Promise<ServerEvent> {
    const deadline = Date.now() + timeoutMs;
    while (this.#queue.length === 0) {
      if (Date.now() > deadline) throw new Error('no event');
      await new Promise<void>((resolve) => {
        this.#waiter = resolve;
        setTimeout(resolve, 50);
      });
    }
    return this.#queue.shift() as ServerEvent;
  }

  pending(): number {
    return this.#queue.length;
  }

  send(value: unknown): void {
    this.ws.send(JSON.stringify(value));
  }

  close(): void {
    this.ws.close();
  }
}
