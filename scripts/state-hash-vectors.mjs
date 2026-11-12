// Writes packages/doc/vectors/state-hash-vectors.json: the state hash (Phase 3 contracts, section
// 2) of a dozen documents made with plain Yjs, so the doc layer's `stateHash` and cgw-ydoc's
// `state_hash` are both held to Yjs itself. Each vector is one update (base64; several parts merged
// with Yjs's own mergeUpdates where the case has several), its canonical text and its hash, worked
// out here by a reference written straight from the contract over Yjs's own state vector and
// delete set:
//
//   v1;sv=<client>:<clock>,...;ds=<client>:<start>-<end>,...
//
// sv sorted by client (clock 0 left out); ds sorted by client then start, neighbouring and
// overlapping ranges merged, end exclusive; the hash is the lowercase hex SHA-256 of the text.
//   node scripts/state-hash-vectors.mjs           write the file
//   node scripts/state-hash-vectors.mjs --check   fail if the file is not what this writes
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Yjs as the doc layer has it (pnpm keeps it out of the root's node_modules).
const require = createRequire(join(root, 'packages/doc/package.json'));
const Y = require('yjs');
const yjsVersion = JSON.parse(
  readFileSync(join(dirname(require.resolve('yjs')), '..', 'package.json'), 'utf8'),
).version;
const out = join(root, 'packages/doc/vectors/state-hash-vectors.json');

// ------------------------------------------------------------------ the reference

/** The contract's canonical text from a state vector (client → clock) and a delete set (client → [{clock, len}]). */
function canonical(stateVector, deleteSet) {
  const sv = [...stateVector]
    .filter(([, clock]) => clock > 0)
    .sort(([a], [b]) => a - b)
    .map(([client, clock]) => `${client}:${clock}`);
  const ds = [];
  for (const client of [...deleteSet.keys()].sort((a, b) => a - b)) {
    const ranges = deleteSet
      .get(client)
      .filter((r) => r.len > 0)
      .map((r) => [r.clock, r.clock + r.len])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let current = null;
    for (const range of ranges) {
      if (current && range[0] <= current[1]) current[1] = Math.max(current[1], range[1]);
      else {
        if (current) ds.push(`${client}:${current[0]}-${current[1]}`);
        current = [...range];
      }
    }
    if (current) ds.push(`${client}:${current[0]}-${current[1]}`);
  }
  return `v1;sv=${sv.join(',')};ds=${ds.join(',')}`;
}

/** What the parts make, applied in order to a fresh document (garbage collection on, as pages are). */
function textOf(parts) {
  const doc = new Y.Doc();
  for (const part of parts) Y.applyUpdate(doc, part);
  const text = canonical(Y.decodeStateVector(Y.encodeStateVector(doc)), Y.snapshot(doc).ds.clients);
  doc.destroy();
  return text;
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// ------------------------------------------------------------------ the documents

function client(id, gc = true) {
  const doc = new Y.Doc({ gc });
  doc.clientID = id;
  return doc;
}

/** Every update a set of documents emits, in the order they happen. */
function recorder(...docs) {
  const updates = [];
  for (const doc of docs) doc.on('update', (u) => updates.push(u));
  return updates;
}

const sync = (from, to) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));

const cases = [];
const add = (name, why, parts) => cases.push({ name, why, parts });

add('empty', 'A document with nothing in it: no clients, no deletes.', [
  Y.encodeStateAsUpdate(new Y.Doc()),
]);

{
  const a = client(1);
  a.getText('t').insert(0, 'hello');
  add('one client', 'One client typed five characters: clock 5, nothing deleted.', [
    Y.encodeStateAsUpdate(a),
  ]);
}

{
  // Three people on one text, out of step and then in step; client ids out of order, one the
  // largest 32-bit id Yjs makes.
  const a = client(300);
  const b = client(7);
  const c = client(4294967295);
  a.getText('t').insert(0, 'alpha ');
  sync(a, b);
  b.getText('t').insert(6, 'beta ');
  c.getText('t').insert(0, 'gamma ');
  sync(b, c);
  sync(c, a);
  sync(a, b);
  a.getText('t').insert(0, '> ');
  sync(a, c);
  add(
    'several clients',
    'Three clients, ids not in order, one the largest 32-bit id; sorted by client.',
    [Y.encodeStateAsUpdate(c)],
  );
}

{
  const a = client(5);
  const t = a.getText('t');
  t.insert(0, 'abcdefghijklmnop');
  t.delete(1, 1); // b: clock 1
  t.delete(1, 1); // c: clock 2, next to b
  t.delete(4, 2); // g h: clocks 6 and 7, apart
  t.delete(8, 1); // m: clock 12
  t.delete(7, 1); // l: clock 11, next to m from the other side
  add(
    'deletions, neighbouring and apart',
    'Deletes made one at a time: neighbours merge into one range, others stay apart.',
    [Y.encodeStateAsUpdate(a)],
  );
}

{
  // Each client deletes what the other typed.
  const a = client(11);
  const b = client(22);
  a.getText('t').insert(0, 'aaaa');
  sync(a, b);
  b.getText('t').insert(4, 'bbbb');
  sync(b, a);
  a.getText('t').delete(5, 2); // b's clocks 1 and 2
  b.getText('t').delete(0, 1); // a's clock 0
  sync(a, b);
  sync(b, a);
  add('deletions across clients', "Each client deletes the other's text.", [
    Y.encodeStateAsUpdate(a),
  ]);
}

{
  // The same history with garbage collection on and off: the same state, the same text.
  for (const gc of [true, false]) {
    const a = client(9, gc);
    const t = a.getText('t');
    for (let i = 0; i < 40; i++) {
      t.insert(t.length, `line ${i}\n`);
      if (i % 3 === 0) t.delete(0, 4);
    }
    a.getMap('m').set('k', 1);
    a.getMap('m').set('k', 2);
    add(
      gc ? "a gc'd document" : 'the same document with deletions kept',
      gc
        ? 'Garbage collection on: deleted content is collected, its ranges stay deleted.'
        : 'Garbage collection off: the same history, so the same text and hash as the one before.',
      [Y.encodeStateAsUpdate(a)],
    );
  }
}

{
  // A page as the editor writes it: blocks with ids and attributes, text with marks, the meta map.
  const a = client(1001);
  const content = a.getXmlFragment('content');
  a.transact(() => {
    const meta = a.getMap('meta');
    meta.set('schemaVersion', 1);
    meta.set('epoch', 0);
    meta.set('pageId', '0193f0c2-7a1e-7000-8000-000000000001');
    const heading = new Y.XmlElement('block');
    heading.setAttribute('id', 'Aa0Bb1Cc2Dd3');
    heading.setAttribute('kind', 'heading');
    heading.setAttribute('level', 1);
    const title = new Y.XmlElement('textBody');
    title.insert(0, [new Y.XmlText('Plans')]);
    heading.insert(0, [title]);
    const para = new Y.XmlElement('block');
    para.setAttribute('id', 'Ee4Ff5Gg6Hh7');
    para.setAttribute('kind', 'paragraph');
    const body = new Y.XmlElement('textBody');
    const text = new Y.XmlText();
    text.insert(0, 'Bold and plain, ');
    text.format(0, 4, { bold: true });
    text.insert(16, 'مرحبا');
    body.insert(0, [text]);
    para.insert(0, [body]);
    const divider = new Y.XmlElement('divider');
    content.insert(0, [heading, para, divider]);
  });
  const b = client(1002);
  sync(a, b);
  const text = b.getXmlFragment('content').get(1).get(0).get(0);
  text.delete(5, 4); // "and "
  text.format(0, 4, { bold: null });
  text.insert(0, '* ');
  b.getXmlFragment('content').delete(2, 1);
  sync(b, a);
  add(
    'a page',
    'XML fragment "content" with blocks, text bodies, marks and Arabic, and the meta map; a second client types, unformats, deletes text and a block.',
    [Y.encodeStateAsUpdate(a)],
  );
}

{
  // Keystrokes from two clients as separate updates, merged by Yjs into one.
  const a = client(41);
  const b = client(42);
  const updates = recorder(a, b);
  a.getText('t').insert(0, 'one');
  sync(a, b);
  b.getText('t').insert(3, ' two');
  sync(b, a);
  a.getText('t').insert(0, 'zero ');
  a.getText('t').delete(5, 3);
  sync(a, b);
  const parts = updates.filter((u) => u.length > 2);
  add(
    'a merged update',
    "Each keystroke's update from two clients, merged with Y.mergeUpdates; parts are the updates in order.",
    parts,
  );
}

{
  // An update that only deletes: no structs, only a delete set.
  const a = client(61);
  const t = a.getText('t');
  t.insert(0, 'keep this, drop that');
  const base = Y.encodeStateAsUpdate(a);
  const before = Y.encodeStateVector(a);
  t.delete(11, 9);
  t.delete(0, 5);
  const deletions = Y.encodeStateAsUpdate(a, before);
  add(
    'an update with only deletions',
    'A base state, then an update with no structs and a delete set; the merged update, parts the two.',
    [base, deletions],
  );
  add(
    'deletions alone',
    'The deletions-only update by itself: what it deletes is not in the document, so nothing counts.',
    [deletions],
  );
}

{
  // Lists and maps: an array with deletes in the middle, a map key overwritten several times.
  const a = client(77);
  const list = a.getArray('list');
  list.insert(0, [1, 2, 3, 4, 5, 6, 7, 8]);
  list.delete(2, 3);
  const map = a.getMap('settings');
  for (let i = 0; i < 5; i++) map.set('theme', `theme ${i}`);
  map.set('other', { nested: [1, 2] });
  map.delete('other');
  add(
    'arrays and maps',
    'An array with a run deleted, a map key set five times (four values deleted), a key removed.',
    [Y.encodeStateAsUpdate(a)],
  );
}

{
  // Clocks past 65,535 and a range of deletes as long as most of them.
  const a = client(2147483648);
  const t = a.getText('t');
  t.insert(0, 'x'.repeat(70000));
  t.delete(100, 69000);
  add(
    'large clocks',
    'One client past clock 65,535, one long deleted range, a client id of 2^31.',
    [Y.encodeStateAsUpdate(a)],
  );
}

{
  // A gap: the first of three updates is missing, so the rest wait as pending and do not count.
  const a = client(88);
  const updates = recorder(a);
  a.getText('t').insert(0, 'first ');
  a.getText('t').insert(6, 'second ');
  a.getText('t').delete(0, 2);
  a.getText('t').insert(0, 'third ');
  add(
    'a gap',
    'Updates 2 to 4 of one client without the first, merged (Yjs writes a skip): nothing is integrated.',
    updates.slice(1),
  );
}

// ------------------------------------------------------------------ the file

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const vectors = cases.map(({ name, why, parts }) => {
  const update = parts.length === 1 ? parts[0] : Y.mergeUpdates(parts);
  const text = textOf([update]);
  // The parts applied one by one make the same state as the merged update (except a gap, where
  // Yjs keeps different pending structs but integrates the same nothing).
  const fromParts = textOf(parts);
  if (fromParts !== text)
    throw new Error(`${name}: the parts give ${fromParts}, the merged update ${text}`);
  const vector = { name, why, update: b64(update) };
  if (parts.length > 1) vector.parts = parts.map(b64);
  return { ...vector, text, hash: sha256(text) };
});
const texts = new Map();
for (const v of vectors) texts.set(v.text, [...(texts.get(v.text) ?? []), v.name]);
const same = texts.get(vectors.find((v) => v.name === "a gc'd document").text);
if (same.length !== 2) throw new Error('The gc on and off documents should share their text');

const file = {
  about:
    'State-hash vectors (Phase 3 contracts, section 2), written by scripts/state-hash-vectors.mjs with plain Yjs; read by packages/doc (stateHash) and crates/cgw-ydoc (state_hash). Do not edit by hand.',
  yjs: yjsVersion,
  vectors,
};
// As Prettier keeps it (pnpm format:check reads the file too).
const json = await prettier.format(JSON.stringify(file), {
  ...(await prettier.resolveConfig(out)),
  filepath: out,
});
if (process.argv.includes('--check')) {
  if (readFileSync(out, 'utf8').replace(/\r\n/g, '\n') !== json) {
    console.error(`${out} is not what scripts/state-hash-vectors.mjs writes: run it again.`);
    process.exit(1);
  }
  console.log(`${vectors.length} vectors, unchanged.`);
} else {
  writeFileSync(out, json);
  console.log(`Wrote ${vectors.length} vectors to ${out}`);
  for (const v of vectors)
    console.log(`  ${v.name}: ${v.text.length > 90 ? v.text.slice(0, 87) + '...' : v.text}`);
}
