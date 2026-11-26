// After 0.19.0: a page's content read from its stored log in the page out's worker is the content
// the main thread read until then (`PageDocument.open` to read, then `fragmentToJSON`).
import { readFileSync } from 'node:fs';
import { MemoryStore, uuidv7 } from '@cgw/workspace';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { build, fragmentToJSON, writeJSON } from '../index';
import { CONTENT, PageDocument } from '../document';
import { retryPending } from '../log';
import { documentSchema } from '../schema';
import { readContent } from './read';

const { docOf, heading, paragraph } = build;

describe('a page read from its stored log', () => {
  it('is what opening it to read gives: a snapshot, updates after it, one that will not apply', async () => {
    const store = new MemoryStore();
    const pageId = uuidv7();
    const doc = new Y.Doc();
    writeJSON(
      doc.getXmlFragment(CONTENT),
      documentSchema(),
      docOf(heading(1, 'Report'), paragraph('First'), paragraph('Second')),
    );
    await store.appendDocUpdates(pageId, [
      { updateId: uuidv7(), data: Y.encodeStateAsUpdate(doc) },
    ]);
    await store.compactDoc(pageId, Y.encodeStateAsUpdate(doc), 1);
    const before = Y.encodeStateVector(doc);
    doc.getXmlFragment(CONTENT).delete(1, 1);
    await store.appendDocUpdates(pageId, [
      { updateId: uuidv7(), data: Y.encodeStateAsUpdate(doc, before) },
      { updateId: uuidv7(), data: new Uint8Array([255, 1, 2, 3]) },
    ]);
    const stored = await store.loadDoc(pageId);
    expect(stored.snapshot).not.toBeNull();
    expect(stored.updates).toHaveLength(2);

    const read = readContent(stored);
    // The read writes nothing: the shell sets the bad update aside, as opening the page does.
    expect((await store.loadDoc(pageId)).updates).toHaveLength(2);
    expect(read.bad).toEqual([stored.updates[1].localSeq]);
    const page = await PageDocument.open(pageId, store, { canEdit: false });
    expect(read.content).toEqual(fragmentToJSON(page.fragment));
    await page.close();
    const words = JSON.stringify(read.content);
    expect(words).toContain('Report');
    expect(words).not.toContain('First');
    expect(words).toContain('Second');
  });

  it('heals the Yjs pending-order case as opening does (S1 fixture)', () => {
    const updates = (
      JSON.parse(
        readFileSync(
          new URL('../../../../bench/editor/fixtures/yjs-pending-order.json', import.meta.url),
          'utf8',
        ),
      ) as string[]
    ).map((b64) => new Uint8Array(Buffer.from(b64, 'base64')));
    const doc = new Y.Doc();
    for (const update of updates) Y.applyUpdate(doc, update);
    retryPending(doc);
    const read = readContent({
      snapshot: null,
      snapshotCovers: 0,
      updates: updates.map((data, i) => ({ updateId: uuidv7(), localSeq: i + 1, seq: null, data })),
    });
    expect(read.bad).toEqual([]);
    expect(read.content).toEqual(fragmentToJSON(doc.getXmlFragment(CONTENT)));
  });
});
