import type { AlertKind, Item, ItemKind, ItemPage, PromptBlock, ProviderHealth, ProviderId, Session, Usage } from './protocol.ts';
import type { PendingRegistry } from './pending.ts';
import { clip, oneLine } from './util.ts';

/** A `done` alert carries up to DONE_TEXT_MAX of the answer and a title of up to DONE_TITLE_MAX; answers shorter than DONE_MIN (or "No response requested.") raise none. */
const DONE_TEXT_MAX = 500;
const DONE_TITLE_MAX = 60;
const DONE_MIN = 20;
const NO_RESPONSE = /^no response requested\.?$/i;

/** What providers call to publish changes; implemented by the WebSocket hub. */
export interface Hub {
  session(session: Session): void;
  removed(sessionId: string): void;
  usage(usage: Usage): void;
  /**
   * The live numbers of the provider's own source (a connected Codex daemon) for one account: they
   * replace that entry rather than merge into it, and `usage` reports of it are ignored while the
   * provider holds it. The hold ends with live numbers of another account, or `undefined` (the
   * source is gone or its login is being re-read).
   */
  liveUsage(provider: SessionProvider, usage: Usage | undefined): void;
  /** The account the provider's home is logged into now (undefined: logged out or not known), after each read of its login (the first one also when it fails): usage is sent for current logins only. */
  login(provider: SessionProvider, accountId: string | undefined): void;
  alert(sessionId: string, alert: AlertKind, text?: string, title?: string): void;
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

/** The text of a turn's `done` alert, by the rule of the user's Slack Stop hook: undefined (no alert) for an empty, short or "No response requested." answer. */
export function doneText(answer: string | undefined): string | undefined {
  const text = (answer ?? '').trim();
  return [...text].length < DONE_MIN || NO_RESPONSE.test(text) ? undefined : clip(text, DONE_TEXT_MAX);
}

/** The title of a turn's `done` alert: the prompt that started it when the user typed one, else the session title; undefined when neither has text. */
export function doneTitle(prompt: string | undefined, sessionTitle: string | undefined): string | undefined {
  const typed = oneLine(prompt ?? '');
  return (typed ? clip(typed, DONE_TITLE_MAX) : sessionTitle) || undefined;
}
