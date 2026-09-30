import { createServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { safeEqual, type Auth } from './auth.ts';
import type { Device } from './config.ts';
import type { BridgeHub } from './hub.ts';
import {
  ITEM_KINDS,
  TEXT_MAX,
  type Answers,
  type ApiError,
  type BridgeInfo,
  type ErrorCode,
  type Health,
  type ItemKind,
  type ItemPage,
  type PairResponse,
  type RequestList,
  type SessionList,
  type UsageList,
} from './protocol.ts';
import { PromptBlocked } from './provider.ts';
import { clip, isObject, parseJson, str } from './util.ts';

const PUBLIC_BODY_MAX = 64 * 1024;
const LOCAL_BODY_MAX = 10 * 1024 * 1024;
const DEFAULT_PAGE = 40;
const MAX_PAGE = 200;
const DEVICE_NAME_MAX = 64;
const REALM = 'Bearer realm="wristline"';

// Local API bodies, shared with the CLI.
export type LocalPairResponse = { code: string; expiresAt: string } | { token: string; deviceId: string };
export interface LocalDevices {
  devices: Pick<Device, 'id' | 'name' | 'createdAt'>[];
}

/**
 * Serves `POST /hooks/<name>` on the local listener. Resolves the hook's JSON output, or undefined
 * for an empty 200 ("no decision"). `signal` aborts when the agent drops the request.
 */
export type HookHandler = (input: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown> | undefined>;

export interface ServerOptions {
  hub: BridgeHub;
  auth: Auth;
  bridge: BridgeInfo;
  /** Bearer token required on the local listener. */
  hookToken: string;
  apiPort: number;
  hookPort: number;
  host?: string;
  onStatusline(body: unknown): void;
  hooks?: ReadonlyMap<string, HookHandler>;
}

export interface RunningServer {
  apiPort: number;
  hookPort: number;
  close(): Promise<void>;
}

type Headers = Record<string, string | number>;

function send(res: ServerResponse, status: number, body?: unknown, headers: Headers = {}): void {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'cache-control': 'no-store',
    ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) }),
    ...headers,
  });
  res.end(data);
}

function fail(res: ServerResponse, status: number, error: ErrorCode, headers: Headers = {}): void {
  send(res, status, { error } satisfies ApiError, headers);
}

function bearer(req: IncomingMessage): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  return match?.[1];
}

const TOO_LARGE = Symbol('too large');

/** Resolves undefined for an empty or non-JSON-object body. */
function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown> | undefined | typeof TOO_LARGE> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) {
      req.resume();
      resolve(TOO_LARGE);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      req.off('data', onData);
      req.resume();
      resolve(TOO_LARGE);
    };
    req.on('data', onData);
    req.on('end', () => resolve(parseJson(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

/** Reads a JSON body or answers 413/400 itself (then resolves undefined). */
async function body(req: IncomingMessage, res: ServerResponse, limit: number): Promise<Record<string, unknown> | undefined> {
  const parsed = await readJson(req, limit);
  if (parsed === TOO_LARGE) {
    fail(res, 413, 'payload_too_large', { connection: 'close' });
    return undefined;
  }
  if (!parsed) fail(res, 400, 'bad_request');
  return parsed;
}

function parseAnswers(value: unknown): Answers | undefined {
  if (!isObject(value)) return undefined;
  const answers: Answers = {};
  for (const [key, ids] of Object.entries(value)) {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return undefined;
    answers[key] = ids;
  }
  return answers;
}

function positiveInt(value: string | null): number | undefined | null {
  if (value === null) return undefined;
  return /^[1-9]\d{0,9}$/.test(value) ? Number(value) : null;
}

/** A comma list of item kinds; null when any of them is unknown. */
function itemKinds(value: string | null): Set<ItemKind> | undefined | null {
  if (value === null) return undefined;
  const kinds = value.split(',');
  return kinds.every((k): k is ItemKind => (ITEM_KINDS as readonly string[]).includes(k)) ? new Set(kinds) : null;
}

/** Undefined for a request-target `URL` rejects (e.g. `//[`), which must not throw in the upgrade listener. */
function parseUrl(req: IncomingMessage): URL | undefined {
  try {
    return new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return undefined;
  }
}

/** A percent-decoded path segment; undefined when it is malformed (`%zz`). */
function decodeId(segment: string | undefined): string | undefined {
  try {
    return decodeURIComponent(segment ?? '');
  } catch {
    return undefined;
  }
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { hub, auth, bridge } = options;
  const host = options.host ?? '127.0.0.1';
  const wss = new WebSocketServer({ noServer: true, maxPayload: PUBLIC_BODY_MAX });

  /** Every public route except /api/pair needs a device token; failures feed the lockout. */
  const authorize = (req: IncomingMessage): Device | 401 | 429 => {
    const device = auth.authenticate(bearer(req));
    if (device) return device;
    if (auth.locked()) return 429;
    auth.recordFailure();
    return 401;
  };
  const denyHeaders = (status: 401 | 429): Headers =>
    status === 401 ? { 'www-authenticate': REALM } : { 'retry-after': auth.retryAfterSec() };

  const pair = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (auth.locked()) return fail(res, 429, 'rate_limited', denyHeaders(429));
    const input = await body(req, res, PUBLIC_BODY_MAX);
    if (!input) return;
    const code = str(input.code);
    const name = str(input.deviceName)?.trim();
    if (!code || !/^\d{6}$/.test(code) || !name) return fail(res, 400, 'bad_request');
    const result = await auth.pair(code, clip(name, DEVICE_NAME_MAX));
    if (result === 'no_window') return fail(res, 404, 'not_found');
    if (result === 'invalid_code') return fail(res, 401, 'invalid_code', denyHeaders(401));
    send(res, 200, { token: result.token, deviceId: result.device.id, bridge } satisfies PairResponse);
  };

  const handlePublic = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = parseUrl(req);
    if (!url) return fail(res, 400, 'bad_request');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method === 'POST' && path === '/api/pair') return pair(req, res);

    const device = authorize(req);
    if (typeof device === 'number') return fail(res, device, device === 401 ? 'unauthorized' : 'rate_limited', denyHeaders(device));

    if (method === 'GET' && path === '/api/health') {
      const health: Health = { ...bridge, providers: hub.providerHealth() };
      return send(res, 200, health);
    }
    if (method === 'DELETE' && path === '/api/device') {
      const revoked = auth.revoke(device.id);
      hub.closeDevice(device.id); // Not after the save, which may fail: the token is already gone from memory.
      await revoked;
      return send(res, 204);
    }
    if (method === 'GET' && path === '/api/sessions') return send(res, 200, { sessions: hub.sessions() } satisfies SessionList);
    if (method === 'GET' && path === '/api/requests') return send(res, 200, { requests: hub.pending.list() } satisfies RequestList);
    if (method === 'GET' && path === '/api/usage') return send(res, 200, { usage: hub.usageList() } satisfies UsageList);

    const session = /^\/api\/sessions\/([^/]+)\/(items|prompt)$/.exec(path);
    if (session) {
      const id = decodeId(session[1]);
      if (id === undefined) return fail(res, 400, 'bad_request');
      const target = hub.resolve(id);
      if (session[2] === 'items' && method === 'GET') {
        const before = positiveInt(url.searchParams.get('before'));
        const limit = positiveInt(url.searchParams.get('limit'));
        const kinds = itemKinds(url.searchParams.get('kinds'));
        if (before === null || limit === null || kinds === null) return fail(res, 400, 'bad_request');
        const page = target && (await target.provider.readItems(target.nativeId, before, Math.min(limit ?? DEFAULT_PAGE, MAX_PAGE), kinds));
        return page ? send(res, 200, page satisfies ItemPage) : fail(res, 404, 'not_found');
      }
      if (session[2] === 'prompt' && method === 'POST') {
        const input = await body(req, res, PUBLIC_BODY_MAX);
        if (!input) return;
        const text = str(input.text)?.trim();
        if (!text) return fail(res, 400, 'bad_request');
        if (text.length > TEXT_MAX) return fail(res, 413, 'payload_too_large');
        if (!target) return fail(res, 404, 'not_found');
        try {
          await target.provider.sendPrompt(target.nativeId, text);
        } catch (err) {
          if (err instanceof PromptBlocked) return fail(res, 409, err.code);
          throw err;
        }
        return send(res, 202, {});
      }
    }

    const request = /^\/api\/requests\/([^/]+)$/.exec(path);
    if (request && method === 'POST') {
      const id = decodeId(request[1]);
      if (id === undefined) return fail(res, 400, 'bad_request');
      const input = await body(req, res, PUBLIC_BODY_MAX);
      if (!input) return;
      const answers = parseAnswers(input.answers);
      if (!answers) return fail(res, 400, 'bad_request');
      const result = hub.pending.answer(id, answers);
      if (result === 'already_resolved') return fail(res, 409, 'already_resolved');
      if (result === 'invalid') return fail(res, 400, 'bad_request');
      return send(res, 200, {});
    }
    fail(res, 404, 'not_found');
  };

  const handleLocal = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Required even on loopback: WSL2 forwards localhost ports to Windows, where any browser page could post here.
    const token = bearer(req);
    if (!token || !safeEqual(token, options.hookToken)) return fail(res, 401, 'unauthorized', { 'www-authenticate': REALM });
    const url = parseUrl(req);
    if (!url) return fail(res, 400, 'bad_request');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'POST' && path === '/local/statusline') {
      const input = await body(req, res, LOCAL_BODY_MAX);
      if (!input) return;
      options.onStatusline(input);
      return send(res, 204);
    }
    const hook = /^\/hooks\/([a-z-]+)$/.exec(path);
    const handler = hook && options.hooks?.get(hook[1] ?? '');
    if (method === 'POST' && handler) {
      const input = await body(req, res, LOCAL_BODY_MAX);
      if (!input) return;
      // An agent that stops waiting may drop the connection. (Claude Code 2.1.284 keeps it open after a
      // terminal answer; the claude-code provider detects that from its session registry.)
      const ctrl = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) ctrl.abort();
      });
      const output = await handler(input, ctrl.signal);
      if (res.destroyed) return;
      if (output) return send(res, 200, output);
      res.writeHead(200, { 'cache-control': 'no-store', 'content-length': 0 });
      res.end();
      return;
    }
    if (method === 'POST' && path === '/local/pair') {
      const input = (await readJson(req, PUBLIC_BODY_MAX)) ?? {};
      if (input === TOO_LARGE) return fail(res, 413, 'payload_too_large');
      if (input.token === true) {
        const issued = await auth.issue(clip(str(input.name)?.trim() || 'watch', DEVICE_NAME_MAX));
        return send(res, 200, { token: issued.token, deviceId: issued.device.id } satisfies LocalPairResponse);
      }
      return send(res, 200, auth.startPairing() satisfies LocalPairResponse);
    }
    if (method === 'GET' && path === '/local/devices') {
      const devices = auth.devices().map(({ id, name, createdAt }) => ({ id, name, createdAt }));
      return send(res, 200, { devices } satisfies LocalDevices);
    }
    const revoke = /^\/local\/devices\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && revoke) {
      const id = decodeId(revoke[1]);
      if (id === undefined) return fail(res, 400, 'bad_request');
      const revoked = auth.revoke(id);
      hub.closeDevice(id); // Not after the save, which may fail: the token is already gone from memory.
      if (!(await revoked)) return fail(res, 404, 'not_found');
      return send(res, 204);
    }
    fail(res, 404, 'not_found');
  };

  const guard =
    (handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) =>
    (req: IncomingMessage, res: ServerResponse): void => {
      handler(req, res).catch((err: unknown) => {
        console.error(`wristline: ${req.method} ${req.url} failed:`, err);
        if (!res.headersSent) fail(res, 500, 'internal');
        else res.destroy();
      });
    };

  const publicServer = createServer(guard(handlePublic));
  const localServer = createServer(guard(handleLocal));

  publicServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node hands the socket over without an error listener: a peer reset would otherwise crash the process.
    const onError = (): void => {
      socket.destroy();
    };
    socket.on('error', onError);
    const url = parseUrl(req);
    if (!url) return reject(socket, 400, 'bad_request');
    if (url.pathname !== '/api/ws') return reject(socket, 404, 'not_found');
    const device = authorize(req);
    if (typeof device === 'number') return reject(socket, device, device === 401 ? 'unauthorized' : 'rate_limited', denyHeaders(device));
    socket.off('error', onError); // ws installs its own.
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, device.id));
  });

  const [apiPort, hookPort] = await Promise.all([
    listen(publicServer, options.apiPort, host),
    listen(localServer, options.hookPort, host),
  ]).catch((err: unknown) => {
    publicServer.close();
    localServer.close();
    throw err;
  });

  return {
    apiPort,
    hookPort,
    close: async () => {
      wss.close();
      publicServer.closeAllConnections();
      localServer.closeAllConnections();
      await Promise.all([closeServer(publicServer), closeServer(localServer)]);
    },
  };
}

function reject(socket: Duplex, status: number, error: ErrorCode, headers: Headers = {}): void {
  const data = JSON.stringify({ error } satisfies ApiError);
  const lines = Object.entries({ ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), connection: 'close' }).map(
    ([k, v]) => `${k}: ${v}`,
  );
  // Like ws's abortHandshake: a peer that never closes would otherwise keep the socket in FIN-WAIT-2 for good.
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\n${lines.join('\r\n')}\r\n\r\n${data}`);
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
