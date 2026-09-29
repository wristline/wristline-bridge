// Pure parsing of Codex rollouts ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl) and
// session_index.jsonl. Rollouts use snake_case and PascalCase item types while the app-server
// uses camelCase; everything is normalized to the app-server shapes in rpc.ts first, so the same
// code will serve `item/completed` notifications. Verified against codex-cli 0.159.0.

import type { ItemDraft, ItemSink, LineHandler } from '../../jsonl.ts';
import type { RequestDraft } from '../../pending.ts';
import { DETAIL_MAX, PERMISSION_QUESTION, TEXT_MAX, type Answers, type Option, type Question, type Usage, type UsageWindow } from '../../protocol.ts';
import { clip, clipTail, isObject, num, oneLine, parseJson, str, toIso, type JsonObject } from '../../util.ts';
import type {
  CommandExecutionStatus,
  FileUpdateChange,
  ItemCompletedNotification,
  PatchChangeKind,
  RateLimitSnapshot,
  RateLimitWindow,
  ThreadItem,
  ThreadStatus,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  UserInput,
} from './rpc.ts';

const TITLE_MAX = 40;
/** Longest command or question text shown on a request. */
const REQUEST_TEXT_MAX = 1500;

function camelKeys(obj: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(obj)) out[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  return out;
}

function normalizeStatus(value: unknown): CommandExecutionStatus {
  switch (str(value)?.toLowerCase().replace(/_/g, '')) {
    case 'inprogress':
      return 'inProgress';
    case 'failed':
      return 'failed';
    case 'declined':
      return 'declined';
    default:
      return 'completed';
  }
}

/** Text of `[{type: "text" | "Text", text}]` content. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => (isObject(part) && str(part.type)?.toLowerCase() === 'text' ? (str(part.text) ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Rollouts store argv (`["/bin/bash", "-lc", "<script>"]`), the app-server a string
 * (`/bin/bash -lc '<script>'`); both become `<script>` so the two sources show the same text.
 */
function commandString(command: unknown): string {
  if (typeof command === 'string') return /^\S*sh -l?c '([^']*)'$/.exec(command)?.[1] ?? command;
  if (!Array.isArray(command)) return '';
  const argv = command.filter((a: unknown): a is string => typeof a === 'string');
  if (argv.length === 3 && (argv[1] === '-lc' || argv[1] === '-c')) return argv[2] ?? '';
  return argv.join(' ');
}

function changeKind(value: unknown): PatchChangeKind {
  const type = isObject(value) ? str(value.type) : str(value);
  if (type === 'add' || type === 'delete') return { type };
  const movePath = isObject(value) ? (str(value.move_path) ?? str(value.movePath) ?? null) : null;
  return { type: 'update', move_path: movePath };
}

/** Rollouts map path -> change, the app-server sends an array. */
function fileChanges(changes: unknown): FileUpdateChange[] {
  if (Array.isArray(changes)) {
    return changes.flatMap((c: unknown) => {
      const path = isObject(c) ? str(c.path) : undefined;
      return isObject(c) && path ? [{ path, kind: changeKind(c.kind), diff: str(c.diff) ?? '' }] : [];
    });
  }
  if (!isObject(changes)) return [];
  return Object.entries(changes).map(([path, c]) => ({
    path,
    kind: changeKind(c),
    diff: isObject(c) ? (str(c.unified_diff) ?? '') : '',
  }));
}

/** Undefined for item kinds the watch does not show (reasoning, sub-agent activity, ...). */
export function normalizeItem(raw: unknown): ThreadItem | undefined {
  if (!isObject(raw)) return undefined;
  const o = camelKeys(raw);
  const id = str(o.id);
  if (!id) return undefined;
  switch (str(o.type)?.toLowerCase()) {
    case 'usermessage': {
      const text = contentText(o.content);
      const content: UserInput[] = text ? [{ type: 'text', text }] : [];
      return { type: 'userMessage', id, content };
    }
    case 'agentmessage':
      return { type: 'agentMessage', id, text: str(o.text) ?? contentText(o.content) };
    case 'plan':
      return { type: 'plan', id, text: str(o.text) ?? '' };
    case 'commandexecution':
      return {
        type: 'commandExecution',
        id,
        command: commandString(o.command),
        status: normalizeStatus(o.status),
        aggregatedOutput: str(o.aggregatedOutput) ?? null,
        exitCode: num(o.exitCode) ?? null,
      };
    case 'filechange':
      return { type: 'fileChange', id, changes: fileChanges(o.changes), status: normalizeStatus(o.status) };
    default:
      return undefined;
  }
}

export function normalizeItemCompleted(raw: unknown): ItemCompletedNotification | undefined {
  if (!isObject(raw)) return undefined;
  const o = camelKeys(raw);
  const item = normalizeItem(o.item);
  if (!item) return undefined;
  return { item, threadId: str(o.threadId) ?? '', turnId: str(o.turnId) ?? '', completedAtMs: num(o.completedAtMs) ?? 0 };
}

export function itemDraft(item: ThreadItem, ts: string): ItemDraft | undefined {
  switch (item.type) {
    case 'userMessage': {
      const text = item.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n').trim();
      return text ? { kind: 'user', ts, text: clip(text, TEXT_MAX) } : undefined;
    }
    case 'agentMessage': {
      const text = item.text.trim();
      return text ? { kind: 'assistant', ts, text: clip(text, TEXT_MAX) } : undefined;
    }
    case 'plan':
      return { kind: 'notice', ts, text: clip(item.text.trim(), TEXT_MAX) };
    case 'commandExecution': {
      // `pending` is always set: a live `item/started` item is later replaced by its completion.
      const draft: ItemDraft = { kind: 'tool', ts, text: clip(`Shell(${item.command})`, TEXT_MAX), pending: item.status === 'inProgress' };
      const output = item.aggregatedOutput?.trim();
      if (output) draft.detail = clipTail(output, DETAIL_MAX);
      if (item.status === 'failed' || item.status === 'declined' || (item.exitCode !== null && item.exitCode !== 0)) draft.error = true;
      return draft;
    }
    case 'fileChange': {
      const draft: ItemDraft = {
        kind: 'tool',
        ts,
        text: clip(`Edit(${item.changes.map((c) => c.path).join(', ')})`, TEXT_MAX),
        pending: item.status === 'inProgress',
      };
      if (item.status === 'failed' || item.status === 'declined') draft.error = true;
      return draft;
    }
  }
}

export function applyItemCompleted(n: ItemCompletedNotification, fallbackTs: string, sink: ItemSink): void {
  const ts = n.completedAtMs > 0 ? new Date(n.completedAtMs).toISOString() : fallbackTs;
  const draft = itemDraft(n.item, ts);
  if (draft) sink.add(n.item.id, draft);
}

/** Applies one rollout line to the session's items. */
export function parseCodexLine(line: string, sink: ItemSink): void {
  if (!line.includes('"item_completed"')) return;
  const rec = parseJson(line);
  const payload = rec?.payload;
  if (!rec || !isObject(payload) || payload.type !== 'item_completed') return;
  const n = normalizeItemCompleted(payload);
  if (n) applyItemCompleted(n, str(rec.timestamp) ?? '', sink);
}

function breakdown(raw: unknown): TokenUsageBreakdown | undefined {
  if (!isObject(raw)) return undefined;
  const o = camelKeys(raw);
  const totalTokens = num(o.totalTokens);
  if (totalTokens === undefined) return undefined;
  return {
    totalTokens,
    inputTokens: num(o.inputTokens) ?? 0,
    cachedInputTokens: num(o.cachedInputTokens) ?? 0,
    outputTokens: num(o.outputTokens) ?? 0,
    reasoningOutputTokens: num(o.reasoningOutputTokens) ?? 0,
  };
}

/** `token_count.info` of a rollout or `tokenUsage` of thread/tokenUsage/updated. */
export function normalizeTokenUsage(raw: unknown): ThreadTokenUsage | undefined {
  if (!isObject(raw)) return undefined;
  const o = camelKeys(raw);
  const total = breakdown(o.total ?? o.totalTokenUsage);
  const last = breakdown(o.last ?? o.lastTokenUsage);
  if (!total || !last) return undefined;
  return { total, last, modelContextWindow: num(o.modelContextWindow) ?? null };
}

/** Same numbers the TUI shows: tokens of the last request against the model window. */
export function contextOf(usage: ThreadTokenUsage): { used: number; window: number } | undefined {
  return usage.modelContextWindow ? { used: usage.last.totalTokens, window: usage.modelContextWindow } : undefined;
}

function rateWindow(raw: unknown): RateLimitWindow | null {
  if (!isObject(raw)) return null;
  const o = camelKeys(raw);
  const usedPercent = num(o.usedPercent);
  if (usedPercent === undefined) return null;
  return { usedPercent, windowDurationMins: num(o.windowDurationMins ?? o.windowMinutes) ?? null, resetsAt: num(o.resetsAt) ?? null };
}

export function normalizeRateLimits(raw: unknown): RateLimitSnapshot | undefined {
  if (!isObject(raw)) return undefined;
  const o = camelKeys(raw);
  const primary = rateWindow(o.primary);
  const secondary = rateWindow(o.secondary);
  if (!primary && !secondary) return undefined;
  return { limitId: str(o.limitId) ?? null, primary, secondary };
}

export function usageOf(snapshot: RateLimitSnapshot, updatedAt: string): Usage {
  const windows: UsageWindow[] = [];
  for (const [id, w] of [['primary', snapshot.primary], ['secondary', snapshot.secondary]] as const) {
    if (!w) continue;
    const window: UsageWindow = { id, usedPercent: w.usedPercent };
    const resetsAt = toIso(w.resetsAt);
    if (resetsAt) window.resetsAt = resetsAt;
    if (w.windowDurationMins !== null) window.minutes = w.windowDurationMins;
    windows.push(window);
  }
  return { provider: 'codex', updatedAt, windows };
}

/**
 * Collects what the session list needs from a rollout. Lines are filtered by substring before
 * JSON.parse; escaped quotes inside string values never match.
 */
export class CodexMetaScan implements LineHandler {
  id: string | undefined;
  cwd: string | undefined;
  version: string | undefined;
  /** Rollouts of threads spawned by another agent; listed only through their parent. */
  subagent = false;
  firstPrompt: string | undefined;
  turnOpen = false;
  context: { used: number; window: number } | undefined;
  rateLimits: { at: string; snapshot: RateLimitSnapshot } | undefined;

  line(line: string): void {
    if (line.includes('"type":"token_count"')) {
      const rec = parseJson(line);
      const payload = rec?.payload;
      if (!isObject(payload) || payload.type !== 'token_count') return;
      const usage = normalizeTokenUsage(payload.info);
      this.context = (usage && contextOf(usage)) ?? this.context;
      const snapshot = normalizeRateLimits(payload.rate_limits);
      const at = str(rec?.timestamp);
      if (snapshot && at) this.rateLimits = { at, snapshot };
    } else if (/"type":"(task_started|task_complete|turn_aborted)"/.test(line)) {
      const payload = parseJson(line)?.payload;
      const type = isObject(payload) ? payload.type : undefined;
      if (type === 'task_started') this.turnOpen = true;
      else if (type === 'task_complete' || type === 'turn_aborted') this.turnOpen = false;
    } else if (this.id === undefined && line.includes('"type":"session_meta"')) {
      const payload = parseJson(line)?.payload;
      if (!isObject(payload)) return;
      this.id = str(payload.id);
      this.cwd = str(payload.cwd);
      this.version = str(payload.cli_version);
      this.subagent = isObject(payload.source) && isObject(payload.source.subagent);
    } else if (this.firstPrompt === undefined && line.includes('"UserMessage"')) {
      const payload = parseJson(line)?.payload;
      const n = isObject(payload) && payload.type === 'item_completed' ? normalizeItemCompleted(payload) : undefined;
      if (n?.item.type !== 'userMessage') return;
      const text = oneLine(n.item.content.map((c) => (c.type === 'text' ? c.text : '')).join(' '));
      if (text) this.firstPrompt = clip(text, TITLE_MAX);
    }
  }

  reset(): void {
    this.id = this.cwd = this.version = this.firstPrompt = undefined;
    this.subagent = this.turnOpen = false;
    this.context = this.rateLimits = undefined;
  }
}

/** Thread names from session_index.jsonl; the last entry per id wins. */
export class SessionIndex implements LineHandler {
  readonly titles = new Map<string, string>();

  line(line: string): void {
    const rec = parseJson(line);
    const id = str(rec?.id);
    const name = str(rec?.thread_name);
    if (id && name) this.titles.set(id, name);
  }

  reset(): void {
    this.titles.clear();
  }
}

// App-server state and requests

export function normalizeThreadStatus(raw: unknown): ThreadStatus | undefined {
  if (!isObject(raw)) return undefined;
  switch (raw.type) {
    case 'notLoaded':
    case 'idle':
    case 'systemError':
      return { type: raw.type };
    case 'active': {
      const flags = Array.isArray(raw.activeFlags) ? raw.activeFlags : [];
      return { type: 'active', activeFlags: flags.filter((f): f is 'waitingOnApproval' | 'waitingOnUserInput' => f === 'waitingOnApproval' || f === 'waitingOnUserInput') };
    }
    default:
      return undefined;
  }
}

/** Fills the rate-limit windows a sparse `account/rateLimits/updated` carries into the last snapshot. */
export function mergeRateLimits(previous: RateLimitSnapshot | undefined, next: RateLimitSnapshot): RateLimitSnapshot {
  return { limitId: next.limitId ?? previous?.limitId ?? null, primary: next.primary ?? previous?.primary ?? null, secondary: next.secondary ?? previous?.secondary ?? null };
}

/** A server request the watch can answer, and how to turn the watch's answers into its result. */
export interface CodexAsk {
  threadId: string;
  turnId: string;
  itemId: string;
  draft: Omit<RequestDraft, 'sessionId'>;
  result(answers: Answers): unknown;
}

const permission = (title: string, text: string, options: Option[]): Omit<RequestDraft, 'sessionId'> => ({
  kind: 'permission',
  title,
  questions: [{ id: PERMISSION_QUESTION, text: clip(text.trim() || title, REQUEST_TEXT_MAX), multi: false, options }],
});

const withReason = (text: string, reason: string | undefined): string => (reason ? `${text}\n\n${reason}` : text);

/**
 * Maps an approval or `requestUserInput` request to a watch request; undefined for requests the
 * watch cannot answer (other methods, free-text or secret questions). `describeItem` returns
 * what a started item does (e.g. the files of a file change), because a file-change approval
 * does not repeat it.
 */
export function codexAsk(method: string, raw: unknown, describeItem: (itemId: string) => string | undefined = () => undefined): CodexAsk | undefined {
  if (!isObject(raw)) return undefined;
  const threadId = str(raw.threadId);
  const turnId = str(raw.turnId) ?? '';
  const itemId = str(raw.itemId) ?? '';
  if (!threadId) return undefined;
  const reason = str(raw.reason);
  const ids = { threadId, turnId, itemId };
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      // Absent in older servers; then every decision is allowed.
      const available = Array.isArray(raw.availableDecisions) ? raw.availableDecisions : undefined;
      const offers = (name: string): boolean => !available || available.some((d) => d === name || (isObject(d) && name in d));
      const amendment = available?.find((d) => isObject(d) && isObject(d.acceptWithExecpolicyAmendment));
      const always = offers('acceptForSession') ? 'acceptForSession' : amendment;
      const deny = offers('decline') ? 'decline' : offers('cancel') ? 'cancel' : undefined;
      const options: Option[] = [];
      if (offers('accept')) options.push({ id: 'allow', label: 'Allow' });
      if (always === 'acceptForSession') options.push({ id: 'always', label: 'Always allow', description: 'For this session' });
      else if (always) options.push({ id: 'always', label: 'Always allow', description: clip(amendmentText(always), 120) });
      if (deny) options.push({ id: 'deny', label: 'Deny' });
      if (options.length === 0) return undefined;
      const actions = Array.isArray(raw.commandActions) ? raw.commandActions.map((a: unknown) => (isObject(a) ? str(a.command) : undefined)).filter(Boolean) : [];
      const command = actions.length > 0 ? actions.join('\n') : (str(raw.command) ?? '');
      const decisions: Record<string, unknown> = { allow: 'accept', always, deny };
      return { ...ids, draft: permission('Shell', withReason(command, reason), options), result: (a) => ({ decision: decisions[a[PERMISSION_QUESTION]?.[0] ?? ''] }) };
    }
    case 'item/fileChange/requestApproval': {
      const options: Option[] = [
        { id: 'allow', label: 'Allow' },
        { id: 'always', label: 'Always allow', description: 'For this session' },
        { id: 'deny', label: 'Deny' },
      ];
      const decisions: Record<string, string> = { allow: 'accept', always: 'acceptForSession', deny: 'decline' };
      const text = withReason(describeItem(itemId) ?? 'File changes', reason);
      return { ...ids, draft: permission('Edit', text, options), result: (a) => ({ decision: decisions[a[PERMISSION_QUESTION]?.[0] ?? ''] }) };
    }
    case 'item/permissions/requestApproval': {
      const requested = isObject(raw.permissions) ? raw.permissions : {};
      const options: Option[] = [
        { id: 'allow', label: 'Allow' },
        { id: 'always', label: 'Always allow', description: 'For this session' },
        { id: 'deny', label: 'Deny' },
      ];
      const text = withReason(describePermissions(requested), reason);
      return {
        ...ids,
        draft: permission('Permissions', text, options),
        result: (a) => {
          const choice = a[PERMISSION_QUESTION]?.[0];
          // Granting nothing is the denial.
          return choice === 'deny' ? { permissions: {} } : { permissions: requested, scope: choice === 'always' ? 'session' : 'turn' };
        },
      };
    }
    case 'item/tool/requestUserInput': {
      const raws = Array.isArray(raw.questions) ? raw.questions : [];
      const questions: Question[] = [];
      for (const q of raws) {
        const id = isObject(q) ? str(q.id) : undefined;
        const text = isObject(q) ? str(q.question) : undefined;
        if (!isObject(q) || !id || !text || q.isSecret === true) return undefined;
        const options: Option[] = [];
        for (const [j, o] of (Array.isArray(q.options) ? q.options : []).entries()) {
          const label = isObject(o) ? str(o.label) : undefined;
          if (!label) continue;
          const description = isObject(o) ? str(o.description) : undefined;
          options.push(description ? { id: String(j), label, description } : { id: String(j), label });
        }
        // Free-text questions are answered in the terminal.
        if (options.length === 0) return undefined;
        const header = str(q.header);
        const shown = clip(text, REQUEST_TEXT_MAX);
        questions.push(header ? { id, header, text: shown, multi: false, options } : { id, text: shown, multi: false, options });
      }
      if (questions.length === 0) return undefined;
      return {
        ...ids,
        draft: { kind: 'question', title: 'Question', questions },
        result: (a) => {
          const answers: Record<string, { answers: string[] }> = {};
          for (const q of questions) answers[q.id] = { answers: q.options.filter((o) => a[q.id]?.includes(o.id)).map((o) => o.label) };
          return { answers };
        },
      };
    }
    default:
      return undefined;
  }
}

function amendmentText(decision: unknown): string {
  const inner = isObject(decision) && isObject(decision.acceptWithExecpolicyAmendment) ? decision.acceptWithExecpolicyAmendment.execpolicy_amendment : undefined;
  return Array.isArray(inner) ? inner.filter((a) => typeof a === 'string').join(' ') : '';
}

function describePermissions(p: JsonObject): string {
  const parts: string[] = [];
  if (isObject(p.network) && p.network.enabled === true) parts.push('Network access');
  const fs = isObject(p.fileSystem) ? p.fileSystem : {};
  for (const key of ['write', 'read'] as const) {
    const paths = Array.isArray(fs[key]) ? fs[key].filter((x): x is string => typeof x === 'string') : [];
    if (paths.length > 0) parts.push(`${key === 'write' ? 'Write' : 'Read'}: ${paths.join(', ')}`);
  }
  for (const e of Array.isArray(fs.entries) ? fs.entries : []) {
    if (!isObject(e) || !isObject(e.path)) continue;
    const where = str(e.path.path) ?? str(e.path.pattern) ?? (isObject(e.path.value) ? str(e.path.value.kind) : undefined);
    if (where) parts.push(`${str(e.access) ?? 'access'}: ${where}`);
  }
  return parts.length > 0 ? parts.join('\n') : 'Additional permissions';
}
