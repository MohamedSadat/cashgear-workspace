// A LocalStore held in memory: the reference the conformance suite is written against, the store
// unit tests use, and what a page uses when nothing may be kept (a read-only preview).
import type { Id } from './ids';
import { uuidv7 } from './ids';
import { Mirror } from './mirror';
import { planOps } from './ops';
import { snippet, searchTerms } from './search';
import {
  STORE_SCHEMA_VERSION,
  type AssetRecord,
  type HistoryEntry,
  type LocalStore,
  type LocalUpdate,
  type MirrorSnapshot,
  type Operation,
  type OpResult,
  type PageRecord,
  type SearchEntry,
  type SearchHit,
  type StoredDoc,
  type StoredUpdate,
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
      log.snapshot = copy(snapshot);
      log.snapshotCovers = Math.max(log.snapshotCovers, coversLocalUpTo);
      log.updates = log.updates.filter((u) => u.localSeq > coversLocalUpTo);
    });
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
      for (const id of plan.deletePages) this.dropPageData(id);
    });
  }

  private dropPageData(pageId: Id) {
    this.docs.delete(pageId);
    this.search_.delete(pageId);
    for (const [id, h] of this.history) if (h.entry.pageId === pageId) this.history.delete(id);
  }

  nextOutboxBatch(limit: number): Promise<Operation[]> {
    return this.run(() => this.outbox.slice(0, limit).map((op) => structuredClone(op)));
  }

  settleOps(results: OpResult[]): Promise<void> {
    return this.run(() => {
      const settled = new Set(results.map((r) => r.opId));
      for (let i = this.outbox.length - 1; i >= 0; i--)
        if (settled.has(this.outbox[i].opId)) this.outbox.splice(i, 1);
    });
  }

  readMirror(workspaceId: Id | null): Promise<MirrorSnapshot> {
    return this.run(() => structuredClone(this.mirror.snapshot(workspaceId)));
  }

  getPage(pageId: Id): Promise<PageRecord | null> {
    return this.run(() => structuredClone(this.mirror.pages.get(pageId) ?? null));
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
        const page = this.mirror.pages.get(entry.pageId);
        if (!page || page.trashedAt) continue;
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

  purgeTrash(workspaceId: Id, before: string): Promise<Id[]> {
    return this.run(async () => {
      const roots = this.mirror
        .trash(workspaceId)
        .filter((p) => p.trashedAt! < before)
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
      for (const id of plan.deletePages) this.dropPageData(id);
      return plan.deletePages;
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
