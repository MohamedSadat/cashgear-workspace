// An in-memory server for the sync engine's tests: the operations endpoint with AppliedOps, the
// change feed (with retention), the tree, documents by sequence (no validation, but the push
// checks: access, epoch, schema version, sizes), the state hash and repair, Yjs client ids and
// assets, with the same tree rules as the real one (it runs the client's own planner, which the
// server ports, plus the server's own fallbacks: a create under a parent that is gone or in the
// trash goes to the top of its section, and a sibling's equal order key is replaced).
//
// Faults: `offline` refuses every call; `lose` applies the next call of a kind, then loses its
// answer, as a dropped connection does; `throttle` answers the next call of a kind with 429 (or
// 503) and a `Retry-After`; `expire` answers an account's calls with 401.
//
// Phase 4: databases, views and rows with the server's rules (contract sections 1, 2 and 4): the
// client's planner again (per-property merges, coercion, type changes converting every row,
// relations kept two-way, the tree rules), plus what only the server does: each property's
// version rises with every write of it; created and edited by; rows' counts; a trash or restore
// of a page reaches the rows of the databases under it; a relation keeps only rows of its target
// that exist; a reverse property needs the target database to be visible. Every change to a row
// is a `row` change in the feed; the tree carries databases and views, never rows; rows come by
// `rows` (by id) and `query` (by `queryRows`). Formula and rollup results are not computed here
// (`computed` stays empty).
import { queryRows } from '../db/query';
import type { PropertyId, QuerySpec, Value } from '../db/types';
import { uuidv7, type Id } from '../ids';
import { Mirror } from '../mirror';
import { planOps, type Plan } from '../ops';
import { compareSiblings, keyBetween, keysBetween } from '../order';
import { emptyPlan } from '../remote';
import {
  OfflineError,
  SyncHttpError,
  type Account,
  type DocCodec,
  type DocPull,
  type ServerChange,
  type SyncApi,
} from '../sync/api';
import {
  OpError,
  type EntityRecord,
  type EntityType,
  type Operation,
  type OpResult,
  type PageKind,
  type PageRecord,
  type RowRecord,
  type WorkspaceRecord,
} from '../types';

/** A refusal the server makes that the planner does not (an access check). */
class Refusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface Change {
  seq: number;
  entityType: ServerChange['entityType'];
  entityId: Id;
  kind: string;
  /** Seen only by this account (an access event); everyone's when absent. */
  userId?: Id;
}

interface Space {
  mirror: Mirror;
  seq: number;
  changes: Change[];
  /** The highest sequence pruned from the feed: `after` below it is 410 `feed.expired`. */
  prunedSeq: number;
  applied: Map<Id, OpResult>;
  members: Set<Id>;
  /** Members who may only read (demoted). */
  readers: Set<Id>;
  yjs: Map<number, Id>;
  /** The kind of every page made here, gone or not (an answer about a row deleted for good). */
  kinds: Map<Id, PageKind>;
}

interface DocRow {
  seq: number;
  updateId: Id;
  data: Uint8Array;
  userId: Id;
}

interface ServerDoc {
  epoch: number;
  schemaVersion: number;
  rows: DocRow[];
}

export type Kind =
  | 'me'
  | 'listWorkspaces'
  | 'createWorkspace'
  | 'pushOps'
  | 'changes'
  | 'tree'
  | 'pushDoc'
  | 'pullDoc'
  | 'docStateHash'
  | 'repairDoc'
  | 'fetchBytes'
  | 'yjsClients'
  | 'assetTicket'
  | 'putBytes'
  | 'completeAsset'
  | 'assetUrl'
  | 'rows'
  | 'query';

export interface FakeServerOptions {
  /** What the state hash is computed with: the fake cannot read Yjs itself. */
  codec?: DocCodec;
  /** For Yjs client ids it issues. */
  random?: () => number;
}

/** The server's limits on a push (SYNC_DESIGN.md, What the server checks). */
export const MAX_UPDATE_BYTES = 1024 * 1024;
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_REQUEST_UPDATES = 200;
const MAX_PULL = 1000;

export class FakeServer {
  readonly spaces = new Map<Id, Space>();
  readonly docs = new Map<Id, ServerDoc>();
  readonly blobs = new Map<string, Uint8Array>();
  readonly assets = new Map<Id, { workspaceId: Id; completed: boolean }>();
  /** Pages deleted for good: their routes answer 410 `page.gone`. */
  readonly gone = new Set<Id>();
  /** Pages no one may see (revoked for everyone). */
  readonly hidden = new Set<Id>();
  private readonly hiddenFor = new Map<Id, Set<Id>>();
  /** Pages whose state hash the worker has not computed yet (null in the answer). */
  readonly hashPending = new Set<Id>();
  offline = false;
  private readonly lost = new Set<Kind>();
  private readonly throttled = new Map<Kind, { status: number; retryAfterMs: number }>();
  private readonly expired = new Set<Id>();
  calls: string[] = [];
  /** Every document push that reached the server: page, how many updates, how many bytes. */
  pushes: { pageId: Id; count: number; bytes: number }[] = [];

  constructor(private readonly options: FakeServerOptions = {}) {}

  // Faults ---------------------------------------------------------------------------------------

  /** The next call of this kind is applied, then its answer is lost. */
  lose(kind: Kind) {
    this.lost.add(kind);
  }

  /** The next call of this kind is answered 429 (or 503) with `Retry-After`. */
  throttle(kind: Kind, retryAfterMs: number, status = 429) {
    this.throttled.set(kind, { status, retryAfterMs });
  }

  /** The account's session ends: its calls are 401 until `renew`. */
  expire(accountId: Id) {
    this.expired.add(accountId);
  }

  renew(accountId: Id) {
    this.expired.delete(accountId);
  }

  private answer<T>(kind: Kind, value: T): T {
    if (this.lost.delete(kind)) throw new OfflineError('answer lost');
    return value;
  }

  private gate(kind: Kind, account: Account) {
    this.calls.push(kind);
    if (this.offline) throw new OfflineError();
    if (this.expired.has(account.id)) throw new SyncHttpError(401, 'auth.required');
    const throttle = this.throttled.get(kind);
    if (throttle) {
      this.throttled.delete(kind);
      throw new SyncHttpError(
        throttle.status,
        throttle.status === 429 ? 'limit.rate' : 'server.unavailable',
        undefined,
        throttle.retryAfterMs,
      );
    }
  }

  // The server's own changes, as tests script them -------------------------------------------------

  private space(account: Account, workspaceId: Id): Space {
    const space = this.spaces.get(workspaceId);
    if (!space || !space.members.has(account.id)) throw new SyncHttpError(404, 'not.found');
    return space;
  }

  /** The space a page, a database's page or a row is in. */
  private spaceOfPage(pageId: Id): Space | undefined {
    for (const space of this.spaces.values())
      if (space.mirror.pages.has(pageId) || space.mirror.rowRecords.has(pageId)) return space;
    return undefined;
  }

  /** A change to the feed; a page's change is a row's when the page is a row (FeedService). */
  private change(
    space: Space,
    entityType: ServerChange['entityType'],
    entityId: Id,
    kind = 'upsert',
    userId?: Id,
  ) {
    const type = entityType === 'page' && space.kinds.get(entityId) === 'row' ? 'row' : entityType;
    space.changes.push({ seq: ++space.seq, entityType: type, entityId, kind, userId });
  }

  /** Whether the account may see a page; a row is seen as its database is. */
  private visible(account: Account, pageId: Id): boolean {
    const id = this.spaceOfPage(pageId)?.mirror.rowRecords.get(pageId)?.databaseId ?? pageId;
    return !this.hidden.has(id) && !this.hiddenFor.get(account.id)?.has(id);
  }

  private entity(space: Space, type: EntityType | undefined, op: Operation): EntityRecord | null {
    const m = space.mirror;
    switch (type) {
      case 'workspace':
        return m.workspaces.get(op.workspaceId) ?? null;
      case 'section':
        return m.sections.get(op.entityId) ?? null;
      case 'page':
        return m.pages.get(op.entityId) ?? null;
      case 'favourite':
        return m.favourites.get(`${op.workspaceId}/${op.entityId}`) ?? null;
      case 'visit':
        return m.visits.get(`${op.workspaceId}/${op.entityId}`) ?? null;
      case 'database':
        return m.databases.get(op.entityId) ?? null;
      case 'view':
        return m.views.get(op.entityId) ?? null;
      case 'row':
        return m.rowRecords.get(op.entityId) ?? null;
      default:
        return null;
    }
  }

  /** What an operation's answer is about: a row's page operations answer with the row. */
  private entityTypeOf(space: Space, op: Operation): EntityType {
    switch (op.type) {
      case 'db.update':
        return 'database';
      case 'view.upsert':
      case 'view.delete':
        return 'view';
      case 'row.update':
        return 'row';
      case 'page.create':
        return op.payload.kind === 'row' ? 'row' : 'page';
      default:
        if (op.type.startsWith('page.') && space.kinds.get(op.entityId) === 'row') return 'row';
        return op.type.split('.')[0] as EntityType;
    }
  }

  /** The page whose visibility decides whether the account may see what an operation is about. */
  private subjectOf(space: Space, op: Operation): Id | null {
    switch (op.type) {
      case 'db.update':
      case 'row.update':
        return op.entityId;
      case 'view.upsert':
        return op.payload.databaseId;
      case 'view.delete':
        return space.mirror.views.get(op.entityId)?.databaseId ?? null;
      case 'page.create':
        // A row is made in a database the account must see.
        return op.payload.kind === 'row' ? op.payload.parentPageId : null;
      default:
        return op.type.startsWith('page.') ? op.entityId : null;
    }
  }

  /** A page (or a row) as an account sees it: its document's head, epoch and schema, its level. */
  private pageView<T extends PageRecord>(space: Space, account: Account, page: T): T {
    const doc = this.docs.get(page.id);
    return {
      ...structuredClone(page),
      docHeadSeq: doc?.rows.at(-1)?.seq ?? 0,
      docEpoch: doc?.epoch ?? 0,
      docSchemaVersion: doc?.schemaVersion ?? 1,
      ...(space.readers.has(account.id) ? { access: 'view' as const } : {}),
    };
  }

  /** A database the account may read, with the space it is in; 404 otherwise. */
  private databaseGate(account: Account, databaseId: Id) {
    const space = this.spaceOfPage(databaseId);
    const database = space?.mirror.databases.get(databaseId);
    if (!space || !database || !space.members.has(account.id) || !this.visible(account, databaseId))
      throw new SyncHttpError(404, 'not.found');
    return { space, database };
  }

  /**
   * Rows made on the server's side, as an import would (tests' large databases): `count` rows
   * after the database's last, each titled `Row {n}` with the values given.
   */
  seedRows(
    databaseId: Id,
    count: number,
    values: (i: number) => Record<PropertyId, Value> = () => ({}),
  ): RowRecord[] {
    const space = this.spaceOfPage(databaseId)!;
    const m = space.mirror;
    if (!m.databases.has(databaseId)) throw new Error('No such database');
    const page = m.pages.get(databaseId)!;
    const last = m
      .rowsOf(databaseId)
      .map((r) => r.orderKey)
      .sort()
      .at(-1);
    const keys = keysBetween(last ?? null, null, count);
    const at = new Date().toISOString();
    const rows = keys.map((orderKey, i): RowRecord => ({
      id: uuidv7(),
      workspaceId: page.workspaceId,
      sectionId: page.sectionId,
      parentPageId: databaseId,
      orderKey,
      kind: 'row',
      title: `Row ${i}`,
      icon: null,
      coverAssetId: null,
      isTemplate: false,
      templateOfPageId: null,
      version: 1,
      createdAt: at,
      updatedAt: at,
      trashedAt: null,
      trashRootId: null,
      databaseId,
      values: values(i),
      versions: Object.fromEntries(Object.keys(values(i)).map((k) => [k, 1])),
      computed: {},
      computedVersion: null,
      createdBy: null,
      updatedBy: null,
    }));
    m.apply({ ...emptyPlan(), rows });
    for (const row of rows) {
      space.kinds.set(row.id, 'row');
      this.change(space, 'row', row.id);
    }
    this.recount(space, [databaseId], new Set([databaseId]));
    return rows;
  }

  /**
   * Rows' counts made again (rows not trashed and not templates); a database whose count moved
   * or whose rows were made or removed is a `database` change.
   */
  private recount(space: Space, databaseIds: Iterable<Id>, made: ReadonlySet<Id>) {
    const m = space.mirror;
    for (const id of new Set(databaseIds)) {
      const database = m.databases.get(id);
      if (!database) continue;
      const count = m.rowsOf(id).filter((r) => !r.trashedAt && !r.isTemplate).length;
      if (count !== database.rowCount) m.databases.set(id, { ...database, rowCount: count });
      if (count !== database.rowCount || made.has(id)) this.change(space, 'database', id);
    }
  }

  /** Adds a second person to a workspace, as an invite accepted would. */
  addMember(workspaceId: Id, accountId: Id) {
    this.spaces.get(workspaceId)!.members.add(accountId);
  }

  /** Makes a member a reader (or an editor again): pushes are 403 `access.denied`. */
  demote(workspaceId: Id, accountId: Id, reader = true) {
    const space = this.spaces.get(workspaceId)!;
    if (reader) space.readers.add(accountId);
    else space.readers.delete(accountId);
    this.change(space, 'member', accountId);
    // Every page's level changed for them: the client fetches the tree again.
    this.change(space, 'access', workspaceId, 'grant', accountId);
  }

  /** Removes access to a page and its subtree (for one account, or everyone), with a revoke. */
  revoke(workspaceId: Id, rootId: Id, accountId?: Id) {
    const space = this.spaces.get(workspaceId)!;
    const ids = [rootId, ...space.mirror.descendantIds(rootId)];
    if (accountId) {
      let set = this.hiddenFor.get(accountId);
      if (!set) this.hiddenFor.set(accountId, (set = new Set()));
      for (const id of ids) set.add(id);
    } else for (const id of ids) this.hidden.add(id);
    this.change(space, 'access', rootId, 'revoke', accountId);
  }

  /** Gives access to a page and its subtree back (for one account, or everyone), with a grant. */
  grant(workspaceId: Id, rootId: Id, accountId?: Id) {
    const space = this.spaces.get(workspaceId)!;
    const ids = [rootId, ...space.mirror.descendantIds(rootId)];
    for (const id of ids) {
      if (accountId) this.hiddenFor.get(accountId)?.delete(id);
      else this.hidden.delete(id);
    }
    this.change(space, 'access', rootId, 'grant', accountId);
  }

  /** The worker's feed retention: changes up to `upToSeq` (all, by default) are deleted. */
  pruneFeed(workspaceId: Id, upToSeq?: number) {
    const space = this.spaces.get(workspaceId)!;
    const to = upToSeq ?? space.seq;
    space.changes = space.changes.filter((c) => c.seq > to);
    space.prunedSeq = Math.max(space.prunedSeq, to);
  }

  /**
   * A permanent delete on the server (a person's, or trash retention): pages and documents go,
   * and a database's rows with it; a row alone, when it is one.
   */
  purge(pageId: Id) {
    const space = this.spaceOfPage(pageId)!;
    const m = space.mirror;
    const row = m.rowRecords.get(pageId);
    const ids = row ? [] : [pageId, ...m.descendantIds(pageId)];
    const rows = row ? [row] : ids.flatMap((id) => m.rowsOf(id));
    const views = ids.flatMap((id) => m.viewsOf(id).map((v) => v.id));
    const databases = ids.filter((id) => m.databases.has(id));
    m.apply({ ...emptyPlan(), deletePages: ids, deleteRows: rows.map((r) => r.id) });
    for (const id of ids) {
      this.gone.add(id);
      this.docs.delete(id);
      this.change(space, 'page', id, 'delete');
    }
    for (const id of databases) this.change(space, 'database', id, 'delete');
    for (const id of views) this.change(space, 'view', id, 'delete');
    for (const r of rows) {
      this.gone.add(r.id);
      this.docs.delete(r.id);
      this.change(space, 'row', r.id, 'delete');
    }
    if (row) this.recount(space, [row.databaseId], new Set([row.databaseId]));
  }

  /** A hard restore: a new epoch whose history is the given state (sequence numbers keep rising). */
  hardRestore(pageId: Id, state: Uint8Array) {
    const doc = this.docOf(pageId);
    const seq = (doc.rows.at(-1)?.seq ?? 0) + 1;
    doc.epoch++;
    doc.rows = [{ seq, updateId: uuidv7(), data: new Uint8Array(state), userId: 'server' }];
    const space = this.spaceOfPage(pageId);
    if (space) this.change(space, 'page', pageId);
  }

  /** The page's document needs a newer client: older ones get 426 `client.tooOld`. */
  raiseSchema(pageId: Id, version: number) {
    this.docOf(pageId).schemaVersion = version;
    const space = this.spaceOfPage(pageId);
    if (space) this.change(space, 'page', pageId);
  }

  private docOf(pageId: Id): ServerDoc {
    let doc = this.docs.get(pageId);
    if (!doc) this.docs.set(pageId, (doc = { epoch: 0, schemaVersion: 1, rows: [] }));
    return doc;
  }

  /** Everything the server holds of a page's document, in sequence order. */
  docParts(pageId: Id): Uint8Array[] {
    return (this.docs.get(pageId)?.rows ?? []).map((r) => new Uint8Array(r.data));
  }

  /** A page route's checks: 410 for a page deleted for good, 404 for one the caller cannot see. */
  private pageGate(account: Account, pageId: Id, edit: boolean): { space: Space; doc: ServerDoc } {
    if (this.gone.has(pageId)) throw new SyncHttpError(410, 'page.gone');
    const space = this.spaceOfPage(pageId);
    if (!space || !space.members.has(account.id) || !this.visible(account, pageId))
      throw new SyncHttpError(404, 'not.found');
    if (edit && space.readers.has(account.id)) throw new SyncHttpError(403, 'access.denied');
    return { space, doc: this.docOf(pageId) };
  }

  private store(
    account: Account,
    doc: ServerDoc,
    request: { epoch: number; clientSchemaVersion: number },
    updates: { updateId: Id; data: Uint8Array }[],
  ) {
    if (request.epoch !== doc.epoch) throw new SyncHttpError(409, 'doc.epochMismatch');
    if (request.clientSchemaVersion < doc.schemaVersion)
      throw new SyncHttpError(426, 'client.tooOld');
    if (updates.some((u) => u.data.byteLength > MAX_UPDATE_BYTES))
      throw new SyncHttpError(413, 'limit.size');
    if (updates.reduce((n, u) => n + u.data.byteLength, 0) > MAX_REQUEST_BYTES)
      throw new SyncHttpError(413, 'limit.size');
    if (updates.length > MAX_REQUEST_UPDATES) throw new SyncHttpError(400, 'request.invalid');
    return updates.map((u) => {
      const seen = doc.rows.find((r) => r.updateId === u.updateId);
      if (seen) return { updateId: u.updateId, seq: seen.seq };
      const seq = (doc.rows.at(-1)?.seq ?? 0) + 1;
      doc.rows.push({
        seq,
        updateId: u.updateId,
        data: new Uint8Array(u.data),
        userId: account.id,
      });
      return { updateId: u.updateId, seq };
    });
  }

  private pull(doc: ServerDoc, after: number): DocPull {
    const rows = doc.rows.filter((r) => r.seq > after);
    const more = rows.length > MAX_PULL;
    const sent = rows.slice(0, MAX_PULL);
    const head = doc.rows.at(-1)?.seq ?? 0;
    return {
      epoch: doc.epoch,
      schemaVersion: doc.schemaVersion,
      headSeq: head,
      cursor: more ? sent.at(-1)!.seq : head,
      more,
      snapshot: null,
      updates: sent.map((r) => ({
        seq: r.seq,
        updateId: r.updateId,
        data: new Uint8Array(r.data),
      })),
      rejected: [],
    };
  }

  /**
   * The server's planner, with its fallbacks for a parent that is gone and equal order keys, and
   * what only the server does with databases (the file's head says what).
   */
  private async apply(
    space: Space,
    account: Account,
    op: Operation,
  ): Promise<{ op: Operation; notice?: string }> {
    const m = space.mirror;
    let notice: string | undefined;
    const row =
      (op.type === 'page.create' && op.payload.kind === 'row') ||
      (op.type === 'page.move' && m.rowRecords.has(op.entityId));
    if ((op.type === 'page.create' || op.type === 'page.move') && !row) {
      const payload = { ...op.payload } as PageRecord;
      const parent = payload.parentPageId ? m.pages.get(payload.parentPageId) : undefined;
      if (op.type === 'page.create' && payload.parentPageId && (!parent || parent.trashedAt)) {
        // The parent is gone (or in the trash): the page goes to the top of its section, and the
        // user is told.
        const top = m.topPages(payload.sectionId).filter((p) => p.id !== op.entityId);
        payload.parentPageId = null;
        payload.orderKey = keyBetween(top.at(-1)?.orderKey ?? null, null);
        notice = 'tree.parentMissing';
      }
      const siblings = (
        payload.parentPageId
          ? m.childrenOf(payload.parentPageId, true)
          : m.childrenOf(`section:${payload.sectionId}`, true)
      )
        .filter((p) => p.id !== op.entityId)
        .sort(compareSiblings);
      if (siblings.some((p) => p.orderKey === payload.orderKey)) {
        // Two pages with one key: the later gets a key of its own, just after.
        const next = siblings.find((p) => p.orderKey > payload.orderKey);
        payload.orderKey = keyBetween(payload.orderKey, next?.orderKey ?? null);
      }
      op = { ...op, payload } as Operation;
    }
    op = this.keepRelated(m, op);
    const plan = await planOps([structuredClone(op)], m);
    // A reverse property added to another database needs the account to see it (edit on both).
    for (const database of plan.databases)
      if (database.id !== op.entityId && !this.visible(account, database.id))
        throw new Refusal('access.denied');
    this.checkFiles(m, plan);
    this.cascadeTrash(m, op, plan);
    this.stampRows(m, account, op, plan);
    // What the plan removes, read before it goes.
    const removedRows = plan.deleteRows
      .map((id) => m.rowRecords.get(id))
      .filter((r): r is RowRecord => !!r);
    const removedDatabases = plan.deletePages.filter((id) => m.databases.has(id));
    const removedViews = [
      ...plan.deleteViews,
      ...removedDatabases.flatMap((id) => m.viewsOf(id).map((v) => v.id)),
    ];
    const made = new Set(plan.rows.filter((r) => !m.rowRecords.has(r.id)).map((r) => r.databaseId));
    for (const r of removedRows) made.add(r.databaseId);
    m.apply(plan);
    for (const p of plan.pages) {
      space.kinds.set(p.id, p.kind);
      this.change(space, 'page', p.id);
    }
    for (const r of plan.rows) {
      space.kinds.set(r.id, 'row');
      this.change(space, 'row', r.id);
    }
    for (const id of plan.deletePages) {
      this.change(space, 'page', id, 'delete');
      this.gone.add(id);
      this.docs.delete(id);
    }
    for (const id of removedDatabases) this.change(space, 'database', id, 'delete');
    for (const r of removedRows) {
      this.change(space, 'row', r.id, 'delete');
      this.gone.add(r.id);
      this.docs.delete(r.id);
    }
    for (const d of plan.databases) this.change(space, 'database', d.id);
    for (const v of plan.views) this.change(space, 'view', v.id);
    for (const id of new Set(removedViews)) this.change(space, 'view', id, 'delete');
    this.recount(
      space,
      [...plan.rows.map((r) => r.databaseId), ...made],
      new Set([...made].filter((id) => !plan.databases.some((d) => d.id === id))),
    );
    for (const s of plan.sections) this.change(space, 'section', s.id);
    for (const id of plan.deleteSections) this.change(space, 'section', id, 'delete');
    for (const w of plan.workspaces) this.change(space, 'workspace', w.id);
    for (const f of plan.favourites) this.change(space, 'favourite', f.pageId);
    for (const f of plan.deleteFavourites) this.change(space, 'favourite', f.pageId, 'delete');
    return { op, notice };
  }

  /**
   * A relation written to a row keeps only rows of its target database the server has (as the
   * server reads the ids it is given); the rest are dropped before the planner sees them.
   */
  /**
   * The server's rule for files (OpsService `CoverAsync`, DatabaseOps `FilesAsync`): a page's new
   * cover, and each file newly added to a row, must be a file the server holds; knowing its id is
   * not enough (`access.denied`).
   */
  private checkFiles(m: Mirror, plan: Plan) {
    const held = (id: Id) => this.assets.get(id)?.completed === true;
    for (const page of plan.pages) {
      const cover = page.coverAssetId;
      if (cover && cover !== m.pages.get(page.id)?.coverAssetId && !held(cover))
        throw new Refusal('access.denied');
    }
    for (const row of plan.rows) {
      const database =
        plan.databases.find((d) => d.id === row.databaseId) ?? m.databases.get(row.databaseId);
      const before = m.rowRecords.get(row.id);
      if (row.coverAssetId && row.coverAssetId !== before?.coverAssetId && !held(row.coverAssetId))
        throw new Refusal('access.denied');
      for (const def of database?.properties ?? []) {
        if (def.type !== 'files') continue;
        const now = row.values[def.id];
        const was = before?.values[def.id];
        const old = new Set(Array.isArray(was) ? (was as string[]) : []);
        for (const id of Array.isArray(now) ? (now as string[]) : [])
          if (!old.has(id) && !held(id)) throw new Refusal('access.denied');
      }
    }
  }

  private keepRelated(m: Mirror, op: Operation): Operation {
    let values: Record<PropertyId, Value | null> | undefined;
    let databaseId: Id | null | undefined;
    if (op.type === 'row.update') {
      values = op.payload.values;
      databaseId = m.rowRecords.get(op.entityId)?.databaseId;
    } else if (op.type === 'page.create' && op.payload.kind === 'row') {
      values = op.payload.row?.values;
      databaseId = op.payload.parentPageId;
    }
    const database = databaseId ? m.databases.get(databaseId) : undefined;
    if (!values || !database) return op;
    let changed = false;
    const kept = { ...values };
    for (const [id, value] of Object.entries(values)) {
      const def = database.properties.find((p) => p.id === id);
      if (def?.type !== 'relation' || !Array.isArray(value)) continue;
      const ids = value.filter(
        (rowId) => m.rowRecords.get(rowId)?.databaseId === def.relation?.databaseId,
      );
      if (ids.length === value.length) continue;
      kept[id] = ids.length ? ids : null;
      changed = true;
    }
    if (!changed) return op;
    if (op.type === 'row.update') return { ...op, payload: { values: kept } };
    if (op.type !== 'page.create') return op;
    const made = Object.fromEntries(
      Object.entries(kept).filter((entry): entry is [PropertyId, Value] => entry[1] !== null),
    );
    return { ...op, payload: { ...op.payload, row: { values: made } } };
  }

  /**
   * A trash reaches the rows of the databases it trashes (the subtree rule: the server's rows are
   * pages under their database), and a restore brings back those it trashed. Rows trashed on
   * their own keep their own root. (The client's planner does not cascade: its rows read as
   * trashed while their database is, and the server's rows come in the feed.)
   */
  private cascadeTrash(m: Mirror, op: Operation, plan: Plan) {
    if (op.type !== 'page.trash' && op.type !== 'page.restore') return;
    for (const page of plan.pages) {
      if (page.kind !== 'database') continue;
      for (const r of m.rowsOf(page.id)) {
        if (op.type === 'page.trash' && !r.trashedAt)
          plan.rows.push({
            ...r,
            trashedAt: page.trashedAt,
            trashRootId: op.entityId,
            version: r.version + 1,
          });
        else if (op.type === 'page.restore' && r.trashRootId === op.entityId)
          plan.rows.push({ ...r, trashedAt: null, trashRootId: null, version: r.version + 1 });
      }
    }
  }

  /**
   * What the server writes on every row a plan writes: each property's version rises with every
   * write of it (every property the operation names on its own row, whatever its value; on other
   * rows, those whose value changed: a reverse relation, a conversion); who edited it last; who
   * made it.
   */
  private stampRows(m: Mirror, account: Account, op: Operation, plan: Plan) {
    const named = new Set<PropertyId>(
      Object.keys(
        op.type === 'row.update'
          ? op.payload.values
          : op.type === 'page.create'
            ? (op.payload.row?.values ?? {})
            : {},
      ),
    );
    plan.rows = plan.rows.map((row) => {
      const before = m.rowRecords.get(row.id);
      const own = row.id === op.entityId;
      const versions = { ...(before?.versions ?? {}) };
      const keys = new Set([
        ...Object.keys(row.values),
        ...Object.keys(before?.values ?? {}),
        ...(own ? named : []),
      ]);
      for (const key of keys)
        if (
          (own && named.has(key)) ||
          JSON.stringify(row.values[key]) !== JSON.stringify(before?.values[key])
        )
          versions[key] = (versions[key] ?? 0) + 1;
      return {
        ...row,
        versions,
        updatedBy: account.id,
        createdBy: before ? before.createdBy : account.id,
      };
    });
  }

  api(account: Account): SyncApi {
    return {
      me: async () => {
        this.gate('me', account);
        return account;
      },
      listWorkspaces: async () => {
        this.gate('listWorkspaces', account);
        return [...this.spaces.entries()]
          .filter(([, s]) => s.members.has(account.id))
          .map(([id, s]) => s.mirror.workspaces.get(id)!)
          .map((w) => ({ ...w }));
      },
      createWorkspace: async (w) => {
        this.gate('createWorkspace', account);
        const existing = this.spaces.get(w.id);
        if (existing) return { ...existing.mirror.workspaces.get(w.id)! };
        const record: WorkspaceRecord = {
          id: w.id,
          name: w.name,
          icon: w.icon,
          createdAt: new Date().toISOString(),
          version: 1,
          localOnly: false,
          deletedAt: null,
        };
        const space: Space = {
          mirror: new Mirror(),
          seq: 0,
          changes: [],
          prunedSeq: 0,
          applied: new Map(),
          members: new Set([account.id]),
          readers: new Set(),
          yjs: new Map(),
          kinds: new Map(),
        };
        space.mirror.load({
          workspaces: [record],
          sections: [],
          pages: [],
          favourites: [],
          visits: [],
          assets: [],
          databases: [],
          views: [],
        });
        this.spaces.set(w.id, space);
        this.change(space, 'workspace', w.id);
        return this.answer('createWorkspace', { ...record });
      },
      pushOps: async (workspaceId, _device, ops) => {
        this.gate('pushOps', account);
        const space = this.space(account, workspaceId);
        const results: OpResult[] = [];
        for (const op of ops) {
          const seen = space.applied.get(op.opId);
          if (seen) {
            results.push(structuredClone(seen));
            continue;
          }
          const type = this.entityTypeOf(space, op);
          const subject = this.subjectOf(space, op);
          let result: OpResult;
          if (subject && !this.visible(account, subject)) {
            // A page the caller may not see is, to them, no page at all (a row: its database).
            result = {
              opId: op.opId,
              status: 'rejected',
              error: { code: 'not.found' },
              entityType: type,
              entity: null,
            };
          } else if (
            space.readers.has(account.id) &&
            op.type !== 'favourite.set' &&
            op.type !== 'visit.record'
          ) {
            result = {
              opId: op.opId,
              status: 'rejected',
              error: { code: 'access.denied' },
              entityType: type,
              entity: structuredClone(this.entity(space, type, op)),
            };
          } else
            try {
              const done = await this.apply(space, account, op);
              result = {
                opId: op.opId,
                status: 'applied',
                entityType: type,
                entity: structuredClone(this.entity(space, type, done.op)),
                ...(done.notice ? { notice: done.notice } : {}),
              };
            } catch (error) {
              if (!(error instanceof OpError) && !(error instanceof Refusal)) throw error;
              result = {
                opId: op.opId,
                status: 'rejected',
                error: { code: error.code },
                entityType: type,
                entity: structuredClone(this.entity(space, type, op)),
              };
            }
          if ((result.entityType === 'page' || result.entityType === 'row') && result.entity)
            result.entity = this.pageView(space, account, result.entity as PageRecord);
          space.applied.set(op.opId, structuredClone(result));
          results.push(result);
        }
        return this.answer('pushOps', results);
      },
      changes: async (workspaceId, after, limit) => {
        this.gate('changes', account);
        const space = this.space(account, workspaceId);
        if (after < space.prunedSeq) throw new SyncHttpError(410, 'feed.expired');
        const rows = space.changes
          .filter((c) => c.seq > after && (!c.userId || c.userId === account.id))
          .slice(0, limit);
        const m = space.mirror;
        const changes = rows.map((row): ServerChange => {
          switch (row.entityType) {
            case 'page': {
              const page = this.visible(account, row.entityId)
                ? m.pages.get(row.entityId)
                : undefined;
              return page
                ? {
                    seq: row.seq,
                    entityType: 'page',
                    entityId: row.entityId,
                    kind: 'upsert',
                    entity: this.pageView(space, account, page),
                  }
                : {
                    seq: row.seq,
                    entityType: 'page',
                    entityId: row.entityId,
                    kind: 'delete',
                    entity: null,
                  };
            }
            case 'section': {
              const section = m.sections.get(row.entityId);
              return section
                ? {
                    seq: row.seq,
                    entityType: 'section',
                    entityId: row.entityId,
                    kind: 'upsert',
                    entity: { ...section },
                  }
                : {
                    seq: row.seq,
                    entityType: 'section',
                    entityId: row.entityId,
                    kind: 'delete',
                    entity: null,
                  };
            }
            case 'favourite': {
              const favourite = m.favourites.get(`${workspaceId}/${row.entityId}`);
              return favourite && this.visible(account, row.entityId)
                ? {
                    seq: row.seq,
                    entityType: 'favourite',
                    entityId: row.entityId,
                    kind: 'upsert',
                    entity: { ...favourite },
                  }
                : {
                    seq: row.seq,
                    entityType: 'favourite',
                    entityId: row.entityId,
                    kind: 'delete',
                    entity: null,
                  };
            }
            case 'workspace':
              return {
                seq: row.seq,
                entityType: 'workspace',
                entityId: row.entityId,
                kind: 'upsert',
                entity: { ...m.workspaces.get(workspaceId)! },
              };
            case 'access':
              return {
                seq: row.seq,
                entityType: 'access',
                entityId: row.entityId,
                kind: row.kind as 'grant' | 'revoke',
                entity: null,
              };
            case 'database': {
              const database = this.visible(account, row.entityId)
                ? m.databases.get(row.entityId)
                : undefined;
              return database
                ? {
                    seq: row.seq,
                    entityType: 'database',
                    entityId: row.entityId,
                    kind: 'upsert',
                    entity: structuredClone(database),
                  }
                : {
                    seq: row.seq,
                    entityType: 'database',
                    entityId: row.entityId,
                    kind: 'delete',
                    entity: null,
                  };
            }
            case 'view': {
              const view = m.views.get(row.entityId);
              return view && this.visible(account, view.databaseId)
                ? {
                    seq: row.seq,
                    entityType: 'view',
                    entityId: row.entityId,
                    kind: 'upsert',
                    entity: structuredClone(view),
                  }
                : {
                    seq: row.seq,
                    entityType: 'view',
                    entityId: row.entityId,
                    kind: 'delete',
                    entity: null,
                  };
            }
            case 'row': {
              const found = m.rowRecords.get(row.entityId);
              return found && this.visible(account, found.databaseId)
                ? {
                    seq: row.seq,
                    entityType: 'row',
                    entityId: row.entityId,
                    kind: 'upsert',
                    entity: this.pageView(space, account, found),
                  }
                : {
                    seq: row.seq,
                    entityType: 'row',
                    entityId: row.entityId,
                    kind: 'delete',
                    entity: null,
                  };
            }
            default:
              return {
                seq: row.seq,
                entityType: 'member',
                entityId: row.entityId,
                kind: 'upsert',
                entity: null,
              };
          }
        });
        const cursor = rows.at(-1)?.seq ?? Math.max(after, space.seq);
        return this.answer('changes', {
          changes,
          cursor,
          more: space.changes.some((c) => c.seq > cursor && (!c.userId || c.userId === account.id)),
        });
      },
      tree: async (workspaceId, root) => {
        this.gate('tree', account);
        const space = this.space(account, workspaceId);
        const m = space.mirror;
        const under = root ? new Set([root, ...m.descendantIds(root)]) : null;
        const pages = [...m.pages.values()].filter(
          (p) =>
            p.workspaceId === workspaceId &&
            this.visible(account, p.id) &&
            (!under || under.has(p.id)),
        );
        const databases = pages.flatMap((p) => {
          const database = m.databases.get(p.id);
          return database ? [structuredClone(database)] : [];
        });
        return this.answer('tree', {
          workspace: { ...m.workspaces.get(workspaceId)! },
          sections: m.sectionsOf(workspaceId).map((s) => ({ ...s })),
          pages: pages.map((p) => this.pageView(space, account, p)),
          favourites: [...m.favourites.values()].filter(
            (f) => f.workspaceId === workspaceId && this.visible(account, f.pageId),
          ),
          visits: [],
          cursor: space.seq,
          databases,
          views: databases.flatMap((d) => m.viewsOf(d.id).map((v) => structuredClone(v))),
        });
      },
      rows: async (databaseId, after, limit) => {
        this.gate('rows', account);
        const { space } = this.databaseGate(account, databaseId);
        if (limit < 1 || limit > 1000) throw new SyncHttpError(400, 'request.invalid');
        const all = space.mirror.rowsOf(databaseId).sort((a, b) => (a.id < b.id ? -1 : 1));
        const rest = after === null ? all : all.filter((r) => r.id > after);
        const sent = rest.slice(0, limit);
        return this.answer('rows', {
          rows: sent.map((r) => this.pageView(space, account, r)),
          next: rest.length > limit ? sent.at(-1)!.id : null,
          total: all.length,
        });
      },
      query: async (databaseId, request) => {
        this.gate('query', account);
        const { space, database } = this.databaseGate(account, databaseId);
        const limit = request.limit ?? 100;
        if (limit < 1 || limit > 500) throw new SyncHttpError(400, 'request.invalid');
        const view = request.viewId ? space.mirror.views.get(request.viewId) : undefined;
        if (request.viewId && view?.databaseId !== databaseId)
          throw new SyncHttpError(404, 'not.found');
        // Explicit parts override the view's.
        const spec: QuerySpec = {
          filter: request.filter !== undefined ? request.filter : (view?.config.filter ?? null),
          sorts: request.sorts ?? view?.config.sorts ?? [],
          group: request.group !== undefined ? request.group : (view?.config.group ?? null),
          search: request.search,
        };
        const result = queryRows(
          database,
          space.mirror.rowsOf(databaseId),
          spec,
          request.context,
          request.groupKey != null ? { groupKey: request.groupKey } : {},
        );
        // The cursor is opaque to clients: here, how many rows came before.
        const offset = request.after ? Number(request.after) : 0;
        const sent = result.rows.slice(offset, offset + limit);
        return this.answer('query', {
          rows: sent.map((r) => this.pageView(space, account, r)),
          groups: result.groups,
          total: result.rows.length,
          next: offset + limit < result.rows.length ? String(offset + limit) : null,
        });
      },
      pushDoc: async (pageId, request) => {
        this.gate('pushDoc', account);
        const { space, doc } = this.pageGate(account, pageId, true);
        this.pushes.push({
          pageId,
          count: request.updates.length,
          bytes: request.updates.reduce((n, u) => n + u.data.byteLength, 0),
        });
        const acks = this.store(account, doc, request, request.updates);
        this.change(space, 'page', pageId);
        return this.answer('pushDoc', { acks, headSeq: doc.rows.at(-1)?.seq ?? 0 });
      },
      pullDoc: async (pageId, after) => {
        this.gate('pullDoc', account);
        const { doc } = this.pageGate(account, pageId, false);
        return this.answer('pullDoc', this.pull(doc, after));
      },
      docStateHash: async (pageId) => {
        this.gate('docStateHash', account);
        const { doc } = this.pageGate(account, pageId, false);
        const codec = this.options.codec;
        const hash =
          codec && !this.hashPending.has(pageId)
            ? await codec.stateHash(doc.rows.map((r) => r.data))
            : null;
        return this.answer('docStateHash', {
          epoch: doc.epoch,
          upToSeq: doc.rows.at(-1)?.seq ?? 0,
          hash,
        });
      },
      repairDoc: async (pageId, request) => {
        this.gate('repairDoc', account);
        const { space, doc } = this.pageGate(account, pageId, request.update !== null);
        let ack: { updateId: Id; seq: number } | null = null;
        if (request.update) {
          [ack] = this.store(account, doc, request, [request.update]);
          this.change(space, 'page', pageId);
        } else if (request.epoch !== doc.epoch) throw new SyncHttpError(409, 'doc.epochMismatch');
        return this.answer('repairDoc', { ack, pull: this.pull(doc, 0) });
      },
      fetchBytes: async (url) => {
        this.gate('fetchBytes', account);
        const bytes = this.blobs.get(url);
        if (!bytes) throw new SyncHttpError(404, 'not.found');
        return new Uint8Array(bytes);
      },
      yjsClients: async (workspaceId, request) => {
        this.gate('yjsClients', account);
        const space = this.space(account, workspaceId);
        const registered: number[] = [];
        const refused: number[] = [];
        for (const id of request.register ?? []) {
          const holder = space.yjs.get(id);
          if (holder && holder !== account.id) refused.push(id);
          else {
            space.yjs.set(id, account.id);
            registered.push(id);
          }
        }
        const issued: number[] = [];
        const random = this.options.random ?? Math.random;
        while (issued.length < (request.issue ?? 0)) {
          const id = 1 + Math.floor(random() * 0xfffffffe);
          if (space.yjs.has(id)) continue;
          space.yjs.set(id, account.id);
          issued.push(id);
        }
        return this.answer('yjsClients', { issued, registered, refused });
      },
      assetTicket: async (workspaceId, asset) => {
        this.gate('assetTicket', account);
        this.space(account, workspaceId);
        this.assets.set(asset.id, { workspaceId, completed: false });
        return { assetId: asset.id, uploadUrl: `fake://assets/${asset.id}`, headers: {} };
      },
      putBytes: async (url, _headers, bytes) => {
        this.gate('putBytes', account);
        this.blobs.set(url, new Uint8Array(bytes));
        this.answer('putBytes', undefined);
      },
      completeAsset: async (assetId) => {
        this.gate('completeAsset', account);
        const asset = this.assets.get(assetId);
        if (!asset || !this.blobs.has(`fake://assets/${assetId}`))
          throw new SyncHttpError(400, 'request.invalid');
        asset.completed = true;
      },
      assetUrl: async (assetId) => {
        this.gate('assetUrl', account);
        return `fake://assets/${assetId}`;
      },
    };
  }
}

/**
 * Opaque document updates for tests: JSON naming the Yjs client ids they write as, their text in
 * order, and their items as a set (what the state hash is over: merging is order-free).
 */
export const fakeCodec: DocCodec = {
  schemaVersion: 1,
  merge: (updates) =>
    encode({
      clients: [...new Set(updates.flatMap((u) => decode(u).clients))],
      text: updates.map((u) => decode(u).text).join(''),
      items: [...new Set(updates.flatMap((u) => decode(u).items ?? []))],
    }),
  clientIds: (update) => decode(update).clients,
  stateHash: async (parts) =>
    `fake:${[...new Set(parts.flatMap((u) => decode(u).items ?? []))].sort().join('|')}`,
};

let items = 0;

export const fakeUpdate = (client: number, text: string) =>
  encode({ clients: [client], text, items: [`${client}:${++items}`] });

function encode(value: { clients: number[]; text: string; items?: string[] }): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decode(update: Uint8Array): { clients: number[]; text: string; items?: string[] } {
  try {
    return JSON.parse(new TextDecoder().decode(update)) as {
      clients: number[];
      text: string;
      items?: string[];
    };
  } catch {
    return { clients: [], text: '', items: [] };
  }
}

export const newId = uuidv7;
