// What the server says, as plans the stores write the way they write planOps' plans: the answers
// to pushed operations (planSettle) and batches from the change feed or the tree (planRemote).
// Every store runs these same rules (SYNC_DESIGN.md, Channel 2):
//   - an entity with operations still waiting in the outbox keeps its local state: the local
//     change wins until the server has answered it, then the answer's entity is taken;
//   - deletes always apply, with the page's document, history and search entry;
//   - a whole tree (or a subtree) replaces what the device held of it.
import type { Id } from './ids';
import type { Plan } from './ops';
import type {
  EntityRecord,
  FavouriteRecord,
  Operation,
  OpResult,
  PageRecord,
  RemoteBatch,
  SectionRecord,
  VisitRecord,
  WorkspaceRecord,
} from './types';

/** What the remote planners read; each store answers from inside its transaction. */
export interface RemoteReader {
  workspace(id: Id): Promise<WorkspaceRecord | undefined>;
  workspacePages(workspaceId: Id): Promise<PageRecord[]>;
  workspaceSections(workspaceId: Id): Promise<SectionRecord[]>;
  /** Whether an operation on this entity waits in the outbox, leaving out the ones in `except`. */
  pending(entityId: Id, except?: ReadonlySet<Id>): Promise<boolean>;
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

export async function planRemote(batch: RemoteBatch, reader: RemoteReader): Promise<Plan> {
  const plan = emptyPlan();
  const ws = batch.workspaceId;
  if (batch.deleteWorkspace) {
    plan.deleteWorkspaces = [ws];
    plan.deletePages = (await reader.workspacePages(ws)).map((p) => p.id);
    return plan;
  }
  const keep = async (id: Id) => !(await reader.pending(id));
  for (const w of batch.workspaces ?? [])
    if (await keep(w.id)) plan.workspaces.push(await withAccount(reader, w));
  for (const s of batch.sections ?? []) if (await keep(s.id)) plan.sections.push(s);
  for (const p of batch.pages ?? []) if (await keep(p.id)) plan.pages.push(p);
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

  if (batch.replace) {
    const held = await reader.workspacePages(ws);
    const sent = new Set((batch.pages ?? []).map((p) => p.id));
    const scope = batch.replace.root === null ? null : subtree(held, batch.replace.root);
    for (const page of held)
      if (!sent.has(page.id) && (scope === null || scope.has(page.id)) && (await keep(page.id)))
        plan.deletePages.push(page.id);
    if (batch.replace.root === null) {
      const sentSections = new Set((batch.sections ?? []).map((s) => s.id));
      for (const section of await reader.workspaceSections(ws))
        if (!sentSections.has(section.id) && (await keep(section.id)))
          plan.deleteSections.push(section.id);
    }
  }
  plan.deletePages = [...new Set(plan.deletePages)];
  // A page that goes takes the account's favourite and visit of it, as a local delete does.
  const gone = new Set(plan.deletePages);
  const pairs = new Set(plan.deleteFavourites.map((f) => f.pageId));
  for (const pageId of gone)
    if (!pairs.has(pageId)) plan.deleteFavourites.push({ workspaceId: ws, pageId });
  const visited = new Set(plan.deleteVisits.map((v) => v.pageId));
  for (const pageId of gone)
    if (!visited.has(pageId)) plan.deleteVisits.push({ workspaceId: ws, pageId });
  plan.favourites = plan.favourites.filter((f) => !gone.has(f.pageId));
  plan.visits = plan.visits.filter((v) => !gone.has(v.pageId));
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
        case 'page':
          plan.pages.push(entity as PageRecord);
          break;
        case 'favourite':
          plan.favourites.push(entity as FavouriteRecord);
          break;
        case 'visit':
          plan.visits.push(entity as VisitRecord);
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
          if (result.status === 'rejected') plan.deletePages.push(op.entityId);
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
  return plan;
}

/**
 * A local workspace's records as creates, parents first, then its trash (deepest roots first, so a
 * page trashed on its own keeps its own root) and favourites: what an upload sends (M2.3).
 */
export function uploadOps(
  workspace: WorkspaceRecord,
  sections: SectionRecord[],
  pages: PageRecord[],
  favourites: FavouriteRecord[],
  newOpId: () => Id,
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
  for (const page of ordered)
    out.push(
      op('page.create', page.id, { ...page, version: 1, trashedAt: null, trashRootId: null }),
    );
  const roots = pages
    .filter((p) => p.trashedAt && p.trashRootId === p.id)
    .sort((a, b) => depth(b) - depth(a));
  for (const root of roots) out.push(op('page.trash', root.id, {}));
  for (const favourite of favourites)
    if (byId.has(favourite.pageId))
      out.push(
        op('favourite.set', favourite.pageId, { favourite: true, orderKey: favourite.orderKey }),
      );
  return out;
}
