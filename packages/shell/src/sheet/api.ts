// Workspace's workbook routes (Phase 5, docs/INTEGRATIONS.md "Workbooks as their own documents"),
// over the app's typed API client: a workbook's record, its content's signed URL, its pictures,
// its launch link for Cash Gear Sheet (Phase 9: its web app's or its desktop app's), its sheets
// and ranges, the view export, and (Phase 9) its history and an upload. Workbooks are
// not in the change feed: the app reads them by route, online. A refusal is a SyncHttpError with
// the server's code; no answer at all is the client's NetworkError (`unreachable` says which).
import type { ApiClient, Schemas } from '@cgw/api';
import { SyncHttpError, type Id } from '@cgw/workspace';

export type WorkbookAccess = 'full' | 'edit' | 'comment' | 'view';

/** A workbook as the server sends it (the caller's own level in `access`). */
export interface Workbook {
  id: Id;
  workspaceId: Id;
  name: string;
  /** The record's version (rename, trash, restore, permissions), for `If-Match`. */
  version: number;
  /** The current version of the content, or null before Sheet's first save. */
  versionId: Id | null;
  /** The content's entity tag (`"<versionId>"`), or null with no version. */
  etag: string | null;
  size: number | null;
  savedAt: string | null;
  savedBy: { id: Id; name: string } | null;
  createdBy: Id;
  createdAt: string;
  trashedAt: string | null;
  access: WorkbookAccess;
}

export interface WorkbookContent {
  readUrl: string | null;
  etag: string | null;
  versionId: Id | null;
  size: number | null;
  expiresAt: string | null;
}

export interface WorkbookPicture {
  url: string;
  versionId: Id;
  etag: string;
  madeAt: string;
  width: number;
  height: number;
}

export interface WorkbookSheet {
  name: string;
  usedRange: string | null;
  hidden: boolean;
}

export interface PermissionEntry {
  /** Phase 11: `group` too, when the list was asked for with groups. */
  principalType: 'user' | 'workspace' | 'group';
  principalId: Id;
  level: string;
  displayName?: string | null;
  email?: string | null;
  /** A group's number of people (null for a person or the workspace). */
  peopleCount?: number | null;
}

export interface WorkbookPermissions {
  restricted: boolean;
  yourLevel: string;
  entries: PermissionEntry[];
}

/** One kept version of a workbook (Phase 9: its history, the newest 10), newest first. */
export interface WorkbookVersion {
  id: Id;
  size: number;
  sha256: string;
  savedAt: string;
  savedBy: { id: Id; name: string } | null;
  /** The workbook's current version. */
  current: boolean;
}

/** Where "Open in Cash Gear Sheet" goes: Sheet's web app, or its desktop app by deep link. */
export type LaunchTarget = 'web' | 'desktop';

/** The xlsx content type, as Sheet's own save sends it. */
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type VersionDto = Schemas['WorkbookVersionDto'];

const versionOf = (dto: VersionDto): WorkbookVersion => ({
  id: dto.id,
  size: Number(dto.size),
  sha256: dto.sha256,
  savedAt: dto.savedAt,
  savedBy: dto.savedBy ? { id: dto.savedBy.id, name: dto.savedBy.name } : null,
  current: !!dto.current,
});

/** May change the workbook's content and pictures (Sheet's edit session, `PUT …/previews`). */
export const canEditWorkbook = (access: string | null | undefined) =>
  access === 'full' || access === 'edit';

const num = (value: number | string | null | undefined) =>
  value === null || value === undefined ? null : Number(value);

const accessOf = (value: string): WorkbookAccess =>
  value === 'full' || value === 'edit' || value === 'comment' ? value : 'view';

type Answer<T> = { data?: T; error?: unknown; response: Response };

/** The answer's data, or a SyncHttpError with the server's code. */
async function data<T>(request: Promise<Answer<T>>): Promise<T> {
  const result = await request;
  if (result.response.ok) return result.data as T;
  const body = result.error as { code?: string; title?: string } | undefined;
  throw new SyncHttpError(
    result.response.status,
    body?.code ?? 'server.error',
    body?.title ?? result.response.statusText,
  );
}

interface WorkbookDto {
  id: string;
  workspaceId: string;
  name: string;
  version: number | string;
  versionId: string | null;
  etag: string | null;
  size: number | string | null;
  savedAt: string | null;
  savedBy: { id: string; name: string } | null;
  createdBy: string;
  createdAt: string;
  trashedAt: string | null;
  access: string;
}

export function toWorkbook(dto: WorkbookDto): Workbook {
  return {
    id: dto.id,
    workspaceId: dto.workspaceId,
    name: dto.name,
    version: Number(dto.version),
    versionId: dto.versionId ?? null,
    etag: dto.etag ?? null,
    size: num(dto.size),
    savedAt: dto.savedAt ?? null,
    savedBy: dto.savedBy ? { id: dto.savedBy.id, name: dto.savedBy.name } : null,
    createdBy: dto.createdBy,
    createdAt: dto.createdAt,
    trashedAt: dto.trashedAt ?? null,
    access: accessOf(dto.access),
  };
}

/** The server's code for a refusal, `offline` when there was no answer. */
export function failureCode(error: unknown): string {
  if (error instanceof SyncHttpError) return error.code;
  const named = error as { name?: string } | null;
  if (
    error instanceof TypeError ||
    named?.name === 'NetworkError' ||
    named?.name === 'OfflineError'
  )
    return 'offline';
  return 'server.error';
}

export const statusOf = (error: unknown) => (error instanceof SyncHttpError ? error.status : 0);

/** The workbook routes over the app's API client. */
export function workbookApi(api: ApiClient) {
  const path = (workbookId: Id) => ({ params: { path: { workbookId } } });
  return {
    list: async (workspaceId: Id, options: { q?: string; trashed?: boolean } = {}) => {
      const query: { q?: string; trashed?: boolean } = {};
      if (options.q) query.q = options.q;
      if (options.trashed) query.trashed = true;
      const answer = await data(
        api.GET('/api/v1/workspaces/{workspaceId}/workbooks', {
          params: { path: { workspaceId }, query },
        }),
      );
      return answer.workbooks.map(toWorkbook);
    },
    create: async (workspaceId: Id, name: string, id?: Id) =>
      toWorkbook(
        await data(
          api.POST('/api/v1/workspaces/{workspaceId}/workbooks', {
            params: { path: { workspaceId } },
            body: { id: id ?? null, name },
          }),
        ),
      ),
    get: async (workbookId: Id) =>
      toWorkbook(await data(api.GET('/api/v1/workbooks/{workbookId}', path(workbookId)))),
    update: async (
      workbookId: Id,
      change: { name?: string; trashed?: boolean },
      version?: number,
    ) =>
      toWorkbook(
        await data(
          api.PATCH('/api/v1/workbooks/{workbookId}', {
            params: { path: { workbookId } },
            body: { name: change.name ?? null, trashed: change.trashed ?? null },
            ...(version !== undefined ? { headers: { 'If-Match': `"${version}"` } } : {}),
          }),
        ),
      ),
    content: async (workbookId: Id): Promise<WorkbookContent> => {
      const answer = await data(
        api.GET('/api/v1/workbooks/{workbookId}/content', path(workbookId)),
      );
      return {
        readUrl: answer.readUrl ?? null,
        etag: answer.etag ?? null,
        versionId: answer.versionId ?? null,
        size: num(answer.size),
        expiresAt: answer.expiresAt ?? null,
      };
    },
    /** The view's newest picture (of whichever version), or null when there is none. */
    picture: async (workbookId: Id, viewHash: string): Promise<WorkbookPicture | null> => {
      try {
        const answer = await data(
          api.GET('/api/v1/workbooks/{workbookId}/previews/{viewHash}', {
            params: { path: { workbookId, viewHash } },
          }),
        );
        return {
          url: answer.url,
          versionId: answer.versionId,
          etag: answer.etag,
          madeAt: answer.madeAt,
          width: Number(answer.width),
          height: Number(answer.height),
        };
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw error;
      }
    },
    /** Sends a picture of the view as drawn from the version `versionId` (editors only). */
    putPicture: async (workbookId: Id, viewHash: string, png: Uint8Array, versionId: Id) => {
      await data(
        api.PUT('/api/v1/workbooks/{workbookId}/previews/{viewHash}', {
          params: { path: { workbookId, viewHash } },
          body: png as unknown as string,
          bodySerializer: (body: unknown) => body as BodyInit,
          headers: { 'Content-Type': 'image/png', 'X-Workbook-Version': versionId },
        }),
      );
    },
    /**
     * A launch link for Cash Gear Sheet, two minutes, one use: `{Sheet}/cloud#launch=<ticket>` for
     * its web app; with `desktop` (Phase 9, Track S6) `cashgear-sheet://workspace/launch#ticket=…`
     * for its desktop app.
     */
    launch: async (workbookId: Id, target: LaunchTarget = 'web') =>
      (
        await data(
          target === 'web'
            ? api.POST('/api/v1/workbooks/{workbookId}/launch', {
                params: { path: { workbookId } },
              })
            : api.POST('/api/v1/workbooks/{workbookId}/launch', {
                params: { path: { workbookId } },
                body: { target },
              }),
        )
      ).url,
    // ---- Phase 9: a workbook's history ----------------------------------------------------------
    /** Its kept versions, newest first, each with when and by whom it was saved. */
    versions: async (workbookId: Id): Promise<WorkbookVersion[]> =>
      (
        await data(api.GET('/api/v1/workbooks/{workbookId}/versions', path(workbookId)))
      ).versions.map(versionOf),
    /** One version's bytes by a short signed URL (read access), for the embed. */
    versionContent: async (workbookId: Id, versionId: Id): Promise<WorkbookContent> => {
      const answer = await data(
        api.GET('/api/v1/workbooks/{workbookId}/versions/{versionId}/content', {
          params: { path: { workbookId, versionId } },
        }),
      );
      return {
        readUrl: answer.readUrl ?? null,
        etag: answer.etag ?? null,
        versionId: answer.versionId ?? null,
        size: num(answer.size),
        expiresAt: answer.expiresAt ?? null,
      };
    },
    /**
     * An older version copied as the newest, saved by the restorer now (`edit` or above). `etag`,
     * the current content's, makes it refuse (`version.conflict`) when someone saved meanwhile.
     */
    restoreVersion: async (workbookId: Id, versionId: Id, etag?: string | null) =>
      data(
        api.POST('/api/v1/workbooks/{workbookId}/versions/{versionId}/restore', {
          params: { path: { workbookId, versionId } },
          ...(etag ? { headers: { 'If-Match': etag } } : {}),
        }),
      ),
    /**
     * A new version from xlsx bytes (`edit`): the first with `If-None-Match: *` (`etag` null), a
     * later one with `If-Match` on the current content's entity tag, as Sheet's own save.
     */
    uploadVersion: async (workbookId: Id, bytes: Uint8Array, etag: string | null = null) =>
      data(
        api.POST('/api/v1/workbooks/{workbookId}/versions', {
          params: { path: { workbookId } },
          body: bytes as unknown as string,
          bodySerializer: (body: unknown) => body as BodyInit,
          headers: {
            'Content-Type': XLSX_TYPE,
            ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }),
          },
        }),
      ),
    sheets: async (workbookId: Id): Promise<WorkbookSheet[]> =>
      (await data(api.GET('/api/v1/workbooks/{workbookId}/sheets', path(workbookId)))).sheets.map(
        (sheet) => ({
          name: sheet.name,
          usedRange: sheet.usedRange ?? null,
          hidden: !!sheet.hidden,
        }),
      ),
    /** A range as CSV in canonical text (the database's CSV import reads it). */
    range: async (workbookId: Id, sheet: string | null, range: string | null) => {
      const query: { sheet?: string; range?: string } = {};
      if (sheet) query.sheet = sheet;
      if (range) query.range = range;
      const answer = await data(
        api.GET('/api/v1/workbooks/{workbookId}/range', {
          params: { path: { workbookId }, query },
        }),
      );
      return { sheet: answer.sheet, range: answer.range ?? null, csv: answer.csv };
    },
    /**
     * The access list. Phase 11: with `groups`, the groups' rows too (`?principals=group`);
     * without, as 0.10.0 read it.
     */
    permissions: async (workbookId: Id, groups = true): Promise<WorkbookPermissions> => {
      const answer = await data(
        api.GET('/api/v1/workbooks/{workbookId}/permissions', {
          params: {
            path: { workbookId },
            ...(groups ? { query: { principals: ['group'] } } : {}),
          },
        }),
      );
      return {
        restricted: answer.restricted,
        yourLevel: answer.yourLevel,
        entries: answer.entries.map((e) => ({
          principalType:
            e.principalType === 'workspace' || e.principalType === 'group'
              ? e.principalType
              : 'user',
          principalId: e.principalId,
          level: e.level,
          displayName: e.displayName ?? null,
          email: e.email ?? null,
          peopleCount: num(e.peopleCount),
        })),
      };
    },
    /**
     * Saves the list. Phase 11: with `groups` (`principals: ["group"]`), its group entries replace
     * the stored group rows; without, the server keeps them all.
     */
    setPermissions: async (
      workbookId: Id,
      body: {
        restricted: boolean;
        entries: { principalType: string; principalId: Id; level: string }[];
      },
      groups = true,
    ) => {
      await data(
        api.PUT('/api/v1/workbooks/{workbookId}/permissions', {
          params: { path: { workbookId } },
          body: groups ? { ...body, principals: ['group'] } : body,
        }),
      );
    },
    /** A new workbook holding a database view's rows; the server writes its version 1. */
    exportView: async (databaseId: Id, viewId: Id | null, name: string) =>
      toWorkbook(
        await data(
          api.POST('/api/v1/databases/{databaseId}/workbooks', {
            params: { path: { databaseId } },
            body: { viewId, name },
          }),
        ),
      ),
  };
}

export type WorkbookApi = ReturnType<typeof workbookApi>;
