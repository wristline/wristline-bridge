import type { AlertKind, Item, ItemPage, PromptBlock, ProviderHealth, ProviderId, Session, Usage } from './protocol.ts';
import type { PendingRegistry } from './pending.ts';

/** What providers call to publish changes; implemented by the WebSocket hub. */
export interface Hub {
  session(session: Session): void;
  removed(sessionId: string): void;
  usage(usage: Usage): void;
  alert(sessionId: string, alert: AlertKind, text?: string): void;
  readonly pending: PendingRegistry;
}

export interface SessionProvider {
  readonly id: ProviderId;
  start(hub: Hub): Promise<void>;
  stop(): void;
  health(): ProviderHealth;
  listSessions(): Session[];
  /** Resolves undefined for an unknown session. */
  readItems(nativeId: string, before: number | undefined, limit: number): Promise<ItemPage | undefined>;
  /** Streams new and updated items of one session; returns the unsubscribe function. */
  watch(nativeId: string, onItem: (item: Item) => void): () => void;
  /** Rejects with PromptBlocked when the session cannot take a prompt right now. */
  sendPrompt(nativeId: string, text: string): Promise<void>;
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
