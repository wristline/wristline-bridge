import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { PendingRegistry, type PendingOptions } from './pending.ts';
import {
  API_VERSION,
  CLOSE_REVOKED,
  type Alert,
  type AlertKind,
  type ClientMode,
  type Item,
  type PendingRequest,
  type ProviderHealth,
  type ProviderId,
  type ServerEvent,
  type Session,
  type Usage,
  type UsageWindow,
} from './protocol.ts';
import type { Hub, SessionProvider } from './provider.ts';
import { parseJson } from './util.ts';

const SESSION_THROTTLE_MS = 2000;
/** `usage` events per entry: at most one per minute (the first one at once). */
export const USAGE_THROTTLE_MS = 60_000;
const PING_MS = 30_000;
/** Alerts replayed in the snapshot: at most this many, none older than ALERT_TTL_MS. */
const ALERT_KEEP = 10;
const ALERT_TTL_MS = 10 * 60_000;
const STATUS_RANK: Record<Session['status'], number> = { needs_input: 0, running: 1, idle: 2, ended: 2 };

interface Client {
  ws: WebSocket;
  deviceId: string;
  sessionId: string | null;
  /** Item kinds the subscription wants; undefined for all. */
  kinds: ReadonlySet<string> | undefined;
  mode: ClientMode;
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

interface UsageThrottle {
  last: number;
  timer?: NodeJS.Timeout;
  /** A change arrived during the throttle window; the timer sends the entry's state at its end. */
  pending: boolean;
}

/** The identity of a usage entry: its provider and account (see the header of protocol.ts). */
export function usageKey(usage: Pick<Usage, 'provider' | 'account'>): string {
  return `${usage.provider}:${usage.account?.id ?? ''}`;
}

function expired(window: UsageWindow, now: number): boolean {
  return window.resetsAt !== undefined && Date.parse(window.resetsAt) < now;
}

/**
 * Of two values of one window, the one to keep. Each Claude Code process reports the limits of its
 * own last API response, and an idle one keeps repeating them, so arrival order says nothing: the
 * later reset time is the newer window, and within one window usage only grows. Without both reset
 * times the report wins.
 */
function newerWindow(stored: UsageWindow, reported: UsageWindow): UsageWindow {
  if (stored.resetsAt === undefined || reported.resetsAt === undefined) return reported;
  const [a, b] = [Date.parse(stored.resetsAt), Date.parse(reported.resetsAt)];
  if (a !== b) return a > b ? stored : reported;
  return stored.usedPercent > reported.usedPercent ? stored : reported;
}

/**
 * The report's windows, then the stored ones it did not mention. A statusLine report names only
 * the windows it happens to carry, so an omitted window keeps its last value until its reset time
 * passes; a window is only ever removed by that. Windows past their reset time are dropped first.
 */
export function mergeUsage(previous: Usage | undefined, next: Usage, now: number): Usage {
  const stored = new Map((previous?.windows ?? []).filter((w) => !expired(w, now)).map((w) => [w.id, w]));
  const byId = new Map<string, UsageWindow>();
  for (const w of next.windows) {
    if (expired(w, now)) continue;
    const old = stored.get(w.id);
    byId.set(w.id, old ? newerWindow(old, w) : w);
  }
  for (const [id, w] of stored) if (!byId.has(id)) byId.set(id, w);
  return { ...next, windows: [...byId.values()] };
}

/** A subscribe message's `kinds`: undefined (all) when absent or null, null when malformed. Unknown kinds just never match. */
function subscribeKinds(value: unknown): ReadonlySet<string> | undefined | null {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) && value.every((k) => typeof k === 'string') ? new Set(value) : null;
}

export interface HubOptions {
  /** May hold several instances of one provider id (one per agent home). */
  providers: SessionProvider[];
  /** Overrides for deterministic request ids and timestamps in tests. */
  pending?: Pick<PendingOptions, 'now' | 'newId'>;
  /** The same for alert ids and timestamps; `now` also expires usage windows and times the usage throttle. */
  alerts?: Pick<PendingOptions, 'now' | 'newId'>;
  /** Test override of USAGE_THROTTLE_MS. */
  usageThrottleMs?: number;
  /** Info lines (connections, alert and request delivery; never their text). Defaults to console.log. */
  log?: (line: string) => void;
}

/** Fans provider changes out to connected watches and tracks what each one subscribed to. */
export class BridgeHub implements Hub {
  readonly pending: PendingRegistry;
  readonly #providers: SessionProvider[];
  readonly #usage = new Map<string, Usage>();
  /** Providers that have reported a labelled usage entry; their unlabelled reports are stale from then on (see protocol.md). */
  readonly #labelled = new Set<ProviderId>();
  readonly #clients = new Set<Client>();
  readonly #watches = new Map<string, { stop: () => void; clients: Set<Client> }>();
  readonly #throttles = new Map<string, Throttle>();
  readonly #usageThrottles = new Map<string, UsageThrottle>();
  readonly #usageThrottleMs: number;
  readonly #ping: NodeJS.Timeout;
  /** Oldest first, at most ALERT_KEEP. */
  readonly #alerts: Alert[] = [];
  /** Status as last broadcast per session: a background client hears of a change to or from needs_input only. */
  readonly #lastStatus = new Map<string, Session['status']>();
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #log: (line: string) => void;

  constructor(options: HubOptions) {
    this.#providers = options.providers;
    this.#log = options.log ?? console.log;
    this.#now = options.alerts?.now ?? Date.now;
    this.#newId = options.alerts?.newId ?? randomUUID;
    this.#usageThrottleMs = options.usageThrottleMs ?? USAGE_THROTTLE_MS;
    this.pending = new PendingRegistry({
      ...options.pending,
      onRequest: (request) => {
        this.#broadcast({ type: 'request', request });
        this.#log(`wristline: request ${request.id} broadcast clients=${this.#reach().clients}`);
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
    // The watch lists live sessions only: one that ends leaves its list (and cancels a throttled update).
    if (this.#overlay(session).status === 'ended') return this.removed(session.id);
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
    // A background client told the session needs input would otherwise keep showing that.
    const waited = this.#lastStatus.get(sessionId) === 'needs_input';
    this.#lastStatus.delete(sessionId);
    this.#broadcast({ type: 'session_removed', sessionId }, waited);
  }

  usage(usage: Usage): void {
    if (!usage.account && this.#labelled.has(usage.provider)) return;
    const key = usageKey(usage);
    const previous = this.#usage.get(key);
    // Another home's older snapshot of this account (a rollout) must not replace its live numbers.
    if (previous && usage.updatedAt < previous.updatedAt) return;
    const now = this.#now();
    let merged = mergeUsage(previous, usage, now);
    // Once the provider names an account, its unlabelled entry is stale; a watch drops it with the next snapshot.
    // The windows it reported before the account was known are this account's: they are folded in, not dropped.
    if (usage.account) {
      const unlabelledKey = usageKey({ provider: usage.provider });
      merged = mergeUsage(this.#usage.get(unlabelledKey), merged, now);
      this.#labelled.add(usage.provider);
      this.#usage.delete(unlabelledKey);
      clearTimeout(this.#usageThrottles.get(unlabelledKey)?.timer);
      this.#usageThrottles.delete(unlabelledKey);
    }
    this.#usage.set(key, merged);
    // Unchanged numbers are not worth waking the watch radio for; GET /api/usage has the fresh timestamp.
    // Windows merely listed in another order (a report without one of them comes first) are unchanged too.
    const numbers = (u: Usage): string => JSON.stringify([[...u.windows].sort((x, y) => (x.id < y.id ? -1 : 1)), u.account]);
    const changed = !previous || numbers(previous) !== numbers(merged);
    if (changed) this.#publishUsage(key);
  }

  /** At most one `usage` event per entry and USAGE_THROTTLE_MS; a change inside the window is sent at its end, in its then-current state. */
  #publishUsage(key: string): void {
    const now = this.#now();
    const t = this.#usageThrottles.get(key) ?? { last: Number.NEGATIVE_INFINITY, pending: false };
    this.#usageThrottles.set(key, t);
    if (now - t.last >= this.#usageThrottleMs) {
      clearTimeout(t.timer);
      t.timer = undefined;
      t.pending = false;
      t.last = now;
      this.#sendUsage(key);
      return;
    }
    t.pending = true;
    t.timer ??= setTimeout(() => {
      t.timer = undefined;
      t.last = this.#now();
      if (t.pending) this.#sendUsage(key);
      t.pending = false;
    }, t.last + this.#usageThrottleMs - now);
  }

  /** An entry whose last window has reset is sent with no windows, so the watch clears its stale numbers. */
  #sendUsage(key: string): void {
    const stored = this.#usage.get(key);
    if (!stored) return;
    this.#broadcast({ type: 'usage', usage: this.#current(key) ?? { ...stored, windows: [] } });
  }

  /** The entry as the watch should see it now: without windows whose reset time has passed; undefined when none is left. */
  #current(key: string): Usage | undefined {
    const stored = this.#usage.get(key);
    if (!stored) return undefined;
    const now = this.#now();
    const windows = stored.windows.filter((w) => !expired(w, now));
    return windows.length === 0 ? undefined : windows.length === stored.windows.length ? stored : { ...stored, windows };
  }

  alert(sessionId: string, kind: AlertKind, text?: string, title?: string): void {
    const alert: Alert = { id: this.#newId(), at: new Date(this.#now()).toISOString(), sessionId, alert: kind, ...(text === undefined ? {} : { text }), ...(title === undefined ? {} : { title }) };
    this.#alerts.push(alert);
    if (this.#alerts.length > ALERT_KEEP) this.#alerts.shift();
    this.#broadcast({ type: 'alert', ...alert });
    const { clients, bg } = this.#reach();
    this.#log(`wristline: alert ${kind} id=${alert.id} clients=${clients} bg=${bg}`);
  }

  /** To every foreground connection of one device only (a Quick Ask answer is nobody else's business). */
  sendToDevice(deviceId: string, event: ServerEvent): void {
    const data = JSON.stringify(event);
    for (const c of this.#clients) if (c.deviceId === deviceId && c.mode === 'foreground') this.#sendRaw(c, data);
  }

  // Queries

  /** Live sessions only (not ended): needs_input first, then running, then most recent activity. A session two instances list (a copied home) counts once, from the first, as in `resolve`. */
  sessions(): Session[] {
    const byId = new Map<string, Session>();
    for (const p of this.#providers) for (const s of p.listSessions()) if (!byId.has(s.id)) byId.set(s.id, this.#overlay(s));
    return [...byId.values()].filter((s) => s.status !== 'ended').sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.lastActivity.localeCompare(a.lastActivity));
  }

  providerHealth(): ProviderHealth[] {
    return this.#providers.map((p) => p.health());
  }

  /** The merged entries, without windows whose reset time has passed. */
  usageList(): Usage[] {
    return [...this.#usage.keys()].flatMap((key) => this.#current(key) ?? []);
  }

  /** The buffered alerts of the past ALERT_TTL_MS, oldest first: a reconnecting watch posts the ones it missed. */
  alerts(): Alert[] {
    const since = this.#now() - ALERT_TTL_MS;
    return this.#alerts.filter((a) => Date.parse(a.at) >= since);
  }

  snapshot(): ServerEvent {
    return { type: 'snapshot', apiVersion: API_VERSION, sessions: this.sessions(), requests: this.pending.list(), usage: this.usageList(), alerts: this.alerts() };
  }

  /** Finds the provider instance that lists the session. */
  resolve(sessionId: string): Target | undefined {
    const colon = sessionId.indexOf(':');
    if (colon < 0) return undefined;
    const id = sessionId.slice(0, colon);
    const provider = this.#providers.find((p) => p.id === id && p.listSessions().some((s) => s.id === sessionId));
    return provider && { provider, nativeId: sessionId.slice(colon + 1) };
  }

  // WebSocket clients

  attach(ws: WebSocket, deviceId: string): void {
    const client: Client = { ws, deviceId, sessionId: null, kinds: undefined, mode: 'foreground', alive: true };
    this.#clients.add(client);
    this.pending.watchConnected();
    this.#log(`wristline: watch ${deviceId.slice(0, 6)} connected`);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const msg = parseJson(data.toString());
      // Unknown message types are ignored so newer watches can talk to older bridges.
      if (msg?.type === 'subscribe' && (msg.sessionId === null || typeof msg.sessionId === 'string')) {
        const kinds = subscribeKinds(msg.kinds);
        if (kinds !== null) this.#subscribe(client, msg.sessionId, kinds);
      } else if (msg?.type === 'mode' && (msg.mode === 'foreground' || msg.mode === 'background')) {
        client.mode = msg.mode;
      }
    });
    ws.on('close', () => {
      this.#unsubscribe(client);
      this.#clients.delete(client);
      this.pending.watchDisconnected();
      this.#log(`wristline: watch ${deviceId.slice(0, 6)} disconnected`);
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
    for (const t of this.#usageThrottles.values()) clearTimeout(t.timer);
    for (const c of this.#clients) c.ws.terminate();
    for (const w of this.#watches.values()) w.stop();
    this.#watches.clear();
  }

  #subscribe(client: Client, sessionId: string | null, kinds: ReadonlySet<string> | undefined): void {
    this.#unsubscribe(client);
    const target = sessionId === null ? undefined : this.resolve(sessionId);
    if (!sessionId || !target) return;
    client.sessionId = sessionId;
    client.kinds = kinds;
    let watch = this.#watches.get(sessionId);
    if (!watch) {
      const clients = new Set<Client>();
      const stop = target.provider.watch(target.nativeId, (item: Item) => {
        const data = JSON.stringify({ type: 'item', sessionId, item } satisfies ServerEvent);
        for (const c of clients) if (c.mode === 'foreground' && (!c.kinds || c.kinds.has(item.kind))) this.#sendRaw(c, data);
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

  #broadcast(event: ServerEvent, background = this.#forBackground(event)): void {
    const data = JSON.stringify(event);
    for (const c of this.#clients) if (c.mode === 'foreground' || background) this.#sendRaw(c, data);
  }

  /** What a background client hears: requests and their resolution, alerts, and a session entering or leaving needs_input (`removed` adds the removal of one that needed input). */
  #forBackground(event: ServerEvent): boolean {
    switch (event.type) {
      case 'request':
      case 'resolved':
      case 'alert':
        return true;
      case 'session': {
        const { id, status } = event.session;
        const was = this.#lastStatus.get(id) === 'needs_input';
        this.#lastStatus.set(id, status);
        return was !== (status === 'needs_input');
      }
      default:
        return false;
    }
  }

  /** Open connections, and how many of them are in background mode: whom a request or alert broadcast reached. */
  #reach(): { clients: number; bg: number } {
    let clients = 0;
    let bg = 0;
    for (const c of this.#clients) {
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      clients++;
      if (c.mode === 'background') bg++;
    }
    return { clients, bg };
  }

  #send(client: Client, event: ServerEvent): void {
    this.#sendRaw(client, JSON.stringify(event));
  }

  #sendRaw(client: Client, data: string): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(data);
  }
}
