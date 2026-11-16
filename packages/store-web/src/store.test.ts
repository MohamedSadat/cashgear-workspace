import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  STORE_SCHEMA_VERSION,
  uuidv7,
  type AssetRecord,
  type HistoryEntry,
  type Operation,
  type PinRecord,
  type QuarantineEntry,
  type RepairState,
} from '@cgw/workspace';
import {
  describeLocalStore,
  op,
  pageRecord,
  sectionRecord,
  workspaceRecord,
} from '@cgw/workspace/testing';
import { done, getAll, openDatabase, request } from './idb';
import { IndexedDbStore, upgrade } from './store';

describeLocalStore('IndexedDB', () => IndexedDbStore.open(indexedDB, `test-${uuidv7()}`));

const ACCOUNT = '0193a1b2-c3d4-7e5f-8a9b-000000000001';
const bytes = (...values: number[]) => new Uint8Array(values);

/** Opens a database at the version it has, with no upgrade: to look at what a store holds. */
const peek = (name: string) => openDatabase(indexedDB, name, undefined, () => {});

/**
 * A workspace as an earlier build left it: its records, a page under another, one in the trash,
 * a favourite, a visit, an asset with its bytes, a document log with a snapshot and later updates,
 * an update in the corrupt area, local history, the outbox, search entries and preferences.
 * `synced` makes it a synced workspace's (version 2): acknowledged and pulled updates, cursors.
 */
function fixture(synced: boolean) {
  const ws = {
    ...workspaceRecord('Old'),
    ...(synced ? { localOnly: false, accountId: ACCOUNT } : {}),
  };
  const section = sectionRecord(ws.id);
  const other = sectionRecord(ws.id, 'Private', 'a1');
  const a = pageRecord(ws.id, section.id, null, 'Alpha');
  const b = pageRecord(ws.id, section.id, a.id, 'Beta');
  const trashed = {
    ...pageRecord(ws.id, other.id, null, 'Old trash'),
    trashedAt: '2026-01-01T00:00:00.000Z',
  };
  trashed.trashRootId = trashed.id;
  // Only a snapshot: everything it covered was dropped.
  const c = pageRecord(ws.id, other.id, null, 'Gamma', 'a1');
  const favourite = { workspaceId: ws.id, pageId: a.id, orderKey: 'a0' };
  const visit = { workspaceId: ws.id, pageId: b.id, lastVisitedAt: '2026-02-01T00:00:00.000Z' };
  const asset: AssetRecord = {
    id: uuidv7(),
    workspaceId: ws.id,
    fileName: 'تقرير.png',
    contentType: 'image/png',
    sizeBytes: 3,
    sha256: 'abc',
    width: 1,
    height: 1,
    createdAt: '2026-02-01T00:00:00.000Z',
    ...(synced ? { uploaded: false } : {}),
  };
  const history: HistoryEntry = {
    id: uuidv7(),
    pageId: a.id,
    createdAt: '2026-02-02T00:00:00.000Z',
    sizeBytes: 2,
  };
  const outbox: Operation[] = [op('page.update', ws.id, a.id, { title: 'Alpha' }, 1)];
  // a: a snapshot covering local 1, then 2 (sent, if synced), 3 (unsent), 4 (pulled, if synced).
  const updates = [
    {
      pageId: a.id,
      localSeq: 2,
      updateId: uuidv7(),
      data: bytes(2, 0, 255),
      seq: synced ? 7 : null,
    },
    { pageId: a.id, localSeq: 3, updateId: uuidv7(), data: bytes(3), seq: null },
    ...(synced ? [{ pageId: a.id, localSeq: 4, updateId: uuidv7(), data: bytes(4), seq: 8 }] : []),
    { pageId: b.id, localSeq: 1, updateId: uuidv7(), data: bytes(1), seq: null },
  ];
  const corrupt = {
    pageId: b.id,
    localSeq: 2,
    updateId: uuidv7(),
    data: bytes(0xde, 0xad),
    seq: null,
    reason: 'doc.undecodable',
    at: '2026-02-03T00:00:00.000Z',
  };
  const logs = [
    { pageId: a.id, nextSeq: synced ? 5 : 4, snapshot: bytes(9, 9, 9), snapshotCovers: 1 },
    { pageId: b.id, nextSeq: 3, snapshot: null, snapshotCovers: 0 },
    { pageId: c.id, nextSeq: 4, snapshot: bytes(5, 5), snapshotCovers: 3 },
  ];
  const search = [
    { pageId: a.id, workspaceId: ws.id, title: 'alpha', text: 'quarterly report' },
    { pageId: b.id, workspaceId: ws.id, title: 'beta', text: 'تقرير المبيعات' },
  ];

  // Version 3 (offline): a pin, a set-aside log and a repair state.
  const pin: PinRecord = {
    workspaceId: ws.id,
    pageId: b.id,
    subtree: true,
    pinnedAt: '2026-03-01T00:00:00.000Z',
  };
  const entry: QuarantineEntry = {
    id: uuidv7(),
    workspaceId: ws.id,
    pageId: c.id,
    title: 'Gamma',
    reason: 'doc.epochMismatch',
    at: '2026-03-02T00:00:00.000Z',
    parts: [bytes(5, 5), bytes(6)],
    status: 'pending',
    recoveredPageId: null,
  };
  const repair: RepairState = {
    pageId: a.id,
    epoch: 1,
    checkedSeq: 8,
    at: '2026-03-03T00:00:00.000Z',
    repairs: 0,
  };

  /** Writes the rows as that version did, into a database its own upgrade made. */
  async function write(db: IDBDatabase, version: number) {
    const names = [
      'workspaces',
      'sections',
      'pages',
      'favourites',
      'visits',
      'assets',
      'assetBytes',
      'docLogs',
      'docUpdates',
      'corrupt',
      'history',
      'historyBytes',
      'outbox',
      'search',
      'prefs',
      'meta',
      ...(synced ? ['syncCursors', 'docCursors', 'unsentPages'] : []),
      ...(version >= 3 ? ['pins', 'quarantine', 'repairs'] : []),
    ];
    const tx = db.transaction(names, 'readwrite');
    const put = (name: string, value: unknown, key?: IDBValidKey) =>
      tx.objectStore(name).put(value, key);
    put('workspaces', ws);
    for (const s of [section, other]) put('sections', s);
    // Version 1 and 2 kept a top-level page with an empty parent key.
    for (const p of [a, b, trashed, c]) put('pages', { ...p, parentPageId: p.parentPageId ?? '' });
    put('favourites', favourite);
    put('visits', visit);
    put('assets', asset);
    put('assetBytes', bytes(137, 80, 0), asset.id);
    for (const log of logs) put('docLogs', log);
    for (const update of updates) put('docUpdates', update);
    tx.objectStore('corrupt').add(corrupt);
    put('history', history);
    put('historyBytes', bytes(8, 8), history.id);
    for (const o of outbox) tx.objectStore('outbox').add(o);
    for (const entry of search) put('search', entry);
    put('prefs', { [a.id]: true }, 'toggles');
    put('meta', version, 'schemaVersion');
    if (synced) {
      put('syncCursors', { workspaceId: ws.id, cursor: 42 });
      put('docCursors', { pageId: a.id, headSeq: 8, epoch: 1 });
      put('unsentPages', { pageId: a.id });
      put('unsentPages', { pageId: b.id });
    }
    if (version >= 3) {
      put('pins', pin);
      put('quarantine', entry);
      put('repairs', repair);
    }
    await done(tx);
  }

  /** Everything the old store held, read through the store of this build. */
  async function check(store: IndexedDbStore, version: number) {
    expect(await store.schemaVersion()).toBe(STORE_SCHEMA_VERSION);
    const mirror = await store.readMirror(ws.id);
    expect(mirror.workspaces).toEqual([ws]);
    expect(mirror.sections).toEqual(expect.arrayContaining([section, other]));
    expect(mirror.pages).toHaveLength(4);
    for (const p of [a, b, trashed, c]) expect(await store.getPage(p.id)).toEqual(p);
    expect(mirror.favourites).toEqual([favourite]);
    expect(mirror.visits).toEqual([visit]);
    expect(mirror.assets).toEqual([asset]);
    expect(await store.getAssetBytes(asset.id)).toEqual(bytes(137, 80, 0));
    const doc = await store.loadDoc(a.id);
    expect(doc.snapshot).toEqual(bytes(9, 9, 9));
    expect(doc.snapshotCovers).toBe(1);
    const { updateId, localSeq, data, seq } = updates[0];
    expect(doc.updates[0]).toEqual({ updateId, localSeq, data, seq });
    expect(doc.updates.map((u) => [u.localSeq, u.seq, [...u.data]])).toEqual(
      updates.filter((u) => u.pageId === a.id).map((u) => [u.localSeq, u.seq, [...u.data]]),
    );
    // The update in the corrupt area stays out of the log; the others load.
    expect((await store.loadDoc(b.id)).updates.map((u) => [...u.data])).toEqual([[1]]);
    expect(await store.listHistory(a.id)).toEqual([history]);
    expect(await store.getHistory(history.id)).toEqual(bytes(8, 8));
    expect(await store.nextOutboxBatch(10)).toEqual(outbox);
    expect(await store.nextOutboxBatch(10, ws.id)).toEqual(outbox);
    expect((await store.search(ws.id, 'quarter', 10)).map((h) => h.pageId)).toEqual([a.id]);
    expect(await store.getPref('toggles')).toEqual({ [a.id]: true });
    // Schema 3's collections: what version 3 kept, or empty from an earlier one.
    expect(await store.pins(ws.id)).toEqual(version >= 3 ? [pin] : []);
    expect(await store.quarantine(null)).toEqual(version >= 3 ? [entry] : []);
    expect(await store.repairState(a.id)).toEqual(version >= 3 ? repair : null);
    // Schema 4's collections are there and empty; the pages stay pages.
    expect(mirror.databases).toEqual([]);
    expect(mirror.views).toEqual([]);
    expect(mirror.pages.every((p) => p.kind === 'page')).toBe(true);
    expect(await store.dbHolds(ws.id)).toEqual([]);
    expect(await store.trashedRows(ws.id)).toEqual([]);
    expect(await store.readRows(a.id)).toEqual([]);
    // A page with only a snapshot counts as held: the index over the old logs finds it.
    expect(await store.heldPages(ws.id)).toEqual([a.id, b.id, c.id].sort());
    const docBytes = 3 + 2 + updates.reduce((n, u) => n + u.data.byteLength, 0);
    expect(await store.storageUsage(ws.id)).toEqual({
      pages: 3,
      docBytes,
      assetBytes: 3,
      historyBytes: 2,
      quarantineBytes: version >= 3 ? 3 : 0,
    });
  }

  /** Builds the store as that version did: its upgrade only, its rows as it wrote them. */
  async function build(name: string, version: number) {
    const db = await openDatabase(indexedDB, name, version, (d, oldVersion, tx) =>
      upgrade(d, oldVersion, tx, version),
    );
    expect(db.objectStoreNames.contains(version >= 3 ? 'rows' : 'pins')).toBe(false);
    await write(db, version);
    db.close();
  }

  return { ws, a, b, c, updates, outbox, asset, build, check };
}

describe('IndexedDB store migration', () => {
  it('opens a version-1 store at version 4 with all it held', async () => {
    const name = `test-v1-${uuidv7()}`;
    const f = fixture(false);
    await f.build(name, 1);

    const store = await IndexedDbStore.open(indexedDB, name);
    await f.check(store, 1);
    // The log goes on from where version 1 left it.
    expect(await store.appendDocUpdates(f.b.id, [{ updateId: uuidv7(), data: bytes(5) }])).toEqual([
      3,
    ]);
    // Version 1 never sent anything: once the workspace syncs, its old updates are pushed.
    await store.beginUpload(f.ws.id, ACCOUNT, []);
    expect(
      (await store.unsentDocUpdates(10)).map((d) => [d.pageId, d.updates.map((u) => u.data[0])]),
    ).toEqual(
      expect.arrayContaining([
        [f.a.id, [2, 3]],
        [f.b.id, [1, 5]],
      ]),
    );
    // And what schema 3 adds works on it.
    const entry = await store.setAsideDoc(f.a.id, 'doc.epochMismatch');
    expect(entry?.parts.map((p) => [...p])).toEqual([[9, 9, 9], [2, 0, 255], [3]]);
    await store.close();

    const db = await peek(name);
    expect(db.version).toBe(4);
    expect([...db.objectStoreNames]).toEqual(
      expect.arrayContaining([
        'pins',
        'quarantine',
        'repairs',
        'databases',
        'views',
        'rows',
        'dbHolds',
      ]),
    );
    db.close();
  });

  it('opens a version-2 store at version 4 with all it held, sync state included', async () => {
    const name = `test-v2-${uuidv7()}`;
    const f = fixture(true);
    await f.build(name, 2);

    const store = await IndexedDbStore.open(indexedDB, name);
    await f.check(store, 2);
    expect(await store.syncCursor(f.ws.id)).toBe(42);
    expect(await store.docCursor(f.a.id)).toEqual({ headSeq: 8, epoch: 1 });
    expect(await store.docCursors(f.ws.id)).toEqual({ [f.a.id]: { headSeq: 8, epoch: 1 } });
    expect(
      (await store.unsentDocUpdates(10)).map((d) => [d.pageId, d.updates.map((u) => u.data[0])]),
    ).toEqual(
      expect.arrayContaining([
        [f.a.id, [3]],
        [f.b.id, [1]],
      ]),
    );
    expect(await store.pendingAssets(10)).toEqual([f.asset]);
    // Setting a migrated log aside keeps its sent and pulled updates.
    const entry = await store.setAsideDoc(f.a.id, 'doc.epochMismatch');
    expect(entry?.parts.map((p) => [...p])).toEqual([[9, 9, 9], [2, 0, 255], [3], [4]]);
    expect((await store.loadDoc(f.a.id)).updates.map((u) => u.seq)).toEqual([7, 8]);
    expect(await store.quarantine(f.ws.id)).toEqual([entry]);
    await store.close();
  });

  it('opens a version-3 store at version 4 with all it held, offline state included', async () => {
    const name = `test-v3-${uuidv7()}`;
    const f = fixture(true);
    await f.build(name, 3);

    const store = await IndexedDbStore.open(indexedDB, name);
    await f.check(store, 3);
    expect(await store.syncCursor(f.ws.id)).toBe(42);
    expect(await store.docCursors(f.ws.id)).toEqual({ [f.a.id]: { headSeq: 8, epoch: 1 } });
    expect(await store.pendingAssets(10)).toEqual([f.asset]);
    // What schema 4 adds works on what version 3 wrote: a database under one of its pages.
    const db = {
      ...pageRecord(f.ws.id, f.a.sectionId, f.a.id, 'Tasks', 'a9'),
      kind: 'database' as const,
    };
    await store.applyLocalOps([
      op('page.create', f.ws.id, db.id, { ...db, database: { properties: [] } }),
    ]);
    expect((await store.readMirror(f.ws.id)).databases.map((d) => d.id)).toEqual([db.id]);
    expect((await store.dbHold(db.id))?.mode).toBe('full');
    // And a page version 3 kept goes with everything of it, as before.
    await store.applyRemote({ workspaceId: f.ws.id, deletePages: [f.b.id] });
    expect(await store.pins(f.ws.id)).toEqual([]);
    expect((await store.quarantine(f.ws.id)).map((e) => e.pageId).sort()).toEqual(
      [f.b.id, f.c.id].sort(),
    );
    await store.close();

    const peeked = await peek(name);
    expect(peeked.version).toBe(4);
    const rows = peeked.transaction('rows').objectStore('rows');
    expect([...rows.indexNames].sort()).toEqual(['database', 'trashRoot', 'workspace']);
    peeked.close();
  });

  it('refuses a store a newer version wrote, and leaves it as it was', async () => {
    // A database a later build upgraded (with a step of its own), and its rows.
    const newer = STORE_SCHEMA_VERSION + 1;
    const name = `test-v${newer}-${uuidv7()}`;
    const f = fixture(true);
    const later = await openDatabase(indexedDB, name, newer, (db, oldVersion, tx) => {
      upgrade(db, oldVersion, tx, STORE_SCHEMA_VERSION);
      db.createObjectStore('future');
    });
    let tx = later.transaction(['pages', 'meta', 'future'], 'readwrite');
    tx.objectStore('pages').put({ ...f.a, parentPageId: '' });
    tx.objectStore('meta').put(newer, 'schemaVersion');
    tx.objectStore('future').put('kept', 'x');
    await done(tx);
    later.close();
    await expect(IndexedDbStore.open(indexedDB, name)).rejects.toThrow(/newer version/);
    const db = await peek(name);
    expect(db.version).toBe(newer);
    tx = db.transaction(['pages', 'meta', 'future']);
    expect(await getAll(tx.objectStore('pages'))).toEqual([{ ...f.a, parentPageId: '' }]);
    expect(await request(tx.objectStore('meta').get('schemaVersion'))).toBe(newer);
    expect(await request(tx.objectStore('future').get('x'))).toBe('kept');
    db.close();

    // A store whose database is at this build's version but whose record says newer.
    const other = `test-meta${newer}-${uuidv7()}`;
    const current = await openDatabase(indexedDB, other, STORE_SCHEMA_VERSION, (d, oldVersion, t) =>
      upgrade(d, oldVersion, t, STORE_SCHEMA_VERSION),
    );
    tx = current.transaction(['meta'], 'readwrite');
    tx.objectStore('meta').put(newer, 'schemaVersion');
    await done(tx);
    current.close();
    await expect(IndexedDbStore.open(indexedDB, other)).rejects.toThrow(
      new RegExp(`newer version \\(${newer}\\)`),
    );
    const again = await peek(other);
    expect(await request(again.transaction('meta').objectStore('meta').get('schemaVersion'))).toBe(
      newer,
    );
    again.close();
  });
});

describe('IndexedDB store, the corrupt area', () => {
  it('keeps an undecodable update aside, with its bytes, and loads the rest after a restart', async () => {
    const name = `test-corrupt-${uuidv7()}`;
    const page = uuidv7();
    let store = await IndexedDbStore.open(indexedDB, name);
    const seqs = await store.appendDocUpdates(
      page,
      [1, 2, 3].map((v) => ({ updateId: uuidv7(), data: bytes(v, v) })),
    );
    await store.quarantineUpdates(page, [seqs[1]], 'doc.undecodable');
    await store.close();
    store = await IndexedDbStore.open(indexedDB, name);
    expect((await store.loadDoc(page)).updates.map((u) => [...u.data])).toEqual([
      [1, 1],
      [3, 3],
    ]);
    await store.close();
    const db = await peek(name);
    const rows = await getAll<{
      pageId: string;
      localSeq: number;
      data: Uint8Array;
      reason: string;
    }>(db.transaction('corrupt').objectStore('corrupt'));
    expect(rows.map((r) => [r.pageId, r.localSeq, [...r.data], r.reason])).toEqual([
      [page, seqs[1], [2, 2], 'doc.undecodable'],
    ]);
    db.close();
  });
});

describe('IndexedDB store, storage usage', () => {
  // Settings reads it as it opens. One transaction over every page, three requests a page, held
  // the documents' writes up for seconds in a workspace of 10,000 pages (bench/phase8.mjs).
  const DOC_STORES = ['docLogs', 'docUpdates', 'docCursors'];

  /** Requests on the document stores while `run` runs. */
  async function requestsDuring<T>(
    run: () => Promise<T>,
  ): Promise<{ result: T; requests: number }> {
    const methods = ['get', 'getAll', 'getAllKeys', 'count'] as const;
    const saved = methods.map((m) => IDBObjectStore.prototype[m]);
    let requests = 0;
    methods.forEach((m, i) => {
      const original = saved[i] as (...args: unknown[]) => IDBRequest;
      (IDBObjectStore.prototype as unknown as Record<string, unknown>)[m] = function (
        this: IDBObjectStore,
        ...args: unknown[]
      ) {
        if (DOC_STORES.includes(this.name)) requests++;
        return original.apply(this, args);
      };
    });
    try {
      return { result: await run(), requests };
    } finally {
      methods.forEach((m, i) => {
        (IDBObjectStore.prototype as unknown as Record<string, unknown>)[m] = saved[i];
      });
    }
  }

  /** What the page-by-page reading counted: each page's snapshot and updates, loaded. */
  async function expected(store: IndexedDbStore, pageIds: string[]) {
    let pages = 0;
    let docBytes = 0;
    for (const id of pageIds) {
      const doc = await store.loadDoc(id);
      if (!doc.snapshot && !doc.updates.length) continue;
      pages++;
      docBytes +=
        (doc.snapshot?.byteLength ?? 0) + doc.updates.reduce((n, u) => n + u.data.byteLength, 0);
    }
    return { pages, docBytes, assetBytes: 0, historyBytes: 0, quarantineBytes: 0 };
  }

  async function make(store: IndexedDbStore, workspaces: { pages: number }[]) {
    const made = workspaces.map(() => {
      const ws = workspaceRecord();
      return { ws, section: sectionRecord(ws.id), pages: [] as ReturnType<typeof pageRecord>[] };
    });
    // Made in turn, so the workspaces' ids (made in time order) interleave from first to last.
    const most = Math.max(...workspaces.map((w) => w.pages));
    for (let i = 0; i < most; i++)
      made.forEach((m, w) => {
        while (m.pages.length < Math.ceil(((i + 1) * workspaces[w].pages) / most))
          m.pages.push(pageRecord(m.ws.id, m.section.id, null, `Page ${m.pages.length}`));
      });
    for (const { ws, section, pages } of made)
      await store.applyLocalOps([
        op('workspace.create', ws.id, ws.id, ws),
        op('section.create', ws.id, section.id, section),
        ...pages.map((p) => op('page.create', ws.id, p.id, p)),
      ]);
    return made;
  }

  it('reads a large workspace by range, a few requests for 1,001 pages', async () => {
    const store = await IndexedDbStore.open(indexedDB, `test-usage-${uuidv7()}`);
    const [{ ws, pages }] = await make(store, [{ pages: 1001 }]);
    // Every tenth page holds two updates (more records than one request reads), a few of them
    // compacted into a snapshot.
    for (const [i, p] of pages.entries()) {
      if (i % 10) continue;
      const data = [new Uint8Array(i + 1), new Uint8Array(3)];
      const seqs = await store.appendDocUpdates(
        p.id,
        data.map((d) => ({ updateId: uuidv7(), data: d })),
      );
      if (i % 300 === 0) await store.compactDoc(p.id, new Uint8Array(50 + i), seqs[0]);
    }
    const want = await expected(
      store,
      pages.map((p) => p.id),
    );
    expect(want.pages).toBe(101);
    const { result, requests } = await requestsDuring(() => store.storageUsage(ws.id));
    expect(result).toEqual(want);
    // The logs' keys, the logs (101) and the updates (198) at 100 a request, the cursors' keys:
    // 6, not 3 a page (3,003).
    expect(requests).toBe(6);
    await store.close();
  }, 30_000);

  it('reads a workspace among many more pages of another one page by page', async () => {
    const store = await IndexedDbStore.open(indexedDB, `test-usage-${uuidv7()}`);
    const [mine, other] = await make(store, [{ pages: 500 }, { pages: 1100 }]);
    for (const [i, p] of other.pages.entries())
      await store.appendDocUpdates(p.id, [{ updateId: uuidv7(), data: new Uint8Array(i % 7) }]);
    for (const [i, p] of mine.pages.entries())
      if (i % 5 === 0)
        await store.appendDocUpdates(p.id, [{ updateId: uuidv7(), data: new Uint8Array(i + 2) }]);
    const want = await expected(
      store,
      mine.pages.map((p) => p.id),
    );
    expect(want.pages).toBe(100);
    const { result, requests } = await requestsDuring(() => store.storageUsage(mine.ws.id));
    expect(result).toEqual(want);
    // The range would read the other workspace's 1,100 too: three requests a page instead.
    expect(requests).toBe(1 + 3 * 500);
    expect(await store.storageUsage(other.ws.id)).toEqual(
      await expected(
        store,
        other.pages.map((p) => p.id),
      ),
    );
    await store.close();
  }, 60_000);
});
