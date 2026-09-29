// Stands in for `codex app-server proxy` in tests: a WebSocket server on stdio that answers like
// the Codex app-server daemon. argv: <state JSON> <log file>. Every message it receives is
// appended to the log file. Test-only methods: fake/notify {method, params} sends a notification,
// fake/request {method, params} sends a server request and returns its id, fake/state {...} changes
// the state (e.g. the login) for later requests, fake/exit quits.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';

interface State {
  loaded: string[];
  threads: Record<string, Record<string, unknown>>;
  rateLimits: unknown;
  /** `account/read`'s account and `account/rateLimits/read`'s accountId. */
  account: unknown;
  accountId: string | null;
  /** Delays the two account reads, for what arrives while a login is being re-read. */
  accountDelayMs: number;
}

const state: State = { loaded: [], threads: {}, rateLimits: null, account: null, accountId: null, accountDelayMs: 0, ...(JSON.parse(process.argv[2] ?? '{}') as Partial<State>) };
const logFile = process.argv[3];
let nextServerId = 0;

const server = createServer();
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const text = data.toString();
    if (logFile) appendFileSync(logFile, `${text}\n`);
    const msg = JSON.parse(text) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (msg.method === undefined || msg.id === undefined) return; // an answer, or `initialized`
    const reply = (result: unknown): void => ws.send(JSON.stringify({ id: msg.id, result }));
    const fail = (code: number, message: string): void => ws.send(JSON.stringify({ id: msg.id, error: { code, message } }));
    const p = msg.params ?? {};
    const threadId = String(p.threadId);
    switch (msg.method) {
      case 'initialize':
        return reply({ userAgent: 'fake', codexHome: '/fake', platformFamily: 'unix', platformOs: 'linux' });
      case 'thread/loaded/list':
        return reply({ data: state.loaded, nextCursor: null });
      case 'thread/read': {
        const thread = state.threads[threadId];
        return thread ? reply({ thread: { id: threadId, ephemeral: false, parentThreadId: null, ...thread } }) : fail(-32600, 'no rollout found');
      }
      case 'thread/resume':
        return reply({ thread: { id: threadId } });
      case 'turn/start':
        return reply({ turn: { id: 'turn-new', items: [], status: 'inProgress' } });
      case 'account/read':
        return void setTimeout(() => reply({ account: state.account }), state.accountDelayMs);
      case 'account/rateLimits/read':
        return void setTimeout(() => reply({ rateLimits: state.rateLimits, accountId: state.accountId }), state.accountDelayMs);
      case 'fake/state':
        Object.assign(state, p);
        return reply({});
      case 'fake/notify':
        ws.send(JSON.stringify({ method: p.method, params: p.params, emittedAtMs: Date.now() }));
        return reply({});
      case 'fake/request': {
        const id = nextServerId++;
        ws.send(JSON.stringify({ method: p.method, id, params: p.params }));
        return reply({ id });
      }
      case 'fake/exit':
        process.exit(0);
      default:
        return fail(-32601, `unknown method ${msg.method}`);
    }
  });
});

// The HTTP server accepts any duplex stream as a connection; this one is our stdio.
const conn = new Duplex({
  read() {},
  write(chunk: Buffer, _encoding, callback) {
    process.stdout.write(chunk, callback);
  },
});
process.stdin.on('data', (chunk: Buffer) => conn.push(chunk));
process.stdin.on('end', () => process.exit(0));
server.emit('connection', Object.assign(conn, { setTimeout() {}, setNoDelay() {}, setKeepAlive() {}, ref() {}, unref() {} }));
