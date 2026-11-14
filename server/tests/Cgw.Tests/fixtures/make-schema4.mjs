// Writes schema4.json beside it: Yjs updates for the worker's schema-version 4 tests (Phase 5
// contracts, section 1), made by plain Yjs on top of updates.json's "page" (client 1001 wrote
// it). Version 4 adds a workbook embed (an atom body: workbookId, sheet, range, chartId, height)
// and an ERP view (an atom body: linkId, connectorId, filter, fields, sort, pageSize).
//   node server/tests/Cgw.Tests/fixtures/make-schema4.mjs
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

function addBlock(content, id, name, attrs) {
  const block = new Y.XmlElement('block');
  block.setAttribute('id', id);
  const body = new Y.XmlElement(name);
  for (const [key, value] of Object.entries(attrs)) body.setAttribute(key, value);
  block.insert(0, [body]);
  content.push([block]);
}

// Values a test can look for in the derived text, which must hold none of them.
const addEmbed = (content) =>
  addBlock(content, 'Se1Se2Se3Se4', 'sheetEmbed', {
    workbookId: '0195f4a0-0000-7000-8000-0000000000e1',
    sheet: 'Embedded Sheet 4417',
    range: 'A1:D20',
    chartId: null,
    height: 320,
  });
const addErp = (content) =>
  addBlock(content, 'Ev1Ev2Ev3Ev4', 'erpView', {
    linkId: '0195f4a0-0000-7000-8000-0000000000e2',
    connectorId: 'vendors',
    filter: '{"search":"Erp Filter 5521"}',
    fields: '["code","name"]',
    sort: '[{"field":"name","direction":"asc"}]',
    pageSize: 25,
  });

const out = [
  {
    name: 'migrate4',
    client: 1001,
    data: b64(
      edit(1001, (content, meta) => {
        meta.set('schemaVersion', 4);
        addEmbed(content);
        addErp(content);
      }),
    ),
    why: 'the migration to version 4: meta.schemaVersion set to 4, a workbook embed and an ERP view added, in one transaction',
  },
  {
    name: 'embedOnly',
    client: 1001,
    data: b64(edit(1001, addEmbed)),
    why: 'a workbook embed in a document still at version 1: an element versions 1 to 3 lack',
  },
  {
    name: 'erpOnly',
    client: 1001,
    data: b64(edit(1001, addErp)),
    why: 'an ERP view in a document still at version 1',
  },
  {
    name: 'claimsV5',
    client: 1001,
    data: b64(edit(1001, (_content, meta) => meta.set('schemaVersion', 5))),
    why: 'a document claiming version 5, newer than the worker knows',
  },
];
const file = join(here, 'schema4.json');
writeFileSync(
  file,
  await prettier.format(JSON.stringify(out), {
    ...(await prettier.resolveConfig(file)),
    filepath: file,
  }),
);
console.log(`Wrote ${out.length} updates to ${file}`);
