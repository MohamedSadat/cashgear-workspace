// A database on a page shared by link (Phase 9; DECISIONS.md, "2026-11-17: Phase 9"): the
// database views and the chart and board blocks drawn read-only over a `DatabaseHost` of the
// share link's own routes, with no account. The server answers by the view the block names (its
// filter, sorts and group, and the toolbar's title search): never a filter, sort or group the
// reader sends, so the query sends only the view's id; and only the view's shown properties'
// values come in the rows, people's never, and a related row's title only when its database is
// in the link's scope. Row pages stay closed. Nothing is stored on this device and nothing is
// written: every change is refused here, and the server would refuse it too.
//
// A query grouped as its view is (a board, a grouped table) pages as the server groups it; a
// query grouped some other way (a chart's or a board block's own property) gathers the view's rows
// (up to `GATHER_LIMIT`) and groups them here, by the values the rows carry.
import type {
  DatabaseHost,
  DatabaseRef,
  Person,
  RowGroup,
  RowRef,
  RowRequest,
  RowSnapshot,
  RowSource,
} from '@cgw/database';
import {
  groupKeys,
  keyBetween,
  queryRows,
  uuidv7,
  type CellValue,
  type DatabaseRecord,
  type DateWindow,
  type GroupCount,
  type GroupRule,
  type Id,
  type PageRecord,
  type PropertyDef,
  type PropertyId,
  type QueryContext,
  type RowRecord,
  type Value,
  type ViewConfig,
  type ViewRecord,
  type ViewType,
} from '@cgw/workspace';

// ---- The routes ----------------------------------------------------------------------------------

export class SharedReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
    this.name = 'SharedReadError';
  }
}

interface ViewDto {
  id: string;
  workspaceId?: string;
  databaseId?: string;
  name: string;
  type: string;
  orderKey: string;
  config: unknown;
  version?: number | string;
  createdAt?: string;
}

interface RowDto {
  id: string;
  databaseId: string;
  title?: string;
  icon?: string | null;
  orderKey?: string;
  coverAssetId?: string | null;
  values?: unknown;
  computed?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

/** `GET /shared/databases/{id}`: the database, when its page is in the link's scope. */
export interface SharedDatabaseAnswer {
  database: {
    id: string;
    title: string;
    icon: string | null;
    properties: unknown;
    workspaceId?: string;
    version?: number | string;
    rowCount?: number | string;
    createdAt?: string;
  };
  views: ViewDto[];
}

/**
 * What a shared query sends: the view, paging, the title search, and the reader's today and
 * offset (for the view's relative dates); nothing else is taken.
 */
export interface SharedQuery {
  viewId: Id;
  groupKey?: string;
  after?: string | null;
  limit?: number;
  search?: string;
  context?: { today: string; offsetMinutes: number };
  /** Phase 9: a calendar's or a timeline's days, on its own date property (the server checks). */
  window?: DateWindow;
  /** Phase 9: a calendar's or a timeline's rows with no date, by the view's own date property. */
  undated?: true;
}

/** `POST /shared/databases/{id}/query`, as the server's query answers, with related titles. */
export interface SharedQueryAnswer {
  rows: RowDto[];
  groups: { key: string; count: number | string }[] | null;
  total: number | string;
  next: string | null;
  titles?: Record<string, string>;
}

export interface SharedDatabaseApi {
  database(databaseId: Id): Promise<SharedDatabaseAnswer>;
  query(databaseId: Id, query: SharedQuery): Promise<SharedQueryAnswer>;
}

/** The share link's database routes: the token in a header only, never a cookie. */
export function sharedDatabaseApi(
  apiBase: string,
  token: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): SharedDatabaseApi {
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetcher(`${apiBase}/api/v1/shared${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'X-Share-Token': token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      credentials: 'omit',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      let code = response.status === 429 ? 'limit.rate' : 'server.error';
      try {
        const problem = (await response.json()) as { code?: string };
        if (problem?.code) code = problem.code;
      } catch {
        // Not a problem body: the status says enough.
      }
      throw new SharedReadError(response.status, code);
    }
    return (await response.json()) as T;
  };
  return {
    database: (databaseId) => call(`/databases/${encodeURIComponent(databaseId)}`),
    query: (databaseId, query) => call(`/databases/${encodeURIComponent(databaseId)}/query`, query),
  };
}

// ---- Records from the answers ------------------------------------------------------------------------

const EMPTY_CONFIG: ViewConfig = {
  filter: null,
  sorts: [],
  group: null,
  properties: { order: [], hidden: [], widths: {} },
};

const configOf = (raw: unknown): ViewConfig => {
  const config = (raw && typeof raw === 'object' ? raw : {}) as Partial<ViewConfig>;
  return {
    ...EMPTY_CONFIG,
    ...config,
    properties: { ...EMPTY_CONFIG.properties, ...(config.properties ?? {}) },
  };
};

function databaseOf(answer: SharedDatabaseAnswer): DatabaseRecord {
  const d = answer.database;
  return {
    id: d.id,
    workspaceId: d.workspaceId ?? answer.views[0]?.workspaceId ?? '',
    properties: Array.isArray(d.properties) ? (d.properties as PropertyDef[]) : [],
    version: Number(d.version ?? 0),
    rowCount: Number(d.rowCount ?? 0),
    createdAt: d.createdAt ?? '',
  };
}

function viewOf(databaseId: Id, workspaceId: Id, v: ViewDto): ViewRecord {
  return {
    id: v.id,
    workspaceId: v.workspaceId ?? workspaceId,
    databaseId: v.databaseId ?? databaseId,
    name: v.name ?? '',
    // Kept as the server says: a type this build does not know is drawn as a table by the views.
    type: v.type as ViewType,
    orderKey: v.orderKey ?? '',
    config: configOf(v.config),
    version: Number(v.version ?? 0),
    createdAt: v.createdAt ?? '',
  };
}

/** A read-only page record for the database's own page (title and icon, nothing else known). */
function pageOf(database: DatabaseRecord, title: string, icon: string | null): PageRecord {
  return {
    id: database.id,
    workspaceId: database.workspaceId,
    sectionId: '',
    parentPageId: null,
    orderKey: '',
    kind: 'database',
    title,
    icon,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 0,
    createdAt: database.createdAt,
    updatedAt: database.createdAt,
    trashedAt: null,
    trashRootId: null,
    access: 'view',
  };
}

export function rowOf(dto: RowDto, workspaceId: Id): RowRecord {
  return {
    id: dto.id,
    workspaceId,
    sectionId: '',
    parentPageId: dto.databaseId,
    orderKey: dto.orderKey ?? '',
    kind: 'row',
    title: dto.title ?? '',
    icon: dto.icon ?? null,
    coverAssetId: dto.coverAssetId ?? null,
    isTemplate: false,
    templateOfPageId: null,
    version: 0,
    createdAt: dto.createdAt ?? '',
    updatedAt: dto.updatedAt ?? dto.createdAt ?? '',
    trashedAt: null,
    trashRootId: null,
    access: 'view',
    databaseId: dto.databaseId,
    values: (dto.values && typeof dto.values === 'object' ? dto.values : {}) as Record<
      PropertyId,
      Value
    >,
    versions: {},
    computed: (dto.computed && typeof dto.computed === 'object' ? dto.computed : {}) as Record<
      PropertyId,
      CellValue
    >,
    computedVersion: null,
    // People are never sent by link, and never shown.
    createdBy: null,
    updatedBy: null,
  };
}

// ---- The host ------------------------------------------------------------------------------------

/** Rows a source asks for at a time (the server allows at most 500). */
const PAGE_SIZE = 100;
/** Rows gathered at most for a query grouped another way than its view (a chart's, a board's). */
export const GATHER_LIMIT = 2000;

interface Entry {
  state: 'loading' | 'ready' | 'failed';
  database: DatabaseRecord | null;
  views: ViewRecord[];
  page: PageRecord | null;
}

export interface SharedDatabaseHostOptions {
  /** A page of the link's scope: its title and icon (the shared tree's). */
  pageTitle(pageId: Id): string | undefined;
  pageIcon?(pageId: Id): string | null | undefined;
  /** Opens a page of the link's scope (the database's own page); nothing for another. */
  openPage(pageId: Id): void;
  openExternal?(url: string): void;
  /** Images and files, by the link's own signed URLs. */
  assetUrl?(assetId: Id): Promise<string | null>;
}

const READ_ONLY = 'access.denied';

export class SharedDatabaseHost implements DatabaseHost {
  private readonly entries = new Map<Id, Entry>();
  private readonly listeners = new Set<() => void>();
  /** Rows the answers brought, and related rows' titles: for `page` and `pageTitle`. */
  private readonly seen = new Map<Id, RowRecord>();
  private readonly titles = new Map<Id, string>();
  private scheduled = false;
  private context: QueryContext | null = null;
  readonly assets: DatabaseHost['assets'];

  constructor(
    private readonly api: SharedDatabaseApi,
    private readonly options: SharedDatabaseHostOptions,
  ) {
    const assetUrl = options.assetUrl;
    this.assets = assetUrl
      ? {
          url: (assetId) => assetUrl(assetId),
          info: () => undefined,
          store: async () => null,
          pick: async () => [],
          open: (assetId) =>
            void assetUrl(assetId).then((url) => url && this.options.openExternal?.(url)),
        }
      : undefined;
  }

  /** Everything read changed: told once, after the current task. */
  private emit() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const listener of [...this.listeners]) listener();
    });
  }

  /** The database's record and views, asked for once; a refusal leaves it missing. */
  private entry(databaseId: Id): Entry {
    let entry = this.entries.get(databaseId);
    if (entry) return entry;
    entry = { state: 'loading', database: null, views: [], page: null };
    this.entries.set(databaseId, entry);
    const loading = entry;
    this.api.database(databaseId).then(
      (answer) => {
        const database = databaseOf(answer);
        loading.state = 'ready';
        loading.database = database;
        loading.views = answer.views
          .map((v) => viewOf(databaseId, database.workspaceId, v))
          .sort((a, b) =>
            a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1,
          );
        loading.page = pageOf(
          database,
          answer.database.title ?? this.options.pageTitle(databaseId) ?? '',
          answer.database.icon ?? this.options.pageIcon?.(databaseId) ?? null,
        );
        this.emit();
      },
      () => {
        loading.state = 'failed';
        this.emit();
      },
    );
    return entry;
  }

  /** Whether the database could be read by this link (undefined while it is asked). */
  readable(databaseId: Id): boolean | undefined {
    const state = this.entry(databaseId).state;
    return state === 'loading' ? undefined : state === 'ready';
  }

  // ---- Records ------------------------------------------------------------------------------

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  database = (databaseId: Id) => this.entry(databaseId).database;

  views = (databaseId: Id) => this.entry(databaseId).views;

  page = (pageId: Id): PageRecord | RowRecord | null =>
    this.entries.get(pageId)?.page ?? this.seen.get(pageId) ?? null;

  pageTitle = (pageId: Id): string | undefined =>
    this.entries.get(pageId)?.page?.title ??
    this.seen.get(pageId)?.title ??
    this.titles.get(pageId) ??
    this.options.pageTitle(pageId);

  rowTemplates = (): RowRecord[] => NO_ROWS;

  databases = (): DatabaseRef[] => NO_DATABASES;

  // ---- Rows ----------------------------------------------------------------------------------

  rows(databaseId: Id, request: RowRequest): RowSource {
    return new SharedRowSource(this, databaseId, request);
  }

  /** A page of the view's rows from the server; the rows and related titles are remembered. */
  async fetch(databaseId: Id, query: SharedQuery): Promise<SharedQueryAnswer> {
    const answer = await this.api.query(databaseId, query);
    for (const [id, title] of Object.entries(answer.titles ?? {}))
      if (typeof title === 'string') this.titles.set(id, title);
    return answer;
  }

  remember(row: RowRecord) {
    if (this.seen.size > 20_000) this.seen.clear();
    this.seen.set(row.id, row);
  }

  async searchRows(): Promise<RowRef[]> {
    return [];
  }

  /** Nothing is placed by link: any key will do. */
  rowOrderKey(): string {
    return keyBetween(null, null);
  }

  // ---- Changes: none by link -------------------------------------------------------------------

  async apply(): Promise<void> {
    throw new Error(READ_ONLY);
  }

  newId = () => uuidv7();

  // ---- People and rights: no one, and read only ----------------------------------------------

  me = (): Person | null => null;
  people = (): Person[] => NO_PEOPLE;
  canEdit = () => false;

  queryContext = (): QueryContext => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const offsetMinutes = -now.getTimezoneOffset();
    if (this.context?.today === today && this.context.offsetMinutes === offsetMinutes)
      return this.context;
    this.context = { today, offsetMinutes, me: null, people: {} };
    return this.context;
  };

  // ---- Navigation: row pages stay closed ---------------------------------------------------------

  openRow = (): void => {};

  openPage = (pageId: Id) => this.options.openPage(pageId);

  openExternal = (url: string) => this.options.openExternal?.(url);
}

const NO_ROWS: RowRecord[] = [];
const NO_DATABASES: DatabaseRef[] = [];
const NO_PEOPLE: Person[] = [];

const LOADING: RowSnapshot = {
  rows: [],
  groups: null,
  total: 0,
  complete: false,
  localOnly: false,
  loading: true,
  error: null,
};

/** The group's identity for the server's grouping: what it groups by, not how it is shown. */
const groupIdentity = (rule: GroupRule | null | undefined) =>
  rule ? JSON.stringify({ propertyId: rule.propertyId, dateBy: rule.dateBy ?? null }) : null;

/** A refusal as the notice code the views show. */
function codeOf(error: unknown): string {
  if (error instanceof SharedReadError) return error.code;
  if (error instanceof TypeError) return 'offline';
  return 'server.error';
}

/**
 * A view's rows by link: the server's pages of the view's query. Grouped as the view is, the
 * server's group counts and each group's own pages; grouped another way, every row gathered (up
 * to `GATHER_LIMIT`) and grouped here.
 */
export class SharedRowSource implements RowSource {
  private readonly listeners = new Set<() => void>();
  private current: RowSnapshot = LOADING;
  private closed = false;
  private generation = 0;
  private readonly pageSize: number;
  private order: Id[] = [];
  private rows = new Map<Id, RowRecord>();
  private next: string | null = null;
  private total = 0;
  private serverGroups: GroupCount[] | null = null;
  private groupRows = new Map<string, Id[]>();
  private groupNext = new Map<string, string | null>();
  private loading = false;
  private error: string | null = null;
  private started = false;
  private readonly offHost: () => void;

  constructor(
    private readonly host: SharedDatabaseHost,
    readonly databaseId: Id,
    private readonly request: RowRequest,
  ) {
    this.pageSize = Math.max(1, Math.min(500, Math.floor(request.pageSize ?? PAGE_SIZE)));
    // The database and its views come first: the query names a view of it.
    this.offHost = host.subscribe(() => this.start());
    this.start();
  }

  /** The view the query is for: the one named, else the database's first. */
  private view(): ViewRecord | null {
    const views = this.host.views(this.databaseId);
    return views.find((v) => v.id === this.request.viewId) ?? views[0] ?? null;
  }

  /** The rows are grouped here, not by the server: the query groups another way than its view. */
  private gathers(): boolean {
    const wanted = groupIdentity(this.request.spec.group);
    return wanted !== null && wanted !== groupIdentity(this.view()?.config.group);
  }

  private start() {
    if (this.started || this.closed) return;
    const readable = this.host.readable(this.databaseId);
    if (readable === undefined) return;
    this.started = true;
    if (!readable || !this.view()) {
      this.set({ ...LOADING, loading: false, complete: true, error: READ_ONLY });
      return;
    }
    void this.fetch(null);
  }

  private query(after: string | null, groupKey?: string): SharedQuery {
    const search = this.request.spec.search?.trim();
    const { today, offsetMinutes } = this.host.queryContext();
    return {
      viewId: this.view()!.id,
      ...(groupKey !== undefined ? { groupKey } : {}),
      ...(after ? { after } : {}),
      limit: this.gathers() ? 500 : this.pageSize,
      ...(search ? { search } : {}),
      context: { today, offsetMinutes },
      ...(this.request.spec.window ? { window: this.request.spec.window } : {}),
      ...(this.request.undated ? { undated: true as const } : {}),
    };
  }

  private async fetch(after: string | null, groupKey?: string) {
    const generation = this.generation;
    this.loading = true;
    this.error = null;
    this.build();
    try {
      const answer = await this.host.fetch(this.databaseId, this.query(after, groupKey));
      if (this.closed || generation !== this.generation) return;
      const workspaceId = this.host.database(this.databaseId)?.workspaceId ?? '';
      const ids: Id[] = [];
      for (const dto of answer.rows) {
        const row = rowOf(dto, workspaceId);
        this.rows.set(row.id, row);
        this.host.remember(row);
        ids.push(row.id);
      }
      if (groupKey === undefined) {
        const have = new Set(this.order);
        this.order.push(...ids.filter((id) => !have.has(id)));
        this.next = answer.next ?? null;
        this.total = Number(answer.total);
        if (answer.groups)
          this.serverGroups = answer.groups.map((g) => ({ key: g.key, count: Number(g.count) }));
      } else {
        const list = this.groupRows.get(groupKey) ?? [];
        const have = new Set(list);
        list.push(...ids.filter((id) => !have.has(id)));
        this.groupRows.set(groupKey, list);
        this.groupNext.set(groupKey, answer.next ?? null);
      }
      this.loading = false;
      // Grouped another way than its view: every row, page after page, up to the limit.
      if (
        groupKey === undefined &&
        this.gathers() &&
        this.next &&
        this.order.length < GATHER_LIMIT
      ) {
        void this.fetch(this.next);
        return;
      }
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      this.loading = false;
      this.error = codeOf(error);
    }
    this.build();
  }

  private build() {
    const database = this.host.database(this.databaseId);
    if (!database) return this.set({ ...LOADING, loading: this.loading });
    const flat = this.order.map((id) => this.rows.get(id)!).filter(Boolean);
    const rule = this.request.spec.group;
    if (!rule) {
      return this.set({
        rows: flat,
        groups: null,
        total: this.total,
        complete: this.next === null,
        localOnly: false,
        loading: this.loading,
        error: this.error,
      });
    }
    const ctx = this.host.queryContext();
    const gathered = this.gathers();
    let counts: GroupCount[] | null;
    let pool: RowRecord[] = flat;
    if (gathered) {
      counts = queryRows(database, flat, { filter: null, sorts: [], group: rule }, ctx).groups;
    } else {
      counts = this.serverGroups;
      const extra = new Set<Id>(flat.map((r) => r.id));
      for (const list of this.groupRows.values())
        for (const id of list)
          if (!extra.has(id)) {
            extra.add(id);
            const row = this.rows.get(id);
            if (row) pool = [...pool, row];
          }
    }
    const groups = this.grouped(database, pool, counts ?? [], rule, ctx, gathered);
    this.set({
      rows: groups.flatMap((g) => g.rows),
      groups,
      total: gathered ? flat.length : this.total,
      complete: groups.every((g) => g.complete),
      localOnly: false,
      loading: this.loading,
      error: this.error,
    });
  }

  /** Rows placed in their groups (a row in every group it holds), in group order. */
  private grouped(
    database: DatabaseRecord,
    rows: readonly RowRecord[],
    counts: GroupCount[],
    rule: GroupRule,
    ctx: QueryContext,
    gathered: boolean,
  ): RowGroup[] {
    const hidden = new Set(rule.hidden ?? []);
    const shown = counts.filter((g) => !hidden.has(g.key) && !(rule.hideEmpty && g.count === 0));
    const byKey = new Map(shown.map((g) => [g.key, [] as RowRecord[]]));
    for (const row of rows)
      for (const key of groupKeys(database, row, rule, ctx)) byKey.get(key)?.push(row);
    return shown.map((g) => {
      const groupRows = byKey.get(g.key)!;
      return {
        key: g.key,
        count: g.count,
        rows: groupRows,
        complete: gathered
          ? this.next === null || this.order.length >= GATHER_LIMIT
          : this.next === null || this.groupNext.get(g.key) === null || groupRows.length >= g.count,
      };
    });
  }

  private set(snapshot: RowSnapshot) {
    this.current = snapshot;
    for (const listener of [...this.listeners]) listener();
  }

  snapshot = () => this.current;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  loadMore(groupKey?: string) {
    if (this.loading || !this.started || this.gathers()) return;
    if (groupKey !== undefined && this.serverGroups) {
      if (this.next === null || this.groupNext.get(groupKey) === null) return;
      void this.fetch(this.groupNext.get(groupKey) ?? null, groupKey);
    } else if (this.next !== null) void this.fetch(this.next);
  }

  retry() {
    this.generation++;
    this.order = [];
    this.rows = new Map();
    this.next = null;
    this.total = 0;
    this.serverGroups = null;
    this.groupRows = new Map();
    this.groupNext = new Map();
    this.started = false;
    this.start();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.offHost();
    this.listeners.clear();
  }
}
