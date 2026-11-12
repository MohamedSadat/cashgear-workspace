// Writes schema2.json beside it: Yjs updates for the worker's schema-version tests (Phase 3
// contracts, section 4), made by plain Yjs on top of updates.json's "page" (client 1001 wrote it).
// Version 2 adds one node type, tableOfContents, an atom body with no attributes.
//   node server/tests/Cgw.Tests/fixtures/make-schema2.mjs
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

/** An edit as `client` on top of the page and whatever came before it. */
function edit(client, change, ...before) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, page);
  for (const update of before) Y.applyUpdate(doc, update);
  doc.clientID = client;
  const vector = Y.encodeStateVector(doc);
  doc.transact(() => change(doc.getXmlFragment('content'), doc.getMap('meta')));
  return Y.encodeStateAsUpdate(doc, vector);
}

function addToc(content) {
  const block = new Y.XmlElement('block');
  block.setAttribute('id', 'Tc1Tc2Tc3Tc4');
  block.insert(0, [new Y.XmlElement('tableOfContents')]);
  content.push([block]);
}

const migrate = edit(1001, (content, meta) => {
  meta.set('schemaVersion', 2);
  addToc(content);
});
const afterMigration = edit(
  1002,
  (content) => {
    const body = content.get(0).get(0);
    body.get(0).insert(5, ' again');
  },
  migrate,
);

const out = [
  {
    name: 'migrate',
    client: 1001,
    data: b64(migrate),
    why: 'the migration to version 2: meta.schemaVersion set to 2 and a table of contents added, in one transaction',
  },
  {
    name: 'tocOnly',
    client: 1001,
    data: b64(edit(1001, addToc)),
    why: 'a table of contents in a document still at version 1: an element version 1 lacks',
  },
  {
    name: 'claimsV3',
    client: 1001,
    data: b64(edit(1001, (_content, meta) => meta.set('schemaVersion', 3))),
    why: 'a document claiming version 3, newer than the worker knows',
  },
  {
    name: 'afterMigration',
    client: 1002,
    data: b64(afterMigration),
    why: 'typing on the migrated page',
  },
];
const file = join(here, 'schema2.json');
writeFileSync(
  file,
  await prettier.format(JSON.stringify(out), {
    ...(await prettier.resolveConfig(file)),
    filepath: file,
  }),
);
console.log(`Wrote ${out.length} updates to ${file}`);
