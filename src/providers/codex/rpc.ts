// Client for the Codex app-server daemon, and the subset of its v2 protocol (codex-cli 0.159.0)
// that the bridge reads.
//
// Types are hand-written instead of `codex app-server generate-ts`: the generated tree (~730
// files) uses extensionless relative imports, which do not compile under `moduleResolution:
// nodenext`. Field names mirror the generated types so they can be swapped in later.

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { join } from 'node:path';
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
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
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
  /** Replaces `<bin> app-server proxy --sock <socket>`; tests run a fake proxy script. */
  command?: { file: string; args: string[] };
  backoffMs?: { min: number; max: number };
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
 * the daemon is absent the client retries with a 1 s → 30 s backoff.
 *
 * Events: `ready` after each handshake, `closed` when a ready connection is lost,
 * `notification` (method, params).
 */
export class CodexRpc extends EventEmitter {
  readonly #options: RpcOptions;
  readonly #minBackoff: number;
  readonly #maxBackoff: number;
  readonly #timeoutMs: number;
  readonly #waiters = new Map<RequestId, Waiter>();
  #handler: ServerRequestHandler | undefined;
  #child: ChildProcess | undefined;
  #ws: WebSocket | undefined;
  #ready = false;
  #running = false;
  #nextId = 1;
  #backoff: number;
  #retry: NodeJS.Timeout | undefined;
  #detail = 'app-server not connected';

  constructor(options: RpcOptions) {
    super();
    this.#options = options;
    this.#minBackoff = options.backoffMs?.min ?? BACKOFF_MIN_MS;
    this.#maxBackoff = options.backoffMs?.max ?? BACKOFF_MAX_MS;
    this.#timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#backoff = this.#minBackoff;
  }

  get ready(): boolean {
    return this.#ready;
  }

  /** Human-readable connection state for `/api/health`. */
  get detail(): string {
    return this.#detail;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#connect();
  }

  stop(): void {
    this.#running = false;
    clearTimeout(this.#retry);
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
    if (!this.#running) return;
    let command = this.#options.command;
    if (!command) {
      const socket = controlSocket(this.#options.codexHome);
      try {
        await stat(socket);
      } catch {
        // No daemon: stay read-only and look again later, without spawning anything.
        this.#detail = 'app-server not running; read-only';
        this.#scheduleRetry();
        return;
      }
      command = { file: this.#options.bin ?? 'codex', args: ['app-server', 'proxy', '--sock', socket] };
    }
    if (!this.#running) return;
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
      this.#detail = isObject(err) && err.code === 'ENOENT' ? 'codex CLI not found; read-only' : `app-server proxy failed: ${err.message}; read-only`;
      this.#lost(child);
    });
    child.on('exit', () => {
      if (this.#child === child && !this.#ready) {
        const reason = stderr.split('\n').find((l) => l.trim())?.replace(/^Error:\s*/, '');
        this.#detail = `app-server unreachable${reason ? ` (${reason.trim()})` : ''}; read-only`;
      }
      this.#lost(child);
    });

    const ws = new WebSocket('ws://localhost/', { createConnection: () => stdioSocket(child) as unknown as Socket });
    this.#ws = ws;
    ws.on('message', (data: RawData) => this.#receive(data.toString()));
    ws.on('error', () => {}); // Followed by 'close'.
    ws.on('close', () => this.#lost(child));
    ws.on('open', () => {
      this.#handshake().catch((err: unknown) => {
        this.#detail = `app-server handshake failed: ${err instanceof Error ? err.message : String(err)}; read-only`;
        this.#lost(child);
      });
    });
  }

  async #handshake(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'wristline-bridge', title: 'Wristline', version: this.#options.clientVersion },
      capabilities: { optOutNotificationMethods: OPT_OUT },
    });
    this.notify('initialized');
    this.#ready = true;
    this.#backoff = this.#minBackoff;
    this.#detail = 'app-server connected';
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
      if (this.#running) this.#detail = 'app-server connection lost; reconnecting';
      this.emit('closed');
    }
  }

  #scheduleRetry(): void {
    if (!this.#running) return;
    clearTimeout(this.#retry);
    const delay = this.#backoff;
    this.#backoff = Math.min(this.#maxBackoff, this.#backoff * 2);
    this.#retry = setTimeout(() => void this.#connect(), delay);
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
