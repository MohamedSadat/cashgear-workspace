// Phase 8's server bench (Phase8Bench.cs): plain Yjs writes a page with a history and then one
// person's keystrokes into it, each keystroke an update on top of the last, as a live page pushes
// them (one update a key). Written to the file named by the first argument; the bench runs it.
//   node server/tests/Cgw.Tests/fixtures/make-typing.mjs <out.json> [blocks] [keys] [edits]
// The base page is written as clients 1001 and 1002 (a history of inserts, deletes and formats, so
// its structs are as fragmented as a page people have worked on); the typist is client 3001.
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let root = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
  const up = dirname(root);
  if (up === root) throw new Error('Run inside the repository');
  root = up;
}
const Y = createRequire(join(root, 'packages/doc/package.json'))('yjs');

const [out, blocksArg, keysArg, editsArg] = process.argv.slice(2);
if (!out) throw new Error('Name the output file');
const BLOCKS = Number(blocksArg ?? 100);
const KEYS = Number(keysArg ?? 300);
const EDITS = Number(editsArg ?? BLOCKS * 4);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** mulberry32: the same corpus on every run. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = seeded(20261116);
const pick = (list) => list[Math.floor(random() * list.length)];
const id = () => Array.from({ length: 12 }, () => pick([...DIGITS])).join('');
const WORDS = [
  'invoice',
  'budget',
  'ledger',
  'warehouse',
  'forecast',
  'quarter',
  'report',
  'customer',
];
const ARABIC = ['الفاتورة', 'الميزانية', 'المستودع', 'العميل', 'تقرير', 'الربع', 'الحساب', 'العقد'];
const sentence = (n) =>
  Array.from({ length: n }, () => pick(random() < 0.3 ? ARABIC : WORDS)).join(' ') + '. ';

const doc = new Y.Doc();
doc.clientID = 1001;
const content = doc.getXmlFragment('content');
doc.transact(() => {
  doc.getMap('meta').set('schemaVersion', 1);
  doc.getMap('meta').set('epoch', 0);
});
const texts = [];
for (let i = 0; i < BLOCKS; i++)
  doc.transact(() => {
    const block = new Y.XmlElement('block');
    block.setAttribute('id', id());
    const body = new Y.XmlElement('textBody');
    body.setAttribute('kind', i % 12 === 0 ? 'heading' : i % 5 === 0 ? 'bulletItem' : 'paragraph');
    const text = new Y.XmlText(sentence(6 + Math.floor(random() * 14)));
    body.insert(0, [text]);
    block.insert(0, [body]);
    content.push([block]);
    texts.push(text);
  });
// Work on it by two people: words put in, cut, formatted and linked.
for (let i = 0; i < EDITS; i++) {
  doc.clientID = i % 2 ? 1002 : 1001;
  const text = pick(texts);
  const roll = random();
  doc.transact(() => {
    if (roll < 0.5) text.insert(Math.floor(random() * (text.length + 1)), sentence(1));
    else if (roll < 0.75 && text.length > 12) {
      const at = Math.floor(random() * (text.length - 6));
      text.delete(at, Math.min(text.length - at, 1 + Math.floor(random() * 10)));
    } else if (roll < 0.9 && text.length > 4) {
      const at = Math.floor(random() * (text.length - 2));
      text.format(at, Math.min(text.length - at, 1 + Math.floor(random() * 12)), {
        [pick(['bold', 'italic'])]: {},
      });
    } else
      text.insert(Math.floor(random() * (text.length + 1)), 'the report', {
        link: { href: `https://example.com/report/${Math.floor(random() * 1000)}` },
      });
  });
}
const base = Y.encodeStateAsUpdate(doc);

// The typist: a block of their own at the end, then a key at a time into it.
const typist = new Y.Doc();
Y.applyUpdate(typist, base);
typist.clientID = 3001;
const typed =
  'the quick brown fox jumps over the lazy dog and the ledger balances. كتب المحاسب تقرير الربع. ';
let body = null;
const edits = [];
for (let i = 0; i < KEYS; i++) {
  const before = Y.encodeStateVector(typist);
  const ch = typed[i % typed.length];
  typist.transact(() => {
    if (!body) {
      const block = new Y.XmlElement('block');
      block.setAttribute('id', 'TypistBlock1');
      const textBody = new Y.XmlElement('textBody');
      textBody.setAttribute('kind', 'paragraph');
      body = new Y.XmlText(ch);
      textBody.insert(0, [body]);
      block.insert(0, [textBody]);
      typist.getXmlFragment('content').push([block]);
    } else body.insert(i, ch);
  });
  edits.push(Y.encodeStateAsUpdate(typist, before));
}
if (typist.store.pendingStructs) throw new Error('The typist depends on something missing');
writeFileSync(
  out,
  JSON.stringify({
    clients: [1001, 1002],
    client: 3001,
    base: b64(base),
    baseBytes: base.byteLength,
    blocks: BLOCKS,
    history: EDITS,
    edits: edits.map(b64),
    finalBytes: Y.encodeStateAsUpdate(typist).byteLength,
  }),
);
console.log(`${BLOCKS} blocks, ${EDITS} edits: ${base.byteLength} bytes; ${KEYS} keystrokes`);
