// Quick Ask: one headless, tool-less run of `claude -p` or `codex exec` per question, in an empty
// scratch directory, without a session left behind. Verified against Claude Code 2.1.285 and
// codex-cli 0.159.2 (the JSON shapes parsed here are the ones those printed; see docs/protocol.md).
// Prompt and answer text are never logged.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AskConfig, Bins } from './config.ts';
import { TEXT_MAX, type Ask, type AskBody, type ProviderId, type ServerEvent } from './protocol.ts';
import { claudeModelName } from './providers/claude-code/parse.ts';
import { clip, isObject, num, oneLine, parseJson, str } from './util.ts';

export const ASK_TIMEOUT_MS = 90_000;
/** Asks kept per device, newest first. */
export const ASK_KEEP = 20;
const KILL_GRACE_MS = 5000;
const ERROR_MAX = 200;
export const ASK_SYSTEM_PROMPT =
  "You are answering a quick question from a smartwatch: answer directly in the user's language, in at most ~80 words, no markdown headings or code fences unless essential.";

export type AskSpawn = (bin: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

export interface AskRunnerOptions {
  /** The bridge's config directory; the scratch cwd is `<dir>/ask-cwd`. */
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
  /** The `--session-id` given to Claude Code, so its hooks for this run can be told apart. */
  sessionId?: string;
  run?: Running;
}

interface Outcome {
  answer?: string;
  model?: string;
  durationMs?: number;
  error?: string;
}

export class AskRunner {
  readonly #cwd: string;
  readonly #o: AskRunnerOptions;
  readonly #spawn: AskSpawn;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  /** Per device, newest first. */
  readonly #byDevice = new Map<string, Entry[]>();

  constructor(options: AskRunnerOptions) {
    this.#o = options;
    this.#spawn = options.spawn ?? ((bin, args, o) => nodeSpawn(bin, args, { ...o, stdio: ['ignore', 'pipe', 'pipe'] }));
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? ASK_TIMEOUT_MS;
    this.#cwd = join(options.dir, 'ask-cwd');
    mkdirSync(this.#cwd, { recursive: true, mode: 0o700 });
  }

  /** For a watch that names no provider. */
  get defaultProvider(): ProviderId {
    return this.#o.ask.provider;
  }

  /** Starts the CLI for this device; at most one ask runs per device. */
  start(deviceId: string, body: AskBody): Ask | 'busy' | 'unavailable' {
    const bin = body.provider === 'claude-code' ? this.#o.bins.claude : this.#o.bins.codex;
    if (!bin) return 'unavailable';
    const entries = this.#byDevice.get(deviceId) ?? [];
    if (entries.some((e) => e.run)) return 'busy';
    const ask: Ask = { id: `ask-${randomUUID()}`, provider: body.provider, question: body.text, status: 'running', createdAt: new Date(this.#now()).toISOString() };
    const entry: Entry = { deviceId, ask };
    const { args, env } = body.provider === 'claude-code' ? this.#claudeArgs(body, entry) : this.#codexArgs(body);
    entries.unshift(entry);
    this.#byDevice.set(deviceId, entries.slice(0, ASK_KEEP));
    this.#launch(entry, bin, args, env, body);
    this.#emit(entry);
    return ask;
  }

  list(deviceId: string): Ask[] {
    return (this.#byDevice.get(deviceId) ?? []).map((e) => e.ask);
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

  /** Whether a Claude Code session id is one of this runner's asks (recent or running): its hooks are not a session's. */
  ownsClaudeSession(nativeId: string): boolean {
    for (const entries of this.#byDevice.values()) if (entries.some((e) => e.sessionId === nativeId)) return true;
    return false;
  }

  close(): void {
    for (const entries of this.#byDevice.values()) {
      for (const e of entries) {
        if (!e.run) continue;
        clearTimeout(e.run.timer);
        clearTimeout(e.run.killTimer);
        e.run.child.kill('SIGKILL');
      }
    }
  }

  #env(): NodeJS.ProcessEnv {
    // A bridge started inside a Claude Code session would otherwise be taken for a nested one.
    const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...env } = process.env;
    return env;
  }

  #claudeArgs(body: AskBody, entry: Entry): { args: string[]; env: NodeJS.ProcessEnv } {
    entry.sessionId = randomUUID();
    const args = [
      '-p',
      ...['--output-format', 'json'],
      ...['--model', body.model || this.#o.ask.claudeModel],
      ...['--max-turns', '1'],
      '--no-session-persistence',
      ...['--tools', ''],
      ...['--permission-prompts', 'none'],
      '--strict-mcp-config',
      ...['--session-id', entry.sessionId],
      ...['--append-system-prompt', ASK_SYSTEM_PROMPT],
      '--safe-mode',
      '--',
      body.text,
    ];
    return { args, env: { ...this.#env(), CLAUDE_CONFIG_DIR: this.#o.claudeHome } };
  }

  #codexArgs(body: AskBody): { args: string[]; env: NodeJS.ProcessEnv } {
    const model = body.model || this.#o.ask.codexModel;
    const args = ['exec', '--json', ...['-s', 'read-only'], '--skip-git-repo-check', '--ephemeral', ...['-C', this.#cwd], ...(model ? ['-m', model] : []), '--', `${ASK_SYSTEM_PROMPT}\n\n${body.text}`];
    return { args, env: { ...this.#env(), CODEX_HOME: this.#o.codexHome } };
  }

  #launch(entry: Entry, bin: string, args: string[], env: NodeJS.ProcessEnv, body: AskBody): void {
    const child = this.#spawn(bin, args, { cwd: this.#cwd, env });
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
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => run.stdout.push(chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => run.stderr.push(chunk));
    let finished = false;
    const finish = (outcome: Outcome): void => {
      if (finished) return;
      finished = true;
      clearTimeout(run.timer);
      clearTimeout(run.killTimer);
      entry.run = undefined;
      const durationMs = outcome.durationMs ?? this.#now() - run.startedAt;
      const { id, provider, question, createdAt } = entry.ask;
      entry.ask =
        outcome.answer === undefined
          ? { id, provider, question, status: 'error', durationMs, error: outcome.error ?? 'bad_output', createdAt }
          : { id, provider, question, status: 'done', answer: outcome.answer, ...(outcome.model ? { model: outcome.model } : {}), durationMs, createdAt };
      this.#emit(entry);
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
