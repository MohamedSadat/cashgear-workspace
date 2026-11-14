// The open workspace: the local store, the metadata mirror drawn by the sidebar, and the page
// documents currently open. Every change to the tree is an operation, planned against the mirror,
// made durable by the store, then shown (SYNC_DESIGN.md, Channel 2).
//
// Phase 4: rows. The mirror holds a database's rows once something needs them (a view, a plan
// that reads them); they are read from the store then, and again whenever the sync engine says a
// held database's rows changed (`rowsChanged`) or the mirror is read again. A row is a page for
// documents, titles, search and the trash; its access is its database's.
import type { DocEvent, DocJSON, DocumentOptions, PageDocument } from '@cgw/doc';
import {
  Mirror,
  OpError,
  keyBetween,
  newOp,
  normaliseText,
  planOps,
  searchTerms,
  uuidv7,
  type Id,
  type LocalStore,
  type Operation,
  type PageKind,
  type PageRecord,
  type PropertyDef,
  type RowRecord,
  type SearchHit,
  type SectionRecord,
  type WorkspaceRecord,
} from '@cgw/workspace';

const LAST_WORKSPACE = 'cgw-workspace';
const OPEN_LIMIT = 4;

export interface NewPage {
  sectionId: Id;
  parentPageId: Id | null;
  title?: string;
  icon?: string | null;
  /** Insert after this sibling; at the end when absent. */
  after?: Id | null;
}

/** What the cloud connection gives the session (cloud/cloud.ts); absent, the session is local only. */
export interface CloudHooks {
  /** The Yjs client id this session writes a workspace's documents as (Q9). */
  clientIdFor(workspaceId: Id): Promise<number | undefined>;
  /** Pulls a page's document from the server, if its workspace syncs. */
  pullPage(pageId: Id): Promise<void>;
  /** Something changed locally: sync soon. */
  changed(): void;
  /** A workspace was just made here. */
  created?(workspaceId: Id): void;
  /**
   * The page is being opened and this device holds nothing of its document: it is pulled now.
   * True when it was (open the page again), false when its workspace does not sync; throws
   * NotOnDeviceError when the server cannot be reached or nobody is signed in.
   */
  fetchMissing?(pageId: Id): Promise<boolean>;
  /** What an open document reports (a move conflict, updates still pending after the retry). */
  docEvent?(event: DocEvent): void;
  /**
   * Phase 6: the page on screen (the document opened last) is `pageId` (`open`), or no longer is
   * (another page opened, or this one closed): it is joined on the hub while it is shown.
   */
  live?(pageId: Id, open: boolean): void;
  /** Phase 6: an open document was saved: its updates may go out at once (else `changed`). */
  saved?(pageId: Id): void;
}

/** A page whose document this device does not hold, opened while it cannot be fetched. */
export class NotOnDeviceError extends Error {
  constructor(
    readonly pageId: Id,
    /** `offline`: the server cannot be reached; `signedOut`: nobody is signed in to ask it. */
    readonly reason: 'offline' | 'signedOut',
  ) {
    super('This page is not on this device');
    this.name = 'NotOnDeviceError';
  }
}

/**
 * A page saved by a newer build whose document this device does not hold: it is shown read-only
 * from the server's derived JSON, never pulled into an editor that could not keep it (D7).
 */
export class NewerDocumentError extends Error {
  constructor(readonly pageId: Id) {
    super('This page needs a newer version of the app');
    this.name = 'NewerDocumentError';
  }
}

/** Whether the account may change a page's document (a local page is the user's own). */
/**
 * Whether the account may change a page: its title, icon, cover, place and document (a local page
 * is the user's own). The interface opens anything else read-only; the server is still the check.
 */
export const canEditPage = (page: PageRecord | undefined) =>
  !page?.access || page.access === 'full' || page.access === 'edit';
const mayEdit = canEditPage;

/** A page, a database's page or a row, as the session finds it by id. */
export type AnyPage = PageRecord | RowRecord;

/**
 * A hit of the server's search: what was found and, for a row, its database (this device may not
 * hold the row; rows are not in the tree). An older server names neither.
 */
export interface RemoteSearchHit extends SearchHit {
  kind?: PageKind;
  databaseId?: Id | null;
}

export const isRowRecord = (page: AnyPage | undefined | null): page is RowRecord =>
  page?.kind === 'row';

/** Nothing of the page's document is on this device: no snapshot, no update. */
const holdsNothing = (doc: PageDocument) => doc.doc.store.clients.size === 0;

export class WorkspaceSession {
  readonly mirror: Mirror;
  private readonly docs = new Map<Id, Promise<PageDocument>>();
  /** Whether each open document was opened to edit (`canEdit`), to reopen it if access changes. */
  private readonly editable = new Map<Id, boolean>();
  /** Blank pages made in this session and not yet shown: their title takes focus when shown. */
  private readonly fresh = new Set<Id>();
  private readonly order: Id[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  /** Edits waiting on a delay of their own (a title being typed), written by `flushAll`. */
  private readonly flushers = new Set<() => Promise<void> | void>();
  private workspace: Id | null;
  private readonly listeners = new Set<() => void>();
  private readonly resetListeners = new Set<(pageId: Id) => void>();
  /** Databases whose rows are in the mirror: read again with it (`reloadMirror`, `rowsChanged`). */
  private readonly rowDatabases = new Set<Id>();
  private readonly rowListeners = new Set<(databaseId: Id) => void>();
  private readonly pendingRows = new Set<Id>();
  private rowsTask: Promise<void> | null = null;
  /** Each workspace's count of rows in the trash on their own (`trashedRowCount`). */
  private readonly rowTrash = new Map<Id, { count: number; fresh: boolean; counting: boolean }>();
  private readonly rowTrashListeners = new Set<() => void>();
  private cloud: CloudHooks | null = null;
  /** The page on screen: the document opened last, until another opens or it closes (Phase 6). */
  private shown: Id | null = null;
  /** Bytes of an asset this device does not hold, from the server (cloud/cloud.ts). */
  remoteAssets: ((assetId: Id) => Promise<Uint8Array | null>) | null = null;
  /** Server search for a synced workspace, merged after local hits by the palette (M2.7). */
  remoteSearch: ((q: string, limit: number) => Promise<RemoteSearchHit[]>) | null = null;
  /** A bookmark's preview from the server, for a synced workspace (cloud/cloud.ts). */
  remotePreview:
    | ((url: string) => Promise<{
        title: string | null;
        description: string | null;
        siteName: string | null;
        imageAssetId: Id | null;
      } | null>)
    | null = null;

  private constructor(
    readonly store: LocalStore,
    mirror: Mirror,
    workspaceId: Id | null,
    private readonly docOptions: DocumentOptions = {},
  ) {
    this.mirror = mirror;
    this.workspace = workspaceId;
  }

  static async start(
    store: LocalStore,
    docOptions: DocumentOptions = {},
  ): Promise<WorkspaceSession> {
    const mirror = new Mirror(await store.readMirror(null));
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_WORKSPACE);
    } catch {
      // No memory of the last workspace; take the first.
    }
    const live = [...mirror.workspaces.values()].filter((w) => !w.deletedAt);
    const chosen =
      live.find((w) => w.id === last) ?? live.sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    return new WorkspaceSession(store, mirror, chosen?.id ?? null, docOptions);
  }

  connect(hooks: CloudHooks) {
    this.cloud = hooks;
    if (this.shown) hooks.live?.(this.shown, true);
  }

  /** A page's open document, if the session has it open (or is opening it). */
  openDocument(pageId: Id): Promise<PageDocument> | undefined {
    return this.docs.get(pageId);
  }

  /** The page on screen changed (Phase 6): the cloud joins it on the hub while it is shown. */
  private show(pageId: Id | null) {
    if (pageId === this.shown) return;
    const before = this.shown;
    this.shown = pageId;
    if (before) this.cloud?.live?.(before, false);
    if (pageId) this.cloud?.live?.(pageId, true);
  }

  /**
   * The mirror read again from the store, after the sync engine wrote what the server said. The
   * rows it held are read with it and put back at once, so a plan or a view never sees them gone.
   * In turn with the changes made here, so nothing read before a change is shown after it.
   */
  reloadMirror(): Promise<void> {
    return this.serial(() => this.reloadMirrorNow());
  }

  private async reloadMirrorNow(): Promise<void> {
    const snapshot = await this.store.readMirror(null);
    const kept = [...this.rowDatabases].filter((id) => snapshot.databases.some((d) => d.id === id));
    const rows = await Promise.all(kept.map((id) => this.store.readRows(id)));
    this.mirror.reset(snapshot);
    this.rowDatabases.clear();
    kept.forEach((id, i) => {
      this.mirror.loadRows(id, rows[i]);
      this.rowDatabases.add(id);
    });
    // The store took changes from elsewhere: rows of a database removed with it, say.
    this.trashedRowsMoved();
    // Access changed on the server (a resync): a page opened to edit, or to read, opens again the
    // other way, so the editor follows and a reader's open never writes.
    for (const [pageId, editable] of this.editable) {
      const page = this.record(pageId);
      if (page && this.docs.has(pageId) && this.canEdit(pageId) !== editable) this.resetDoc(pageId);
    }
    // A workspace this device lost goes from view; the first one the account brings opens.
    if (!this.workspace || !this.mirror.workspaces.has(this.workspace)) {
      const next = this.workspaces()[0]?.id ?? null;
      if (next !== this.workspace) {
        this.workspace = next;
        for (const listener of this.listeners) listener();
      }
    }
  }

  /** Updates another device made, already stored: the open document shows them. */
  applyRemoteDoc(pageId: Id, updates: Uint8Array[]) {
    const open = this.docs.get(pageId);
    if (open) void open.then((doc) => doc.applyRemote(updates)).catch(() => undefined);
    this.scheduleIndex(pageId);
  }

  /** The page's document was replaced on the server: it is closed and opened again. */
  resetDoc(pageId: Id) {
    this.forget(pageId);
    for (const listener of this.resetListeners) listener(pageId);
  }

  onDocReset(listener: (pageId: Id) => void): () => void {
    this.resetListeners.add(listener);
    return () => void this.resetListeners.delete(listener);
  }

  private clientIdFor(pageId: Id): Promise<number | undefined> {
    const workspaceId = this.record(pageId)?.workspaceId ?? this.workspace;
    return workspaceId && this.cloud
      ? this.cloud.clientIdFor(workspaceId)
      : Promise.resolve(undefined);
  }

  get workspaceId(): Id | null {
    return this.workspace;
  }

  get current(): WorkspaceRecord | null {
    return this.workspace ? (this.mirror.workspaces.get(this.workspace) ?? null) : null;
  }

  workspaces(): WorkspaceRecord[] {
    return [...this.mirror.workspaces.values()]
      .filter((w) => !w.deletedAt)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  switchTo(workspaceId: Id) {
    this.workspace = workspaceId;
    try {
      localStorage.setItem(LAST_WORKSPACE, workspaceId);
    } catch {
      // The choice then lasts until the page closes.
    }
    for (const listener of this.listeners) listener();
  }

  onSwitch(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Plans against the mirror, writes through the store, then shows. One at a time. */
  apply(ops: Operation[]): Promise<void> {
    return this.serial(async () => {
      // The rows a plan reads (the database's, and those its relations point into) are here first.
      await this.prepareRows(ops);
      const plan = await planOps(ops, this.mirror);
      // A row trashed, restored or removed: the trash's count of rows is read again (after the
      // write).
      const ownRoot = (row: RowRecord | undefined) => !!row && row.trashRootId === row.id;
      const trashMoved =
        plan.deleteRows.length > 0 ||
        plan.rows.some((row) => ownRoot(row) !== ownRoot(this.mirror.rowRecords.get(row.id)));
      // The change shows at once (a cell, a title, a page), and the store's write follows: a
      // cell edit waited for IndexedDB's commit (about 20 ms) and its old value showed for a
      // frame or two (bench/phase4.mjs, "local ≤ 16 ms").
      this.mirror.apply(plan);
      try {
        await this.store.applyLocalOps(ops);
      } catch (error) {
        // The store saw something the mirror did not: its truth, read back whole.
        await this.reloadMirrorNow();
        throw error;
      }
      if (trashMoved) this.trashedRowsMoved();
      // A database made here holds every row it has: its (new) rows are all in the mirror.
      for (const op of ops)
        if (op.type === 'page.create' && op.payload.kind === 'database') {
          if (!this.mirror.rowsLoaded(op.entityId))
            this.mirror.loadRows(op.entityId, this.mirror.rowsOf(op.entityId));
          this.rowDatabases.add(op.entityId);
        }
      this.cloud?.changed();
    });
  }

  /** Runs after everything asked for before it (changes, mirror and row reads), one at a time. */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // Rows ----------------------------------------------------------------------------------------

  /** A page, a database's page or a row (if its database's rows are in the mirror). */
  record(pageId: Id): AnyPage | undefined {
    return this.mirror.pages.get(pageId) ?? this.mirror.rowRecords.get(pageId);
  }

  /**
   * Whether the account may change a page; a row is changed as its database may be (contract
   * section 1: a row's level is its database's). The server is still the check.
   */
  canEdit(pageId: Id): boolean {
    const page = this.record(pageId);
    if (!isRowRecord(page)) return mayEdit(page);
    return mayEdit(page) && mayEdit(this.mirror.pages.get(page.databaseId));
  }

  /** A database's rows held on this device, read into the mirror if they are not there yet. */
  loadRows(databaseId: Id): Promise<RowRecord[]> {
    if (this.mirror.rowsLoaded(databaseId) && this.rowDatabases.has(databaseId))
      return Promise.resolve(this.mirror.rowsOf(databaseId));
    return this.serial(() => this.loadRowsNow(databaseId));
  }

  private async loadRowsNow(databaseId: Id): Promise<RowRecord[]> {
    if (!this.mirror.rowsLoaded(databaseId))
      this.mirror.loadRows(databaseId, await this.store.readRows(databaseId));
    this.rowDatabases.add(databaseId);
    return this.mirror.rowsOf(databaseId);
  }

  /** A row by id: from the mirror, else from the store (its database's rows are read then). */
  async findRow(rowId: Id): Promise<RowRecord | null> {
    const known = this.mirror.rowRecords.get(rowId);
    if (known) return known;
    const stored = await this.store.getPage(rowId);
    if (!isRowRecord(stored)) return null;
    await this.loadRows(stored.databaseId);
    return this.mirror.rowRecords.get(rowId) ?? stored;
  }

  /**
   * The sync engine wrote rows of a held database (or its hold changed): the mirror reads them
   * again. Several at once are read once; listeners hear of each database after.
   */
  rowsChanged(databaseId: Id) {
    this.pendingRows.add(databaseId);
    this.rowsTask ??= this.serial(async () => {
      this.rowsTask = null;
      const ids = [...this.pendingRows];
      this.pendingRows.clear();
      for (const id of ids)
        if (this.rowDatabases.has(id)) this.mirror.loadRows(id, await this.store.readRows(id));
      this.trashedRowsMoved();
      for (const id of ids) for (const listener of this.rowListeners) listener(id);
    });
  }

  /**
   * How many rows of a workspace are in the trash on their own (each its own trash root), for the
   * sidebar's count: 0 until counted. Rows are not all in the mirror, so the store counts them,
   * again only when a change could move the count: a plan here that trashes, restores or deletes
   * a row, the sync engine's word that rows changed, or the mirror read again; never per edit.
   */
  trashedRowCount(workspaceId: Id): number {
    let entry = this.rowTrash.get(workspaceId);
    if (!entry)
      this.rowTrash.set(workspaceId, (entry = { count: 0, fresh: false, counting: false }));
    if (!entry.fresh && !entry.counting) void this.countTrashedRows(workspaceId);
    return entry.count;
  }

  /** Told when a workspace's count of trashed rows has changed. Stable, for `useSyncExternalStore`. */
  readonly onTrashedRows = (listener: () => void): (() => void) => {
    this.rowTrashListeners.add(listener);
    return () => void this.rowTrashListeners.delete(listener);
  };

  /** The counts are stale: the open workspace's is counted now, the others when next asked. */
  private trashedRowsMoved() {
    for (const [id, entry] of this.rowTrash) {
      entry.fresh = false;
      if (id === this.workspace && !entry.counting) void this.countTrashedRows(id);
    }
  }

  private async countTrashedRows(workspaceId: Id) {
    const entry = this.rowTrash.get(workspaceId);
    if (!entry) return;
    entry.counting = true;
    try {
      // Moved again while the store counted: that count is not shown, the next one is.
      while (!entry.fresh) {
        entry.fresh = true;
        const count = await this.store.trashedRows(workspaceId).then(
          (rows) => rows.length,
          () => entry.count,
        );
        if (entry.fresh && count !== entry.count) {
          entry.count = count;
          for (const listener of this.rowTrashListeners) listener();
        }
      }
    } finally {
      entry.counting = false;
    }
  }

  /** Told after a held database's rows (or its hold) changed and the mirror has them. */
  onRows(listener: (databaseId: Id) => void): () => void {
    this.rowListeners.add(listener);
    return () => void this.rowListeners.delete(listener);
  }

  /** Every database whose rows a plan of these operations reads, read into the mirror. */
  private async prepareRows(ops: Operation[]) {
    const ids = new Set<Id>();
    const targets = (properties: readonly PropertyDef[]) => {
      for (const def of properties)
        if (def.type === 'relation' && def.relation) ids.add(def.relation.databaseId);
    };
    for (const op of ops) {
      switch (op.type) {
        case 'workspace.create':
        case 'workspace.update':
        case 'section.create':
        case 'section.update':
        case 'section.delete':
        case 'favourite.set':
        case 'visit.record':
        case 'view.upsert':
        case 'view.delete':
          break;
        case 'db.update':
          ids.add(op.entityId);
          targets(op.payload.properties ?? []);
          break;
        case 'page.create':
          if (op.payload.kind === 'row' && op.payload.parentPageId)
            ids.add(op.payload.parentPageId);
          if (op.payload.kind === 'database') targets(op.payload.database?.properties ?? []);
          break;
        default: {
          // A page operation or a row's values: on a row, its database; on a database's page
          // (a move, a trash, a delete), its rows.
          const page = this.mirror.pages.get(op.entityId);
          if (page) {
            if (page.kind === 'database') ids.add(page.id);
            break;
          }
          const row =
            this.mirror.rowRecords.get(op.entityId) ?? (await this.store.getPage(op.entityId));
          if (isRowRecord(row)) ids.add(row.databaseId);
        }
      }
    }
    for (const id of [...ids]) targets(this.mirror.databases.get(id)?.properties ?? []);
    for (const id of ids)
      if (this.mirror.databases.has(id) && !this.mirror.rowsLoaded(id)) await this.loadRowsNow(id);
  }

  private ws(): Id {
    if (!this.workspace) throw new OpError('not.found', 'No workspace is open');
    return this.workspace;
  }

  // Workspaces and sections --------------------------------------------------------------------

  /** A new local-only workspace with its two sections; returns its id. */
  async createWorkspace(
    name: string,
    sections: { shared: string; private: string },
  ): Promise<{ workspace: WorkspaceRecord; shared: SectionRecord; personal: SectionRecord }> {
    const now = new Date().toISOString();
    const workspace: WorkspaceRecord = {
      id: uuidv7(),
      name,
      icon: null,
      createdAt: now,
      version: 1,
      localOnly: true,
      deletedAt: null,
    };
    const shared: SectionRecord = {
      id: uuidv7(),
      workspaceId: workspace.id,
      name: sections.shared,
      orderKey: keyBetween(null, null),
      visibility: 'workspace',
      version: 1,
      createdAt: now,
    };
    const personal: SectionRecord = {
      id: uuidv7(),
      workspaceId: workspace.id,
      name: sections.private,
      orderKey: keyBetween(shared.orderKey, null),
      visibility: 'private',
      version: 1,
      createdAt: now,
    };
    await this.apply([
      newOp('workspace.create', workspace.id, workspace.id, workspace),
      newOp('section.create', workspace.id, shared.id, shared),
      newOp('section.create', workspace.id, personal.id, personal),
    ]);
    this.switchTo(workspace.id);
    this.cloud?.created?.(workspace.id);
    return { workspace, shared, personal };
  }

  renameWorkspace(name: string) {
    const id = this.ws();
    return this.apply([newOp('workspace.update', id, id, { name })]);
  }

  async createSection(name: string): Promise<SectionRecord> {
    const workspaceId = this.ws();
    const existing = this.mirror.sectionsOf(workspaceId);
    const section: SectionRecord = {
      id: uuidv7(),
      workspaceId,
      name,
      orderKey: keyBetween(existing.at(-1)?.orderKey ?? null, null),
      visibility: 'workspace',
      version: 1,
      createdAt: new Date().toISOString(),
    };
    await this.apply([newOp('section.create', workspaceId, section.id, section)]);
    return section;
  }

  renameSection(sectionId: Id, name: string) {
    return this.apply([newOp('section.update', this.ws(), sectionId, { name })]);
  }

  deleteSection(sectionId: Id) {
    return this.apply([newOp('section.delete', this.ws(), sectionId, {})]);
  }

  // Pages --------------------------------------------------------------------------------------

  siblingsOf(sectionId: Id, parentPageId: Id | null): PageRecord[] {
    return parentPageId ? this.mirror.childrenOf(parentPageId) : this.mirror.topPages(sectionId);
  }

  /** The order key for a place among siblings: after `after`, or at the end. */
  keyFor(sectionId: Id, parentPageId: Id | null, after?: Id | null, exclude?: Id): string {
    const siblings = this.siblingsOf(sectionId, parentPageId).filter((p) => p.id !== exclude);
    if (after === undefined) return keyBetween(siblings.at(-1)?.orderKey ?? null, null);
    if (after === null) return keyBetween(null, siblings[0]?.orderKey ?? null);
    const index = siblings.findIndex((p) => p.id === after);
    if (index < 0) return keyBetween(siblings.at(-1)?.orderKey ?? null, null);
    return keyBetween(siblings[index].orderKey, siblings[index + 1]?.orderKey ?? null);
  }

  pageRecord(page: NewPage): PageRecord {
    const now = new Date().toISOString();
    return {
      id: uuidv7(),
      workspaceId: this.ws(),
      sectionId: page.sectionId,
      parentPageId: page.parentPageId,
      orderKey: this.keyFor(page.sectionId, page.parentPageId, page.after),
      kind: 'page',
      title: page.title ?? '',
      icon: page.icon ?? null,
      coverAssetId: null,
      isTemplate: false,
      templateOfPageId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      trashRootId: null,
    };
  }

  /** A new page and its first document update (one empty paragraph, or the given content). */
  async createPage(page: NewPage, content?: DocJSON): Promise<PageRecord> {
    const record = this.pageRecord(page);
    const { newDocumentUpdate } = await import('@cgw/doc');
    await this.apply([newOp('page.create', record.workspaceId, record.id, record)]);
    const clientId = await this.clientIdFor(record.id);
    await this.store.appendDocUpdates(record.id, [
      { updateId: uuidv7(), data: newDocumentUpdate(record.id, content, clientId) },
    ]);
    if (content) void this.indexPage(record.id, content).catch(() => undefined);
    else this.fresh.add(record.id);
    return record;
  }

  /** True once for a blank page just made here: whoever shows it first puts focus in its title. */
  takeFresh(pageId: Id): boolean {
    return this.fresh.delete(pageId);
  }

  async updatePage(
    pageId: Id,
    changes: Partial<Pick<PageRecord, 'title' | 'icon' | 'coverAssetId' | 'isTemplate'>>,
  ) {
    await this.apply([newOp('page.update', this.ws(), pageId, changes)]);
    if (changes.title !== undefined) this.scheduleIndex(pageId, 300);
  }

  movePage(pageId: Id, to: { sectionId: Id; parentPageId: Id | null; after?: Id | null }) {
    const page = this.mirror.pages.get(pageId);
    if (!page) return Promise.reject(new OpError('not.found'));
    const orderKey = this.keyFor(to.sectionId, to.parentPageId, to.after, pageId);
    return this.apply([
      newOp(
        'page.move',
        this.ws(),
        pageId,
        { sectionId: to.sectionId, parentPageId: to.parentPageId, orderKey },
        page.version,
      ),
    ]);
  }

  async trashPage(pageId: Id) {
    const page = this.record(pageId) ?? (await this.findRow(pageId)) ?? undefined;
    if (!page) return;
    await this.apply([newOp('page.trash', this.ws(), pageId, {}, page.version)]);
    for (const id of this.underneath(pageId)) this.forget(id);
  }

  restorePage(pageId: Id) {
    return this.apply([newOp('page.restore', this.ws(), pageId, {})]);
  }

  async deletePage(pageId: Id) {
    const ids = this.underneath(pageId);
    await this.apply([newOp('page.delete', this.ws(), pageId, {})]);
    for (const id of ids) this.forget(id);
  }

  /** A page and the pages under it, and the open rows of the databases among them. */
  private underneath(pageId: Id): Id[] {
    const ids = [pageId, ...this.mirror.descendantIds(pageId)];
    const databases = new Set(ids);
    for (const id of this.docs.keys()) {
      const row = this.mirror.rowRecords.get(id);
      if (row && databases.has(row.databaseId)) ids.push(id);
    }
    return ids;
  }

  setFavourite(pageId: Id, favourite: boolean) {
    const workspaceId = this.ws();
    const last = this.mirror.favouritesOf(workspaceId).at(-1);
    const orderKey = favourite
      ? keyBetween(
          last ? (this.mirror.favourites.get(`${workspaceId}/${last.id}`)?.orderKey ?? null) : null,
          null,
        )
      : null;
    return this.apply([newOp('favourite.set', workspaceId, pageId, { favourite, orderKey })]);
  }

  recordVisit(pageId: Id) {
    return this.apply([newOp('visit.record', this.ws(), pageId, { at: new Date().toISOString() })]);
  }

  // Search ---------------------------------------------------------------------------------------

  private readonly folded = new Map<Id, { title: string; folded: string }>();

  private foldedTitle(page: AnyPage): string {
    const cached = this.folded.get(page.id);
    if (cached?.title === page.title) return cached.folded;
    const folded = normaliseText(page.title);
    this.folded.set(page.id, { title: page.title, folded });
    return folded;
  }

  /**
   * Pages whose title or text match a normalised query (D25): titles from the mirror, so every
   * page is found by title; text from the local store's index of the pages this device holds.
   */
  async search(normalisedQuery: string, limit: number): Promise<SearchHit[]> {
    const workspaceId = this.ws();
    const terms = searchTerms(normalisedQuery);
    if (!terms.length) return [];
    const hits = new Map<Id, SearchHit>();
    const titled = (page: AnyPage) => {
      const words = this.foldedTitle(page).split(' ');
      if (terms.every((term) => words.some((word) => word.startsWith(term))))
        hits.set(page.id, { pageId: page.id, title: page.title, snippet: '', score: 3 });
    };
    for (const page of this.mirror.pages.values()) {
      if (hits.size >= limit) break;
      if (page.workspaceId === workspaceId && !page.trashedAt) titled(page);
    }
    // Rows whose database's rows are in the mirror (the rest are found in the store's index).
    for (const row of this.mirror.rowRecords.values()) {
      if (hits.size >= limit) break;
      if (row.workspaceId !== workspaceId || row.trashedAt || row.isTemplate) continue;
      if (!this.mirror.pages.get(row.databaseId)?.trashedAt) titled(row);
    }
    for (const hit of await this.store.search(workspaceId, normalisedQuery, limit)) {
      const existing = hits.get(hit.pageId);
      if (existing) existing.snippet ||= hit.snippet;
      else hits.set(hit.pageId, hit);
    }
    return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private indexTimers = new Map<Id, ReturnType<typeof setTimeout>>();

  /** Puts a page's title and text in the store's search index, a moment after it settles. */
  scheduleIndex(pageId: Id, delay = 1500) {
    clearTimeout(this.indexTimers.get(pageId));
    this.indexTimers.set(
      pageId,
      setTimeout(() => {
        this.indexTimers.delete(pageId);
        void this.indexPage(pageId).catch((error: unknown) =>
          console.warn('Indexing failed:', error),
        );
      }, delay),
    );
  }

  async indexPage(pageId: Id, json?: DocJSON): Promise<void> {
    const page = this.record(pageId);
    if (!page) return;
    const { plainText, PageDocument, fragmentToJSON } = await import('@cgw/doc');
    let content = json;
    if (!content) {
      const open = this.docs.get(pageId);
      // Opened to read only: no migration or meta stamp is written.
      const doc = open
        ? await open
        : await PageDocument.open(pageId, this.store, { canEdit: false });
      content = fragmentToJSON(doc.fragment);
      if (!open) await doc.close();
    }
    const text = plainText(content, {
      pageTitle: (id) => this.mirror.pages.get(id)?.title,
      assetName: (id) => this.mirror.assets.get(id)?.fileName,
    });
    await this.store.putSearchEntry({
      pageId,
      workspaceId: page.workspaceId,
      title: normaliseText(page.title),
      text: normaliseText(text),
    });
  }

  /** The content a page holds now, as ProseMirror JSON (open pages flush first). */
  async pageContent(pageId: Id): Promise<DocJSON> {
    const open = this.docs.get(pageId);
    if (open) await (await open).flush();
    const { PageDocument, fragmentToJSON } = await import('@cgw/doc');
    const doc = await PageDocument.open(pageId, this.store, { canEdit: false });
    const json = fragmentToJSON(doc.fragment);
    await doc.close();
    return json;
  }

  /**
   * "New from template": the template and its subpages copied as new pages beside it, with new
   * page ids and new block ids, and links inside the copy pointed at the copies.
   */
  async newFromTemplate(templateId: Id): Promise<PageRecord> {
    const template = this.mirror.pages.get(templateId);
    if (!template) throw new OpError('not.found');
    const { withNewIds, remapRefs } = await import('@cgw/doc');
    const originals = [
      template,
      ...this.mirror.descendantIds(templateId).map((id) => this.mirror.pages.get(id)!),
    ];
    const ids = new Map(originals.map((page) => [page.id, uuidv7()]));
    const records = originals.map((page) => {
      const record = this.pageRecord({
        sectionId: template.sectionId,
        parentPageId: page.id === templateId ? template.parentPageId : ids.get(page.parentPageId!)!,
        title: page.title,
        icon: page.icon,
        after: page.id === templateId ? templateId : undefined,
      });
      return {
        ...record,
        id: ids.get(page.id)!,
        orderKey: page.id === templateId ? record.orderKey : page.orderKey,
        coverAssetId: page.coverAssetId,
        templateOfPageId: page.id === templateId ? templateId : null,
      };
    });
    const contents = await Promise.all(originals.map((page) => this.pageContent(page.id)));
    const { newDocumentUpdate } = await import('@cgw/doc');
    await this.apply(
      records.map((record) => newOp('page.create', record.workspaceId, record.id, record)),
    );
    const clientId = await this.clientIdFor(template.id);
    for (const [i, record] of records.entries()) {
      const content = remapRefs(withNewIds(contents[i]), ids);
      await this.store.appendDocUpdates(record.id, [
        { updateId: uuidv7(), data: newDocumentUpdate(record.id, content, clientId) },
      ]);
      void this.indexPage(record.id, content).catch(() => undefined);
    }
    return records[0];
  }

  /**
   * A recovered page (cloud/recovery.ts): a page with a given id, in a given workspace and
   * section, which need not be the open one, and its first document.
   */
  async createRecoveredPage(
    page: { id: Id; workspaceId: Id; sectionId: Id; title: string; orderKey: string },
    content: DocJSON | undefined,
  ): Promise<void> {
    const now = new Date().toISOString();
    const record: PageRecord = {
      id: page.id,
      workspaceId: page.workspaceId,
      sectionId: page.sectionId,
      parentPageId: null,
      orderKey: page.orderKey,
      kind: 'page',
      title: page.title,
      icon: null,
      coverAssetId: null,
      isTemplate: false,
      templateOfPageId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      trashRootId: null,
    };
    await this.apply([newOp('page.create', record.workspaceId, record.id, record)]);
    await this.writeFirstDocument(record.id, record.workspaceId, content);
  }

  /**
   * A row made from a row template (`templateOfPageId`) starts with the template's body, as a page
   * made from a template does (`newFromTemplate`): new block ids, links into the template's own
   * copy kept. Nothing is written when the template has no body (the row's is made on its first
   * open) or the row has one already.
   */
  async copyBody(templateId: Id, rowId: Id): Promise<void> {
    const template = this.record(templateId) ?? (await this.findRow(templateId)) ?? undefined;
    if (!template) return;
    if ((await this.store.loadDoc(rowId)).updates.length) return;
    const held = await this.store.loadDoc(templateId);
    // A body only the server has is pulled first (offline, the row starts empty).
    if (!held.snapshot && !held.updates.length && (template.docHeadSeq ?? 0) > 0)
      await this.cloud?.pullPage(templateId).catch(() => undefined);
    const content = await this.pageContent(templateId);
    if (!content.content?.length) return;
    const { withNewIds } = await import('@cgw/doc');
    const row = this.record(rowId);
    await this.writeFirstDocument(
      rowId,
      row?.workspaceId ?? template.workspaceId,
      withNewIds(content),
    );
  }

  /** A page's first document update: the given content, or one empty paragraph. */
  async writeFirstDocument(pageId: Id, workspaceId: Id, content: DocJSON | undefined) {
    const { newDocumentUpdate } = await import('@cgw/doc');
    const clientId = this.cloud ? await this.cloud.clientIdFor(workspaceId) : undefined;
    await this.store.appendDocUpdates(pageId, [
      { updateId: uuidv7(), data: newDocumentUpdate(pageId, content, clientId) },
    ]);
    this.cloud?.changed();
    void this.indexPage(pageId, content).catch(() => undefined);
  }

  // Documents ----------------------------------------------------------------------------------

  /** Opens (or returns the open) document of a page. A few stay open; older ones are closed. */
  openDoc(pageId: Id): Promise<PageDocument> {
    let doc = this.docs.get(pageId);
    if (!doc) {
      // The document layer (Yjs) loads with the editor, not with the frame.
      doc = Promise.all([import('@cgw/doc'), this.clientIdFor(pageId)]).then(
        async ([{ PageDocument, SCHEMA_VERSION, newDocumentUpdate }, clientId]) => {
          const record = this.record(pageId);
          const options: DocumentOptions = {
            ...this.docOptions,
            clientId,
            // A reader's open writes nothing: no migration, no meta stamp (they would be refused).
            canEdit: this.canEdit(pageId),
            onEvent: (event) => this.cloud?.docEvent?.(event),
          };
          this.editable.set(pageId, options.canEdit!);
          let opened = await PageDocument.open(pageId, this.store, options);
          // A row the server holds no body of (never opened anywhere) has nothing to fetch.
          const bodyless = isRowRecord(record) && !((record.docHeadSeq ?? 0) > 0);
          if (holdsNothing(opened) && isRowRecord(record) && (bodyless || !this.cloud)) {
            // A row's body is made on its first open (contract section 1), as a page's is when
            // it is made: one empty paragraph, by the client that opens it first. A reader is
            // shown it empty and writes nothing.
            if (options.canEdit) {
              await opened.close();
              await this.store.appendDocUpdates(pageId, [
                { updateId: uuidv7(), data: newDocumentUpdate(pageId, undefined, clientId) },
              ]);
              opened = await PageDocument.open(pageId, this.store, options);
              this.cloud?.changed();
            }
          } else if (holdsNothing(opened)) {
            // Nothing of it on this device (a page made elsewhere, never opened here): the
            // server's copy first, so the page opens with its content, or says why it cannot.
            try {
              if ((record?.docSchemaVersion ?? 0) > SCHEMA_VERSION)
                throw new NewerDocumentError(pageId);
              if (await this.cloud?.fetchMissing?.(pageId)) {
                await opened.close();
                opened = await PageDocument.open(pageId, this.store, options);
              }
            } catch (error) {
              await opened.close();
              throw error;
            }
          } else {
            // The server's newer state is pulled now.
            void this.cloud?.pullPage(pageId).catch(() => undefined);
          }
          // Each save is pushed soon after (at once through the hub, while the page is live).
          opened.onSaved(() =>
            this.cloud?.saved ? this.cloud.saved(pageId) : this.cloud?.changed(),
          );
          return opened;
        },
      );
      this.docs.set(pageId, doc);
      doc.catch(() => {
        this.docs.delete(pageId);
        // Not opened after all (not on this device while offline, say): not on screen either.
        if (this.shown === pageId) this.show(null);
      });
    }
    const at = this.order.indexOf(pageId);
    if (at >= 0) this.order.splice(at, 1);
    this.order.push(pageId);
    while (this.order.length > OPEN_LIMIT) this.forget(this.order.shift()!);
    this.show(pageId);
    return doc;
  }

  /**
   * Something that holds an edit back for a moment (the title field's pause) and writes it when
   * asked: `flushAll` asks before the page hides, the window closes or a workspace uploads.
   */
  onFlush(flush: () => Promise<void> | void): () => void {
    this.flushers.add(flush);
    return () => void this.flushers.delete(flush);
  }

  /**
   * Writes everything still waiting: titles being typed, then every open document's pending
   * batch; resolves once the store has them. Before hiding, closing, quitting or uploading.
   */
  async flushAll(): Promise<void> {
    await Promise.all(
      [...this.flushers].map(async (flush) => {
        try {
          await flush();
        } catch (error) {
          console.warn('A pending edit could not be written:', error);
        }
      }),
    );
    await Promise.all(
      [...this.docs.values()].map((doc) => doc.then((d) => d.flush()).catch(() => undefined)),
    );
    // Operations planned meanwhile (the titles above) are in the store when this resolves.
    await this.queue;
  }

  private forget(pageId: Id) {
    const doc = this.docs.get(pageId);
    if (!doc) return;
    if (this.shown === pageId) this.show(null);
    this.docs.delete(pageId);
    this.editable.delete(pageId);
    const at = this.order.indexOf(pageId);
    if (at >= 0) this.order.splice(at, 1);
    void doc.then((d) => d.close()).catch(() => undefined);
  }

  async close() {
    for (const id of [...this.docs.keys()]) this.forget(id);
    await this.flushAll();
    await this.store.close();
  }
}
