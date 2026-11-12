// The sync engine (SYNC_DESIGN.md, The sync loop): the same in the browser and on the desktop,
// over a LocalStore and a SyncApi. One pass, per synced workspace of the signed-in account:
//   1. push the outbox, oldest first, and take the server's answers into the mirror;
//   2. push document updates not yet sent, registering the Yjs client ids they write as;
//   3. pull the change feed until it has no more, and resync any subtree access changed on;
//   4. pull documents this device holds whose server head moved;
//   5. upload assets the server lacks.
// Failures back off exponentially with jitter, capped at 5 minutes; a 401 pauses the loop until
// the user signs in again. Nothing waiting is ever discarded: an update the server refuses is
// moved to the store's corrupt area, and the user is told.
import { uuidv7, type Id } from '../ids';
import { uploadOps } from '../remote';
import type {
  AssetRecord,
  EntityRecord,
  LocalStore,
  OpResult,
  PageRecord,
  RemoteBatch,
  WorkspaceRecord,
} from '../types';
import {
  OfflineError,
  SyncHttpError,
  type Account,
  type DocCodec,
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
  /** A page's document was replaced on the server (a hard restore): reopen it. */
  | { kind: 'docReset'; pageId: Id }
  | { kind: 'members'; workspaceId: Id }
  | { kind: 'notice'; code: string; workspaceId: Id; pageId?: Id };

export interface SyncOptions {
  /** How often a pass runs while nothing else triggers one. */
  intervalMs?: number;
  /** For tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
}

const MAX_BACKOFF = 5 * 60_000;
const POOL_LOW = 4;
const POOL_FILL = 8;
const EMPTY_UPDATE = new Uint8Array([0, 0]);

/** Operations that change a page's whole subtree. */
const SUBTREE_OPS = new Set(['page.move', 'page.trash', 'page.restore', 'page.delete']);

const poolKey = (workspaceId: Id) => `sync:yjsPool:${workspaceId}`;
const registeredKey = (workspaceId: Id) => `sync:yjsRegistered:${workspaceId}`;

export class SyncEngine {
  private account: Account | null = null;
  private running = false;
  private stopped = true;
  private again = false;
  private timer: unknown = null;
  private failures = 0;
  private status_: SyncStatus = { state: 'signedOut', waiting: 0, lastSynced: null };
  private readonly listeners = new Set<(event: SyncEvent) => void>();
  private readonly statusListeners = new Set<(status: SyncStatus) => void>();
  /** Session Yjs client ids, one per workspace (Q9). */
  private readonly sessionIds = new Map<Id, number>();
  /** Pages to pull on the next pass: opened, or their head moved. */
  private readonly wanted = new Set<Id>();
  /** Pages whose pushes the server will not take (read-only, too old a client): not retried this session. */
  private readonly held = new Set<Id>();
  private passes = 0;

  constructor(
    private readonly store: LocalStore,
    private readonly api: SyncApi,
    private readonly codec: DocCodec,
    private readonly options: SyncOptions = {},
  ) {}

  // Lifecycle --------------------------------------------------------------------------------------

  get status(): SyncStatus {
    return this.status_;
  }

  get signedIn(): Account | null {
    return this.account;
  }

  /** Signs the engine in (after `me()` answered) or out; a sign-out keeps everything local. */
  setAccount(account: Account | null) {
    this.account = account;
    this.sessionIds.clear();
    if (account) this.kick(0);
    else void this.report('signedOut');
  }

  start() {
    this.stopped = false;
    this.kick(0);
  }

  stop() {
    this.stopped = true;
    this.clear();
  }

  /** A pass soon: after a local change, when the network returns, when a page opens. */
  kick(delayMs = 300) {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.clear();
    this.timer = (this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(
      () => void this.run(),
      delayMs,
    );
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

  private clear() {
    if (this.timer !== null)
      (this.options.clearTimer ?? ((h) => clearTimeout(h as number)))(this.timer);
    this.timer = null;
  }

  private async report(state: SyncState) {
    const waiting =
      (await this.store.nextOutboxBatch(1000)).filter((op) => this.isMine(op.workspaceId)).length +
      (await this.store.unsentDocUpdates(1000)).reduce((n, d) => n + d.updates.length, 0);
    this.status_ = {
      state,
      waiting,
      lastSynced: state === 'synced' ? new Date().toISOString() : this.status_.lastSynced,
    };
    for (const listener of this.statusListeners) listener(this.status_);
  }

  private mine = new Set<Id>();
  private isMine(workspaceId: Id) {
    return this.mine.has(workspaceId);
  }

  private async run() {
    if (this.running || this.stopped) return;
    this.running = true;
    this.again = false;
    try {
      await this.syncOnce();
      this.failures = 0;
    } catch (error) {
      this.failures++;
      if (error instanceof SyncHttpError && error.status === 401) {
        this.account = null;
        await this.report('signedOut');
      } else await this.report(error instanceof OfflineError ? 'offline' : 'error');
      if (!(error instanceof OfflineError) && !(error instanceof SyncHttpError))
        console.warn('Sync failed:', error);
    } finally {
      this.running = false;
    }
    if (this.stopped) return;
    const base = this.options.intervalMs ?? 1500;
    const delay = this.again
      ? 50
      : this.failures
        ? Math.min(MAX_BACKOFF, 1000 * 2 ** (this.failures - 1)) *
          (0.5 + (this.options.random ?? Math.random)())
        : base;
    if (this.account || this.again) this.kick(delay);
  }

  // One pass ---------------------------------------------------------------------------------------

  async syncOnce(): Promise<void> {
    const account = this.account;
    if (!account) {
      await this.report('signedOut');
      return;
    }
    await this.report('syncing');
    let held = await this.syncedWorkspaces(account);
    // Workspaces the account gained or lost on another device, now and then.
    if (this.passes++ % 10 === 0) {
      const server = await this.api.listWorkspaces();
      const known = new Set(held.map((w) => w.id));
      const there = new Set(server.map((w) => w.id));
      for (const workspace of server)
        if (!known.has(workspace.id)) await this.firstSync(workspace.id, account);
      for (const workspace of held)
        if (!there.has(workspace.id)) {
          await this.store.applyRemote({ workspaceId: workspace.id, deleteWorkspace: true });
          this.emit({ kind: 'mirror', workspaceId: workspace.id });
        }
      held = await this.syncedWorkspaces(account);
    }
    this.mine = new Set(held.map((w) => w.id));
    for (const workspace of held) {
      try {
        await this.pushOutbox(workspace, account);
        await this.pushDocs(workspace);
        await this.pullChanges(workspace, account);
        await this.pullDocs(workspace);
        await this.uploadAssets(workspace);
      } catch (error) {
        // The workspace is gone for this account: forget it here, as another device's removal would.
        if (error instanceof SyncHttpError && error.status === 404 && error.code === 'not.found') {
          await this.store.applyRemote({ workspaceId: workspace.id, deleteWorkspace: true });
          this.emit({ kind: 'mirror', workspaceId: workspace.id });
          this.emit({ kind: 'notice', code: 'workspace.lost', workspaceId: workspace.id });
          continue;
        }
        throw error;
      }
    }
    await this.report('synced');
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
      await this.store.settleOps(results);
      // A refused tree operation changed a whole subtree locally: take the server's subtree back.
      const subtrees = new Set<Id>();
      for (const result of results) {
        const op = ops.find((o) => o.opId === result.opId);
        if (result.status === 'rejected' && result.entity && op && SUBTREE_OPS.has(op.type))
          subtrees.add(op.entityId);
      }
      for (const root of subtrees) await this.resync(workspace.id, root, account);
      for (const result of results) {
        if (result.notice)
          this.emit({
            kind: 'notice',
            code: result.notice,
            workspaceId: workspace.id,
            pageId: entityPage(result.entity),
          });
        if (result.status === 'rejected' && result.error)
          this.emit({
            kind: 'notice',
            code: result.error.code,
            workspaceId: workspace.id,
            pageId: entityPage(result.entity),
          });
      }
      this.emit({ kind: 'mirror', workspaceId: workspace.id });
      if (ops.length < 100) return;
    }
  }

  // 2. Document updates ----------------------------------------------------------------------------

  private async pushDocs(workspace: WorkspaceRecord) {
    for (;;) {
      // A page whose creation has not reached the server yet waits for it: its push would be 404.
      // (Made between this pass's push of the outbox and now; the next pass sends both.)
      const creating = await this.creating(workspace.id);
      const unsent = (await this.store.unsentDocUpdates(200)).filter(
        (doc) => !this.held.has(doc.pageId) && !creating.has(doc.pageId),
      );
      let pushed = 0;
      for (const doc of unsent) {
        const page = await this.store.getPage(doc.pageId);
        if (!page || page.workspaceId !== workspace.id) continue;
        const ids = [...new Set(doc.updates.flatMap((u) => this.codec.clientIds(u.data)))];
        const refused = await this.register(workspace.id, ids);
        let updates = doc.updates;
        if (refused.size) {
          // Written as an id another person holds here: the server would refuse it. Kept aside.
          const bad = updates.filter((u) =>
            this.codec.clientIds(u.data).some((id) => refused.has(id)),
          );
          await this.store.quarantineUpdates(
            page.id,
            bad.map((u) => u.localSeq),
            'yjs.clientTaken',
          );
          this.emit({
            kind: 'notice',
            code: 'doc.clientTaken',
            workspaceId: workspace.id,
            pageId: page.id,
          });
          updates = updates.filter((u) => !bad.includes(u));
        }
        if (!updates.length) continue;
        const cursor = await this.store.docCursor(page.id);
        try {
          const answer = await this.api.pushDoc(page.id, {
            epoch: cursor?.epoch ?? page.docEpoch ?? 0,
            clientSchemaVersion: this.codec.schemaVersion,
            updates: updates.map((u) => ({ updateId: u.updateId, data: u.data })),
          });
          await this.store.ackDocUpdates(page.id, answer.acks);
          // The page is now held here: later heads are pulled for it.
          if (!cursor)
            await this.store.applyRemoteDocUpdates(page.id, {
              epoch: page.docEpoch ?? 0,
              headSeq: 0,
              updates: [],
            });
          pushed += updates.length;
        } catch (error) {
          if (!(error instanceof SyncHttpError)) throw error;
          await this.refusedPush(
            workspace.id,
            page,
            error,
            updates.map((u) => u.localSeq),
          );
        }
      }
      if (pushed < 200) return;
    }
  }

  /** What a refused push means (SYNC_DESIGN.md, Across the two models; Epoch change). */
  private async refusedPush(
    workspaceId: Id,
    page: PageRecord,
    error: SyncHttpError,
    localSeqs: number[],
  ) {
    switch (error.code) {
      case 'doc.epochMismatch':
        // The server replaced the document's history: unsent edits are kept aside, and the page is
        // pulled again from the start of the new epoch.
        await this.store.quarantineUpdates(page.id, localSeqs, 'doc.epochMismatch');
        await this.resetDoc(page.id);
        this.emit({ kind: 'notice', code: error.code, workspaceId, pageId: page.id });
        return;
      case 'page.gone':
      case 'access.denied':
      case 'not.found':
      case 'limit.size':
        await this.store.quarantineUpdates(page.id, localSeqs, error.code);
        this.emit({ kind: 'notice', code: error.code, workspaceId, pageId: page.id });
        return;
      case 'client.tooOld':
        this.held.add(page.id);
        this.emit({ kind: 'notice', code: error.code, workspaceId, pageId: page.id });
        return;
      default:
        throw error;
    }
  }

  /** The page's log emptied (the empty update stands as sent) so it is pulled from the start. */
  private async resetDoc(pageId: Id) {
    const updateId = uuidv7();
    await this.store.replaceDoc(pageId, { updateId, data: EMPTY_UPDATE });
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
    for (;;) {
      const page = await this.api.changes(workspace.id, cursor, 500);
      const roots = new Set<Id>();
      const batch = batchOf(workspace.id, page.changes, account, roots, (event) =>
        this.emit(event),
      );
      batch.cursor = page.cursor;
      const heads = await this.store.docCursors(workspace.id);
      for (const p of batch.pages ?? [])
        if (heads[p.id] && (p.docHeadSeq ?? 0) > heads[p.id].headSeq) this.wanted.add(p.id);
      await this.store.applyRemote(batch);
      if (page.changes.length) this.emit({ kind: 'mirror', workspaceId: workspace.id });
      for (const root of roots)
        await this.resync(workspace.id, root === workspace.id ? null : root, account);
      cursor = page.cursor;
      if (!page.more) return;
    }
  }

  /** The scoped resync: what the server holds of a subtree (or the whole tree) replaces it here. */
  private async resync(workspaceId: Id, root: Id | null, account: Account) {
    const tree = await this.api.tree(workspaceId, root);
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

  // 4. Documents -----------------------------------------------------------------------------------

  /** Pulls one page now (it is being opened); resolves when this device holds what the server has. */
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
  }

  /** Pages made here whose `page.create` still waits in the outbox: not on the server yet. */
  private async creating(workspaceId: Id): Promise<Set<Id>> {
    return new Set(
      (await this.store.nextOutboxBatch(OUTBOX_ALL, workspaceId))
        .filter((op) => op.type === 'page.create')
        .map((op) => op.entityId),
    );
  }

  private async pullDocs(workspace: WorkspaceRecord) {
    const heads = await this.store.docCursors(workspace.id);
    const mirror = await this.store.readMirror(workspace.id);
    const creating = await this.creating(workspace.id);
    for (const page of mirror.pages) {
      if (creating.has(page.id)) continue;
      const held = heads[page.id];
      if (
        this.wanted.has(page.id) ||
        (held && (page.docHeadSeq ?? 0) > held.headSeq) ||
        (held && (page.docEpoch ?? 0) !== held.epoch)
      )
        await this.pullDoc(page);
    }
  }

  private async pullDoc(page: PageRecord) {
    this.wanted.delete(page.id);
    let cursor = await this.store.docCursor(page.id);
    for (;;) {
      let pull;
      try {
        pull = await this.api.pullDoc(page.id, cursor?.headSeq ?? 0);
      } catch (error) {
        if (error instanceof SyncHttpError && (error.status === 404 || error.status === 410))
          return;
        throw error;
      }
      if (cursor && pull.epoch !== cursor.epoch) {
        // A hard restore on the server: start again from the new epoch, edits kept aside.
        const unsent = (await this.store.unsentDocUpdates(10_000)).find(
          (d) => d.pageId === page.id,
        );
        if (unsent)
          await this.store.quarantineUpdates(
            page.id,
            unsent.updates.map((u) => u.localSeq),
            'doc.epochMismatch',
          );
        await this.resetDoc(page.id);
        this.emit({
          kind: 'notice',
          code: 'doc.epochMismatch',
          workspaceId: page.workspaceId,
          pageId: page.id,
        });
        cursor = null;
        continue;
      }
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
      if (added.length)
        this.emit({ kind: 'doc', pageId: page.id, updates: added.map((u) => u.data) });
      if (pull.rejected.length) {
        const doc = await this.store.loadDoc(page.id);
        const refused = new Set(pull.rejected);
        const bad = doc.updates.filter((u) => refused.has(u.updateId)).map((u) => u.localSeq);
        if (bad.length) {
          await this.store.quarantineUpdates(page.id, bad, 'doc.refused');
          this.emit({
            kind: 'notice',
            code: 'doc.refused',
            workspaceId: page.workspaceId,
            pageId: page.id,
          });
        }
      }
      cursor = { headSeq: pull.cursor, epoch: pull.epoch };
      if (!pull.more) return;
    }
  }

  // 5. Assets --------------------------------------------------------------------------------------

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
        this.emit({ kind: 'notice', code: error.code, workspaceId: asset.workspaceId });
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
      const parts = [...(doc.snapshot ? [doc.snapshot] : []), ...doc.updates.map((u) => u.data)];
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
