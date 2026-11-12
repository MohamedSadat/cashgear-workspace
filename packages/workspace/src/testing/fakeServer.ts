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
import { uuidv7, type Id } from '../ids';
import { Mirror } from '../mirror';
import { planOps } from '../ops';
import { compareSiblings, keyBetween } from '../order';
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
  type PageRecord,
  type WorkspaceRecord,
} from '../types';

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
  | 'assetUrl';

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

  private spaceOfPage(pageId: Id): Space | undefined {
    for (const space of this.spaces.values()) if (space.mirror.pages.has(pageId)) return space;
    return undefined;
  }

  private change(
    space: Space,
    entityType: ServerChange['entityType'],
    entityId: Id,
    kind = 'upsert',
    userId?: Id,
  ) {
    space.changes.push({ seq: ++space.seq, entityType, entityId, kind, userId });
  }

  private visible(account: Account, pageId: Id): boolean {
    return !this.hidden.has(pageId) && !this.hiddenFor.get(account.id)?.has(pageId);
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
      default:
        return null;
    }
  }

  /** A page as an account sees it: its document's head, epoch and schema, and its level. */
  private pageView(space: Space, account: Account, page: PageRecord): PageRecord {
    const doc = this.docs.get(page.id);
    return {
      ...structuredClone(page),
      docHeadSeq: doc?.rows.at(-1)?.seq ?? 0,
      docEpoch: doc?.epoch ?? 0,
      docSchemaVersion: doc?.schemaVersion ?? 1,
      ...(space.readers.has(account.id) ? { access: 'view' as const } : {}),
    };
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

  /** A permanent delete on the server (a person's, or trash retention): pages and documents go. */
  purge(pageId: Id) {
    const space = this.spaceOfPage(pageId)!;
    const ids = [pageId, ...space.mirror.descendantIds(pageId)];
    space.mirror.apply({
      workspaces: [],
      sections: [],
      pages: [],
      favourites: [],
      visits: [],
      deleteSections: [],
      deletePages: ids,
      deleteFavourites: [],
      deleteVisits: [],
      outbox: [],
    });
    for (const id of ids) {
      this.gone.add(id);
      this.docs.delete(id);
      this.change(space, 'page', id, 'delete');
    }
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

  /** The server's planner, with its fallbacks for a parent that is gone and equal order keys. */
  private async apply(space: Space, op: Operation): Promise<{ op: Operation; notice?: string }> {
    const m = space.mirror;
    let notice: string | undefined;
    if (op.type === 'page.create' || op.type === 'page.move') {
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
    const plan = await planOps([structuredClone(op)], m);
    m.apply(plan);
    for (const p of plan.pages) this.change(space, 'page', p.id);
    for (const id of plan.deletePages) {
      this.change(space, 'page', id, 'delete');
      this.gone.add(id);
      this.docs.delete(id);
    }
    for (const s of plan.sections) this.change(space, 'section', s.id);
    for (const id of plan.deleteSections) this.change(space, 'section', id, 'delete');
    for (const w of plan.workspaces) this.change(space, 'workspace', w.id);
    for (const f of plan.favourites) this.change(space, 'favourite', f.pageId);
    for (const f of plan.deleteFavourites) this.change(space, 'favourite', f.pageId, 'delete');
    return { op, notice };
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
        };
        space.mirror.load({
          workspaces: [record],
          sections: [],
          pages: [],
          favourites: [],
          visits: [],
          assets: [],
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
          const type = op.type.split('.')[0] as EntityType;
          let result: OpResult;
          if (op.type.startsWith('page.') && !this.visible(account, op.entityId)) {
            // A page the caller may not see is, to them, no page at all.
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
              const done = await this.apply(space, op);
              result = {
                opId: op.opId,
                status: 'applied',
                entityType: type,
                entity: structuredClone(this.entity(space, type, done.op)),
                ...(done.notice ? { notice: done.notice } : {}),
              };
            } catch (error) {
              if (!(error instanceof OpError)) throw error;
              result = {
                opId: op.opId,
                status: 'rejected',
                error: { code: error.code },
                entityType: type,
                entity: structuredClone(this.entity(space, type, op)),
              };
            }
          if (result.entityType === 'page' && result.entity)
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
        return this.answer('tree', {
          workspace: { ...m.workspaces.get(workspaceId)! },
          sections: m.sectionsOf(workspaceId).map((s) => ({ ...s })),
          pages: pages.map((p) => this.pageView(space, account, p)),
          favourites: [...m.favourites.values()].filter(
            (f) => f.workspaceId === workspaceId && this.visible(account, f.pageId),
          ),
          visits: [],
          cursor: space.seq,
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
