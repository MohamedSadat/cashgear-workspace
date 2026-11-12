// The metadata mirror in memory: what the sidebar, breadcrumbs, title search and page links draw
// from (DATA_MODEL.md, "Large workspaces"). Children are indexed by parent, so expanding a node in
// a 10,000-page workspace reads only that node's children.
import type { Id } from './ids';
import { compareSiblings } from './order';
import type { MirrorReader, Plan } from './ops';
import type {
  AssetRecord,
  FavouriteRecord,
  MirrorSnapshot,
  PageRecord,
  SectionRecord,
  VisitRecord,
  WorkspaceRecord,
} from './types';

const favKey = (workspaceId: Id, pageId: Id) => `${workspaceId}/${pageId}`;
const TOP = (sectionId: Id) => `section:${sectionId}`;

export class Mirror implements MirrorReader {
  readonly workspaces = new Map<Id, WorkspaceRecord>();
  readonly sections = new Map<Id, SectionRecord>();
  readonly pages = new Map<Id, PageRecord>();
  readonly favourites = new Map<string, FavouriteRecord>();
  readonly visits = new Map<string, VisitRecord>();
  readonly assets = new Map<Id, AssetRecord>();
  /** Parent key (a page id, or `section:{id}` for the top) to child ids. */
  private readonly childIndex = new Map<string, Set<Id>>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  constructor(snapshot?: MirrorSnapshot) {
    if (snapshot) this.load(snapshot);
  }

  load(snapshot: MirrorSnapshot) {
    for (const w of snapshot.workspaces) this.workspaces.set(w.id, w);
    for (const s of snapshot.sections) this.sections.set(s.id, s);
    for (const p of snapshot.pages) this.setPage(p);
    for (const f of snapshot.favourites) this.favourites.set(favKey(f.workspaceId, f.pageId), f);
    for (const v of snapshot.visits) this.visits.set(favKey(v.workspaceId, v.pageId), v);
    for (const a of snapshot.assets) this.assets.set(a.id, a);
    this.emit();
  }

  /** Everything replaced by a snapshot (after the store took changes from the server). */
  reset(snapshot: MirrorSnapshot) {
    this.workspaces.clear();
    this.sections.clear();
    this.pages.clear();
    this.favourites.clear();
    this.visits.clear();
    this.assets.clear();
    this.childIndex.clear();
    this.load(snapshot);
  }

  snapshot(workspaceId: Id | null = null): MirrorSnapshot {
    const mine = <T extends { workspaceId: Id }>(items: Iterable<T>) =>
      [...items].filter((item) => workspaceId === null || item.workspaceId === workspaceId);
    return {
      workspaces: [...this.workspaces.values()].filter(
        (w) => workspaceId === null || w.id === workspaceId,
      ),
      sections: mine(this.sections.values()),
      pages: mine(this.pages.values()),
      favourites: mine(this.favourites.values()),
      visits: mine(this.visits.values()),
      assets: mine(this.assets.values()),
    };
  }

  /** Writes a plan's results; the store has already made them durable. */
  apply(plan: Plan) {
    for (const id of plan.deleteWorkspaces ?? []) this.deleteWorkspace(id);
    for (const w of plan.workspaces) this.workspaces.set(w.id, w);
    for (const s of plan.sections) this.sections.set(s.id, s);
    for (const id of plan.deleteSections) this.sections.delete(id);
    for (const p of plan.pages) this.setPage(p);
    for (const id of plan.deletePages) this.deletePage(id);
    for (const f of plan.favourites) this.favourites.set(favKey(f.workspaceId, f.pageId), f);
    for (const f of plan.deleteFavourites) this.favourites.delete(favKey(f.workspaceId, f.pageId));
    for (const v of plan.visits) this.visits.set(favKey(v.workspaceId, v.pageId), v);
    for (const v of plan.deleteVisits) this.visits.delete(favKey(v.workspaceId, v.pageId));
    this.emit();
  }

  /** A workspace and everything it holds, gone (a synced workspace the account lost). */
  private deleteWorkspace(id: Id) {
    this.workspaces.delete(id);
    for (const [key, s] of this.sections) if (s.workspaceId === id) this.sections.delete(key);
    for (const p of [...this.pages.values()]) if (p.workspaceId === id) this.deletePage(p.id);
    for (const [key, f] of this.favourites) if (f.workspaceId === id) this.favourites.delete(key);
    for (const [key, v] of this.visits) if (v.workspaceId === id) this.visits.delete(key);
    for (const [key, a] of this.assets) if (a.workspaceId === id) this.assets.delete(key);
  }

  putAsset(asset: AssetRecord) {
    this.assets.set(asset.id, asset);
    this.emit();
  }

  private parentKey(page: PageRecord) {
    return page.parentPageId ?? TOP(page.sectionId);
  }

  private setPage(page: PageRecord) {
    const old = this.pages.get(page.id);
    if (old) this.childIndex.get(this.parentKey(old))?.delete(old.id);
    this.pages.set(page.id, page);
    const key = this.parentKey(page);
    let set = this.childIndex.get(key);
    if (!set) this.childIndex.set(key, (set = new Set()));
    set.add(page.id);
  }

  private deletePage(id: Id) {
    const old = this.pages.get(id);
    if (!old) return;
    this.childIndex.get(this.parentKey(old))?.delete(id);
    this.pages.delete(id);
  }

  // MirrorReader, for planning against memory (the desktop store and tests)
  async workspace(id: Id) {
    return this.workspaces.get(id);
  }
  async section(id: Id) {
    return this.sections.get(id);
  }
  async page(id: Id) {
    return this.pages.get(id);
  }
  async children(parentPageId: Id) {
    return this.childrenOf(parentPageId, true);
  }
  async sectionPages(sectionId: Id) {
    return [...this.pages.values()].filter((p) => p.sectionId === sectionId);
  }
  async favourite(workspaceId: Id, pageId: Id) {
    return this.favourites.get(favKey(workspaceId, pageId));
  }

  // Reads for the interface, synchronous
  /** Children in drawn order; trashed pages are left out unless asked for. */
  childrenOf(parent: Id, includeTrashed = false): PageRecord[] {
    const ids = this.childIndex.get(parent);
    if (!ids) return [];
    const out: PageRecord[] = [];
    for (const id of ids) {
      const page = this.pages.get(id)!;
      if (includeTrashed || !page.trashedAt) out.push(page);
    }
    return out.sort(compareSiblings);
  }

  topPages(sectionId: Id): PageRecord[] {
    return this.childrenOf(TOP(sectionId));
  }

  hasChildren(pageId: Id): boolean {
    const ids = this.childIndex.get(pageId);
    if (!ids) return false;
    for (const id of ids) if (!this.pages.get(id)!.trashedAt) return true;
    return false;
  }

  sectionsOf(workspaceId: Id): SectionRecord[] {
    return [...this.sections.values()]
      .filter((s) => s.workspaceId === workspaceId)
      .sort(compareSiblings);
  }

  /** The page's ancestors, nearest last: what breadcrumbs draw. */
  ancestors(pageId: Id): PageRecord[] {
    const out: PageRecord[] = [];
    let page = this.pages.get(pageId);
    const seen = new Set<Id>();
    while (page?.parentPageId && !seen.has(page.parentPageId)) {
      seen.add(page.parentPageId);
      page = this.pages.get(page.parentPageId);
      if (page) out.unshift(page);
    }
    return out;
  }

  descendantIds(pageId: Id): Id[] {
    const out: Id[] = [];
    const queue = [pageId];
    while (queue.length) {
      const ids = this.childIndex.get(queue.shift()!);
      if (!ids) continue;
      for (const id of ids) {
        out.push(id);
        queue.push(id);
      }
    }
    return out;
  }

  /** Trash roots of a workspace, newest first. */
  trash(workspaceId: Id): PageRecord[] {
    return [...this.pages.values()]
      .filter((p) => p.workspaceId === workspaceId && p.trashRootId === p.id)
      .sort((a, b) => (a.trashedAt! < b.trashedAt! ? 1 : -1));
  }

  favouritesOf(workspaceId: Id): PageRecord[] {
    return [...this.favourites.values()]
      .filter((f) => f.workspaceId === workspaceId)
      .sort((a, b) => compareSiblings({ ...a, id: a.pageId }, { ...b, id: b.pageId }))
      .map((f) => this.pages.get(f.pageId))
      .filter((p): p is PageRecord => !!p && !p.trashedAt);
  }

  isFavourite(workspaceId: Id, pageId: Id): boolean {
    return this.favourites.has(favKey(workspaceId, pageId));
  }

  recentOf(workspaceId: Id, limit = 8): PageRecord[] {
    return [...this.visits.values()]
      .filter((v) => v.workspaceId === workspaceId)
      .sort((a, b) => (a.lastVisitedAt < b.lastVisitedAt ? 1 : -1))
      .map((v) => this.pages.get(v.pageId))
      .filter((p): p is PageRecord => !!p && !p.trashedAt)
      .slice(0, limit);
  }

  templatesOf(workspaceId: Id): PageRecord[] {
    return [...this.pages.values()]
      .filter((p) => p.workspaceId === workspaceId && p.isTemplate && !p.trashedAt)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Rises on every change, for useSyncExternalStore. */
  getRevision = () => this.revision;

  private emit() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}
