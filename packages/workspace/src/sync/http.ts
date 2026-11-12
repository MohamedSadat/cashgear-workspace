// The SyncApi over HTTP, through @cgw/api (typed from the server's OpenAPI document). Bytes travel
// as base64 in JSON in Phase 2 (SYNC_DESIGN.md: a binary framing waits for Phase 6). Problems
// become SyncHttpError with the server's stable code; an unreachable server, OfflineError.
import {
  ApiError,
  NetworkError,
  getSigned,
  putSigned,
  type ApiClient,
  type Schemas,
} from '@cgw/api';
import type { Id } from '../ids';
import type {
  EntityRecord,
  EntityType,
  FavouriteRecord,
  OpResult,
  PageRecord,
  SectionRecord,
  VisitRecord,
  WorkspaceRecord,
} from '../types';
import {
  OfflineError,
  SyncHttpError,
  type Account,
  type ChangesPage,
  type DocPull,
  type ServerChange,
  type ServerTree,
  type SyncApi,
} from './api';

const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const num = (value: number | string) => (typeof value === 'number' ? value : Number(value));

/** The data of an answer, or its problem as SyncHttpError; an unreachable server as OfflineError. */
async function call<T>(
  request: () => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  let result;
  try {
    result = await request();
  } catch (error) {
    if (error instanceof NetworkError || error instanceof TypeError) throw new OfflineError(error);
    if (error instanceof ApiError) throw new SyncHttpError(error.status, error.code, error.title);
    throw error;
  }
  if (result.response.ok) return result.data as T;
  let code = result.response.status === 401 ? 'auth.required' : 'server.error';
  let title = result.response.statusText;
  const body = result.error as { code?: string; title?: string } | undefined;
  if (body?.code) code = body.code;
  if (body?.title) title = body.title;
  throw new SyncHttpError(result.response.status, code, title);
}

type Page = Schemas['PageDto'];
type Workspace = Schemas['WorkspaceDto'];
type Entity = Schemas['EntityDto'];

export const pageRecord = (p: Page): PageRecord => ({
  id: p.id,
  workspaceId: p.workspaceId,
  sectionId: p.sectionId,
  parentPageId: p.parentPageId ?? null,
  orderKey: p.orderKey,
  kind: 'page',
  title: p.title,
  icon: p.icon ?? null,
  coverAssetId: p.coverAssetId ?? null,
  isTemplate: p.isTemplate,
  templateOfPageId: p.templateOfPageId ?? null,
  version: num(p.version),
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  trashedAt: p.trashedAt ?? null,
  trashRootId: p.trashRootId ?? null,
  access: p.access as PageRecord['access'],
  restricted: p.restricted,
  docHeadSeq: num(p.docHeadSeq),
  docEpoch: num(p.docEpoch),
  docSchemaVersion: num(p.docSchemaVersion),
});

export const workspaceRecord = (w: Workspace): WorkspaceRecord => ({
  id: w.id,
  name: w.name,
  icon: w.icon ?? null,
  createdAt: w.createdAt,
  version: num(w.version),
  localOnly: false,
  deletedAt: w.deletedAt ?? null,
  role: w.role as WorkspaceRecord['role'],
});

const sectionRecord = (s: Schemas['SectionDto']): SectionRecord => ({
  id: s.id,
  workspaceId: s.workspaceId,
  name: s.name,
  orderKey: s.orderKey,
  visibility: s.visibility === 'private' ? 'private' : 'workspace',
  version: num(s.version),
  createdAt: s.createdAt,
});

const favouriteRecord = (f: Schemas['FavouriteDto']): FavouriteRecord => ({
  workspaceId: f.workspaceId,
  pageId: f.pageId,
  orderKey: f.orderKey,
});

const visitRecord = (v: Schemas['VisitDto']): VisitRecord => ({
  workspaceId: v.workspaceId,
  pageId: v.pageId,
  lastVisitedAt: v.lastVisitedAt,
});

function entityRecord(
  type: string | null | undefined,
  entity: Entity | null | undefined,
): EntityRecord | null {
  if (!entity) return null;
  switch (type) {
    case 'workspace':
      return entity.workspace ? workspaceRecord(entity.workspace) : null;
    case 'section':
      return entity.section ? sectionRecord(entity.section) : null;
    case 'page':
      return entity.page ? pageRecord(entity.page) : null;
    case 'favourite':
      return entity.favourite ? favouriteRecord(entity.favourite) : null;
    case 'visit':
      return entity.visit ? visitRecord(entity.visit) : null;
    default:
      return null;
  }
}

export function httpSyncApi(api: ApiClient): SyncApi {
  return {
    // Asked at every start: 200 signed in or not, so a signed-out start logs no error.
    async me(): Promise<Account | null> {
      const { account: me } = await call(() => api.GET('/api/v1/account/session'));
      if (!me) return null;
      return {
        id: me.id,
        email: me.email,
        displayName: me.displayName,
        deviceId: me.deviceId ?? null,
      };
    },

    async listWorkspaces() {
      return (await call(() => api.GET('/api/v1/workspaces'))).map(workspaceRecord);
    },

    async createWorkspace(workspace) {
      return workspaceRecord(await call(() => api.POST('/api/v1/workspaces', { body: workspace })));
    },

    async pushOps(workspaceId, deviceId, ops) {
      const answer = await call(() =>
        api.POST('/api/v1/workspaces/{workspaceId}/ops', {
          params: { path: { workspaceId } },
          body: {
            deviceId,
            ops: ops.map((op) => ({
              ...op,
              payload: op.payload as never,
              baseVersion: op.baseVersion,
            })),
          },
        }),
      );
      return answer.results.map((r): OpResult => ({
        opId: r.opId,
        status: r.status === 'applied' ? 'applied' : 'rejected',
        error: r.error ? { code: r.error.code, title: r.error.title } : undefined,
        entityType: (r.entityType ?? undefined) as EntityType | undefined,
        entity: r.entityType ? entityRecord(r.entityType, r.entity) : undefined,
        notice: r.notice ?? undefined,
      }));
    },

    async changes(workspaceId, after, limit): Promise<ChangesPage> {
      const page = await call(() =>
        api.GET('/api/v1/workspaces/{workspaceId}/changes', {
          params: { path: { workspaceId }, query: { after, limit } },
        }),
      );
      return {
        cursor: num(page.cursor),
        more: page.more,
        changes: page.changes.map(
          (c) =>
            ({
              seq: num(c.seq),
              entityType: c.entityType,
              entityId: c.entityId,
              kind: c.kind,
              entity: entityRecord(c.entityType, c.entity),
            }) as ServerChange,
        ),
      };
    },

    async tree(workspaceId, root): Promise<ServerTree> {
      const tree = await call(() =>
        api.GET('/api/v1/workspaces/{workspaceId}/tree', {
          params: { path: { workspaceId }, query: root ? { root } : {} },
        }),
      );
      return {
        workspace: workspaceRecord(tree.workspace),
        sections: tree.sections.map(sectionRecord),
        pages: tree.pages.map(pageRecord),
        favourites: tree.favourites.map(favouriteRecord),
        visits: tree.visits.map(visitRecord),
        cursor: num(tree.cursor),
      };
    },

    async pushDoc(pageId, request) {
      const answer = await call(() =>
        api.POST('/api/v1/pages/{pageId}/doc/updates', {
          params: { path: { pageId } },
          body: {
            epoch: request.epoch,
            clientSchemaVersion: request.clientSchemaVersion,
            updates: request.updates.map((u) => ({ updateId: u.updateId, data: toBase64(u.data) })),
          },
        }),
      );
      return {
        acks: answer.acks.map((a) => ({ updateId: a.updateId, seq: num(a.seq) })),
        headSeq: num(answer.headSeq),
      };
    },

    async pullDoc(pageId, after): Promise<DocPull> {
      const pull = await call(() =>
        api.GET('/api/v1/pages/{pageId}/doc', { params: { path: { pageId }, query: { after } } }),
      );
      return {
        epoch: num(pull.epoch),
        schemaVersion: num(pull.schemaVersion),
        headSeq: num(pull.headSeq),
        cursor: num(pull.cursor),
        more: pull.more,
        snapshot: pull.snapshot
          ? { upToSeq: num(pull.snapshot.upToSeq), url: pull.snapshot.url }
          : null,
        updates: pull.updates.map((u) => ({
          seq: num(u.seq),
          updateId: u.updateId,
          data: fromBase64(u.data),
        })),
        rejected: pull.rejected,
      };
    },

    async fetchBytes(url) {
      let response: Response;
      try {
        response = await getSigned(url);
      } catch (error) {
        throw new OfflineError(error);
      }
      if (!response.ok)
        throw new SyncHttpError(
          response.status,
          response.status === 403 ? 'access.denied' : 'not.found',
        );
      return new Uint8Array(await response.arrayBuffer());
    },

    async yjsClients(workspaceId, request) {
      const answer = await call(() =>
        api.POST('/api/v1/workspaces/{workspaceId}/yjs-clients', {
          params: { path: { workspaceId } },
          body: { issue: request.issue ?? 0, register: request.register ?? [] },
        }),
      );
      return {
        issued: answer.issued.map(num),
        registered: answer.registered.map(num),
        refused: answer.refused.map(num),
      };
    },

    async assetTicket(workspaceId: Id, asset) {
      const ticket = await call(() =>
        api.POST('/api/v1/workspaces/{workspaceId}/assets', {
          params: { path: { workspaceId } },
          body: asset,
        }),
      );
      return { assetId: ticket.assetId, uploadUrl: ticket.uploadUrl, headers: ticket.headers };
    },

    async putBytes(url, headers, bytes) {
      let response: Response;
      try {
        response = await putSigned(url, headers, bytes);
      } catch (error) {
        throw new OfflineError(error);
      }
      if (!response.ok) throw new SyncHttpError(response.status, 'asset.uploadFailed');
    },

    async completeAsset(assetId) {
      await call(() =>
        api.POST('/api/v1/assets/{assetId}/complete', { params: { path: { assetId } } }),
      );
    },

    async assetUrl(assetId) {
      return (
        await call(() => api.GET('/api/v1/assets/{assetId}/url', { params: { path: { assetId } } }))
      ).url;
    },
  };
}
