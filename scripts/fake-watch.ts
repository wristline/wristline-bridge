// Development WebSocket client that behaves like the watch app.
//
//   node scripts/fake-watch.ts --url http://127.0.0.1:47770 --code 123456
//   node scripts/fake-watch.ts --url http://127.0.0.1:47770 --token <token>
//
// Prints one line per event (prefixed with the local time) and reads commands from stdin:
//   subscribe <sessionId> | unsubscribe | prompt <sessionId> <text> | quit
//   answer <requestId> <optionIds> [<optionIds> ...]   one argument per question, ids joined by ","
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';
import type { ClientEvent, PairResponse, PendingRequest, ServerEvent } from '../src/protocol.ts';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:47770' },
    code: { type: 'string' },
    token: { type: 'string' },
    name: { type: 'string', default: 'fake-watch' },
  },
});
const base = (values.url ?? '').replace(/\/$/, '');

function log(text: string): void {
  console.log(`${new Date().toISOString()} ${text}`);
}

async function api(method: string, path: string, token: string | undefined, body?: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, data: text ? (JSON.parse(text) as unknown) : undefined };
}

async function main(): Promise<void> {
  let token = values.token;
  if (!token) {
    if (!values.code) throw new Error('pass --code <6 digits> or --token <token>');
    const { status, data } = await api('POST', '/api/pair', undefined, { code: values.code, deviceName: values.name });
    if (status !== 200) throw new Error(`pairing failed: ${status} ${JSON.stringify(data)}`);
    token = (data as PairResponse).token;
    log(`paired as ${(data as PairResponse).deviceId}; token ${token}`);
  }

  const requests = new Map<string, PendingRequest>();
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/ws`, { headers: { authorization: `Bearer ${token}` } });
  ws.on('unexpected-response', (_req, res) => {
    log(`connection refused: ${res.statusCode}`);
    process.exit(1);
  });
  ws.on('close', (code) => {
    log(`closed (${code})`);
    process.exit(0);
  });
  ws.on('message', (data) => {
    const event = JSON.parse(data.toString()) as ServerEvent;
    switch (event.type) {
      case 'snapshot':
        for (const r of event.requests) requests.set(r.id, r);
        log(`snapshot apiVersion=${event.apiVersion} sessions=${event.sessions.length} requests=${event.requests.length} usage=${event.usage.length}`);
        for (const s of event.sessions) log(`  ${s.status.padEnd(11)} ${s.id} ${s.title}`);
        break;
      case 'item':
        log(`item ${event.sessionId} #${event.item.seq} ${event.item.kind}${event.item.pending ? ' (pending)' : ''}: ${event.item.text.slice(0, 120).replace(/\s+/g, ' ')}`);
        break;
      case 'request':
        requests.set(event.request.id, event.request);
        log(`request ${event.request.id} ${event.request.kind} "${event.request.title}" in ${event.request.sessionId}`);
        for (const q of event.request.questions) {
          log(`  ${q.id}${q.multi ? ' (multi)' : ''}: ${q.text.slice(0, 200).replace(/\s+/g, ' ')}  [${q.options.map((o) => `${o.id}=${o.label}`).join(' | ')}]`);
        }
        break;
      default:
        log(JSON.stringify(event));
    }
  });
  const send = (event: ClientEvent): void => ws.send(JSON.stringify(event));
  await new Promise((resolve) => ws.once('open', resolve));
  log('connected');
  // Read stdin only once connected so early commands are not lost.
  createInterface({ input: process.stdin }).on('line', (line) => {
    const [command, arg, ...rest] = line.trim().split(/\s+/);
    void (async () => {
      if (command === 'subscribe' && arg) send({ type: 'subscribe', sessionId: arg });
      else if (command === 'unsubscribe') send({ type: 'subscribe', sessionId: null });
      else if (command === 'answer' && arg && rest[0]) {
        const questions = requests.get(arg)?.questions ?? [{ id: 'decision' }];
        const answers = Object.fromEntries(questions.map((q, i) => [q.id, (rest[i] ?? '').split(',').filter(Boolean)]));
        const { status, data } = await api('POST', `/api/requests/${arg}`, token, { answers });
        log(`answer -> ${status} ${JSON.stringify(data)}`);
      } else if (command === 'prompt' && arg && rest.length > 0) {
        const { status, data } = await api('POST', `/api/sessions/${encodeURIComponent(arg)}/prompt`, token, { text: rest.join(' ') });
        log(`prompt -> ${status} ${JSON.stringify(data)}`);
      } else if (command === 'quit') ws.close();
      else if (command) log('commands: subscribe <sid> | unsubscribe | answer <rid> <ids,..> [<ids,..> ...] | prompt <sid> <text> | quit');
    })();
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
