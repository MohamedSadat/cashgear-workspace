// Spike S3, step 3: Yjs 13 checks what cgw-ydoc produced from the corpus (step 2, .NET). Runs
// only with S3=1, after the other two steps (`pnpm bench:s3`).
// The pass criterion: the output loads in Yjs 13 with identical content for every document.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';

const ROOT = 'bench/results/s3';
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
const ready = !!process.env.S3 && existsSync(join(ROOT, 'out'));

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** JSON as ProseMirror treats it: key order and mark order do not matter, and adjacent text
 * with the same marks is one node. */
function canon(value: Json): Json {
  if (Array.isArray(value)) return value.map(canon);
  if (value === null || typeof value !== 'object') return value;
  const out: { [key: string]: Json } = {};
  for (const key of Object.keys(value).sort()) {
    let item = canon(value[key]);
    if (key === 'marks' && Array.isArray(item))
      item = [...item].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (key === 'content' && Array.isArray(item)) {
      const joined: Json[] = [];
      for (const child of item as { [key: string]: Json }[]) {
        const last = joined[joined.length - 1] as { [key: string]: Json } | undefined;
        if (
          last &&
          last.type === 'text' &&
          child.type === 'text' &&
          JSON.stringify(last.marks ?? null) === JSON.stringify(child.marks ?? null)
        )
          last.text = (last.text as string) + (child.text as string);
        else joined.push({ ...child });
      }
      item = joined;
    }
    out[key] = item;
  }
  return out;
}

/** The same plain-text rule as cgw-ydoc: one line per element that holds text. */
function plainText(fragment: Y.XmlFragment): string {
  const visit = (node: Y.XmlElement | Y.XmlText): string => {
    if (node instanceof Y.XmlText)
      return node
        .toDelta()
        .map((d: { insert: unknown }) => (typeof d.insert === 'string' ? d.insert : ''))
        .join('');
    const children = node.toArray() as (Y.XmlElement | Y.XmlText)[];
    const inner = children.map(visit).join('');
    const hasText = children.some((c) => c instanceof Y.XmlText);
    return inner + (hasText && !inner.endsWith('\n') ? '\n' : '');
  };
  return (fragment.toArray() as (Y.XmlElement | Y.XmlText)[]).map(visit).join('');
}

const load = (...updates: Uint8Array[]) => {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  return doc;
};

/** Client ranges as Yjs decodes them, to check cgw_client_ranges. */
function rangesOf(update: Uint8Array) {
  const decoded = Y.decodeUpdate(update);
  const byClient = new Map<number, { start: number; end: number }>();
  for (const struct of decoded.structs) {
    const { client, clock } = struct.id;
    const range = byClient.get(client) ?? { start: clock, end: clock };
    range.start = Math.min(range.start, clock);
    range.end = Math.max(range.end, clock + struct.length);
    byClient.set(client, range);
  }
  return [...byClient]
    .map(([client, r]) => ({ client, start: r.start, end: r.end }))
    .sort((a, b) => a.client - b.client);
}

describe.skipIf(!ready)('S3: Yjs 13 reads what cgw-ydoc wrote', () => {
  it('every document: merged, compacted, diffed, JSON, text, meta and client ranges', () => {
    const files = readdirSync(join(ROOT, 'corpus')).filter((f) => f.endsWith('.json'));
    const problems: string[] = [];
    let compactedBytes = 0;
    let mergedBytes = 0;
    for (const file of files) {
      const source = JSON.parse(readFileSync(join(ROOT, 'corpus', file), 'utf8'));
      const out = JSON.parse(readFileSync(join(ROOT, 'out', file), 'utf8'));
      const merged = bytes(out.merged);
      const compacted = bytes(out.compacted);
      mergedBytes += merged.byteLength;
      compactedBytes += compacted.byteLength;
      const expectedJson = JSON.stringify(canon(source.json));
      for (const [name, doc] of [
        ['merged', load(merged)],
        ['compacted', load(compacted)],
        ['half + diff', load(bytes(out.half), bytes(out.missing))],
      ] as const) {
        const fragment = doc.getXmlFragment('content');
        if (fragment.toJSON() !== source.xml) problems.push(`${file} ${name}: XML differs`);
        if (
          JSON.stringify(canon(yXmlFragmentToProsemirrorJSON(fragment) as unknown as Json)) !==
          expectedJson
        )
          problems.push(`${file} ${name}: ProseMirror JSON differs`);
      }
      const rustJson = JSON.stringify(canon(JSON.parse(out.json)));
      if (rustJson !== expectedJson) {
        let at = 0;
        while (at < rustJson.length && rustJson[at] === expectedJson[at]) at++;
        problems.push(
          `${file}: cgw_to_json differs from y-prosemirror's JSON at ${at}: rust …${rustJson.slice(Math.max(0, at - 80), at + 60)}… js …${expectedJson.slice(Math.max(0, at - 80), at + 60)}…`,
        );
      }
      const doc = load(merged);
      if (out.text !== plainText(doc.getXmlFragment('content')))
        problems.push(`${file}: cgw_to_text differs`);
      if (out.meta.schemaVersion !== 1 || out.meta.epoch !== 1 || !out.meta.pageId)
        problems.push(`${file}: meta differs: ${JSON.stringify(out.meta)}`);
      if (JSON.stringify(canon(out.ranges.ranges)) !== JSON.stringify(canon(rangesOf(merged))))
        problems.push(`${file}: client ranges differ`);
    }
    const big = JSON.parse(readFileSync(join(ROOT, 'big.json'), 'utf8'));
    const bigCompacted = new Uint8Array(readFileSync(join(ROOT, 'big-compacted.bin')));
    if (load(bigCompacted).getXmlFragment('content').toJSON() !== big.xml)
      problems.push('big: the compacted history reads differently');
    const summary = {
      documents: files.length,
      problems: problems.slice(0, 20),
      byKind: problems.reduce<Record<string, number>>((count, p) => {
        const kind = p.replace(/^S+ /, '').replace(/ at d+:.*$/, '');
        count[kind] = (count[kind] ?? 0) + 1;
        return count;
      }, {}),
      problemCount: problems.length,
      mergedBytes,
      compactedBytes,
      bigMergedBytes: big.mergedBytes,
      bigCompactedBytes: bigCompacted.byteLength,
    };
    writeFileSync(join(ROOT, 'verify-summary.json'), JSON.stringify(summary, null, 2) + '\n');
    expect(problems).toEqual([]);
  }, 600_000);
});
