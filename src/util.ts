// Helpers for reading untyped JSON from agent files and bounding text sent to the watch.

export type JsonObject = Record<string, unknown>;

/** An error the CLI prints as a plain message, without a stack trace. */
export class CliError extends Error {}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseJson(text: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Keeps the head of `text` within `max` code units, never splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  if (isHighSurrogate(text.charCodeAt(end - 1))) end--;
  return `${text.slice(0, end)}…`;
}

/** Keeps the tail of `text` within `max` code units, never splitting a surrogate pair. */
export function clipTail(text: string, max: number): string {
  if (text.length <= max) return text;
  let start = text.length - (max - 1);
  if (isLowSurrogate(text.charCodeAt(start))) start++;
  return `…${text.slice(start)}`;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The first line of `text`, clipped to `max`; undefined when there is none. */
export function headline(text: string | undefined, max: number): string | undefined {
  return clip(oneLine(text?.trim().split('\n')[0] ?? ''), max) || undefined;
}

/** Text safe to print or show: control characters (which could rewrite a terminal line) become spaces. */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

/** The record's own value for `key`; a plain object would answer `constructor` and the like from its prototype. */
export function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Accepts epoch seconds, epoch milliseconds or an ISO string. */
export function toIso(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  const n = num(value);
  if (n === undefined) return undefined;
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

export function isNotFound(err: unknown): boolean {
  return isObject(err) && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}
