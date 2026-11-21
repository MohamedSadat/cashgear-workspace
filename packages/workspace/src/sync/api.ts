// What the sync engine needs from the server (SYNC_DESIGN.md, Cloud sync), as plain records.
// `http.ts` implements it over @cgw/api; tests implement it in memory (testing/fakeServer.ts).
import type {
  DatabaseRecord,
  DateWindow,
  FilterGroup,
  GroupCount,
  GroupRule,
  QueryContext,
  SortRule,
  ViewRecord,
} from '../db/types';
import type { Id } from '../ids';
import type {
  FavouriteRecord,
  Operation,
  OpResult,
  PageRecord,
  RowRecord,
  SectionRecord,
  VisitRecord,
  WorkspaceRecord,
} from '../types';

/**
 * Whether the server refuses an operation because a create before it in the same push was refused
 * (SYNC_DESIGN.md, Push): it is on that entity, or names it as its parent page, section or
 * database. The server answers such an operation `not.found`, with no entity, and keeps nothing of
 * it: sent again, it is decided afresh.
 */
export function dependsOnCreate(op: Operation, refused: ReadonlySet<Id>): boolean {
  if (refused.has(op.entityId)) return true;
  const payload = op.payload as unknown;
  if (!payload || typeof payload !== 'object') return false;
  return (['parentPageId', 'sectionId', 'databaseId'] as const).some((name) => {
    const value = (payload as Record<string, unknown>)[name];
    return typeof value === 'string' && refused.has(value);
  });
}

export interface Account {
  id: Id;
  email: string;
  displayName: string;
  deviceId: Id | null;
}

export type ServerChange =
  | {
      seq: number;
      entityType: 'workspace';
      entityId: Id;
      kind: 'upsert' | 'delete';
      entity: WorkspaceRecord | null;
    }
  | {
      seq: number;
      entityType: 'section';
      entityId: Id;
      kind: 'upsert' | 'delete';
      entity: SectionRecord | null;
    }
  | {
      seq: number;
      entityType: 'page';
      entityId: Id;
      kind: 'upsert' | 'delete';
      entity: PageRecord | null;
    }
  | {
      seq: number;
      entityType: 'favourite';
      entityId: Id;
      kind: 'upsert' | 'delete';
      entity: FavouriteRecord | null;
    }
  | {
      seq: number;
      entityType: 'visit';
      entityId: Id;
      kind: 'upsert' | 'delete';
      entity: VisitRecord | null;
    }
  | { seq: number; entityType: 'member'; entityId: Id; kind: 'upsert' | 'delete'; entity: null }
  /** A grant or revoke naming the root of what changed: the client refetches it (scoped resync). */
  | { seq: number; entityType: 'access'; entityId: Id; kind: 'grant' | 'revoke'; entity: null }
  // Phase 4. A database's delete comes with its page's, which removes it with all it holds.
  | {
      seq: number;
      entityType: 'database';
      entityId: Id;
      kind: 'upsert' | 'delete';
      entity: DatabaseRecord | null;
    }
  | {
      seq: number;
      entityType: 'view';
      entityId: Id;
      kind: 'upsert' | 'delete';
      entity: ViewRecord | null;
    }
  /** Every change to a row (its values, title, trash, order, its document's head). */
  | {
      seq: number;
      entityType: 'row';
      entityId: Id;
      kind: 'upsert' | 'delete';
      entity: RowRecord | null;
    }
  // Phase 6. Never stored: an open comments list reads the page's threads again; the inbox, the
  // person's notifications.
  /** A page's comments changed (`entityId` is the page). */
  | { seq: number; entityType: 'comments'; entityId: Id; kind: 'upsert' | 'delete'; entity: null }
  /** One of this person's notifications was made or read (`entityId` is the notification). */
  | {
      seq: number;
      entityType: 'notification';
      entityId: Id;
      kind: 'upsert' | 'delete';
      entity: null;
    }
  /** Phase 13: a plugin added, updated, switched (`upsert`) or removed (`delete`); never stored. */
  | { seq: number; entityType: 'plugin'; entityId: Id; kind: 'upsert' | 'delete'; entity: null };

export interface ChangesPage {
  changes: ServerChange[];
  cursor: number;
  more: boolean;
}

export interface ServerTree {
  workspace: WorkspaceRecord;
  sections: SectionRecord[];
  /** Pages and databases' pages; never rows. */
  pages: PageRecord[];
  favourites: FavouriteRecord[];
  visits: VisitRecord[];
  cursor: number;
  /** Phase 4: the databases (and their views) whose page is in `pages`. */
  databases: DatabaseRecord[];
  views: ViewRecord[];
}

/** A page of a database's rows by row id, trashed rows and templates included (a full fetch). */
export interface RowsPage {
  rows: RowRecord[];
  /** The next `after`, or null when every row has come. */
  next: Id | null;
  /** Every row of the database. */
  total: number;
}

/**
 * The server's query of a database (contract section 4): the view's filter, sorts and group unless
 * given here; templates and trashed rows left out.
 */
export interface QueryRequest {
  viewId?: Id | null;
  filter?: FilterGroup | null;
  sorts?: SortRule[];
  group?: GroupRule | null;
  /** Pages within one group of a grouped query. */
  groupKey?: string | null;
  search?: string;
  /** Only the rows whose dates meet these days (Phase 9; `DateWindow`, the same rule). */
  window?: DateWindow | null;
  context: QueryContext;
  /** The `next` of the previous page (opaque), or null for the first. */
  after?: string | null;
  /** 1 to 500; 100 when absent. */
  limit?: number;
}

export interface QueryAnswer {
  rows: RowRecord[];
  /** Every group's count over the filtered rows; null when the query has no group. */
  groups: GroupCount[] | null;
  /** The filtered count (in the group, with `groupKey`). */
  total: number;
  next: string | null;
}

export interface DocPushRequest {
  epoch: number;
  clientSchemaVersion: number;
  updates: { updateId: Id; data: Uint8Array }[];
}

export interface DocPull {
  epoch: number;
  schemaVersion: number;
  headSeq: number;
  /** The next `after`. */
  cursor: number;
  more: boolean;
  snapshot: { upToSeq: number; url: string } | null;
  updates: { seq: number; updateId: Id; data: Uint8Array }[];
  /** This account's own updates the server refused. */
  rejected: Id[];
}

/**
 * Phase 12, the batch pull of documents (`POST /workspaces/{id}/docs/pull`): one page of a request
 * as answered, in the request's order. `pull` is exactly what `pullDoc` with the same `after`
 * answers; without it, `status` and `code` are what that route would have refused the page with
 * (403, 404, 410, ...), or `0` and `deferred`: not read in this answer (its size cap), ask again.
 */
export type DocsPullItem =
  | { pageId: Id; status: 200; pull: DocPull; code?: undefined }
  | { pageId: Id; status: number; code: string; pull?: undefined };

/** Pages a batch pull asks for at most (and at least one). */
export const DOCS_PULL_PAGES = 100;

/** The server's state hash of a page's document at its validated head (the repair check). */
export interface DocStateHash {
  epoch: number;
  /** The validated head the hash is for. */
  upToSeq: number;
  /** Null until the worker has computed it for the current head. */
  hash: string | null;
}

export interface DocRepairRequest {
  epoch: number;
  clientSchemaVersion: number;
  /** The device's full state, when the account may edit the page; null for a reader. */
  update: { updateId: Id; data: Uint8Array } | null;
}

export interface DocRepairAnswer {
  ack: { updateId: Id; seq: number } | null;
  /** The page from the start, as `pullDoc(pageId, 0)` answers. */
  pull: DocPull;
}

export interface AssetTicket {
  assetId: Id;
  uploadUrl: string;
  headers: Record<string, string>;
}

export interface SyncApi {
  /** The signed-in account, or null when signed out. */
  me(): Promise<Account | null>;
  listWorkspaces(): Promise<WorkspaceRecord[]>;
  createWorkspace(workspace: {
    id: Id;
    name: string;
    icon: string | null;
  }): Promise<WorkspaceRecord>;
  pushOps(workspaceId: Id, deviceId: Id | null, ops: Operation[]): Promise<OpResult[]>;
  changes(workspaceId: Id, after: number, limit: number): Promise<ChangesPage>;
  tree(workspaceId: Id, root?: Id | null): Promise<ServerTree>;
  pushDoc(
    pageId: Id,
    request: DocPushRequest,
  ): Promise<{ acks: { updateId: Id; seq: number }[]; headSeq: number }>;
  pullDoc(pageId: Id, after: number): Promise<DocPull>;
  /**
   * Phase 12: up to `DOCS_PULL_PAGES` distinct pages of one workspace in one request, each checked
   * and answered as `pullDoc` would be, one page's refusal never failing the rest (`DocsPullItem`).
   * The request as a whole fails as any route does (401, 429 with `Retry-After`, 400
   * `request.invalid` for no page, too many or one twice, 404 for a workspace not the account's).
   */
  pullDocs(workspaceId: Id, pages: { pageId: Id; after: number }[]): Promise<DocsPullItem[]>;
  /** The state hash of the page's validated head (SYNC_DESIGN.md, Repair). */
  docStateHash(pageId: Id): Promise<DocStateHash>;
  /** Sends the device's full state (or nothing, for a reader) and pulls the page from the start. */
  repairDoc(pageId: Id, request: DocRepairRequest): Promise<DocRepairAnswer>;
  /** Bytes from a signed URL (a snapshot, an asset): no credentials are sent. */
  fetchBytes(url: string): Promise<Uint8Array>;
  yjsClients(
    workspaceId: Id,
    request: { issue?: number; register?: number[] },
  ): Promise<{ issued: number[]; registered: number[]; refused: number[] }>;
  /** An upload ticket for a new asset, the upload itself, and its completion (M2.5). */
  assetTicket(
    workspaceId: Id,
    asset: { id: Id; fileName: string; contentType: string; sizeBytes: number },
  ): Promise<AssetTicket>;
  putBytes(url: string, headers: Record<string, string>, bytes: Uint8Array): Promise<void>;
  completeAsset(assetId: Id): Promise<void>;
  assetUrl(assetId: Id): Promise<string>;
  // Phase 4: databases
  /** A database's rows after `after` (by row id), at most `limit` (1 to 1,000). */
  rows(databaseId: Id, after: Id | null, limit: number): Promise<RowsPage>;
  query(databaseId: Id, request: QueryRequest): Promise<QueryAnswer>;
}

/** The server answered with a problem (status and stable code). */
export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = `${status} ${code}`,
    /** How long the server asked to be left alone (`Retry-After` on a 429 or 503). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'SyncHttpError';
  }
}

/** The server could not be reached. Nothing is discarded; the loop backs off and tries again. */
export class OfflineError extends Error {
  constructor(cause?: unknown) {
    super('The server could not be reached', { cause });
    this.name = 'OfflineError';
  }
}

/** What the engine needs from the document layer (it never looks inside a document itself). */
export interface DocCodec {
  /** One update holding all of these. */
  merge(updates: Uint8Array[]): Uint8Array;
  /** The Yjs client ids an update writes structs as. */
  clientIds(update: Uint8Array): number[];
  /** The document schema version this build writes. */
  schemaVersion: number;
  /** The canonical state hash (state vector and delete set) of the document these parts make. */
  stateHash(parts: Uint8Array[]): Promise<string>;
}
