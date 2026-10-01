import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { PendingRegistry, type PendingOptions, type Presence } from './pending.ts';
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
/** A connection counts towards presence while its watch answered a ping (or connected) at most this long ago: one ping interval plus 5 s. */
const PONG_MAX_MS = 35_000;
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
  /** When the watch last answered a ping; its connect time until then. */
  lastPong: number;
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

/** Two values of one window id whose reset times are at most this far apart are the same window. */
const SAME_WINDOW_MS = 5 * 60_000;

/**
 * Of two values of one window id, the one to keep. Arrival order says little: each Claude Code
 * process reports the limits of its own last API response (an idle one keeps repeating them), and
 * Codex servers jitter a window's reset time by about a second between reports. So reset times at
 * most SAME_WINDOW_MS apart mean the same window: usage only grows within it, so the higher
 * `usedPercent` wins, with the later reset time. Reset times further apart are two windows, and the
 * later one is the newer. Without a reset time on either side (Codex sends none for some limits)
 * nothing tells a stale report from a reset, so the reported (newer) value wins, even when lower,
 * and a known reset time is kept. Within one window the optional fields either value carries are
 * kept, in the stored value's field order, so an unchanged merge is no change.
 */
function mergeWindow(stored: UsageWindow, reported: UsageWindow): UsageWindow {
  const a = stored.resetsAt === undefined ? undefined : Date.parse(stored.resetsAt);
  const b = reported.resetsAt === undefined ? undefined : Date.parse(reported.resetsAt);
  if (a !== undefined && b !== undefined && Math.abs(a - b) > SAME_WINDOW_MS) return a > b ? stored : reported;
  const merged = { ...stored, ...reported };
  if (a !== undefined && b !== undefined) {
    merged.usedPercent = Math.max(stored.usedPercent, reported.usedPercent);
    if (a > b) merged.resetsAt = stored.resetsAt;
  } else if (a !== undefined) {
    merged.resetsAt = stored.resetsAt;
  }
  return merged;
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
    byId.set(w.id, old ? mergeWindow(old, w) : w);
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
  /** The same for alert ids and timestamps; `now` also expires usage windows, times the usage throttle and ages pongs. */
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
  /** The account id each home (provider instance) is logged into now, undefined when logged out; only homes that reported one. */
  readonly #logins = new Map<SessionProvider, string | undefined>();
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
    // An account no home is logged into now is kept (it shows again at once if one logs back in) but never sent.
    if (changed && this.#visible(merged)) this.#publishUsage(key);
  }

  login(provider: SessionProvider, accountId: string | undefined): void {
    if (this.#logins.has(provider) && this.#logins.get(provider) === accountId) return;
    const before = new Map([...this.#usage].map(([key, u]) => [key, this.#visible(u)]));
    this.#logins.set(provider, accountId);
    for (const [key, u] of this.#usage) {
      if (this.#visible(u) === before.get(key)) continue;
      // Sent at once, past the throttle: a removal must not wait, nor an entry coming back; a change held back for one now hidden is void.
      const t = this.#usageThrottles.get(key);
      if (t) {
        clearTimeout(t.timer);
        t.timer = undefined;
        t.pending = false;
      }
      this.#sendUsage(key);
    }
  }

  /**
   * Whether the watch may see the entry: always without an account, else only while its account is
   * the current login of a home of its provider. Until a home of that provider has reported its
   * login there is nothing to go by, and every entry passes.
   */
  #visible(usage: Usage): boolean {
    if (!usage.account) return true;
    let reported = false;
    for (const [p, id] of this.#logins) {
      if (p.id !== usage.provider) continue;
      if (id === usage.account.id) return true;
      reported = true;
    }
    return !reported;
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

  /** An entry whose last window has reset, or whose account is no longer logged in, is sent with no windows: the watch drops it. */
  #sendUsage(key: string): void {
    const stored = this.#usage.get(key);
    if (!stored) return;
    const shown = this.#visible(stored) ? this.#current(key) : undefined;
    this.#broadcast({ type: 'usage', usage: shown ?? { ...stored, windows: [] } });
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

  /** The merged entries of accounts logged in now (and those without an account), without windows whose reset time has passed. */
  usageList(): Usage[] {
    return [...this.#usage].flatMap(([key, u]) => (this.#visible(u) ? (this.#current(key) ?? []) : []));
  }

  /** The buffered alerts of the past ALERT_TTL_MS, oldest first: a reconnecting watch posts the ones it missed. */
  alerts(): Alert[] {
    const since = this.#now() - ALERT_TTL_MS;
    return this.#alerts.filter((a) => Date.parse(a.at) >= since);
  }

  /**
   * `GET /local/presence`: the registry's, except that open connections whose watch has not answered
   * a ping for PONG_MAX_MS (e.g. it lost its network without closing) count as gone from then on,
   * since an alert sent into them reaches nobody. With `codexThread`, whether a finished turn of that
   * thread raises a `done` alert at all (an embedded-server TUI's does not).
   */
  presence(codexThread?: string): Presence {
    let lastPong = Number.NEGATIVE_INFINITY;
    for (const c of this.#clients) lastPong = Math.max(lastPong, c.lastPong);
    let presence = this.pending.presence();
    if (presence.watch && this.#now() - lastPong > PONG_MAX_MS) presence = { watch: false, since: new Date(lastPong + PONG_MAX_MS).toISOString() };
    if (codexThread === undefined) return presence;
    return { ...presence, covered: this.#providers.some((p) => p.id === 'codex' && p.covers?.(codexThread) === true) };
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
    const client: Client = { ws, deviceId, sessionId: null, kinds: undefined, mode: 'foreground', alive: true, lastPong: this.#now() };
    this.#clients.add(client);
    this.pending.watchConnected();
    this.#log(`wristline: watch ${deviceId.slice(0, 6)} connected`);
    ws.on('pong', () => {
      client.alive = true;
      client.lastPong = this.#now();
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
