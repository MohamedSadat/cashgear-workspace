// Writes schema6.json beside it: Yjs updates for the worker's schema-version 6 tests (Phase 7,
// INTEGRATIONS.md, Plugin blocks), made by plain Yjs on top of updates.json's "page" (client 1001
// wrote it). Version 6 adds a plugin block (an atom body: type, version, props).
//   node server/tests/Cgw.Tests/fixtures/make-schema6.mjs
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

/** Text a test can look for in the derived text and search, which must not hold it. */
const marker = 'Plugprop 6631';
const database = '0195f4a0-0000-7000-8000-0000000000d6';

function addPlugin(content) {
  const block = new Y.XmlElement('block');
  block.setAttribute('id', 'Pb1Pb2Pb3Pb4');
  const plugin = new Y.XmlElement('pluginBlock');
  plugin.setAttribute('type', 'cashgear.chart');
  plugin.setAttribute('version', 1);
  plugin.setAttribute(
    'props',
    JSON.stringify({ databaseId: database, viewId: null, chart: 'bar', title: marker }),
  );
  block.insert(0, [plugin]);
  content.push([block]);
}

const out = [
  {
    name: 'migrate6',
    client: 1001,
    data: b64(
      edit(1001, (content, meta) => {
        meta.set('schemaVersion', 6);
        addPlugin(content);
      }),
    ),
    why: 'the migration to version 6: meta.schemaVersion set to 6 and a plugin block, in one transaction',
  },
  {
    name: 'pluginOnly',
    client: 1001,
    data: b64(edit(1001, addPlugin)),
    why: 'a plugin block in a document still at version 1: an element versions 1 to 5 lack',
  },
  {
    name: 'claimsV7',
    client: 1001,
    data: b64(edit(1001, (_content, meta) => meta.set('schemaVersion', 7))),
    why: 'a document claiming version 7, newer than the worker knows',
  },
];
const file = join(here, 'schema6.json');
writeFileSync(
  file,
  await prettier.format(JSON.stringify(out), {
    ...(await prettier.resolveConfig(file)),
    filepath: file,
  }),
);
console.log(`Wrote ${out.length} updates to ${file}`);
