// Operations applied to the metadata mirror. Both local stores run this planner inside their own
// transaction and write what it returns, so the tree rules (DATA_MODEL.md, Tree) hold the same way
// on both. The server checks the same rules again in Phase 2.
import type { Id } from './ids';
import { keyBetween, compareSiblings } from './order';
import {
  OpError,
  type FavouriteRecord,
  type Operation,
  type PageRecord,
  type SectionRecord,
  type VisitRecord,
  type WorkspaceRecord,
} from './types';

/** What the planner reads; each store answers from inside its transaction. */
export interface MirrorReader {
  workspace(id: Id): Promise<WorkspaceRecord | undefined>;
  section(id: Id): Promise<SectionRecord | undefined>;
  page(id: Id): Promise<PageRecord | undefined>;
  /** Every page whose parent is `parentPageId`, trashed or not. */
  children(parentPageId: Id): Promise<PageRecord[]>;
  /** Every page in the section, trashed or not. */
  sectionPages(sectionId: Id): Promise<PageRecord[]>;
  favourite(workspaceId: Id, pageId: Id): Promise<FavouriteRecord | undefined>;
}

/** What a batch of operations changes. Records are final values; deletes are keys. */
export interface Plan {
  workspaces: WorkspaceRecord[];
  sections: SectionRecord[];
  pages: PageRecord[];
  favourites: FavouriteRecord[];
  visits: VisitRecord[];
  deleteSections: Id[];
  /** Pages removed for good: their documents, history and search entries go with them. */
  deletePages: Id[];
  deleteFavourites: { workspaceId: Id; pageId: Id }[];
  deleteVisits: { workspaceId: Id; pageId: Id }[];
  outbox: Operation[];
}

const favKey = (workspaceId: Id, pageId: Id) => `${workspaceId}/${pageId}`;

/** Earlier operations in a batch are seen by later ones. */
class Overlay implements MirrorReader {
  workspaces = new Map<Id, WorkspaceRecord>();
  sections = new Map<Id, SectionRecord | null>();
  pages = new Map<Id, PageRecord | null>();
  favourites = new Map<string, FavouriteRecord | null>();
  visits = new Map<string, VisitRecord | null>();

  constructor(private readonly base: MirrorReader) {}

  async workspace(id: Id) {
    return this.workspaces.get(id) ?? (await this.base.workspace(id));
  }
  async section(id: Id) {
    const own = this.sections.get(id);
    return own === null ? undefined : (own ?? (await this.base.section(id)));
  }
  async page(id: Id) {
    const own = this.pages.get(id);
    return own === null ? undefined : (own ?? (await this.base.page(id)));
  }
  private merge(base: PageRecord[], keep: (page: PageRecord) => boolean): PageRecord[] {
    const out = new Map(base.map((page) => [page.id, page]));
    for (const [id, page] of this.pages) {
      if (page === null || !keep(page)) out.delete(id);
      else out.set(id, page);
    }
    return [...out.values()];
  }
  async children(parentPageId: Id) {
    return this.merge(
      await this.base.children(parentPageId),
      (p) => p.parentPageId === parentPageId,
    );
  }
  async sectionPages(sectionId: Id) {
    return this.merge(await this.base.sectionPages(sectionId), (p) => p.sectionId === sectionId);
  }
  async favourite(workspaceId: Id, pageId: Id) {
    const own = this.favourites.get(favKey(workspaceId, pageId));
    return own === null ? undefined : (own ?? (await this.base.favourite(workspaceId, pageId)));
  }
}

const now = () => new Date().toISOString();

async function descendants(reader: MirrorReader, pageId: Id): Promise<PageRecord[]> {
  const out: PageRecord[] = [];
  const queue = [pageId];
  while (queue.length) {
    for (const child of await reader.children(queue.shift()!)) {
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

async function lastTopKey(reader: MirrorReader, sectionId: Id, except: Id): Promise<string | null> {
  const top = (await reader.sectionPages(sectionId))
    .filter((p) => p.parentPageId === null && p.id !== except && !p.trashedAt)
    .sort(compareSiblings);
  return top.length ? top[top.length - 1].orderKey : null;
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new OpError('not.found', `${what} not found`);
  return value;
}

function checkBase(entity: { version: number }, op: Operation) {
  if (op.baseVersion !== null && op.baseVersion !== entity.version)
    throw new OpError(
      'version.conflict',
      `${op.type} on version ${op.baseVersion}, now ${entity.version}`,
    );
}

/**
 * Plans a batch: checks every rule against the mirror as it will be after the operations before
 * it, and returns the records to write. Throws OpError on the first refusal; nothing is written.
 */
export async function planOps(ops: Operation[], base: MirrorReader): Promise<Plan> {
  const reader = new Overlay(base);
  const deletePages = new Set<Id>();
  const deleteSections = new Set<Id>();

  const putPage = (page: PageRecord) => reader.pages.set(page.id, page);

  for (const op of ops) {
    const at = now();
    switch (op.type) {
      case 'workspace.create': {
        if (await reader.workspace(op.entityId)) throw new OpError('invalid', 'Workspace exists');
        if (op.payload.id !== op.entityId) throw new OpError('invalid', 'Id mismatch');
        reader.workspaces.set(op.entityId, { ...op.payload, version: 1 });
        break;
      }
      case 'workspace.update': {
        const workspace = need(await reader.workspace(op.entityId), 'Workspace');
        reader.workspaces.set(op.entityId, {
          ...workspace,
          ...op.payload,
          version: workspace.version + 1,
        });
        break;
      }
      case 'section.create': {
        need(await reader.workspace(op.workspaceId), 'Workspace');
        if (await reader.section(op.entityId)) throw new OpError('invalid', 'Section exists');
        if (op.payload.id !== op.entityId || op.payload.workspaceId !== op.workspaceId)
          throw new OpError('invalid', 'Id mismatch');
        reader.sections.set(op.entityId, { ...op.payload, version: 1 });
        break;
      }
      case 'section.update': {
        const section = need(await reader.section(op.entityId), 'Section');
        reader.sections.set(op.entityId, {
          ...section,
          ...op.payload,
          version: section.version + 1,
        });
        break;
      }
      case 'section.delete': {
        need(await reader.section(op.entityId), 'Section');
        if ((await reader.sectionPages(op.entityId)).length)
          throw new OpError('section.notEmpty', 'The section still holds pages');
        reader.sections.set(op.entityId, null);
        deleteSections.add(op.entityId);
        break;
      }
      case 'page.create': {
        const page = op.payload;
        if (page.id !== op.entityId || page.workspaceId !== op.workspaceId)
          throw new OpError('invalid', 'Id mismatch');
        if (await reader.page(page.id)) throw new OpError('invalid', 'Page exists');
        const section = need(await reader.section(page.sectionId), 'Section');
        if (section.workspaceId !== op.workspaceId) throw new OpError('tree.section');
        if (page.parentPageId) {
          const parent = need(await reader.page(page.parentPageId), 'Parent page');
          if (parent.sectionId !== page.sectionId) throw new OpError('tree.section');
          if (parent.trashedAt) throw new OpError('page.trashed', 'The parent is in the trash');
        }
        putPage({ ...page, version: 1, trashedAt: null, trashRootId: null });
        break;
      }
      case 'page.update': {
        const page = need(await reader.page(op.entityId), 'Page');
        if (page.trashedAt) throw new OpError('page.trashed');
        putPage({ ...page, ...op.payload, version: page.version + 1, updatedAt: at });
        break;
      }
      case 'page.move': {
        const page = need(await reader.page(op.entityId), 'Page');
        checkBase(page, op);
        if (page.trashedAt) throw new OpError('page.trashed');
        const { sectionId, parentPageId, orderKey } = op.payload;
        const section = need(await reader.section(sectionId), 'Section');
        if (section.workspaceId !== page.workspaceId) throw new OpError('tree.section');
        if (parentPageId) {
          // No cycles: the new parent may not be the page or anything under it.
          let cursor: PageRecord | undefined = await reader.page(parentPageId);
          if (!cursor) throw new OpError('not.found', 'Parent page not found');
          if (cursor.trashedAt) throw new OpError('page.trashed', 'The parent is in the trash');
          if (cursor.sectionId !== sectionId) throw new OpError('tree.section');
          while (cursor) {
            if (cursor.id === page.id) throw new OpError('tree.cycle');
            cursor = cursor.parentPageId ? await reader.page(cursor.parentPageId) : undefined;
          }
        }
        putPage({
          ...page,
          sectionId,
          parentPageId,
          orderKey,
          version: page.version + 1,
          updatedAt: at,
        });
        if (sectionId !== page.sectionId)
          for (const child of await descendants(reader, page.id))
            putPage({ ...child, sectionId, version: child.version + 1 });
        break;
      }
      case 'page.trash': {
        const page = need(await reader.page(op.entityId), 'Page');
        checkBase(page, op);
        if (page.trashedAt) throw new OpError('page.trashed');
        // The subtree goes as one unit; pages already trashed on their own keep their own root.
        for (const record of [page, ...(await descendants(reader, page.id))])
          if (!record.trashedAt)
            putPage({
              ...record,
              trashedAt: at,
              trashRootId: page.id,
              version: record.version + 1,
            });
        break;
      }
      case 'page.restore': {
        const page = need(await reader.page(op.entityId), 'Page');
        if (page.trashRootId !== page.id) throw new OpError('page.notTrashed');
        let { parentPageId, orderKey } = page;
        const parent = parentPageId ? await reader.page(parentPageId) : undefined;
        if (parentPageId && (!parent || parent.trashedAt)) {
          // The old parent is gone: back to the top of its section.
          parentPageId = null;
          orderKey = keyBetween(await lastTopKey(reader, page.sectionId, page.id), null);
        }
        putPage({
          ...page,
          parentPageId,
          orderKey,
          trashedAt: null,
          trashRootId: null,
          version: page.version + 1,
        });
        for (const record of await descendants(reader, page.id))
          if (record.trashRootId === page.id)
            putPage({ ...record, trashedAt: null, trashRootId: null, version: record.version + 1 });
        break;
      }
      case 'page.delete': {
        const page = need(await reader.page(op.entityId), 'Page');
        if (!page.trashedAt)
          throw new OpError('page.notTrashed', 'Pages are deleted for good only from the trash');
        for (const record of [page, ...(await descendants(reader, page.id))]) {
          reader.pages.set(record.id, null);
          deletePages.add(record.id);
          reader.favourites.set(favKey(record.workspaceId, record.id), null);
          reader.visits.set(favKey(record.workspaceId, record.id), null);
        }
        break;
      }
      case 'favourite.set': {
        const page = need(await reader.page(op.entityId), 'Page');
        const key = favKey(page.workspaceId, page.id);
        if (op.payload.favourite)
          reader.favourites.set(key, {
            workspaceId: page.workspaceId,
            pageId: page.id,
            orderKey: op.payload.orderKey ?? keyBetween(null, null),
          });
        else reader.favourites.set(key, null);
        break;
      }
      case 'visit.record': {
        const page = need(await reader.page(op.entityId), 'Page');
        reader.visits.set(favKey(page.workspaceId, page.id), {
          workspaceId: page.workspaceId,
          pageId: page.id,
          lastVisitedAt: op.payload.at,
        });
        break;
      }
      default: {
        const unknown: never = op;
        throw new OpError('invalid', `Unknown operation ${(unknown as Operation).type}`);
      }
    }
  }

  const split = <T>(map: Map<string, T | null>) => ({
    put: [...map.values()].filter((v): v is T => v !== null),
    gone: [...map.entries()].filter(([, v]) => v === null).map(([k]) => k),
  });
  const favourites = split(reader.favourites);
  const visits = split(reader.visits);
  const toPair = (key: string) => {
    const [workspaceId, pageId] = key.split('/');
    return { workspaceId, pageId };
  };
  return {
    workspaces: [...reader.workspaces.values()],
    sections: split(reader.sections).put,
    pages: split(reader.pages).put,
    favourites: favourites.put,
    visits: visits.put,
    deleteSections: [...deleteSections],
    deletePages: [...deletePages],
    deleteFavourites: favourites.gone.map(toPair),
    deleteVisits: visits.gone.map(toPair),
    outbox: ops,
  };
}
