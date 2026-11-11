// The desktop's LocalStore: requests to crates/cgw-store over a transport (Tauri's invoke in the
// app; the cgw-store-cli process in tests). Bytes travel as bytes in a binary frame. The tree rules
// are planned here against the in-memory mirror (the desktop app is one instance), and the plan is
// written by the Rust store in one transaction. The server's answers and change feed are planned
// the same way (planSettle, planRemote), against the mirror and an in-memory index of the outbox.
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
  type DocAck,
  type DocCursor,
  type HistoryEntry,
  type Id,
  type LocalStore,
  type LocalUpdate,
  type MirrorSnapshot,
  type Operation,
  type OpResult,
  type PageRecord,
  type Plan,
  type RemoteBatch,
  type RemoteDocPull,
  type RemoteReader,
  type SearchEntry,
  type SearchHit,
  type StoredDoc,
  type StoredUpdate,
  type UnsentDoc,
} from '@cgw/workspace';
import { decodeFrame, encodeFrame } from './frame';
import { OutboxIndex, type OutboxEntry } from './outbox';

/** Sends one request frame and resolves with the answer frame. */
export type Transport = (frame: Uint8Array) => Promise<Uint8Array>;

export class StoreRequestError extends Error {}

export class DesktopStore implements LocalStore {
  readonly kind = 'sqlite' as const;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly transport: Transport,
    private readonly mirror: Mirror,
    private readonly outbox: OutboxIndex,
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
    return new DesktopStore(transport, new Mirror(snapshot), new OutboxIndex(outbox));
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
  private async write(plan: Plan): Promise<void> {
    await this.call({ op: 'applyPlan', plan });
    this.mirror.apply(plan);
    this.outbox.remove(plan.settled ?? []);
    for (const id of plan.deleteWorkspaces ?? []) this.outbox.removeWorkspace(id);
    if (plan.replaceOutbox) {
      this.outbox.removeWorkspace(plan.replaceOutbox.workspaceId);
      this.outbox.add(plan.replaceOutbox.ops);
    }
    this.outbox.add(plan.outbox);
  }

  /**
   * A remote plan, written. Its records come from the caller (the server's answers), so the mirror
   * takes copies; and since the Rust store drops a deleted page's favourites and visits with it,
   * the plan drops them from the mirror too.
   */
  private writeRemote(remote: Plan): Promise<void> {
    const plan = structuredClone(remote);
    const gone = new Set(plan.deletePages);
    if (gone.size) {
      for (const f of this.mirror.favourites.values())
        if (gone.has(f.pageId))
          plan.deleteFavourites.push({ workspaceId: f.workspaceId, pageId: f.pageId });
      for (const v of this.mirror.visits.values())
        if (gone.has(v.pageId))
          plan.deleteVisits.push({ workspaceId: v.workspaceId, pageId: v.pageId });
    }
    return this.write(plan);
  }

  /** What the remote planners read: the mirror, and the outbox index. */
  private reader(): RemoteReader {
    return {
      workspace: async (id) => this.mirror.workspaces.get(id),
      workspacePages: async (id) =>
        [...this.mirror.pages.values()].filter((p) => p.workspaceId === id),
      workspaceSections: async (id) => this.mirror.sectionsOf(id),
      pending: async (entityId, except) => this.outbox.pending(entityId, except),
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
    return this.serial(async () => this.write(await planOps(ops, this.mirror)));
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
    return this.serial(async () => structuredClone(this.mirror.pages.get(pageId) ?? null));
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

  beginUpload(workspaceId: Id, accountId: Id, ops: Operation[]): Promise<void> {
    return this.serial(async () => {
      const workspace = this.mirror.workspaces.get(workspaceId);
      if (!workspace) throw new StoreRequestError('No such workspace');
      const plan = emptyPlan();
      plan.workspaces.push({ ...workspace, localOnly: false, accountId });
      plan.replaceOutbox = { workspaceId, ops };
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

  replaceDoc(pageId: Id, update: LocalUpdate): Promise<void> {
    return this.serial(async () => {
      await this.call({ op: 'replaceDoc', pageId, updateId: update.updateId }, [update.data]);
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
      return rows
        .map((row) => {
          const inTitle = terms.every((t) => row.title.split(' ').some((w) => w.startsWith(t)));
          return {
            pageId: row.pageId,
            title: this.mirror.pages.get(row.pageId)?.title ?? row.title,
            snippet: inTitle ? '' : snippet(row.text, normalisedQuery),
            score: inTitle ? 2 : 1,
          };
        })
        .sort((a, b) => b.score - a.score);
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

  async purgeTrash(workspaceId: Id, before: string): Promise<Id[]> {
    const roots = this.mirror.trash(workspaceId).filter((p) => p.trashedAt! < before);
    if (!roots.length) return [];
    const gone = roots.flatMap((p) => [p.id, ...this.mirror.descendantIds(p.id)]);
    await this.applyLocalOps(
      roots.map((p) => ({
        opId: uuidv7(),
        type: 'page.delete' as const,
        workspaceId,
        entityId: p.id,
        baseVersion: null,
        payload: {},
        createdAt: new Date().toISOString(),
      })),
    );
    return gone;
  }

  schemaVersion(): Promise<number> {
    return this.serial(async () => (await this.call<number>({ op: 'schemaVersion' })).value);
  }

  close(): Promise<void> {
    return this.queue.then(() => undefined);
  }
}
