// Spike S3, step 1: a corpus of documents written by Yjs 13 for cgw-ydoc to process. Runs only
// with S3=1 (`pnpm bench:s3` runs all three steps).
//   S3_DOCS (default 1000): fuzzed documents, each the updates of two or three editors
//   S3_BIG_BYTES (default 1 MiB): the size of the long edit history used to time compaction
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { installDom } from './dom';

installDom();
const { runFuzz } = await import('./fuzz');
const { stampVersion } = await import('./gate');
const { seeded } = await import('./commands');

const DOCS = Number(process.env.S3_DOCS ?? 1000);
const BIG = Number(process.env.S3_BIG_BYTES ?? 1024 * 1024);
const OUT = 'bench/results/s3/corpus';
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

describe.skipIf(!process.env.S3)('S3 corpus', () => {
  it(`writes ${DOCS} fuzzed documents`, () => {
    mkdirSync(OUT, { recursive: true });
    for (let n = 0; n < DOCS; n++) {
      const result = runFuzz({
        seed: 1_000_003 * (n + 1),
        clients: 2 + (n % 2),
        ops: 20 + (n % 7) * 25,
        binding: 'tiptap-ids',
        schema: { content: n % 2 ? 'mixed' : 'ordered', bodies: 'kind' },
        collect: true,
        prepare: (doc) => {
          stampVersion(doc, 1);
          doc.getMap('meta').set('epoch', 1);
          doc.getMap('meta').set('pageId', `page-${n}`);
        },
      });
      expect(result.failures).toEqual([]);
      const { updates, xml, json } = result.collected!;
      writeFileSync(
        join(OUT, `${String(n).padStart(4, '0')}.json`),
        JSON.stringify({ updates: updates.map(b64), xml, json }),
      );
    }
  }, 1_800_000);

  it('writes a long edit history of about 1 MB', () => {
    const doc = new Y.Doc();
    const content = doc.getXmlFragment('content');
    const random = seeded(42);
    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));
    doc.transact(() => {
      for (let i = 0; i < 200; i++) {
        const block = new Y.XmlElement('block');
        block.setAttribute('id', `blk${String(i).padStart(9, '0')}`);
        const body = new Y.XmlElement('textBody');
        body.setAttribute('kind', 'paragraph');
        body.insert(0, [new Y.XmlText('')]);
        block.insert(0, [body]);
        content.push([block]);
      }
    });
    const texts = content
      .toArray()
      .map((block) => ((block as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText);
    // Edits until the merged update itself passes the target size.
    let merged: Uint8Array = new Uint8Array();
    while (merged.byteLength < BIG) {
      for (let step = 0; step < 2000; step++) {
        const text = texts[Math.floor(random() * texts.length)];
        doc.transact(() => {
          const at = Math.floor(random() * (text.length + 1));
          text.insert(at, 'abcdefghij كلمة عربية '.slice(0, 1 + Math.floor(random() * 20)));
          if (text.length > 120) text.delete(Math.floor(random() * 60), 30);
          if (random() < 0.1) text.format(0, Math.min(5, text.length), { bold: {} });
        });
      }
      merged = Y.mergeUpdates(updates);
    }
    mkdirSync('bench/results/s3', { recursive: true });
    writeFileSync('bench/results/s3/big.bin', merged);
    writeFileSync(
      'bench/results/s3/big.json',
      JSON.stringify({
        updates: updates.length,
        mergedBytes: merged.byteLength,
        xml: content.toJSON(),
      }),
    );
    expect(merged.byteLength).toBeGreaterThanOrEqual(BIG);
  }, 600_000);

  it('writes a page of about 1 MB of content with an ordinary history', () => {
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    const content = doc.getXmlFragment('content');
    const words = [
      'Cash',
      'Gear',
      'workspace',
      'المخزون',
      'الفاتورة',
      'report',
      'quarter',
      'العميل',
    ];
    let size = 0;
    let n = 0;
    while (size < BIG) {
      // One block per transaction, typed in bursts and edited once, as a page is written.
      doc.transact(() => {
        const block = new Y.XmlElement('block');
        block.setAttribute('id', `b${String(n++).padStart(11, '0')}`);
        const body = new Y.XmlElement('textBody');
        body.setAttribute('kind', n % 7 === 0 ? 'heading' : 'paragraph');
        const text = new Y.XmlText('');
        body.insert(0, [text]);
        block.insert(0, [body]);
        content.push([block]);
        for (let burst = 0; burst < 4; burst++) {
          let line = '';
          for (let w = 0; w < 12; w++) line += words[(n * 7 + w * 3 + burst) % words.length] + ' ';
          text.insert(text.length, line);
        }
        text.format(0, 4, { bold: {} });
        text.delete(10, 5);
      });
      size = updates.reduce((sum, u) => sum + u.byteLength, 0);
    }
    writeFileSync('bench/results/s3/content.bin', Y.mergeUpdates(updates));
  }, 600_000);
});
