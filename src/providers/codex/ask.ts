// Maps the app-server's approval and question requests to watch requests, and the watch's answers
// back to the request results. Verified against codex-cli 0.159.0.

import type { RequestDraft } from '../../pending.ts';
import { PERMISSION_QUESTION, type Answers, type Option, type Question } from '../../protocol.ts';
import { clip, isObject, str, type JsonObject } from '../../util.ts';

/** Longest command or question text shown on a request. */
const REQUEST_TEXT_MAX = 1500;

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
