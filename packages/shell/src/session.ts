// The open workspace: the local store, the metadata mirror drawn by the sidebar, and the page
// documents currently open. Every change to the tree is an operation, planned against the mirror,
// made durable by the store, then shown (SYNC_DESIGN.md, Channel 2).
import type { DocJSON, DocumentOptions, PageDocument } from '@cgw/doc';
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
  type PageRecord,
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
}

export class WorkspaceSession {
  readonly mirror: Mirror;
  private readonly docs = new Map<Id, Promise<PageDocument>>();
  /** Blank pages made in this session and not yet shown: their title takes focus when shown. */
  private readonly fresh = new Set<Id>();
  private readonly order: Id[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private workspace: Id | null;
  private readonly listeners = new Set<() => void>();
  private readonly resetListeners = new Set<(pageId: Id) => void>();
  private cloud: CloudHooks | null = null;
  /** Bytes of an asset this device does not hold, from the server (cloud/cloud.ts). */
  remoteAssets: ((assetId: Id) => Promise<Uint8Array | null>) | null = null;
  /** Server search for a synced workspace, merged after local hits by the palette (M2.7). */
  remoteSearch: ((q: string, limit: number) => Promise<SearchHit[]>) | null = null;
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
  }

  /** The mirror read again from the store, after the sync engine wrote what the server said. */
  async reloadMirror(): Promise<void> {
    this.mirror.reset(await this.store.readMirror(null));
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
    const workspaceId = this.mirror.pages.get(pageId)?.workspaceId ?? this.workspace;
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
      this.cloud?.changed();
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

  // Search ---------------------------------------------------------------------------------------

  private readonly folded = new Map<Id, { title: string; folded: string }>();

  private foldedTitle(page: PageRecord): string {
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
    for (const page of this.mirror.pages.values()) {
      if (page.workspaceId !== workspaceId || page.trashedAt) continue;
      const words = this.foldedTitle(page).split(' ');
      if (terms.every((term) => words.some((word) => word.startsWith(term))))
        hits.set(page.id, { pageId: page.id, title: page.title, snippet: '', score: 3 });
      if (hits.size >= limit) break;
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
    const page = this.mirror.pages.get(pageId);
    if (!page) return;
    const { plainText, PageDocument, fragmentToJSON } = await import('@cgw/doc');
    let content = json;
    if (!content) {
      const open = this.docs.get(pageId);
      const doc = open ? await open : await PageDocument.open(pageId, this.store);
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
    const doc = await PageDocument.open(pageId, this.store);
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

  // Documents ----------------------------------------------------------------------------------

  /** Opens (or returns the open) document of a page. A few stay open; older ones are closed. */
  openDoc(pageId: Id): Promise<PageDocument> {
    let doc = this.docs.get(pageId);
    if (!doc) {
      // The document layer (Yjs) loads with the editor, not with the frame.
      doc = Promise.all([import('@cgw/doc'), this.clientIdFor(pageId)]).then(
        async ([{ PageDocument }, clientId]) => {
          const opened = await PageDocument.open(pageId, this.store, {
            ...this.docOptions,
            clientId,
          });
          // Each save is pushed soon after; the server's newer state is pulled now.
          opened.onSaved(() => this.cloud?.changed());
          void this.cloud?.pullPage(pageId).catch(() => undefined);
          return opened;
        },
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
