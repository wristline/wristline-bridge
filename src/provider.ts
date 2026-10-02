import type { AlertKind, Item, ItemKind, ItemPage, LimitReset, PromptBlock, ProviderHealth, ProviderId, Session, Usage } from './protocol.ts';
import type { PendingRegistry } from './pending.ts';
import { clip, oneLine } from './util.ts';

/**
 * A `done` alert carries up to DONE_TEXT_MAX of the answer and a title of up to DONE_TITLE_MAX;
 * answers shorter than DONE_MIN characters (DONE_MIN_CJK when they contain Hangul, Han or Kana,
 * which say as much in fewer characters), or "No response requested.", raise none.
 */
const DONE_TEXT_MAX = 500;
const DONE_TITLE_MAX = 60;
const DONE_MIN = 20;
const DONE_MIN_CJK = 8;
const CJK = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const NO_RESPONSE = /^no response requested\.?$/i;

/** What providers call to publish changes; implemented by the WebSocket hub. */
export interface Hub {
  session(session: Session): void;
  removed(sessionId: string): void;
  /** False when the report was set aside because a live source holds its entry (see `liveUsage`): offer it again later. */
  usage(usage: Usage): boolean;
  /**
   * The live numbers of the provider's own source (a connected Codex daemon) for one account: they
   * replace that entry rather than merge into it, and `usage` reports of it are set aside while the
   * provider holds it. The hold ends with live numbers of another account, or `undefined` (the
   * source is gone or has no numbers to go by).
   */
  liveUsage(provider: SessionProvider, usage: Usage | undefined): void;
  /** The account the provider's home is logged into now (undefined: logged out or not known), after each read of its login (the first one also when it fails): usage is sent for current logins only. */
  login(provider: SessionProvider, accountId: string | undefined): void;
  alert(sessionId: string, alert: AlertKind, text?: string, title?: string, reset?: LimitReset): void;
  readonly pending: PendingRegistry;
}

export interface SessionProvider {
  readonly id: ProviderId;
  start(hub: Hub): Promise<void>;
  stop(): void;
  health(): ProviderHealth;
  listSessions(): Session[];
  /** Resolves undefined for an unknown session. With `kinds`, pages count only items of those kinds. */
  readItems(nativeId: string, before: number | undefined, limit: number, kinds?: ReadonlySet<ItemKind>): Promise<ItemPage | undefined>;
  /** Streams new and updated items of one session; returns the unsubscribe function. */
  watch(nativeId: string, onItem: (item: Item) => void): () => void;
  /** Rejects with PromptBlocked when the session cannot take a prompt right now. */
  sendPrompt(nativeId: string, text: string): Promise<void>;
  /** Whether a finished turn of the session reaches the bridge and so raises its `done` alert (Codex: only a thread it rejoined in the daemon). */
  covers?(nativeId: string): boolean;
}

export class PromptBlocked extends Error {
  readonly code: PromptBlock;

  constructor(code: PromptBlock) {
    super(`prompt blocked: ${code}`);
    this.name = 'PromptBlocked';
    this.code = code;
  }
}

export function sessionKey(provider: ProviderId, nativeId: string): string {
  return `${provider}:${nativeId}`;
}

/** The text of a turn's `done` alert, by the same rule as a typical notifier Stop hook: undefined (no alert) for an empty, short or "No response requested." answer. */
export function doneText(answer: string | undefined): string | undefined {
  const text = (answer ?? '').trim();
  const min = CJK.test(text) ? DONE_MIN_CJK : DONE_MIN;
  return [...text].length < min || NO_RESPONSE.test(text) ? undefined : clip(text, DONE_TEXT_MAX);
}

/** A usage limit the agent hit, from its transcript: the record's time, the agent's message and what is known about when it ends. */
export interface LimitHit extends LimitReset {
  at: string;
  text: string;
}

/** A repeat of a session's last limit (same reset time, else same text) raises no alert within this time of its alert. */
const LIMIT_REPEAT_MS = 3600_000;

/**
 * Raises `alert limit` once per limit hit of a session: only for a record written since `since`
 * (the provider's start: older hits are history), and not for a repeat of the session's last limit
 * within LIMIT_REPEAT_MS of its alert (e.g. a prompt retried against it).
 */
export class LimitAlerts {
  readonly #since: number;
  readonly #last = new Map<string, { at: string; key: string; alertedAt: number }>();

  constructor(since: number) {
    this.#since = since;
  }

  check(hub: Hub | undefined, session: Session, hit: LimitHit | undefined): void {
    const at = hit ? Date.parse(hit.at) : NaN;
    if (!hit || !(at >= this.#since)) return;
    const last = this.#last.get(session.id);
    if (last?.at === hit.at) return;
    const key = hit.resetsAt ?? hit.text;
    if (last?.key === key && at - last.alertedAt < LIMIT_REPEAT_MS) {
      last.at = hit.at;
      return;
    }
    this.#last.set(session.id, { at: hit.at, key, alertedAt: at });
    const { at: _at, text, ...reset } = hit;
    hub?.alert(session.id, 'limit', clip(text, DONE_TEXT_MAX), session.title || undefined, reset);
  }
}

/** The title of a turn's `done` alert: the prompt that started it when the user typed one, else the session title; undefined when neither has text. */
export function doneTitle(prompt: string | undefined, sessionTitle: string | undefined): string | undefined {
  const typed = oneLine(prompt ?? '');
  return (typed ? clip(typed, DONE_TITLE_MAX) : sessionTitle) || undefined;
}
