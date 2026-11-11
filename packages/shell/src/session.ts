// The open workspace: the local store, the metadata mirror drawn by the sidebar, and the page
// documents currently open. Every change to the tree is an operation, planned against the mirror,
// made durable by the store, then shown (SYNC_DESIGN.md, Channel 2).
import type { DocJSON, DocumentOptions, PageDocument } from '@cgw/doc';
import {
  Mirror,
  OpError,
  keyBetween,
  newOp,
  planOps,
  uuidv7,
  type Id,
  type LocalStore,
  type Operation,
  type PageRecord,
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

export class WorkspaceSession {
  readonly mirror: Mirror;
  private readonly docs = new Map<Id, Promise<PageDocument>>();
  private readonly order: Id[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private workspace: Id | null;
  private readonly listeners = new Set<() => void>();

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
    const run = async () => {
      const plan = await planOps(ops, this.mirror);
      try {
        await this.store.applyLocalOps(ops);
      } catch (error) {
        // The store saw something the mirror did not: read the truth back.
        this.mirror.load(await this.store.readMirror(null));
        throw error;
      }
      this.mirror.apply(plan);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
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
    await this.store.appendDocUpdates(record.id, [
      { updateId: uuidv7(), data: newDocumentUpdate(record.id, content) },
    ]);
    return record;
  }

  updatePage(
    pageId: Id,
    changes: Partial<Pick<PageRecord, 'title' | 'icon' | 'coverAssetId' | 'isTemplate'>>,
  ) {
    return this.apply([newOp('page.update', this.ws(), pageId, changes)]);
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
    const page = this.mirror.pages.get(pageId);
    if (!page) return;
    await this.apply([newOp('page.trash', this.ws(), pageId, {}, page.version)]);
    for (const id of [pageId, ...this.mirror.descendantIds(pageId)]) this.forget(id);
  }

  restorePage(pageId: Id) {
    return this.apply([newOp('page.restore', this.ws(), pageId, {})]);
  }

  async deletePage(pageId: Id) {
    const ids = [pageId, ...this.mirror.descendantIds(pageId)];
    await this.apply([newOp('page.delete', this.ws(), pageId, {})]);
    for (const id of ids) this.forget(id);
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

  // Documents ----------------------------------------------------------------------------------

  /** Opens (or returns the open) document of a page. A few stay open; older ones are closed. */
  openDoc(pageId: Id): Promise<PageDocument> {
    let doc = this.docs.get(pageId);
    if (!doc) {
      // The document layer (Yjs) loads with the editor, not with the frame.
      doc = import('@cgw/doc').then(({ PageDocument }) =>
        PageDocument.open(pageId, this.store, this.docOptions),
      );
      this.docs.set(pageId, doc);
      doc.catch(() => this.docs.delete(pageId));
    }
    const at = this.order.indexOf(pageId);
    if (at >= 0) this.order.splice(at, 1);
    this.order.push(pageId);
    while (this.order.length > OPEN_LIMIT) this.forget(this.order.shift()!);
    return doc;
  }

  /** Writes every open document's pending batch: before hiding, closing or quitting. */
  async flushAll(): Promise<void> {
    await Promise.all(
      [...this.docs.values()].map((doc) => doc.then((d) => d.flush()).catch(() => undefined)),
    );
  }

  private forget(pageId: Id) {
    const doc = this.docs.get(pageId);
    if (!doc) return;
    this.docs.delete(pageId);
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
