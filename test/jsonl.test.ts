import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ItemLog, JsonlTail, Transcript, TranscriptCache, type ItemSink } from '../src/jsonl.ts';
import type { Item, ItemKind } from '../src/protocol.ts';

const dir = mkdtempSync(join(tmpdir(), 'wristline-jsonl-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function collect(path: string): { tail: JsonlTail; lines: string[]; resets: number[] } {
  const lines: string[] = [];
  const resets: number[] = [];
  const tail = new JsonlTail(path, { line: (l) => lines.push(l), reset: () => resets.push(lines.length) });
  return { tail, lines, resets };
}

test('a Korean character split across appends is decoded once the line completes', async () => {
  const path = join(dir, 'split.jsonl');
  const bytes = Buffer.from('{"text":"한글"}\n', 'utf8');
  const cut = bytes.indexOf(Buffer.from('한', 'utf8')) + 1; // inside the 3-byte sequence
  writeFileSync(path, bytes.subarray(0, cut));
  const { tail, lines } = collect(path);
  assert.equal(await tail.sync(), true);
  assert.deepEqual(lines, []);
  appendFileSync(path, bytes.subarray(cut));
  await tail.sync();
  assert.deepEqual(lines, ['{"text":"한글"}']);
});

test('a multibyte character straddling the 1 MiB read chunk stays intact', async () => {
  const path = join(dir, 'chunk.jsonl');
  const first = 'a'.repeat((1 << 20) - 2);
  writeFileSync(path, `${first}\n한글 끝\n`); // '한' starts at byte 2^20 - 1
  const { tail, lines } = collect(path);
  await tail.sync();
  assert.equal(lines.length, 2);
  assert.equal(lines[1], '한글 끝');
});

test('a partial line is carried until its newline arrives', async () => {
  const path = join(dir, 'partial.jsonl');
  writeFileSync(path, '{"a":1}\n{"b":');
  const { tail, lines } = collect(path);
  await tail.sync();
  assert.deepEqual(lines, ['{"a":1}']);
  assert.equal(await tail.sync(), false);
  appendFileSync(path, '2}\n');
  await tail.sync();
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test('truncation resets and re-reads from the start', async () => {
  const path = join(dir, 'truncate.jsonl');
  writeFileSync(path, '{"n":1}\n{"n":2}\n');
  const { tail, lines, resets } = collect(path);
  await tail.sync();
  truncateSync(path, 0);
  writeFileSync(path, '{"n":3}\n');
  await tail.sync();
  assert.deepEqual(resets, [2]);
  assert.deepEqual(lines, ['{"n":1}', '{"n":2}', '{"n":3}']);
});

test('a missing file reads as empty', async () => {
  const { tail, lines } = collect(join(dir, 'missing.jsonl'));
  assert.equal(await tail.sync(), false);
  assert.deepEqual(lines, []);
});

test('ItemLog pages backwards by seq', () => {
  const log = new ItemLog();
  for (let i = 1; i <= 5; i++) log.add(`k${i}`, { kind: 'user', ts: 't', text: String(i) });
  const texts = (p: { items: Item[] }): string[] => p.items.map((i) => i.text);
  assert.deepEqual(texts(log.page(undefined, 2)), ['4', '5']);
  assert.equal(log.page(undefined, 2).hasMore, true);
  assert.deepEqual(texts(log.page(4, 2)), ['2', '3']);
  assert.deepEqual(log.page(2, 10), { items: [log.page(undefined, 5).items[0]], hasMore: false });
  assert.deepEqual(log.page(1, 10), { items: [], hasMore: false });
});

test('ItemLog pages over the items of the given kinds only; before stays a seq', () => {
  const log = new ItemLog();
  const kinds: ItemKind[] = ['user', 'tool', 'tool', 'assistant', 'tool', 'notice', 'tool', 'tool', 'user', 'tool'];
  kinds.forEach((kind, i) => log.add(`k${i + 1}`, { kind, ts: 't', text: String(i + 1) }));
  const talk = new Set<ItemKind>(['user', 'assistant', 'notice']);
  const seqs = (p: { items: Item[]; hasMore: boolean }): [number[], boolean] => [p.items.map((i) => i.seq), p.hasMore];
  assert.deepEqual(seqs(log.page(undefined, 2, talk)), [[6, 9], true]);
  assert.deepEqual(seqs(log.page(6, 2, talk)), [[1, 4], false], 'the next page starts below the smallest seq; no older match left');
  assert.deepEqual(seqs(log.page(undefined, 3, talk)), [[4, 6, 9], true]);
  assert.deepEqual(seqs(log.page(undefined, 4, talk)), [[1, 4, 6, 9], false], 'exactly the matching items: no more');
  assert.deepEqual(seqs(log.page(8, 1, talk)), [[6], true], 'before may point at a skipped item');
  assert.deepEqual(seqs(log.page(undefined, 1, new Set(['assistant']))), [[4], false], 'only other kinds are older');
  assert.deepEqual(seqs(log.page(undefined, 40, new Set(['tool']))), [[2, 3, 5, 7, 8, 10], false]);
  assert.deepEqual(seqs(log.page(2, 40, new Set(['tool']))), [[], false]);
  assert.deepEqual(seqs(log.page(undefined, 40, new Set())), [[], false]);
  assert.deepEqual(seqs(log.page(undefined, 3)), [[8, 9, 10], true], 'without kinds, every item counts');
});

const parseText = (line: string, sink: ItemSink): void => {
  const { id, text } = JSON.parse(line) as { id: string; text: string };
  sink.add(id, { kind: 'user', ts: 't', text });
};

test('a watched transcript streams appended items but not its history', async () => {
  const path = join(dir, 'watched.jsonl');
  writeFileSync(path, '{"id":"a","text":"old"}\n');
  const transcript = new Transcript(path, parseText);
  const seen: Item[] = [];
  const stop = transcript.subscribe((item) => seen.push(item));
  await transcript.sync();
  assert.deepEqual(seen, []);
  appendFileSync(path, '{"id":"b","text":"new"}\n');
  const deadline = Date.now() + 5000;
  while (seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  stop();
  assert.deepEqual(seen, [{ seq: 2, kind: 'user', ts: 't', text: 'new' }]);
  assert.equal(transcript.watched, false);
});

test('TranscriptCache evicts the least recently used unwatched transcript', () => {
  const cache = new TranscriptCache(2);
  const make = (name: string) => () => new Transcript(join(dir, `${name}.jsonl`), parseText);
  const a = cache.get('a', make('a'));
  const stop = a.subscribe(() => {});
  cache.get('b', make('b'));
  cache.get('c', make('c'));
  assert.equal(cache.has('a'), true, 'watched entries stay');
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('c'), true);
  stop();
  cache.clear();
});

test('a tail replays its head files before its own lines, again after a reset, and can be rebased', async () => {
  const base = join(dir, 'base.jsonl');
  const lines = ['{"n":1}\n', '{"n":2}\n', '{"n":3}\n'];
  writeFileSync(base, lines.join(''));
  const end = Buffer.byteLength(lines[0]! + lines[1]!);
  const segment = join(dir, 'segment.jsonl');
  writeFileSync(segment, '{"n":4}\n');
  const seen: string[] = [];
  const resets: number[] = [];
  const tail = new JsonlTail(segment, { line: (l) => seen.push(l), reset: () => resets.push(seen.length) }, [{ path: base, end }]);
  await tail.sync();
  assert.deepEqual(seen, ['{"n":1}', '{"n":2}', '{"n":4}'], 'the third base line lies past the cut');
  appendFileSync(segment, '{"n":5}\n');
  await tail.sync();
  assert.deepEqual(seen.slice(3), ['{"n":5}']);
  truncateSync(segment, 0);
  writeFileSync(segment, '{"n":6}\n');
  await tail.sync();
  assert.deepEqual([resets, seen.slice(4)], [[4], ['{"n":1}', '{"n":2}', '{"n":6}']]);

  const parse = (line: string, sink: ItemSink): void => sink.add(line, { kind: 'notice', ts: '', text: line });
  const transcript = new Transcript(base, parse);
  const items: Item[] = [];
  transcript.subscribe((item) => items.push(item));
  assert.deepEqual((await transcript.page(undefined, 10)).items.map((i) => i.text), ['{"n":1}', '{"n":2}', '{"n":3}']);
  assert.equal(items.length, 0, 'history is not streamed');
  transcript.rebase(segment, [{ path: base, end }]);
  assert.equal(transcript.path, segment);
  assert.deepEqual((await transcript.page(undefined, 10)).items.map((i) => [i.seq, i.text]), [[1, '{"n":1}'], [2, '{"n":2}'], [3, '{"n":6}']]);
  assert.deepEqual(items.map((i) => [i.seq, i.text]), [[1, '{"n":1}'], [2, '{"n":2}'], [3, '{"n":6}']], 'the rebased items are streamed with their new seq');
  appendFileSync(segment, '{"n":7}\n');
  await transcript.sync();
  assert.deepEqual(items.at(-1), { seq: 4, kind: 'notice', ts: '', text: '{"n":7}' });
  transcript.close();
});
