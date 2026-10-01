// Wire format of the Wristline protocol, apiVersion 1.
// This file is the single source of truth: a change here must update docs/protocol.md and
// protocol/v1/*.json (`UPDATE_FIXTURES=1 npm test`) in the same commit.
//
// Usage identity: a Usage is identified by `provider` plus `account?.id ?? ''`; a `usage` event
// replaces the entry with the same key. No `account` means a single or unknown account.

export const API_VERSION = 1;
/** Upper bounds (UTF-16 code units) the bridge enforces before sending text to the watch. */
export const TEXT_MAX = 4000;
export const DETAIL_MAX = 600;

export type ProviderId = 'claude-code' | 'codex';
export type SessionStatus = 'running' | 'idle' | 'needs_input' | 'ended';
/** `unsafe_prefix` is only ever a prompt error (409), never a session's `promptBlock`. `busy` is also the 409 of `POST /api/ask`. */
export type PromptBlock = 'not_live' | 'no_tmux' | 'awaiting_input' | 'busy' | 'unsupported' | 'unsafe_prefix';

export interface Account {
  /** Claude Code: `oauthAccount.accountUuid`; Codex: `chatgpt_account_id` (a rollout's `creator_account_id`, `account/rateLimits/read`'s `accountId`). */
  id: string;
  /** `config.labels[id]`, else the email, else the organization name, else `id.slice(0, 8)`. Never empty. */
  label: string;
  /** Claude Code only: inferred from the home's login timeline rather than known for certain. */
  estimated?: boolean;
}

export interface Session {
  /** `<provider>:<nativeId>` */
  id: string;
  provider: ProviderId;
  /** May be empty when the agent has not produced a title yet. */
  title: string;
  cwd: string;
  status: SessionStatus;
  /** ISO 8601 */
  lastActivity: string;
  /** Present when `POST /api/sessions/:sid/prompt` would be refused. */
  promptBlock?: PromptBlock;
  context?: { used: number; window: number };
  /** Absent for a single or unknown account. */
  account?: Account;
  /** Model name for people, e.g. `Fable 5.1` (Claude Code) or `gpt-6-astra` (Codex). */
  model?: string;
  /** Reasoning effort, e.g. `xhigh`, `high`, `medium`, `low`; absent when unset or unsupported by the model. */
  effort?: string;
}

export const ITEM_KINDS = ['user', 'assistant', 'tool', 'notice'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface Item {
  /** Position in the session, starting at 1. An updated item is re-sent with the same seq. */
  seq: number;
  kind: ItemKind;
  ts: string;
  text: string;
  detail?: string;
  pending?: boolean;
  error?: boolean;
  /** On an `assistant` item: a plan the agent proposed in plan mode (Claude Code: ExitPlanMode's plan; Codex: a plan item). */
  plan?: boolean;
  /** On an `error` assistant item that is a usage limit the agent hit: when the limit resets (ISO 8601), when known. */
  resetsAt?: string;
}

export interface Option {
  id: string;
  label: string;
  description?: string;
}

export interface Question {
  id: string;
  header?: string;
  text: string;
  multi: boolean;
  options: Option[];
}

export type RequestKind = 'permission' | 'question';

/** A permission request carries exactly one question with id `decision`. */
export const PERMISSION_QUESTION = 'decision';
export type PermissionOption = 'allow' | 'always' | 'deny' | 'defer';

export interface PendingRequest {
  id: string;
  sessionId: string;
  kind: RequestKind;
  title: string;
  questions: Question[];
  createdAt: string;
}

/** Question id -> selected option ids. */
export type Answers = Record<string, string[]>;

export interface UsageWindow {
  /** claude-code: `5h` | `7d` | `7d_<model>` (e.g. `7d_opus`) | `spend`, else the statusLine key; codex: `primary` | `secondary` */
  id: string;
  /** For people, e.g. `5h`, `7d Opus`, `Spend` (claude-code only); a watch shows `id` when absent. */
  label?: string;
  usedPercent: number;
  resetsAt?: string;
  minutes?: number;
}

export interface Usage {
  provider: ProviderId;
  updatedAt: string;
  windows: UsageWindow[];
  /** Absent for a single or unknown account (see the identity rule in the header). */
  account?: Account;
}

export type ResolvedBy = 'watch' | 'terminal' | 'timeout';
export type AlertKind = 'needs_input' | 'done' | 'limit';

/** A session finished, waits for input, or hit a usage limit. Sent as an `alert` event and replayed in the `snapshot` (the last 10 of the past 10 minutes) for a watch that was offline. */
export interface Alert {
  /** uuid; a watch shows each id once (an event, then the snapshots that replay it). */
  id: string;
  /** ISO 8601 */
  at: string;
  sessionId: string;
  alert: AlertKind;
  /** `needs_input`: a short summary; `done`: up to 500 characters of the answer; `limit`: up to 500 characters of the agent's limit message. */
  text?: string;
  /** `done`: the prompt that started the turn, else the session title; `limit`: the session title. */
  title?: string;
  /** `limit`: when the limit resets (ISO 8601), when known. */
  resetsAt?: string;
}

export type AskStatus = 'running' | 'done' | 'error';

/** A Quick Ask: one headless, tool-less run of the agent CLI for a short answer. Kept in memory per device; never a session. */
export interface Ask {
  /** `ask-<uuid>` */
  id: string;
  provider: ProviderId;
  /** The conversation this ask continues: the id of the thread's first ask (its own id for a first ask). */
  threadId: string;
  /** The watch's text, trimmed. */
  question: string;
  status: AskStatus;
  /** When `done`; at most TEXT_MAX code units. */
  answer?: string;
  /** When `done`. Claude Code: the model's name for people (e.g. `Haiku 4.5`); Codex: the configured `codexModel`, absent when unset. */
  model?: string;
  /** When `done` or `error`: child start to exit. */
  durationMs?: number;
  /** When `error`: `timeout`, `cancelled`, `exit_<code>`, `bad_output`, or a short message from the CLI. */
  error?: string;
  /** ISO 8601 */
  createdAt: string;
}

export type ServerEvent =
  /** `alerts`: the buffered alerts, oldest first, so a reconnecting watch can post the ones it missed. */
  | { type: 'snapshot'; apiVersion: typeof API_VERSION; sessions: Session[]; requests: PendingRequest[]; usage: Usage[]; alerts: Alert[] }
  | { type: 'session'; session: Session }
  | { type: 'session_removed'; sessionId: string }
  | { type: 'item'; sessionId: string; item: Item }
  | { type: 'request'; request: PendingRequest }
  | { type: 'resolved'; requestId: string; by: ResolvedBy }
  | { type: 'usage'; usage: Usage }
  | ({ type: 'alert' } & Alert)
  /** Sent to the asking device only; `text` is the answer. `running` once after the 202, then `done` or `error` once. */
  | { type: 'ask'; askId: string; provider: ProviderId; status: AskStatus; text?: string; model?: string; durationMs?: number; error?: string };

/**
 * `background` (the watch app is not on screen): the bridge sends only `request`, `resolved`,
 * `alert` and `session` events whose status changed to or from `needs_input`. `foreground` (the
 * default for a new connection) sends everything.
 */
export type ClientMode = 'foreground' | 'background';

/** `subscribe`: `kinds`, when present, limits the subscription's `item` events to those kinds. `mode`: see ClientMode. */
export type ClientEvent = { type: 'subscribe'; sessionId: string | null; kinds?: ItemKind[] } | { type: 'mode'; mode: ClientMode };

/** WebSocket close code sent when the device token is revoked. */
export const CLOSE_REVOKED = 4001;

// REST bodies.

export interface BridgeInfo {
  name: string;
  version: string;
  apiVersion: typeof API_VERSION;
}

export interface PairRequest {
  code: string;
  deviceName: string;
}

export interface PairResponse {
  token: string;
  deviceId: string;
  bridge: BridgeInfo;
}

export interface ProviderHealth {
  id: ProviderId;
  status: 'ok' | 'not_found';
  /** Agent CLI version seen in its most recent session data. */
  version?: string;
  /** Diagnostic text for people (English, not localised), e.g. the Codex app-server connection. */
  detail?: string;
}

export interface Health extends BridgeInfo {
  providers: ProviderHealth[];
}

export interface SessionList {
  sessions: Session[];
}

export interface ItemPage {
  items: Item[];
  hasMore: boolean;
}

export interface PromptBody {
  text: string;
}

export interface RequestList {
  requests: PendingRequest[];
}

export interface AnswerBody {
  answers: Answers;
}

export interface UsageList {
  usage: Usage[];
}

export interface AskBody {
  provider: ProviderId;
  text: string;
  /** Overrides the bridge's configured model for this ask. */
  model?: string;
  /** Continues that thread (a `threadId` of this device's asks); absent for a new thread. */
  threadId?: string;
}

export interface AskAccepted {
  askId: string;
}

export interface AskList {
  asks: Ask[];
}

export type ErrorCode =
  | 'unauthorized'
  | 'rate_limited'
  | 'bad_request'
  | 'not_found'
  | 'payload_too_large'
  | 'invalid_code'
  | 'already_resolved'
  | 'internal'
  | 'ask_unavailable'
  | PromptBlock;

export interface ApiError {
  error: ErrorCode;
}
