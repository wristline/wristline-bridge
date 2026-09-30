// Quick Ask: one headless, tool-less run of `claude -p` or `codex exec` per question, in an empty
// scratch directory. Asks form threads: the first ask of a thread starts a CLI session (Claude
// Code: `--session-id`; Codex: a persisted `codex exec`), follow-ups resume it (`--resume`,
// `codex exec resume`), and the session files are deleted when the thread expires (24 h after its
// last ask) or the watch deletes it. Threads are persisted in `<dir>/ask-threads.json` so a bridge
// restart still excludes and expires them; asks themselves live in memory only. Verified against
// Claude Code 2.1.285 and codex-cli 0.159.2 (the JSON shapes parsed here are the ones those
// printed; see docs/protocol.md). Prompt and answer text are never logged.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AskConfig, Bins } from './config.ts';
import { TEXT_MAX, type Ask, type AskBody, type ProviderId, type ServerEvent } from './protocol.ts';
import { isDefaultClaudeHome } from './providers/claude-code/account.ts';
import { projectSlug } from './providers/claude-code/home.ts';
import { claudeModelName } from './providers/claude-code/parse.ts';
import { scanRollouts } from './providers/codex/home.ts';
import { clip, isNotFound, isObject, num, oneLine, parseJson, str } from './util.ts';

export const ASK_TIMEOUT_MS = 90_000;
/** Asks kept per device, newest first. */
export const ASK_KEEP = 10;
/** Asks older than this are dropped when one is added or listed; a thread expires this long after its last ask. */
export const ASK_MAX_AGE_MS = 24 * 60 * 60_000;
const SWEEP_MS = 60_000;
const KILL_GRACE_MS = 5000;
const DELETE_TIMEOUT_MS = 30_000;
const ERROR_MAX = 200;
const THREADS_FILE = 'ask-threads.json';
export const ASK_SYSTEM_PROMPT =
  "You are answering a quick question from a smartwatch: answer directly in the user's language, in at most ~80 words, no markdown headings or code fences unless essential.";

export type AskSpawn = (bin: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

export interface AskRunnerOptions {
  /** The bridge's config directory; the scratch cwd is `<dir>/ask-cwd`, the thread registry `<dir>/ask-threads.json`. */
  dir: string;
  bins: Pick<Bins, 'claude' | 'codex'>;
  claudeHome: string;
  codexHome: string;
  ask: AskConfig;
  onEvent: (deviceId: string, event: ServerEvent) => void;
  /** Test injection. */
  spawn?: AskSpawn;
  now?: () => number;
  timeoutMs?: number;
}

interface Running {
  child: ChildProcess;
  timer: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  startedAt: number;
  stdout: string[];
  stderr: string[];
  cancelled: boolean;
  timedOut: boolean;
}

interface Entry {
  deviceId: string;
  ask: Ask;
  run?: Running;
  /** The thread was deleted while this ask ran: its files go once the CLI has exited. */
  purge?: Thread;
}

/** A conversation the CLI can continue; `id` is the first ask's id. */
interface Thread {
  id: string;
  provider: ProviderId;
  deviceId: string;
  /** ISO 8601; the thread expires ASK_MAX_AGE_MS after it. */
  lastAskAt: string;
  /** Claude Code: the `--session-id` (the uuid of `id`; a fresh one after a failed first ask); Codex: `thread.started.thread_id`, once seen. */
  sessionId?: string;
  /** The CLI has a conversation to resume (Claude Code: an ask answered; Codex: the thread id is known). */
  started: boolean;
}

interface Outcome {
  answer?: string;
  model?: string;
  durationMs?: number;
  error?: string;
}

export type StartResult = Ask | 'busy' | 'unavailable' | 'not_found' | 'bad_request';

export class AskRunner {
  readonly #cwd: string;
  readonly #o: AskRunnerOptions;
  readonly #spawn: AskSpawn;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  /** Per device, newest first. */
  readonly #byDevice = new Map<string, Entry[]>();
  readonly #threads = new Map<string, Thread>();
  /** Forgotten threads whose files are not deleted yet: still owned, so a refresh meanwhile does not list their sessions. */
  readonly #purging = new Set<Thread>();
  readonly #threadsPath: string;
  readonly #sweeper: NodeJS.Timeout;

  constructor(options: AskRunnerOptions) {
    this.#o = options;
    this.#spawn = options.spawn ?? ((bin, args, o) => nodeSpawn(bin, args, { ...o, stdio: ['ignore', 'pipe', 'pipe'] }));
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? ASK_TIMEOUT_MS;
    const cwd = join(options.dir, 'ask-cwd');
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    // Resolved once: Claude Code files transcripts under the real path, Codex records `-C` as given; the purge and the providers' filters must match both.
    this.#cwd = realpathSync(cwd);
    this.#threadsPath = join(options.dir, THREADS_FILE);
    for (const t of readThreads(this.#threadsPath)) this.#threads.set(t.id, t);
    this.sweep();
    this.#sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.#sweeper.unref();
  }

  /** For a watch that names no provider. */
  get defaultProvider(): ProviderId {
    return this.#o.ask.provider;
  }

  /** The scratch directory the CLIs run in, resolved as they record it: the providers skip sessions made there. */
  get cwd(): string {
    return this.#cwd;
  }

  /** Starts the CLI for this device; at most one ask runs per device. With `threadId`, continues that thread of this device. */
  start(deviceId: string, body: AskBody): StartResult {
    const bin = body.provider === 'claude-code' ? this.#o.bins.claude : this.#o.bins.codex;
    if (!bin) return 'unavailable';
    this.sweep();
    let thread = body.threadId === undefined ? undefined : this.#threads.get(body.threadId);
    if (body.threadId !== undefined && (!thread || thread.deviceId !== deviceId)) return 'not_found';
    if (thread && thread.provider !== body.provider) return 'bad_request';
    const entries = this.#recent(deviceId);
    if (entries.some((e) => e.run)) return 'busy';
    const id = `ask-${randomUUID()}`;
    const createdAt = new Date(this.#now()).toISOString();
    if (!thread) {
      thread = { id, provider: body.provider, deviceId, lastAskAt: createdAt, started: false };
      if (body.provider === 'claude-code') thread.sessionId = id.slice('ask-'.length);
      this.#threads.set(id, thread);
    } else thread.lastAskAt = createdAt;
    this.#saveThreads();
    const ask: Ask = { id, provider: body.provider, threadId: thread.id, question: body.text, status: 'running', createdAt };
    const entry: Entry = { deviceId, ask };
    const { args, env } = body.provider === 'claude-code' ? this.#claudeArgs(body, thread) : this.#codexArgs(body, thread);
    entries.unshift(entry);
    this.#byDevice.set(deviceId, entries.slice(0, ASK_KEEP));
    this.#launch(entry, thread, bin, args, env, body);
    this.#emit(entry);
    return ask;
  }

  list(deviceId: string): Ask[] {
    this.sweep();
    return this.#recent(deviceId)
      .filter((e) => !e.purge)
      .map((e) => e.ask);
  }

  /** True when the ask belongs to the device; a running one is killed and ends `cancelled`. */
  cancel(deviceId: string, askId: string): boolean {
    const entry = this.#byDevice.get(deviceId)?.find((e) => e.ask.id === askId);
    if (!entry) return false;
    if (entry.run) {
      entry.run.cancelled = true;
      this.#kill(entry.run);
    }
    return true;
  }

  /** True when the thread belongs to the device: it is forgotten and its CLI session files deleted (after a running ask was killed). */
  deleteThread(deviceId: string, threadId: string): boolean {
    const thread = this.#threads.get(threadId);
    if (!thread || thread.deviceId !== deviceId) return false;
    this.#forget(thread);
    return true;
  }

  /** Whether a Claude Code session id is one of this runner's threads: its hooks are not a session's and it is not listed. */
  ownsClaudeSession(nativeId: string): boolean {
    return this.#owns('claude-code', nativeId);
  }

  /** The same for a Codex thread id. */
  ownsCodexThread(nativeId: string): boolean {
    return this.#owns('codex', nativeId);
  }

  /** Forgets and purges threads whose last ask is older than ASK_MAX_AGE_MS. Runs every minute and before each start or list. */
  sweep(): void {
    const since = this.#now() - ASK_MAX_AGE_MS;
    for (const thread of this.#threads.values()) if (Date.parse(thread.lastAskAt) < since) this.#forget(thread);
  }

  close(): void {
    clearInterval(this.#sweeper);
    for (const entries of this.#byDevice.values()) {
      for (const e of entries) {
        if (!e.run) continue;
        clearTimeout(e.run.timer);
        clearTimeout(e.run.killTimer);
        e.run.child.kill('SIGKILL');
      }
    }
  }

  #owns(provider: ProviderId, nativeId: string): boolean {
    for (const t of [...this.#threads.values(), ...this.#purging]) if (t.provider === provider && t.sessionId === nativeId) return true;
    return false;
  }

  #forget(thread: Thread): void {
    this.#purging.add(thread);
    this.#threads.delete(thread.id);
    this.#saveThreads();
    // Its asks go with it; a running one stays, unlisted, until its CLI has exited (one ask per device).
    const entries = this.#byDevice.get(thread.deviceId);
    if (entries) this.#byDevice.set(thread.deviceId, entries.filter((e) => e.run || e.ask.threadId !== thread.id));
    const running = entries?.find((e) => e.run && e.ask.threadId === thread.id);
    if (running?.run) {
      // The CLI still writes its session; delete it once it has exited.
      running.purge = thread;
      running.run.cancelled = true;
      this.#kill(running.run);
      return;
    }
    this.#purge(thread);
  }

  #purge(thread: Thread): void {
    this.#purging.add(thread);
    purgeThread(thread, this.#o, this.#cwd, this.#spawn, this.#env())
      .catch((err: unknown) => {
        console.error(`wristline: ask thread ${thread.id} (${thread.provider}): could not delete its session: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => this.#purging.delete(thread));
  }

  /** Via a temporary file and a rename: a crash mid-write must not leave a half file that parses to no threads. */
  #saveThreads(): void {
    try {
      const tmp = `${this.#threadsPath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ threads: [...this.#threads.values()] }, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.#threadsPath);
    } catch (err) {
      console.error(`wristline: could not save ${this.#threadsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The device's asks with those older than ASK_MAX_AGE_MS dropped. */
  #recent(deviceId: string): Entry[] {
    const since = this.#now() - ASK_MAX_AGE_MS;
    const entries = (this.#byDevice.get(deviceId) ?? []).filter((e) => Date.parse(e.ask.createdAt) >= since);
    this.#byDevice.set(deviceId, entries);
    return entries;
  }

  #env(): NodeJS.ProcessEnv {
    // A bridge started inside a Claude Code session would otherwise be taken for a nested one.
    const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...env } = process.env;
    return env;
  }

  #claudeArgs(body: AskBody, thread: Thread): { args: string[]; env: NodeJS.ProcessEnv } {
    const sessionId = thread.sessionId ?? '';
    const args = [
      '-p',
      ...['--output-format', 'json'],
      ...['--model', body.model || this.#o.ask.claudeModel],
      ...['--max-turns', '1'],
      ...['--tools', ''],
      ...['--permission-prompts', 'none'],
      '--strict-mcp-config',
      ...(thread.started ? ['--resume', sessionId] : ['--session-id', sessionId]),
      ...['--append-system-prompt', ASK_SYSTEM_PROMPT],
      '--safe-mode',
      '--',
      body.text,
    ];
    // The default home is Claude Code's without the variable; set, the CLI would keep a `.claude.json` of its own in `~/.claude`.
    const { CLAUDE_CONFIG_DIR: _d, ...env } = this.#env();
    return { args, env: isDefaultClaudeHome(this.#o.claudeHome) ? env : { ...env, CLAUDE_CONFIG_DIR: this.#o.claudeHome } };
  }

  /** `codex exec resume` takes no `-s`/`-C`: the sandbox goes in as a config override and the cwd is the process's. */
  #codexArgs(body: AskBody, thread: Thread): { args: string[]; env: NodeJS.ProcessEnv } {
    const model = body.model || this.#o.ask.codexModel;
    const prompt = `${ASK_SYSTEM_PROMPT}\n\n${body.text}`;
    const args =
      thread.started && thread.sessionId
        ? ['exec', 'resume', thread.sessionId, '--json', ...['-c', 'sandbox_mode="read-only"'], '--skip-git-repo-check', ...(model ? ['-m', model] : []), '--', prompt]
        : ['exec', '--json', ...['-s', 'read-only'], '--skip-git-repo-check', ...['-C', this.#cwd], ...(model ? ['-m', model] : []), '--', prompt];
    return { args, env: { ...this.#env(), CODEX_HOME: this.#o.codexHome } };
  }

  #launch(entry: Entry, thread: Thread, bin: string, args: string[], env: NodeJS.ProcessEnv, body: AskBody): void {
    let child: ChildProcess;
    try {
      child = this.#spawn(bin, args, { cwd: this.#cwd, env });
    } catch (err) {
      // spawn throws on an argument it refuses (a NUL byte) and quotes it, i.e. the question: only the code is logged.
      const code = (isObject(err) && str(err.code)) || 'spawn_failed';
      console.error(`wristline: ask ${entry.ask.id} (${body.provider}) could not start: ${code}`);
      // After start() has reported it running, like a CLI that is not installed.
      process.nextTick(() => this.#end(entry, thread, { error: clip(code.toLowerCase(), ERROR_MAX) }, 0));
      return;
    }
    const run: Running = {
      child,
      timer: setTimeout(() => {
        run.timedOut = true;
        this.#kill(run);
      }, this.#timeoutMs),
      startedAt: this.#now(),
      stdout: [],
      stderr: [],
      cancelled: false,
      timedOut: false,
    };
    entry.run = run;
    let partial = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      run.stdout.push(chunk);
      // The Codex thread id is needed as soon as it is printed: the provider must skip the rollout from its next scan.
      if (body.provider !== 'codex' || thread.sessionId) return;
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      const id = lines.map(codexThreadId).find((x) => x !== undefined);
      if (!id) return;
      // Recorded even for a thread deleted meanwhile: its rollout is purged by that id once the CLI has exited.
      thread.sessionId = id;
      if (this.#threads.get(thread.id) === thread) {
        thread.started = true;
        this.#saveThreads();
      }
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => run.stderr.push(chunk));
    let finished = false;
    const finish = (outcome: Outcome): void => {
      if (finished) return;
      finished = true;
      clearTimeout(run.timer);
      clearTimeout(run.killTimer);
      entry.run = undefined;
      this.#end(entry, thread, outcome, this.#now() - run.startedAt);
    };
    child.once('error', (err: NodeJS.ErrnoException) => {
      console.error(`wristline: ask ${entry.ask.id} (${body.provider}) could not start: ${err.code ?? err.message}`);
      finish({ error: clip(oneLine(err.code ?? err.message).toLowerCase(), ERROR_MAX) });
    });
    child.once('close', (code, signal) => {
      if (run.cancelled) return finish({ error: 'cancelled' });
      if (run.timedOut) return finish({ error: 'timeout' });
      const exit = code === 0 ? undefined : `exit_${code ?? signal ?? 'unknown'}`;
      const outcome = body.provider === 'claude-code' ? parseClaude(run.stdout.join('')) : parseCodex(run.stdout.join(''));
      if (outcome.answer !== undefined) {
        if (exit) console.warn(`wristline: ask ${entry.ask.id} (${body.provider}) answered but ended with ${exit}`);
        if (body.provider === 'codex') {
          const model = body.model || this.#o.ask.codexModel;
          finish(model ? { ...outcome, model } : outcome);
        } else finish(outcome);
        return;
      }
      const error = outcome.error ?? exit ?? 'bad_output';
      const last = oneLine(run.stderr.join('').trim().split('\n').at(-1) ?? '');
      console.error(`wristline: ask ${entry.ask.id} (${body.provider}) failed: ${error}${last ? ` (${clip(last, ERROR_MAX)})` : ''}`);
      finish({ error });
    });
  }

  /** Records how the ask ended, restarts or purges its thread's files as needed, and reports it. */
  #end(entry: Entry, thread: Thread, outcome: Outcome, elapsedMs: number): void {
    const durationMs = outcome.durationMs ?? elapsedMs;
    const { id, provider, threadId, question, createdAt } = entry.ask;
    entry.ask =
      outcome.answer === undefined
        ? { id, provider, threadId, question, status: 'error', durationMs, error: outcome.error ?? 'bad_output', createdAt }
        : { id, provider, threadId, question, status: 'done', answer: outcome.answer, ...(outcome.model ? { model: outcome.model } : {}), durationMs, createdAt };
    if (provider === 'claude-code' && !thread.started && this.#threads.get(threadId) === thread) {
      if (outcome.answer !== undefined) thread.started = true;
      else {
        // Claude Code refuses `--session-id` of a transcript that exists, and a failed run (timeout, cancel,
        // error) may have written one: the thread starts over under a fresh id and the old files go.
        this.#purge({ ...thread });
        thread.sessionId = randomUUID();
      }
      this.#saveThreads();
    }
    if (entry.purge) {
      this.#purge(entry.purge);
      const entries = this.#byDevice.get(entry.deviceId);
      if (entries) this.#byDevice.set(entry.deviceId, entries.filter((e) => e !== entry));
    }
    this.#emit(entry);
  }

  #kill(run: Running): void {
    run.child.kill('SIGTERM');
    run.killTimer ??= setTimeout(() => run.child.kill('SIGKILL'), KILL_GRACE_MS);
  }

  #emit(entry: Entry): void {
    const { id, provider, status, answer, model, durationMs, error } = entry.ask;
    this.#o.onEvent(entry.deviceId, {
      type: 'ask',
      askId: id,
      provider,
      status,
      ...(answer === undefined ? {} : { text: answer }),
      ...(model === undefined ? {} : { model }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(error === undefined ? {} : { error }),
    });
  }
}

function readThreads(path: string): Thread[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (!isNotFound(err)) console.error(`wristline: could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const raw = parseJson(text)?.threads;
  if (!Array.isArray(raw)) {
    console.error(`wristline: ${path} is not a thread registry; its threads are lost (their CLI sessions will never be deleted)`);
    return [];
  }
  const threads: Thread[] = [];
  for (const t of raw) {
    const id = isObject(t) ? str(t.id) : undefined;
    const deviceId = isObject(t) ? str(t.deviceId) : undefined;
    const lastAskAt = isObject(t) ? str(t.lastAskAt) : undefined;
    if (!isObject(t) || !id || !deviceId || !lastAskAt || (t.provider !== 'claude-code' && t.provider !== 'codex')) continue;
    // The session id names files to delete under the CLI's home: only a uuid is ever used as one.
    const sessionId = str(t.sessionId);
    if (sessionId !== undefined && !isUuid(sessionId)) continue;
    threads.push({ id, provider: t.provider, deviceId, lastAskAt, ...(sessionId ? { sessionId } : {}), started: t.started === true });
  }
  return threads;
}

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** The `thread.started` line of `codex exec --json`, if this is one. */
function codexThreadId(line: string): string | undefined {
  if (!line.includes('thread.started')) return undefined;
  const event = parseJson(line);
  const id = event?.type === 'thread.started' ? str(event.thread_id) : undefined;
  return id !== undefined && isUuid(id) ? id : undefined;
}

/**
 * Deletes the CLI's files for a thread. Claude Code: the transcript and its sub-agent directory
 * under the scratch cwd's project directory. Codex: `codex delete --force <id>` (removes the
 * rollout and the session_index line); without the CLI, or when it fails, the same by hand.
 */
async function purgeThread(thread: Thread, o: AskRunnerOptions, cwd: string, spawn: AskSpawn, env: NodeJS.ProcessEnv): Promise<void> {
  const id = thread.sessionId;
  if (!id) return;
  if (thread.provider === 'claude-code') {
    const project = join(o.claudeHome, 'projects', projectSlug(cwd));
    await rm(join(project, `${id}.jsonl`), { force: true });
    await rm(join(project, id), { recursive: true, force: true });
    return;
  }
  if (o.bins.codex && (await codexDelete(o.bins.codex, id, spawn, { ...env, CODEX_HOME: o.codexHome }, cwd))) return;
  const rollouts = await scanRollouts(join(o.codexHome, 'sessions'));
  const file = rollouts?.get(id);
  for (const f of file ? [file, ...file.previous] : []) await rm(f.path, { force: true });
  const index = join(o.codexHome, 'session_index.jsonl');
  let lines: string[];
  try {
    lines = (await readFile(index, 'utf8')).split('\n');
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  const kept = lines.filter((line) => parseJson(line)?.id !== id);
  if (kept.length !== lines.length) await writeFile(index, kept.join('\n'));
}

/** Resolves true when `codex delete --force <id>` exited 0. */
function codexDelete(bin: string, id: string, spawn: AskSpawn, env: NodeJS.ProcessEnv, cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['delete', '--force', id], { cwd, env });
    const timer = setTimeout(() => child.kill('SIGKILL'), DELETE_TIMEOUT_MS);
    child.stdout?.resume();
    child.stderr?.resume();
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/** `claude -p --output-format json` prints one result object. */
export function parseClaude(stdout: string): Outcome {
  const result = parseJson(stdout.trim());
  if (!result || result.type !== 'result') return { error: 'bad_output' };
  const text = str(result.result) ?? '';
  const durationMs = num(result.duration_ms);
  const out: Outcome = durationMs === undefined ? {} : { durationMs };
  if (result.subtype !== 'success') return { ...out, error: clip(str(result.subtype) || 'bad_output', ERROR_MAX) };
  if (result.is_error === true) return { ...out, error: clip(oneLine(text.split('\n')[0] ?? '') || 'bad_output', ERROR_MAX) };
  const modelId = isObject(result.modelUsage) ? Object.keys(result.modelUsage)[0] : undefined;
  return { ...out, answer: clip(text.trim(), TEXT_MAX), ...(modelId ? { model: claudeModelName(modelId) } : {}) };
}

/** `codex exec --json` prints JSONL events; the answer is the last `agent_message` item. */
export function parseCodex(stdout: string): Outcome {
  let answer: string | undefined;
  let error: string | undefined;
  for (const line of stdout.split('\n')) {
    const event = parseJson(line);
    if (!event) continue;
    if (event.type === 'item.completed' && isObject(event.item) && event.item.type === 'agent_message') {
      const text = str(event.item.text);
      if (text !== undefined) answer = text;
    } else if (event.type === 'turn.failed') {
      error = clip(oneLine((isObject(event.error) ? str(event.error.message) : undefined) || 'turn.failed'), ERROR_MAX);
    } else if (event.type === 'error') {
      error = clip(oneLine(str(event.message) || 'error'), ERROR_MAX);
    }
  }
  if (answer !== undefined) return { answer: clip(answer.trim(), TEXT_MAX) };
  return error === undefined ? {} : { error };
}
