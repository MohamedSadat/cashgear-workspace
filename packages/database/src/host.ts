// What every database view is given by the app around it (contract section 7). The views never
// save, load or call the network: records, rows, people, files and navigation all come through
// here, and every change goes out as operations through `apply`. The shell implements it over
// its session (the local store, the sync engine and the server's query route); the tests and the
// browser harness implement it in memory (`./testing/memoryHost.ts`).
//
// Reads are synchronous and live: each read returns the same object while it is unchanged, so a
// read can be a `useSyncExternalStore` snapshot, and `subscribe` says when any of them changed.
import type { Id, Operation, PageRecord, RowRecord } from '@cgw/workspace';
import type { DatabaseRecord, PropertyId, QueryContext, QuerySpec, ViewRecord } from './core';

/** A person of the workspace: person cells, created and edited by, the "Me" of a filter. */
export interface Person {
  id: Id;
  name: string;
  email?: string | null;
  /** A picture the shell can show (an object URL or an asset URL), or null for initials. */
  avatarUrl?: string | null;
}

/** A file's details as the shell keeps them (the same as `EditorHost.assets.info`). */
export interface AssetInfo {
  fileName: string;
  sizeBytes: number;
  contentType: string;
}

/** Files: the same shape as `EditorHost.assets`, so the shell hands both the same object. */
export interface DatabaseAssets {
  /** A URL the page may show (an image), or null when there is none yet (offline, not fetched). */
  url(assetId: Id): Promise<string | null>;
  info(assetId: Id): AssetInfo | undefined;
  /** Keeps a file's bytes and gives its asset id, or null when it was refused (type, size). */
  store(file: File): Promise<{ assetId: Id; width: number | null; height: number | null } | null>;
  /** Lets the person choose files; an empty list when they chose none. */
  pick(accept: string[]): Promise<File[]>;
  /** Opens or downloads the file the way the shell opens files. */
  open(assetId: Id): void;
}

/** A row found by `searchRows`: enough to show it in a relation picker. */
export interface RowRef {
  id: Id;
  databaseId: Id;
  title: string;
  icon: string | null;
}

/** A database the person may pick as a relation's target. */
export interface DatabaseRef {
  id: Id;
  title: string;
  icon: string | null;
}

/** Where a row goes among its database's rows. */
export type RowPlace = 'start' | 'end' | { after: Id | null; before: Id | null };

/** What rows to read for a view. */
export interface RowRequest {
  /** The view the rows are for (null: a query of its own, as the row panel's relation lists). */
  viewId: Id | null;
  /** The query to run: the view's filter, sorts and group, and the toolbar's search. */
  spec: QuerySpec;
  /**
   * Rows fetched at first and by each `loadMore` (default 100) when the server answers. A
   * database queried on this device (a full hold) gives every row at once.
   */
  pageSize?: number;
}

/** One group of a grouped query, in group order. */
export interface RowGroup {
  /** The group key (`GroupCount.key`); `''` is "no value". */
  key: string;
  /** Rows of the query in this group, loaded or not. */
  count: number;
  /** The group's rows loaded so far, in the query's order. */
  rows: RowRecord[];
  /** Every row of the group is in `rows`. */
  complete: boolean;
}

/**
 * What a row source holds now. Rows are `RowRecord`s whose `computed` holds what formula and
 * rollup cells show: the host's own result where it holds the inputs (`computeRow` over the row
 * and, for rollups, the related rows), else the server's.
 */
export interface RowSnapshot {
  /**
   * The rows loaded so far, in the query's order. Grouped: the rows of every group in group
   * order (a multi-select row once for each group it is in).
   */
  rows: RowRecord[];
  /**
   * Grouped queries: every group, in group order, with groups the rule hides (`hidden`, and
   * empty ones with `hideEmpty`) already left out. Null when the query has no group.
   */
  groups: RowGroup[] | null;
  /** Rows the query matches, in every group. */
  total: number;
  /** Every row the query matches is loaded. */
  complete: boolean;
  /**
   * The rows are only those this device has (offline, a database larger than the local limit):
   * the view says "showing rows on this device".
   */
  localOnly: boolean;
  /** A fetch is under way (the first one, or a `loadMore`). */
  loading: boolean;
  /** Why the last fetch failed, as a notice code (`offline`, `access.denied`, ...), else null. */
  error: string | null;
}

/** A live, paged list of rows for one query. */
export interface RowSource {
  /** The same object until something in it changes. */
  snapshot(): RowSnapshot;
  subscribe(listener: () => void): () => void;
  /** Fetches the next page, of one group when a key is given. Nothing when complete or busy. */
  loadMore(groupKey?: string): void;
  /** Tries a failed fetch again. */
  retry(): void;
  /** Stops listening and fetching; the source is not used after this. */
  close(): void;
}

export interface DatabaseHost {
  // ---- Records, live ---------------------------------------------------------------------
  /** Says when anything the reads below return has changed. */
  subscribe(listener: () => void): () => void;
  /** The database's record (its properties), or null while it is not on this device. */
  database(databaseId: Id): DatabaseRecord | null;
  /** The database's views, in their order (by order key, then id). */
  views(databaseId: Id): ViewRecord[];
  /**
   * A page by id: the database's own page (title, icon, section), a related row; for a row, its
   * `RowRecord` (kind `row`, `computed` filled as in a row source), which `RowProperties` reads.
   * Rows the device does not hold may be unknown (null).
   */
  page(pageId: Id): PageRecord | RowRecord | null;
  /** A page's title as the interface shows it (rows of other databases included), if known. */
  pageTitle(pageId: Id): string | undefined;
  /** The database's row templates (`isTemplate` rows), for "New from template". */
  rowTemplates(databaseId: Id): RowRecord[];
  /** Databases the person may relate to (relation set-up), by title. */
  databases(): DatabaseRef[];

  // ---- Rows ------------------------------------------------------------------------------
  /**
   * A live source of rows for a query: local rows queried by `queryRows` for a database this
   * device holds in full, the server's query (keyset paged) otherwise, and offline the rows
   * already fetched, flagged `localOnly`. The caller closes it.
   */
  rows(databaseId: Id, request: RowRequest): RowSource;
  /**
   * Rows of a database whose titles match the words (a relation picker), at most `limit`. Local
   * rows first; the server's search when the database is not held in full and it is online.
   */
  searchRows(
    databaseId: Id,
    query: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<RowRef[]>;
  /**
   * An order key among the database's rows, from the rows' own keys (the "no sort" order, a
   * board's order within a column): after every row, before every row, or between two rows
   * (`after: null` is from the start, `before: null` to the end).
   */
  rowOrderKey(databaseId: Id, place: RowPlace): string;

  // ---- Changes -----------------------------------------------------------------------------
  /**
   * Applies operations through the session (planned locally, then sent), in the order of the
   * calls. Rejects with the planner's error when they are refused; the host has already told the
   * person why.
   */
  apply(ops: Operation[]): Promise<void>;
  /** A new id for a row, a view or a database page (UUIDv7). */
  newId(): Id;

  // ---- People and rights -----------------------------------------------------------------
  /** The signed-in person (null while the workspace is local only). */
  me(): Person | null;
  /** The workspace's people, for person cells; on a local workspace only the person using it. */
  people(): Person[];
  /** Whether the person may change the database, its views and its rows (decided by the server). */
  canEdit(databaseId: Id): boolean;
  /** What queries are evaluated against: today, the offset, the person asking, people's names. */
  queryContext(): QueryContext;

  // ---- Files and navigation --------------------------------------------------------------
  /** Files cells; without it they show names and cannot upload. */
  assets?: DatabaseAssets;
  /** Opens a row as a page (its properties above its body). */
  openRow(rowId: Id): void;
  /** Opens a page (the database's own page as a full page, a page a cell names). */
  openPage(pageId: Id): void;
  /** Opens a link the person clicked (already checked against the scheme allow-list). */
  openExternal?(url: string): void;

  // ---- CSV (views stream; optional: the shell implements them for a synced workspace) -------
  /**
   * Imports a CSV on the server (`POST /databases/{id}/import`, contract section 4): files
   * larger than the device imports itself (`LOCAL_ROW_LIMIT` rows). `columns` names each
   * column's property (null: not imported). The database must have reached the server (a new one
   * is sent first). Absent on a local workspace; rejects with a notice code (`offline`,
   * `db.tooLarge`, ...) as the error's message when refused.
   */
  importCsv?(databaseId: Id, request: CsvImportRequest): Promise<CsvImportResult>;
  /**
   * A view's rows as CSV from the server (`GET /databases/{id}/export?viewId=`): for a database
   * this device does not hold in full. Absent on a local workspace.
   */
  exportCsv?(databaseId: Id, viewId: Id): Promise<Blob>;
  /**
   * Saves a file the person asked for (an export): the desktop's save dialog. Without it the
   * browser downloads the file.
   */
  saveFile?(fileName: string, data: Blob): Promise<void>;

  // ---- Workbooks (Phase 5, M5.5; optional: the shell implements them for a synced workspace) --
  /**
   * "Export to a workbook": a new workbook holding the view's rows in its filter and sort order
   * and its shown properties, written by the server (`POST /databases/{id}/workbooks`). Absent
   * on a local workspace; rejects with a notice code (`offline`, `limit.size`, ...) as the
   * error's message when refused.
   */
  exportWorkbook?(databaseId: Id, viewId: Id, name: string): Promise<WorkbookExportResult>;
  /** "Open in Cash Gear Sheet" for a workbook (after an export). */
  openWorkbook?(workbookId: Id): void;
}

/** A workbook a view was exported to. */
export interface WorkbookExportResult {
  workbookId: Id;
  name: string;
}

/** The server's CSV import, as its route takes it. */
export interface CsvImportRequest {
  csv: string;
  columns: (PropertyId | null)[];
  header: boolean;
}

export interface CsvImportResult {
  created: number;
  problems: { line: number; message: string }[];
}
