// Phase 8 (DECISIONS.md, 2026-11-16): what this device made and the server may not hold yet is
// written with strict durability, so "Saved", which waits for these writes, waits for the disk;
// what came from the server stays relaxed (Chrome's default), since it can be fetched again.
// CI run 43746282731 lost text the page had reported saved; the cause and what strict does and
// does not cover are in the stream's notes and scripts/idb-torn-log.mjs.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STORE_SCHEMA_VERSION, uuidv7, type AssetRecord } from '@cgw/workspace';
import { op, pageRecord, sectionRecord, workspaceRecord } from '@cgw/workspace/testing';
import { IndexedDbStore } from './store';

interface Seen {
  stores: string;
  durability: IDBTransactionDurability;
  completed: boolean;
}

let seen: Seen[] = [];
const original = IDBDatabase.prototype.transaction;

beforeEach(() => {
  seen = [];
  // Every read-write transaction the store opens, with the durability it asked for.
  IDBDatabase.prototype.transaction = function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase['transaction']>
  ) {
    const tx = original.apply(this, args);
    if (tx.mode === 'readwrite') {
      const entry: Seen = {
        stores: [...tx.objectStoreNames].sort().join(','),
        durability: tx.durability,
        completed: false,
      };
      seen.push(entry);
      tx.addEventListener('complete', () => (entry.completed = true));
    }
    return tx;
  } as IDBDatabase['transaction'];
});

afterEach(() => {
  IDBDatabase.prototype.transaction = original;
});

async function synced() {
  const store = await IndexedDbStore.open(indexedDB, `durability-${uuidv7()}`);
  const ws = { ...workspaceRecord('Synced'), localOnly: false };
  const section = sectionRecord(ws.id);
  const page = pageRecord(ws.id, section.id, null, 'Alpha');
  await store.applyLocalOps([
    op('workspace.create', ws.id, ws.id, ws),
    op('section.create', ws.id, section.id, section),
    op('page.create', ws.id, page.id, page),
  ]);
  seen = [];
  return { store, ws, page };
}

describe('durability of the store’s writes', () => {
  it("writes a page's own updates strictly, and they are complete when the write resolves", async () => {
    const { store, page } = await synced();
    const pending = store.appendDocUpdates(page.id, [
      { updateId: uuidv7(), data: new Uint8Array([1, 2, 3]) },
    ]);
    expect(seen).toEqual([
      { stores: 'docLogs,docUpdates,unsentPages', durability: 'strict', completed: false },
    ]);
    await pending;
    // What "Saved" waits for (PageDocument awaits this call) has completed, strictly.
    expect(seen).toEqual([
      { stores: 'docLogs,docUpdates,unsentPages', durability: 'strict', completed: true },
    ]);
    await store.close();
  });

  it("writes the session's own operations, an asset's bytes and a repaired log strictly", async () => {
    const { store, ws, page } = await synced();
    await store.applyLocalOps([
      op('page.update', ws.id, page.id, { title: 'Renamed' }, page.version),
    ]);
    const asset: AssetRecord = {
      id: uuidv7(),
      workspaceId: ws.id,
      fileName: 'a.png',
      contentType: 'image/png',
      sizeBytes: 1,
      sha256: 'x',
      width: 1,
      height: 1,
      createdAt: new Date().toISOString(),
    };
    await store.putAsset(asset, new Uint8Array([9]));
    await store.replaceDoc(page.id, { updateId: uuidv7(), data: new Uint8Array([4]) });
    expect(
      seen.map((s) => [s.stores.split(',').length > 10 ? 'plan' : s.stores, s.durability]),
    ).toEqual([
      ['plan', 'strict'],
      ['assetBytes,assets', 'strict'],
      ['docCursors,docLogs,docUpdates,unsentPages', 'strict'],
    ]);
    await store.close();
  });

  it('leaves what came from the server relaxed', async () => {
    const { store, page } = await synced();
    const [mine] = await store.appendDocUpdates(page.id, [
      { updateId: uuidv7(), data: new Uint8Array([1]) },
    ]);
    seen = [];
    await store.applyRemoteDocUpdates(page.id, {
      epoch: 0,
      headSeq: 2,
      updates: [{ seq: 2, updateId: uuidv7(), data: new Uint8Array([5]) }],
    });
    const rows = (await store.loadDoc(page.id)).updates;
    await store.ackDocUpdates(page.id, [{ updateId: rows[0].updateId, seq: 1 }]);
    expect(mine).toBe(1);
    expect(seen.map((s) => s.durability)).toEqual(['default', 'default']);
    expect(await store.schemaVersion()).toBe(STORE_SCHEMA_VERSION);
    await store.close();
  });
});
