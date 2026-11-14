// Writes mentions.json beside it: Yjs updates holding userMention nodes (Phase 6 contracts,
// section 5) for the worker's mention pass, made by plain Yjs on top of updates.json's "page"
// (client 1001 wrote it). The people are placeholders of a UUID's length, which a test swaps for
// real ids in the bytes (a Yjs string is its length and its UTF-8, so the update stays whole).
//   node server/tests/Cgw.Tests/fixtures/make-mentions.mjs
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

/** The placeholders a test replaces: A and B are people to notify or not, O the one who writes. */
export const people = {
  a: '00000000-0000-7000-8000-00000000000a',
  b: '00000000-0000-7000-8000-00000000000b',
  o: '00000000-0000-7000-8000-00000000000c',
};

/** An edit as `client` on top of `base`. */
function edit(base, client, change) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, base);
  doc.clientID = client;
  const vector = Y.encodeStateVector(doc);
  doc.transact(() => change(doc.getXmlFragment('content'), doc.getMap('meta')));
  return Y.encodeStateAsUpdate(doc, vector);
}

/** A paragraph block of text and mentions: a string is text, `{ user }` a mention. */
function addParagraph(content, id, parts) {
  const block = new Y.XmlElement('block');
  block.setAttribute('id', id);
  const body = new Y.XmlElement('textBody');
  body.setAttribute('kind', 'paragraph');
  body.insert(
    0,
    parts.map((part) => {
      if (typeof part === 'string') {
        const text = new Y.XmlText();
        text.insert(0, part);
        return text;
      }
      const mention = new Y.XmlElement('userMention');
      mention.setAttribute('userId', part.user);
      return mention;
    }),
  );
  block.insert(0, [body]);
  content.push([block]);
}

const first = edit(page, 1001, (content, meta) => {
  meta.set('schemaVersion', 5);
  addParagraph(content, 'Mn1Mn2Mn3Mn4', [
    'Look at this, ',
    { user: people.a },
    ' and ',
    { user: people.b },
    ', from ',
    { user: people.o },
  ]);
});
const doc = new Y.Doc();
Y.applyUpdate(doc, page);
Y.applyUpdate(doc, first);
const second = edit(Y.encodeStateAsUpdate(doc), 1001, (content) =>
  addParagraph(content, 'Mn5Mn6Mn7Mn8', ['Also for ', { user: people.a }]),
);

const out = [
  {
    name: 'mentions',
    client: 1001,
    data: b64(first),
    why: 'a block mentioning a, b and o (the writer), raising the document to version 5',
  },
  {
    name: 'mentionAgain',
    client: 1001,
    data: b64(second),
    why: 'on top of mentions: a second block mentioning a again',
  },
];
const file = join(here, 'mentions.json');
writeFileSync(
  file,
  await prettier.format(JSON.stringify({ people, updates: out }), {
    ...(await prettier.resolveConfig(file)),
    filepath: file,
  }),
);
console.log(`Wrote ${out.length} updates to ${file}`);
