// Phase 2's server benchmarks (bench/phase2.mjs), step 1: Yjs 13 writes the updates the server
// benchmarks push (server/tests/Cgw.Tests/Phase2Bench.cs). Runs only when PHASE2_CORPUS names the
// output folder, so `pnpm test` skips it. Every file starts from the same base page, written as
// client 1001 with no page id in its meta, so any page can take it (as server-fixtures.test.ts).
//   push.json         keystrokes from one client on the base page: push round trips, pulls of 200
//   compaction.json   a document of about PHASE2_BIG_BYTES (1 MiB) in its updates, each the
//                     batch of edits an autosave would send, with deletes and formats to collect
//   load.json         PHASE2_LOAD_USERS (200) typists, each with its own client id and block and a
//                     chain of PHASE2_LOAD_EDITS (320) keystrokes that depends only on the base
//                     page and its own earlier edits, so any interleaving with the others is valid
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { BLOCK_ID, CONTENT, META, documentSchema, writeJSON } from '@cgw/doc';

const OUT = process.env.PHASE2_CORPUS ? resolve(process.env.PHASE2_CORPUS) : '';
const BIG = Number(process.env.PHASE2_BIG_BYTES ?? 1024 * 1024);
const USERS = Number(process.env.PHASE2_LOAD_USERS ?? 200);
const LOAD_EDITS = Number(process.env.PHASE2_LOAD_EDITS ?? 320);
const PUSH_EDITS = Number(process.env.PHASE2_PUSH_EDITS ?? 400);

const BASE_CLIENT = 1001;
const PUSH_CLIENT = 3001;
const BIG_CLIENT = 4001;
/** Load users write as 5,000,001 and up: unique in every workspace. */
const LOAD_CLIENT = 5_000_001;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** mulberry32: the same corpus on every run. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'invoice',
  'budget',
  'ledger',
  'warehouse',
  'forecast',
  'quarter',
  'report',
  'customer',
  'الفاتورة',
  'الميزانية',
  'المستودع',
  'العميل',
  'تقرير',
  'الربع',
  'الحساب',
  'العقد',
];

/** The page every corpus starts from: a heading, paragraphs and a list, as a short real page. */
function basePage(): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = BASE_CLIENT;
  doc.transact(() => {
    doc.getMap(META).set('schemaVersion', 1);
    doc.getMap(META).set('epoch', 0);
  });
  const block = (id: string, kind: string, text: string) => ({
    type: 'block',
    attrs: { id },
    content: [{ type: 'textBody', attrs: { kind }, content: [{ type: 'text', text }] }],
  });
  writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), {
    type: 'doc',
    content: [
      block('BaseHeading1', 'heading', 'Quarterly review / المراجعة الربعية'),
      block(
        'BasePara0001',
        'paragraph',
        'Notes for the quarter: invoices, the budget and the warehouse forecast.',
      ),
      block('BasePara0002', 'paragraph', 'ملاحظات الربع: الفواتير والميزانية وتوقعات المستودع.'),
      block('BaseItem0001', 'bulletItem', 'Close the ledger'),
      block('BaseItem0002', 'bulletItem', 'مراجعة العقود'),
    ],
  });
  return Y.encodeStateAsUpdate(doc);
}

function docOn(base: Uint8Array, client: number) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, base);
  doc.clientID = client;
  return doc;
}

/** The text a typist types: English or Arabic sentences, one UTF-16 unit per keystroke. */
function typed(user: number, length: number): string {
  const english = 'the quick brown fox jumps over the lazy dog and the ledger balances. ';
  const arabic = 'كتب المحاسب تقرير الربع وراجع الفواتير والعقود مع العميل. ';
  let text = `${user}: `;
  while (text.length < length) text += user % 2 ? arabic : english;
  return text.slice(0, length);
}

/** Keystrokes into a new block of the typist's own, each one an update on top of the last. */
function keystrokes(base: Uint8Array, client: number, blockId: string, text: string) {
  const doc = docOn(base, client);
  const content = doc.getXmlFragment(CONTENT);
  let body: Y.XmlText | null = null;
  const edits: Uint8Array[] = [];
  for (let i = 0; i < text.length; i++) {
    const before = Y.encodeStateVector(doc);
    doc.transact(() => {
      if (!body) {
        const block = new Y.XmlElement('block');
        block.setAttribute('id', blockId);
        const textBody = new Y.XmlElement('textBody');
        textBody.setAttribute('kind', 'paragraph');
        body = new Y.XmlText(text[i]);
        textBody.insert(0, [body]);
        block.insert(0, [textBody]);
        content.push([block]);
      } else body.insert(i, text[i]);
    });
    edits.push(Y.encodeStateAsUpdate(doc, before));
  }
  return edits;
}

/** A long history: blocks written, typed into, cut, formatted and removed, sent in autosave-sized batches. */
function bigHistory(base: Uint8Array) {
  const random = seeded(20261112);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const doc = docOn(base, BIG_CLIENT);
  const content = doc.getXmlFragment(CONTENT);
  const id = () => Array.from({ length: 12 }, () => pick([...DIGITS])).join('');
  const sentence = (words: number) =>
    Array.from({ length: words }, () => pick(WORDS)).join(' ') + '. ';
  const texts = () =>
    content
      .toArray()
      .map((block) => (block as Y.XmlElement).get(0))
      .filter((body): body is Y.XmlElement => body instanceof Y.XmlElement)
      .map((body) => body.get(0))
      .filter((text): text is Y.XmlText => text instanceof Y.XmlText);
  const edit = () => {
    const roll = random();
    const all = texts();
    const text = all.length ? pick(all) : null;
    if (roll < 0.3 || !text) {
      const block = new Y.XmlElement('block');
      block.setAttribute('id', id());
      const body = new Y.XmlElement('textBody');
      body.setAttribute(
        'kind',
        pick(['paragraph', 'paragraph', 'heading', 'bulletItem', 'numberedItem', 'quote']),
      );
      body.insert(0, [new Y.XmlText(sentence(5 + Math.floor(random() * 40)))]);
      block.insert(0, [body]);
      content.insert(Math.floor(random() * (content.length + 1)), [block]);
    } else if (roll < 0.65) {
      text.insert(Math.floor(random() * (text.length + 1)), sentence(1 + Math.floor(random() * 4)));
    } else if (roll < 0.8 && text.length > 10) {
      const at = Math.floor(random() * (text.length - 5));
      text.delete(at, Math.min(text.length - at, 1 + Math.floor(random() * 30)));
    } else if (roll < 0.9 && text.length > 4) {
      const at = Math.floor(random() * (text.length - 2));
      text.format(at, Math.min(text.length - at, 1 + Math.floor(random() * 20)), {
        [pick(['bold', 'italic', 'code'])]: {},
      });
    } else if (roll < 0.95) {
      text.insert(Math.floor(random() * (text.length + 1)), 'the report', {
        link: { href: `https://example.com/report/${Math.floor(random() * 1000)}` },
      });
    } else if (content.length > 20) {
      content.delete(Math.floor(random() * content.length), 1);
    }
  };
  const updates: Uint8Array[] = [];
  let batch: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => batch.push(update));
  let total = 0;
  while (total < BIG) {
    while (batch.reduce((sum, u) => sum + u.byteLength, 0) < 4096) doc.transact(edit);
    const update = Y.mergeUpdates(batch);
    batch = [];
    updates.push(update);
    total += update.byteLength;
  }
  const ids = content.toArray().map((block) => (block as Y.XmlElement).getAttribute('id'));
  return { updates, total, merged: Y.mergeUpdates([base, ...updates]), ids };
}

describe.skipIf(!OUT)('Phase 2 corpus', () => {
  it('writes the push, compaction and load-test updates', () => {
    mkdirSync(OUT, { recursive: true });
    const base = basePage();

    const push = keystrokes(base, PUSH_CLIENT, 'PushTyping01', typed(0, PUSH_EDITS));
    writeFileSync(
      join(OUT, 'push.json'),
      JSON.stringify({
        baseClient: BASE_CLIENT,
        client: PUSH_CLIENT,
        base: b64(base),
        edits: push.map(b64),
      }),
    );

    const big = bigHistory(base);
    expect(big.ids.every((id) => typeof id === 'string' && BLOCK_ID.test(id))).toBe(true);
    writeFileSync(
      join(OUT, 'compaction.json'),
      JSON.stringify({
        baseClient: BASE_CLIENT,
        client: BIG_CLIENT,
        base: b64(base),
        updates: big.updates.map(b64),
        updateBytes: big.total,
        mergedBytes: big.merged.byteLength,
      }),
    );

    const users = Array.from({ length: USERS }, (_, n) => {
      const text = typed(n + 1, LOAD_EDITS);
      const blockId = `LoadUser${String(n + 1).padStart(4, '0')}`;
      expect(blockId).toMatch(BLOCK_ID);
      const edits = keystrokes(base, LOAD_CLIENT + n, blockId, text);
      return {
        client: LOAD_CLIENT + n,
        blockId,
        text,
        edits: edits.map(b64),
        // Where each keystroke ends in the typist's clock (exclusive, as a state vector counts):
        // the benchmark tells from it whether a snapshot holds the keystroke.
        ends: edits.map((edit) =>
          Math.max(
            ...Y.decodeUpdate(edit)
              .structs.filter((s) => s.id.client === LOAD_CLIENT + n)
              .map((s) => s.id.clock + s.length),
          ),
        ),
      };
    });
    writeFileSync(
      join(OUT, 'load.json'),
      JSON.stringify({ baseClient: BASE_CLIENT, base: b64(base), users }),
    );

    // Any interleaving of the typists' chains is valid: here, all of them in reverse order.
    const check = new Y.Doc();
    Y.applyUpdate(check, base);
    for (const user of [...users].reverse())
      for (const edit of [...user.edits].reverse())
        Y.applyUpdate(check, Buffer.from(edit, 'base64'));
    expect(check.store.pendingStructs).toBeNull();
    expect(check.getXmlFragment(CONTENT).length).toBe(5 + USERS);
    console.log(
      `push: ${push.length} keystrokes; compaction: ${big.updates.length} updates, ${big.total} bytes (${big.merged.byteLength} merged); load: ${USERS} users x ${LOAD_EDITS} keystrokes`,
    );
  }, 600_000);
});
