import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@cgw/workspace';
import {
  describeLocalStore,
  op,
  pageRecord,
  sectionRecord,
  workspaceRecord,
} from '@cgw/workspace/testing';
import { done, openDatabase } from './idb';
import { IndexedDbStore, upgrade } from './store';

describeLocalStore('IndexedDB', () => IndexedDbStore.open(indexedDB, `test-${uuidv7()}`));

describe('IndexedDB store migration', () => {
  it('opens a version-1 store at version 2 with its data intact', async () => {
    const name = `test-v1-${uuidv7()}`;
    const ws = workspaceRecord();
    const section = sectionRecord(ws.id);
    const page = pageRecord(ws.id, section.id, null, 'Written by version 1');
    const create = op('page.create', ws.id, page.id, page);
    const updateId = uuidv7();

    // A store as a version-1 build left it: its upgrade only, its rows as it wrote them.
    const v1 = await openDatabase(indexedDB, name, 1, (db, oldVersion, tx) =>
      upgrade(db, oldVersion, tx, 1),
    );
    expect(v1.objectStoreNames.contains('docCursors')).toBe(false);
    const tx = v1.transaction(
      ['workspaces', 'sections', 'pages', 'docLogs', 'docUpdates', 'outbox', 'meta'],
      'readwrite',
    );
    tx.objectStore('workspaces').put(ws);
    tx.objectStore('sections').put(section);
    tx.objectStore('pages').put({ ...page, parentPageId: '' });
    tx.objectStore('docLogs').put({
      pageId: page.id,
      nextSeq: 2,
      snapshot: null,
      snapshotCovers: 0,
    });
    tx.objectStore('docUpdates').put({
      pageId: page.id,
      localSeq: 1,
      updateId,
      data: new Uint8Array([1, 2, 255]),
      seq: null,
    });
    tx.objectStore('outbox').add(create);
    tx.objectStore('meta').put(1, 'schemaVersion');
    await done(tx);
    v1.close();

    const store = await IndexedDbStore.open(indexedDB, name);
    expect(await store.schemaVersion()).toBe(2);
    expect(await store.getPage(page.id)).toEqual(page);
    expect((await store.readMirror(ws.id)).sections).toEqual([section]);
    const doc = await store.loadDoc(page.id);
    expect(doc.updates).toEqual([
      { updateId, data: new Uint8Array([1, 2, 255]), localSeq: 1, seq: null },
    ]);
    // The outbox is found through the indexes version 2 added over its old rows.
    expect(await store.nextOutboxBatch(10)).toEqual([create]);
    expect(await store.nextOutboxBatch(10, ws.id)).toEqual([create]);
    // Version 1 never sent anything: once the workspace syncs, its old update is pushed.
    await store.beginUpload(ws.id, '0193a1b2-c3d4-7e5f-8a9b-000000000001', []);
    expect(await store.unsentDocUpdates(10)).toEqual([{ pageId: page.id, updates: doc.updates }]);
    // The log goes on from where version 1 left it.
    expect(
      await store.appendDocUpdates(page.id, [{ updateId: uuidv7(), data: new Uint8Array([3]) }]),
    ).toEqual([2]);
    await store.close();
  });

  it('refuses a store a newer version wrote', async () => {
    const name = `test-v9-${uuidv7()}`;
    const v9 = await openDatabase(indexedDB, name, 9, (db, oldVersion, tx) =>
      upgrade(db, oldVersion, tx),
    );
    v9.close();
    await expect(IndexedDbStore.open(indexedDB, name)).rejects.toThrow(/newer version/);
  });
});
