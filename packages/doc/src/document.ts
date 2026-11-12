// A page's Yjs document, opened from the local store and saved back to it (SYNC_DESIGN.md,
// Autosave). The editor changes the Y.Doc; this layer batches the updates for at most 500 ms,
// merges them and appends one record, then says "saved". The log is the document: opening a page
// replays the snapshot and every update after it, so a crash loses at most the unsaved batch.
import * as Y from 'yjs';
import { uuidv7, type Id, type LocalStore } from '@cgw/workspace';
import { writeJSON, type DocJSON } from './binding';
import { newBlockId } from './ids';
import { SCHEMA_VERSION, documentSchema } from './schema';

/** The shared types inside every page's document (DATA_MODEL.md, "The Yjs document"). */
export const CONTENT = 'content';
export const META = 'meta';

/** Origins this layer gives Yjs transactions it makes itself, so autosave can tell them apart. */
export const LOAD = Symbol('cgw-load');
/** Updates pulled from the server: already in the store, never saved or pushed again. */
export const REMOTE = Symbol('cgw-remote');

export type SaveState = 'saved' | 'saving' | 'unsaved' | 'error' | 'readOnly';

/** What the document layer needs from the local store. */
export type DocStore = Pick<
  LocalStore,
  'loadDoc' | 'appendDocUpdates' | 'compactDoc' | 'quarantineUpdates' | 'addHistory'
>;

export interface DocumentOptions {
  /** Longest wait between the first unsaved change and its write. */
  maxDelayMs?: number;
  /** A shorter wait after the last change, so a pause saves at once. */
  idleMs?: number;
  /** Compact the local log once it holds more updates than this. */
  compactAfter?: number;
  /** Keep a history snapshot after this many saved updates, or this long of editing. */
  historyEvery?: { updates: number; ms: number };
  historyKeep?: number;
  /**
   * The Yjs client id this session writes as (Q9: one the server issued to this device, in a
   * synced workspace). Absent, Yjs picks one at random, as in a local-only workspace.
   */
  clientId?: number;
  /** Timers, for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface OpenReport {
  /** Updates that failed to apply, moved to the corrupt area. */
  quarantined: number;
  /** Updates Yjs held back on the first pass and integrated on the retry (S1). */
  healedPending: boolean;
  /** Still pending after the retry: something this device does not have. */
  stillPending: boolean;
  /** Updates replayed from the log. */
  replayed: number;
  ms: number;
}

const defaults = {
  maxDelayMs: 500,
  idleMs: 150,
  compactAfter: 200,
  historyEvery: { updates: 200, ms: 10 * 60_000 },
  historyKeep: 50,
};

type YStore = { pendingStructs: { update: Uint8Array } | null; pendingDs: Uint8Array | null };
const yStore = (doc: Y.Doc) => (doc as unknown as { store: YStore }).store;

/**
 * Yjs 13.6.33 can hold updates as pending after everything they need has arrived, depending on
 * order (S1; bench/editor/fixtures/yjs-pending-order.json). Applying the pending update once more
 * integrates them. Returns whether anything was pending before and after.
 */
export function retryPending(
  doc: Y.Doc,
  origin: unknown = LOAD,
): { before: boolean; after: boolean } {
  const store = yStore(doc);
  const before = !!store.pendingStructs || !!store.pendingDs;
  if (store.pendingStructs) Y.applyUpdateV2(doc, store.pendingStructs.update, origin);
  if (store.pendingDs) Y.applyUpdate(doc, store.pendingDs, origin);
  return { before, after: !!store.pendingStructs || !!store.pendingDs };
}

export function documentVersion(doc: Y.Doc): number {
  const value = doc.getMap(META).get('schemaVersion');
  return typeof value === 'number' ? value : 1;
}

/** A new page's document: the meta map stamped, and the given content if any. */
export function stampMeta(doc: Y.Doc, pageId: Id): void {
  const meta = doc.getMap(META);
  doc.transact(() => {
    if (!meta.has('schemaVersion')) meta.set('schemaVersion', SCHEMA_VERSION);
    if (!meta.has('epoch')) meta.set('epoch', 0);
    if (!meta.has('pageId')) meta.set('pageId', pageId);
  });
}

export class PageDocument {
  readonly doc: Y.Doc;
  readonly fragment: Y.XmlFragment;
  /** True when the document is newer than this build: it is shown, never written (D7, S2). */
  readonly readOnly: boolean;
  private state: SaveState;
  private readonly pending: Uint8Array[] = [];
  private maxTimer: unknown = null;
  private idleTimer: unknown = null;
  private writing: Promise<void> = Promise.resolve();
  private failures = 0;
  private logLength: number;
  private lastSeq: number;
  private sinceHistory = 0;
  private historyStarted = 0;
  private closed = false;
  private readonly listeners = new Set<(state: SaveState) => void>();
  private readonly savedListeners = new Set<() => void>();
  private readonly options: Required<
    Omit<DocumentOptions, 'setTimer' | 'clearTimer' | 'clientId'>
  > &
    Pick<DocumentOptions, 'setTimer' | 'clearTimer' | 'clientId'>;

  private constructor(
    readonly pageId: Id,
    private readonly store: DocStore,
    doc: Y.Doc,
    logLength: number,
    lastSeq: number,
    readonly report: OpenReport,
    options: DocumentOptions,
  ) {
    this.options = { ...defaults, clientId: 0, ...options };
    this.doc = doc;
    this.fragment = doc.getXmlFragment(CONTENT);
    this.readOnly = documentVersion(doc) > SCHEMA_VERSION;
    this.state = this.readOnly ? 'readOnly' : 'saved';
    this.logLength = logLength;
    this.lastSeq = lastSeq;
    if (!this.readOnly) doc.on('update', this.onUpdate);
  }

  /** Replays the page's log into a new Y.Doc. An update that will not apply is set aside. */
  static async open(
    pageId: Id,
    store: DocStore,
    options: DocumentOptions = {},
  ): Promise<PageDocument> {
    const started = performance.now();
    const stored = await store.loadDoc(pageId);
    const doc = new Y.Doc({ gc: true });
    if (options.clientId) doc.clientID = options.clientId;
    const bad: number[] = [];
    doc.transact(() => {
      if (stored.snapshot) Y.applyUpdate(doc, stored.snapshot, LOAD);
      for (const update of stored.updates) {
        try {
          Y.applyUpdate(doc, update.data, LOAD);
        } catch {
          bad.push(update.localSeq);
        }
      }
    }, LOAD);
    const pending = retryPending(doc);
    if (bad.length) await store.quarantineUpdates(pageId, bad, 'The update does not decode');
    const lastSeq = stored.updates.reduce(
      (max, u) => Math.max(max, u.localSeq),
      stored.snapshotCovers,
    );
    const report: OpenReport = {
      quarantined: bad.length,
      healedPending: pending.before && !pending.after,
      stillPending: pending.after,
      replayed: stored.updates.length,
      ms: performance.now() - started,
    };
    const page = new PageDocument(
      pageId,
      store,
      doc,
      stored.updates.length - bad.length,
      lastSeq,
      report,
      options,
    );
    if (!page.readOnly) stampMeta(doc, pageId);
    return page;
  }

  /** A page that is not in any store: previews, tests, the scratch page. */
  static detached(pageId: Id, doc = new Y.Doc()): PageDocument {
    const none: DocStore = {
      loadDoc: async () => ({ snapshot: null, snapshotCovers: 0, updates: [] }),
      appendDocUpdates: async (_id, updates) => updates.map((_, i) => i + 1),
      compactDoc: async () => {},
      quarantineUpdates: async () => {},
      addHistory: async () => ({ id: uuidv7(), pageId, createdAt: '', sizeBytes: 0 }),
    };
    const page = new PageDocument(
      pageId,
      none,
      doc,
      0,
      0,
      { quarantined: 0, healedPending: false, stillPending: false, replayed: 0, ms: 0 },
      {},
    );
    if (!page.readOnly) stampMeta(doc, pageId);
    return page;
  }

  get saveState(): SaveState {
    return this.state;
  }

  onSaveState(listener: (state: SaveState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Called after each successful write, for the search index and history. */
  onSaved(listener: () => void): () => void {
    this.savedListeners.add(listener);
    return () => {
      this.savedListeners.delete(listener);
    };
  }

  private setState(state: SaveState) {
    if (state === this.state) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private timer(fn: () => void, ms: number) {
    return (this.options.setTimer ?? ((f, t) => setTimeout(f, t)))(fn, ms);
  }

  private clear(handle: unknown) {
    if (handle !== null) (this.options.clearTimer ?? ((h) => clearTimeout(h as number)))(handle);
  }

  private readonly onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === LOAD || origin === REMOTE || this.closed) return;
    this.pending.push(update);
    this.setState('unsaved');
    if (!this.historyStarted) this.historyStarted = Date.now();
    this.clear(this.idleTimer);
    this.idleTimer = this.timer(() => void this.flush(), this.options.idleMs);
    if (this.maxTimer === null)
      this.maxTimer = this.timer(() => void this.flush(), this.options.maxDelayMs);
  };

  /** Writes whatever is waiting. Resolves when it is durable (or has failed and will retry). */
  flush(): Promise<void> {
    this.clear(this.idleTimer);
    this.clear(this.maxTimer);
    this.idleTimer = this.maxTimer = null;
    this.writing = this.writing.then(() => this.write());
    return this.writing;
  }

  private async write(): Promise<void> {
    if (!this.pending.length) return;
    const batch = this.pending.splice(0);
    const data = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch);
    this.setState('saving');
    try {
      const [seq] = await this.store.appendDocUpdates(this.pageId, [{ updateId: uuidv7(), data }]);
      this.failures = 0;
      this.lastSeq = Math.max(this.lastSeq, seq);
      this.logLength++;
      this.sinceHistory++;
      this.setState(this.pending.length ? 'unsaved' : 'saved');
      for (const listener of this.savedListeners) listener();
      await this.maintain();
    } catch (error) {
      // Put the batch back in front and try again later; nothing typed is dropped.
      this.pending.unshift(data);
      this.failures++;
      this.setState('error');
      console.error('Autosave failed; retrying.', error);
      if (!this.closed && this.maxTimer === null)
        this.maxTimer = this.timer(
          () => void this.flush(),
          Math.min(30_000, 500 * 2 ** this.failures),
        );
    }
  }

  /** Compaction and history, after a write; neither may lose anything if it fails. */
  private async maintain() {
    const { compactAfter, historyEvery, historyKeep } = this.options;
    const historyDue =
      this.sinceHistory >= historyEvery.updates ||
      (this.historyStarted > 0 && Date.now() - this.historyStarted >= historyEvery.ms);
    if (this.logLength <= compactAfter && !historyDue) return;
    const snapshot = Y.encodeStateAsUpdate(this.doc);
    try {
      if (historyDue) {
        await this.store.addHistory(this.pageId, snapshot, historyKeep);
        this.sinceHistory = 0;
        this.historyStarted = 0;
      }
      if (this.logLength > compactAfter) {
        await this.store.compactDoc(this.pageId, snapshot, this.lastSeq);
        this.logLength = 0;
      }
    } catch (error) {
      console.warn('Local compaction failed; the log is kept as it is.', error);
    }
  }

  /**
   * Applies updates another device made, which the sync engine has already stored: the editor
   * shows them, and they are neither saved again nor pushed (they carry the REMOTE origin).
   */
  applyRemote(updates: Uint8Array[]): void {
    if (!updates.length || this.closed) return;
    this.doc.transact(() => {
      for (const update of updates) {
        try {
          Y.applyUpdate(this.doc, update, REMOTE);
        } catch (error) {
          console.warn('A pulled update did not apply:', error);
        }
      }
    }, REMOTE);
    retryPending(this.doc, REMOTE);
  }

  /** Keeps a history snapshot now (before a restore, or when asked). */
  async keepHistory(): Promise<void> {
    await this.store.addHistory(
      this.pageId,
      Y.encodeStateAsUpdate(this.doc),
      this.options.historyKeep,
    );
  }

  /** Flushes, then stops listening. The Y.Doc stays usable for reading. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    this.doc.off('update', this.onUpdate);
    this.listeners.clear();
    this.savedListeners.clear();
  }
}

/**
 * A new page's first update: the meta map stamped, and the given content or one empty paragraph,
 * so the caret has somewhere to go. Made once, by the client that creates the page.
 */
export function newDocumentUpdate(pageId: Id, json?: DocJSON, clientId?: number): Uint8Array {
  const doc = new Y.Doc();
  if (clientId) doc.clientID = clientId;
  stampMeta(doc, pageId);
  writeJSON(
    doc.getXmlFragment(CONTENT),
    documentSchema(),
    json ?? {
      type: 'doc',
      content: [
        {
          type: 'block',
          attrs: { id: newBlockId() },
          content: [{ type: 'textBody', attrs: { kind: 'paragraph' } }],
        },
      ],
    },
  );
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}
