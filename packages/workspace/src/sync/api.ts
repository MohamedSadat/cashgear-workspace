// What the sync engine needs from the server (SYNC_DESIGN.md, Cloud sync), as plain records.
// `http.ts` implements it over @cgw/api; tests implement it in memory (testing/fakeServer.ts).
import type { Id } from '../ids';
import type {
  FavouriteRecord,
  Operation,
  OpResult,
  PageRecord,
  SectionRecord,
  VisitRecord,
  WorkspaceRecord,
} from '../types';

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
  | { seq: number; entityType: 'access'; entityId: Id; kind: 'grant' | 'revoke'; entity: null };

export interface ChangesPage {
  changes: ServerChange[];
  cursor: number;
  more: boolean;
}

export interface ServerTree {
  workspace: WorkspaceRecord;
  sections: SectionRecord[];
  pages: PageRecord[];
  favourites: FavouriteRecord[];
  visits: VisitRecord[];
  cursor: number;
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
}

/** The server answered with a problem (status and stable code). */
export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = `${status} ${code}`,
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
}
