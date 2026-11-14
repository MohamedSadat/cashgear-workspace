// Writes schema5.json beside it: Yjs updates for the worker's schema-version 5 tests (Phase 6
// contracts, section 2), made by plain Yjs on top of updates.json's "page" (client 1001 wrote
// it). Version 5 adds a person's mention (an inline atom: userId).
//   node server/tests/Cgw.Tests/fixtures/make-schema5.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const Y = createRequire(join(root, 'packages/doc/package.json'))('yjs');
const fixtures = JSON.parse(readFileSync(join(here, 'updates.json'), 'utf8'));
const page = Buffer.from(fixtures.find((f) => f.name === 'page').data, 'base64');
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/** An edit as `client` on top of the page. */
function edit(client, change) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, page);
  doc.clientID = client;
  const vector = Y.encodeStateVector(doc);
  doc.transact(() => change(doc.getXmlFragment('content'), doc.getMap('meta')));
  return Y.encodeStateAsUpdate(doc, vector);
}

/** An id a test can look for in the derived text, which must not hold it. */
const mentioned = '0195f4a0-0000-7000-8000-0000000000f5';

function addMention(content) {
  const block = new Y.XmlElement('block');
  block.setAttribute('id', 'Um1Um2Um3Um4');
  const body = new Y.XmlElement('textBody');
  body.setAttribute('kind', 'paragraph');
  const before = new Y.XmlText();
  before.insert(0, 'Ask ');
  const mention = new Y.XmlElement('userMention');
  mention.setAttribute('userId', mentioned);
  const after = new Y.XmlText();
  after.insert(0, ' about it');
  body.insert(0, [before, mention, after]);
  block.insert(0, [body]);
  content.push([block]);
}

const out = [
  {
    name: 'migrate5',
    client: 1001,
    data: b64(
      edit(1001, (content, meta) => {
        meta.set('schemaVersion', 5);
        addMention(content);
      }),
    ),
    why: 'the migration to version 5: meta.schemaVersion set to 5 and a person mentioned, in one transaction',
  },
  {
    name: 'mentionOnly',
    client: 1001,
    data: b64(edit(1001, addMention)),
    why: 'a mention in a document still at version 1: an element versions 1 to 4 lack',
  },
  {
    name: 'claimsV6',
    client: 1001,
    data: b64(edit(1001, (_content, meta) => meta.set('schemaVersion', 6))),
    why: 'a document claiming version 6, newer than the worker knows',
  },
];
const file = join(here, 'schema5.json');
writeFileSync(
  file,
  await prettier.format(JSON.stringify(out), {
    ...(await prettier.resolveConfig(file)),
    filepath: file,
  }),
);
console.log(`Wrote ${out.length} updates to ${file}`);
