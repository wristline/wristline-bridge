import { watch, type FSWatcher } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Item, ItemPage } from './protocol.ts';
import { isNotFound } from './util.ts';

const CHUNK_BYTES = 1 << 20;
const POLL_MS = 3000;
const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

export interface LineHandler {
  line(line: string): void;
  /** The file shrank or was replaced; everything will be read again from the start. */
  reset(): void;
}

/**
 * Incremental reader of an append-only JSONL file. Lines are split on the `\n` byte before
 * decoding, so a multibyte UTF-8 character cut by a read boundary stays intact in the carry.
 */
export class JsonlTail {
  readonly path: string;
  readonly #handler: LineHandler;
  #offset = 0;
  #ino: number | undefined;
  #carry: Buffer = EMPTY;
  #queue: Promise<boolean> = Promise.resolve(false);

  constructor(path: string, handler: LineHandler) {
    this.path = path;
    this.#handler = handler;
  }

  /** Consumes bytes appended since the last call; calls are serialized. Resolves true if anything changed. */
  sync(): Promise<boolean> {
    const run = this.#queue.then(
      () => this.#read(),
      () => this.#read(),
    );
    this.#queue = run;
    return run;
  }

  async #read(): Promise<boolean> {
    let file;
    try {
      file = await open(this.path, 'r');
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
    try {
      const { size, ino } = await file.stat();
      let changed = false;
      if (size < this.#offset || (this.#ino !== undefined && ino !== this.#ino)) {
        this.#offset = 0;
        this.#carry = EMPTY;
        this.#handler.reset();
        changed = true;
      }
      this.#ino = ino;
      while (this.#offset < size) {
        const length = Math.min(CHUNK_BYTES, size - this.#offset);
        const chunk = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(chunk, 0, length, this.#offset);
        if (bytesRead === 0) break;
        this.#offset += bytesRead;
        this.#consume(chunk.subarray(0, bytesRead));
        changed = true;
      }
      return changed;
    } finally {
      await file.close();
    }
  }

  #consume(chunk: Buffer): void {
    const buf = this.#carry.length > 0 ? Buffer.concat([this.#carry, chunk]) : chunk;
    let start = 0;
    for (let nl = buf.indexOf(NEWLINE); nl !== -1; nl = buf.indexOf(NEWLINE, start)) {
      if (nl > start) this.#handler.line(buf.toString('utf8', start, nl));
      start = nl + 1;
    }
    // Copy so the (up to 1 MiB) read buffer is not retained by a short tail.
    this.#carry = start < buf.length ? Buffer.from(buf.subarray(start)) : EMPTY;
  }
}

/**
 * Calls `onEvent` when the file may have changed: on fs.watch events and every 3 s, because
 * fs.watch misses events on some filesystems and cannot watch a file that does not exist yet.
 */
export function followFile(path: string, onEvent: () => void): () => void {
  let watcher: FSWatcher | undefined;
  const arm = (): void => {
    if (watcher) return;
    try {
      watcher = watch(path, onEvent);
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      // Not created yet; the poll below re-arms.
    }
  };
  arm();
  const timer = setInterval(() => {
    arm();
    onEvent();
  }, POLL_MS);
  return () => {
    clearInterval(timer);
    watcher?.close();
  };
}

export type ItemDraft = Omit<Item, 'seq'>;

/** Receives items parsed from agent records; `update` of an unknown key is ignored. */
export interface ItemSink {
  add(key: string, item: ItemDraft): void;
  update(key: string, patch: Partial<ItemDraft>): void;
}

export class ItemLog implements ItemSink {
  #items: Item[] = [];
  #byKey = new Map<string, Item>();
  #changed = new Set<Item>();

  add(key: string, draft: ItemDraft): void {
    if (this.#byKey.has(key)) {
      this.update(key, draft);
      return;
    }
    const item: Item = { seq: this.#items.length + 1, ...draft };
    this.#items.push(item);
    this.#byKey.set(key, item);
    this.#changed.add(item);
  }

  update(key: string, patch: Partial<ItemDraft>): void {
    const item = this.#byKey.get(key);
    if (!item) return;
    Object.assign(item, patch);
    this.#changed.add(item);
  }

  /** Items added or updated since the previous drain, in seq order. */
  drain(): Item[] {
    const out = [...this.#changed].sort((a, b) => a.seq - b.seq);
    this.#changed.clear();
    return out;
  }

  reset(): void {
    this.#items = [];
    this.#byKey.clear();
    this.#changed.clear();
  }

  /** The `limit` newest items with seq < `before`. */
  page(before: number | undefined, limit: number): ItemPage {
    const total = this.#items.length;
    const end = before === undefined ? total : Math.max(0, Math.min(total, before - 1));
    const start = Math.max(0, end - limit);
    return { items: this.#items.slice(start, end), hasMore: start > 0 };
  }
}

export type LineParser = (line: string, sink: ItemSink) => void;

/** One session's items, kept current from its JSONL file while anyone watches it. */
export class Transcript {
  readonly #path: string;
  readonly #tail: JsonlTail;
  readonly #log = new ItemLog();
  readonly #subscribers = new Set<(item: Item) => void>();
  #unfollow: (() => void) | undefined;
  #loaded = false;

  constructor(path: string, parse: LineParser) {
    this.#path = path;
    this.#tail = new JsonlTail(path, {
      line: (line) => parse(line, this.#log),
      reset: () => this.#log.reset(),
    });
  }

  get watched(): boolean {
    return this.#subscribers.size > 0;
  }

  async page(before: number | undefined, limit: number): Promise<ItemPage> {
    await this.sync();
    return this.#log.page(before, limit);
  }

  async sync(): Promise<void> {
    await this.#tail.sync();
    const changed = this.#log.drain();
    // The initial load is history, which clients fetch through `page`.
    if (this.#loaded) {
      for (const item of changed) for (const fn of this.#subscribers) fn(item);
    }
    this.#loaded = true;
  }

  /**
   * Applies items from a live source (e.g. app-server notifications) after catching up with the
   * file, so seq order still follows the file. The file's own record of the same item (same key)
   * later updates it in place.
   */
  async inject(apply: (sink: ItemSink) => void): Promise<void> {
    await this.sync();
    apply(this.#log);
    for (const item of this.#log.drain()) for (const fn of this.#subscribers) fn(item);
  }

  subscribe(onItem: (item: Item) => void): () => void {
    this.#subscribers.add(onItem);
    if (!this.#unfollow) {
      const kick = (): void => {
        this.sync().catch((err: unknown) => console.error(`wristline: reading ${this.#path}:`, err));
      };
      this.#unfollow = followFile(this.#path, kick);
      kick();
    }
    return () => {
      this.#subscribers.delete(onItem);
      if (this.#subscribers.size === 0) this.close();
    };
  }

  close(): void {
    this.#unfollow?.();
    this.#unfollow = undefined;
    this.#subscribers.clear();
  }
}

/** Least-recently-used transcripts; a transcript being watched is never evicted. */
export class TranscriptCache {
  readonly #max: number;
  readonly #entries = new Map<string, Transcript>();

  constructor(max = 20) {
    this.#max = max;
  }

  get(key: string, create: () => Transcript): Transcript {
    let entry = this.#entries.get(key);
    if (entry) {
      this.#entries.delete(key);
    } else {
      entry = create();
    }
    this.#entries.set(key, entry);
    for (const [k, t] of this.#entries) {
      if (this.#entries.size <= this.#max) break;
      if (!t.watched) this.#entries.delete(k);
    }
    return entry;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /** The cached transcript, without creating one or changing the LRU order. */
  peek(key: string): Transcript | undefined {
    return this.#entries.get(key);
  }

  clear(): void {
    for (const t of this.#entries.values()) t.close();
    this.#entries.clear();
  }
}
