// Client for the Codex app-server daemon, and the subset of its v2 protocol (codex-cli 0.159.0)
// that the bridge reads.
//
// Types are hand-written instead of `codex app-server generate-ts`: the generated tree (~730
// files) uses extensionless relative imports, which do not compile under `moduleResolution:
// nodenext`. Field names mirror the generated types so they can be swapped in later.

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { Duplex } from 'node:stream';
import { WebSocket, type RawData } from 'ws';
import { isObject, num, str } from '../../util.ts';

export type UserInput =
  | { type: 'text'; text: string }
  | { type: 'image' | 'localImage' | 'audio' | 'localAudio' | 'skill' | 'mention' };

export type CommandExecutionStatus = 'inProgress' | 'completed' | 'failed' | 'declined';
export type PatchApplyStatus = 'inProgress' | 'completed' | 'failed' | 'declined';
export type PatchChangeKind = { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null };

export interface FileUpdateChange {
  path: string;
  kind: PatchChangeKind;
  diff: string;
}

/** The ThreadItem variants the watch shows; the others are skipped. */
export type ThreadItem =
  | { type: 'userMessage'; id: string; content: UserInput[] }
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'plan'; id: string; text: string }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      status: CommandExecutionStatus;
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | { type: 'fileChange'; id: string; changes: FileUpdateChange[]; status: PatchApplyStatus };

export type ThreadActiveFlag = 'waitingOnApproval' | 'waitingOnUserInput';

export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: ThreadActiveFlag[] };

export interface ItemCompletedNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
  completedAtMs: number;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

/** `account/read`: `null` before a login. Only `chatgpt` logins have an account id (from `account/rateLimits/read`). */
export interface GetAccountResponse {
  account: { type: 'chatgpt'; email: string; planType: string } | { type: 'apiKey' } | { type: 'amazonBedrock' } | null;
}

/** `account/rateLimits/read`: `accountId` is the `chatgpt_account_id` the limits belong to, `null` for API-key logins. */
export interface GetAccountRateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  accountId: string | null;
}

// JSON-RPC client

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_MS = 15_000;
/** Streaming notifications the bridge never uses; the daemon skips them for this connection. */
const OPT_OUT = [
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'command/exec/outputDelta',
  'process/outputDelta',
  'turn/diff/updated',
];

export type RequestId = string | number;

/** A request the daemon sends to its clients (approvals, questions). */
export interface ServerRequest {
  id: RequestId;
  method: string;
  params: unknown;
}

/**
 * Answers a server request. Resolving undefined sends nothing, which leaves the request to the
 * daemon's other clients (e.g. the TUI); JSON-RPC has no "no decision" answer.
 */
export type ServerRequestHandler = (request: ServerRequest) => Promise<unknown> | undefined;

export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export interface RpcOptions {
  codexHome: string;
  /** The codex binary (default `codex` on PATH). */
  bin?: string;
  clientVersion: string;
  /** Replaces `<bin> app-server proxy --sock <socket>`; tests run a fake proxy script. The socket must still exist. */
  command?: { file: string; args: string[] };
  /** How often to look for the daemon while disconnected (default 15 s). */
  retryMs?: number;
  requestTimeoutMs?: number;
}

interface Waiter {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export function controlSocket(codexHome: string): string {
  return join(codexHome, 'app-server-control', 'app-server-control.sock');
}

/**
 * Connection to the Codex app-server daemon through `codex app-server proxy`, which pipes stdio
 * to the daemon's control socket. The socket speaks WebSocket (HTTP upgrade, one JSON-RPC message
 * per text frame, no `jsonrpc` field), so a WebSocket client runs over the proxy's stdio. While
 * the daemon is absent the client looks again every 15 s, and at once when the control socket
 * (a symlink the daemon replaces on each start) changes. One proxy child runs at a time.
 *
 * Events: `ready` after each handshake, `closed` when a ready connection is lost,
 * `notification` (method, params).
 */
export class CodexRpc extends EventEmitter {
  readonly #options: RpcOptions;
  readonly #socket: string;
  readonly #retryMs: number;
  readonly #timeoutMs: number;
  readonly #waiters = new Map<RequestId, Waiter>();
  #handler: ServerRequestHandler | undefined;
  #child: ChildProcess | undefined;
  #ws: WebSocket | undefined;
  #ready = false;
  #running = false;
  #connecting = false;
  #nextId = 1;
  #retry: NodeJS.Timeout | undefined;
  #watcher: FSWatcher | undefined;
  /** Identity of the socket behind the control symlink at the last look; undefined while there is none. */
  #target: string | undefined;
  #absent = false;
  #detail = 'app-server connecting';

  constructor(options: RpcOptions) {
    super();
    this.#options = options;
    this.#socket = controlSocket(options.codexHome);
    this.#retryMs = options.retryMs ?? RETRY_MS;
    this.#timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  get ready(): boolean {
    return this.#ready;
  }

  /**
   * Whether the last attempt found no daemon to talk to: no control socket, or a proxy that could not
   * reach it (exited before the handshake). False before the first attempt, while connecting or
   * connected, after a lost connection until the next attempt, and when the proxy cannot be run.
   */
  get absent(): boolean {
    return this.#absent;
  }

  /** Human-readable connection state for `/api/health`. */
  get detail(): string {
    return this.#detail;
  }

  /** Resolves once the first attempt is under way (the daemon found or not); the handshake follows. */
  start(): Promise<void> {
    if (this.#running) return Promise.resolve();
    this.#running = true;
    return this.#connect();
  }

  stop(): void {
    this.#running = false;
    clearTimeout(this.#retry);
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#teardown(new Error('stopped'));
  }

  onRequest(handler: ServerRequestHandler): void {
    this.#handler = handler;
  }

  /** Rejects with RpcError for an error response, or Error when disconnected or after 30 s. */
  request(method: string, params: unknown = {}): Promise<unknown> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('app-server not connected'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.#timeoutMs);
      this.#waiters.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  async #connect(): Promise<void> {
    if (!this.#running || this.#connecting) return;
    this.#connecting = true;
    try {
      this.#watchSocket();
      this.#target = await this.#readTarget();
      this.#absent = this.#target === undefined;
      if (this.#target === undefined) {
        // No daemon: look again later, without spawning anything.
        this.#setDetail('app-server reconnecting (not running); read-only');
        this.#scheduleRetry();
        return;
      }
      if (!this.#running) return;
      // Never two proxies: whatever child is left from an earlier attempt goes first.
      this.#teardown(new Error('reconnecting'));
      this.#spawn(this.#options.command ?? { file: this.#options.bin ?? 'codex', args: ['app-server', 'proxy', '--sock', this.#socket] });
    } finally {
      this.#connecting = false;
    }
  }

  #spawn(command: { file: string; args: string[] }): void {
    const child = spawn(command.file, command.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: this.#options.codexHome },
    });
    this.#child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', (err) => {
      this.#setDetail(isObject(err) && err.code === 'ENOENT' ? 'app-server reconnecting (codex CLI not found); read-only' : `app-server reconnecting (proxy failed: ${err.message}); read-only`);
      this.#lost(child);
    });
    child.on('exit', () => {
      if (this.#child === child && !this.#ready) {
        const reason = stderr.split('\n').find((l) => l.trim())?.replace(/^Error:\s*/, '');
        this.#setDetail(`app-server reconnecting (unreachable${reason ? `: ${reason.trim()}` : ''}); read-only`);
      }
      this.#lost(child);
    });

    const ws = new WebSocket('ws://localhost/', { createConnection: () => stdioSocket(child) as unknown as Socket });
    this.#ws = ws;
    let opened = false;
    ws.on('message', (data: RawData) => this.#receive(data.toString()));
    ws.on('error', () => {}); // Followed by 'close'.
    ws.on('close', () => {
      // Closed before the upgrade (it comes before the proxy's exit): no daemon took the connection.
      if (this.#child === child && !opened) this.#absent = true;
      this.#lost(child);
    });
    ws.on('open', () => {
      opened = true;
      this.#handshake().catch((err: unknown) => {
        this.#setDetail(`app-server reconnecting (handshake failed: ${err instanceof Error ? err.message : String(err)}); read-only`);
        this.#lost(child);
      });
    });
  }

  /** Follows the control socket's directory so a daemon (re)start is noticed at once, not at the next retry. */
  #watchSocket(): void {
    if (this.#watcher || !this.#running) return;
    try {
      this.#watcher = watch(dirname(this.#socket), () => void this.#socketChanged());
      this.#watcher.on('error', () => {
        this.#watcher?.close();
        this.#watcher = undefined;
      });
    } catch {
      // The directory does not exist yet; the next retry arms it again.
    }
  }

  async #socketChanged(): Promise<void> {
    const target = await this.#readTarget();
    if (!this.#running || target === this.#target || this.#connecting) return;
    this.#target = target;
    if (target === undefined) return; // Gone: the proxy's exit (or the retry) handles it.
    // A new daemon owns the socket now: any connection to the old one is stale.
    clearTimeout(this.#retry);
    if (this.#ready) this.#teardown(new Error('app-server replaced'));
    await this.#connect();
  }

  /** The socket's inode, not the link's text: a restarted daemon reuses the same /tmp path. */
  async #readTarget(): Promise<string | undefined> {
    try {
      const st = await stat(this.#socket);
      return `${st.dev}:${st.ino}:${st.ctimeMs}`;
    } catch {
      return undefined;
    }
  }

  #setDetail(detail: string): void {
    if (detail === this.#detail) return;
    this.#detail = detail;
    console.log(`wristline: codex ${detail}`);
  }

  async #handshake(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'wristline-bridge', title: 'Wristline', version: this.#options.clientVersion },
      capabilities: { optOutNotificationMethods: OPT_OUT },
    });
    this.notify('initialized');
    this.#ready = true;
    this.#setDetail('app-server connected');
    this.emit('ready');
  }

  #receive(text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(msg)) return;
    const method = str(msg.method);
    const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : undefined;
    if (method && id !== undefined) {
      this.#serve(this.#ws, { id, method, params: msg.params });
    } else if (method) {
      this.emit('notification', method, msg.params);
    } else if (id !== undefined) {
      const waiter = this.#waiters.get(id);
      if (!waiter) return;
      this.#waiters.delete(id);
      clearTimeout(waiter.timer);
      if (isObject(msg.error)) waiter.reject(new RpcError(num(msg.error.code) ?? -32603, str(msg.error.message) ?? 'error'));
      else waiter.resolve(msg.result);
    }
  }

  #serve(ws: WebSocket | undefined, request: ServerRequest): void {
    const answer = this.#handler?.(request);
    if (!answer) return;
    answer.then(
      (result) => {
        // An id belongs to one connection; never answer on a newer one.
        if (result !== undefined && ws === this.#ws && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: request.id, result }));
      },
      (err: unknown) => console.error(`wristline: codex ${request.method} handler failed:`, err),
    );
  }

  #lost(child: ChildProcess): void {
    if (this.#child !== child) return;
    this.#teardown(new Error('app-server connection closed'));
    this.#scheduleRetry();
  }

  #teardown(reason: Error): void {
    const wasReady = this.#ready;
    this.#ready = false;
    const ws = this.#ws;
    const child = this.#child;
    this.#ws = undefined;
    this.#child = undefined;
    ws?.removeAllListeners('close');
    ws?.terminate();
    child?.kill();
    for (const waiter of this.#waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    this.#waiters.clear();
    if (wasReady) {
      if (this.#running) this.#setDetail('app-server reconnecting (connection lost); read-only');
      this.emit('closed');
    }
  }

  #scheduleRetry(): void {
    if (!this.#running) return;
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => void this.#connect(), this.#retryMs);
  }
}

/** A socket-like stream over a child's stdin/stdout, for `ws`'s `createConnection`. */
function stdioSocket(child: ChildProcess): Duplex {
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      if (!child.stdin || child.stdin.destroyed) return callback(new Error('app-server proxy exited'));
      child.stdin.write(chunk, callback);
    },
    final(callback) {
      child.stdin?.end();
      callback();
    },
  });
  child.stdin?.on('error', () => {}); // EPIPE after the proxy exits; 'exit' handles it.
  child.stdout?.on('data', (chunk: Buffer) => stream.push(chunk));
  child.stdout?.on('end', () => stream.push(null));
  // Methods `ws` and `http` call on a net.Socket.
  return Object.assign(stream, { setNoDelay() {}, setTimeout() {}, setKeepAlive() {}, ref() {}, unref() {} });
}
