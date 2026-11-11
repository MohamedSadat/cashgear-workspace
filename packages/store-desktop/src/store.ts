// The desktop's LocalStore: requests to crates/cgw-store over a transport (Tauri's invoke in the
// app; the cgw-store-cli process in tests). Bytes travel as bytes in a binary frame. The tree rules
// are planned here against the in-memory mirror (the desktop app is one instance), and the plan is
// written by the Rust store in one transaction.
import {
  Mirror,
  STORE_SCHEMA_VERSION,
  planOps,
  snippet,
  searchTerms,
  uuidv7,
  type AssetRecord,
  type HistoryEntry,
  type Id,
  type LocalStore,
  type LocalUpdate,
  type MirrorSnapshot,
  type Operation,
  type OpResult,
  type PageRecord,
  type SearchEntry,
  type SearchHit,
  type StoredDoc,
} from '@cgw/workspace';
import { decodeFrame, encodeFrame } from './frame';

/** Sends one request frame and resolves with the answer frame. */
export type Transport = (frame: Uint8Array) => Promise<Uint8Array>;

export class StoreRequestError extends Error {}

export class DesktopStore implements LocalStore {
  readonly kind = 'sqlite' as const;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly transport: Transport,
    private readonly mirror: Mirror,
  ) {}

  static async open(transport: Transport): Promise<DesktopStore> {
    const probe = new DesktopStore(transport, new Mirror());
    const version = (await probe.call<number>({ op: 'schemaVersion' })).value;
    if (version > STORE_SCHEMA_VERSION)
      throw new StoreRequestError(
        `This store was written by a newer version (${version}); update the app.`,
      );
    const snapshot = (await probe.call<MirrorSnapshot>({ op: 'readMirror', workspaceId: null }))
      .value;
    return new DesktopStore(transport, new Mirror(snapshot));
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
    return this.serial(async () => {
      const plan = await planOps(ops, this.mirror);
      await this.call({ op: 'applyPlan', plan });
      this.mirror.apply(plan);
    });
  }

  nextOutboxBatch(limit: number): Promise<Operation[]> {
    return this.serial(
      async () => (await this.call<Operation[]>({ op: 'nextOutboxBatch', limit })).value,
    );
  }

  settleOps(results: OpResult[]): Promise<void> {
    return this.serial(async () => {
      await this.call({ op: 'settleOps', opIds: results.map((r) => r.opId) });
    });
  }

  readMirror(workspaceId: Id | null): Promise<MirrorSnapshot> {
    return this.serial(async () => structuredClone(this.mirror.snapshot(workspaceId)));
  }

  getPage(pageId: Id): Promise<PageRecord | null> {
    return this.serial(async () => structuredClone(this.mirror.pages.get(pageId) ?? null));
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
