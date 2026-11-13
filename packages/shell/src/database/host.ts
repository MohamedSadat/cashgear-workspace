// The `DatabaseHost` the database views are given (contract section 7), over the session: records
// from the mirror (databases, views, page titles), rows from the local store and the server, every
// change as operations through the session, people from the workspace's members, files as the
// editor's, and navigation by route. The views never save, load or call the network themselves.
//
// Rows: a database this device holds in full (every row, kept fresh by the feed; a local
// workspace's always) is queried here with `queryRows`, formulas and rollups computed by
// `computeRow` where the inputs are here. Any other is the server's query while online (paged,
// its rows kept on this device by the engine), and offline the rows this device has, flagged
// "showing rows on this device". A view showing a database in a synced workspace starts a hold of
// it (and of the databases its relations point into), so it is fetched and kept.
import type {
  DatabaseAssets,
  DatabaseHost,
  DatabaseRef,
  Person,
  RowPlace,
  RowRef,
  RowRequest,
  RowSource,
} from '@cgw/database';
import {
  compareSiblings,
  computeRow,
  keyBetween,
  normaliseText,
  searchTerms,
  uuidv7,
  type CellValue,
  type DatabaseRecord,
  type DbHold,
  type Id,
  type Operation,
  type PageRecord,
  type PropertyId,
  type QueryAnswer,
  type QueryContext,
  type QueryRequest,
  type RowRecord,
  type ViewRecord,
} from '@cgw/workspace';
import { navigate } from '../route';
import { canEditPage, type WorkspaceSession } from '../session';
import { ShellRowSource } from './sources';

type ImportCsv = NonNullable<DatabaseHost['importCsv']>;
type ExportCsv = NonNullable<DatabaseHost['exportCsv']>;
export type CsvImportRequest = Parameters<ImportCsv>[1];
export type CsvImportResult = Awaited<ReturnType<ImportCsv>>;

/** A member of a workspace as the server lists them. */
export interface Member {
  userId: Id;
  displayName: string;
  email: string;
}

/**
 * What the host needs of the connection to the server (cloud/cloud.ts gives it; the tests give
 * one over the fake server). Absent, every workspace is read from this device only.
 */
export interface DatabaseSync {
  /** Someone is signed in and the server is not known to be out of reach. */
  online(): boolean;
  /** The signed-in account, or null. */
  account(): { id: Id; displayName: string; email: string } | null;
  /** Keeps the database's rows on this device (the engine's hold). */
  holdDatabase(databaseId: Id): Promise<DbHold>;
  /** The server's query; its rows are kept when the database is held. */
  queryDatabase(databaseId: Id, request: QueryRequest): Promise<QueryAnswer>;
  /** The server's query, nothing kept (finding which database a row a search found is in). */
  peekQuery?(databaseId: Id, request: QueryRequest): Promise<QueryAnswer>;
  /** The workspace's members (the people a person cell can name). */
  members(workspaceId: Id): Promise<Member[]>;
  /** Sends what waits now (a database made here, before the server imports into it). */
  syncNow(): Promise<void>;
  /** The server's CSV import into a database (contract section 4). */
  importCsv(databaseId: Id, request: CsvImportRequest): Promise<CsvImportResult>;
  /** The server's CSV of a view's rows, as bytes (a BOM first). */
  exportCsv(databaseId: Id, viewId: Id, context: QueryContext): Promise<Uint8Array>;
  /** The status or the account changed. */
  subscribe(listener: () => void): () => void;
  /** The workspace's members changed. */
  onMembers?(listener: (workspaceId: Id) => void): () => void;
}

export interface ShellDatabaseHostOptions {
  session: WorkspaceSession;
  /** Files, as the editor host has them (page/editorHost.ts `assetsOf`). */
  assets?: DatabaseAssets;
  openExternal?(url: string): void;
  saveFile?(name: string, bytes: Uint8Array, type: string): Promise<void>;
  /** A change was refused: the person is told why (the frame's notice). */
  onError?(error: unknown): void;
  /** Opens a page or a row (default: by route). */
  open?(pageId: Id): void;
}

/** The person's calendar date, `YYYY-MM-DD`, by the device's clock. */
export function localToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const PEOPLE_PREF = (workspaceId: Id) => `database/people/${workspaceId}`;

/** The same items in the same order (each read returns the same array while they are). */
function sameItems<T>(a: readonly T[] | undefined, b: readonly T[]): a is T[] {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const relationTargets = (database: DatabaseRecord | null | undefined): Id[] =>
  database
    ? [
        ...new Set(
          database.properties
            .filter((p) => p.type === 'relation' && p.relation && !p.trashedAt)
            .map((p) => p.relation!.databaseId),
        ),
      ]
    : [];

const computes = (database: DatabaseRecord) =>
  database.properties.some((p) => (p.type === 'formula' || p.type === 'rollup') && !p.trashedAt);

/** Databases a rollup reads rows of (through its relation). */
function rollupTargets(database: DatabaseRecord): Id[] {
  const out = new Set<Id>();
  for (const def of database.properties) {
    if (def.type !== 'rollup' || !def.rollup || def.trashedAt) continue;
    const relation = database.properties.find((p) => p.id === def.rollup!.relationPropertyId);
    if (relation?.relation) out.add(relation.relation.databaseId);
  }
  return [...out];
}

interface RowsEntry {
  rev: number;
  list: RowRecord[];
  set: Set<RowRecord>;
  token: number;
}

export type SourceMode = 'pending' | 'local' | 'server' | 'device';

export class ShellDatabaseHost implements DatabaseHost {
  readonly session: WorkspaceSession;
  readonly assets?: DatabaseAssets;
  private sync: DatabaseSync | null = null;
  private offSync: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly sources = new Set<ShellRowSource>();
  private scheduled = false;
  private readonly cleanups: (() => void)[] = [];
  // Caches: each read returns the same object while what it reads is unchanged.
  private readonly viewsCache = new Map<Id, ViewRecord[]>();
  private readonly templatesCache = new Map<Id, { token: number; list: RowRecord[] }>();
  private databasesCache: { workspaceId: Id | null; list: DatabaseRef[] } | null = null;
  private readonly rowsCache = new Map<Id, RowsEntry>();
  private readonly computedCache = new WeakMap<
    RowRecord,
    { database: DatabaseRecord; key: string; row: RowRecord }
  >();
  private readonly holds = new Map<Id, DbHold | null>();
  /** Rows the server's answers brought that the mirror does not hold (titles, relation pickers). */
  private readonly seen = new Map<Id, RowRecord>();
  private peopleList: Person[] = [];
  private peopleKey = '';
  private mePerson: Person | null = null;
  private context: QueryContext | null = null;
  private contextKey = '';

  constructor(private readonly options: ShellDatabaseHostOptions) {
    this.session = options.session;
    this.assets = options.assets;
    this.cleanups.push(
      this.session.mirror.subscribe(() => this.schedule()),
      this.session.onRows((databaseId) => void this.readHold(databaseId)),
      this.session.onSwitch(() => void this.refreshPeople()),
    );
    void this.refreshPeople();
  }

  /** The connection to the server came (or went): sources look again at where rows come from. */
  connect(sync: DatabaseSync | null) {
    for (const off of this.offSync) off();
    this.offSync = [];
    this.sync = sync;
    if (sync) {
      this.offSync.push(
        sync.subscribe(() => {
          const online = sync.online();
          // Every status while online, not only the one that brought the network back: a query
          // that failed as it came back left its view on this device's rows (a source that is
          // not waiting on the network does nothing).
          if (online) for (const source of this.sources) source.onlineChanged(true);
          void this.refreshPeople();
          this.schedule();
        }),
      );
      if (sync.onMembers)
        this.offSync.push(sync.onMembers(() => void this.refreshPeople({ force: true })));
    }
    // Views on screen hold their databases now that holds can be made.
    for (const source of this.sources) void source.restart();
    void this.refreshPeople({ force: true });
    this.schedule();
  }

  dispose() {
    for (const off of [...this.cleanups, ...this.offSync]) off();
    for (const source of [...this.sources]) source.close();
    this.listeners.clear();
  }

  /** Everything changed reads again after the current task (several changes, one notice). */
  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const source of [...this.sources]) source.refresh();
      for (const listener of [...this.listeners]) listener();
    });
  }

  // ---- Records ---------------------------------------------------------------------------------

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  database = (databaseId: Id): DatabaseRecord | null =>
    this.session.mirror.databases.get(databaseId) ?? null;

  views = (databaseId: Id): ViewRecord[] => {
    const fresh = this.session.mirror.viewsOf(databaseId);
    const cached = this.viewsCache.get(databaseId);
    if (sameItems(cached, fresh)) return cached;
    this.viewsCache.set(databaseId, fresh);
    return fresh;
  };

  page = (pageId: Id): PageRecord | RowRecord | null => {
    const page = this.session.mirror.pages.get(pageId);
    if (page) return page;
    const row = this.session.mirror.rowRecords.get(pageId) ?? this.seen.get(pageId);
    return row ? this.withComputed(row) : null;
  };

  pageTitle = (pageId: Id): string | undefined =>
    this.session.mirror.pages.get(pageId)?.title ??
    this.session.mirror.rowRecords.get(pageId)?.title ??
    this.seen.get(pageId)?.title;

  rowTemplates = (databaseId: Id): RowRecord[] => {
    const token = this.rowsToken(databaseId);
    const cached = this.templatesCache.get(databaseId);
    if (cached?.token === token) return cached.list;
    const fresh = this.rowList(databaseId).filter((r) => r.isTemplate && !r.trashedAt);
    fresh.sort(compareSiblings);
    const list = cached && sameItems(cached.list, fresh) ? cached.list : fresh;
    this.templatesCache.set(databaseId, { token, list });
    return list;
  };

  databases = (): DatabaseRef[] => {
    const { mirror } = this.session;
    const workspaceId = this.session.workspaceId;
    const fresh: DatabaseRef[] = [];
    for (const database of mirror.databases.values()) {
      const page = mirror.pages.get(database.id);
      if (database.workspaceId !== workspaceId || !page || page.trashedAt) continue;
      fresh.push({ id: database.id, title: page.title, icon: page.icon });
    }
    fresh.sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1));
    const cached = this.databasesCache;
    if (
      cached &&
      cached.workspaceId === workspaceId &&
      cached.list.length === fresh.length &&
      cached.list.every(
        (d, i) => d.id === fresh[i].id && d.title === fresh[i].title && d.icon === fresh[i].icon,
      )
    )
      return cached.list;
    this.databasesCache = { workspaceId, list: fresh };
    return fresh;
  };

  // ---- Rows ------------------------------------------------------------------------------------

  rows(databaseId: Id, request: RowRequest): RowSource {
    const source = new ShellRowSource(this, databaseId, request);
    this.sources.add(source);
    source.onClose(() => this.sources.delete(source));
    return source;
  }

  /**
   * The rows of a database in the mirror, the same array while they are the same records (read
   * from the store the first time they are asked for). `token` rises whenever they change.
   */
  rowList(databaseId: Id): RowRecord[] {
    return this.rowsEntry(databaseId).list;
  }

  rowsToken(databaseId: Id): number {
    return this.rowsEntry(databaseId).token;
  }

  private rowsEntry(databaseId: Id): RowsEntry {
    const { mirror } = this.session;
    const rev = mirror.getRevision();
    let entry = this.rowsCache.get(databaseId);
    if (entry?.rev === rev) return entry;
    if (!mirror.rowsLoaded(databaseId)) void this.session.loadRows(databaseId);
    const fresh = mirror.rowsOf(databaseId);
    if (entry && entry.list.length === fresh.length && fresh.every((r) => entry!.set.has(r))) {
      entry.rev = rev;
      return entry;
    }
    entry = { rev, list: fresh, set: new Set(fresh), token: (entry?.token ?? 0) + 1 };
    this.rowsCache.set(databaseId, entry);
    return entry;
  }

  /**
   * What a database's computed cells read besides its own rows: the rows its rollups reduce, when
   * they are here. It changes when any of those change.
   */
  computeKey(database: DatabaseRecord): string {
    if (!computes(database)) return '';
    return rollupTargets(database)
      .map((id) => `${id}:${this.queriesLocally(id) ? this.rowsToken(id) : '-'}`)
      .join(',');
  }

  /** A row with `computed` holding this device's results where it holds the inputs. */
  withComputed(row: RowRecord): RowRecord {
    const database = this.database(row.databaseId);
    if (!database || !computes(database)) return row;
    const key = this.computeKey(database);
    const cached = this.computedCache.get(row);
    if (cached && cached.database === database && cached.key === key) return cached.row;
    const computed: Record<PropertyId, CellValue> = {
      ...row.computed,
      ...computeRow(database, row, this.related),
    };
    const out = { ...row, computed };
    this.computedCache.set(row, { database, key, row: out });
    return out;
  }

  /** Related rows for a rollup, when this device holds every row of their database. */
  private readonly related = (databaseId: Id, ids: Id[]) => {
    const database = this.database(databaseId);
    if (!database || !this.queriesLocally(databaseId)) return null;
    this.rowList(databaseId);
    const { rowRecords } = this.session.mirror;
    return {
      database,
      rows: ids.map((id) => rowRecords.get(id)).filter((r): r is RowRecord => !!r),
    };
  };

  /** Whether the database's workspace is on this device only (nothing to fetch, ever). */
  isLocal(databaseId: Id): boolean {
    const page = this.session.mirror.pages.get(databaseId);
    const workspace = page && this.session.mirror.workspaces.get(page.workspaceId);
    return !workspace || workspace.localOnly;
  }

  /** The hold as last read; undefined until it has been. */
  holdOf(databaseId: Id): DbHold | null | undefined {
    return this.holds.get(databaseId);
  }

  /** Every row is on this device and kept fresh: the database is queried here. */
  queriesLocally(databaseId: Id): boolean {
    if (this.isLocal(databaseId)) return this.session.mirror.rowsLoaded(databaseId);
    const hold = this.holds.get(databaseId);
    return (
      !!hold && hold.mode === 'full' && hold.complete && this.session.mirror.rowsLoaded(databaseId)
    );
  }

  /** Where a source's rows come from now. */
  modeFor(databaseId: Id, offline: boolean): SourceMode {
    if (!this.session.mirror.rowsLoaded(databaseId)) return 'pending';
    if (this.isLocal(databaseId)) return 'local';
    const hold = this.holds.get(databaseId);
    if (hold === undefined) return 'pending';
    if (hold && hold.mode === 'full' && hold.complete) return 'local';
    return this.sync && this.sync.online() && !offline ? 'server' : 'device';
  }

  online(): boolean {
    return !!this.sync?.online();
  }

  /**
   * What a view of a database needs before it shows rows: its rows and those of the databases its
   * relations point into in the mirror; in a synced workspace a hold of each (the engine fetches
   * them), and the hold as it is now.
   */
  async prepare(databaseId: Id): Promise<void> {
    const ids = [databaseId, ...relationTargets(this.database(databaseId))];
    for (const id of ids) {
      if (!this.isLocal(id) && this.sync) {
        try {
          this.holds.set(id, await this.sync.holdDatabase(id));
        } catch {
          await this.readHold(id);
        }
      } else if (!this.holds.has(id)) await this.readHold(id);
      await this.session.loadRows(id);
    }
    this.schedule();
  }

  /** The hold read again (the engine says it changed, with the rows). */
  async readHold(databaseId: Id): Promise<DbHold | null> {
    const hold = await this.session.store.dbHold(databaseId).catch(() => null);
    this.holds.set(databaseId, hold);
    this.schedule();
    return hold;
  }

  /** The server's query, through the engine (its rows are kept); undefined without a server. */
  query(databaseId: Id, request: QueryRequest): Promise<QueryAnswer> {
    if (!this.sync) return Promise.reject(new Error('offline'));
    return this.sync.queryDatabase(databaseId, request).then((answer) => {
      for (const row of answer.rows) this.remember(row);
      return answer;
    });
  }

  /** A row a server answer brought, for its title and `page()` while the mirror lacks it. */
  remember(row: RowRecord) {
    if (this.seen.size > 20_000) this.seen.clear();
    this.seen.set(row.id, row);
  }

  async searchRows(
    databaseId: Id,
    query: string,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<RowRef[]> {
    const limit = options.limit ?? 25;
    await this.session.loadRows(databaseId);
    const terms = searchTerms(normaliseText(query));
    const matches = (row: RowRecord) => {
      if (row.trashedAt || row.isTemplate) return false;
      if (!terms.length) return true;
      const words = normaliseText(row.title).split(' ');
      return terms.every((term) => words.some((word) => word.startsWith(term)));
    };
    const ref = (row: RowRecord): RowRef => ({
      id: row.id,
      databaseId,
      title: row.title,
      icon: row.icon,
    });
    const out = this.rowList(databaseId)
      .filter(matches)
      .sort(compareSiblings)
      .slice(0, limit)
      .map(ref);
    if (out.length >= limit || this.queriesLocally(databaseId) || !this.online()) return out;
    if (options.signal?.aborted) return out;
    try {
      const answer = await this.query(databaseId, {
        filter: null,
        sorts: [],
        group: null,
        ...(query.trim() ? { search: query.trim() } : {}),
        context: this.queryContext(),
        limit,
      });
      const have = new Set(out.map((r) => r.id));
      for (const row of answer.rows)
        if (!have.has(row.id) && out.length < limit && !row.trashedAt && !row.isTemplate)
          out.push(ref(row));
    } catch {
      // Offline or refused: the rows on this device are what is found.
    }
    return out;
  }

  /**
   * A row a search found that this device does not hold, pulled as a page is when it is opened.
   * The server's hit names the row's database: that database is held and its query asked for
   * rows by the row's title, which keeps the rows it answers on this device; a row its title does
   * not find there (a template) comes with the next pass when the database is held in full. A hit
   * that names no database (a server before 0.4.0) asks each database not held in full by that
   * title until one has it. True when the row is on this device after.
   */
  async locateRow(rowId: Id, title: string, databaseId: Id | null = null): Promise<boolean> {
    if (await this.session.findRow(rowId)) return true;
    const sync = this.sync;
    const workspaceId = this.session.workspaceId;
    if (!sync || !sync.online() || !workspaceId) return false;
    const request: QueryRequest = {
      filter: null,
      sorts: [],
      group: null,
      search: title.trim(),
      context: this.queryContext(),
      limit: 100,
    };
    if (databaseId) {
      try {
        const hold = await sync.holdDatabase(databaseId);
        this.holds.set(databaseId, hold);
        if (title.trim()) await sync.queryDatabase(databaseId, request);
        if (await this.session.findRow(rowId)) return true;
        if (hold.mode !== 'full') return false;
        await sync.syncNow();
        return !!(await this.session.findRow(rowId));
      } catch {
        // Refused or offline: not found.
        return false;
      }
    }
    if (!title.trim()) return false;
    const peek = sync.peekQuery ?? sync.queryDatabase;
    for (const database of this.session.mirror.databases.values()) {
      const page = this.session.mirror.pages.get(database.id);
      if (database.workspaceId !== workspaceId || !page || page.trashedAt) continue;
      if (this.queriesLocally(database.id)) continue;
      try {
        const answer = await peek.call(sync, database.id, request);
        if (!answer.rows.some((r) => r.id === rowId)) continue;
        this.holds.set(database.id, await sync.holdDatabase(database.id));
        await sync.queryDatabase(database.id, request);
        return !!(await this.session.findRow(rowId));
      } catch {
        // Refused or offline: the next database, or nothing found.
      }
    }
    return false;
  }

  rowOrderKey(databaseId: Id, place: RowPlace): string {
    const rows = [...this.rowList(databaseId)].sort(compareSiblings);
    const { rowRecords } = this.session.mirror;
    const keyOf = (id: Id | null) =>
      id ? (rowRecords.get(id)?.orderKey ?? this.seen.get(id)?.orderKey ?? null) : null;
    let a: string | null;
    let b: string | null;
    if (place === 'end') {
      a = rows.at(-1)?.orderKey ?? null;
      b = null;
    } else if (place === 'start') {
      a = null;
      b = rows[0]?.orderKey ?? null;
    } else {
      a = keyOf(place.after);
      b = keyOf(place.before);
      if (place.after && !place.before) {
        const at = rows.findIndex((r) => r.id === place.after);
        b = at >= 0 ? (rows[at + 1]?.orderKey ?? null) : null;
      }
    }
    try {
      return keyBetween(a, b);
    } catch {
      // Keys out of order (rows this device does not hold): after the first one.
      return keyBetween(a, null);
    }
  }

  // ---- Changes ---------------------------------------------------------------------------------

  async apply(ops: Operation[]): Promise<void> {
    try {
      await this.session.apply(ops);
    } catch (error) {
      this.options.onError?.(error);
      throw error;
    }
    // The change is in the store now (durable): bench/phase4.mjs times a cell edit to here. One
    // mark at a time, so a long session keeps none.
    performance.clearMarks('cgw-db-applied');
    performance.mark('cgw-db-applied');
    // A row's title is found by search (its search entry, as a page's).
    const titled = ops.filter(
      (op) =>
        (op.type === 'page.update' && op.payload.title !== undefined) ||
        (op.type === 'page.create' && op.payload.kind === 'row' && op.payload.title),
    );
    if (titled.length <= 50) for (const op of titled) this.session.scheduleIndex(op.entityId, 300);
    // A row made from a row template starts with the template's body.
    for (const op of ops)
      if (op.type === 'page.create' && op.payload.kind === 'row' && op.payload.templateOfPageId)
        void this.session
          .copyBody(op.payload.templateOfPageId, op.entityId)
          .catch((error: unknown) => console.warn('The template body was not copied:', error));
  }

  newId = () => uuidv7();

  // ---- People and rights -----------------------------------------------------------------------

  me = (): Person | null => {
    const account = this.sync?.account() ?? null;
    if (!account) return (this.mePerson = null);
    const me = this.mePerson;
    if (me && me.id === account.id && me.name === account.displayName) return me;
    return (this.mePerson = { id: account.id, name: account.displayName, email: account.email });
  };

  people = (): Person[] => this.peopleList;

  /** The workspace's people: its members (kept on this device for offline), else just me. */
  async refreshPeople({ force = false }: { force?: boolean } = {}) {
    const workspace = this.session.current;
    const me = this.me();
    const synced = !!workspace && !workspace.localOnly && !!this.sync && !!me;
    const key = `${workspace?.id ?? ''}|${me?.id ?? ''}|${synced}`;
    if (!force && key === this.peopleKey) return;
    this.peopleKey = key;
    let list: Person[] = me ? [me] : [];
    if (workspace && synced) {
      try {
        const members = await this.sync!.members(workspace.id);
        list = members.map((m) => ({ id: m.userId, name: m.displayName, email: m.email }));
        void this.session.store.setPref(PEOPLE_PREF(workspace.id), list).catch(() => undefined);
      } catch {
        const kept = await this.session.store
          .getPref<Person[]>(PEOPLE_PREF(workspace.id))
          .catch(() => undefined);
        if (kept?.length) list = kept;
      }
    }
    if (key !== this.peopleKey) return;
    if (me && !list.some((p) => p.id === me.id)) list = [me, ...list];
    const same =
      list.length === this.peopleList.length &&
      list.every((p, i) => p.id === this.peopleList[i].id && p.name === this.peopleList[i].name);
    if (same) return;
    this.peopleList = list;
    this.schedule();
  }

  canEdit = (databaseId: Id): boolean => {
    const page = this.session.mirror.pages.get(databaseId);
    return !!page && !page.trashedAt && canEditPage(page);
  };

  queryContext = (): QueryContext => {
    const now = new Date();
    const today = localToday(now);
    const offsetMinutes = -now.getTimezoneOffset();
    const me = this.me()?.id ?? null;
    const key = `${today}|${offsetMinutes}|${me}`;
    if (this.context && key === this.contextKey && this.context.people === this.peopleNames)
      return this.context;
    this.contextKey = key;
    this.context = { today, offsetMinutes, me, people: this.peopleNames };
    return this.context;
  };

  private namesFor: Person[] | null = null;
  private names: Record<Id, string> = {};
  private get peopleNames(): Record<Id, string> {
    if (this.namesFor !== this.peopleList) {
      this.namesFor = this.peopleList;
      this.names = Object.fromEntries(this.peopleList.map((p) => [p.id, p.name]));
    }
    return this.names;
  }

  // ---- Files and navigation --------------------------------------------------------------------

  openRow = (rowId: Id) => this.open(rowId);
  openPage = (pageId: Id) => this.open(pageId);

  private open(pageId: Id) {
    if (this.options.open) this.options.open(pageId);
    else navigate({ kind: 'page', pageId });
  }

  openExternal = (url: string) => this.options.openExternal?.(url);

  // ---- CSV (the server's routes, for a synced workspace) ---------------------------------------

  /** Whether the open workspace syncs: the server's CSV routes are offered then. */
  private syncsCurrent(): boolean {
    const workspace = this.session.current;
    return !!this.sync && !!workspace && !workspace.localOnly;
  }

  get importCsv(): ImportCsv | undefined {
    return this.syncsCurrent() ? this.importOnServer : undefined;
  }

  get exportCsv(): ExportCsv | undefined {
    return this.syncsCurrent() ? this.exportFromServer : undefined;
  }

  private readonly importOnServer: ImportCsv = async (databaseId, request) => {
    const sync = this.sync;
    if (!sync || !sync.online()) throw new Error('offline');
    try {
      // A database the dialog has just made (or a change to it) reaches the server first.
      await this.session.flushAll();
      await this.untilSent(databaseId, sync);
      return await sync.importCsv(databaseId, request);
    } catch (error) {
      throw new Error(
        error instanceof Error && error.message === 'offline' ? 'offline' : noticeCode(error),
        { cause: error },
      );
    }
  };

  /** Passes run until no operation on the database waits in the outbox (a few at most). */
  private async untilSent(databaseId: Id, sync: DatabaseSync) {
    const workspaceId = this.session.mirror.pages.get(databaseId)?.workspaceId;
    for (let pass = 0; pass < 8; pass++) {
      const waiting = await this.session.store.nextOutboxBatch(10_000, workspaceId);
      if (!waiting.some((op) => op.entityId === databaseId)) return;
      await sync.syncNow();
      if (!sync.online()) break;
    }
    throw new Error('offline');
  }

  private readonly exportFromServer: ExportCsv = async (databaseId, viewId) => {
    const sync = this.sync;
    if (!sync || !sync.online()) throw new Error('offline');
    try {
      const bytes = await sync.exportCsv(databaseId, viewId, this.queryContext());
      return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'text/csv;charset=utf-8' });
    } catch (error) {
      throw new Error(noticeCode(error), { cause: error });
    }
  };

  saveFile = async (fileName: string, data: Blob): Promise<void> => {
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (this.options.saveFile)
      await this.options.saveFile(fileName, bytes, data.type || 'text/csv;charset=utf-8');
  };
}

/** A refusal as the notice code the views show (`offline`, `db.tooLarge`, `access.denied`, ...). */
export function noticeCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'server.error';
  const named = error as { name?: string; code?: string; status?: number };
  if (named.name === 'OfflineError' || named.name === 'NetworkError' || error instanceof TypeError)
    return 'offline';
  if (named.code) return named.code;
  return 'server.error';
}
