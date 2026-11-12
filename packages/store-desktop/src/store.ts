// The desktop's LocalStore: requests to crates/cgw-store over a transport (Tauri's invoke in the
// app; the cgw-store-cli process in tests). Bytes travel as bytes in a binary frame. The tree rules
// are planned here against the in-memory mirror (the desktop app is one instance), and the plan is
// written by the Rust store in one transaction. The server's answers and change feed are planned
// the same way (planSettle, planRemote), against the mirror and an in-memory index of the outbox.
// A remote plan goes with the ids its set-aside entries would take (one per deleted page): the Rust
// store sets aside, in the plan's transaction, the logs it must not drop (schema 3).
//
// Schema 4 (databases): the mirror holds database and view records from the start, but no rows. A
// plan that needs a database's rows (a type change, a relation, a cascade) or a row (an edit) reads
// them from SQLite first and keeps them in the mirror, which every later write keeps in step. The
// holds are read at open and kept beside the mirror, as the outbox index is.
import {
  Mirror,
  STORE_SCHEMA_VERSION,
  emptyPlan,
  planOps,
  planRemote,
  planSettle,
  snippet,
  searchTerms,
  uuidv7,
  type AssetRecord,
  type DbHold,
  type DocAck,
  type DocCursor,
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
  type StorageUsage,
  type StoredDoc,
  type StoredUpdate,
  type UnsentDoc,
} from '@cgw/workspace';
import { decodeFrame, encodeFrame } from './frame';
import { OutboxIndex, type OutboxEntry } from './outbox';

/** Sends one request frame and resolves with the answer frame. */
export type Transport = (frame: Uint8Array) => Promise<Uint8Array>;

export class StoreRequestError extends Error {}

/** A quarantine entry as the Rust store answers it: its parts follow as blobs. */
type EntryHeader = Omit<QuarantineEntry, 'parts'> & { parts?: number };

/** What a remote plan's request carries so the Rust store can set logs aside (applyPlan). */
interface SetAside {
  reason: string;
  at: string;
  /**
   * One new entry id per deleted page, then one per deleted row, in the plan's order; only those
   * set aside are used.
   */
  ids: Id[];
}

export class DesktopStore implements LocalStore {
  readonly kind = 'sqlite' as const;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly transport: Transport,
    private readonly mirror: Mirror,
    private readonly outbox: OutboxIndex,
    /** Every hold, by database: what the remote planners ask (`dbHold`). */
    private readonly holds: Map<Id, DbHold> = new Map(),
  ) {}

  static async open(transport: Transport): Promise<DesktopStore> {
    const probe = new DesktopStore(transport, new Mirror(), new OutboxIndex());
    const version = (await probe.call<number>({ op: 'schemaVersion' })).value;
    if (version > STORE_SCHEMA_VERSION)
      throw new StoreRequestError(
        `This store was written by a newer version (${version}); update the app.`,
      );
    const snapshot = (await probe.call<MirrorSnapshot>({ op: 'readMirror', workspaceId: null }))
      .value;
    const outbox = (await probe.call<OutboxEntry[]>({ op: 'outboxIndex' })).value;
    const holds = (await probe.call<DbHold[]>({ op: 'dbHolds', workspaceId: null })).value;
    return new DesktopStore(
      transport,
      new Mirror(snapshot),
      new OutboxIndex(outbox),
      new Map(holds.map((h) => [h.databaseId, h])),
    );
  }

  private async call<T>(
    header: Record<string, unknown>,
    blobs: Uint8Array[] = [],
  ): Promise<{ value: T; blobs: Uint8Array[] }> {
    const answer = decodeFrame(await this.transport(encodeFrame(header, blobs)));
    const result = answer.header as { ok?: T; error?: string };
    if (result.error !== undefined) throw new StoreRequestError(result.error);
    return { value: result.ok as T, blobs: answer.blobs };
  }

  /** One request at a time, in order: the mirror and the database move together. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Writes a plan in one request, then moves the mirror and the outbox index the same way the Rust
   * store moved the database: answered operations go, lost workspaces' operations go, an upload's
   * creates replace its workspace's operations, and the plan's own operations are added.
   */
  private async write(plan: Plan, setAside?: SetAside): Promise<void> {
    await this.call({ op: 'applyPlan', plan, ...(setAside ? { setAside } : {}) });
    this.mirror.apply(plan);
    for (const hold of plan.holds) this.holds.set(hold.databaseId, hold);
    for (const id of plan.deletePages) this.holds.delete(id);
    for (const id of plan.deleteWorkspaces ?? [])
      for (const [key, hold] of this.holds) if (hold.workspaceId === id) this.holds.delete(key);
    this.outbox.remove(plan.settled ?? []);
    for (const id of plan.deleteWorkspaces ?? []) this.outbox.removeWorkspace(id);
    if (plan.replaceOutbox) {
      const { workspaceId, ops, replaced } = plan.replaceOutbox;
      if (replaced) this.outbox.remove(replaced);
      else this.outbox.removeWorkspace(workspaceId);
      this.outbox.add(ops);
    }
    this.outbox.add(plan.outbox);
  }

  /**
   * A remote plan, written. Its records come from the caller (the server's answers), so the mirror
   * takes copies; and since the Rust store drops a deleted page's favourites and visits with it,
   * the plan drops them from the mirror too. The pages it deletes are set aside first where their
   * logs hold unsent updates (the server's word never drops what was typed here).
   */
  private writeRemote(remote: Plan): Promise<void> {
    const plan = structuredClone(remote);
    const gone = new Set([...plan.deletePages, ...plan.deleteRows]);
    if (gone.size) {
      for (const f of this.mirror.favourites.values())
        if (gone.has(f.pageId))
          plan.deleteFavourites.push({ workspaceId: f.workspaceId, pageId: f.pageId });
      for (const v of this.mirror.visits.values())
        if (gone.has(v.pageId))
          plan.deleteVisits.push({ workspaceId: v.workspaceId, pageId: v.pageId });
    }
    const removed = plan.deletePages.length + plan.deleteRows.length;
    const setAside = removed
      ? {
          reason: 'page.removed',
          at: new Date().toISOString(),
          ids: Array.from({ length: removed }, () => uuidv7()),
        }
      : undefined;
    return this.write(plan, setAside);
  }

  /**
   * Ids SQLite holds no row for. A row reaches SQLite only through a plan this store writes, and
   * every plan's rows enter the mirror, which is asked first: so a miss stays a miss (a page's
   * create asks whether its id is taken, and need not ask SQLite every time).
   */
  private readonly missingRows = new Set<Id>();

  /** A row: from the mirror if a plan already read it, else from SQLite (and kept). */
  private async row(id: Id): Promise<RowRecord | undefined> {
    const known = this.mirror.rowRecords.get(id);
    if (known) return known;
    if (this.missingRows.has(id)) return undefined;
    const row = (await this.call<RowRecord | null>({ op: 'getRow', id })).value;
    if (row) this.mirror.putRow(row);
    else {
      if (this.missingRows.size > 100_000) this.missingRows.clear();
      this.missingRows.add(id);
    }
    return row ?? undefined;
  }

  /** Every row held of a database: read from SQLite the first time a plan needs them. */
  private async rowsOf(databaseId: Id): Promise<RowRecord[]> {
    if (!this.mirror.rowsLoaded(databaseId))
      this.mirror.loadRows(
        databaseId,
        (await this.call<RowRecord[]>({ op: 'readRows', databaseId })).value,
      );
    return this.mirror.rowsOf(databaseId);
  }

  /** What the planners read: the mirror (rows read in as needed), the outbox index, the holds. */
  private reader(): MirrorReader & RemoteReader {
    const mirror = this.mirror;
    return {
      workspace: async (id) => mirror.workspaces.get(id),
      section: async (id) => mirror.sections.get(id),
      page: async (id) => mirror.pages.get(id) ?? (await this.row(id)),
      children: (id) => mirror.children(id),
      sectionPages: (id) => mirror.sectionPages(id),
      favourite: (workspaceId, pageId) => mirror.favourite(workspaceId, pageId),
      database: async (id) => mirror.databases.get(id),
      view: async (id) => mirror.views.get(id),
      rows: (databaseId) => this.rowsOf(databaseId),
      workspacePages: async (id) => [...mirror.pages.values()].filter((p) => p.workspaceId === id),
      workspaceSections: async (id) => mirror.sectionsOf(id),
      workspaceViews: async (id) => [...mirror.views.values()].filter((v) => v.workspaceId === id),
      pending: async (entityId, except) => this.outbox.pending(entityId, except),
      rowIds: async (databaseId) =>
        mirror.rowsLoaded(databaseId)
          ? mirror.rowsOf(databaseId).map((r) => r.id)
          : (await this.call<Id[]>({ op: 'rowIds', databaseId })).value,
      workspaceRowIds: async (workspaceId) =>
        (await this.call<Id[]>({ op: 'rowIds', workspaceId })).value,
      dbHold: async (id) => this.holds.get(id),
    };
  }

  // Documents ----------------------------------------------------------------------------------

  loadDoc(pageId: Id): Promise<StoredDoc> {
    return this.serial(async () => {
      const { value, blobs } = await this.call<{
        hasSnapshot: boolean;
        snapshotCovers: number;
        updates: { updateId: Id; localSeq: number; seq: number | null }[];
      }>({ op: 'loadDoc', pageId });
      const snapshot = value.hasSnapshot ? blobs[0] : null;
      const data = value.hasSnapshot ? blobs.slice(1) : blobs;
      return {
        snapshot,
        snapshotCovers: value.snapshotCovers,
        updates: value.updates.map((u, i) => ({ ...u, data: data[i] })),
      };
    });
  }

  appendDocUpdates(pageId: Id, updates: LocalUpdate[]): Promise<number[]> {
    return this.serial(
      async () =>
        (
          await this.call<number[]>(
            { op: 'appendDocUpdates', pageId, updateIds: updates.map((u) => u.updateId) },
            updates.map((u) => u.data),
          )
        ).value,
    );
  }

  compactDoc(pageId: Id, snapshot: Uint8Array, coversLocalUpTo: number): Promise<void> {
    return this.serial(async () => {
      await this.call({ op: 'compactDoc', pageId, coversLocalUpTo }, [snapshot]);
    });
  }

  quarantineUpdates(pageId: Id, localSeqs: number[], reason: string): Promise<void> {
    return this.serial(async () => {
      await this.call({ op: 'quarantineUpdates', pageId, localSeqs, reason });
    });
  }

  docLogLength(pageId: Id): Promise<number> {
    return this.serial(async () => (await this.call<number>({ op: 'docLogLength', pageId })).value);
  }

  addHistory(pageId: Id, snapshot: Uint8Array, keep: number): Promise<HistoryEntry> {
    const entry = { id: uuidv7(), pageId, createdAt: new Date().toISOString() };
    return this.serial(
      async () =>
        (await this.call<HistoryEntry>({ op: 'addHistory', entry, keep }, [snapshot])).value,
    );
  }

  listHistory(pageId: Id): Promise<HistoryEntry[]> {
    return this.serial(
      async () => (await this.call<HistoryEntry[]>({ op: 'listHistory', pageId })).value,
    );
  }

  getHistory(entryId: Id): Promise<Uint8Array | null> {
    return this.serial(async () => {
      const { value, blobs } = await this.call<boolean>({ op: 'getHistory', id: entryId });
      return value ? blobs[0] : null;
    });
  }

  // Mirror and outbox --------------------------------------------------------------------------

  applyLocalOp(op: Operation): Promise<void> {
    return this.applyLocalOps([op]);
  }

  applyLocalOps(ops: Operation[]): Promise<void> {
    return this.serial(async () => this.write(await planOps(ops, this.reader())));
  }

  nextOutboxBatch(limit: number, workspaceId?: Id): Promise<Operation[]> {
    return this.serial(
      async () =>
        (
          await this.call<Operation[]>({
            op: 'nextOutboxBatch',
            limit,
            workspaceId: workspaceId ?? null,
          })
        ).value,
    );
  }

  readMirror(workspaceId: Id | null): Promise<MirrorSnapshot> {
    return this.serial(async () => structuredClone(this.mirror.snapshot(workspaceId)));
  }

  getPage(pageId: Id): Promise<PageRecord | null> {
    return this.serial(async () =>
      structuredClone(this.mirror.pages.get(pageId) ?? (await this.row(pageId)) ?? null),
    );
  }

  // Sync (store schema 2) ----------------------------------------------------------------------

  settleOps(results: OpResult[]): Promise<void> {
    return this.serial(async () => {
      if (!results.length) return;
      // Only an answer that names an entity needs its operation to be planned.
      const named = results.filter((r) => r.entityType).map((r) => r.opId);
      const answered = named.length
        ? (await this.call<Operation[]>({ op: 'outboxOps', opIds: named })).value
        : [];
      const ops = new Map(answered.map((op) => [op.opId, op]));
      await this.writeRemote(await planSettle(results, ops, this.reader()));
    });
  }

  applyRemote(batch: RemoteBatch): Promise<void> {
    return this.serial(async () => this.writeRemote(await planRemote(batch, this.reader())));
  }

  syncCursor(workspaceId: Id): Promise<number | null> {
    return this.serial(
      async () => (await this.call<number | null>({ op: 'syncCursor', workspaceId })).value,
    );
  }

  beginUpload(workspaceId: Id, accountId: Id, ops: Operation[], replaced?: Id[]): Promise<void> {
    return this.serial(async () => {
      const workspace = this.mirror.workspaces.get(workspaceId);
      if (!workspace) throw new StoreRequestError('No such workspace');
      const plan = emptyPlan();
      plan.workspaces.push({ ...workspace, localOnly: false, accountId });
      plan.replaceOutbox = replaced ? { workspaceId, ops, replaced } : { workspaceId, ops };
      await this.writeRemote(plan);
    });
  }

  unsentDocUpdates(limit: number): Promise<UnsentDoc[]> {
    return this.serial(async () => {
      const { value, blobs } = await this.call<{ pageId: Id; updateId: Id; localSeq: number }[]>({
        op: 'unsentDocUpdates',
        limit,
      });
      // Rows come grouped by page, pages in the order of their oldest unsent update.
      const out: UnsentDoc[] = [];
      value.forEach((row, i) => {
        const update: StoredUpdate = {
          updateId: row.updateId,
          data: blobs[i],
          localSeq: row.localSeq,
          seq: null,
        };
        const last = out[out.length - 1];
        if (last?.pageId === row.pageId) last.updates.push(update);
        else out.push({ pageId: row.pageId, updates: [update] });
      });
      return out;
    });
  }

  ackDocUpdates(pageId: Id, acks: DocAck[]): Promise<void> {
    return this.serial(async () => {
      if (!acks.length) return;
      await this.call({
        op: 'ackDocUpdates',
        pageId,
        acks: acks.map(({ updateId, seq }) => ({ updateId, seq })),
      });
    });
  }

  applyRemoteDocUpdates(pageId: Id, pull: RemoteDocPull): Promise<StoredUpdate[]> {
    return this.serial(async () => {
      // An update the server has no key for is kept under a new one, should it be added.
      const updates = pull.updates.map((u) => ({
        seq: u.seq,
        updateId: u.updateId ?? null,
        id: u.updateId ?? uuidv7(),
      }));
      const added = (
        await this.call<{ index: number; updateId: Id; localSeq: number }[]>(
          {
            op: 'applyRemoteDocUpdates',
            pageId,
            epoch: pull.epoch,
            headSeq: pull.headSeq,
            updates,
          },
          pull.updates.map((u) => u.data),
        )
      ).value;
      return added.map(({ index, updateId, localSeq }) => ({
        updateId,
        data: pull.updates[index].data.slice(),
        localSeq,
        seq: pull.updates[index].seq,
      }));
    });
  }

  docCursor(pageId: Id): Promise<DocCursor | null> {
    return this.serial(
      async () => (await this.call<DocCursor | null>({ op: 'docCursor', pageId })).value,
    );
  }

  docCursors(workspaceId: Id): Promise<Record<Id, DocCursor>> {
    return this.serial(
      async () => (await this.call<Record<Id, DocCursor>>({ op: 'docCursors', workspaceId })).value,
    );
  }

  replaceDoc(pageId: Id, update: LocalUpdate, upTo?: number): Promise<void> {
    return this.serial(async () => {
      await this.call(
        {
          op: 'replaceDoc',
          pageId,
          updateId: update.updateId,
          ...(upTo === undefined ? {} : { upTo }),
        },
        [update.data],
      );
    });
  }

  pendingAssets(limit: number): Promise<AssetRecord[]> {
    return this.serial(
      async () => (await this.call<AssetRecord[]>({ op: 'pendingAssets', limit })).value,
    );
  }

  markAssetUploaded(assetId: Id): Promise<void> {
    return this.serial(async () => {
      const asset = this.mirror.assets.get(assetId);
      if (!asset) return;
      await this.call({ op: 'markAssetUploaded', id: assetId });
      this.mirror.putAsset({ ...asset, uploaded: true });
    });
  }

  // Search (FTS5 over normalised text) ----------------------------------------------------------

  putSearchEntry(entry: SearchEntry): Promise<void> {
    return this.serial(async () => {
      await this.call({ op: 'putSearchEntry', entry });
    });
  }

  deleteSearchEntries(pageIds: Id[]): Promise<void> {
    return this.serial(async () => {
      await this.call({ op: 'deleteSearchEntries', pageIds });
    });
  }

  search(workspaceId: Id, normalisedQuery: string, limit: number): Promise<SearchHit[]> {
    return this.serial(async () => {
      if (!searchTerms(normalisedQuery).length) return [];
      const rows = (
        await this.call<{ pageId: Id; title: string; text: string }[]>({
          op: 'search',
          workspaceId,
          query: normalisedQuery,
          limit,
        })
      ).value;
      const terms = searchTerms(normalisedQuery);
      const hits: SearchHit[] = [];
      for (const row of rows) {
        const inTitle = terms.every((t) => row.title.split(' ').some((w) => w.startsWith(t)));
        // A page's title from the mirror; a row's from its record (read in once).
        const page = this.mirror.pages.get(row.pageId) ?? (await this.row(row.pageId));
        hits.push({
          pageId: row.pageId,
          title: page?.title ?? row.title,
          snippet: inTitle ? '' : snippet(row.text, normalisedQuery),
          score: inTitle ? 2 : 1,
        });
      }
      return hits.sort((a, b) => b.score - a.score);
    });
  }

  // Assets, preferences, housekeeping ----------------------------------------------------------

  putAsset(asset: AssetRecord, bytes: Uint8Array): Promise<void> {
    return this.serial(async () => {
      await this.call({ op: 'putAsset', asset }, [bytes]);
      this.mirror.putAsset(asset);
    });
  }

  getAssetBytes(assetId: Id): Promise<Uint8Array | null> {
    return this.serial(async () => {
      const { value, blobs } = await this.call<boolean>({ op: 'getAssetBytes', id: assetId });
      return value ? blobs[0] : null;
    });
  }

  getPref<T>(key: string): Promise<T | undefined> {
    return this.serial(async () => {
      const value = (await this.call<T | null>({ op: 'getPref', key })).value;
      return value === null ? undefined : value;
    });
  }

  setPref(key: string, value: unknown): Promise<void> {
    return this.serial(async () => {
      await this.call({ op: 'setPref', key, value });
    });
  }

  // Offline (store schema 3) -------------------------------------------------------------------

  pin(pin: PinRecord): Promise<void> {
    return this.serial(async () => {
      await this.call({ op: 'pin', pin });
    });
  }

  unpin(pageId: Id): Promise<void> {
    return this.serial(async () => {
      await this.call({ op: 'unpin', pageId });
    });
  }

  pins(workspaceId: Id): Promise<PinRecord[]> {
    return this.serial(
      async () => (await this.call<PinRecord[]>({ op: 'pins', workspaceId })).value,
    );
  }

  heldPages(workspaceId: Id): Promise<Id[]> {
    return this.serial(async () => (await this.call<Id[]>({ op: 'heldPages', workspaceId })).value);
  }

  storageUsage(workspaceId: Id): Promise<StorageUsage> {
    return this.serial(
      async () => (await this.call<StorageUsage>({ op: 'storageUsage', workspaceId })).value,
    );
  }

  setAsideDoc(pageId: Id, reason: string): Promise<QuarantineEntry | null> {
    return this.serial(async () => {
      const { value, blobs } = await this.call<EntryHeader | null>({
        op: 'setAsideDoc',
        pageId,
        reason,
        id: uuidv7(),
        at: new Date().toISOString(),
      });
      return value && { ...value, parts: blobs };
    });
  }

  quarantine(workspaceId: Id | null): Promise<QuarantineEntry[]> {
    return this.serial(async () => {
      const { value, blobs } = await this.call<EntryHeader[]>({ op: 'quarantine', workspaceId });
      let at = 0;
      return value.map(({ parts = 0, ...entry }) => ({
        ...entry,
        parts: blobs.slice(at, (at += parts)),
      }));
    });
  }

  settleQuarantine(
    id: Id,
    status: 'recovered' | 'dismissed',
    recoveredPageId: Id | null = null,
  ): Promise<void> {
    return this.serial(async () => {
      await this.call({ op: 'settleQuarantine', id, status, recoveredPageId });
    });
  }

  repairState(pageId: Id): Promise<RepairState | null> {
    return this.serial(
      async () => (await this.call<RepairState | null>({ op: 'repairState', pageId })).value,
    );
  }

  setRepairState(state: RepairState): Promise<void> {
    return this.serial(async () => {
      await this.call({ op: 'setRepairState', state });
    });
  }

  // Databases (store schema 4) ----------------------------------------------------------------

  readRows(databaseId: Id): Promise<RowRecord[]> {
    return this.serial(
      async () => (await this.call<RowRecord[]>({ op: 'readRows', databaseId })).value,
    );
  }

  trashedRows(workspaceId: Id): Promise<RowRecord[]> {
    return this.serial(
      async () => (await this.call<RowRecord[]>({ op: 'trashedRows', workspaceId })).value,
    );
  }

  dbHold(databaseId: Id): Promise<DbHold | null> {
    return this.serial(
      async () => (await this.call<DbHold | null>({ op: 'dbHold', databaseId })).value,
    );
  }

  dbHolds(workspaceId: Id): Promise<DbHold[]> {
    return this.serial(
      async () => (await this.call<DbHold[]>({ op: 'dbHolds', workspaceId })).value,
    );
  }

  holdDatabase(hold: DbHold): Promise<void> {
    return this.serial(async () => {
      await this.call({ op: 'holdDatabase', hold });
      this.holds.set(hold.databaseId, structuredClone(hold));
    });
  }

  purgeTrash(workspaceId: Id, before: string): Promise<Id[]> {
    return this.serial(async () => {
      // Trash roots (pages, and rows that are their own), newest first, as the memory store takes them.
      const rows = (await this.call<RowRecord[]>({ op: 'trashedRows', workspaceId })).value;
      const roots = [...this.mirror.trash(workspaceId), ...rows]
        .filter((p) => p.trashedAt! < before)
        .sort((a, b) => (a.trashedAt! < b.trashedAt! ? 1 : -1));
      if (!roots.length) return [];
      const plan = await planOps(
        roots.map((p) => ({
          opId: uuidv7(),
          type: 'page.delete' as const,
          workspaceId,
          entityId: p.id,
          baseVersion: null,
          payload: {},
          createdAt: new Date().toISOString(),
        })),
        this.reader(),
      );
      await this.write(plan);
      return [...plan.deletePages, ...plan.deleteRows];
    });
  }

  schemaVersion(): Promise<number> {
    return this.serial(async () => (await this.call<number>({ op: 'schemaVersion' })).value);
  }

  close(): Promise<void> {
    return this.queue.then(() => undefined);
  }
}
