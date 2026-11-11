// The LocalStore on IndexedDB (D11). Every method is one transaction; applyLocalOps plans and
// writes inside the same transaction, so the mirror and the outbox change together or not at all.
import {
  STORE_SCHEMA_VERSION,
  planOps,
  searchTerms,
  snippet,
  uuidv7,
  type AssetRecord,
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
  type SearchEntry,
  type SearchHit,
  type SectionRecord,
  type StoredDoc,
  type StoredUpdate,
  type VisitRecord,
  type WorkspaceRecord,
} from '@cgw/workspace';
import { done, getAll, openDatabase, request } from './idb';

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
} as const;
type StoreName = (typeof S)[keyof typeof S];

interface DocLog {
  pageId: Id;
  nextSeq: number;
  snapshot: Uint8Array | null;
  snapshotCovers: number;
}

interface UpdateRow extends StoredUpdate {
  pageId: Id;
}

/** The stores at schema version 1. Later versions only add (SYNC_DESIGN.md, local migration). */
function upgrade(db: IDBDatabase, oldVersion: number) {
  if (oldVersion < 1) {
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
  }
}

const pageRange = (pageId: Id) => IDBKeyRange.bound([pageId, 0], [pageId, Number.MAX_SAFE_INTEGER]);

/** Bytes are copied into their own buffer: a view into a larger one would store the whole buffer. */
const own = (bytes: Uint8Array) =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();

export class IndexedDbStore implements LocalStore {
  readonly kind = 'indexeddb' as const;

  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory: IDBFactory = indexedDB, name = DATABASE): Promise<IndexedDbStore> {
    const db = await openDatabase(factory, name, STORE_SCHEMA_VERSION, upgrade);
    const store = new IndexedDbStore(db);
    const tx = db.transaction(S.meta, 'readwrite');
    const version = await request(tx.objectStore(S.meta).get('schemaVersion'));
    if (typeof version === 'number' && version > STORE_SCHEMA_VERSION) {
      db.close();
      throw new Error(`This store was written by a newer version (${version}); update the app.`);
    }
    tx.objectStore(S.meta).put(STORE_SCHEMA_VERSION, 'schemaVersion');
    await done(tx);
    return store;
  }

  private tx(names: StoreName[], mode: IDBTransactionMode = 'readonly') {
    return this.db.transaction(names, mode);
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
      updates: rows.map(({ updateId, data, localSeq, seq }) => ({ updateId, data, localSeq, seq })),
    };
  }

  async appendDocUpdates(pageId: Id, updates: LocalUpdate[]): Promise<number[]> {
    const tx = this.tx([S.docLogs, S.docUpdates], 'readwrite');
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
    await done(tx);
    return seqs;
  }

  async compactDoc(pageId: Id, snapshot: Uint8Array, coversLocalUpTo: number): Promise<void> {
    const tx = this.tx([S.docLogs, S.docUpdates], 'readwrite');
    const logs = tx.objectStore(S.docLogs);
    const log = ((await request(logs.get(pageId))) as DocLog | undefined) ?? {
      pageId,
      nextSeq: coversLocalUpTo + 1,
      snapshot: null,
      snapshotCovers: 0,
    };
    log.snapshot = own(snapshot);
    log.snapshotCovers = Math.max(log.snapshotCovers, coversLocalUpTo);
    log.nextSeq = Math.max(log.nextSeq, coversLocalUpTo + 1);
    logs.put(log);
    tx.objectStore(S.docUpdates).delete(IDBKeyRange.bound([pageId, 0], [pageId, coversLocalUpTo]));
    await done(tx);
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
    const tx = this.tx(
      [
        S.workspaces,
        S.sections,
        S.pages,
        S.favourites,
        S.visits,
        S.outbox,
        S.docLogs,
        S.docUpdates,
        S.history,
        S.historyBytes,
        S.search,
      ],
      'readwrite',
    );
    const committed = done(tx);
    try {
      const plan = await planOps(ops, this.reader(tx));
      for (const w of plan.workspaces) tx.objectStore(S.workspaces).put(w);
      for (const s of plan.sections) tx.objectStore(S.sections).put(s);
      for (const id of plan.deleteSections) tx.objectStore(S.sections).delete(id);
      for (const p of plan.pages) tx.objectStore(S.pages).put(this.pageRow(p));
      for (const f of plan.favourites) tx.objectStore(S.favourites).put(f);
      for (const f of plan.deleteFavourites)
        tx.objectStore(S.favourites).delete([f.workspaceId, f.pageId]);
      for (const v of plan.visits) tx.objectStore(S.visits).put(v);
      for (const v of plan.deleteVisits) tx.objectStore(S.visits).delete([v.workspaceId, v.pageId]);
      for (const op of plan.outbox) tx.objectStore(S.outbox).add(op);
      for (const pageId of plan.deletePages) await this.dropPageData(tx, pageId);
    } catch (error) {
      tx.abort();
      await committed.catch(() => undefined);
      throw error;
    }
    await committed;
  }

  /** IndexedDB cannot index null: a top-level page is stored with an empty parent key. */
  private pageRow(page: PageRecord) {
    return { ...page, parentPageId: page.parentPageId ?? '' };
  }

  private pageOf(row: (PageRecord & { parentPageId: string }) | undefined): PageRecord | undefined {
    return row ? { ...row, parentPageId: row.parentPageId || null } : undefined;
  }

  private async dropPageData(tx: IDBTransaction, pageId: Id) {
    tx.objectStore(S.pages).delete(pageId);
    tx.objectStore(S.docLogs).delete(pageId);
    tx.objectStore(S.docUpdates).delete(pageRange(pageId));
    tx.objectStore(S.search).delete(pageId);
    const entries = await getAll<HistoryEntry>(tx.objectStore(S.history).index('page'), pageId);
    for (const entry of entries) {
      tx.objectStore(S.history).delete(entry.id);
      tx.objectStore(S.historyBytes).delete(entry.id);
    }
  }

  private reader(tx: IDBTransaction): MirrorReader {
    const pages = tx.objectStore(S.pages);
    return {
      workspace: async (id) =>
        (await request(tx.objectStore(S.workspaces).get(id))) as WorkspaceRecord | undefined,
      section: async (id) =>
        (await request(tx.objectStore(S.sections).get(id))) as SectionRecord | undefined,
      page: async (id) =>
        this.pageOf((await request(pages.get(id))) as PageRecord & { parentPageId: string }),
      children: async (parentPageId) =>
        (
          await getAll<PageRecord & { parentPageId: string }>(pages.index('parent'), parentPageId)
        ).map((p) => this.pageOf(p)!),
      sectionPages: async (sectionId) =>
        (
          await getAll<PageRecord & { parentPageId: string }>(pages.index('section'), sectionId)
        ).map((p) => this.pageOf(p)!),
      favourite: async (workspaceId, pageId) =>
        (await request(tx.objectStore(S.favourites).get([workspaceId, pageId]))) as
          FavouriteRecord | undefined,
    };
  }

  async nextOutboxBatch(limit: number): Promise<Operation[]> {
    const ops: Operation[] = [];
    const tx = this.tx([S.outbox]);
    await new Promise<void>((resolve, reject) => {
      const cursor = tx.objectStore(S.outbox).openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c || ops.length >= limit) return resolve();
        ops.push(c.value as Operation);
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
    return ops;
  }

  async settleOps(results: OpResult[]): Promise<void> {
    const settled = new Set(results.map((r) => r.opId));
    const tx = this.tx([S.outbox], 'readwrite');
    await new Promise<void>((resolve, reject) => {
      const cursor = tx.objectStore(S.outbox).openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return resolve();
        if (settled.has((c.value as Operation).opId)) c.delete();
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
    await done(tx);
  }

  async readMirror(workspaceId: Id | null): Promise<MirrorSnapshot> {
    const tx = this.tx([S.workspaces, S.sections, S.pages, S.favourites, S.visits, S.assets]);
    const scoped = <T>(name: StoreName) =>
      workspaceId === null
        ? getAll<T>(tx.objectStore(name))
        : getAll<T>(tx.objectStore(name).index('workspace'), workspaceId);
    const [workspaces, sections, pages, favourites, visits, assets] = await Promise.all([
      workspaceId === null
        ? getAll<WorkspaceRecord>(tx.objectStore(S.workspaces))
        : request(tx.objectStore(S.workspaces).get(workspaceId)).then((w) =>
            w ? [w as WorkspaceRecord] : [],
          ),
      scoped<SectionRecord>(S.sections),
      scoped<PageRecord & { parentPageId: string }>(S.pages),
      scoped<FavouriteRecord>(S.favourites),
      scoped<VisitRecord>(S.visits),
      scoped<AssetRecord>(S.assets),
    ]);
    return {
      workspaces,
      sections,
      pages: pages.map((p) => this.pageOf(p)!),
      favourites,
      visits,
      assets,
    };
  }

  async getPage(pageId: Id): Promise<PageRecord | null> {
    const row = (await request(this.tx([S.pages]).objectStore(S.pages).get(pageId))) as
      (PageRecord & { parentPageId: string }) | undefined;
    return this.pageOf(row) ?? null;
  }

  // Search -------------------------------------------------------------------------------------

  async putSearchEntry(entry: SearchEntry): Promise<void> {
    const tx = this.tx([S.search], 'readwrite');
    tx.objectStore(S.search).put(entry);
    await done(tx);
  }

  async deleteSearchEntries(pageIds: Id[]): Promise<void> {
    const tx = this.tx([S.search], 'readwrite');
    for (const id of pageIds) tx.objectStore(S.search).delete(id);
    await done(tx);
  }

  /** A scan of the workspace's entries; the browser's search worker keeps them in memory (M1.8). */
  async search(workspaceId: Id, normalisedQuery: string, limit: number): Promise<SearchHit[]> {
    const terms = searchTerms(normalisedQuery);
    if (!terms.length) return [];
    const tx = this.tx([S.search, S.pages]);
    const entries = await getAll<SearchEntry>(
      tx.objectStore(S.search).index('workspace'),
      workspaceId,
    );
    const hits: SearchHit[] = [];
    for (const entry of entries) {
      const words = `${entry.title} ${entry.text}`.split(' ');
      if (!terms.every((t) => words.some((w) => w.startsWith(t)))) continue;
      const page = this.pageOf(
        (await request(tx.objectStore(S.pages).get(entry.pageId))) as PageRecord & {
          parentPageId: string;
        },
      );
      if (!page || page.trashedAt) continue;
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

  // Assets, preferences, housekeeping ----------------------------------------------------------

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

  async getPref<T>(key: string): Promise<T | undefined> {
    return (await request(this.tx([S.prefs]).objectStore(S.prefs).get(key))) as T | undefined;
  }

  async setPref(key: string, value: unknown): Promise<void> {
    const tx = this.tx([S.prefs], 'readwrite');
    tx.objectStore(S.prefs).put(value, key);
    await done(tx);
  }

  async purgeTrash(workspaceId: Id, before: string): Promise<Id[]> {
    const pages = (
      await getAll<PageRecord>(
        this.tx([S.pages]).objectStore(S.pages).index('workspace'),
        workspaceId,
      )
    ).filter((p) => p.trashRootId === p.id && p.trashedAt! < before);
    if (!pages.length) return [];
    const ops = pages.map((p): Operation => ({
      opId: uuidv7(),
      type: 'page.delete',
      workspaceId,
      entityId: p.id,
      baseVersion: null,
      payload: {},
      createdAt: new Date().toISOString(),
    }));
    const before_ = new Set((await this.readMirror(workspaceId)).pages.map((p) => p.id));
    await this.applyLocalOps(ops);
    const after = new Set((await this.readMirror(workspaceId)).pages.map((p) => p.id));
    return [...before_].filter((id) => !after.has(id));
  }

  async schemaVersion(): Promise<number> {
    return (
      ((await request(this.tx([S.meta]).objectStore(S.meta).get('schemaVersion'))) as
        number | undefined) ?? 0
    );
  }

  async close(): Promise<void> {
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
