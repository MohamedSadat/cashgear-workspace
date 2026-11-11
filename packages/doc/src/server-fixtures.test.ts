// Yjs updates the server's tests push through the real push path and worker (Phase 2: "hostile
// updates (S7's corpus) against the real push path and worker"). Made here, by Yjs itself, and
// checked on every run; `CGW_WRITE_VECTORS=1` writes them again. Each names the Yjs client id it
// writes as, so the server test can register (or not register) it to the pusher.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { writeJSON } from './binding';
import { CONTENT, META } from './document';
import { documentSchema } from './schema';

const file = join(
  __dirname,
  '..',
  '..',
  '..',
  'server',
  'tests',
  'Cgw.Tests',
  'fixtures',
  'updates.json',
);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

interface Fixture {
  name: string;
  client: number;
  data: string;
  /** What the worker does with it, pushed on top of `page`. */
  expect: 'valid' | 'rejected';
  why: string;
}

function make(): Fixture[] {
  // The page: written by client 1001, with no page id in its meta, so any page can take it.
  const base = new Y.Doc();
  base.clientID = 1001;
  base.transact(() => {
    base.getMap(META).set('schemaVersion', 1);
    base.getMap(META).set('epoch', 0);
  });
  writeJSON(base.getXmlFragment(CONTENT), documentSchema(), {
    type: 'doc',
    content: [
      {
        type: 'block',
        attrs: { id: 'Ab3dEf6hIj9L' },
        content: [
          {
            type: 'textBody',
            attrs: { kind: 'paragraph' },
            content: [{ type: 'text', text: 'Hello' }],
          },
        ],
      },
    ],
  });
  const page = Y.encodeStateAsUpdate(base);

  /** An edit on top of the page, written as `client`. */
  const edit = (client: number, change: (content: Y.XmlFragment, doc: Y.Doc) => void) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, page);
    doc.clientID = client;
    const before = Y.encodeStateVector(doc);
    doc.transact(() => change(doc.getXmlFragment(CONTENT), doc));
    return Y.encodeStateAsUpdate(doc, before);
  };
  const appendWorld = (content: Y.XmlFragment) => {
    const body = (content.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    (body.get(0) as Y.XmlText).insert(5, ' world');
  };
  const addBlock = (content: Y.XmlFragment, body: Y.XmlElement, id = 'Zz9yX8wV7uT6') => {
    const block = new Y.XmlElement('block');
    block.setAttribute('id', id);
    block.insert(0, [body]);
    content.push([block]);
  };
  const paragraph = (text: Y.XmlText) => {
    const body = new Y.XmlElement('textBody');
    body.setAttribute('kind', 'paragraph');
    body.insert(0, [text]);
    return body;
  };

  return [
    {
      name: 'page',
      client: 1001,
      data: b64(page),
      expect: 'valid',
      why: 'a new page from a registered client',
    },
    {
      name: 'edit',
      client: 1002,
      data: b64(edit(1002, appendWorld)),
      expect: 'valid',
      why: 'typing from a second registered client',
    },
    {
      name: 'forged',
      client: 999,
      data: b64(edit(999, appendWorld)),
      expect: 'rejected',
      why: 'written as a client id not registered to the pusher',
    },
    {
      name: 'unknownElement',
      client: 1001,
      data: b64(
        edit(1001, (c) => {
          const script = new Y.XmlElement('script');
          script.insert(0, [new Y.XmlText('window.__xss.push(10)')]);
          addBlock(c, script);
        }),
      ),
      expect: 'rejected',
      why: 'an element the schema lacks stops every binding syncing the page (S7)',
    },
    ...[
      'javascript:window.__xss.push(1)',
      '  JaVaScRiPt:window.__xss.push(2)',
      'data:text/html,<script>parent.__xss.push(3)</script>',
      'vbscript:msgbox(1)',
    ].map((href, i): Fixture => ({
      name: `unsafeLink${i + 1}`,
      client: 1001,
      data: b64(
        edit(1001, (c) => {
          const text = new Y.XmlText();
          text.insert(0, 'click me', { link: { href } });
          addBlock(c, paragraph(text), `Lk${i}aaaaaaaaa`);
        }),
      ),
      expect: 'rejected',
      why: 'a link with a scheme off the allow-list',
    })),
    {
      name: 'hostileAttributes',
      client: 1001,
      data: b64(
        edit(1001, (c) => {
          const image = new Y.XmlElement('image');
          image.setAttribute('assetId', '" onerror="window.__xss.push(4)');
          image.setAttribute('onerror', 'window.__xss.push(5)');
          image.setAttribute('src', 'javascript:window.__xss.push(6)');
          addBlock(c, image);
        }),
      ),
      expect: 'valid',
      why: 'attributes the schema does not know are kept by clients and drawn inert (S7); the server does not judge them',
    },
    {
      name: 'badBlockId',
      client: 1001,
      data: b64(edit(1001, (c) => addBlock(c, paragraph(new Y.XmlText('x')), 'x'))),
      expect: 'rejected',
      why: 'a block id the editor could not have minted',
    },
    {
      name: 'otherPage',
      client: 1001,
      data: b64(
        edit(1001, (_c, doc) =>
          doc.getMap(META).set('pageId', '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'),
        ),
      ),
      expect: 'rejected',
      why: 'the document names another page',
    },
    {
      name: 'newerSchema',
      client: 1001,
      data: b64(edit(1001, (_c, doc) => doc.getMap(META).set('schemaVersion', 99))),
      expect: 'rejected',
      why: 'a newer schema version would make every client open the page read-only',
    },
    {
      name: 'garbage',
      client: 1001,
      data: b64(new Uint8Array([1, 2, 3, 250, 251, 252, 253, 254, 255])),
      expect: 'rejected',
      why: 'not a Yjs update',
    },
  ];
}

describe('server fixtures', () => {
  it('are the updates Yjs makes for the server tests', () => {
    const fixtures = make();
    if (process.env.CGW_WRITE_VECTORS === '1')
      writeFileSync(file, JSON.stringify(fixtures, null, 2) + '\n');
    const kept = JSON.parse(readFileSync(file, 'utf8')) as Fixture[];
    // The bytes depend only on the client ids and the content; compare what each does.
    expect(kept.map((f) => [f.name, f.client, f.expect])).toEqual(
      fixtures.map((f) => [f.name, f.client, f.expect]),
    );
    for (const fixture of kept.filter((f) => f.name !== 'garbage')) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(kept[0].data, 'base64'));
      Y.applyUpdate(doc, Buffer.from(fixture.data, 'base64'));
      expect(doc.getXmlFragment(CONTENT).length).toBeGreaterThan(0);
    }
  });
});
