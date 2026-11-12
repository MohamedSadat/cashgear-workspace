// A LocalStore held in memory: the reference the conformance suite is written against, the store
// unit tests use, and what a page uses when nothing may be kept (a read-only preview).
import type { Id } from './ids';
import { uuidv7 } from './ids';
import { Mirror } from './mirror';
import { planOps, type Plan } from './ops';
import { emptyPlan, planRemote, planSettle, type RemoteReader } from './remote';
import { snippet, searchTerms } from './search';
import {
  STORE_SCHEMA_VERSION,
  type AssetRecord,
  type DbHold,
  type DocAck,
  type DocCursor,
  type HistoryEntry,
  type LocalStore,
  type LocalUpdate,
  type MirrorSnapshot,
  type Operation,
  type OpResult,
  type PageRecord,
  type PinRecord,
  type QuarantineEntry,
  type RemoteBatch,
  type RepairState,
  type RemoteDocPull,
  type RowRecord,
  type SearchEntry,
  type SearchHit,
  type StorageUsage,
  type StoredDoc,
  type StoredUpdate,
  type UnsentDoc,
} from './types';

interface DocLog {
  snapshot: Uint8Array | null;
  snapshotCovers: number;
  nextSeq: number;
  updates: StoredUpdate[];
}

const copy = (bytes: Uint8Array) => new Uint8Array(bytes);

export class MemoryStore implements LocalStore {
  readonly kind = 'memory' as const;
  private readonly mirror = new Mirror();
  private readonly docs = new Map<Id, DocLog>();
  private readonly corrupt: { pageId: Id; update: StoredUpdate; reason: string }[] = [];
  private readonly history = new Map<Id, { entry: HistoryEntry; data: Uint8Array }>();
  private readonly outbox: Operation[] = [];
  private readonly search_ = new Map<Id, SearchEntry>();
  private readonly assetBytes = new Map<Id, Uint8Array>();
  private readonly prefs = new Map<string, unknown>();
  private readonly syncCursors = new Map<Id, number>();
  private readonly docCursors_ = new Map<Id, DocCursor>();
  private readonly pins_ = new Map<Id, PinRecord>();
  private readonly quarantine_: QuarantineEntry[] = [];
  private readonly repairs = new Map<Id, RepairState>();
  private readonly holds_ = new Map<Id, DbHold>();
  /** Serialises calls, as a database transaction would. */
  private queue: Promise<unknown> = Promise.resolve();

  private run<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private log(pageId: Id): DocLog {
    let log = this.docs.get(pageId);
    if (!log)
      this.docs.set(pageId, (log = { snapshot: null, snapshotCovers: 0, nextSeq: 1, updates: [] }));
    return log;
  }

  loadDoc(pageId: Id): Promise<StoredDoc> {
    return this.run(() => {
      const log = this.docs.get(pageId);
      if (!log) return { snapshot: null, snapshotCovers: 0, updates: [] };
      return {
        snapshot: log.snapshot && copy(log.snapshot),
        snapshotCovers: log.snapshotCovers,
        updates: log.updates.map((u) => ({ ...u, data: copy(u.data) })),
      };
    });
  }

  appendDocUpdates(pageId: Id, updates: LocalUpdate[]): Promise<number[]> {
    return this.run(() => {
      const log = this.log(pageId);
      return updates.map((u) => {
        const localSeq = log.nextSeq++;
        log.updates.push({ updateId: u.updateId, data: copy(u.data), localSeq, seq: null });
        return localSeq;
      });
    });
  }

  compactDoc(pageId: Id, snapshot: Uint8Array, coversLocalUpTo: number): Promise<void> {
    return this.run(() => {
      const log = this.log(pageId);
      const keepUnsent = this.synced(pageId);
      log.snapshot = copy(snapshot);
      log.snapshotCovers = Math.max(log.snapshotCovers, coversLocalUpTo);
      log.updates = log.updates.filter(
        (u) => u.localSeq > coversLocalUpTo || (keepUnsent && u.seq === null),
      );
    });
  }

  /** A page, a database's page or a row. */
  private pageOf(pageId: Id): PageRecord | undefined {
    return this.mirror.pages.get(pageId) ?? this.mirror.rowRecords.get(pageId);
  }

  /** Every page and row of a workspace. */
  private allPages(workspaceId: Id): PageRecord[] {
    return [...this.mirror.pages.values(), ...this.mirror.rowRecords.values()].filter(
      (p) => p.workspaceId === workspaceId,
    );
  }

  /** Whether a page belongs to a workspace that syncs (its unsent updates are kept and pushed). */
  private synced(pageId: Id): boolean {
    const page = this.pageOf(pageId);
    const workspace = page && this.mirror.workspaces.get(page.workspaceId);
    return !!workspace && !workspace.localOnly;
  }

  quarantineUpdates(pageId: Id, localSeqs: number[], reason: string): Promise<void> {
    return this.run(() => {
      const log = this.log(pageId);
      const bad = new Set(localSeqs);
      for (const update of log.updates)
        if (bad.has(update.localSeq)) this.corrupt.push({ pageId, update, reason });
      log.updates = log.updates.filter((u) => !bad.has(u.localSeq));
    });
  }

  docLogLength(pageId: Id): Promise<number> {
    return this.run(() => this.docs.get(pageId)?.updates.length ?? 0);
  }

  addHistory(pageId: Id, snapshot: Uint8Array, keep: number): Promise<HistoryEntry> {
    return this.run(() => {
      const entry: HistoryEntry = {
        id: uuidv7(),
        pageId,
        createdAt: new Date().toISOString(),
        sizeBytes: snapshot.byteLength,
      };
      this.history.set(entry.id, { entry, data: copy(snapshot) });
      const mine = [...this.history.values()]
        .filter((h) => h.entry.pageId === pageId)
        .sort((a, b) => (a.entry.id < b.entry.id ? 1 : -1));
      for (const old of mine.slice(keep)) this.history.delete(old.entry.id);
      return entry;
    });
  }

  listHistory(pageId: Id): Promise<HistoryEntry[]> {
    return this.run(() =>
      [...this.history.values()]
        .map((h) => h.entry)
        .filter((e) => e.pageId === pageId)
        .sort((a, b) => (a.id < b.id ? 1 : -1)),
    );
  }

  getHistory(entryId: Id): Promise<Uint8Array | null> {
    return this.run(() => {
      const found = this.history.get(entryId);
      return found ? copy(found.data) : null;
    });
  }

  applyLocalOp(op: Operation): Promise<void> {
    return this.applyLocalOps([op]);
  }

  applyLocalOps(ops: Operation[]): Promise<void> {
    return this.run(async () => {
      const plan = await planOps(ops, this.mirror);
      this.mirror.apply(plan);
      this.outbox.push(...plan.outbox.map((op) => structuredClone(op)));
      this.writeHolds(plan);
      for (const id of [...plan.deletePages, ...plan.deleteRows]) this.dropPageData(id);
    });
  }

  /** A plan's holds written; a database page that went takes its hold. */
  private writeHolds(plan: Plan) {
    for (const hold of plan.holds) this.holds_.set(hold.databaseId, structuredClone(hold));
    for (const id of plan.deletePages) this.holds_.delete(id);
    for (const id of plan.deleteWorkspaces ?? [])
      for (const [key, hold] of this.holds_) if (hold.workspaceId === id) this.holds_.delete(key);
  }

  private dropPageData(pageId: Id) {
    this.docs.delete(pageId);
    this.docCursors_.delete(pageId);
    this.search_.delete(pageId);
    this.pins_.delete(pageId);
    this.repairs.delete(pageId);
    for (const [id, h] of this.history) if (h.entry.pageId === pageId) this.history.delete(id);
  }

  nextOutboxBatch(limit: number, workspaceId?: Id): Promise<Operation[]> {
    return this.run(() =>
      this.outbox
        .filter((op) => workspaceId === undefined || op.workspaceId === workspaceId)
        .slice(0, limit)
        .map((op) => structuredClone(op)),
    );
  }

  private reader(): RemoteReader {
    return {
      workspace: async (id) => this.mirror.workspaces.get(id),
      workspacePages: async (id) =>
        [...this.mirror.pages.values()].filter((p) => p.workspaceId === id),
      workspaceSections: async (id) => this.mirror.sectionsOf(id),
      pending: async (entityId, except) =>
        this.outbox.some((op) => op.entityId === entityId && !except?.has(op.opId)),
      database: async (id) => this.mirror.databases.get(id),
      workspaceViews: async (id) =>
        [...this.mirror.views.values()].filter((v) => v.workspaceId === id),
      rows: async (id) => this.mirror.rowsOf(id),
      rowIds: async (id) => this.mirror.rowsOf(id).map((r) => r.id),
      workspaceRowIds: async (id) =>
        [...this.mirror.rowRecords.values()].filter((r) => r.workspaceId === id).map((r) => r.id),
      dbHold: async (id) => this.holds_.get(id),
    };
  }

  /** Writes a remote plan: the mirror, the outbox and the cursors together. */
  private writeRemote(plan: Plan) {
    // Nothing unsent goes on the server's word: a removed page's log is set aside first.
    const removed = [...plan.deletePages, ...plan.deleteRows];
    for (const id of removed) this.setAside(id, 'page.removed');
    const settled = new Set(plan.settled ?? []);
    for (let i = this.outbox.length - 1; i >= 0; i--)
      if (settled.has(this.outbox[i].opId)) this.outbox.splice(i, 1);
    for (const id of plan.deleteWorkspaces ?? []) {
      for (let i = this.outbox.length - 1; i >= 0; i--)
        if (this.outbox[i].workspaceId === id) this.outbox.splice(i, 1);
      this.syncCursors.delete(id);
      for (const [assetId, asset] of this.mirror.assets)
        if (asset.workspaceId === id) this.assetBytes.delete(assetId);
    }
    for (const id of removed) this.dropPageData(id);
    this.writeHolds(plan);
    this.mirror.apply(structuredClone(plan));
    if (plan.cursor) this.syncCursors.set(plan.cursor.workspaceId, plan.cursor.value);
  }

  settleOps(results: OpResult[]): Promise<void> {
    return this.run(async () => {
      const ops = new Map(this.outbox.map((op) => [op.opId, op]));
      this.writeRemote(await planSettle(results, ops, this.reader()));
    });
  }

  applyRemote(batch: RemoteBatch): Promise<void> {
    return this.run(async () => this.writeRemote(await planRemote(batch, this.reader())));
  }

  syncCursor(workspaceId: Id): Promise<number | null> {
    return this.run(() => this.syncCursors.get(workspaceId) ?? null);
  }

  beginUpload(workspaceId: Id, accountId: Id, ops: Operation[], replaced?: Id[]): Promise<void> {
    return this.run(() => {
      const workspace = this.mirror.workspaces.get(workspaceId);
      if (!workspace) throw new Error('No such workspace');
      const gone = replaced ? new Set(replaced) : null;
      const kept: Operation[] = [];
      for (let i = this.outbox.length - 1; i >= 0; i--) {
        const op = this.outbox[i];
        if (op.workspaceId !== workspaceId) continue;
        this.outbox.splice(i, 1);
        if (gone && !gone.has(op.opId)) kept.unshift(op);
      }
      this.outbox.push(...ops.map((op) => structuredClone(op)), ...kept);
      const plan = emptyPlan();
      plan.workspaces.push({ ...workspace, localOnly: false, accountId });
      this.mirror.apply(plan);
    });
  }

  unsentDocUpdates(limit: number): Promise<UnsentDoc[]> {
    return this.run(() => {
      const out: UnsentDoc[] = [];
      let left = limit;
      const pending = [...this.docs.entries()]
        .filter(([pageId]) => this.synced(pageId))
        .map(([pageId, log]) => ({ pageId, updates: log.updates.filter((u) => u.seq === null) }))
        .filter((d) => d.updates.length)
        .sort((a, b) => (a.updates[0].updateId < b.updates[0].updateId ? -1 : 1));
      for (const doc of pending) {
        if (left <= 0) break;
        const updates = doc.updates.slice(0, left).map((u) => ({ ...u, data: copy(u.data) }));
        left -= updates.length;
        out.push({ pageId: doc.pageId, updates });
      }
      return out;
    });
  }

  ackDocUpdates(pageId: Id, acks: DocAck[]): Promise<void> {
    return this.run(() => {
      const log = this.docs.get(pageId);
      if (!log) return;
      const bySeq = new Map(acks.map((a) => [a.updateId, a.seq]));
      for (const update of log.updates) {
        const seq = bySeq.get(update.updateId);
        if (seq !== undefined) update.seq = seq;
      }
    });
  }

  applyRemoteDocUpdates(pageId: Id, pull: RemoteDocPull): Promise<StoredUpdate[]> {
    return this.run(() => {
      const log = this.log(pageId);
      const added: StoredUpdate[] = [];
      for (const remote of pull.updates) {
        const mine = remote.updateId
          ? log.updates.find((u) => u.updateId === remote.updateId)
          : undefined;
        if (mine) {
          mine.seq ??= remote.seq;
          continue;
        }
        if (log.updates.some((u) => u.seq === remote.seq)) continue;
        const stored: StoredUpdate = {
          updateId: remote.updateId ?? uuidv7(),
          data: copy(remote.data),
          localSeq: log.nextSeq++,
          seq: remote.seq,
        };
        log.updates.push(stored);
        added.push({ ...stored, data: copy(stored.data) });
      }
      const current = this.docCursors_.get(pageId);
      const kept = current && current.epoch === pull.epoch ? current.headSeq : 0;
      this.docCursors_.set(pageId, { headSeq: Math.max(kept, pull.headSeq), epoch: pull.epoch });
      return added;
    });
  }

  docCursor(pageId: Id): Promise<DocCursor | null> {
    return this.run(() => structuredClone(this.docCursors_.get(pageId) ?? null));
  }

  docCursors(workspaceId: Id): Promise<Record<Id, DocCursor>> {
    return this.run(() => {
      const out: Record<Id, DocCursor> = {};
      for (const [pageId, cursor] of this.docCursors_)
        if (this.pageOf(pageId)?.workspaceId === workspaceId) out[pageId] = { ...cursor };
      return out;
    });
  }

  replaceDoc(pageId: Id, update: LocalUpdate, upTo?: number): Promise<void> {
    return this.run(() => {
      const log = this.log(pageId);
      if (upTo !== undefined && log.snapshotCovers > upTo)
        throw new Error('The page was compacted meanwhile');
      const later = upTo === undefined ? [] : log.updates.filter((u) => u.localSeq > upTo);
      log.snapshot = null;
      log.snapshotCovers = 0;
      // The merged update stands where the last one it replaces stood, before those that follow.
      const localSeq = upTo === undefined ? log.nextSeq++ : upTo;
      log.updates = [
        { updateId: update.updateId, data: copy(update.data), localSeq, seq: null },
        ...later,
      ];
      this.docCursors_.delete(pageId);
    });
  }

  pendingAssets(limit: number): Promise<AssetRecord[]> {
    return this.run(() =>
      [...this.mirror.assets.values()]
        .filter((a) => !a.uploaded && this.assetBytes.has(a.id))
        .filter((a) => {
          const workspace = this.mirror.workspaces.get(a.workspaceId);
          return !!workspace && !workspace.localOnly;
        })
        .slice(0, limit)
        .map((a) => structuredClone(a)),
    );
  }

  markAssetUploaded(assetId: Id): Promise<void> {
    return this.run(() => {
      const asset = this.mirror.assets.get(assetId);
      if (asset) this.mirror.putAsset({ ...asset, uploaded: true });
    });
  }

  readMirror(workspaceId: Id | null): Promise<MirrorSnapshot> {
    return this.run(() => structuredClone(this.mirror.snapshot(workspaceId)));
  }

  getPage(pageId: Id): Promise<PageRecord | null> {
    return this.run(() => structuredClone(this.pageOf(pageId) ?? null));
  }

  /** Whether a page reads as trashed: it is, or it is a row whose database page is. */
  private readsTrashed(page: PageRecord): boolean {
    if (page.trashedAt) return true;
    const row = this.mirror.rowRecords.get(page.id);
    return !!row && !!this.mirror.pages.get(row.databaseId)?.trashedAt;
  }

  putSearchEntry(entry: SearchEntry): Promise<void> {
    return this.run(() => void this.search_.set(entry.pageId, { ...entry }));
  }

  deleteSearchEntries(pageIds: Id[]): Promise<void> {
    return this.run(() => {
      for (const id of pageIds) this.search_.delete(id);
    });
  }

  search(workspaceId: Id, normalisedQuery: string, limit: number): Promise<SearchHit[]> {
    return this.run(() => {
      const terms = searchTerms(normalisedQuery);
      if (!terms.length) return [];
      const hits: SearchHit[] = [];
      for (const entry of this.search_.values()) {
        if (entry.workspaceId !== workspaceId) continue;
        const page = this.pageOf(entry.pageId);
        if (!page || this.readsTrashed(page)) continue;
        const words = `${entry.title} ${entry.text}`.split(' ');
        if (!terms.every((t) => words.some((w) => w.startsWith(t)))) continue;
        const inTitle = terms.every((t) => entry.title.split(' ').some((w) => w.startsWith(t)));
        hits.push({
          pageId: entry.pageId,
          title: page.title,
          snippet: inTitle ? '' : snippet(entry.text, normalisedQuery),
          score: inTitle ? 2 : 1,
        });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    });
  }

  putAsset(asset: AssetRecord, bytes: Uint8Array): Promise<void> {
    return this.run(() => {
      this.mirror.putAsset(structuredClone(asset));
      this.assetBytes.set(asset.id, copy(bytes));
    });
  }

  getAssetBytes(assetId: Id): Promise<Uint8Array | null> {
    return this.run(() => {
      const bytes = this.assetBytes.get(assetId);
      return bytes ? copy(bytes) : null;
    });
  }

  getPref<T>(key: string): Promise<T | undefined> {
    return this.run(() => structuredClone(this.prefs.get(key)) as T | undefined);
  }

  setPref(key: string, value: unknown): Promise<void> {
    return this.run(() => void this.prefs.set(key, structuredClone(value)));
  }

  // Offline (store schema 3) ------------------------------------------------------------------

  pin(pin: PinRecord): Promise<void> {
    return this.run(() => void this.pins_.set(pin.pageId, { ...pin }));
  }

  unpin(pageId: Id): Promise<void> {
    return this.run(() => void this.pins_.delete(pageId));
  }

  pins(workspaceId: Id): Promise<PinRecord[]> {
    return this.run(() =>
      [...this.pins_.values()]
        .filter((p) => p.workspaceId === workspaceId)
        .sort((a, b) => (a.pageId < b.pageId ? -1 : 1))
        .map((p) => ({ ...p })),
    );
  }

  /** Whether this device holds the page's document: a log, a snapshot or a cursor. */
  private holds(pageId: Id): boolean {
    const log = this.docs.get(pageId);
    return (!!log && (!!log.snapshot || log.updates.length > 0)) || this.docCursors_.has(pageId);
  }

  heldPages(workspaceId: Id): Promise<Id[]> {
    return this.run(() =>
      this.allPages(workspaceId)
        .filter((p) => this.holds(p.id))
        .map((p) => p.id)
        .sort(),
    );
  }

  storageUsage(workspaceId: Id): Promise<StorageUsage> {
    return this.run(() => {
      const usage: StorageUsage = {
        pages: 0,
        docBytes: 0,
        assetBytes: 0,
        historyBytes: 0,
        quarantineBytes: 0,
      };
      for (const page of this.allPages(workspaceId)) {
        const log = this.docs.get(page.id);
        if (this.holds(page.id)) usage.pages++;
        if (log)
          usage.docBytes +=
            (log.snapshot?.byteLength ?? 0) +
            log.updates.reduce((n, u) => n + u.data.byteLength, 0);
      }
      for (const [assetId, bytes] of this.assetBytes)
        if (this.mirror.assets.get(assetId)?.workspaceId === workspaceId)
          usage.assetBytes += bytes.byteLength;
      for (const h of this.history.values())
        if (this.pageOf(h.entry.pageId)?.workspaceId === workspaceId)
          usage.historyBytes += h.data.byteLength;
      for (const entry of this.quarantine_)
        if (entry.workspaceId === workspaceId)
          usage.quarantineBytes += entry.parts.reduce((n, p) => n + p.byteLength, 0);
      return usage;
    });
  }

  /** The page's log into a pending entry, its unsent updates out of the log; null if none. */
  private setAside(pageId: Id, reason: string): QuarantineEntry | null {
    const log = this.docs.get(pageId);
    const page = this.pageOf(pageId);
    if (!log || !page || !this.synced(pageId) || !log.updates.some((u) => u.seq === null))
      return null;
    const entry: QuarantineEntry = {
      id: uuidv7(),
      workspaceId: page.workspaceId,
      pageId,
      title: page.title,
      reason,
      at: new Date().toISOString(),
      parts: [
        ...(log.snapshot ? [copy(log.snapshot)] : []),
        ...log.updates.map((u) => copy(u.data)),
      ],
      status: 'pending',
      recoveredPageId: null,
    };
    this.quarantine_.push(entry);
    log.updates = log.updates.filter((u) => u.seq !== null);
    return structuredClone(entry);
  }

  setAsideDoc(pageId: Id, reason: string): Promise<QuarantineEntry | null> {
    return this.run(() => this.setAside(pageId, reason));
  }

  quarantine(workspaceId: Id | null): Promise<QuarantineEntry[]> {
    return this.run(() =>
      this.quarantine_
        .filter((e) => workspaceId === null || e.workspaceId === workspaceId)
        .sort((a, b) => (a.id < b.id ? 1 : -1))
        .map((e) => structuredClone(e)),
    );
  }

  settleQuarantine(
    id: Id,
    status: 'recovered' | 'dismissed',
    recoveredPageId: Id | null = null,
  ): Promise<void> {
    return this.run(() => {
      const entry = this.quarantine_.find((e) => e.id === id);
      if (!entry) return;
      entry.status = status;
      entry.recoveredPageId = recoveredPageId ?? entry.recoveredPageId;
    });
  }

  repairState(pageId: Id): Promise<RepairState | null> {
    return this.run(() => structuredClone(this.repairs.get(pageId) ?? null));
  }

  setRepairState(state: RepairState): Promise<void> {
    return this.run(() => void this.repairs.set(state.pageId, { ...state }));
  }

  // Databases (store schema 4) ---------------------------------------------------------------

  readRows(databaseId: Id): Promise<RowRecord[]> {
    return this.run(() =>
      this.mirror
        .rowsOf(databaseId)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((r) => structuredClone(r)),
    );
  }

  trashedRows(workspaceId: Id): Promise<RowRecord[]> {
    return this.run(() => this.mirror.trashedRows(workspaceId).map((r) => structuredClone(r)));
  }

  dbHold(databaseId: Id): Promise<DbHold | null> {
    return this.run(() => structuredClone(this.holds_.get(databaseId) ?? null));
  }

  dbHolds(workspaceId: Id): Promise<DbHold[]> {
    return this.run(() =>
      [...this.holds_.values()]
        .filter((h) => h.workspaceId === workspaceId)
        .sort((a, b) => (a.databaseId < b.databaseId ? -1 : 1))
        .map((h) => ({ ...h })),
    );
  }

  holdDatabase(hold: DbHold): Promise<void> {
    return this.run(() => void this.holds_.set(hold.databaseId, { ...hold }));
  }

  purgeTrash(workspaceId: Id, before: string): Promise<Id[]> {
    return this.run(async () => {
      // Trash roots (pages, and rows that are their own), newest first.
      const roots = [...this.mirror.trash(workspaceId), ...this.mirror.trashedRows(workspaceId)]
        .filter((p) => p.trashedAt! < before)
        .sort((a, b) => (a.trashedAt! < b.trashedAt! ? 1 : -1))
        .map((p) => p.id);
      const ops: Operation[] = roots.map((id) => ({
        opId: uuidv7(),
        type: 'page.delete',
        workspaceId,
        entityId: id,
        baseVersion: null,
        payload: {},
        createdAt: new Date().toISOString(),
      }));
      if (!ops.length) return [];
      const plan = await planOps(ops, this.mirror);
      this.mirror.apply(plan);
      this.outbox.push(...ops);
      this.writeHolds(plan);
      const gone = [...plan.deletePages, ...plan.deleteRows];
      for (const id of gone) this.dropPageData(id);
      return gone;
    });
  }

  schemaVersion(): Promise<number> {
    return Promise.resolve(STORE_SCHEMA_VERSION);
  }

  close(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  /** For tests: what the corrupt area holds. */
  corruptUpdates() {
    return this.corrupt.map((c) => ({
      pageId: c.pageId,
      localSeq: c.update.localSeq,
      reason: c.reason,
    }));
  }
}
