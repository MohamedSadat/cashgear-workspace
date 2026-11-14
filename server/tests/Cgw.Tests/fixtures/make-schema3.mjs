// Writes schema3.json beside it: Yjs updates for the worker's schema-version 3 tests (Phase 4
// contracts, sections 4 and 5), made by plain Yjs on top of updates.json's "page" (client 1001
// wrote it). Version 3 adds a database view (an atom body: databaseId, viewId) and a date mention
// (an inline atom: date, end).
//   node server/tests/Cgw.Tests/fixtures/make-schema3.mjs
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

function addView(content) {
  const block = new Y.XmlElement('block');
  block.setAttribute('id', 'Dv1Dv2Dv3Dv4');
  const view = new Y.XmlElement('databaseView');
  view.setAttribute('databaseId', '0195f4a0-0000-7000-8000-000000000001');
  view.setAttribute('viewId', null);
  block.insert(0, [view]);
  content.push([block]);
}

function addDate(content) {
  const block = new Y.XmlElement('block');
  block.setAttribute('id', 'Dm1Dm2Dm3Dm4');
  const body = new Y.XmlElement('textBody');
  body.setAttribute('kind', 'paragraph');
  const text = new Y.XmlText();
  text.insert(0, 'Due ');
  const mention = new Y.XmlElement('dateMention');
  mention.setAttribute('date', '2026-11-13');
  mention.setAttribute('end', null);
  body.insert(0, [text, mention]);
  block.insert(0, [body]);
  content.push([block]);
}

const out = [
  {
    name: 'migrate3',
    client: 1001,
    data: b64(
      edit(1001, (content, meta) => {
        meta.set('schemaVersion', 3);
        addView(content);
        addDate(content);
      }),
    ),
    why: 'the migration to version 3: meta.schemaVersion set to 3, a database view and a date mention added, in one transaction',
  },
  {
    name: 'viewOnly',
    client: 1001,
    data: b64(edit(1001, addView)),
    why: 'a database view in a document still at version 1: an element versions 1 and 2 lack',
  },
  {
    name: 'dateOnly',
    client: 1001,
    data: b64(edit(1001, addDate)),
    why: 'a date mention in a document still at version 1',
  },
  {
    name: 'claimsV4',
    client: 1001,
    data: b64(edit(1001, (_content, meta) => meta.set('schemaVersion', 4))),
    why: 'a document claiming version 4, newer than a version-3 app or worker knows',
  },
];
const file = join(here, 'schema3.json');
writeFileSync(
  file,
  await prettier.format(JSON.stringify(out), {
    ...(await prettier.resolveConfig(file)),
    filepath: file,
  }),
);
console.log(`Wrote ${out.length} updates to ${file}`);
