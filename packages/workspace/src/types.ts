// The workspace layer's records and contracts (DATA_MODEL.md, SYNC_DESIGN.md). Typed and fixed in
// Phase 1: `Operation` is the shape Phase 2 sends to the server, and `LocalStore` is what both
// local stores implement and the conformance suite checks.
import type { Id } from './ids';

export type { Id };

// ---------------------------------------------------------------------------------------------
// Relational records: the local mirror

export interface WorkspaceRecord {
  id: Id;
  name: string;
  /** An emoji, or null. */
  icon: string | null;
  createdAt: string;
  /** Rises on every change, as the server's will. */
  version: number;
  /** Local-only until Phase 2 uploads it. */
  localOnly: boolean;
  deletedAt: string | null;
}

export type SectionVisibility = 'workspace' | 'private';

export interface SectionRecord {
  id: Id;
  workspaceId: Id;
  name: string;
  orderKey: string;
  visibility: SectionVisibility;
  version: number;
  createdAt: string;
}

export type PageKind = 'page';

export interface PageRecord {
  id: Id;
  workspaceId: Id;
  sectionId: Id;
  /** Null at the top of its section. */
  parentPageId: Id | null;
  orderKey: string;
  kind: PageKind;
  title: string;
  /** An emoji, or null. */
  icon: string | null;
  coverAssetId: Id | null;
  isTemplate: boolean;
  /** The template this page was made from, for display. */
  templateOfPageId: Id | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Set on every page of a trashed subtree; `trashRootId` names the page the user trashed. */
  trashedAt: string | null;
  trashRootId: Id | null;
}

export interface FavouriteRecord {
  workspaceId: Id;
  pageId: Id;
  orderKey: string;
}

export interface VisitRecord {
  workspaceId: Id;
  pageId: Id;
  lastVisitedAt: string;
}

export interface AssetRecord {
  id: Id;
  workspaceId: Id;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

/** Where a page sits: the top of a section, or under a page. */
export type TreeParent = { sectionId: Id; pageId: null } | { sectionId: Id; pageId: Id };

// ---------------------------------------------------------------------------------------------
// Operations: every change to the mirror, kept in the outbox until a server acknowledges it.

export type Operation =
  | Op<'workspace.create', WorkspaceRecord>
  | Op<'workspace.update', Partial<Pick<WorkspaceRecord, 'name' | 'icon'>>>
  | Op<'section.create', SectionRecord>
  | Op<'section.update', Partial<Pick<SectionRecord, 'name' | 'orderKey'>>>
  | Op<'section.delete', Record<string, never>>
  | Op<'page.create', PageRecord>
  | Op<'page.update', PageUpdate>
  | Op<'page.move', PageMove>
  | Op<'page.trash', Record<string, never>>
  | Op<'page.restore', Record<string, never>>
  | Op<'page.delete', Record<string, never>>
  | Op<'favourite.set', { favourite: boolean; orderKey: string | null }>
  | Op<'visit.record', { at: string }>;

export type OperationType = Operation['type'];

export interface Op<T extends string, P> {
  /** UUIDv7, the idempotency key. */
  opId: Id;
  type: T;
  workspaceId: Id;
  entityId: Id;
  /** The entity's version this was based on; null for a create. */
  baseVersion: number | null;
  payload: P;
  /** For display only; never used to order. */
  createdAt: string;
}

export type PageUpdate = Partial<
  Pick<PageRecord, 'title' | 'icon' | 'coverAssetId' | 'isTemplate' | 'templateOfPageId'>
>;

export interface PageMove {
  sectionId: Id;
  parentPageId: Id | null;
  orderKey: string;
}

export interface OpResult {
  opId: Id;
  status: 'applied' | 'rejected';
  error?: { code: string };
}

/** Why an operation was refused; the codes are the server's (SYNC_DESIGN.md). */
export type OpErrorCode =
  | 'tree.cycle'
  | 'tree.section'
  | 'not.found'
  | 'version.conflict'
  | 'page.trashed'
  | 'page.notTrashed'
  | 'section.notEmpty'
  | 'invalid';

export class OpError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'OpError';
  }
}

// ---------------------------------------------------------------------------------------------
// Documents in the local store

export interface LocalUpdate {
  /** UUIDv7, the idempotency key for a pushed update (Phase 2). */
  updateId: Id;
  data: Uint8Array;
}

export interface StoredUpdate extends LocalUpdate {
  /** Order within this device's log for the page; rises by one per append. */
  localSeq: number;
  /** The server's sequence once acknowledged; null while local only. */
  seq: number | null;
}

export interface StoredDoc {
  snapshot: Uint8Array | null;
  /** The highest local sequence the snapshot covers; 0 with no snapshot. */
  snapshotCovers: number;
  updates: StoredUpdate[];
}

export interface HistoryEntry {
  id: Id;
  pageId: Id;
  createdAt: string;
  sizeBytes: number;
}

export interface SearchHit {
  pageId: Id;
  title: string;
  /** A short run of the text around the first match, or empty for a title match. */
  snippet: string;
  score: number;
}

/** What the search index holds for a page: normalised text (search.ts) and the title. */
export interface SearchEntry {
  pageId: Id;
  workspaceId: Id;
  title: string;
  text: string;
}

export interface Prefs {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------------
// The local store (D11, SYNC_DESIGN.md "The local store")

export interface MirrorSnapshot {
  workspaces: WorkspaceRecord[];
  sections: SectionRecord[];
  pages: PageRecord[];
  favourites: FavouriteRecord[];
  visits: VisitRecord[];
  assets: AssetRecord[];
}

/**
 * Every method is one atomic transaction. `applyLocalOp` changes the mirror and adds the
 * operation to the outbox together, or does neither. Bytes stay bytes.
 */
export interface LocalStore {
  readonly kind: 'indexeddb' | 'sqlite' | 'memory';

  // Documents
  loadDoc(pageId: Id): Promise<StoredDoc>;
  /** Appends to the page's log and returns the local sequence each update was given. */
  appendDocUpdates(pageId: Id, updates: LocalUpdate[]): Promise<number[]>;
  /** Replaces the snapshot and drops the updates it covers. */
  compactDoc(pageId: Id, snapshot: Uint8Array, coversLocalUpTo: number): Promise<void>;
  /** Moves updates that fail to decode out of the log, into the corrupt area (kept for support). */
  quarantineUpdates(pageId: Id, localSeqs: number[], reason: string): Promise<void>;
  /** How many updates the log holds after the snapshot. */
  docLogLength(pageId: Id): Promise<number>;

  // Local page history
  addHistory(pageId: Id, snapshot: Uint8Array, keep: number): Promise<HistoryEntry>;
  listHistory(pageId: Id): Promise<HistoryEntry[]>;
  getHistory(entryId: Id): Promise<Uint8Array | null>;

  // Metadata mirror and outbox
  applyLocalOp(op: Operation): Promise<void>;
  /** Several operations in one transaction: all apply, or none (a trash, a template copy). */
  applyLocalOps(ops: Operation[]): Promise<void>;
  nextOutboxBatch(limit: number): Promise<Operation[]>;
  settleOps(results: OpResult[]): Promise<void>;
  readMirror(workspaceId: Id | null): Promise<MirrorSnapshot>;
  getPage(pageId: Id): Promise<PageRecord | null>;

  // Search: the caller normalises (search.ts); the store only indexes and matches
  putSearchEntry(entry: SearchEntry): Promise<void>;
  deleteSearchEntries(pageIds: Id[]): Promise<void>;
  search(workspaceId: Id, normalisedQuery: string, limit: number): Promise<SearchHit[]>;

  // Assets
  putAsset(asset: AssetRecord, bytes: Uint8Array): Promise<void>;
  getAssetBytes(assetId: Id): Promise<Uint8Array | null>;

  // Preferences kept on this device (toggle state, expanded tree nodes)
  getPref<T>(key: string): Promise<T | undefined>;
  setPref(key: string, value: unknown): Promise<void>;

  // Housekeeping
  /** Removes for good every page of the workspace trashed before `before`, with its document. */
  purgeTrash(workspaceId: Id, before: string): Promise<Id[]>;
  schemaVersion(): Promise<number>;
  close(): Promise<void>;
}

/** The store schema version this build reads and writes (SYNC_DESIGN.md, local migration). */
export const STORE_SCHEMA_VERSION = 1;
