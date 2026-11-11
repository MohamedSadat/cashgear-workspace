// An in-memory server for the sync engine's tests: the operations endpoint with AppliedOps, the
// change feed, the tree, documents by sequence (no validation), Yjs client ids and assets, with
// the same tree rules as the real one (it runs the client's own planner, which the server ports).
// Faults: `offline` refuses every call; `lose` applies the next call of a kind, then loses its
// answer, as a dropped connection does.
import { uuidv7, type Id } from '../ids';
import { Mirror } from '../mirror';
import { planOps } from '../ops';
import {
  OfflineError,
  SyncHttpError,
  type Account,
  type DocCodec,
  type ServerChange,
  type SyncApi,
} from '../sync/api';
import {
  OpError,
  type EntityRecord,
  type EntityType,
  type Operation,
  type OpResult,
  type WorkspaceRecord,
} from '../types';

interface Space {
  mirror: Mirror;
  seq: number;
  changes: { seq: number; entityType: ServerChange['entityType']; entityId: Id; kind: string }[];
  applied: Map<Id, OpResult>;
  members: Set<Id>;
  yjs: Map<number, Id>;
}

type Kind = 'pushOps' | 'pushDoc' | 'changes' | 'pullDoc' | 'putBytes';

export class FakeServer {
  readonly spaces = new Map<Id, Space>();
  readonly docs = new Map<
    Id,
    { epoch: number; rows: { seq: number; updateId: Id; data: Uint8Array; userId: Id }[] }
  >();
  readonly blobs = new Map<string, Uint8Array>();
  readonly assets = new Map<Id, { workspaceId: Id; completed: boolean }>();
  offline = false;
  private readonly lost = new Set<Kind>();
  calls: string[] = [];

  /** The next call of this kind is applied, then its answer is lost. */
  lose(kind: Kind) {
    this.lost.add(kind);
  }

  private answer<T>(kind: Kind, value: T): T {
    if (this.lost.delete(kind)) throw new OfflineError('answer lost');
    return value;
  }

  private gate(name: string) {
    this.calls.push(name);
    if (this.offline) throw new OfflineError();
  }

  private space(account: Account, workspaceId: Id): Space {
    const space = this.spaces.get(workspaceId);
    if (!space || !space.members.has(account.id)) throw new SyncHttpError(404, 'not.found');
    return space;
  }

  private change(
    space: Space,
    entityType: ServerChange['entityType'],
    entityId: Id,
    kind = 'upsert',
  ) {
    space.changes.push({ seq: ++space.seq, entityType, entityId, kind });
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

  /** Adds a second person to a workspace, as an invite accepted would. */
  addMember(workspaceId: Id, accountId: Id) {
    this.spaces.get(workspaceId)!.members.add(accountId);
  }

  /** Removes someone's access to a page and its subtree, with a revoke in the feed. */
  revoke(workspaceId: Id, rootId: Id) {
    const space = this.spaces.get(workspaceId)!;
    this.hidden.add(rootId);
    for (const id of space.mirror.descendantIds(rootId)) this.hidden.add(id);
    this.change(space, 'access', rootId, 'revoke');
  }

  readonly hidden = new Set<Id>();

  api(account: Account): SyncApi {
    return {
      me: async () => {
        this.gate('me');
        return account;
      },
      listWorkspaces: async () => {
        this.gate('listWorkspaces');
        return [...this.spaces.entries()]
          .filter(([, s]) => s.members.has(account.id))
          .map(([id, s]) => s.mirror.workspaces.get(id)!)
          .map((w) => ({ ...w }));
      },
      createWorkspace: async (w) => {
        this.gate('createWorkspace');
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
          applied: new Map(),
          members: new Set([account.id]),
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
        return { ...record };
      },
      pushOps: async (workspaceId, _device, ops) => {
        this.gate('pushOps');
        const space = this.space(account, workspaceId);
        const results: OpResult[] = [];
        for (const op of ops) {
          const seen = space.applied.get(op.opId);
          if (seen) {
            results.push(seen);
            continue;
          }
          const type = op.type.split('.')[0] as EntityType;
          let result: OpResult;
          try {
            const plan = await planOps([structuredClone(op)], space.mirror);
            space.mirror.apply(plan);
            for (const p of plan.pages) this.change(space, 'page', p.id);
            for (const id of plan.deletePages) this.change(space, 'page', id, 'delete');
            for (const s of plan.sections) this.change(space, 'section', s.id);
            for (const id of plan.deleteSections) this.change(space, 'section', id, 'delete');
            for (const w of plan.workspaces) this.change(space, 'workspace', w.id);
            for (const f of plan.favourites) this.change(space, 'favourite', f.pageId);
            for (const f of plan.deleteFavourites)
              this.change(space, 'favourite', f.pageId, 'delete');
            result = {
              opId: op.opId,
              status: 'applied',
              entityType: type,
              entity: structuredClone(this.entity(space, type, op)),
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
          space.applied.set(op.opId, result);
          results.push(result);
        }
        return this.answer('pushOps', results);
      },
      changes: async (workspaceId, after, limit) => {
        this.gate('changes');
        const space = this.space(account, workspaceId);
        const rows = space.changes.filter((c) => c.seq > after).slice(0, limit);
        const m = space.mirror;
        const changes = rows.map((row): ServerChange => {
          const visible = !this.hidden.has(row.entityId);
          switch (row.entityType) {
            case 'page': {
              const page = visible ? m.pages.get(row.entityId) : undefined;
              const doc = this.docs.get(row.entityId);
              return page
                ? {
                    seq: row.seq,
                    entityType: 'page',
                    entityId: row.entityId,
                    kind: 'upsert',
                    entity: {
                      ...page,
                      docHeadSeq: doc?.rows.at(-1)?.seq ?? 0,
                      docEpoch: doc?.epoch ?? 0,
                    },
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
              return favourite
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
        return this.answer('changes', {
          changes,
          cursor: rows.at(-1)?.seq ?? after,
          more: space.changes.some((c) => c.seq > (rows.at(-1)?.seq ?? after)),
        });
      },
      tree: async (workspaceId, root) => {
        this.gate('tree');
        const space = this.space(account, workspaceId);
        const m = space.mirror;
        const under = root ? new Set([root, ...m.descendantIds(root)]) : null;
        const pages = [...m.pages.values()].filter(
          (p) =>
            p.workspaceId === workspaceId && !this.hidden.has(p.id) && (!under || under.has(p.id)),
        );
        return {
          workspace: { ...m.workspaces.get(workspaceId)! },
          sections: m.sectionsOf(workspaceId).map((s) => ({ ...s })),
          pages: pages.map((p) => ({
            ...p,
            docHeadSeq: this.docs.get(p.id)?.rows.at(-1)?.seq ?? 0,
          })),
          favourites: [...m.favourites.values()].filter((f) => f.workspaceId === workspaceId),
          visits: [],
          cursor: space.seq,
        };
      },
      pushDoc: async (pageId, request) => {
        this.gate('pushDoc');
        let doc = this.docs.get(pageId);
        if (!doc) this.docs.set(pageId, (doc = { epoch: 0, rows: [] }));
        if (request.epoch !== doc.epoch) throw new SyncHttpError(409, 'doc.epochMismatch');
        const acks = request.updates.map((u) => {
          const seen = doc!.rows.find((r) => r.updateId === u.updateId);
          if (seen) return { updateId: u.updateId, seq: seen.seq };
          const seq = (doc!.rows.at(-1)?.seq ?? 0) + 1;
          doc!.rows.push({
            seq,
            updateId: u.updateId,
            data: new Uint8Array(u.data),
            userId: account.id,
          });
          return { updateId: u.updateId, seq };
        });
        for (const [, space] of this.spaces)
          if (space.mirror.pages.has(pageId)) this.change(space, 'page', pageId);
        return this.answer('pushDoc', { acks, headSeq: doc.rows.at(-1)!.seq });
      },
      pullDoc: async (pageId, after) => {
        this.gate('pullDoc');
        const doc = this.docs.get(pageId) ?? { epoch: 0, rows: [] };
        const rows = doc.rows.filter((r) => r.seq > after);
        const head = doc.rows.at(-1)?.seq ?? 0;
        return this.answer('pullDoc', {
          epoch: doc.epoch,
          schemaVersion: 1,
          headSeq: head,
          cursor: head,
          more: false,
          snapshot: null,
          updates: rows.map((r) => ({
            seq: r.seq,
            updateId: r.updateId,
            data: new Uint8Array(r.data),
          })),
          rejected: [],
        });
      },
      fetchBytes: async (url) => {
        this.gate('fetchBytes');
        const bytes = this.blobs.get(url);
        if (!bytes) throw new SyncHttpError(404, 'not.found');
        return new Uint8Array(bytes);
      },
      yjsClients: async (workspaceId, request) => {
        this.gate('yjsClients');
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
        while (issued.length < (request.issue ?? 0)) {
          const id = 1 + Math.floor(Math.random() * 0xfffffffe);
          if (space.yjs.has(id)) continue;
          space.yjs.set(id, account.id);
          issued.push(id);
        }
        return { issued, registered, refused };
      },
      assetTicket: async (workspaceId, asset) => {
        this.gate('assetTicket');
        this.space(account, workspaceId);
        this.assets.set(asset.id, { workspaceId, completed: false });
        return { assetId: asset.id, uploadUrl: `fake://assets/${asset.id}`, headers: {} };
      },
      putBytes: async (url, _headers, bytes) => {
        this.gate('putBytes');
        this.blobs.set(url, new Uint8Array(bytes));
        this.answer('putBytes', undefined);
      },
      completeAsset: async (assetId) => {
        this.gate('completeAsset');
        const asset = this.assets.get(assetId);
        if (!asset || !this.blobs.has(`fake://assets/${assetId}`))
          throw new SyncHttpError(400, 'request.invalid');
        asset.completed = true;
      },
      assetUrl: async (assetId) => {
        this.gate('assetUrl');
        return `fake://assets/${assetId}`;
      },
    };
  }
}

/** Opaque document updates for tests: JSON naming the Yjs client ids they write as. */
export const fakeCodec: DocCodec = {
  schemaVersion: 1,
  merge: (updates) =>
    encode({
      clients: [...new Set(updates.flatMap((u) => decode(u).clients))],
      text: updates.map((u) => decode(u).text).join(''),
    }),
  clientIds: (update) => decode(update).clients,
};

export const fakeUpdate = (client: number, text: string) => encode({ clients: [client], text });

function encode(value: { clients: number[]; text: string }): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decode(update: Uint8Array): { clients: number[]; text: string } {
  try {
    return JSON.parse(new TextDecoder().decode(update)) as { clients: number[]; text: string };
  } catch {
    return { clients: [], text: '' };
  }
}

export const newId = uuidv7;
