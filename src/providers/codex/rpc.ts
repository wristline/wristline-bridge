// Subset of the Codex app-server v2 protocol (codex-cli 0.159.0) that the bridge reads.
//
// Hand-written instead of `codex app-server generate-ts`: the generated tree (~730 files) uses
// extensionless relative imports, which do not compile under `moduleResolution: nodenext`.
// Field names mirror the generated types so they can be swapped in later.

export type UserInput =
  | { type: 'text'; text: string }
  | { type: 'image' | 'localImage' | 'audio' | 'localAudio' | 'skill' | 'mention' };

export type CommandExecutionStatus = 'inProgress' | 'completed' | 'failed' | 'declined';
export type PatchApplyStatus = 'inProgress' | 'completed' | 'failed' | 'declined';
export type PatchChangeKind = { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null };

export interface FileUpdateChange {
  path: string;
  kind: PatchChangeKind;
  diff: string;
}

/** The ThreadItem variants the watch shows; the others are skipped. */
export type ThreadItem =
  | { type: 'userMessage'; id: string; content: UserInput[] }
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'plan'; id: string; text: string }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      status: CommandExecutionStatus;
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | { type: 'fileChange'; id: string; changes: FileUpdateChange[]; status: PatchApplyStatus };

export interface ItemCompletedNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
  completedAtMs: number;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}
