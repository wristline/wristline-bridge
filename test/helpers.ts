import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Auth, type AuthOptions } from '../src/auth.ts';
import { BridgeHub } from '../src/hub.ts';
import { pageItems } from '../src/jsonl.ts';
import { PendingRegistry } from '../src/pending.ts';
import type { Item, ItemKind, ItemPage, ProviderHealth, ProviderId, ResolvedBy, ServerEvent, Session, Usage } from '../src/protocol.ts';
import { PromptBlocked, type Hub, type SessionProvider } from '../src/provider.ts';
import { hookHandlers } from '../src/providers/claude-code/hooks.ts';
import { startServer, type RunningServer } from '../src/server.ts';

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

/** A hub that records what a provider publishes. */
export function recordingHub(): Hub & { sessions: Session[]; usages: Usage[]; removedIds: string[]; resolved: string[] } {
  const sessions: Session[] = [];
  const usages: Usage[] = [];
  const removedIds: string[] = [];
  const resolved: string[] = [];
  return {
    sessions,
    usages,
    removedIds,
    resolved,
    session: (s) => sessions.push(s),
    removed: (id) => removedIds.push(id),
    usage: (u) => usages.push(u),
    alert: () => {},
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

export interface Bridge {
  hub: BridgeHub;
  auth: Auth;
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
): Promise<Bridge> {
  let n = 0;
  const hub = new BridgeHub({ providers: Array.isArray(provider) ? provider : [provider], pending: { now, newId: () => `req-${++n}` } });
  const auth = new Auth({ devices: [], save, now });
  const hookToken = 'hook-token';
  const server = await startServer({
    hub,
    auth,
    bridge: { name: 'devbox', version: '0.1.0', apiVersion: 1 },
    hookToken,
    apiPort: 0,
    hookPort: 0,
    onStatusline: () => {},
    hooks: hookHandlers(hub, waitMs),
  });
  const { token } = await auth.issue('test watch');
  return {
    hub,
    auth,
    server,
    token,
    hookToken,
    base: `http://127.0.0.1:${server.apiPort}`,
    local: `http://127.0.0.1:${server.hookPort}`,
    close: async () => {
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
