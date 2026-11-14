// A page's Yjs document, opened from the local store and saved back to it (SYNC_DESIGN.md,
// Autosave). The editor changes the Y.Doc; this layer batches the updates for at most 500 ms,
// merges them and appends one record, then says "saved". The log is the document: opening a page
// replays the snapshot and every update after it, so a crash loses at most the unsaved batch.
// Phase 6: while the page is live (joined on the hub, connected: `setLive`), each save goes to the
// others at once, so batches are short: at most 60 ms, 30 ms after the last change.
import * as Y from 'yjs';
import { uuidv7, type Id, type LocalStore } from '@cgw/workspace';
import { writeJSON, type DocJSON } from './binding';
import { newBlockId } from './ids';
import { migrate, type MigrationResult } from './migrations';
import { watchMoves, type MoveConflict } from './moves';
import { CONTENT, LOAD, MIGRATE, MOVES, REMOTE, META, documentVersion } from './names';
import { SCHEMA_VERSION, documentSchema } from './schema';

export { CONTENT, LOAD, META, MIGRATE, MOVES, REMOTE, documentVersion } from './names';

/**
 * What a page's document tells its owner (the shell), as it happens.
 *
 * - `notice` `doc.moveConflict`: another device moved a block in a way that lost this device's
 *   edit in it, or moved a block this device moved too (moves.ts). The page's history has the
 *   content as it was.
 * - `stillPending`: after the retry (S1), Yjs still holds updates it cannot integrate: something
 *   is missing on this device. The owner asks the sync engine to check (`engine.suspect`).
 * - `quarantined`: updates in the local log did not decode; they were moved to the store's
 *   corrupt area and the rest of the page loaded.
 * - `newerVersion`: a pulled change raised the document's schema version above this build's;
 *   the page is read-only from now on (D7).
 * - `migrated`: the page was brought up to this build's schema version, as a local edit.
 */
export type DocEvent =
  | {
      kind: 'notice';
      code: 'doc.moveConflict';
      pageId: Id;
      blockId: string;
      reason: MoveConflict['reason'];
    }
  | { kind: 'stillPending'; pageId: Id }
  | { kind: 'quarantined'; pageId: Id; count: number }
  | { kind: 'newerVersion'; pageId: Id; version: number }
  | { kind: 'migrated'; pageId: Id; from: number; to: number };

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
  /** The same two while the page is live (`setLive`): 60 ms and 30 ms. */
  liveMaxDelayMs?: number;
  liveIdleMs?: number;
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
  /**
   * Whether this account may edit the page (default true). Without it nothing is written on
   * open: no meta stamp, no schema migration.
   */
  canEdit?: boolean;
  /** Told of events from the moment the page opens (`onEvent` subscribes later). */
  onEvent?: (event: DocEvent) => void;
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
  /** The schema migration this open ran, if any. */
  migrated?: MigrationResult | null;
  /** Updates replayed from the log. */
  replayed: number;
  ms: number;
}

const defaults = {
  maxDelayMs: 500,
  idleMs: 150,
  liveMaxDelayMs: 60,
  liveIdleMs: 30,
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
  // Yjs keeps its pending delete set in the V2 encoding too.
  if (store.pendingDs) Y.applyUpdateV2(doc, store.pendingDs, origin);
  return { before, after: !!store.pendingStructs || !!store.pendingDs };
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
  private newer: boolean;
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
  /** Saves go to others at once (`setLive`): batches are short. */
  private live = false;
  /** When the waiting batch's first change came (wall clock). */
  private batchStarted = 0;
  private readonly listeners = new Set<(state: SaveState) => void>();
  private readonly savedListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: DocEvent) => void>();
  /** Block ids this session recorded moves of (for `movedTwice`, moves.ts). */
  private readonly ownMoves = new Set<string>();
  private readonly options: Required<
    Omit<DocumentOptions, 'setTimer' | 'clearTimer' | 'clientId' | 'onEvent'>
  > &
    Pick<DocumentOptions, 'setTimer' | 'clearTimer' | 'clientId' | 'onEvent'>;

  private constructor(
    readonly pageId: Id,
    private readonly store: DocStore,
    doc: Y.Doc,
    logLength: number,
    lastSeq: number,
    readonly report: OpenReport,
    options: DocumentOptions,
  ) {
    this.options = { ...defaults, clientId: 0, canEdit: true, ...options };
    this.doc = doc;
    this.fragment = doc.getXmlFragment(CONTENT);
    this.newer = documentVersion(doc) > SCHEMA_VERSION;
    this.state = this.newer ? 'readOnly' : 'saved';
    this.logLength = logLength;
    this.lastSeq = lastSeq;
    if (options.onEvent) this.eventListeners.add(options.onEvent);
    if (!this.newer) doc.on('update', this.onUpdate);
    doc.getMap(MOVES).observe(this.onMoves);
  }

  /** True when the document is newer than this build: it is shown, never written (D7, S2). */
  get readOnly(): boolean {
    return this.newer;
  }

  /**
   * Opening with edit rights: the schema migration, then the meta stamp, each a local edit that
   * is saved and pushed. Nothing for a page newer than this build, or for someone who may only
   * read it, or for a page this device holds nothing of: that comes from the server, meta and
   * all, with its pull (a new page's first update carries its meta already).
   */
  private prepare(holdsContent: boolean): MigrationResult | null {
    if (this.newer || !this.options.canEdit || !holdsContent) return null;
    // An empty document never stamped (a detached page) is simply this build's version.
    if (!this.doc.getMap(META).has('schemaVersion') && this.fragment.length === 0) {
      stampMeta(this.doc, this.pageId);
      return null;
    }
    const migrated = migrate(this.doc, MIGRATE);
    stampMeta(this.doc, this.pageId);
    if (migrated) this.emit({ kind: 'migrated', pageId: this.pageId, ...migrated });
    return migrated;
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
    // Yjs takes a fresh client id when an update it is given writes as its own ("another client
    // seems to be using it"). Here that is this device's own log, written as the session's id,
    // which no other session holds (the engine's pool): it stays the id this session writes as.
    if (options.clientId) doc.clientID = options.clientId;
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
    report.migrated = page.prepare(!!stored.snapshot || stored.updates.length > 0);
    if (bad.length) page.emit({ kind: 'quarantined', pageId, count: bad.length });
    if (pending.after) page.emit({ kind: 'stillPending', pageId });
    return page;
  }

  /** A page that is not in any store: previews, tests, the scratch page. */
  static detached(pageId: Id, doc = new Y.Doc(), options: DocumentOptions = {}): PageDocument {
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
      options,
    );
    page.report.migrated = page.prepare(true);
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

  /** Events as they happen (see DocEvent). */
  onEvent(listener: (event: DocEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private emit(event: DocEvent) {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('A document event listener failed:', error);
      }
    }
  }

  private readonly onMoves = (event: Y.YMapEvent<unknown>, transaction: Y.Transaction) => {
    if (!transaction.local || transaction.origin === LOAD || transaction.origin === REMOTE) return;
    for (const key of event.keysChanged) this.ownMoves.add(key);
  };

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

  /** How long a batch waits now: the live delays while live (never longer than the usual ones). */
  private delays(): { max: number; idle: number } {
    const { maxDelayMs, idleMs, liveMaxDelayMs, liveIdleMs } = this.options;
    return this.live
      ? { max: Math.min(maxDelayMs, liveMaxDelayMs), idle: Math.min(idleMs, liveIdleMs) }
      : { max: maxDelayMs, idle: idleMs };
  }

  /** Whether the page is live now. */
  get isLive(): boolean {
    return this.live;
  }

  /**
   * The page is live (joined on the hub while it is connected) or no longer: while live, autosave
   * batches for at most 60 ms (30 ms after the last change) instead of 500 ms (150 ms), since each
   * save goes to the other editors at once. A batch waiting when it turns live is written by the
   * live delays, counted from its first change.
   */
  setLive(live: boolean): void {
    if (live === this.live) return;
    this.live = live;
    if (!live || this.closed || this.maxTimer === null) return;
    const { max, idle } = this.delays();
    const left = Math.max(0, max - (Date.now() - this.batchStarted));
    this.clear(this.idleTimer);
    this.clear(this.maxTimer);
    this.idleTimer = this.timer(() => void this.flush(), Math.min(idle, left));
    this.maxTimer = this.timer(() => void this.flush(), left);
  }

  private readonly onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === LOAD || origin === REMOTE || this.closed) return;
    this.pending.push(update);
    this.setState('unsaved');
    if (!this.historyStarted) this.historyStarted = Date.now();
    const { max, idle } = this.delays();
    this.clear(this.idleTimer);
    this.idleTimer = this.timer(() => void this.flush(), idle);
    if (this.maxTimer === null) {
      this.batchStarted = Date.now();
      this.maxTimer = this.timer(() => void this.flush(), max);
    }
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
    const check = watchMoves(this.doc, (origin) => origin === REMOTE, this.ownMoves);
    let pending: { after: boolean };
    try {
      this.doc.transact(() => {
        for (const update of updates) {
          try {
            Y.applyUpdate(this.doc, update, REMOTE);
          } catch (error) {
            console.warn('A pulled update did not apply:', error);
          }
        }
      }, REMOTE);
      pending = retryPending(this.doc, REMOTE);
    } finally {
      for (const conflict of check.finish(updates))
        this.emit({
          kind: 'notice',
          code: 'doc.moveConflict',
          pageId: this.pageId,
          blockId: conflict.blockId,
          reason: conflict.reason,
        });
    }
    if (pending.after) this.emit({ kind: 'stillPending', pageId: this.pageId });
    const version = documentVersion(this.doc);
    if (!this.newer && version > SCHEMA_VERSION) {
      // Another device moved the page to a schema this build does not know. What was typed here
      // is saved; nothing more is written (D7).
      this.newer = true;
      this.doc.off('update', this.onUpdate);
      void this.flush().then(() => this.setState('readOnly'));
      this.emit({ kind: 'newerVersion', pageId: this.pageId, version });
    }
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
    this.doc.getMap(MOVES).unobserve(this.onMoves);
    this.listeners.clear();
    this.savedListeners.clear();
    this.eventListeners.clear();
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
