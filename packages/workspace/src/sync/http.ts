// The SyncApi over HTTP, through @cgw/api (typed from the server's OpenAPI document). Bytes travel
// as base64 in JSON in Phase 2 (SYNC_DESIGN.md: a binary framing waits for Phase 6). Problems
// become SyncHttpError with the server's stable code (and `Retry-After` on a 429 or 503, which the
// loop waits out); an unreachable server, OfflineError.
import {
  ApiError,
  NetworkError,
  getSigned,
  putSigned,
  type ApiClient,
  type Schemas,
} from '@cgw/api';
import type {
  CellValue,
  DatabaseRecord,
  GroupCount,
  PropertyDef,
  PropertyId,
  Value,
  ViewConfig,
  ViewRecord,
  ViewType,
} from '../db/types';
import type { Id } from '../ids';
import type {
  EntityRecord,
  EntityType,
  FavouriteRecord,
  OpResult,
  PageKind,
  PageRecord,
  RowRecord,
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
  type QueryAnswer,
  type RowsPage,
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

/** `Retry-After` in milliseconds: delay-seconds or an HTTP date (RFC 9110); undefined if absent. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

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
  const status = result.response.status;
  let code = status === 401 ? 'auth.required' : status === 429 ? 'limit.rate' : 'server.error';
  let title = result.response.statusText;
  const body = result.error as { code?: string; title?: string } | undefined;
  if (body?.code) code = body.code;
  if (body?.title) title = body.title;
  const wait =
    status === 429 || status === 503
      ? retryAfterMs(result.response.headers.get('Retry-After'))
      : undefined;
  throw new SyncHttpError(status, code, title, wait);
}

type Pull = Schemas['PullResponse'];

const docPull = (pull: Pull): DocPull => ({
  epoch: num(pull.epoch),
  schemaVersion: num(pull.schemaVersion),
  headSeq: num(pull.headSeq),
  cursor: num(pull.cursor),
  more: pull.more,
  snapshot: pull.snapshot ? { upToSeq: num(pull.snapshot.upToSeq), url: pull.snapshot.url } : null,
  updates: pull.updates.map((u) => ({
    seq: num(u.seq),
    updateId: u.updateId,
    data: fromBase64(u.data),
  })),
  rejected: pull.rejected,
});

/**
 * The two Phase 3 routes (contracts §2), typed to the contract until the generated schema holds
 * them: `GET /pages/{pageId}/doc/state-hash` and `POST /pages/{pageId}/doc/repair`.
 */
interface StateHashAnswer {
  epoch: number | string;
  upToSeq: number | string;
  hash: string | null;
}
interface RepairAnswer {
  ack: { updateId: Id; seq: number | string } | null;
  pull: Pull;
}
type Answer<T> = Promise<{ data?: T; error?: unknown; response: Response }>;
interface Phase3Routes {
  GET(
    path: '/api/v1/pages/{pageId}/doc/state-hash',
    init: { params: { path: { pageId: Id } } },
  ): Answer<StateHashAnswer>;
  POST(
    path: '/api/v1/pages/{pageId}/doc/repair',
    init: {
      params: { path: { pageId: Id } };
      body: {
        epoch: number;
        clientSchemaVersion: number;
        update: { updateId: Id; data: string } | null;
      };
    },
  ): Answer<RepairAnswer>;
}

/**
 * Phase 4's records (contract section 4), from the generated schema: their JSON fields
 * (properties, a view's config, a row's values, versions and computed results) arrive as objects
 * the schema types as `unknown`, read here as the contract's shapes.
 */
type DatabaseDto = Schemas['DatabaseDto'];
type ViewDto = Schemas['ViewDto'];
type RowDto = Schemas['RowDto'];

type Page = Schemas['PageDto'];
type Workspace = Schemas['WorkspaceDto'];
type Entity = Schemas['EntityDto'];

const KINDS: readonly PageKind[] = ['page', 'database', 'row'];

export const pageRecord = (p: Page): PageRecord => ({
  id: p.id,
  workspaceId: p.workspaceId,
  sectionId: p.sectionId,
  parentPageId: p.parentPageId ?? null,
  orderKey: p.orderKey,
  // A kind this build does not know is drawn as a page (never dropped).
  kind: KINDS.includes(p.kind as PageKind) ? (p.kind as PageKind) : 'page',
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

export const databaseRecord = (d: DatabaseDto): DatabaseRecord => ({
  id: d.id,
  workspaceId: d.workspaceId,
  properties: (d.properties as PropertyDef[] | null) ?? [],
  version: num(d.version),
  rowCount: num(d.rowCount),
  createdAt: d.createdAt,
});

const VIEW_TYPES: readonly ViewType[] = ['table', 'board', 'list', 'calendar', 'gallery'];

export const viewRecord = (v: ViewDto): ViewRecord => ({
  id: v.id,
  workspaceId: v.workspaceId,
  databaseId: v.databaseId,
  name: v.name,
  // A type this build does not know is drawn as a table (never dropped).
  type: VIEW_TYPES.includes(v.type as ViewType) ? (v.type as ViewType) : 'table',
  orderKey: v.orderKey,
  config: v.config as ViewConfig,
  version: num(v.version),
  createdAt: v.createdAt,
});

export const rowRecord = (r: RowDto): RowRecord => ({
  ...pageRecord(r),
  kind: 'row',
  databaseId: r.databaseId,
  values: (r.values as Record<PropertyId, Value> | null) ?? {},
  versions: Object.fromEntries(
    Object.entries((r.versions as Record<PropertyId, number | string> | null) ?? {}).map(
      ([k, v]) => [k, num(v)],
    ),
  ),
  computed: (r.computed as Record<PropertyId, CellValue> | null) ?? {},
  computedVersion: r.computedVersion === null ? null : num(r.computedVersion),
  createdBy: r.createdBy ?? null,
  updatedBy: r.updatedBy ?? null,
});

function entityRecord(
  type: string | null | undefined,
  dto: Entity | null | undefined,
): EntityRecord | null {
  if (!dto) return null;
  const entity = dto;
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
    case 'database':
      return entity.database ? databaseRecord(entity.database) : null;
    case 'view':
      return entity.view ? viewRecord(entity.view) : null;
    case 'row':
      return entity.row ? rowRecord(entity.row) : null;
    default:
      return null;
  }
}

const groupCounts = (groups: Schemas['QueryResponseDto']['groups']): GroupCount[] | null =>
  groups ? groups.map((g) => ({ key: g.key, count: num(g.count) })) : null;

export function httpSyncApi(api: ApiClient): SyncApi {
  const phase3 = api as unknown as Phase3Routes;
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
        // An older server's tree has neither.
        databases: ((tree.databases as DatabaseDto[] | undefined) ?? []).map(databaseRecord),
        views: ((tree.views as ViewDto[] | undefined) ?? []).map(viewRecord),
      };
    },

    async rows(databaseId, after, limit): Promise<RowsPage> {
      const page = await call(() =>
        api.GET('/api/v1/databases/{databaseId}/rows', {
          params: { path: { databaseId }, query: after ? { after, limit } : { limit } },
        }),
      );
      return { rows: page.rows.map(rowRecord), next: page.next ?? null, total: num(page.total) };
    },

    async query(databaseId, request): Promise<QueryAnswer> {
      const answer = await call(() =>
        api.POST('/api/v1/databases/{databaseId}/query', {
          params: { path: { databaseId } },
          body: request,
        }),
      );
      return {
        rows: answer.rows.map(rowRecord),
        groups: groupCounts(answer.groups),
        total: num(answer.total),
        next: answer.next ?? null,
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
      return docPull(
        await call(() =>
          api.GET('/api/v1/pages/{pageId}/doc', { params: { path: { pageId }, query: { after } } }),
        ),
      );
    },

    async docStateHash(pageId) {
      const answer = await call(() =>
        phase3.GET('/api/v1/pages/{pageId}/doc/state-hash', { params: { path: { pageId } } }),
      );
      return { epoch: num(answer.epoch), upToSeq: num(answer.upToSeq), hash: answer.hash ?? null };
    },

    async repairDoc(pageId, request) {
      const answer = await call(() =>
        phase3.POST('/api/v1/pages/{pageId}/doc/repair', {
          params: { path: { pageId } },
          body: {
            epoch: request.epoch,
            clientSchemaVersion: request.clientSchemaVersion,
            update: request.update
              ? { updateId: request.update.updateId, data: toBase64(request.update.data) }
              : null,
          },
        }),
      );
      return {
        ack: answer.ack ? { updateId: answer.ack.updateId, seq: num(answer.ack.seq) } : null,
        pull: docPull(answer.pull),
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
