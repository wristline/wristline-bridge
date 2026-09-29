import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Auth, type AuthOptions } from '../src/auth.ts';
import { BridgeHub } from '../src/hub.ts';
import type { Item, ItemPage, ProviderHealth, ServerEvent, Session } from '../src/protocol.ts';
import { PromptBlocked, type Hub, type SessionProvider } from '../src/provider.ts';
import { hookHandlers } from '../src/providers/claude-code/hooks.ts';
import { startServer, type RunningServer } from '../src/server.ts';

/** In-memory provider with deterministic data. */
export class FakeProvider implements SessionProvider {
  readonly id = 'claude-code';
  sessions: Session[] = [];
  items = new Map<string, Item[]>();
  #watchers = new Map<string, Set<(item: Item) => void>>();

  async start(_hub: Hub): Promise<void> {}
  stop(): void {}
  health(): ProviderHealth {
    return { id: this.id, status: 'ok', version: '2.1.284' };
  }
  listSessions(): Session[] {
    return this.sessions;
  }
  async readItems(nativeId: string, before: number | undefined, limit: number): Promise<ItemPage | undefined> {
    const all = this.items.get(nativeId);
    if (!all) return undefined;
    const end = before === undefined ? all.length : Math.min(all.length, before - 1);
    const start = Math.max(0, end - limit);
    return { items: all.slice(start, end), hasMore: start > 0 };
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
  provider: SessionProvider,
  now = () => Date.parse('2026-09-29T10:00:00Z'),
  waitMs = 60_000,
  save: AuthOptions['save'] = async () => {},
): Promise<Bridge> {
  let n = 0;
  const hub = new BridgeHub({ providers: [provider], pending: { now, newId: () => `req-${++n}` } });
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
