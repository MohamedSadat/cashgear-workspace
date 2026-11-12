// Operations applied to the metadata mirror. Both local stores run this planner inside their own
// transaction and write what it returns, so the tree rules (DATA_MODEL.md, Tree) hold the same way
// on both. The server checks the same rules again in Phase 2.
//
// Phase 4 (databases): a database is a page of kind `database` with a database record; a row is a
// page of kind `row` under its database, kept as a `RowRecord` in the plan's `rows`, never in its
// `pages`. The tree rules gain: a row only under its database, only rows under a database, nothing
// under a row, and a row's move only reorders it among its database's rows. The database rules
// (per-property merges, coercion, type changes, relations) are in `db/plan.ts`.
import type { DatabaseRecord, ViewRecord } from './db/types';
import {
  planDatabaseUpdate,
  planRelationEdits,
  planReverseProperties,
  startProperties,
  writeValues,
} from './db/plan';
import type { Id } from './ids';
import { keyBetween, compareSiblings } from './order';
import {
  OpError,
  type DbHold,
  type FavouriteRecord,
  type Operation,
  type PageRecord,
  type RowRecord,
  type SectionRecord,
  type VisitRecord,
  type WorkspaceRecord,
} from './types';

/** What the planner reads; each store answers from inside its transaction. */
export interface MirrorReader {
  workspace(id: Id): Promise<WorkspaceRecord | undefined>;
  section(id: Id): Promise<SectionRecord | undefined>;
  /** A page, a database's page, or a row (a `RowRecord`, of kind `row`) this device holds. */
  page(id: Id): Promise<PageRecord | undefined>;
  /** Every page whose parent is `parentPageId`, trashed or not; never a row. */
  children(parentPageId: Id): Promise<PageRecord[]>;
  /** Every page in the section, trashed or not; never a row. */
  sectionPages(sectionId: Id): Promise<PageRecord[]>;
  favourite(workspaceId: Id, pageId: Id): Promise<FavouriteRecord | undefined>;
  // Phase 4
  database(id: Id): Promise<DatabaseRecord | undefined>;
  view(id: Id): Promise<ViewRecord | undefined>;
  /** The rows this device holds of the database, trashed rows and templates included. */
  rows(databaseId: Id): Promise<RowRecord[]>;
}

/** What a batch of operations changes. Records are final values; deletes are keys. */
export interface Plan {
  workspaces: WorkspaceRecord[];
  sections: SectionRecord[];
  /** Pages and databases' pages; never rows. */
  pages: PageRecord[];
  favourites: FavouriteRecord[];
  visits: VisitRecord[];
  deleteSections: Id[];
  /**
   * Pages removed for good: their documents, history and search entries go with them. A database
   * page takes its database record, its views and its hold with it (the stores do that by key);
   * its rows are named in `deleteRows`.
   */
  deletePages: Id[];
  deleteFavourites: { workspaceId: Id; pageId: Id }[];
  deleteVisits: { workspaceId: Id; pageId: Id }[];
  outbox: Operation[];
  // Phase 4 (store schema 4)
  databases: DatabaseRecord[];
  views: ViewRecord[];
  /** Rows written (the `rows` collection, never `pages`). */
  rows: RowRecord[];
  deleteViews: Id[];
  /** Rows removed for good, each as a removed page (document, history, search entry, pin, ...). */
  deleteRows: Id[];
  /** Holds written: a database made here, a fetch of rows moving on. */
  holds: DbHold[];
  /** Remote plans only (remote.ts): workspaces removed with all they hold. */
  deleteWorkspaces?: Id[];
  /** Remote plans only: operations answered by the server, removed from the outbox. */
  settled?: Id[];
  /** Remote plans only: the change feed's cursor to keep. */
  cursor?: { workspaceId: Id; value: number };
  /** Remote plans only: a local workspace's outbox replaced by an upload's creates. */
  /** An upload: `replaced` (all the workspace's when absent) gives way to `ops`; the rest follow. */
  replaceOutbox?: { workspaceId: Id; ops: Operation[]; replaced?: Id[] };
}

const favKey = (workspaceId: Id, pageId: Id) => `${workspaceId}/${pageId}`;

/** A row, told from a page by its kind. */
export const isRow = (page: PageRecord | undefined): page is RowRecord => page?.kind === 'row';

/** Earlier operations in a batch are seen by later ones. */
class Overlay implements MirrorReader {
  workspaces = new Map<Id, WorkspaceRecord>();
  sections = new Map<Id, SectionRecord | null>();
  pages = new Map<Id, PageRecord | null>();
  favourites = new Map<string, FavouriteRecord | null>();
  visits = new Map<string, VisitRecord | null>();
  databases = new Map<Id, DatabaseRecord | null>();
  views = new Map<Id, ViewRecord | null>();
  rowRecords = new Map<Id, RowRecord | null>();
  holds = new Map<Id, DbHold | null>();

  constructor(private readonly base: MirrorReader) {}

  async workspace(id: Id) {
    return this.workspaces.get(id) ?? (await this.base.workspace(id));
  }
  async section(id: Id) {
    const own = this.sections.get(id);
    return own === null ? undefined : (own ?? (await this.base.section(id)));
  }
  async page(id: Id): Promise<PageRecord | undefined> {
    const own = this.pages.get(id);
    if (own === null) return undefined;
    if (own) return own;
    const row = this.rowRecords.get(id);
    if (row === null) return undefined;
    return row ?? (await this.base.page(id));
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
  async database(id: Id) {
    const own = this.databases.get(id);
    return own === null ? undefined : (own ?? (await this.base.database(id)));
  }
  async view(id: Id) {
    const own = this.views.get(id);
    return own === null ? undefined : (own ?? (await this.base.view(id)));
  }
  async rows(databaseId: Id) {
    if (this.databases.get(databaseId) === null) return [];
    const out = new Map((await this.base.rows(databaseId)).map((row) => [row.id, row]));
    for (const [id, row] of this.rowRecords) {
      if (row === null || row.databaseId !== databaseId) out.delete(id);
      else out.set(id, row);
    }
    return [...out.values()];
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

/** A row reads as trashed when it or its database page is (the planner never cascades into rows). */
async function readsTrashed(reader: MirrorReader, page: PageRecord): Promise<boolean> {
  if (page.trashedAt) return true;
  if (!isRow(page)) return false;
  return !!(await reader.page(page.databaseId))?.trashedAt;
}

/** A row counts towards its database's `rowCount` while it is neither trashed nor a template. */
const counts = (row: RowRecord) => !row.trashedAt && !row.isTemplate;

/**
 * Plans a batch: checks every rule against the mirror as it will be after the operations before
 * it, and returns the records to write. Throws OpError on the first refusal; nothing is written.
 */
export async function planOps(ops: Operation[], base: MirrorReader): Promise<Plan> {
  const reader = new Overlay(base);
  const deletePages = new Set<Id>();
  const deleteSections = new Set<Id>();
  const deleteRows = new Set<Id>();
  const deleteViews = new Set<Id>();

  const putPage = (page: PageRecord) => reader.pages.set(page.id, page);
  const putRow = (row: RowRecord) => reader.rowRecords.set(row.id, row);
  const putDatabase = (db: DatabaseRecord) => reader.databases.set(db.id, db);
  const putRows = (rows: RowRecord[]) => rows.forEach(putRow);

  /** A local-only database counts its own rows; a synced one's count is the server's. */
  const recount = async (databaseId: Id, delta: number) => {
    const db = await reader.database(databaseId);
    const workspace = db && (await reader.workspace(db.workspaceId));
    if (!db || !workspace?.localOnly || !delta) return;
    putDatabase({ ...db, rowCount: Math.max(0, db.rowCount + delta) });
  };

  const dropRow = (row: RowRecord) => {
    reader.rowRecords.set(row.id, null);
    deleteRows.add(row.id);
    reader.favourites.set(favKey(row.workspaceId, row.id), null);
    reader.visits.set(favKey(row.workspaceId, row.id), null);
  };

  /** A database and an op on it: the page must be a database's, not trashed, with its record. */
  const liveDatabase = async (id: Id): Promise<DatabaseRecord> => {
    const page = need(await reader.page(id), 'Database');
    if (page.kind !== 'database') throw new OpError('invalid', 'Not a database');
    if (page.trashedAt) throw new OpError('page.trashed', 'The database is in the trash');
    return need(await reader.database(id), 'Database');
  };

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
        // The payload's `database` and `row` parts become the database record and the row's
        // values; the page record keeps only a page's fields.
        const { database, row, ...page } = op.payload;
        if (page.id !== op.entityId || page.workspaceId !== op.workspaceId)
          throw new OpError('invalid', 'Id mismatch');
        if (await reader.page(page.id)) throw new OpError('invalid', 'Page exists');
        const section = need(await reader.section(page.sectionId), 'Section');
        if (section.workspaceId !== op.workspaceId) throw new OpError('tree.section');
        const parent = page.parentPageId
          ? need(await reader.page(page.parentPageId), 'Parent page')
          : undefined;
        if (parent) {
          if (parent.sectionId !== page.sectionId) throw new OpError('tree.section');
          if (parent.trashedAt) throw new OpError('page.trashed', 'The parent is in the trash');
        }
        if (page.kind === 'row') {
          if (parent?.kind !== 'database')
            throw new OpError('invalid', 'A row is made in its database');
          const db = need(await reader.database(parent.id), 'Database');
          const made = page as Partial<RowRecord>;
          const record: RowRecord = {
            ...page,
            kind: 'row',
            version: 1,
            trashedAt: null,
            trashRootId: null,
            databaseId: db.id,
            values: writeValues(db, {}, row?.values ?? {}),
            versions: {},
            computed: {},
            computedVersion: null,
            createdBy: made.createdBy ?? null,
            updatedBy: made.updatedBy ?? made.createdBy ?? null,
          };
          putRow(record);
          putRows(await planRelationEdits(db, record, null, reader, at));
          if (counts(record)) await recount(db.id, 1);
          break;
        }
        if (parent && parent.kind !== 'page')
          throw new OpError(
            'invalid',
            parent.kind === 'row' ? 'Nothing sits under a row' : 'Only rows sit under a database',
          );
        putPage({ ...page, version: 1, trashedAt: null, trashRootId: null });
        if (page.kind === 'database') {
          const db: DatabaseRecord = {
            id: page.id,
            workspaceId: page.workspaceId,
            properties: startProperties(database?.properties ?? []),
            version: 1,
            rowCount: 0,
            createdAt: page.createdAt,
          };
          putDatabase(db);
          // A database made on this device is held whole from its creation.
          reader.holds.set(db.id, {
            databaseId: db.id,
            workspaceId: db.workspaceId,
            mode: 'full',
            complete: true,
            after: null,
            heldAt: at,
          });
          for (const target of await planReverseProperties(db, db.properties, reader))
            putDatabase(target);
        }
        break;
      }
      case 'page.update': {
        const page = need(await reader.page(op.entityId), 'Page');
        if (await readsTrashed(reader, page)) throw new OpError('page.trashed');
        if (isRow(page)) {
          const next: RowRecord = {
            ...page,
            ...op.payload,
            version: page.version + 1,
            updatedAt: at,
          };
          putRow(next);
          await recount(page.databaseId, Number(counts(next)) - Number(counts(page)));
        } else putPage({ ...page, ...op.payload, version: page.version + 1, updatedAt: at });
        break;
      }
      case 'page.move': {
        const page = need(await reader.page(op.entityId), 'Page');
        checkBase(page, op);
        if (await readsTrashed(reader, page)) throw new OpError('page.trashed');
        const { sectionId, parentPageId, orderKey } = op.payload;
        if (isRow(page)) {
          // A row never leaves its database: a move only reorders it among the rows.
          if (sectionId !== page.sectionId || parentPageId !== page.databaseId)
            throw new OpError('invalid', "A row moves only among its database's rows");
          putRow({ ...page, orderKey, version: page.version + 1, updatedAt: at });
          break;
        }
        const section = need(await reader.section(sectionId), 'Section');
        if (section.workspaceId !== page.workspaceId) throw new OpError('tree.section');
        if (parentPageId) {
          // No cycles: the new parent may not be the page or anything under it.
          let cursor: PageRecord | undefined = await reader.page(parentPageId);
          if (!cursor) throw new OpError('not.found', 'Parent page not found');
          if (cursor.trashedAt) throw new OpError('page.trashed', 'The parent is in the trash');
          if (cursor.sectionId !== sectionId) throw new OpError('tree.section');
          if (cursor.kind !== 'page')
            throw new OpError(
              'invalid',
              cursor.kind === 'row' ? 'Nothing sits under a row' : 'Only rows sit under a database',
            );
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
        if (sectionId !== page.sectionId) {
          const moved = await descendants(reader, page.id);
          for (const child of moved) putPage({ ...child, sectionId, version: child.version + 1 });
          // A database's rows are in its section: they move with it.
          for (const record of [page, ...moved])
            if (record.kind === 'database')
              for (const row of await reader.rows(record.id))
                putRow({ ...row, sectionId, version: row.version + 1 });
        }
        break;
      }
      case 'page.trash': {
        const page = need(await reader.page(op.entityId), 'Page');
        checkBase(page, op);
        if (await readsTrashed(reader, page)) throw new OpError('page.trashed');
        if (isRow(page)) {
          // A row is its own trash root.
          putRow({ ...page, trashedAt: at, trashRootId: page.id, version: page.version + 1 });
          if (counts(page)) await recount(page.databaseId, -1);
          break;
        }
        // The subtree goes as one unit; pages already trashed on their own keep their own root.
        // A database's rows are not touched: they read as trashed while their database is.
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
        if (isRow(page)) {
          // Back into its database, where it was.
          const next: RowRecord = {
            ...page,
            trashedAt: null,
            trashRootId: null,
            version: page.version + 1,
          };
          putRow(next);
          if (counts(next)) await recount(page.databaseId, 1);
          break;
        }
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
        // A trash root inside another one, both purged together: gone with the outer one.
        if (deletePages.has(op.entityId) || deleteRows.has(op.entityId)) break;
        const page = need(await reader.page(op.entityId), 'Page');
        if (!(await readsTrashed(reader, page)))
          throw new OpError('page.notTrashed', 'Pages are deleted for good only from the trash');
        if (isRow(page)) {
          dropRow(page);
          if (counts(page)) await recount(page.databaseId, -1);
          break;
        }
        for (const record of [page, ...(await descendants(reader, page.id))]) {
          if (record.kind === 'database') {
            // Its rows go as removed pages; its record, views and hold go with the page.
            for (const row of await reader.rows(record.id)) dropRow(row);
            reader.databases.set(record.id, null);
            reader.holds.set(record.id, null);
            for (const [id, view] of reader.views)
              if (view?.databaseId === record.id) reader.views.set(id, null);
          }
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
      case 'db.update': {
        const db = await liveDatabase(op.entityId);
        const change = await planDatabaseUpdate(db, op.payload, reader, at);
        change.databases.forEach(putDatabase);
        putRows(change.rows);
        break;
      }
      case 'view.upsert': {
        const view = op.payload;
        if (view.id !== op.entityId || view.workspaceId !== op.workspaceId)
          throw new OpError('invalid', 'Id mismatch');
        const db = await liveDatabase(view.databaseId);
        if (db.workspaceId !== op.workspaceId) throw new OpError('invalid', 'Id mismatch');
        const existing = await reader.view(view.id);
        if (existing && existing.databaseId !== view.databaseId)
          throw new OpError('invalid', 'A view stays with its database');
        reader.views.set(view.id, {
          ...view,
          version: existing ? existing.version + 1 : 1,
          createdAt: existing?.createdAt ?? view.createdAt,
        });
        deleteViews.delete(view.id);
        break;
      }
      case 'view.delete': {
        const view = need(await reader.view(op.entityId), 'View');
        await liveDatabase(view.databaseId);
        reader.views.set(view.id, null);
        deleteViews.add(view.id);
        break;
      }
      case 'row.update': {
        const row = need(await reader.page(op.entityId), 'Row');
        if (!isRow(row)) throw new OpError('invalid', 'Not a row');
        if (await readsTrashed(reader, row)) throw new OpError('page.trashed');
        const db = need(await reader.database(row.databaseId), 'Database');
        const next: RowRecord = {
          ...row,
          values: writeValues(db, row.values, op.payload.values),
          version: row.version + 1,
          updatedAt: at,
        };
        putRow(next);
        putRows(await planRelationEdits(db, next, row.values, reader, at));
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
    databases: split(reader.databases).put,
    views: split(reader.views).put,
    rows: split(reader.rowRecords).put,
    deleteViews: [...deleteViews],
    deleteRows: [...deleteRows],
    holds: split(reader.holds).put,
  };
}
