// The sync engine (SYNC_DESIGN.md, The sync loop): the same in the browser and on the desktop,
// over a LocalStore and a SyncApi. One pass, per synced workspace of the signed-in account:
//   1. push the outbox, oldest first, and take the server's answers into the mirror;
//   2. push document updates not yet sent, in batches the server takes (at most 200 updates and
//      4 MB a request, an update over 1 MB alone), each settled before the next;
//   3. pull the change feed until it has no more (the whole tree when the feed has been pruned
//      past this device's cursor), and resync any subtree access changed on;
//   4. pull documents this device holds whose server head moved, then a bounded number of pinned
//      pages it does not hold yet;
//   5. compare a few pages' state hashes with the server's, and repair those that differ;
//   6. upload assets the server lacks.
// Failures back off exponentially with jitter, capped at 5 minutes and never shorter than the
// server's `Retry-After`; a timer that fires far later than it was set for (the machine slept)
// runs a pass at once with the backoff reset. A 401 pauses the loop until the user signs in
// again. Nothing waiting is ever discarded: what the server will not take is set aside (the
// store's quarantine, which the shell makes recovered pages of) or kept in the corrupt area, and
// the user is told.
import { uuidv7, type Id } from '../ids';
import { uploadOps } from '../remote';
import {
  STORE_SCHEMA_VERSION,
  type AssetRecord,
  type EntityRecord,
  type LocalStore,
  type OpResult,
  type PageRecord,
  type PinRecord,
  type RemoteBatch,
  type StoredDoc,
  type StoredUpdate,
  type WorkspaceRecord,
} from '../types';
import {
  OfflineError,
  SyncHttpError,
  type Account,
  type DocCodec,
  type DocPull,
  type DocStateHash,
  type ServerChange,
  type SyncApi,
} from './api';

export type SyncState = 'localOnly' | 'signedOut' | 'offline' | 'syncing' | 'synced' | 'error';

export interface SyncStatus {
  state: SyncState;
  /** Operations and document updates waiting to be sent. */
  waiting: number;
  /** When the last full pass finished, ISO. */
  lastSynced: string | null;
}

/** What the engine tells the app; the shell turns notices into messages. */
export type SyncEvent =
  /** Records changed from the server: read the mirror again. */
  | { kind: 'mirror'; workspaceId: Id }
  /** Updates pulled for a page: an open document applies them. */
  | { kind: 'doc'; pageId: Id; updates: Uint8Array[] }
  /** A page's document was replaced (an epoch change, edit access lost): reopen it. */
  | { kind: 'docReset'; pageId: Id }
  | { kind: 'members'; workspaceId: Id }
  | { kind: 'notice'; code: string; workspaceId: Id; pageId?: Id }
  /** Pending quarantine entries exist: make recovered pages of them. */
  | { kind: 'recover'; workspaceId: Id }
  /** Pins or the pages held here changed: redraw what is available offline. */
  | { kind: 'offline'; workspaceId: Id };

export interface SyncOptions {
  /** How often a pass runs while nothing else triggers one. */
  intervalMs?: number;
  /** For tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
  /** Wall-clock milliseconds, for tests: a timer that fires far too late means the machine slept. */
  now?: () => number;
  /** Pinned pages fetched per pass (default 24). */
  pinBatch?: number;
}

/** How much of a workspace is kept on this device for offline use. */
export interface OfflineProgress {
  /** The workspace's pins. */
  pins: PinRecord[];
  /** Live pages the pins cover: pinned pages, and every page under a subtree pin. */
  pinned: number;
  /** Of those, the pages whose document this device holds. */
  held: number;
  /** Pinned pages still to fetch. */
  toFetch: number;
  /** Every page of the workspace this device holds, pinned or only opened. */
  available: number;
}

const MAX_BACKOFF = 5 * 60_000;
/** The longest a timer is set for: a long wait is a chain of these, so a sleep shows. */
const TICK = 15_000;
/** A timer this much later than it was set for means the machine slept (or the clock jumped). */
const SLEEP_GAP = 90_000;
/** The next pass after one that left work for later (an outbox, pinned pages to fetch). */
const SOON = 100;
const POOL_LOW = 4;
const POOL_FILL = 8;
const EMPTY_UPDATE = new Uint8Array([0, 0]);

/** The server's limits on a document push (SYNC_DESIGN.md, What the server checks). */
export const PUSH_LIMITS = {
  updates: 200,
  bytes: 4 * 1024 * 1024,
  /** Larger than this, an update goes alone (the server refuses it, and only it). */
  alone: 1024 * 1024,
};
/** Unsent updates read at a time, and how many such reads a pass makes before it yields. */
const PUSH_READ = 200;
const PUSH_ROUNDS = 10;
const PIN_BATCH = 24;
const PIN_PARALLEL = 4;
/** State-hash checks a pass makes, and passes a check waits for the server to catch up. */
const CHECKS_PER_PASS = 4;
const CHECK_TRIES = 20;
/** Waiting updates counted for the status (a long outbox shows at least this many). */
const WAITING_CAP = 5000;

/** Operations that change a page's whole subtree. */
const SUBTREE_OPS = new Set(['page.move', 'page.trash', 'page.restore', 'page.delete']);

const poolKey = (workspaceId: Id) => `sync:yjsPool:${workspaceId}`;
const registeredKey = (workspaceId: Id) => `sync:yjsRegistered:${workspaceId}`;
/** The signed-in account (no credential), for a start with no network. */
export const ACCOUNT_PREF = 'sync:account';

const partsOf = (doc: StoredDoc) => [
  ...(doc.snapshot ? [doc.snapshot] : []),
  ...doc.updates.map((u) => u.data),
];

/** A page's unsent updates in batches the server takes, in log order. */
export function pushBatches(updates: StoredUpdate[], limits = PUSH_LIMITS): StoredUpdate[][] {
  const out: StoredUpdate[][] = [];
  let batch: StoredUpdate[] = [];
  let bytes = 0;
  for (const update of updates) {
    const size = update.data.byteLength;
    if (size > limits.alone) {
      if (batch.length) out.push(batch);
      out.push([update]);
      batch = [];
      bytes = 0;
      continue;
    }
    if (batch.length && (batch.length >= limits.updates || bytes + size > limits.bytes)) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(update);
    bytes += size;
  }
  if (batch.length) out.push(batch);
  return out;
}

export class SyncEngine {
  private account: Account | null = null;
  /** Whose changes the status counts while signed out (the cached or last account). */
  private known: Account | null = null;
  private running = false;
  private current: Promise<void> | null = null;
  private stopped = true;
  private again = false;
  private timer: unknown = null;
  /** When the scheduled pass is due, and when and for how long the timer was set (wall clock). */
  private due = 0;
  private armedAt = 0;
  private armedFor = 0;
  private failures = 0;
  /** No pass before this (the server's `Retry-After`), wall clock. */
  private notBefore = 0;
  /** A pass left work for later: the next comes soon. */
  private backlog = false;
  private storeChecked = false;
  private status_: SyncStatus = { state: 'signedOut', waiting: 0, lastSynced: null };
  /** Reports started, and the latest one shown: one that finishes after a later one is dropped. */
  private reportsStarted = 0;
  private reportShown = 0;
  private readonly listeners = new Set<(event: SyncEvent) => void>();
  private readonly statusListeners = new Set<(status: SyncStatus) => void>();
  /** Session Yjs client ids, one per workspace (Q9). */
  private readonly sessionIds = new Map<Id, number>();
  /** Pages to pull on the next pass: opened, or their head moved. */
  private readonly wanted = new Set<Id>();
  /** Pages whose pushes the server will not take (too old a client): not retried this session. */
  private readonly heldBack = new Set<Id>();
  /** Pages this session pushed updates to, until the server's record of them is seen. */
  private readonly edited = new Set<Id>();
  /** State-hash checks to make, with the passes each has waited. */
  private readonly checks = new Map<Id, number>();
  /** Pages checked on opening this session (once a session each). */
  private readonly opened = new Set<Id>();
  /** Pages whose failed repair was reported this session. */
  private readonly repairReported = new Set<Id>();
  /** Quarantine entries already told of; null until the first pass has read them. */
  private seen: Set<Id> | null = null;
  /** Something may have been set aside (or pending entries remain): look after the pass. */
  private quarantineDirty = true;
  /** Workspaces whose held pages changed in this pass. */
  private readonly heldChanged = new Set<Id>();
  /** Workspaces where a tree operation on a subtree was answered: the mirror is checked after the feed. */
  private readonly reconcile = new Set<Id>();
  private mine = new Set<Id>();
  private passes = 0;

  constructor(
    private readonly store: LocalStore,
    private readonly api: SyncApi,
    private readonly codec: DocCodec,
    private readonly options: SyncOptions = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  // Lifecycle --------------------------------------------------------------------------------------

  get status(): SyncStatus {
    return this.status_;
  }

  get signedIn(): Account | null {
    return this.account;
  }

  /**
   * Signs the engine in (after `me()` answered, or with `cachedAccount()` when there is no
   * network: then `offline` says so at once) or out. Signing in keeps the account (never a
   * credential) for the next start; signing out forgets it, and keeps everything local.
   */
  setAccount(account: Account | null, options: { offline?: boolean } = {}) {
    this.account = account;
    this.known = account;
    this.mine = new Set();
    this.sessionIds.clear();
    const kept: Account | null = account && {
      id: account.id,
      email: account.email,
      displayName: account.displayName,
      deviceId: account.deviceId,
    };
    void this.store
      .setPref(ACCOUNT_PREF, kept)
      .catch((error: unknown) => console.warn('Could not keep the account:', error));
    if (account) {
      this.failures = 0;
      if (options.offline) void this.report('offline');
      this.kick(0);
    } else void this.report('signedOut');
  }

  /** The account last signed in on this device, for a start with no network; null if none. */
  async cachedAccount(): Promise<Account | null> {
    const value = await this.store.getPref<Account | null>(ACCOUNT_PREF);
    if (!value || typeof value.id !== 'string' || typeof value.email !== 'string') return null;
    return {
      id: value.id,
      email: value.email,
      displayName: value.displayName ?? '',
      deviceId: value.deviceId ?? null,
    };
  }

  start() {
    this.stopped = false;
    this.kick(0);
  }

  stop() {
    this.stopped = true;
    this.clear();
  }

  /**
   * A local change: nothing is "synced" while it waits, so the status says so at once (a pass
   * starts only after the change settles), and a pass comes soon unless the loop is backing off
   * (offline: the network's return kicks it).
   */
  changed() {
    const state = this.status_.state;
    if (state === 'synced' || state === 'offline' || (state === 'signedOut' && this.known)) {
      this.status_ = {
        ...this.status_,
        state: state === 'synced' ? 'syncing' : state,
        waiting: this.status_.waiting + 1,
      };
      for (const listener of this.statusListeners) listener(this.status_);
    }
    if (this.failures === 0) this.kick();
  }

  /**
   * A pass now, awaited (after one already running): what was written here is on the server when
   * it returns, unless the network or the server failed (the status says which).
   */
  async syncNow(): Promise<void> {
    while (this.current) await this.current;
    this.clear();
    await this.run();
  }

  /** Resolves when no pass is running. */
  async idle(): Promise<void> {
    while (this.current) await this.current;
  }

  /**
   * A pass soon: after a local change, when the network returns, on focus, when a page opens. The
   * server's `Retry-After` is still honoured.
   */
  kick(delayMs = 300) {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.schedule(delayMs);
  }

  on(listener: (event: SyncEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  onStatus(listener: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => void this.statusListeners.delete(listener);
  }

  private emit(event: SyncEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private notice(code: string, workspaceId: Id, pageId?: Id) {
    this.emit({ kind: 'notice', code, workspaceId, ...(pageId ? { pageId } : {}) });
  }

  private clear() {
    if (this.timer !== null)
      (this.options.clearTimer ?? ((h) => clearTimeout(h as number)))(this.timer);
    this.timer = null;
  }

  /** The next pass in `delayMs` (not before `Retry-After`), as a chain of short timers. */
  private schedule(delayMs: number) {
    this.clear();
    const now = this.now();
    this.due = Math.max(now + delayMs, this.notBefore);
    this.arm(now);
  }

  private arm(now: number) {
    const wait = Math.max(0, Math.min(this.due - now, TICK));
    this.armedAt = now;
    this.armedFor = wait;
    this.timer = (this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(
      () => this.fire(),
      wait,
    );
  }

  private fire() {
    this.timer = null;
    if (this.stopped) return;
    const now = this.now();
    if (now - this.armedAt - this.armedFor > SLEEP_GAP) {
      // Far later than set: the machine slept. What waited is due now, and the backoff restarts.
      this.failures = 0;
      void this.run();
      return;
    }
    if (now >= this.due) void this.run();
    else this.arm(now);
  }

  private async report(state: SyncState) {
    // Reports read the store, so they can finish out of order: the sign-out a start begins with
    // must not land after the sign-in that follows it and say "Signed out" while signed in.
    const order = ++this.reportsStarted;
    const owner = this.account ?? this.known;
    if (!this.mine.size) {
      const workspaces = (await this.store.readMirror(null)).workspaces.filter(
        (w) => !w.localOnly && !w.deletedAt && (!owner || w.accountId === owner.id),
      );
      this.mine = new Set(workspaces.map((w) => w.id));
    }
    const ops = (await this.store.nextOutboxBatch(WAITING_CAP)).filter((op) =>
      this.mine.has(op.workspaceId),
    ).length;
    const docs = (await this.store.unsentDocUpdates(WAITING_CAP))
      // A page held back (this build is too old for it) waits for an update, not for a pass.
      .filter((d) => !this.heldBack.has(d.pageId))
      .reduce((n, d) => n + d.updates.length, 0);
    const waiting = ops + docs;
    if (order < this.reportShown) return;
    this.reportShown = order;
    this.status_ = {
      // A pass that ends with changes waiting (made while it ran) has not synced them.
      state: state === 'synced' && waiting > 0 ? 'syncing' : state,
      waiting,
      lastSynced: state === 'synced' ? this.iso() : this.status_.lastSynced,
    };
    for (const listener of this.statusListeners) listener(this.status_);
  }

  private run(): Promise<void> {
    if (this.running || this.stopped) return this.current ?? Promise.resolve();
    this.running = true;
    this.again = false;
    this.backlog = false;
    const pass = this.runPass().finally(() => {
      this.running = false;
      this.current = null;
      this.afterPass();
    });
    this.current = pass;
    return pass;
  }

  private retryAfter = 0;

  private async runPass() {
    this.retryAfter = 0;
    try {
      await this.syncOnce();
      this.failures = 0;
    } catch (error) {
      this.failures++;
      if (error instanceof SyncHttpError && error.status === 401) {
        // The session ended: paused until the user signs in again; nothing is discarded, and the
        // status still counts what waits for the account.
        this.account = null;
        await this.report('signedOut');
      } else await this.report(error instanceof OfflineError ? 'offline' : 'error');
      if (error instanceof SyncHttpError && error.retryAfterMs) {
        this.retryAfter = error.retryAfterMs;
        this.notBefore = this.now() + error.retryAfterMs;
      }
      if (!(error instanceof OfflineError) && !(error instanceof SyncHttpError))
        console.warn('Sync failed:', error);
    }
  }

  private afterPass() {
    if (this.stopped) return;
    const base = this.options.intervalMs ?? 1500;
    const delay = this.failures
      ? Math.max(
          this.retryAfter,
          Math.min(MAX_BACKOFF, 1000 * 2 ** (this.failures - 1)) *
            (0.5 + (this.options.random ?? Math.random)()),
        )
      : this.again
        ? 50
        : this.backlog
          ? SOON
          : base;
    if (this.account || this.again) this.schedule(delay);
  }

  // One pass ---------------------------------------------------------------------------------------

  async syncOnce(): Promise<void> {
    const account = this.account;
    if (!account) {
      await this.report('signedOut');
      return;
    }
    if (!this.storeChecked) {
      // A store newer than this build is refused when it opens; should one get here, nothing is
      // sent from it (the shell asks the user to update).
      if ((await this.store.schemaVersion()) > STORE_SCHEMA_VERSION) {
        await this.report('error');
        this.stop();
        return;
      }
      this.storeChecked = true;
    }
    let held = await this.syncedWorkspaces(account);
    this.mine = new Set(held.map((w) => w.id));
    await this.report(this.status_.state === 'offline' ? 'offline' : 'syncing');
    if (!this.seen) this.seen = new Set((await this.store.quarantine(null)).map((e) => e.id));
    try {
      // Workspaces the account gained or lost on another device, now and then.
      if (this.passes++ % 10 === 0) {
        const server = await this.api.listWorkspaces();
        const known = new Set(held.map((w) => w.id));
        const there = new Set(server.map((w) => w.id));
        for (const workspace of server)
          if (!known.has(workspace.id)) await this.firstSync(workspace.id, account);
        for (const workspace of held)
          if (!there.has(workspace.id)) await this.lose(workspace.id, false);
        held = await this.syncedWorkspaces(account);
        this.mine = new Set(held.map((w) => w.id));
      }
      for (const workspace of held) {
        try {
          await this.pushOutbox(workspace, account);
          await this.pushDocs(workspace);
          await this.pullChanges(workspace, account);
          await this.reconcileTree(workspace.id, account);
          const mirror = await this.store.readMirror(workspace.id);
          const pinned = await this.pinnedPages(workspace.id, mirror.pages);
          await this.pullDocs(workspace, mirror.pages, pinned);
          await this.fetchPinned(workspace, pinned);
          await this.runChecks(workspace);
          await this.uploadAssets(workspace);
        } catch (error) {
          // The workspace is gone for this account: forget it here, as another device's removal would.
          if (
            error instanceof SyncHttpError &&
            error.status === 404 &&
            error.code === 'not.found'
          ) {
            await this.lose(workspace.id, true);
            continue;
          }
          throw error;
        } finally {
          if (this.heldChanged.delete(workspace.id))
            this.emit({ kind: 'offline', workspaceId: workspace.id });
        }
      }
    } finally {
      await this.lookAtQuarantine().catch((error: unknown) =>
        console.warn('Could not read the quarantine:', error),
      );
    }
    await this.report('synced');
  }

  private async lose(workspaceId: Id, notice: boolean) {
    await this.store.applyRemote({ workspaceId, deleteWorkspace: true });
    this.quarantineDirty = true;
    this.emit({ kind: 'mirror', workspaceId });
    if (notice) this.notice('workspace.lost', workspaceId);
  }

  private async syncedWorkspaces(account: Account): Promise<WorkspaceRecord[]> {
    return (await this.store.readMirror(null)).workspaces.filter(
      (w) => !w.localOnly && w.accountId === account.id && !w.deletedAt,
    );
  }

  /** A workspace this device does not hold yet: its whole tree, then the feed from its cursor. */
  private async firstSync(workspaceId: Id, account: Account) {
    const tree = await this.api.tree(workspaceId, null);
    await this.store.applyRemote({
      workspaceId,
      cursor: tree.cursor,
      workspaces: [{ ...tree.workspace, localOnly: false, accountId: account.id }],
      sections: tree.sections,
      pages: tree.pages,
      favourites: tree.favourites,
      visits: tree.visits,
      replace: { root: null },
    });
    this.emit({ kind: 'mirror', workspaceId });
  }

  // Quarantine --------------------------------------------------------------------------------------

  /** Sets a page's unsent edits aside (to become a recovered page) and tells the user why. */
  private async setAside(workspaceId: Id, pageId: Id, reason: string) {
    const entry = await this.store.setAsideDoc(pageId, reason);
    if (entry) this.seen?.add(entry.id);
    this.quarantineDirty = true;
    this.notice(reason, workspaceId, pageId);
  }

  /**
   * After a pass that may have set something aside: entries the store set aside on the server's
   * word (a remote delete, a lost subtree) are told of as `page.removed`, and while any entry is
   * pending the shell is asked to make recovered pages (`recover`), pass after pass.
   */
  private async lookAtQuarantine() {
    if (!this.quarantineDirty || !this.seen) return;
    const pending = new Set<Id>();
    for (const entry of await this.store.quarantine(null)) {
      if (entry.status !== 'pending') continue;
      pending.add(entry.workspaceId);
      if (this.seen.has(entry.id)) continue;
      this.seen.add(entry.id);
      if (entry.reason === 'page.removed')
        this.notice('page.removed', entry.workspaceId, entry.pageId);
    }
    for (const workspaceId of pending) this.emit({ kind: 'recover', workspaceId });
    this.quarantineDirty = pending.size > 0;
  }

  // 1. Operations ----------------------------------------------------------------------------------

  private async pushOutbox(workspace: WorkspaceRecord, account: Account) {
    for (;;) {
      const ops = await this.store.nextOutboxBatch(100, workspace.id);
      if (!ops.length) return;
      const results: OpResult[] = [];
      const rest = [];
      for (const op of ops) {
        if (op.type === 'workspace.create') {
          const created = await this.api.createWorkspace({
            id: op.payload.id,
            name: op.payload.name,
            icon: op.payload.icon,
          });
          results.push({
            opId: op.opId,
            status: 'applied',
            entityType: 'workspace',
            entity: { ...created, accountId: account.id },
          });
        } else rest.push(op);
      }
      if (rest.length)
        results.push(...(await this.api.pushOps(workspace.id, account.deviceId, rest)));
      // A refusal can remove a page here (the server has none): its unsent edits are set aside.
      if (results.some((r) => r.status === 'rejected' || r.entity === null))
        this.quarantineDirty = true;
      await this.store.settleOps(results);
      // A refused tree operation changed a whole subtree locally: take the server's subtree back.
      const subtrees = new Set<Id>();
      for (const result of results) {
        const op = ops.find((o) => o.opId === result.opId);
        if (!op || !SUBTREE_OPS.has(op.type)) continue;
        this.reconcile.add(workspace.id);
        if (result.status === 'rejected' && result.entity) subtrees.add(op.entityId);
      }
      for (const root of subtrees) await this.resync(workspace.id, root, account);
      for (const result of results) {
        if (result.notice) this.notice(result.notice, workspace.id, entityPage(result.entity));
        if (result.status === 'rejected' && result.error)
          this.notice(result.error.code, workspace.id, entityPage(result.entity));
      }
      this.emit({ kind: 'mirror', workspaceId: workspace.id });
      if (ops.length < 100) return;
    }
  }

  // 2. Document updates ----------------------------------------------------------------------------

  private async pushDocs(workspace: WorkspaceRecord) {
    // Updates of pages that cannot go now (another workspace's, held back, not created on the
    // server yet) are read again each round: the read is widened by as many, so they never crowd
    // out the rest.
    let skipped = 0;
    for (let round = 0; round < PUSH_ROUNDS; round++) {
      // A page whose creation has not reached the server yet waits for it: its push would be 404.
      // (Made between this pass's push of the outbox and now; the next pass sends both.)
      const creating = await this.creating(workspace.id);
      const limit = skipped + PUSH_READ;
      const unsent = await this.store.unsentDocUpdates(limit);
      let read = 0;
      skipped = 0;
      for (const doc of unsent) {
        read += doc.updates.length;
        const page =
          this.heldBack.has(doc.pageId) || creating.has(doc.pageId)
            ? null
            : await this.store.getPage(doc.pageId);
        if (!page || page.workspaceId !== workspace.id) {
          skipped += doc.updates.length;
          continue;
        }
        await this.pushPage(workspace.id, page, doc.updates);
      }
      if (read < limit) return;
    }
    // More waits than one pass sends: the next pass comes soon and goes on from here.
    this.backlog = true;
  }

  /** A page's unsent updates, batch by batch; each batch's answer is kept before the next goes. */
  private async pushPage(workspaceId: Id, page: PageRecord, all: StoredUpdate[]) {
    const ids = [...new Set(all.flatMap((u) => this.codec.clientIds(u.data)))];
    const refused = await this.register(workspaceId, ids);
    let updates = all;
    if (refused.size) {
      // Written as an id another person holds here: the server would refuse it. Kept aside.
      const bad = updates.filter((u) => this.codec.clientIds(u.data).some((id) => refused.has(id)));
      await this.store.quarantineUpdates(
        page.id,
        bad.map((u) => u.localSeq),
        'yjs.clientTaken',
      );
      this.notice('doc.clientTaken', workspaceId, page.id);
      updates = updates.filter((u) => !bad.includes(u));
    }
    if (!updates.length) return;
    let cursor = await this.store.docCursor(page.id);
    const epoch = cursor?.epoch ?? page.docEpoch ?? 0;
    const queue = pushBatches(updates);
    while (queue.length) {
      const batch = queue.shift()!;
      try {
        const answer = await this.api.pushDoc(page.id, {
          epoch,
          clientSchemaVersion: this.codec.schemaVersion,
          updates: batch.map((u) => ({ updateId: u.updateId, data: u.data })),
        });
        await this.store.ackDocUpdates(page.id, answer.acks);
        this.edited.add(page.id);
        // The page is now held here: later heads are pulled for it.
        if (!cursor) {
          await this.store.applyRemoteDocUpdates(page.id, { epoch, headSeq: 0, updates: [] });
          cursor = { epoch, headSeq: 0 };
        }
      } catch (error) {
        if (!(error instanceof SyncHttpError)) throw error;
        if (error.code === 'limit.size' && batch.length > 1) {
          // Over the request's limit after all: one at a time, so only a too-large one is refused.
          queue.unshift(...batch.map((u) => [u]));
          continue;
        }
        if (await this.refusedPush(workspaceId, page, error, batch)) return;
      }
    }
  }

  /**
   * What a refused push means (SYNC_DESIGN.md, Across the two models; Epoch change). True when
   * the page's other batches are not to be sent.
   */
  private async refusedPush(
    workspaceId: Id,
    page: PageRecord,
    error: SyncHttpError,
    batch: StoredUpdate[],
  ): Promise<boolean> {
    switch (error.code) {
      case 'doc.epochMismatch':
        // The server replaced the document's history: unsent edits are set aside (a recovered
        // page), and the page is pulled again from the start of the new epoch.
        await this.setAside(workspaceId, page.id, 'doc.epochMismatch');
        await this.resetDoc(page.id);
        return true;
      case 'access.denied':
        // Edit access went while offline: the edits become a recovered page, and the page is
        // what the server holds.
        await this.setAside(workspaceId, page.id, 'access.denied');
        await this.resetDoc(page.id);
        return true;
      case 'not.found':
        // Read access went too: the edits are set aside; the feed's revoke removes the page.
        await this.setAside(workspaceId, page.id, 'access.denied');
        return true;
      case 'page.gone':
        // Deleted for good on the server: the edits become a recovered page.
        await this.setAside(workspaceId, page.id, 'page.gone');
        return true;
      case 'limit.size':
        await this.store.quarantineUpdates(
          page.id,
          batch.map((u) => u.localSeq),
          error.code,
        );
        this.notice(error.code, workspaceId, page.id);
        return false;
      case 'client.tooOld':
        // The page needs a newer app: its edits stay here, unsent, and the page is read-only.
        this.heldBack.add(page.id);
        this.notice(error.code, workspaceId, page.id);
        return true;
      default:
        throw error;
    }
  }

  /**
   * The page's log emptied (the empty update stands as sent) so it is pulled from the start. Only
   * what was read here gives way: an update written meanwhile stays, to be sent.
   */
  private async resetDoc(pageId: Id) {
    const doc = await this.store.loadDoc(pageId);
    const upTo = doc.updates.reduce((n, u) => Math.max(n, u.localSeq), doc.snapshotCovers);
    const updateId = uuidv7();
    await this.store.replaceDoc(pageId, { updateId, data: EMPTY_UPDATE }, upTo);
    await this.store.ackDocUpdates(pageId, [{ updateId, seq: 0 }]);
    this.wanted.add(pageId);
    this.emit({ kind: 'docReset', pageId });
  }

  /** Registers the ids this device wrote with, once each; returns those another user holds. */
  private async register(workspaceId: Id, ids: number[]): Promise<Set<number>> {
    const known = new Set((await this.store.getPref<number[]>(registeredKey(workspaceId))) ?? []);
    const missing = ids.filter((id) => !known.has(id));
    if (!missing.length) return new Set();
    const answer = await this.api.yjsClients(workspaceId, { register: missing });
    for (const id of answer.registered) known.add(id);
    await this.store.setPref(registeredKey(workspaceId), [...known]);
    return new Set(answer.refused);
  }

  /**
   * The Yjs client id this session writes a workspace's documents as: one the server issued to
   * this device (unique in the workspace), or a random one registered when it is pushed.
   */
  async clientIdFor(workspaceId: Id): Promise<number | undefined> {
    const workspace = (await this.store.readMirror(workspaceId)).workspaces[0];
    if (!workspace || workspace.localOnly) return undefined;
    const existing = this.sessionIds.get(workspaceId);
    if (existing !== undefined) return existing;
    const pool = (await this.store.getPref<number[]>(poolKey(workspaceId))) ?? [];
    let id: number | undefined;
    if (pool.length) {
      // A random one, so two tabs starting together rarely take the same.
      id = pool.splice(Math.floor((this.options.random ?? Math.random)() * pool.length), 1)[0];
      await this.store.setPref(poolKey(workspaceId), pool);
    } else id = 1 + Math.floor((this.options.random ?? Math.random)() * 0xfffffffe);
    this.sessionIds.set(workspaceId, id);
    if (pool.length < POOL_LOW && this.account)
      void this.refillPool(workspaceId).catch(() => undefined);
    return id;
  }

  private async refillPool(workspaceId: Id) {
    const answer = await this.api.yjsClients(workspaceId, { issue: POOL_FILL });
    const pool = (await this.store.getPref<number[]>(poolKey(workspaceId))) ?? [];
    await this.store.setPref(poolKey(workspaceId), [...pool, ...answer.issued]);
    const known = new Set((await this.store.getPref<number[]>(registeredKey(workspaceId))) ?? []);
    for (const id of answer.issued) known.add(id);
    await this.store.setPref(registeredKey(workspaceId), [...known]);
  }

  // 3. The change feed -----------------------------------------------------------------------------

  private async pullChanges(workspace: WorkspaceRecord, account: Account) {
    let cursor = await this.store.syncCursor(workspace.id);
    if (cursor === null) {
      await this.firstSync(workspace.id, account);
      return;
    }
    let resynced = false;
    for (;;) {
      let page;
      try {
        page = await this.api.changes(workspace.id, cursor, 500);
      } catch (error) {
        if (
          !resynced &&
          error instanceof SyncHttpError &&
          error.status === 410 &&
          error.code === 'feed.expired'
        ) {
          // This device was away longer than the feed keeps changes: the whole tree, with its
          // cursor, replaces the mirror; the outbox stays, and is sent as ever.
          cursor = await this.fullResync(workspace.id, account);
          resynced = true;
          continue;
        }
        throw error;
      }
      const roots = new Set<Id>();
      const batch = batchOf(workspace.id, page.changes, account, roots, (event) =>
        this.emit(event),
      );
      batch.cursor = page.cursor;
      await this.beforeRemote(workspace.id, batch.pages ?? []);
      if (batch.deletePages?.length || batch.deleteWorkspace) this.quarantineDirty = true;
      await this.store.applyRemote(batch);
      if (page.changes.length) this.emit({ kind: 'mirror', workspaceId: workspace.id });
      for (const root of roots)
        await this.resync(workspace.id, root === workspace.id ? null : root, account);
      cursor = page.cursor;
      if (!page.more) return;
    }
  }

  /**
   * Before the server's records of pages are taken: pages whose head moved are pulled, and a page
   * this session edited that the server has in the trash is told of (its edits are there on
   * restore).
   */
  private async beforeRemote(workspaceId: Id, pages: PageRecord[]) {
    const heads = await this.store.docCursors(workspaceId);
    for (const p of pages) {
      const held = heads[p.id];
      if (held && ((p.docHeadSeq ?? 0) > held.headSeq || (p.docEpoch ?? 0) !== held.epoch))
        this.wanted.add(p.id);
      if (!this.edited.delete(p.id) || !p.trashedAt) continue;
      const local = await this.store.getPage(p.id);
      if (local && !local.trashedAt) this.notice('page.trashed', workspaceId, p.id);
    }
  }

  /** The feed has been pruned past this device's cursor: the whole tree, cursor included. */
  private async fullResync(workspaceId: Id, account: Account): Promise<number> {
    const tree = await this.api.tree(workspaceId, null);
    await this.beforeRemote(workspaceId, tree.pages);
    this.quarantineDirty = true;
    await this.store.applyRemote({
      workspaceId,
      cursor: tree.cursor,
      workspaces: [{ ...tree.workspace, localOnly: false, accountId: account.id }],
      sections: tree.sections,
      pages: tree.pages,
      favourites: tree.favourites,
      visits: tree.visits,
      replace: { root: null },
    });
    this.emit({ kind: 'mirror', workspaceId });
    return tree.cursor;
  }

  /**
   * The scoped resync: what the server holds of a subtree (or the whole tree) replaces it here.
   * When a page under the root here is not under it there (moved away, or gone), only the whole
   * tree says which: a scoped replace would remove a page that was only moved (and set its unsent
   * edits aside), so the whole tree replaces the mirror instead.
   */
  private async resync(workspaceId: Id, root: Id | null, account: Account) {
    let tree = await this.api.tree(workspaceId, root);
    if (root !== null && (await this.leftOut(workspaceId, root, tree.pages))) {
      root = null;
      tree = await this.api.tree(workspaceId, null);
    }
    await this.beforeRemote(workspaceId, tree.pages);
    this.quarantineDirty = true;
    await this.store.applyRemote({
      workspaceId,
      sections: tree.sections,
      pages: tree.pages,
      favourites: tree.favourites,
      visits: tree.visits,
      workspaces: [{ ...tree.workspace, localOnly: false, accountId: account.id }],
      replace: { root },
    });
    this.emit({ kind: 'mirror', workspaceId });
  }

  /**
   * After a subtree operation was answered (and the feed read): the local planner changed the
   * pages under the root as it saw them, and the server those under it as it saw them. A page
   * changed here that the server did not change gets no feed change, so a tree the server cannot
   * hold (a page in the trash under a root that is not, or not above it; a page under a trashed
   * parent that is not trashed; a page in another section than its parent) means the whole tree
   * is taken again.
   */
  private async reconcileTree(workspaceId: Id, account: Account) {
    if (!this.reconcile.has(workspaceId)) return;
    const pages = (await this.store.readMirror(workspaceId)).pages;
    const pending = new Set(
      (await this.store.nextOutboxBatch(OUTBOX_ALL, workspaceId)).map((op) => op.entityId),
    );
    if (impossibleTree(pages, pending)) await this.resync(workspaceId, null, account);
    this.reconcile.delete(workspaceId);
  }

  /** Whether a page under `root` here (not made here and still unsent) is missing from `pages`. */
  private async leftOut(workspaceId: Id, root: Id, pages: PageRecord[]): Promise<boolean> {
    const sent = new Set(pages.map((p) => p.id));
    const local = (await this.store.readMirror(workspaceId)).pages;
    const here = new Set(local.map((p) => p.id));
    const creating = await this.creating(workspaceId);
    const children = new Map<Id, Id[]>();
    for (const page of local)
      if (page.parentPageId) {
        const list = children.get(page.parentPageId) ?? [];
        list.push(page.id);
        children.set(page.parentPageId, list);
      }
    const queue = [root];
    const seen = new Set<Id>();
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!sent.has(id) && !creating.has(id) && here.has(id)) return true;
      queue.push(...(children.get(id) ?? []));
    }
    return false;
  }

  // 4. Documents -----------------------------------------------------------------------------------

  /**
   * Pulls one page now (it is being opened); resolves when this device holds what the server has.
   * The first opening in a session also checks the page's state hash (in a pass, soon).
   */
  async pullPage(pageId: Id): Promise<void> {
    const page = await this.store.getPage(pageId);
    if (!page || !this.account) return;
    // Before the first pass knows the workspace syncs, or while the page's creation is still on
    // its way: the server has nothing to give yet (and a 404 would be logged). A pass pulls it.
    if (!this.mine.has(page.workspaceId) || (await this.creating(page.workspaceId)).has(pageId)) {
      this.wanted.add(pageId);
      this.kick();
      return;
    }
    await this.pullDoc(page);
    if (this.heldChanged.delete(page.workspaceId))
      this.emit({ kind: 'offline', workspaceId: page.workspaceId });
    if (!this.opened.has(pageId)) {
      this.opened.add(pageId);
      this.checks.set(pageId, 0);
      this.kick();
    }
  }

  /**
   * The document layer found updates still pending after its retry (SYNC_DESIGN.md, Pending
   * updates): the page's state hash is compared with the server's soon, and repaired if they differ.
   */
  suspect(pageId: Id) {
    this.checks.set(pageId, 0);
    this.repairReported.delete(pageId);
    this.kick();
  }

  /** Pages made here whose `page.create` still waits in the outbox: not on the server yet. */
  private async creating(workspaceId: Id): Promise<Set<Id>> {
    return new Set(
      (await this.store.nextOutboxBatch(OUTBOX_ALL, workspaceId))
        .filter((op) => op.type === 'page.create')
        .map((op) => op.entityId),
    );
  }

  private async pullDocs(workspace: WorkspaceRecord, pages: PageRecord[], pinned: Set<Id>) {
    const heads = await this.store.docCursors(workspace.id);
    const creating = await this.creating(workspace.id);
    for (const page of pages) {
      if (creating.has(page.id)) continue;
      const held = heads[page.id];
      const moved =
        held && ((page.docHeadSeq ?? 0) > held.headSeq || (page.docEpoch ?? 0) !== held.epoch);
      if (!this.wanted.has(page.id) && !moved) continue;
      const added = await this.pullDoc(page);
      // A pinned page refreshed with others' edits: its state is checked against the server's.
      if (moved && added && pinned.has(page.id) && !this.checks.has(page.id))
        this.checks.set(page.id, 0);
    }
  }

  /** Pulls a page until it holds the server's head; returns how many updates it lacked. */
  private async pullDoc(page: PageRecord): Promise<number> {
    this.wanted.delete(page.id);
    let cursor = await this.store.docCursor(page.id);
    let added = 0;
    for (;;) {
      let pull: DocPull;
      try {
        pull = await this.api.pullDoc(page.id, cursor?.headSeq ?? 0);
      } catch (error) {
        if (error instanceof SyncHttpError && (error.status === 404 || error.status === 410))
          return added;
        throw error;
      }
      if (cursor && pull.epoch !== cursor.epoch) {
        // A hard restore on the server: start again from the new epoch, edits set aside.
        await this.setAside(page.workspaceId, page.id, 'doc.epochMismatch');
        await this.resetDoc(page.id);
        this.wanted.delete(page.id);
        cursor = null;
        continue;
      }
      added += await this.takePull(page, pull, !cursor);
      cursor = { headSeq: pull.cursor, epoch: pull.epoch };
      if (!pull.more) return added;
    }
  }

  /**
   * A pull's answer into the store: the updates this device lacks, its cursor, what was refused.
   * Returns how many updates were new here.
   */
  private async takePull(page: PageRecord, pull: DocPull, first: boolean): Promise<number> {
    const updates = [];
    if (pull.snapshot)
      updates.push({
        seq: pull.snapshot.upToSeq,
        data: await this.api.fetchBytes(pull.snapshot.url),
      });
    updates.push(...pull.updates);
    const added = await this.store.applyRemoteDocUpdates(page.id, {
      epoch: pull.epoch,
      headSeq: pull.cursor,
      updates,
    });
    if (first) this.heldChanged.add(page.workspaceId);
    if (added.length)
      this.emit({ kind: 'doc', pageId: page.id, updates: added.map((u) => u.data) });
    if (pull.rejected.length) {
      const doc = await this.store.loadDoc(page.id);
      const refused = new Set(pull.rejected);
      const bad = doc.updates.filter((u) => refused.has(u.updateId)).map((u) => u.localSeq);
      if (bad.length) {
        await this.store.quarantineUpdates(page.id, bad, 'doc.refused');
        this.notice('doc.refused', page.workspaceId, page.id);
      }
    }
    return added.length;
  }

  // 4b. Pins ---------------------------------------------------------------------------------------

  /** Keeps a page (and, with `subtree`, every page under it, later ones too) on this device. */
  async pin(pageId: Id, subtree = false): Promise<void> {
    const page = await this.store.getPage(pageId);
    if (!page) throw new Error('No such page');
    await this.store.pin({ workspaceId: page.workspaceId, pageId, subtree, pinnedAt: this.iso() });
    this.emit({ kind: 'offline', workspaceId: page.workspaceId });
    this.kick(0);
  }

  /** Stops keeping a page fresh for offline use; what is held stays until it is needed no more. */
  async unpin(pageId: Id): Promise<void> {
    const page = await this.store.getPage(pageId);
    await this.store.unpin(pageId);
    if (page) this.emit({ kind: 'offline', workspaceId: page.workspaceId });
  }

  /** The pin that keeps a page offline: its own, or a subtree pin above it; null if none. */
  async pinOf(pageId: Id): Promise<{ pin: PinRecord; inherited: boolean } | null> {
    const page = await this.store.getPage(pageId);
    if (!page) return null;
    const pins = new Map((await this.store.pins(page.workspaceId)).map((p) => [p.pageId, p]));
    const own = pins.get(pageId);
    if (own) return { pin: own, inherited: false };
    const mirror = await this.store.readMirror(page.workspaceId);
    const byId = new Map(mirror.pages.map((p) => [p.id, p]));
    const seen = new Set<Id>();
    for (let p = byId.get(page.parentPageId ?? ''); p && !seen.has(p.id);) {
      seen.add(p.id);
      const pin = pins.get(p.id);
      if (pin?.subtree) return { pin, inherited: true };
      p = p.parentPageId ? byId.get(p.parentPageId) : undefined;
    }
    return null;
  }

  /** What the shell shows of offline use: pins, how many pinned pages are held, what remains. */
  async offlineProgress(workspaceId: Id): Promise<OfflineProgress> {
    const mirror = await this.store.readMirror(workspaceId);
    const pinned = await this.pinnedPages(workspaceId, mirror.pages);
    const held = new Set(await this.store.heldPages(workspaceId));
    let have = 0;
    for (const id of pinned) if (held.has(id)) have++;
    return {
      pins: await this.store.pins(workspaceId),
      pinned: pinned.size,
      held: have,
      toFetch: pinned.size - have,
      available: held.size,
    };
  }

  /** Pages of the workspace that open with no network: those whose document this device holds. */
  async availableOffline(workspaceId: Id): Promise<Set<Id>> {
    return new Set(await this.store.heldPages(workspaceId));
  }

  /** Live pages the workspace's pins cover: pinned pages and every page under a subtree pin. */
  private async pinnedPages(workspaceId: Id, pages: PageRecord[]): Promise<Set<Id>> {
    const pins = await this.store.pins(workspaceId);
    const out = new Set<Id>();
    if (!pins.length) return out;
    const byId = new Map(pages.map((p) => [p.id, p]));
    const children = new Map<Id, PageRecord[]>();
    for (const page of pages)
      if (page.parentPageId) {
        const list = children.get(page.parentPageId) ?? [];
        list.push(page);
        children.set(page.parentPageId, list);
      }
    for (const pin of pins) {
      const root = byId.get(pin.pageId);
      if (!root || root.trashedAt) continue;
      out.add(root.id);
      if (!pin.subtree) continue;
      const queue = [root.id];
      while (queue.length)
        for (const child of children.get(queue.shift()!) ?? [])
          if (!child.trashedAt && !out.has(child.id)) {
            out.add(child.id);
            queue.push(child.id);
          }
    }
    return out;
  }

  /** A bounded number of pinned pages this device does not hold, a few at a time. */
  private async fetchPinned(workspace: WorkspaceRecord, pinned: Set<Id>) {
    if (!pinned.size) return;
    const held = new Set(await this.store.heldPages(workspace.id));
    const creating = await this.creating(workspace.id);
    const todo = [...pinned].filter((id) => !held.has(id) && !creating.has(id));
    if (!todo.length) return;
    const batch = todo.slice(0, this.options.pinBatch ?? PIN_BATCH);
    if (todo.length > batch.length) this.backlog = true;
    let failure: unknown = null;
    let next = 0;
    const worker = async () => {
      while (next < batch.length && failure === null) {
        const page = await this.store.getPage(batch[next++]);
        if (!page) continue;
        try {
          await this.pullDoc(page);
        } catch (error) {
          failure ??= error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PIN_PARALLEL, batch.length) }, worker));
    this.heldChanged.add(workspace.id);
    if (failure !== null) throw failure;
  }

  // 5. Repair --------------------------------------------------------------------------------------

  private async runChecks(workspace: WorkspaceRecord) {
    let made = 0;
    for (const [pageId, tries] of [...this.checks]) {
      const page = await this.store.getPage(pageId);
      if (!page) {
        this.checks.delete(pageId);
        continue;
      }
      if (page.workspaceId !== workspace.id) continue;
      if (made++ >= CHECKS_PER_PASS) return;
      const outcome = await this.check(page);
      if (outcome === 'done' || (outcome === 'wait' && tries + 1 >= CHECK_TRIES))
        this.checks.delete(pageId);
      else if (outcome === 'wait') this.checks.set(pageId, tries + 1);
      else if (outcome === 'verify') this.checks.set(pageId, 0);
      // 'later': edits wait to be sent; the check comes once they are, at no cost of a try.
    }
  }

  /**
   * Compares the page's state hash with the server's at the same head (SYNC_DESIGN.md, Repair):
   * `done` when settled, `wait` while the server catches up (its hash not ready, the heads not
   * equal yet), `later` while edits wait to be sent, `verify` after a repair (the next check says
   * whether it helped).
   */
  private async check(page: PageRecord): Promise<'done' | 'wait' | 'later' | 'verify'> {
    const cursor = await this.store.docCursor(page.id);
    if (!cursor) return 'done';
    const doc = await this.store.loadDoc(page.id);
    if (doc.updates.some((u) => u.seq === null)) return 'later';
    let state: DocStateHash;
    try {
      state = await this.api.docStateHash(page.id);
    } catch (error) {
      if (error instanceof SyncHttpError && [403, 404, 410].includes(error.status)) return 'done';
      throw error;
    }
    if (state.epoch !== cursor.epoch || state.upToSeq > cursor.headSeq) {
      // The server moved on: the pull comes first.
      this.wanted.add(page.id);
      return 'wait';
    }
    if (state.hash === null || state.upToSeq < cursor.headSeq) return 'wait';
    // What was read must still be what the device holds at that head.
    const now = await this.store.docCursor(page.id);
    if (!now || now.headSeq !== cursor.headSeq || now.epoch !== cursor.epoch) return 'wait';
    const local = await this.codec.stateHash(partsOf(doc));
    const prior = await this.store.repairState(page.id);
    const repaired = prior && prior.epoch === state.epoch && prior.repairs > 0 ? prior : null;
    if (local === state.hash) {
      await this.store.setRepairState({
        pageId: page.id,
        epoch: state.epoch,
        checkedSeq: state.upToSeq,
        at: this.iso(),
        repairs: 0,
      });
      if (repaired) this.notice('doc.repaired', page.workspaceId, page.id);
      return 'done';
    }
    if (repaired) {
      // The repair is not in the server's validated head yet.
      if (state.upToSeq < repaired.checkedSeq) return 'wait';
      // A repair was made at this epoch and did not help: reported, not retried.
      if (!this.repairReported.has(page.id)) {
        this.repairReported.add(page.id);
        this.notice('doc.repairFailed', page.workspaceId, page.id);
      }
      return 'done';
    }
    return (await this.repair(page, state, doc)) ? 'verify' : 'wait';
  }

  /**
   * Sends the device's full state (when the account may edit) and takes the server's from the
   * start. False when it could not be made now (the epoch moved; the page is gone).
   */
  private async repair(page: PageRecord, state: DocStateHash, doc: StoredDoc): Promise<boolean> {
    const parts = partsOf(doc);
    const reader =
      this.heldBack.has(page.id) ||
      page.access === 'view' ||
      page.access === 'comment' ||
      page.access === 'none';
    let update: { updateId: Id; data: Uint8Array } | null = null;
    if (!reader && parts.length) {
      const data = this.codec.merge(parts);
      // The server takes at most 1 MB in one update: a larger state only pulls.
      if (data.byteLength <= PUSH_LIMITS.alone) update = { updateId: uuidv7(), data };
    }
    const request = { epoch: state.epoch, clientSchemaVersion: this.codec.schemaVersion };
    let answer;
    try {
      answer = await this.api.repairDoc(page.id, { ...request, update });
    } catch (error) {
      if (!(error instanceof SyncHttpError)) throw error;
      if (error.status === 404 || error.status === 410) return false;
      if (error.code === 'doc.epochMismatch') {
        this.wanted.add(page.id);
        return false;
      }
      if (!update || ![403, 413, 426].includes(error.status)) throw error;
      // It may not send (or not this much): the pull alone.
      update = null;
      answer = await this.api.repairDoc(page.id, { ...request, update });
    }
    await this.takePull(page, answer.pull, false);
    if (answer.pull.more) await this.pullDoc(page);
    await this.store.setRepairState({
      pageId: page.id,
      epoch: state.epoch,
      // Where the repair shows: the head that holds the device's state, or (a reader) this one.
      checkedSeq: answer.ack?.seq ?? state.upToSeq,
      at: this.iso(),
      repairs: 1,
    });
    return true;
  }

  // 6. Assets --------------------------------------------------------------------------------------

  private async uploadAssets(workspace: WorkspaceRecord) {
    const pending = (await this.store.pendingAssets(20)).filter(
      (a) => a.workspaceId === workspace.id,
    );
    for (const asset of pending) await this.uploadAsset(asset);
  }

  private async uploadAsset(asset: AssetRecord) {
    const bytes = await this.store.getAssetBytes(asset.id);
    if (!bytes) return;
    try {
      const ticket = await this.api.assetTicket(asset.workspaceId, {
        id: asset.id,
        fileName: asset.fileName,
        contentType: asset.contentType,
        sizeBytes: asset.sizeBytes,
      });
      await this.api.putBytes(ticket.uploadUrl, ticket.headers, bytes);
      await this.api.completeAsset(asset.id);
      await this.store.markAssetUploaded(asset.id);
    } catch (error) {
      if (
        error instanceof SyncHttpError &&
        (error.code === 'asset.typeNotAllowed' || error.code === 'limit.size')
      ) {
        // The server will never take it: it stays on this device, and the user is told.
        await this.store.markAssetUploaded(asset.id);
        this.notice(error.code, asset.workspaceId);
        return;
      }
      throw error;
    }
  }

  // Upload of a local workspace (M2.3) ----------------------------------------------------------

  /**
   * Sends a local-only workspace to the account, intact: its id, sections, pages (ids, tree,
   * order, trash), favourites, documents and assets. The workspace is made on the server first;
   * then each page's log becomes one update holding all of it; then the outbox is replaced by the
   * workspace's records as creates, and the loop sends the rest.
   */
  async upload(workspaceId: Id): Promise<void> {
    const account = this.account;
    if (!account) throw new SyncHttpError(401, 'auth.required');
    const current = await this.store.readMirror(workspaceId);
    const workspace = current.workspaces[0];
    if (!workspace) throw new Error('No such workspace');
    if (!workspace.localOnly) return;
    // What the records below stand for. Anything written while the upload runs (a page made at
    // the same time, a key typed into an open page) is not replaced, and is sent after them.
    const replaced = (await this.store.nextOutboxBatch(OUTBOX_ALL, workspaceId)).map(
      (op) => op.opId,
    );
    const snapshot = await this.store.readMirror(workspaceId);
    await this.api.createWorkspace({
      id: workspace.id,
      name: workspace.name,
      icon: workspace.icon,
    });
    const ids = new Set<number>();
    for (const page of snapshot.pages) {
      const doc = await this.store.loadDoc(page.id);
      const parts = partsOf(doc);
      if (!parts.length) continue;
      const merged = parts.length === 1 ? parts[0] : this.codec.merge(parts);
      for (const id of this.codec.clientIds(merged)) ids.add(id);
      const upTo = Math.max(doc.snapshotCovers, ...doc.updates.map((u) => u.localSeq));
      await this.store.replaceDoc(page.id, { updateId: uuidv7(), data: merged }, upTo);
    }
    const refused = ids.size ? await this.registerAll(workspaceId, [...ids]) : new Set<number>();
    if (refused.size) throw new Error('A Yjs client id of this workspace is taken on the server');
    const ops = uploadOps(
      workspace,
      snapshot.sections,
      snapshot.pages,
      snapshot.favourites,
      uuidv7,
    );
    await this.store.beginUpload(workspaceId, account.id, ops, replaced);
    this.mine = new Set();
    this.emit({ kind: 'mirror', workspaceId });
    this.kick(0);
  }

  private async registerAll(workspaceId: Id, ids: number[]): Promise<Set<number>> {
    const refused = new Set<number>();
    for (let i = 0; i < ids.length; i += 1000)
      for (const id of await this.register(workspaceId, ids.slice(i, i + 1000))) refused.add(id);
    return refused;
  }
}

/** Enough to read a workspace's whole outbox. */
const OUTBOX_ALL = 1_000_000;

function entityPage(entity: EntityRecord | null | undefined): Id | undefined {
  if (!entity) return undefined;
  return 'pageId' in entity ? entity.pageId : 'sectionId' in entity ? entity.id : undefined;
}

/**
 * Whether the tree holds a state the server never does, among pages with nothing waiting (their
 * local state stands until the server answers): a trashed page whose trash root is missing, not
 * trashed or not above it; a live page under a trashed parent; a page in another section than its
 * parent.
 */
export function impossibleTree(pages: PageRecord[], pending: ReadonlySet<Id> = new Set()): boolean {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const above = (page: PageRecord, root: Id) => {
    const seen = new Set<Id>();
    for (let p: PageRecord | undefined = page; p && !seen.has(p.id);) {
      if (p.id === root) return true;
      seen.add(p.id);
      p = p.parentPageId ? byId.get(p.parentPageId) : undefined;
    }
    return false;
  };
  for (const page of pages) {
    if (pending.has(page.id)) continue;
    const parent = page.parentPageId ? byId.get(page.parentPageId) : undefined;
    if (parent && !pending.has(parent.id)) {
      if (parent.sectionId !== page.sectionId) return true;
      if (parent.trashedAt && !page.trashedAt) return true;
    }
    const rootId = page.trashRootId;
    if (page.trashedAt && rootId && rootId !== page.id && !pending.has(rootId)) {
      const root = byId.get(rootId);
      if (!root || !root.trashedAt || !above(page, rootId)) return true;
    }
  }
  return false;
}

/** A page of the feed as one batch for the store; access events name subtrees to fetch again. */
export function batchOf(
  workspaceId: Id,
  changes: ServerChange[],
  account: Account,
  roots: Set<Id>,
  emit: (event: SyncEvent) => void,
): RemoteBatch {
  const batch: RemoteBatch = {
    workspaceId,
    workspaces: [],
    sections: [],
    pages: [],
    favourites: [],
    visits: [],
    deleteSections: [],
    deletePages: [],
    deleteFavourites: [],
    deleteVisits: [],
  };
  for (const change of changes) {
    switch (change.entityType) {
      case 'workspace':
        if (change.kind === 'delete') batch.deleteWorkspace = true;
        else if (change.entity)
          batch.workspaces!.push({ ...change.entity, localOnly: false, accountId: account.id });
        break;
      case 'section':
        if (change.kind === 'delete' || !change.entity) batch.deleteSections!.push(change.entityId);
        else batch.sections!.push(change.entity);
        break;
      case 'page':
        if (change.kind === 'delete' || !change.entity) batch.deletePages!.push(change.entityId);
        else batch.pages!.push(change.entity);
        break;
      case 'favourite':
        if (change.kind === 'delete' || !change.entity)
          batch.deleteFavourites!.push(change.entityId);
        else batch.favourites!.push(change.entity);
        break;
      case 'visit':
        if (change.kind === 'delete' || !change.entity) batch.deleteVisits!.push(change.entityId);
        else batch.visits!.push(change.entity);
        break;
      case 'member':
        emit({ kind: 'members', workspaceId });
        break;
      case 'access':
        roots.add(change.entityId);
        break;
    }
  }
  return batch;
}
