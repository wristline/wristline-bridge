import { WebSocket, type RawData } from 'ws';
import { PendingRegistry, type PendingOptions } from './pending.ts';
import {
  API_VERSION,
  CLOSE_REVOKED,
  type AlertKind,
  type Item,
  type PendingRequest,
  type ProviderHealth,
  type ServerEvent,
  type Session,
  type Usage,
} from './protocol.ts';
import type { Hub, SessionProvider } from './provider.ts';
import { parseJson } from './util.ts';

const SESSION_THROTTLE_MS = 2000;
const PING_MS = 30_000;
const STATUS_RANK: Record<Session['status'], number> = { needs_input: 0, running: 1, idle: 2, ended: 2 };

interface Client {
  ws: WebSocket;
  deviceId: string;
  sessionId: string | null;
  alive: boolean;
}

interface Throttle {
  last: number;
  timer?: NodeJS.Timeout;
  next?: Session;
}

export interface Target {
  provider: SessionProvider;
  nativeId: string;
}

export interface HubOptions {
  providers: SessionProvider[];
  /** Overrides for deterministic request ids and timestamps in tests. */
  pending?: Pick<PendingOptions, 'now' | 'newId'>;
}

/** Fans provider changes out to connected watches and tracks what each one subscribed to. */
export class BridgeHub implements Hub {
  readonly pending: PendingRegistry;
  readonly #providers: SessionProvider[];
  readonly #usage = new Map<string, Usage>();
  readonly #clients = new Set<Client>();
  readonly #watches = new Map<string, { stop: () => void; clients: Set<Client> }>();
  readonly #throttles = new Map<string, Throttle>();
  readonly #ping: NodeJS.Timeout;

  constructor(options: HubOptions) {
    this.#providers = options.providers;
    this.pending = new PendingRegistry({
      ...options.pending,
      onRequest: (request) => {
        this.#broadcast({ type: 'request', request });
        this.#refreshSession(request);
      },
      onResolved: (request, by) => {
        this.#broadcast({ type: 'resolved', requestId: request.id, by });
        this.#refreshSession(request);
      },
    });
    this.#ping = setInterval(() => this.#heartbeat(), PING_MS);
  }

  // Hub

  session(session: Session): void {
    const now = Date.now();
    const t = this.#throttles.get(session.id) ?? { last: Number.NEGATIVE_INFINITY };
    this.#throttles.set(session.id, t);
    if (!t.timer && now - t.last >= SESSION_THROTTLE_MS) {
      t.last = now;
      this.#broadcast({ type: 'session', session: this.#overlay(session) });
      return;
    }
    t.next = session;
    t.timer ??= setTimeout(() => {
      t.timer = undefined;
      t.last = Date.now();
      if (t.next) this.#broadcast({ type: 'session', session: this.#overlay(t.next) });
      t.next = undefined;
    }, t.last + SESSION_THROTTLE_MS - now);
  }

  removed(sessionId: string): void {
    clearTimeout(this.#throttles.get(sessionId)?.timer);
    this.#throttles.delete(sessionId);
    this.#broadcast({ type: 'session_removed', sessionId });
  }

  usage(usage: Usage): void {
    const previous = this.#usage.get(usage.provider);
    this.#usage.set(usage.provider, usage);
    // Unchanged numbers are not worth waking the watch radio for; GET /api/usage has the fresh timestamp.
    if (!previous || JSON.stringify(previous.windows) !== JSON.stringify(usage.windows)) this.#broadcast({ type: 'usage', usage });
  }

  alert(sessionId: string, alert: AlertKind, text?: string): void {
    this.#broadcast(text === undefined ? { type: 'alert', sessionId, alert } : { type: 'alert', sessionId, alert, text });
  }

  // Queries

  /** needs_input first, then running, then most recent activity. */
  sessions(): Session[] {
    return this.#providers
      .flatMap((p) => p.listSessions())
      .map((s) => this.#overlay(s))
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.lastActivity.localeCompare(a.lastActivity));
  }

  providerHealth(): ProviderHealth[] {
    return this.#providers.map((p) => p.health());
  }

  usageList(): Usage[] {
    return [...this.#usage.values()];
  }

  snapshot(): ServerEvent {
    return { type: 'snapshot', apiVersion: API_VERSION, sessions: this.sessions(), requests: this.pending.list(), usage: this.usageList() };
  }

  /** Finds the provider of a listed session. */
  resolve(sessionId: string): Target | undefined {
    const colon = sessionId.indexOf(':');
    if (colon < 0) return undefined;
    const provider = this.#providers.find((p) => p.id === sessionId.slice(0, colon));
    if (!provider?.listSessions().some((s) => s.id === sessionId)) return undefined;
    return { provider, nativeId: sessionId.slice(colon + 1) };
  }

  // WebSocket clients

  attach(ws: WebSocket, deviceId: string): void {
    const client: Client = { ws, deviceId, sessionId: null, alive: true };
    this.#clients.add(client);
    this.pending.watchConnected();
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const msg = parseJson(data.toString());
      // Unknown message types are ignored so newer watches can talk to older bridges.
      if (msg?.type === 'subscribe' && (msg.sessionId === null || typeof msg.sessionId === 'string')) this.#subscribe(client, msg.sessionId);
    });
    ws.on('close', () => {
      this.#unsubscribe(client);
      this.#clients.delete(client);
      this.pending.watchDisconnected();
    });
    ws.on('error', () => ws.terminate());
    this.#send(client, this.snapshot());
  }

  closeDevice(deviceId: string): void {
    for (const c of this.#clients) if (c.deviceId === deviceId) c.ws.close(CLOSE_REVOKED, 'revoked');
  }

  close(): void {
    clearInterval(this.#ping);
    for (const t of this.#throttles.values()) clearTimeout(t.timer);
    for (const c of this.#clients) c.ws.terminate();
    for (const w of this.#watches.values()) w.stop();
    this.#watches.clear();
  }

  #subscribe(client: Client, sessionId: string | null): void {
    this.#unsubscribe(client);
    const target = sessionId === null ? undefined : this.resolve(sessionId);
    if (!sessionId || !target) return;
    client.sessionId = sessionId;
    let watch = this.#watches.get(sessionId);
    if (!watch) {
      const clients = new Set<Client>();
      const stop = target.provider.watch(target.nativeId, (item: Item) => {
        const data = JSON.stringify({ type: 'item', sessionId, item } satisfies ServerEvent);
        for (const c of clients) this.#sendRaw(c, data);
      });
      watch = { stop, clients };
      this.#watches.set(sessionId, watch);
    }
    watch.clients.add(client);
  }

  #unsubscribe(client: Client): void {
    const id = client.sessionId;
    client.sessionId = null;
    const watch = id === null ? undefined : this.#watches.get(id);
    if (!id || !watch) return;
    watch.clients.delete(client);
    if (watch.clients.size === 0) {
      watch.stop();
      this.#watches.delete(id);
    }
  }

  /** An open request means the session waits on an answer; a prompt would have to wait too. */
  #overlay(session: Session): Session {
    if (!this.pending.hasSession(session.id)) return session;
    const lasting = session.promptBlock !== undefined && session.promptBlock !== 'busy';
    return { ...session, status: 'needs_input', promptBlock: lasting ? session.promptBlock : 'awaiting_input' };
  }

  #refreshSession(request: PendingRequest): void {
    const target = this.resolve(request.sessionId);
    const session = target?.provider.listSessions().find((s) => s.id === request.sessionId);
    if (session) this.session(session);
  }

  #heartbeat(): void {
    for (const c of this.#clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  #broadcast(event: ServerEvent): void {
    const data = JSON.stringify(event);
    for (const c of this.#clients) this.#sendRaw(c, data);
  }

  #send(client: Client, event: ServerEvent): void {
    this.#sendRaw(client, JSON.stringify(event));
  }

  #sendRaw(client: Client, data: string): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(data);
  }
}
