// Wire format of the Wristline protocol, apiVersion 1.
// This file is the single source of truth: a change here must update docs/protocol.md and
// protocol/v1/*.json (`UPDATE_FIXTURES=1 npm test`) in the same commit.

export const API_VERSION = 1;
/** Upper bounds (UTF-16 code units) the bridge enforces before sending text to the watch. */
export const TEXT_MAX = 4000;
export const DETAIL_MAX = 600;

export type ProviderId = 'claude-code' | 'codex';
export type SessionStatus = 'running' | 'idle' | 'needs_input' | 'ended';
/** `unsafe_prefix` is only ever a prompt error (409), never a session's `promptBlock`. */
export type PromptBlock = 'not_live' | 'no_tmux' | 'awaiting_input' | 'busy' | 'unsupported' | 'unsafe_prefix';

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
}

export type ItemKind = 'user' | 'assistant' | 'tool' | 'notice';

export interface Item {
  /** Position in the session, starting at 1. An updated item is re-sent with the same seq. */
  seq: number;
  kind: ItemKind;
  ts: string;
  text: string;
  detail?: string;
  pending?: boolean;
  error?: boolean;
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
  /** `5h` | `7d` (claude-code), `primary` | `secondary` (codex) */
  id: string;
  usedPercent: number;
  resetsAt?: string;
  minutes?: number;
}

export interface Usage {
  provider: ProviderId;
  updatedAt: string;
  windows: UsageWindow[];
}

export type ResolvedBy = 'watch' | 'terminal' | 'timeout';
export type AlertKind = 'needs_input' | 'done';

export type ServerEvent =
  | { type: 'snapshot'; apiVersion: typeof API_VERSION; sessions: Session[]; requests: PendingRequest[]; usage: Usage[] }
  | { type: 'session'; session: Session }
  | { type: 'session_removed'; sessionId: string }
  | { type: 'item'; sessionId: string; item: Item }
  | { type: 'request'; request: PendingRequest }
  | { type: 'resolved'; requestId: string; by: ResolvedBy }
  | { type: 'usage'; usage: Usage }
  | { type: 'alert'; sessionId: string; alert: AlertKind; text?: string };

export type ClientEvent = { type: 'subscribe'; sessionId: string | null };

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

export type ErrorCode =
  | 'unauthorized'
  | 'rate_limited'
  | 'bad_request'
  | 'not_found'
  | 'payload_too_large'
  | 'invalid_code'
  | 'already_resolved'
  | 'internal'
  | PromptBlock;

export interface ApiError {
  error: ErrorCode;
}
