// What a page's document tells its owner: updates still pending after the retry (so the shell
// can ask the engine to check the page), updates that did not decode (set aside, the rest
// loaded), and move conflicts (moves.ts), here on plain Yjs documents; the editor's own moves
// are tested in @cgw/editor.
import { MemoryStore, uuidv7 } from '@cgw/workspace';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { fragmentToJSON, writeJSON } from './binding';
import { CONTENT, MOVES, PageDocument, newDocumentUpdate, type DocEvent } from './document';
import { build } from './index';
import { writeMoves } from './moves';
import { documentSchema } from './schema';
import { plainText } from './text';

const { docOf, paragraph, toggle } = build;

function peer(clientId: number, from?: Y.Doc) {
  const doc = new Y.Doc();
  doc.clientID = clientId;
  if (from) Y.applyUpdate(doc, Y.encodeStateAsUpdate(from));
  return doc;
}

/** The changes a document made since a state vector. */
const since = (doc: Y.Doc, sv: Uint8Array) => Y.encodeStateAsUpdate(doc, sv);

const blockAt = (doc: Y.Doc, ...path: number[]) => {
  let node = doc.getXmlFragment(CONTENT) as Y.XmlFragment | Y.XmlElement;
  for (const i of path) node = node.get(i) as Y.XmlElement;
  return node as Y.XmlElement;
};
const textOf = (block: Y.XmlElement) => (block.get(0) as Y.XmlElement).get(0) as Y.XmlText;

/**
 * A move as the binding writes one: the block deleted and a copy with its id inserted, at `to`
 * among the blocks left (clamped to the end).
 */
function moveTo(doc: Y.Doc, from: number, to: number, record = true) {
  const fragment = doc.getXmlFragment(CONTENT);
  doc.transact(() => {
    const block = fragment.get(from) as Y.XmlElement;
    const id = String(block.getAttribute('id'));
    const copy = block.clone();
    fragment.delete(from, 1);
    fragment.insert(Math.min(to, fragment.length), [copy]);
    if (record) writeMoves(doc, new Map([[id, null]]));
  });
}

async function opened(json = docOf(paragraph('zero'), paragraph('one'), paragraph('two'))) {
  const store = new MemoryStore();
  const pageId = uuidv7();
  await store.appendDocUpdates(pageId, [
    { updateId: uuidv7(), data: newDocumentUpdate(pageId, json, 500) },
  ]);
  const events: DocEvent[] = [];
  const page = await PageDocument.open(pageId, store, {
    clientId: 600,
    onEvent: (event) => events.push(event),
  });
  return { store, pageId, page, events };
}

const notices = (events: DocEvent[]) =>
  events.flatMap((e) => (e.kind === 'notice' ? [{ blockId: e.blockId, reason: e.reason }] : []));

describe('updates still pending after the retry', () => {
  it('are told when they arrive, and when a page opens with them in its log', async () => {
    const { store, pageId, page, events } = await opened();
    const other = peer(700, page.doc);
    let sv = Y.encodeStateVector(other);
    textOf(blockAt(other, 0)).insert(4, ' first');
    const first = since(other, sv);
    sv = Y.encodeStateVector(other);
    textOf(blockAt(other, 0)).insert(10, ' second');
    const second = since(other, sv);

    page.applyRemote([second]);
    expect(events).toContainEqual({ kind: 'stillPending', pageId });
    events.length = 0;
    page.applyRemote([first]);
    expect(events.filter((e) => e.kind === 'stillPending')).toEqual([]);
    expect(plainText(fragmentToJSON(page.fragment))).toContain('zero first second');
    await page.close();

    // A log that holds the second without the first: the page opens with it held back.
    const log = await store.loadDoc(pageId);
    const store2 = new MemoryStore();
    await store2.appendDocUpdates(pageId, [
      ...log.updates.slice(0, 1).map((u) => ({ updateId: uuidv7(), data: u.data })),
      { updateId: uuidv7(), data: second },
    ]);
    const seen: DocEvent[] = [];
    const again = await PageDocument.open(pageId, store2, { onEvent: (e) => seen.push(e) });
    expect(again.report.stillPending).toBe(true);
    expect(seen).toContainEqual({ kind: 'stillPending', pageId });
  });
});

describe('an update in the log that does not decode', () => {
  it('is set aside and reported, and the updates before and after it load', async () => {
    const store = new MemoryStore();
    const pageId = uuidv7();
    const doc = new Y.Doc();
    doc.clientID = 42;
    writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), docOf(paragraph('before')));
    const first = Y.encodeStateAsUpdate(doc);
    const sv = Y.encodeStateVector(doc);
    textOf(blockAt(doc, 0)).insert(6, ' and after');
    const later = since(doc, sv);
    await store.appendDocUpdates(pageId, [
      { updateId: uuidv7(), data: first },
      { updateId: uuidv7(), data: new Uint8Array([255, 1, 2, 3]) },
      { updateId: uuidv7(), data: later },
    ]);
    const events: DocEvent[] = [];
    const page = await PageDocument.open(pageId, store, { onEvent: (e) => events.push(e) });
    expect(page.report.quarantined).toBe(1);
    expect(events).toContainEqual({ kind: 'quarantined', pageId, count: 1 });
    expect(plainText(fragmentToJSON(page.fragment))).toBe('before and after');
    expect(store.corruptUpdates()).toHaveLength(1);
    expect((await store.loadDoc(pageId)).updates).toHaveLength(2);
    await page.close();
  });
});

describe('move conflicts, on plain Yjs documents', () => {
  it('a remote move of a block this device typed in, unseen: the edit is lost and told', async () => {
    const { page, events } = await opened();
    const other = peer(700, page.doc);
    const id = String(blockAt(page.doc, 1).getAttribute('id'));
    // This device types in block one; the other moves it to the end without having seen that.
    textOf(blockAt(page.doc, 1)).insert(3, ' typed here');
    const sv = Y.encodeStateVector(other);
    moveTo(other, 1, 3);
    page.applyRemote([since(other, sv)]);
    expect(notices(events)).toEqual([{ blockId: id, reason: 'editLost' }]);
    // As SYNC_DESIGN.md says: the moved block is at the end, without the edit.
    expect(plainText(fragmentToJSON(page.fragment))).toBe('zero\ntwo\none');
    expect(page.doc.getMap(MOVES).get(id)).toMatchObject({ parent: null });
  });

  it('no notice when the mover had seen the edit, and nothing was lost', async () => {
    const { page, events } = await opened();
    textOf(blockAt(page.doc, 1)).insert(3, ' typed here');
    const other = peer(700, page.doc);
    const sv = Y.encodeStateVector(other);
    moveTo(other, 1, 3);
    page.applyRemote([since(other, sv)]);
    expect(notices(events)).toEqual([]);
    expect(plainText(fragmentToJSON(page.fragment))).toBe('zero\ntwo\none typed here');
  });

  it('no notice for a delete, a different block moved, or a peer deleting my text', async () => {
    const { page, events } = await opened();
    const other = peer(700, page.doc);
    textOf(blockAt(page.doc, 1)).insert(3, ' mine');
    textOf(blockAt(page.doc, 2)).insert(3, ' also mine');
    // The peer sees my second edit, deletes it by name, moves block zero, and deletes block one
    // (which loses my first edit: the "deleted" row, not a move).
    const mine = since(page.doc, Y.encodeStateVector(other));
    const seen = peer(701);
    Y.applyUpdate(seen, Y.encodeStateAsUpdate(other));
    Y.applyUpdate(seen, mine);
    const sv = Y.encodeStateVector(seen);
    textOf(blockAt(seen, 2)).delete(3, ' also mine'.length);
    seen.getXmlFragment(CONTENT).delete(1, 1);
    const sv2 = Y.encodeStateVector(other);
    other.getXmlFragment(CONTENT).delete(1, 1);
    moveTo(other, 0, 2);
    page.applyRemote([since(seen, sv), since(other, sv2)]);
    expect(notices(events)).toEqual([]);
  });

  it('a block added inside a parent that another device moved, unseen', async () => {
    const { page, events } = await opened(
      docOf(toggle(['parent'], [paragraph('child')]), paragraph('next')),
    );
    const other = peer(700, page.doc);
    const parentId = String(blockAt(page.doc, 0).getAttribute('id'));
    // This device adds a block inside the toggle; the other moves the toggle below "next".
    page.doc.transact(() => {
      const block = new Y.XmlElement('block');
      block.setAttribute('id', 'NewChild0001');
      const body = new Y.XmlElement('textBody');
      body.insert(0, [new Y.XmlText('added here')]);
      block.insert(0, [body]);
      blockAt(page.doc, 0).insert(2, [block]);
    });
    const sv = Y.encodeStateVector(other);
    moveTo(other, 0, 2);
    page.applyRemote([since(other, sv)]);
    expect(notices(events)).toEqual([{ blockId: parentId, reason: 'editLost' }]);
  });

  it('two devices move the same block at once: it appears twice, and each is told', async () => {
    const a = await opened();
    // The second device holds the same page, opened in its own session.
    const store = new MemoryStore();
    await store.appendDocUpdates(a.pageId, [
      { updateId: uuidv7(), data: Y.encodeStateAsUpdate(a.page.doc) },
    ]);
    const seen: DocEvent[] = [];
    const b = await PageDocument.open(a.pageId, store, {
      clientId: 700,
      onEvent: (event) => seen.push(event),
    });
    const id = String(blockAt(a.page.doc, 1).getAttribute('id'));
    const svA = Y.encodeStateVector(a.page.doc);
    const svB = Y.encodeStateVector(b.doc);
    moveTo(a.page.doc, 1, 0);
    moveTo(b.doc, 1, 3);
    a.page.applyRemote([since(b.doc, svB)]);
    b.applyRemote([since(a.page.doc, svA)]);
    expect(notices(a.events)).toEqual([{ blockId: id, reason: 'movedTwice' }]);
    expect(notices(seen)).toEqual([{ blockId: id, reason: 'movedTwice' }]);
    expect(plainText(fragmentToJSON(a.page.fragment))).toBe('one\nzero\ntwo\none');
    expect(fragmentToJSON(b.fragment)).toEqual(fragmentToJSON(a.page.fragment));
  });

  it('a move made before this session (replayed from the log) is not this session’s', async () => {
    const a = await opened();
    const other = peer(700, a.page.doc);
    const svOther = Y.encodeStateVector(other);
    moveTo(other, 1, 3);
    // Another device moved a block this device never touched in this session: nothing to tell.
    a.page.applyRemote([since(other, svOther)]);
    expect(notices(a.events)).toEqual([]);
  });
});

describe('the duplicate repair, written to Yjs in place', () => {
  it('computes what the editor computes, and two devices repairing at once converge', async () => {
    const { duplicateRepairs, yjsDuplicateRepairs } = await import('./ids');
    const json = docOf(paragraph('a'), toggle(['t'], [paragraph('b')]), paragraph('c'));
    const doc = new Y.Doc();
    writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), json);
    // Make every block a copy of the first one's id.
    const id = String(blockAt(doc, 0).getAttribute('id'));
    doc.transact(() => {
      blockAt(doc, 1).setAttribute('id', id);
      blockAt(doc, 1, 1).setAttribute('id', id);
      blockAt(doc, 2).setAttribute('id', id);
    });
    const fixes = yjsDuplicateRepairs(doc.getXmlFragment(CONTENT));
    const pm = documentSchema().nodeFromJSON(fragmentToJSON(doc.getXmlFragment(CONTENT)));
    expect(fixes.map((f) => f.id)).toEqual(duplicateRepairs(pm).map((f) => f.id));
    expect(fixes).toHaveLength(3);
    // Two devices apply the same repair concurrently: the same elements, the same values.
    const other = peer(900, doc);
    const sv = Y.encodeStateVector(doc);
    const svOther = Y.encodeStateVector(other);
    for (const d of [doc, other])
      d.transact(() => {
        for (const { element, id: next } of yjsDuplicateRepairs(d.getXmlFragment(CONTENT)))
          element.setAttribute('id', next);
      });
    Y.applyUpdate(doc, since(other, svOther));
    Y.applyUpdate(other, since(doc, sv));
    const ids = (d: Y.Doc) =>
      JSON.stringify(fragmentToJSON(d.getXmlFragment(CONTENT))).match(/"id":"[^"]+"/g);
    expect(ids(doc)).toEqual(ids(other));
    expect(new Set(ids(doc)).size).toBe(4);
    expect(yjsDuplicateRepairs(doc.getXmlFragment(CONTENT))).toEqual([]);
  });
});
