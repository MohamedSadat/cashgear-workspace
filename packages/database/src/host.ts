// What every database view is given by the app around it (contract section 7). The views never
// save, load or call the network: records, rows, people, files and navigation all come through
// here, and every change goes out as operations through `apply`. The shell implements it over
// its session (the local store, the sync engine and the server's query route); the tests and the
// browser harness implement it in memory (`./testing/memoryHost.ts`).
//
// Reads are synchronous and live: each read returns the same object while it is unchanged, so a
// read can be a `useSyncExternalStore` snapshot, and `subscribe` says when any of them changed.
import type { Id, Operation, PageRecord, RowRecord } from '@cgw/workspace';
import type {
  AutomationRecord,
  DatabaseRecord,
  PropertyDef,
  PropertyId,
  QueryContext,
  QuerySpec,
  ViewRecord,
  ViewType,
} from './core';

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
  /**
   * Phase 9: the rows with no value in this date property (a calendar's or a timeline's list
   * beside it). `spec.filter` says so too; a host that sends no filter (a share link's) asks for
   * them by this.
   */
  undated?: PropertyId;
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

  // ---- Automations (Phase 15; optional: the shell gives them for a synced workspace) ----------
  /**
   * A database's rules, kept and run by the server: absent on a local workspace and a share link.
   * The same object while it is there; `subscribe` says when it comes or goes.
   */
  automations?: AutomationsHost;

  /**
   * Phase 16: whether the server keeps a view of this type, so a view of it may be made (a server
   * before 0.16.0 refuses a form). Absent: every type this build knows (a local workspace).
   */
  viewTypeKnown?(type: ViewType): boolean;

  // ---- Forms (Phase 16; optional: the shell gives them for a synced workspace) ---------------
  /**
   * A form view's answers' count and its link, kept by the server: absent on a local workspace and
   * a share link (a member's answer is a row like any other, through `apply`, offline too).
   */
  forms?: FormsHost;
}

/** Whether a form's link takes answers now. */
export type FormLinkState = 'open' | 'off' | 'closed' | 'full';

/** A form view's link, as the server answers it. */
export interface FormLink {
  id: Id;
  /** The address anyone answers by (the Sites process's `/_form/{token}`). */
  url: string;
  enabled: boolean;
  /** ISO time it takes no answers from, or null. */
  closesAt: string | null;
  maxAnswers: number | null;
  /** Answers it has taken. */
  answers: number;
  state: FormLinkState;
  createdAt: string;
}

/** A form view's answers and its link. */
export interface FormState {
  /** Rows its answers added, in the app and by its link, not in the trash. */
  answers: number;
  link: FormLink | null;
  /** Full access: the person makes, changes and deletes the link. */
  canManage: boolean;
  /** False for a database in a private section (it takes no link). */
  linksAllowed: boolean;
}

export interface FormLinkSettings {
  enabled: boolean;
  closesAt: string | null;
  maxAnswers: number | null;
}

/**
 * What a form view's share panel is given (the shell's, over the server's routes). Every call
 * rejects with a notice code (`offline`, `access.denied`, `form.linkExists`, ...) as its message.
 */
export interface FormsHost {
  online(): boolean;
  /** The server keeps form views (its `/version` counts 8 view types). */
  knowsForms(): boolean;
  state(databaseId: Id, viewId: Id): Promise<FormState>;
  createLink(databaseId: Id, viewId: Id, settings: FormLinkSettings): Promise<FormLink>;
  updateLink(databaseId: Id, viewId: Id, settings: FormLinkSettings): Promise<FormLink>;
  deleteLink(databaseId: Id, viewId: Id): Promise<void>;
}

/** A rule's run, as the run log shows it. */
export interface AutomationRun {
  id: Id;
  automationId: Id;
  automationName: string;
  databaseId: Id;
  rowId: Id | null;
  /** The row's title when the person can read it; null for a schedule's or a row gone. */
  rowTitle: string | null;
  trigger: string;
  depth: number;
  actor: Person | null;
  author: Person;
  /** `done`, `stopped`, `skipped`, `running`, or (Phase 17) `waiting`. */
  status: string;
  /** Why it stopped or was skipped: `depth`, `limit.rule`, `author.access`, a step's code. */
  reason: string | null;
  steps: {
    index: number;
    /** Phase 17: the step's place inside branches and approvals (`2/0/1`); absent before 0.17.0. */
    path?: string | null;
    kind: string;
    status: string;
    code?: string | null;
    /** A branch's path taken (`path:0`, `otherwise`), a wait's or an approval's end (an instant). */
    detail?: string | null;
    count?: number | null;
  }[];
  startedAt: string;
  endedAt: string | null;
}

export interface AutomationRunsPage {
  runs: AutomationRun[];
  /** The cursor of the next (older) page, or null. */
  next: string | null;
}

/** A database's rules for its editor, and what the person may do with them. */
export interface DatabaseAutomations {
  automations: {
    rule: AutomationRecord;
    author: Person | null;
    lastRun: { status: string; reason: string | null; startedAt: string } | null;
  }[];
  /** Full access to the database: the person makes, changes and deletes its rules. */
  canManage: boolean;
  /** An owner or admin: their rules may call the workspace's webhooks, listed here. */
  canCallWebhooks: boolean;
  webhooks: { id: Id; name: string }[];
  /** The workspace's time zone (null: UTC until one is set or a rule saved). */
  timeZone: string | null;
  /** Every rule of the workspace is switched off (Settings). */
  allOff: boolean;
  /**
   * Phase 17: how many of `STEP_KINDS` the server keeps (its `/version`'s `stepKinds`; 4 before
   * 0.17.0): waits, branches and approvals are offered only once it keeps 7.
   */
  stepKinds?: number;
}

/**
 * What the rule editor, the run log and the button cell are given (the shell's, over the server's
 * routes; rules are saved as operations through `DatabaseHost.apply`). Every read rejects with a
 * notice code (`offline`, `access.denied`, ...) as the error's message.
 */
export interface AutomationsHost {
  /** Online: rules are read and buttons pressed only then (they run on the server). */
  online(): boolean;
  /** The server knows the button property (its `/version` counts 21 property types). */
  knowsButtons(): boolean;
  list(databaseId: Id): Promise<DatabaseAutomations>;
  /** Saves a rule (an `automation.upsert`), with the browser's time zone for a workspace without one. */
  save(rule: AutomationRecord): Promise<void>;
  remove(rule: AutomationRecord): Promise<void>;
  setEnabled(rule: AutomationRecord, enabled: boolean): Promise<void>;
  runs(databaseId: Id, automationId: Id, before?: string | null): Promise<AutomationRunsPage>;
  rowRuns(databaseId: Id, rowId: Id, before?: string | null): Promise<AutomationRunsPage>;
  /**
   * A button pressed: sent once (a press of its own id), never queued while offline; the shell
   * tells the person what came of it.
   */
  press(databaseId: Id, rowId: Id, def: PropertyDef): Promise<void>;
  /** The workspace's groups, for a notice. */
  groups(): Promise<{ id: Id; name: string }[]>;
  /** Says when a database's rules changed (the feed's `automation` change). */
  onChange(listener: () => void): () => void;
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
