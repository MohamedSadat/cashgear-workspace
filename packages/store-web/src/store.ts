// The LocalStore on IndexedDB (D11). Every method is one transaction; the planners (planOps for
// local operations, planSettle and planRemote for what the server says) run inside the same
// transaction their plan is written in, so the mirror, the outbox and the cursors change together
// or not at all.
//
// Schema 4 (Phase 4, databases) adds database and view records, rows (pages of kind `row`, kept
// apart from `pages` and never in the mirror's snapshot) and the holds that say which databases'
// rows this device keeps. A database page that goes takes its record, views, rows and hold.
import {
  STORE_SCHEMA_VERSION,
  planOps,
  planRemote,
  planSettle,
  searchTerms,
  snippet,
  uuidv7,
  type AssetRecord,
  type DatabaseRecord,
  type DbHold,
  type DocAck,
  type DocCursor,
  type FavouriteRecord,
  type HistoryEntry,
  type Id,
  type LocalStore,
  type LocalUpdate,
  type MirrorReader,
  type MirrorSnapshot,
  type Operation,
  type OpResult,
  type PageRecord,
  type PinRecord,
  type Plan,
  type QuarantineEntry,
  type RemoteBatch,
  type RemoteDocPull,
  type RemoteReader,
  type RepairState,
  type RowRecord,
  type SearchEntry,
  type SearchHit,
  type SectionRecord,
  type StorageUsage,
  type StoredDoc,
  type StoredUpdate,
  type UnsentDoc,
  type ViewRecord,
  type VisitRecord,
  type WorkspaceRecord,
} from '@cgw/workspace';
import { done, getAll, getAllKeys, openDatabase, request } from './idb';
import type { SearchIndex } from './searchIndex';

export const DATABASE = 'cgw-workspace';

const S = {
  workspaces: 'workspaces',
  sections: 'sections',
  pages: 'pages',
  favourites: 'favourites',
  visits: 'visits',
  assets: 'assets',
  assetBytes: 'assetBytes',
  docLogs: 'docLogs',
  docUpdates: 'docUpdates',
  corrupt: 'corrupt',
  history: 'history',
  historyBytes: 'historyBytes',
  outbox: 'outbox',
  search: 'search',
  prefs: 'prefs',
  meta: 'meta',
  // Schema 2
  syncCursors: 'syncCursors',
  docCursors: 'docCursors',
  unsentPages: 'unsentPages',
  // Schema 3
  pins: 'pins',
  quarantine: 'quarantine',
  repairs: 'repairs',
  // Schema 4
  databases: 'databases',
  views: 'views',
  rows: 'rows',
  dbHolds: 'dbHolds',
} as const;
type StoreName = (typeof S)[keyof typeof S];

/** What writing a plan touches (applyLocalOps, settleOps, applyRemote, purgeTrash). */
const PLAN_STORES: StoreName[] = [
  S.workspaces,
  S.sections,
  S.pages,
  S.favourites,
  S.visits,
  S.assets,
  S.assetBytes,
  S.outbox,
  S.syncCursors,
  S.docLogs,
  S.docUpdates,
  S.docCursors,
  S.unsentPages,
  S.history,
  S.historyBytes,
  S.search,
  S.pins,
  S.quarantine,
  S.repairs,
  S.databases,
  S.views,
  S.rows,
  S.dbHolds,
];

/** What setting a page's log aside reads and writes (setAsideDoc, and inside a remote plan). */
const SET_ASIDE_STORES: StoreName[] = [
  S.workspaces,
  S.pages,
  S.rows,
  S.docLogs,
  S.docUpdates,
  S.unsentPages,
  S.quarantine,
];

interface DocLog {
  pageId: Id;
  nextSeq: number;
  snapshot: Uint8Array | null;
  snapshotCovers: number;
}

interface UpdateRow extends StoredUpdate {
  pageId: Id;
}

interface DocCursorRow extends DocCursor {
  pageId: Id;
}

interface SyncCursorRow {
  workspaceId: Id;
  cursor: number;
}

/** IndexedDB cannot index null: a top-level page is stored with an empty parent key. */
type PageRow = PageRecord & { parentPageId: string };

/**
 * The upgrade steps, by the version each one brings the store to. A browser store cannot be
 * copied before it migrates (SYNC_DESIGN.md, local migration), so every step after the first only
 * adds object stores and indexes: none rewrites or removes what an earlier version wrote.
 */
const STEPS: Record<number, (db: IDBDatabase, tx: IDBTransaction) => void> = {
  1: (db) => {
    db.createObjectStore(S.workspaces, { keyPath: 'id' });
    db.createObjectStore(S.sections, { keyPath: 'id' }).createIndex('workspace', 'workspaceId');
    const pages = db.createObjectStore(S.pages, { keyPath: 'id' });
    pages.createIndex('workspace', 'workspaceId');
    pages.createIndex('section', 'sectionId');
    pages.createIndex('parent', 'parentPageId');
    db.createObjectStore(S.favourites, { keyPath: ['workspaceId', 'pageId'] }).createIndex(
      'workspace',
      'workspaceId',
    );
    db.createObjectStore(S.visits, { keyPath: ['workspaceId', 'pageId'] }).createIndex(
      'workspace',
      'workspaceId',
    );
    db.createObjectStore(S.assets, { keyPath: 'id' }).createIndex('workspace', 'workspaceId');
    db.createObjectStore(S.assetBytes);
    db.createObjectStore(S.docLogs, { keyPath: 'pageId' });
    db.createObjectStore(S.docUpdates, { keyPath: ['pageId', 'localSeq'] });
    db.createObjectStore(S.corrupt, { autoIncrement: true });
    db.createObjectStore(S.history, { keyPath: 'id' }).createIndex('page', 'pageId');
    db.createObjectStore(S.historyBytes);
    db.createObjectStore(S.outbox, { autoIncrement: true });
    db.createObjectStore(S.search, { keyPath: 'pageId' }).createIndex('workspace', 'workspaceId');
    db.createObjectStore(S.prefs);
    db.createObjectStore(S.meta);
  },
  2: (db, tx) => {
    // The outbox by workspace (a push, an upload, a lost workspace), by entity (what waits
    // locally) and by operation id (settling). Not unique: an index must never fail an upgrade.
    const outbox = tx.objectStore(S.outbox);
    outbox.createIndex('workspace', 'workspaceId');
    outbox.createIndex('entity', 'entityId');
    outbox.createIndex('op', 'opId');
    db.createObjectStore(S.syncCursors, { keyPath: 'workspaceId' });
    db.createObjectStore(S.docCursors, { keyPath: 'pageId' });
    // Pages whose log may hold updates the server does not have (a superset), so a push reads
    // only those pages. Version 1 never sent anything: every page with updates has unsent ones.
    const unsent = db.createObjectStore(S.unsentPages, { keyPath: 'pageId' });
    const keys = tx.objectStore(S.docUpdates).getAllKeys();
    keys.onsuccess = () => {
      for (const pageId of new Set((keys.result as [Id, number][]).map(([pageId]) => pageId)))
        unsent.put({ pageId });
    };
  },
  3: (db, tx) => {
    // Offline (Phase 3): pins, what was set aside to become recovered pages, repair state.
    db.createObjectStore(S.pins, { keyPath: 'pageId' }).createIndex('workspace', 'workspaceId');
    db.createObjectStore(S.quarantine, { keyPath: 'id' }).createIndex('workspace', 'workspaceId');
    db.createObjectStore(S.repairs, { keyPath: 'pageId' });
    // Logs whose snapshot covers something, so heldPages finds them without reading a snapshot.
    tx.objectStore(S.docLogs).createIndex('covers', 'snapshotCovers');
  },
  4: (db) => {
    // Databases (Phase 4): their records, views, the rows this device holds, and its holds.
    db.createObjectStore(S.databases, { keyPath: 'id' }).createIndex('workspace', 'workspaceId');
    const views = db.createObjectStore(S.views, { keyPath: 'id' });
    views.createIndex('workspace', 'workspaceId');
    views.createIndex('database', 'databaseId');
    const rows = db.createObjectStore(S.rows, { keyPath: 'id' });
    rows.createIndex('database', 'databaseId');
    rows.createIndex('workspace', 'workspaceId');
    // Rows in the trash: a row not in it has a null root, which an index leaves out.
    rows.createIndex('trashRoot', 'trashRootId');
    db.createObjectStore(S.dbHolds, { keyPath: 'databaseId' }).createIndex(
      'workspace',
      'workspaceId',
    );
  },
};

/** Runs the steps after `oldVersion` up to `newVersion` (tests stop at an older version). */
export function upgrade(
  db: IDBDatabase,
  oldVersion: number,
  tx: IDBTransaction,
  newVersion: number = STORE_SCHEMA_VERSION,
) {
  for (let version = oldVersion + 1; version <= newVersion; version++) STEPS[version](db, tx);
}

const pageRange = (pageId: Id) => IDBKeyRange.bound([pageId, 0], [pageId, Number.MAX_SAFE_INTEGER]);

/** Bytes are copied into their own buffer: a view into a larger one would store the whole buffer. */
const own = (bytes: Uint8Array) =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();

const stored = ({ updateId, data, localSeq, seq }: UpdateRow): StoredUpdate => ({
  updateId,
  data,
  localSeq,
  seq,
});

const newer = (version?: number) =>
  new Error(
    `This store was written by a newer version${version ? ` (${version})` : ''}; update the app.`,
  );

export class IndexedDbStore implements LocalStore {
  readonly kind = 'indexeddb' as const;

  private constructor(
    private readonly db: IDBDatabase,
    private readonly index: SearchIndex | null,
  ) {}

  /**
   * Opens the store. With a search index (the browser's worker), text search runs in memory in
   * the worker; without one (tests in Node), the store scans its entries.
   */
  static async open(
    factory: IDBFactory = indexedDB,
    name = DATABASE,
    options: { index?: SearchIndex } = {},
  ): Promise<IndexedDbStore> {
    let db: IDBDatabase;
    try {
      db = await openDatabase(factory, name, STORE_SCHEMA_VERSION, upgrade);
    } catch (error) {
      // The database itself is at a later version than this build knows.
      if ((error as { name?: string } | null)?.name === 'VersionError') throw newer();
      throw error;
    }
    const store = new IndexedDbStore(db, options.index ?? null);
    const tx = db.transaction(S.meta, 'readwrite');
    const version = await request(tx.objectStore(S.meta).get('schemaVersion'));
    if (typeof version === 'number' && version > STORE_SCHEMA_VERSION) {
      db.close();
      throw newer(version);
    }
    tx.objectStore(S.meta).put(STORE_SCHEMA_VERSION, 'schemaVersion');
    await done(tx);
    // The index loads in the background; searches wait for it.
    void options.index?.load(name).catch((error: unknown) => console.warn('Search index:', error));
    return store;
  }

  private tx(names: StoreName[], mode: IDBTransactionMode = 'readonly') {
    return this.db.transaction(names, mode);
  }

  /** A read-write transaction that commits what `body` wrote, or nothing if it throws. */
  private async transact<T>(
    names: StoreName[],
    body: (tx: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const tx = this.tx(names, 'readwrite');
    const committed = done(tx);
    let result: T;
    try {
      result = await body(tx);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // Already aborted by the request that failed.
      }
      await committed.catch(() => undefined);
      throw error;
    }
    await committed;
    return result;
  }

  // Documents ----------------------------------------------------------------------------------

  async loadDoc(pageId: Id): Promise<StoredDoc> {
    const tx = this.tx([S.docLogs, S.docUpdates]);
    const [log, rows] = await Promise.all([
      request(tx.objectStore(S.docLogs).get(pageId)) as Promise<DocLog | undefined>,
      getAll<UpdateRow>(tx.objectStore(S.docUpdates), pageRange(pageId)),
    ]);
    return {
      snapshot: log?.snapshot ?? null,
      snapshotCovers: log?.snapshotCovers ?? 0,
      updates: rows.map(stored),
    };
  }

  async appendDocUpdates(pageId: Id, updates: LocalUpdate[]): Promise<number[]> {
    const tx = this.tx([S.docLogs, S.docUpdates, S.unsentPages], 'readwrite');
    const logs = tx.objectStore(S.docLogs);
    const log: DocLog = ((await request(logs.get(pageId))) as DocLog | undefined) ?? {
      pageId,
      nextSeq: 1,
      snapshot: null,
      snapshotCovers: 0,
    };
    const seqs: number[] = [];
    for (const update of updates) {
      const localSeq = log.nextSeq++;
      seqs.push(localSeq);
      tx.objectStore(S.docUpdates).put({
        pageId,
        localSeq,
        updateId: update.updateId,
        data: own(update.data),
        seq: null,
      } satisfies UpdateRow);
    }
    logs.put(log);
    if (updates.length) tx.objectStore(S.unsentPages).put({ pageId });
    await done(tx);
    return seqs;
  }

  async compactDoc(pageId: Id, snapshot: Uint8Array, coversLocalUpTo: number): Promise<void> {
    const tx = this.tx([S.docLogs, S.docUpdates, S.pages, S.rows, S.workspaces], 'readwrite');
    const logs = tx.objectStore(S.docLogs);
    const updates = tx.objectStore(S.docUpdates);
    const [found, keepUnsent] = await Promise.all([
      request(logs.get(pageId)) as Promise<DocLog | undefined>,
      this.synced(tx, pageId),
    ]);
    const log = found ?? {
      pageId,
      nextSeq: coversLocalUpTo + 1,
      snapshot: null,
      snapshotCovers: 0,
    };
    log.snapshot = own(snapshot);
    log.snapshotCovers = Math.max(log.snapshotCovers, coversLocalUpTo);
    log.nextSeq = Math.max(log.nextSeq, coversLocalUpTo + 1);
    const covered = IDBKeyRange.bound([pageId, 0], [pageId, coversLocalUpTo]);
    if (keepUnsent) {
      // A synced page keeps what the server does not have yet, to push it.
      for (const row of await getAll<UpdateRow>(updates, covered))
        if (row.seq !== null) updates.delete([pageId, row.localSeq]);
    } else updates.delete(covered);
    logs.put(log);
    await done(tx);
  }

  /** A page, a database's page, or a row; the transaction includes `pages` and `rows`. */
  private async pageOrRow(tx: IDBTransaction, pageId: Id): Promise<PageRecord | undefined> {
    const page = this.pageOf((await request(tx.objectStore(S.pages).get(pageId))) as PageRow);
    return page ?? ((await request(tx.objectStore(S.rows).get(pageId))) as RowRecord | undefined);
  }

  /** The ids of a workspace's pages and rows. */
  private async workspacePageIds(tx: IDBTransaction, workspaceId: Id): Promise<Id[]> {
    const [pages, rows] = await Promise.all([
      getAllKeys(tx.objectStore(S.pages).index('workspace'), workspaceId),
      getAllKeys(tx.objectStore(S.rows).index('workspace'), workspaceId),
    ]);
    return [...pages, ...rows] as Id[];
  }

  /** Whether a page belongs to a workspace that syncs (its unsent updates are kept and pushed). */
  private async synced(tx: IDBTransaction, pageId: Id): Promise<boolean> {
    const page = await this.pageOrRow(tx, pageId);
    const workspace =
      page &&
      ((await request(tx.objectStore(S.workspaces).get(page.workspaceId))) as
        WorkspaceRecord | undefined);
    return !!workspace && !workspace.localOnly;
  }

  async quarantineUpdates(pageId: Id, localSeqs: number[], reason: string): Promise<void> {
    const tx = this.tx([S.docUpdates, S.corrupt], 'readwrite');
    for (const localSeq of localSeqs) {
      const row = (await request(tx.objectStore(S.docUpdates).get([pageId, localSeq]))) as
        UpdateRow | undefined;
      if (!row) continue;
      tx.objectStore(S.corrupt).add({ ...row, reason, at: new Date().toISOString() });
      tx.objectStore(S.docUpdates).delete([pageId, localSeq]);
    }
    await done(tx);
  }

  async docLogLength(pageId: Id): Promise<number> {
    return request(this.tx([S.docUpdates]).objectStore(S.docUpdates).count(pageRange(pageId)));
  }

  /** A page whose log holds nothing unsent leaves the pages a push reads. */
  private forgetIfSent(tx: IDBTransaction, pageId: Id, rows: UpdateRow[]) {
    if (!rows.some((row) => row.seq === null)) tx.objectStore(S.unsentPages).delete(pageId);
  }

  // Documents in sync --------------------------------------------------------------------------

  async unsentDocUpdates(limit: number): Promise<UnsentDoc[]> {
    if (limit <= 0) return [];
    const tx = this.tx([S.workspaces, S.pages, S.rows, S.unsentPages, S.docUpdates]);
    const [workspaces, candidates] = await Promise.all([
      getAll<WorkspaceRecord>(tx.objectStore(S.workspaces)),
      getAllKeys(tx.objectStore(S.unsentPages)) as Promise<Id[]>,
    ]);
    const syncing = workspaces.filter((w) => !w.localOnly).map((w) => w.id);
    if (!syncing.length || !candidates.length) return [];
    const syncedPages = new Set(
      (await Promise.all(syncing.map((id) => this.workspacePageIds(tx, id)))).flat(),
    );
    const pending = (
      await Promise.all(
        candidates
          .filter((pageId) => syncedPages.has(pageId))
          .map(async (pageId) => ({
            pageId,
            updates: (await getAll<UpdateRow>(tx.objectStore(S.docUpdates), pageRange(pageId)))
              .filter((row) => row.seq === null)
              .map(stored),
          })),
      )
    )
      .filter((doc) => doc.updates.length)
      .sort((a, b) => (a.updates[0].updateId < b.updates[0].updateId ? -1 : 1));
    const out: UnsentDoc[] = [];
    let left = limit;
    for (const doc of pending) {
      if (left <= 0) break;
      const updates = doc.updates.slice(0, left);
      left -= updates.length;
      out.push({ pageId: doc.pageId, updates });
    }
    return out;
  }

  async ackDocUpdates(pageId: Id, acks: DocAck[]): Promise<void> {
    const tx = this.tx([S.docUpdates, S.unsentPages], 'readwrite');
    const updates = tx.objectStore(S.docUpdates);
    const rows = await getAll<UpdateRow>(updates, pageRange(pageId));
    const bySeq = new Map(acks.map((a) => [a.updateId, a.seq]));
    for (const row of rows) {
      const seq = bySeq.get(row.updateId);
      if (seq === undefined) continue;
      row.seq = seq;
      updates.put(row);
    }
    this.forgetIfSent(tx, pageId, rows);
    await done(tx);
  }

  async applyRemoteDocUpdates(pageId: Id, pull: RemoteDocPull): Promise<StoredUpdate[]> {
    const tx = this.tx([S.docLogs, S.docUpdates, S.docCursors, S.unsentPages], 'readwrite');
    const logs = tx.objectStore(S.docLogs);
    const updates = tx.objectStore(S.docUpdates);
    const cursors = tx.objectStore(S.docCursors);
    const [found, rows, current] = await Promise.all([
      request(logs.get(pageId)) as Promise<DocLog | undefined>,
      getAll<UpdateRow>(updates, pageRange(pageId)),
      request(cursors.get(pageId)) as Promise<DocCursorRow | undefined>,
    ]);
    const log: DocLog = found ?? { pageId, nextSeq: 1, snapshot: null, snapshotCovers: 0 };
    const byId = new Map<Id, UpdateRow>();
    for (const row of rows) if (!byId.has(row.updateId)) byId.set(row.updateId, row);
    const seqs = new Set(rows.map((row) => row.seq));
    const added: StoredUpdate[] = [];
    for (const remote of pull.updates) {
      const mine = remote.updateId ? byId.get(remote.updateId) : undefined;
      if (mine) {
        // An update this device pushed: the pull acknowledges it.
        if (mine.seq === null) {
          mine.seq = remote.seq;
          seqs.add(remote.seq);
          updates.put(mine);
        }
        continue;
      }
      if (seqs.has(remote.seq)) continue;
      const row: UpdateRow = {
        pageId,
        localSeq: log.nextSeq++,
        updateId: remote.updateId ?? uuidv7(),
        data: own(remote.data),
        seq: remote.seq,
      };
      updates.put(row);
      rows.push(row);
      byId.set(row.updateId, row);
      seqs.add(row.seq);
      added.push({ ...stored(row), data: row.data.slice() });
    }
    logs.put(log);
    const kept = current && current.epoch === pull.epoch ? current.headSeq : 0;
    cursors.put({
      pageId,
      headSeq: Math.max(kept, pull.headSeq),
      epoch: pull.epoch,
    } satisfies DocCursorRow);
    this.forgetIfSent(tx, pageId, rows);
    await done(tx);
    return added;
  }

  async docCursor(pageId: Id): Promise<DocCursor | null> {
    const row = (await request(this.tx([S.docCursors]).objectStore(S.docCursors).get(pageId))) as
      DocCursorRow | undefined;
    return row ? { headSeq: row.headSeq, epoch: row.epoch } : null;
  }

  async docCursors(workspaceId: Id): Promise<Record<Id, DocCursor>> {
    const tx = this.tx([S.pages, S.rows, S.docCursors]);
    const [pageIds, rows] = await Promise.all([
      this.workspacePageIds(tx, workspaceId),
      getAll<DocCursorRow>(tx.objectStore(S.docCursors)),
    ]);
    const mine = new Set(pageIds);
    const out: Record<Id, DocCursor> = {};
    for (const row of rows)
      if (mine.has(row.pageId)) out[row.pageId] = { headSeq: row.headSeq, epoch: row.epoch };
    return out;
  }

  async replaceDoc(pageId: Id, update: LocalUpdate, upTo?: number): Promise<void> {
    const tx = this.tx([S.docLogs, S.docUpdates, S.docCursors, S.unsentPages], 'readwrite');
    const logs = tx.objectStore(S.docLogs);
    const found = (await request(logs.get(pageId))) as DocLog | undefined;
    if (upTo !== undefined && (found?.snapshotCovers ?? 0) > upTo) {
      tx.abort();
      throw new Error('The page was compacted meanwhile');
    }
    const log: DocLog = {
      pageId,
      nextSeq: found?.nextSeq ?? 1,
      snapshot: null,
      snapshotCovers: 0,
    };
    const updates = tx.objectStore(S.docUpdates);
    // With `upTo`, later updates stay; the merged one stands where the last it replaces stood.
    updates.delete(
      upTo === undefined ? pageRange(pageId) : IDBKeyRange.bound([pageId, 0], [pageId, upTo]),
    );
    updates.put({
      pageId,
      localSeq: upTo === undefined ? log.nextSeq++ : upTo,
      updateId: update.updateId,
      data: own(update.data),
      seq: null,
    } satisfies UpdateRow);
    logs.put(log);
    tx.objectStore(S.docCursors).delete(pageId);
    tx.objectStore(S.unsentPages).put({ pageId });
    await done(tx);
  }

  // History ------------------------------------------------------------------------------------

  async addHistory(pageId: Id, snapshot: Uint8Array, keep: number): Promise<HistoryEntry> {
    const tx = this.tx([S.history, S.historyBytes], 'readwrite');
    const entry: HistoryEntry = {
      id: uuidv7(),
      pageId,
      createdAt: new Date().toISOString(),
      sizeBytes: snapshot.byteLength,
    };
    tx.objectStore(S.history).put(entry);
    tx.objectStore(S.historyBytes).put(own(snapshot), entry.id);
    const all = await getAll<HistoryEntry>(tx.objectStore(S.history).index('page'), pageId);
    for (const old of all.sort((a, b) => (a.id < b.id ? 1 : -1)).slice(keep)) {
      tx.objectStore(S.history).delete(old.id);
      tx.objectStore(S.historyBytes).delete(old.id);
    }
    await done(tx);
    return entry;
  }

  async listHistory(pageId: Id): Promise<HistoryEntry[]> {
    const all = await getAll<HistoryEntry>(
      this.tx([S.history]).objectStore(S.history).index('page'),
      pageId,
    );
    return all.sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  async getHistory(entryId: Id): Promise<Uint8Array | null> {
    return (
      ((await request(this.tx([S.historyBytes]).objectStore(S.historyBytes).get(entryId))) as
        Uint8Array | undefined) ?? null
    );
  }

  // Mirror and outbox --------------------------------------------------------------------------

  applyLocalOp(op: Operation): Promise<void> {
    return this.applyLocalOps([op]);
  }

  async applyLocalOps(ops: Operation[]): Promise<void> {
    const deleted = await this.transact(PLAN_STORES, async (tx) => {
      const plan = await planOps(ops, this.reader(tx));
      await this.writePlan(tx, plan);
      return [...plan.deletePages, ...plan.deleteRows];
    });
    this.index?.remove(deleted);
  }

  /**
   * Writes a plan in the order the in-memory mirror applies one (Mirror.apply): a lost workspace
   * first, then upserts before deletes, so a record both put and deleted ends up deleted. A remote
   * plan (the server's word) first sets aside the log of every page it removes that holds unsent
   * updates, before anything of it is written; only pages in `unsentPages` (a superset of those)
   * are looked at, so a lost workspace of many pages costs little.
   */
  private async writePlan(tx: IDBTransaction, plan: Plan, remote = false): Promise<void> {
    const store = (name: StoreName) => tx.objectStore(name);
    // A database page that goes takes its rows: those the plan names, and any other held here.
    const rows = new Set(plan.deleteRows);
    for (const id of plan.deletePages)
      for (const rowId of await getAllKeys(store(S.rows).index('database'), id))
        rows.add(rowId as Id);
    const removed = [...plan.deletePages, ...rows];
    if (remote && removed.length) {
      const unsent = new Set((await getAllKeys(store(S.unsentPages))) as Id[]);
      for (const id of removed) if (unsent.has(id)) await this.setAside(tx, id, 'page.removed');
    }
    const outbox = store(S.outbox);
    if (plan.settled?.length) {
      const keys = await Promise.all(
        plan.settled.map((opId) => getAllKeys(outbox.index('op'), opId)),
      );
      for (const key of keys.flat()) outbox.delete(key);
    }
    await Promise.all((plan.deleteWorkspaces ?? []).map((id) => this.dropWorkspace(tx, id)));
    for (const w of plan.workspaces) store(S.workspaces).put(w);
    for (const s of plan.sections) store(S.sections).put(s);
    for (const id of plan.deleteSections) store(S.sections).delete(id);
    for (const p of plan.pages) store(S.pages).put(this.pageRow(p));
    for (const f of plan.favourites) store(S.favourites).put(f);
    for (const f of plan.deleteFavourites) store(S.favourites).delete([f.workspaceId, f.pageId]);
    for (const v of plan.visits) store(S.visits).put(v);
    for (const v of plan.deleteVisits) store(S.visits).delete([v.workspaceId, v.pageId]);
    for (const d of plan.databases) store(S.databases).put(d);
    for (const v of plan.views) store(S.views).put(v);
    for (const r of plan.rows) store(S.rows).put(r);
    for (const h of plan.holds) store(S.dbHolds).put(h);
    for (const id of plan.deleteViews) store(S.views).delete(id);
    for (const op of plan.outbox) outbox.add(op);
    if (plan.cursor)
      store(S.syncCursors).put({
        workspaceId: plan.cursor.workspaceId,
        cursor: plan.cursor.value,
      } satisfies SyncCursorRow);
    await Promise.all(plan.deletePages.map((id) => this.dropDatabase(tx, id)));
    await Promise.all(removed.map((id) => this.dropPageData(tx, id)));
  }

  /** A database page gone: its record, views and hold (its rows go as removed pages). */
  private async dropDatabase(tx: IDBTransaction, pageId: Id) {
    tx.objectStore(S.databases).delete(pageId);
    tx.objectStore(S.dbHolds).delete(pageId);
    for (const key of await getAllKeys(tx.objectStore(S.views).index('database'), pageId))
      tx.objectStore(S.views).delete(key);
  }

  private pageRow(page: PageRecord): PageRow {
    return { ...page, parentPageId: page.parentPageId ?? '' };
  }

  private pageOf(row: PageRow | undefined): PageRecord | undefined {
    return row ? { ...row, parentPageId: row.parentPageId || null } : undefined;
  }

  /**
   * A page (or a row) removed for good, with its document log, cursor, history, search entry, pin
   * and repair state. What was set aside from it stays.
   */
  private async dropPageData(tx: IDBTransaction, pageId: Id) {
    for (const name of [
      S.pages,
      S.rows,
      S.docLogs,
      S.docCursors,
      S.unsentPages,
      S.search,
      S.pins,
      S.repairs,
    ])
      tx.objectStore(name).delete(pageId);
    tx.objectStore(S.docUpdates).delete(pageRange(pageId));
    const entries = await getAll<HistoryEntry>(tx.objectStore(S.history).index('page'), pageId);
    for (const entry of entries) {
      tx.objectStore(S.history).delete(entry.id);
      tx.objectStore(S.historyBytes).delete(entry.id);
    }
  }

  /**
   * A workspace the account lost, with its records, outbox, cursor and asset bytes; its pages'
   * documents go with the plan's page deletes, which name every page of it.
   */
  private async dropWorkspace(tx: IDBTransaction, workspaceId: Id) {
    const keysOf = (name: StoreName) =>
      getAllKeys(tx.objectStore(name).index('workspace'), workspaceId);
    const [ops, assets, sections, pages, favourites, visits, databases, views, rows, holds] =
      await Promise.all([
        keysOf(S.outbox),
        keysOf(S.assets),
        keysOf(S.sections),
        keysOf(S.pages),
        keysOf(S.favourites),
        keysOf(S.visits),
        keysOf(S.databases),
        keysOf(S.views),
        keysOf(S.rows),
        keysOf(S.dbHolds),
      ]);
    for (const [name, keys] of [
      [S.databases, databases],
      [S.views, views],
      [S.rows, rows],
      [S.dbHolds, holds],
    ] as const)
      for (const key of keys) tx.objectStore(name).delete(key);
    for (const key of ops) tx.objectStore(S.outbox).delete(key);
    for (const key of assets) {
      tx.objectStore(S.assets).delete(key);
      tx.objectStore(S.assetBytes).delete(key);
    }
    for (const key of sections) tx.objectStore(S.sections).delete(key);
    for (const key of pages) tx.objectStore(S.pages).delete(key);
    for (const key of favourites) tx.objectStore(S.favourites).delete(key);
    for (const key of visits) tx.objectStore(S.visits).delete(key);
    tx.objectStore(S.workspaces).delete(workspaceId);
    tx.objectStore(S.syncCursors).delete(workspaceId);
  }

  /** What the planners read, from inside the transaction their plan is written in. */
  private reader(tx: IDBTransaction): MirrorReader & RemoteReader {
    const pages = tx.objectStore(S.pages);
    const rows = tx.objectStore(S.rows);
    const pageList = async (source: IDBIndex, key: IDBValidKey) =>
      (await getAll<PageRow>(source, key)).map((p) => this.pageOf(p)!);
    return {
      database: async (id) =>
        (await request(tx.objectStore(S.databases).get(id))) as DatabaseRecord | undefined,
      view: async (id) =>
        (await request(tx.objectStore(S.views).get(id))) as ViewRecord | undefined,
      rows: (databaseId) => getAll<RowRecord>(rows.index('database'), databaseId),
      rowIds: async (databaseId) => (await getAllKeys(rows.index('database'), databaseId)) as Id[],
      workspaceRowIds: async (workspaceId) =>
        (await getAllKeys(rows.index('workspace'), workspaceId)) as Id[],
      workspaceViews: (workspaceId) =>
        getAll<ViewRecord>(tx.objectStore(S.views).index('workspace'), workspaceId),
      dbHold: async (id) =>
        (await request(tx.objectStore(S.dbHolds).get(id))) as DbHold | undefined,
      workspace: async (id) =>
        (await request(tx.objectStore(S.workspaces).get(id))) as WorkspaceRecord | undefined,
      section: async (id) =>
        (await request(tx.objectStore(S.sections).get(id))) as SectionRecord | undefined,
      page: (id) => this.pageOrRow(tx, id),
      children: (parentPageId) => pageList(pages.index('parent'), parentPageId),
      sectionPages: (sectionId) => pageList(pages.index('section'), sectionId),
      favourite: async (workspaceId, pageId) =>
        (await request(tx.objectStore(S.favourites).get([workspaceId, pageId]))) as
          FavouriteRecord | undefined,
      workspacePages: (workspaceId) => pageList(pages.index('workspace'), workspaceId),
      workspaceSections: (workspaceId) =>
        getAll<SectionRecord>(tx.objectStore(S.sections).index('workspace'), workspaceId),
      pending: async (entityId, except) => {
        const byEntity = tx.objectStore(S.outbox).index('entity');
        if (!except?.size) return (await request(byEntity.count(entityId))) > 0;
        return (await getAll<Operation>(byEntity, entityId)).some((op) => !except.has(op.opId));
      },
    };
  }

  async nextOutboxBatch(limit: number, workspaceId?: Id): Promise<Operation[]> {
    if (limit <= 0) return [];
    const outbox = this.tx([S.outbox]).objectStore(S.outbox);
    // Keys rise as operations are added: key order, in the index too, is oldest first.
    return workspaceId === undefined
      ? getAll<Operation>(outbox, undefined, limit)
      : getAll<Operation>(outbox.index('workspace'), workspaceId, limit);
  }

  async settleOps(results: OpResult[]): Promise<void> {
    const deleted = await this.transact(PLAN_STORES, async (tx) => {
      const byOp = tx.objectStore(S.outbox).index('op');
      const found = await Promise.all(results.map((r) => getAll<Operation>(byOp, r.opId, 1)));
      const ops = new Map(found.flat().map((op) => [op.opId, op]));
      const plan = await planSettle(results, ops, this.reader(tx));
      await this.writePlan(tx, plan, true);
      return [...plan.deletePages, ...plan.deleteRows];
    });
    this.index?.remove(deleted);
  }

  async applyRemote(batch: RemoteBatch): Promise<void> {
    const deleted = await this.transact(PLAN_STORES, async (tx) => {
      const plan = await planRemote(batch, this.reader(tx));
      await this.writePlan(tx, plan, true);
      return [...plan.deletePages, ...plan.deleteRows];
    });
    this.index?.remove(deleted);
  }

  async syncCursor(workspaceId: Id): Promise<number | null> {
    const row = (await request(
      this.tx([S.syncCursors]).objectStore(S.syncCursors).get(workspaceId),
    )) as SyncCursorRow | undefined;
    return row?.cursor ?? null;
  }

  async beginUpload(
    workspaceId: Id,
    accountId: Id,
    ops: Operation[],
    replaced?: Id[],
  ): Promise<void> {
    await this.transact([S.workspaces, S.outbox], async (tx) => {
      const workspace = (await request(tx.objectStore(S.workspaces).get(workspaceId))) as
        WorkspaceRecord | undefined;
      if (!workspace) throw new Error('No such workspace');
      const outbox = tx.objectStore(S.outbox);
      const keys = await getAllKeys(outbox.index('workspace'), workspaceId);
      // Operations written while the upload was prepared stay, after its creates, in order.
      const gone = replaced ? new Set(replaced) : null;
      const kept: Operation[] = [];
      if (gone)
        for (const key of [...keys].sort((a, b) => Number(a) - Number(b))) {
          const op = (await request(outbox.get(key))) as Operation;
          if (!gone.has(op.opId)) kept.push(op);
        }
      for (const key of keys) outbox.delete(key);
      for (const op of [...ops, ...kept]) outbox.add(op);
      tx.objectStore(S.workspaces).put({ ...workspace, localOnly: false, accountId });
    });
  }

  async readMirror(workspaceId: Id | null): Promise<MirrorSnapshot> {
    const tx = this.tx([
      S.workspaces,
      S.sections,
      S.pages,
      S.favourites,
      S.visits,
      S.assets,
      S.databases,
      S.views,
    ]);
    const scoped = <T>(name: StoreName) =>
      workspaceId === null
        ? getAll<T>(tx.objectStore(name))
        : getAll<T>(tx.objectStore(name).index('workspace'), workspaceId);
    const [workspaces, sections, pages, favourites, visits, assets, databases, views] =
      await Promise.all([
        workspaceId === null
          ? getAll<WorkspaceRecord>(tx.objectStore(S.workspaces))
          : request(tx.objectStore(S.workspaces).get(workspaceId)).then((w) =>
              w ? [w as WorkspaceRecord] : [],
            ),
        scoped<SectionRecord>(S.sections),
        scoped<PageRow>(S.pages),
        scoped<FavouriteRecord>(S.favourites),
        scoped<VisitRecord>(S.visits),
        scoped<AssetRecord>(S.assets),
        scoped<DatabaseRecord>(S.databases),
        scoped<ViewRecord>(S.views),
      ]);
    return {
      workspaces,
      sections,
      pages: pages.map((p) => this.pageOf(p)!),
      favourites,
      visits,
      assets,
      databases,
      views,
    };
  }

  async getPage(pageId: Id): Promise<PageRecord | null> {
    return (await this.pageOrRow(this.tx([S.pages, S.rows]), pageId)) ?? null;
  }

  /** Whether a page reads as trashed: it is, or it is a row whose database page is. */
  private async readsTrashed(tx: IDBTransaction, page: PageRecord): Promise<boolean> {
    if (page.trashedAt) return true;
    if (page.kind !== 'row') return false;
    const db = this.pageOf(
      (await request(tx.objectStore(S.pages).get((page as RowRecord).databaseId))) as PageRow,
    );
    return !!db?.trashedAt;
  }

  // Search -------------------------------------------------------------------------------------

  async putSearchEntry(entry: SearchEntry): Promise<void> {
    const tx = this.tx([S.search], 'readwrite');
    tx.objectStore(S.search).put(entry);
    await done(tx);
    this.index?.put(entry);
  }

  async deleteSearchEntries(pageIds: Id[]): Promise<void> {
    const tx = this.tx([S.search], 'readwrite');
    for (const id of pageIds) tx.objectStore(S.search).delete(id);
    await done(tx);
    this.index?.remove(pageIds);
  }

  /** A scan of the workspace's entries; the browser's search worker keeps them in memory (M1.8). */
  async search(workspaceId: Id, normalisedQuery: string, limit: number): Promise<SearchHit[]> {
    const terms = searchTerms(normalisedQuery);
    if (!terms.length) return [];
    if (this.index) {
      // The worker ranks; this side drops the trash and writes the snippets.
      const found = await this.index.search(workspaceId, normalisedQuery, limit * 2);
      const tx = this.tx([S.pages, S.rows]);
      const hits: SearchHit[] = [];
      for (const hit of found) {
        const page = await this.pageOrRow(tx, hit.pageId);
        if (!page || (await this.readsTrashed(tx, page))) continue;
        const inTitle = terms.every((t) => hit.title.split(' ').some((w) => w.startsWith(t)));
        hits.push({
          pageId: hit.pageId,
          title: page.title,
          snippet: inTitle ? '' : snippet(hit.text, normalisedQuery),
          score: (inTitle ? 2 : 1) + hit.score / 1000,
        });
        if (hits.length >= limit) break;
      }
      return hits.sort((a, b) => b.score - a.score);
    }
    const tx = this.tx([S.search, S.pages, S.rows]);
    const entries = await getAll<SearchEntry>(
      tx.objectStore(S.search).index('workspace'),
      workspaceId,
    );
    const hits: SearchHit[] = [];
    for (const entry of entries) {
      const words = `${entry.title} ${entry.text}`.split(' ');
      if (!terms.every((t) => words.some((w) => w.startsWith(t)))) continue;
      const page = await this.pageOrRow(tx, entry.pageId);
      if (!page || (await this.readsTrashed(tx, page))) continue;
      const inTitle = terms.every((t) => entry.title.split(' ').some((w) => w.startsWith(t)));
      hits.push({
        pageId: entry.pageId,
        title: page.title,
        snippet: inTitle ? '' : snippet(entry.text, normalisedQuery),
        score: inTitle ? 2 : 1,
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // Assets -------------------------------------------------------------------------------------

  async putAsset(asset: AssetRecord, bytes: Uint8Array): Promise<void> {
    const tx = this.tx([S.assets, S.assetBytes], 'readwrite');
    tx.objectStore(S.assets).put(asset);
    tx.objectStore(S.assetBytes).put(own(bytes), asset.id);
    await done(tx);
  }

  async getAssetBytes(assetId: Id): Promise<Uint8Array | null> {
    return (
      ((await request(this.tx([S.assetBytes]).objectStore(S.assetBytes).get(assetId))) as
        Uint8Array | undefined) ?? null
    );
  }

  async pendingAssets(limit: number): Promise<AssetRecord[]> {
    if (limit <= 0) return [];
    const tx = this.tx([S.workspaces, S.assets, S.assetBytes]);
    const syncing = (await getAll<WorkspaceRecord>(tx.objectStore(S.workspaces)))
      .filter((w) => !w.localOnly)
      .map((w) => w.id);
    const waiting = (
      await Promise.all(
        syncing.map((id) => getAll<AssetRecord>(tx.objectStore(S.assets).index('workspace'), id)),
      )
    )
      .flat()
      .filter((asset) => !asset.uploaded)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const held = await Promise.all(
      waiting.map((asset) => request(tx.objectStore(S.assetBytes).count(asset.id))),
    );
    return waiting.filter((_, i) => held[i] > 0).slice(0, limit);
  }

  async markAssetUploaded(assetId: Id): Promise<void> {
    const tx = this.tx([S.assets], 'readwrite');
    const asset = (await request(tx.objectStore(S.assets).get(assetId))) as AssetRecord | undefined;
    if (asset) tx.objectStore(S.assets).put({ ...asset, uploaded: true });
    await done(tx);
  }

  // Preferences, housekeeping ------------------------------------------------------------------

  async getPref<T>(key: string): Promise<T | undefined> {
    return (await request(this.tx([S.prefs]).objectStore(S.prefs).get(key))) as T | undefined;
  }

  async setPref(key: string, value: unknown): Promise<void> {
    const tx = this.tx([S.prefs], 'readwrite');
    tx.objectStore(S.prefs).put(value, key);
    await done(tx);
  }

  // Offline (store schema 3) -------------------------------------------------------------------

  async pin(pin: PinRecord): Promise<void> {
    const tx = this.tx([S.pins], 'readwrite');
    tx.objectStore(S.pins).put(pin);
    await done(tx);
  }

  async unpin(pageId: Id): Promise<void> {
    const tx = this.tx([S.pins], 'readwrite');
    tx.objectStore(S.pins).delete(pageId);
    await done(tx);
  }

  /** In page order: the index keeps a workspace's pins by their key. */
  async pins(workspaceId: Id): Promise<PinRecord[]> {
    return getAll<PinRecord>(this.tx([S.pins]).objectStore(S.pins).index('workspace'), workspaceId);
  }

  /**
   * Pages with a cursor or an update are held; the rest only if their log has a snapshot, which
   * the `covers` index finds without reading one (a snapshot covering nothing is read to know).
   */
  async heldPages(workspaceId: Id): Promise<Id[]> {
    const tx = this.tx([S.pages, S.rows, S.docLogs, S.docUpdates, S.docCursors]);
    const logs = tx.objectStore(S.docLogs);
    const [pageIds, cursors, withLog, covering] = await Promise.all([
      this.workspacePageIds(tx, workspaceId),
      getAllKeys(tx.objectStore(S.docCursors)) as Promise<Id[]>,
      getAllKeys(logs) as Promise<Id[]>,
      getAllKeys(logs.index('covers'), IDBKeyRange.lowerBound(1)) as Promise<Id[]>,
    ]);
    const held = new Set([...cursors, ...covering]);
    const logged = new Set(withLog);
    const found = await Promise.all(
      pageIds.map(async (pageId) => {
        if (held.has(pageId)) return true;
        if (!logged.has(pageId)) return false;
        if ((await request(tx.objectStore(S.docUpdates).count(pageRange(pageId)))) > 0) return true;
        return !!((await request(logs.get(pageId))) as DocLog | undefined)?.snapshot;
      }),
    );
    return pageIds.filter((_, i) => found[i]).sort();
  }

  /**
   * Reads the workspace's documents one page at a time, so a large workspace is never in memory
   * at once. Assets count by their records' sizes (their bytes are not read).
   */
  async storageUsage(workspaceId: Id): Promise<StorageUsage> {
    const tx = this.tx([
      S.pages,
      S.rows,
      S.docLogs,
      S.docUpdates,
      S.docCursors,
      S.assets,
      S.assetBytes,
      S.history,
      S.quarantine,
    ]);
    const usage: StorageUsage = {
      pages: 0,
      docBytes: 0,
      assetBytes: 0,
      historyBytes: 0,
      quarantineBytes: 0,
    };
    const pageIds = await this.workspacePageIds(tx, workspaceId);
    for (const pageId of pageIds) {
      const [log, rows, cursor] = await Promise.all([
        request(tx.objectStore(S.docLogs).get(pageId)) as Promise<DocLog | undefined>,
        getAll<UpdateRow>(tx.objectStore(S.docUpdates), pageRange(pageId)),
        request(tx.objectStore(S.docCursors).count(pageId)),
      ]);
      if (log?.snapshot || rows.length || cursor) usage.pages++;
      usage.docBytes +=
        (log?.snapshot?.byteLength ?? 0) + rows.reduce((n, row) => n + row.data.byteLength, 0);
    }
    const mine = new Set(pageIds);
    const [assets, history, entries] = await Promise.all([
      getAll<AssetRecord>(tx.objectStore(S.assets).index('workspace'), workspaceId),
      getAll<HistoryEntry>(tx.objectStore(S.history)),
      getAll<QuarantineEntry>(tx.objectStore(S.quarantine).index('workspace'), workspaceId),
    ]);
    const held = await Promise.all(
      assets.map((asset) => request(tx.objectStore(S.assetBytes).count(asset.id))),
    );
    assets.forEach((asset, i) => {
      if (held[i]) usage.assetBytes += asset.sizeBytes;
    });
    for (const entry of history) if (mine.has(entry.pageId)) usage.historyBytes += entry.sizeBytes;
    for (const entry of entries)
      usage.quarantineBytes += entry.parts.reduce((n, part) => n + part.byteLength, 0);
    return usage;
  }

  /**
   * The page's log into a pending entry and its unsent updates out of the log, inside `tx`; null,
   * and nothing written, when the page is not one of a synced workspace or nothing is unsent.
   */
  private async setAside(
    tx: IDBTransaction,
    pageId: Id,
    reason: string,
  ): Promise<QuarantineEntry | null> {
    const page = await this.pageOrRow(tx, pageId);
    if (!page) return null;
    const [workspace, log, rows] = await Promise.all([
      request(tx.objectStore(S.workspaces).get(page.workspaceId)) as Promise<
        WorkspaceRecord | undefined
      >,
      request(tx.objectStore(S.docLogs).get(pageId)) as Promise<DocLog | undefined>,
      getAll<UpdateRow>(tx.objectStore(S.docUpdates), pageRange(pageId)),
    ]);
    if (!workspace || workspace.localOnly || !rows.some((row) => row.seq === null)) return null;
    const entry: QuarantineEntry = {
      id: uuidv7(),
      workspaceId: page.workspaceId,
      pageId,
      title: page.title,
      reason,
      at: new Date().toISOString(),
      parts: [...(log?.snapshot ? [log.snapshot] : []), ...rows.map((row) => row.data)],
      status: 'pending',
      recoveredPageId: null,
    };
    tx.objectStore(S.quarantine).add(entry);
    for (const row of rows)
      if (row.seq === null) tx.objectStore(S.docUpdates).delete([pageId, row.localSeq]);
    tx.objectStore(S.unsentPages).delete(pageId);
    return entry;
  }

  async setAsideDoc(pageId: Id, reason: string): Promise<QuarantineEntry | null> {
    return this.transact(SET_ASIDE_STORES, (tx) => this.setAside(tx, pageId, reason));
  }

  async quarantine(workspaceId: Id | null): Promise<QuarantineEntry[]> {
    const store = this.tx([S.quarantine]).objectStore(S.quarantine);
    const entries =
      workspaceId === null
        ? await getAll<QuarantineEntry>(store)
        : await getAll<QuarantineEntry>(store.index('workspace'), workspaceId);
    return entries.sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  async settleQuarantine(
    id: Id,
    status: 'recovered' | 'dismissed',
    recoveredPageId: Id | null = null,
  ): Promise<void> {
    await this.transact([S.quarantine], async (tx) => {
      const store = tx.objectStore(S.quarantine);
      const entry = (await request(store.get(id))) as QuarantineEntry | undefined;
      if (entry)
        store.put({ ...entry, status, recoveredPageId: recoveredPageId ?? entry.recoveredPageId });
    });
  }

  async repairState(pageId: Id): Promise<RepairState | null> {
    return (
      ((await request(this.tx([S.repairs]).objectStore(S.repairs).get(pageId))) as
        RepairState | undefined) ?? null
    );
  }

  async setRepairState(state: RepairState): Promise<void> {
    const tx = this.tx([S.repairs], 'readwrite');
    tx.objectStore(S.repairs).put(state);
    await done(tx);
  }

  // Databases (store schema 4) ----------------------------------------------------------------

  /** By row id: the index keeps a database's rows by their key. */
  async readRows(databaseId: Id): Promise<RowRecord[]> {
    return getAll<RowRecord>(this.tx([S.rows]).objectStore(S.rows).index('database'), databaseId);
  }

  /** Newest first; only rows in the trash are in the index. */
  async trashedRows(workspaceId: Id): Promise<RowRecord[]> {
    return (await this.trashRows(this.tx([S.rows]), workspaceId)).sort((a, b) =>
      a.trashedAt! < b.trashedAt! ? 1 : -1,
    );
  }

  private async trashRows(tx: IDBTransaction, workspaceId: Id): Promise<RowRecord[]> {
    return (await getAll<RowRecord>(tx.objectStore(S.rows).index('trashRoot'))).filter(
      (r) => r.workspaceId === workspaceId && r.trashRootId === r.id,
    );
  }

  async dbHold(databaseId: Id): Promise<DbHold | null> {
    return (
      ((await request(this.tx([S.dbHolds]).objectStore(S.dbHolds).get(databaseId))) as
        DbHold | undefined) ?? null
    );
  }

  /** In database order: the index keeps a workspace's holds by their key. */
  async dbHolds(workspaceId: Id): Promise<DbHold[]> {
    return getAll<DbHold>(
      this.tx([S.dbHolds]).objectStore(S.dbHolds).index('workspace'),
      workspaceId,
    );
  }

  async holdDatabase(hold: DbHold): Promise<void> {
    const tx = this.tx([S.dbHolds], 'readwrite');
    tx.objectStore(S.dbHolds).put(hold);
    await done(tx);
  }

  async purgeTrash(workspaceId: Id, before: string): Promise<Id[]> {
    const deleted = await this.transact(PLAN_STORES, async (tx) => {
      // Trash roots (pages, and rows that are their own), newest first, as the memory store takes them.
      const pages = (
        await getAll<PageRow>(tx.objectStore(S.pages).index('workspace'), workspaceId)
      ).filter((p) => p.trashRootId === p.id);
      const roots = [...pages, ...(await this.trashRows(tx, workspaceId))]
        .filter((p) => p.trashedAt! < before)
        .sort((a, b) => (a.trashedAt! < b.trashedAt! ? 1 : -1));
      if (!roots.length) return [];
      const ops = roots.map((p): Operation => ({
        opId: uuidv7(),
        type: 'page.delete',
        workspaceId,
        entityId: p.id,
        baseVersion: null,
        payload: {},
        createdAt: new Date().toISOString(),
      }));
      const plan = await planOps(ops, this.reader(tx));
      await this.writePlan(tx, plan);
      return [...plan.deletePages, ...plan.deleteRows];
    });
    this.index?.remove(deleted);
    return deleted;
  }

  async schemaVersion(): Promise<number> {
    return (
      ((await request(this.tx([S.meta]).objectStore(S.meta).get('schemaVersion'))) as
        number | undefined) ?? 0
    );
  }

  async close(): Promise<void> {
    this.index?.close();
    this.db.close();
  }

  /** Asks the browser not to evict this origin's data; false when it refuses (shown to the user). */
  static async persist(): Promise<boolean> {
    try {
      if (await navigator.storage?.persisted?.()) return true;
      return (await navigator.storage?.persist?.()) ?? false;
    } catch {
      return false;
    }
  }
}
