// What the server says, as plans the stores write the way they write planOps' plans: the answers
// to pushed operations (planSettle) and batches from the change feed or the tree (planRemote).
// Every store runs these same rules (SYNC_DESIGN.md, Channel 2):
//   - an entity with operations still waiting in the outbox keeps its local state: the local
//     change wins until the server has answered it, then the answer's entity is taken;
//   - deletes always apply, with the page's document, history and search entry;
//   - a whole tree (or a subtree) replaces what the device held of it.
// Phase 4: databases and views travel as pages do; a row is written only for a database this
// device holds (a `DbHold`, or one the batch sets); a database page that goes takes its rows
// (named in `deleteRows`), its record, views and hold with it.
import { coerceHeldRows } from './db/plan';
import type { DatabaseRecord, PropertyDef, ViewRecord } from './db/types';
import type { Id } from './ids';
import type { Plan } from './ops';
import type {
  DbHold,
  EntityRecord,
  FavouriteRecord,
  Operation,
  OpResult,
  PageCreate,
  PageRecord,
  RemoteBatch,
  RowRecord,
  SectionRecord,
  VisitRecord,
  WorkspaceRecord,
} from './types';

/** What the remote planners read; each store answers from inside its transaction. */
export interface RemoteReader {
  workspace(id: Id): Promise<WorkspaceRecord | undefined>;
  /** Pages and databases' pages of the workspace; never rows. */
  workspacePages(workspaceId: Id): Promise<PageRecord[]>;
  workspaceSections(workspaceId: Id): Promise<SectionRecord[]>;
  /** Whether an operation on this entity waits in the outbox, leaving out the ones in `except`. */
  pending(entityId: Id, except?: ReadonlySet<Id>): Promise<boolean>;
  // Phase 4
  database(id: Id): Promise<DatabaseRecord | undefined>;
  workspaceViews(workspaceId: Id): Promise<ViewRecord[]>;
  /** The rows this device holds of the database. */
  rows(databaseId: Id): Promise<RowRecord[]>;
  /** The ids of the rows this device holds of the database (none for a page that is not one). */
  rowIds(databaseId: Id): Promise<Id[]>;
  /** The ids of every row this device holds of the workspace. */
  workspaceRowIds(workspaceId: Id): Promise<Id[]>;
  dbHold(databaseId: Id): Promise<DbHold | undefined>;
}

export function emptyPlan(): Plan {
  return {
    workspaces: [],
    sections: [],
    pages: [],
    favourites: [],
    visits: [],
    deleteSections: [],
    deletePages: [],
    deleteFavourites: [],
    deleteVisits: [],
    outbox: [],
    databases: [],
    views: [],
    rows: [],
    deleteViews: [],
    deleteRows: [],
    holds: [],
  };
}

/** A synced workspace's record keeps its account; the server does not know which device holds it. */
async function withAccount(
  reader: RemoteReader,
  record: WorkspaceRecord,
): Promise<WorkspaceRecord> {
  const existing = await reader.workspace(record.id);
  return {
    ...record,
    localOnly: false,
    accountId: record.accountId ?? existing?.accountId ?? null,
  };
}

/** Every page under (and including) `root` in a workspace's pages, by their parent links. */
function subtree(pages: PageRecord[], root: Id): Set<Id> {
  const children = new Map<Id, Id[]>();
  for (const page of pages)
    if (page.parentPageId) {
      const list = children.get(page.parentPageId) ?? [];
      list.push(page.id);
      children.set(page.parentPageId, list);
    }
  const out = new Set<Id>([root]);
  const queue = [root];
  while (queue.length)
    for (const child of children.get(queue.shift()!) ?? [])
      if (!out.has(child)) {
        out.add(child);
        queue.push(child);
      }
  return out;
}

/** A record the server sent as a page that is a row: rows travel as rows, never as pages. */
const rowAsPage = (record: PageRecord) => record.kind === 'row';

/**
 * Removals made whole: a database page that goes takes its held rows (named in `deleteRows`, so
 * each goes as a removed page), and nothing removed is written back by the same plan. Every page
 * or row that goes takes the account's favourite and visit of it, as a local delete does.
 */
async function finishRemovals(plan: Plan, reader: RemoteReader, workspaceOf: (id: Id) => Id) {
  plan.deletePages = [...new Set(plan.deletePages)];
  const rows = new Set(plan.deleteRows);
  const databaseOf = new Map<Id, Id>();
  for (const id of plan.deletePages)
    for (const rowId of await reader.rowIds(id)) {
      rows.add(rowId);
      databaseOf.set(rowId, id);
    }
  plan.deleteRows = [...rows];
  const pages = new Set(plan.deletePages);
  const views = new Set(plan.deleteViews);
  plan.deleteViews = [...views];
  plan.pages = plan.pages.filter((p) => !pages.has(p.id));
  plan.databases = plan.databases.filter((d) => !pages.has(d.id));
  plan.views = plan.views.filter((v) => !views.has(v.id) && !pages.has(v.databaseId));
  plan.rows = plan.rows.filter((r) => !rows.has(r.id) && !pages.has(r.databaseId));
  plan.holds = plan.holds.filter((h) => !pages.has(h.databaseId));
  const gone = new Set([...pages, ...rows]);
  const owner = (pageId: Id) => workspaceOf(databaseOf.get(pageId) ?? pageId);
  const pairs = new Set(plan.deleteFavourites.map((f) => f.pageId));
  for (const pageId of gone)
    if (!pairs.has(pageId)) plan.deleteFavourites.push({ workspaceId: owner(pageId), pageId });
  const visited = new Set(plan.deleteVisits.map((v) => v.pageId));
  for (const pageId of gone)
    if (!visited.has(pageId)) plan.deleteVisits.push({ workspaceId: owner(pageId), pageId });
  plan.favourites = plan.favourites.filter((f) => !gone.has(f.pageId));
  plan.visits = plan.visits.filter((v) => !gone.has(v.pageId));
}

export async function planRemote(batch: RemoteBatch, reader: RemoteReader): Promise<Plan> {
  const plan = emptyPlan();
  const ws = batch.workspaceId;
  if (batch.deleteWorkspace) {
    plan.deleteWorkspaces = [ws];
    plan.deletePages = (await reader.workspacePages(ws)).map((p) => p.id);
    plan.deleteRows = await reader.workspaceRowIds(ws);
    return plan;
  }
  const keep = async (id: Id) => !(await reader.pending(id));
  for (const w of batch.workspaces ?? [])
    if (await keep(w.id)) plan.workspaces.push(await withAccount(reader, w));
  for (const s of batch.sections ?? []) if (await keep(s.id)) plan.sections.push(s);
  for (const p of batch.pages ?? []) if (!rowAsPage(p) && (await keep(p.id))) plan.pages.push(p);
  for (const f of batch.favourites ?? []) if (await keep(f.pageId)) plan.favourites.push(f);
  for (const v of batch.visits ?? []) if (await keep(v.pageId)) plan.visits.push(v);
  plan.deleteSections.push(...(batch.deleteSections ?? []));
  plan.deletePages.push(...(batch.deletePages ?? []));
  plan.deleteFavourites.push(
    ...(batch.deleteFavourites ?? []).map((pageId) => ({ workspaceId: ws, pageId })),
  );
  plan.deleteVisits.push(
    ...(batch.deleteVisits ?? []).map((pageId) => ({ workspaceId: ws, pageId })),
  );

  // Databases and views as pages are; rows only for a database held here (or held by this batch).
  plan.holds.push(...(batch.holds ?? []));
  const heldNow = new Set(plan.holds.map((h) => h.databaseId));
  const holdKnown = new Map<Id, boolean>();
  const held = async (databaseId: Id) => {
    if (heldNow.has(databaseId)) return true;
    let known = holdKnown.get(databaseId);
    if (known === undefined)
      holdKnown.set(databaseId, (known = !!(await reader.dbHold(databaseId))));
    return known;
  };
  for (const v of batch.views ?? []) if (await keep(v.id)) plan.views.push(v);
  for (const r of batch.rows ?? [])
    if ((await held(r.databaseId)) && (await keep(r.id))) plan.rows.push(r);
  plan.deleteViews.push(...(batch.deleteViews ?? []));
  plan.deleteRows.push(...(batch.deleteRows ?? []));
  // A type the server changed reaches the held rows the batch did not carry, by coercion.
  const carried = new Set(plan.rows.map((r) => r.id));
  for (const db of batch.databases ?? []) {
    if (!(await keep(db.id))) continue;
    plan.databases.push(db);
    const before = await reader.database(db.id);
    if (!before) continue;
    const others = (await reader.rows(db.id)).filter((r) => !carried.has(r.id));
    plan.rows.push(...coerceHeldRows(before, db, others));
  }

  if (batch.replace) {
    const heldPages = await reader.workspacePages(ws);
    const sent = new Set((batch.pages ?? []).map((p) => p.id));
    const scope = batch.replace.root === null ? null : subtree(heldPages, batch.replace.root);
    for (const page of heldPages)
      if (!sent.has(page.id) && (scope === null || scope.has(page.id)) && (await keep(page.id)))
        plan.deletePages.push(page.id);
    if (batch.replace.root === null) {
      const sentSections = new Set((batch.sections ?? []).map((s) => s.id));
      for (const section of await reader.workspaceSections(ws))
        if (!sentSections.has(section.id) && (await keep(section.id)))
          plan.deleteSections.push(section.id);
      // Views the whole tree does not hold go as sections do; a database goes with its page.
      const sentViews = new Set((batch.views ?? []).map((v) => v.id));
      for (const view of await reader.workspaceViews(ws))
        if (!sentViews.has(view.id) && (await keep(view.id))) plan.deleteViews.push(view.id);
    }
  }
  await finishRemovals(plan, reader, () => ws);
  if (batch.cursor !== undefined) plan.cursor = { workspaceId: ws, value: batch.cursor };
  return plan;
}

/** The entity an operation is about, for an answer that carries none. */
function entityKey(type: OpResult['entityType'], record: EntityRecord): Id {
  return type === 'favourite' || type === 'visit'
    ? (record as FavouriteRecord | VisitRecord).pageId
    : (record as { id: Id }).id;
}

/**
 * The server's answers to pushed operations: they leave the outbox, and each answer's entity
 * replaces the local record, unless more operations on it wait. A refusal with no entity means the
 * server has none this account may see: the local record goes.
 */
export async function planSettle(
  results: OpResult[],
  ops: ReadonlyMap<Id, Operation>,
  reader: RemoteReader,
): Promise<Plan> {
  const plan = emptyPlan();
  const settled = new Set(results.map((r) => r.opId));
  plan.settled = [...settled];
  for (const result of results) {
    const op = ops.get(result.opId);
    if (!result.entityType || !op) continue;
    const entityId = result.entity ? entityKey(result.entityType, result.entity) : op.entityId;
    if (await reader.pending(entityId, settled)) continue;
    const entity = result.entity;
    if (entity) {
      switch (result.entityType) {
        case 'workspace':
          plan.workspaces.push(await withAccount(reader, entity as WorkspaceRecord));
          break;
        case 'section':
          plan.sections.push(entity as SectionRecord);
          break;
        case 'page': {
          // A row answered as a page carries no values: the row's own answer brings them.
          const page = entity as PageRecord;
          if (!rowAsPage(page)) plan.pages.push(page);
          else if ((page as RowRecord).databaseId) plan.rows.push(page as RowRecord);
          break;
        }
        case 'favourite':
          plan.favourites.push(entity as FavouriteRecord);
          break;
        case 'visit':
          plan.visits.push(entity as VisitRecord);
          break;
        case 'database':
          plan.databases.push(entity as DatabaseRecord);
          break;
        case 'view':
          plan.views.push(entity as ViewRecord);
          break;
        case 'row':
          plan.rows.push(entity as RowRecord);
          break;
      }
    } else if (result.status === 'rejected' || entity === null) {
      const pair = { workspaceId: op.workspaceId, pageId: op.entityId };
      switch (result.entityType) {
        case 'section':
          if (result.status === 'rejected' || op.type === 'section.delete')
            plan.deleteSections.push(op.entityId);
          break;
        case 'page':
        case 'database':
          // A database is its page: the server holds neither for this account.
          if (result.status === 'rejected') plan.deletePages.push(op.entityId);
          break;
        case 'row':
          if (result.status === 'rejected') plan.deleteRows.push(op.entityId);
          break;
        case 'view':
          if (result.status === 'rejected' || op.type === 'view.delete')
            plan.deleteViews.push(op.entityId);
          break;
        case 'favourite':
          plan.deleteFavourites.push(pair);
          break;
        case 'visit':
          if (result.status === 'rejected') plan.deleteVisits.push(pair);
          break;
      }
    }
  }
  if (plan.deletePages.length || plan.deleteRows.length) {
    const workspaces = new Map([...ops.values()].map((o) => [o.entityId, o.workspaceId]));
    await finishRemovals(plan, reader, (id) => workspaces.get(id) ?? '');
  }
  return plan;
}

/** What a local workspace's databases are, for an upload: records, views, and every held row. */
export interface UploadDatabases {
  databases: DatabaseRecord[];
  views: ViewRecord[];
  rows: RowRecord[];
}

/** Property types a database is made without on upload, added once every database exists. */
const LATER: PropertyDef['type'][] = ['relation', 'rollup', 'formula'];

/** What a row holds beyond its page. */
const ROW_ONLY = [
  'databaseId',
  'values',
  'versions',
  'computed',
  'computedVersion',
  'createdBy',
  'updatedBy',
] as const;

/** A row as the page `page.create` makes (its values travel beside it, in `row`). */
function rowPage(row: RowRecord): PageRecord {
  const page: Record<string, unknown> = {
    ...row,
    kind: 'row',
    version: 1,
    trashedAt: null,
    trashRootId: null,
  };
  for (const key of ROW_ONLY) delete page[key];
  return page as unknown as PageRecord;
}

/**
 * A local workspace's records as creates, parents first, then its trash (deepest roots first, so a
 * page trashed on its own keeps its own root) and favourites: what an upload sends (M2.3).
 *
 * With `databases` (Phase 4): each database page's create carries its properties, less its
 * relations, rollups and formulas, which a `db.update` adds once every database exists (a relation
 * names its target, a rollup its relation); then each database's views; then its rows as creates
 * with their values, less relations, which a `row.update` sets once every row exists. Trashed rows
 * are trashed after, as trash roots are. The databases stay held on this device.
 */
export function uploadOps(
  workspace: WorkspaceRecord,
  sections: SectionRecord[],
  pages: PageRecord[],
  favourites: FavouriteRecord[],
  newOpId: () => Id,
  databases: UploadDatabases = { databases: [], views: [], rows: [] },
): Operation[] {
  const now = new Date().toISOString();
  const op = (
    type: Operation['type'],
    entityId: Id,
    payload: unknown,
    baseVersion: number | null = null,
  ) =>
    ({
      opId: newOpId(),
      type,
      workspaceId: workspace.id,
      entityId,
      baseVersion,
      payload,
      createdAt: now,
    }) as Operation;
  const out: Operation[] = [];
  for (const section of sections)
    out.push(op('section.create', section.id, { ...section, version: 1 }));
  const byId = new Map(pages.map((p) => [p.id, p]));
  const records = new Map(databases.databases.map((d) => [d.id, d]));
  const depth = (page: PageRecord): number => {
    let d = 0;
    for (
      let p = page;
      p.parentPageId && byId.has(p.parentPageId) && d < 10_000;
      p = byId.get(p.parentPageId)!
    )
      d++;
    return d;
  };
  const ordered = [...pages].sort((a, b) => depth(a) - depth(b));
  for (const page of ordered) {
    const create: PageCreate = { ...page, version: 1, trashedAt: null, trashRootId: null };
    const db = page.kind === 'database' ? records.get(page.id) : undefined;
    if (db) create.database = { properties: db.properties.filter((p) => !LATER.includes(p.type)) };
    out.push(op('page.create', page.id, create));
  }
  // Every database exists: relations, rollups and formulas, in the database's own order.
  const uploaded = databases.databases.filter((d) => byId.get(d.id)?.kind === 'database');
  for (const db of uploaded) {
    const later = db.properties.filter((p) => LATER.includes(p.type));
    if (later.length)
      out.push(
        op('db.update', db.id, { properties: later, order: db.properties.map((p) => p.id) }),
      );
  }
  const live = new Set(uploaded.map((d) => d.id));
  for (const view of [...databases.views].sort((a, b) =>
    a.orderKey === b.orderKey ? (a.id < b.id ? -1 : 1) : a.orderKey < b.orderKey ? -1 : 1,
  ))
    if (live.has(view.databaseId)) out.push(op('view.upsert', view.id, { ...view, version: 1 }));
  const rows = databases.rows.filter((r) => live.has(r.databaseId));
  const relationIds = new Set(
    uploaded.flatMap((d) => d.properties.filter((p) => p.type === 'relation').map((p) => p.id)),
  );
  const relations: Operation[] = [];
  for (const row of rows) {
    const values = Object.fromEntries(
      Object.entries(row.values).filter(([id]) => !relationIds.has(id)),
    );
    const related = Object.fromEntries(
      Object.entries(row.values).filter(([id]) => relationIds.has(id)),
    );
    const create: PageCreate = { ...rowPage(row), row: { values } };
    out.push(op('page.create', row.id, create));
    if (Object.keys(related).length) relations.push(op('row.update', row.id, { values: related }));
  }
  out.push(...relations);
  const roots = pages
    .filter((p) => p.trashedAt && p.trashRootId === p.id)
    .sort((a, b) => depth(b) - depth(a));
  for (const root of roots) out.push(op('page.trash', root.id, {}));
  for (const row of rows)
    if (row.trashedAt && row.trashRootId === row.id) out.push(op('page.trash', row.id, {}));
  const rowIds = new Set(rows.map((r) => r.id));
  for (const favourite of favourites)
    if (byId.has(favourite.pageId) || rowIds.has(favourite.pageId))
      out.push(
        op('favourite.set', favourite.pageId, { favourite: true, orderKey: favourite.orderKey }),
      );
  return out;
}
