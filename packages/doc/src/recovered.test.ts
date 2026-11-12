// Recovered content (contracts, section 5): a set-aside log, merged and read as ProseMirror JSON
// with its block ids, ready to be a new page's first update.
import { MemoryStore, uuidv7 } from '@cgw/workspace';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { fragmentToJSON, writeJSON, type DocJSON } from './binding';
import { CONTENT, META, PageDocument, newDocumentUpdate } from './document';
import { build } from './index';
import { recoveredContent } from './recovered';
import { SCHEMA_VERSION, documentSchema } from './schema';
import { plainText } from './text';

const { docOf, paragraph, heading } = build;

const blockIdsOf = (node: DocJSON): unknown[] => [
  ...(node.type === 'block' ? [node.attrs?.id] : []),
  ...(node.content ?? []).flatMap(blockIdsOf),
];

/** A page's document at some epoch, made on one device. */
function pageAt(epoch: number, json: DocJSON, clientId: number) {
  const doc = new Y.Doc();
  doc.clientID = clientId;
  doc.getMap(META).set('epoch', epoch);
  writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), json);
  return doc;
}

/** Types into the n-th top-level block's text, as an update. */
function typeInto(doc: Y.Doc, n: number, text: string): Uint8Array {
  const sv = Y.encodeStateVector(doc);
  const block = doc.getXmlFragment(CONTENT).get(n) as Y.XmlElement;
  const body = block.get(0) as Y.XmlElement;
  const xmlText = body.get(0) as Y.XmlText;
  xmlText.insert(xmlText.length, text);
  return Y.encodeStateAsUpdate(doc, sv);
}

describe('recovered content', () => {
  it('is the old epoch with the edits made on it, ids kept, never mixed with the new epoch', () => {
    // Epoch 0, as this device held it, and the edits it made offline.
    const original = docOf(heading(1, 'Plan'), paragraph('Step one'), paragraph('Step two'));
    const device = pageAt(0, original, 101);
    const snapshot = Y.encodeStateAsUpdate(device);
    const edits = [typeInto(device, 1, ' (done)'), typeInto(device, 2, ' (next)')];
    // Meanwhile the server restored an older version as epoch 1: a different document.
    const server = pageAt(1, docOf(paragraph('Restored')), 202);
    const parts = [snapshot, ...edits];

    const recovered = recoveredContent(parts);
    expect(plainText(recovered)).toBe('Plan\nStep one (done)\nStep two (next)');
    expect(plainText(recovered)).not.toContain('Restored');
    expect(blockIdsOf(recovered)).toEqual(blockIdsOf(original));
    expect(fragmentToJSON(server.getXmlFragment(CONTENT))).not.toEqual(recovered);

    // Written as a new page: its own meta, the same blocks.
    const newPageId = uuidv7();
    const first = newDocumentUpdate(newPageId, recovered, 303);
    const page = new Y.Doc();
    Y.applyUpdate(page, first);
    expect(page.getMap(META).toJSON()).toEqual({
      schemaVersion: SCHEMA_VERSION,
      epoch: 0,
      pageId: newPageId,
    });
    expect(fragmentToJSON(page.getXmlFragment(CONTENT))).toEqual(recovered);
  });

  it('reads a log that starts with a snapshot', async () => {
    const store = new MemoryStore();
    const pageId = uuidv7();
    await store.appendDocUpdates(pageId, [
      { updateId: uuidv7(), data: newDocumentUpdate(pageId, docOf(paragraph('start'))) },
    ]);
    const page = await PageDocument.open(pageId, store, { compactAfter: 3 });
    const text = ((page.fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(
      0,
    ) as Y.XmlText;
    for (let i = 0; i < 8; i++) {
      text.insert(text.length, ` ${i}`);
      await page.flush();
    }
    await page.close();
    const log = await store.loadDoc(pageId);
    expect(log.snapshot).not.toBeNull();
    expect(log.updates.length).toBeGreaterThan(0);
    const parts = [log.snapshot!, ...log.updates.map((u) => u.data)];
    expect(recoveredContent(parts)).toEqual(fragmentToJSON(page.fragment));
    expect(plainText(recoveredContent(parts))).toBe('start 0 1 2 3 4 5 6 7');
  });

  it('leaves out a part that does not decode and recovers the rest', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const device = pageAt(0, docOf(paragraph('kept')), 7);
    const parts = [
      Y.encodeStateAsUpdate(device),
      new Uint8Array([255, 1, 2]),
      typeInto(device, 0, '!'),
    ];
    expect(plainText(recoveredContent(parts))).toBe('kept!');
    vi.restoreAllMocks();
  });

  it('gives the same content whatever order the updates come in', () => {
    const device = pageAt(0, docOf(paragraph('a'), paragraph('b')), 9);
    const first = Y.encodeStateAsUpdate(device);
    const edits = [typeInto(device, 0, '1'), typeInto(device, 1, '2'), typeInto(device, 0, '3')];
    const forward = recoveredContent([first, ...edits]);
    expect(recoveredContent([...edits].reverse().concat(first))).toEqual(forward);
    expect(plainText(forward)).toBe('a13\nb2');
    expect(recoveredContent([])).toEqual({ type: 'doc', content: [] });
  });
});
