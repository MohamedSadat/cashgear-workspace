// A view's rows (the `RowSource` of contract section 7), live. Three ways to read them, picked
// again whenever the hold, the network or the rows change:
//
// - local: every row of the database is on this device (a local workspace, a full and complete
//   hold): `queryRows` over them, formulas and rollups computed here; every row at once.
// - server: the server's query, keyset paged (`loadMore`, per group with a group key). Its rows
//   are kept on this device by the engine (a partial hold is that cache), and each row shown is
//   the freshest this device has, so edits show at once; rows made after the view opened that
//   match its filter are added at the end until the query runs again.
// - device: offline (or signed out) for a database not held in full: the rows this device has,
//   queried here, flagged `localOnly` ("showing rows on this device").
import type { RowGroup, RowRequest, RowSnapshot, RowSource } from '@cgw/database';
import {
  groupKeys,
  matchesFilter,
  queryRows,
  type DatabaseRecord,
  type GroupCount,
  type Id,
  type QueryContext,
  type QueryRequest,
  type RowRecord,
} from '@cgw/workspace';
import { noticeCode, type ShellDatabaseHost, type SourceMode } from './host';

const LOADING: RowSnapshot = {
  rows: [],
  groups: null,
  total: 0,
  complete: false,
  localOnly: false,
  loading: true,
  error: null,
};

interface ServerState {
  /** The flat query's rows, in its order, and the cursor after them (null: all came). */
  order: Id[];
  next: string | null;
  total: number;
  groups: GroupCount[] | null;
  /** Rows a group's own pages brought, and each group's cursor (absent: not asked yet). */
  groupRows: Map<string, Id[]>;
  groupNext: Map<string, string | null>;
  /** Every row the answers brought, by id. */
  rows: Map<Id, RowRecord>;
  loading: boolean;
  error: string | null;
  /** Rises with every answer. */
  version: number;
}

const same = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export class ShellRowSource implements RowSource {
  private readonly listeners = new Set<() => void>();
  private readonly closers: (() => void)[] = [];
  private current: RowSnapshot = LOADING;
  private mode: SourceMode = 'pending';
  private closed = false;
  /** The server could not be reached (or nobody is signed in): this device's rows until it can. */
  private offline = false;
  private server: ServerState | null = null;
  private generation = 0;
  private key: readonly unknown[] = [];
  private readonly openedAt = new Date().toISOString();
  private readonly pageSize: number;

  constructor(
    private readonly host: ShellDatabaseHost,
    readonly databaseId: Id,
    private readonly request: RowRequest,
  ) {
    this.pageSize = Math.max(1, Math.min(500, Math.floor(request.pageSize ?? 100)));
    void this.restart();
  }

  /** Holds the database (when it can) and reads where the rows come from again. */
  async restart() {
    await this.host.prepare(this.databaseId).catch(() => undefined);
    this.refresh();
  }

  onClose(listener: () => void) {
    this.closers.push(listener);
  }

  /** The network came back, or went: a source on the device's rows tries the server again. */
  onlineChanged(online: boolean) {
    if (online && this.offline) {
      this.offline = false;
      this.refresh();
    }
  }

  /** Something it reads may have changed (the host calls this after every change). */
  refresh() {
    if (this.closed) return;
    const mode = this.host.modeFor(this.databaseId, this.offline);
    if (mode !== this.mode) {
      this.mode = mode;
      this.key = [];
      this.generation++;
      this.server = null;
      if (mode === 'server') void this.fetch(null);
    }
    if (mode === 'pending') return;
    if (mode === 'server') this.buildServer();
    else this.buildLocal(mode === 'device');
  }

  // ---- Rows queried on this device ---------------------------------------------------------------

  private buildLocal(localOnly: boolean) {
    const database = this.host.database(this.databaseId);
    const rows = database ? this.host.rowList(this.databaseId) : [];
    const ctx = this.host.queryContext();
    const key = [database, rows, ctx, localOnly, database ? this.host.computeKey(database) : ''];
    if (same(key, this.key)) return;
    this.key = key;
    if (!database) return this.set({ ...LOADING, complete: true, loading: false, localOnly });
    const input = rows.map((row) => this.host.withComputed(row));
    const result = queryRows(database, input, this.request.spec, ctx);
    const groups = this.grouped(database, result.rows, result.groups, ctx, () => true);
    this.set({
      rows: groups ? groups.flatMap((g) => g.rows) : result.rows,
      groups,
      total: result.rows.length,
      complete: true,
      localOnly,
      loading: false,
      error: null,
    });
  }

  /** Rows placed in their groups (a row in every group it holds), in group order. */
  private grouped(
    database: DatabaseRecord,
    rows: readonly RowRecord[],
    counts: GroupCount[] | null,
    ctx: QueryContext,
    complete: (group: GroupCount, rows: RowRecord[]) => boolean,
  ): RowGroup[] | null {
    const rule = this.request.spec.group;
    if (!counts || !rule) return null;
    const hidden = new Set(rule.hidden ?? []);
    const shown = counts.filter((g) => !hidden.has(g.key) && !(rule.hideEmpty && g.count === 0));
    const byKey = new Map(shown.map((g) => [g.key, [] as RowRecord[]]));
    for (const row of rows)
      for (const key of groupKeys(database, row, rule, ctx)) byKey.get(key)?.push(row);
    return shown.map((g) => {
      const groupRows = byKey.get(g.key)!;
      return { key: g.key, count: g.count, rows: groupRows, complete: complete(g, groupRows) };
    });
  }

  // ---- Rows from the server's query --------------------------------------------------------------

  private requestFor(after: string | null, groupKey?: string): QueryRequest {
    const { spec } = this.request;
    return {
      filter: spec.filter,
      sorts: spec.sorts,
      group: spec.group,
      ...(spec.search ? { search: spec.search } : {}),
      ...(groupKey !== undefined ? { groupKey } : {}),
      context: this.host.queryContext(),
      after,
      limit: this.pageSize,
    };
  }

  /** A page of the query: the first (`after` null) starts again; a group's pages that group. */
  private async fetch(after: string | null, groupKey?: string) {
    const generation = this.generation;
    const first = after === null && groupKey === undefined;
    if (first)
      this.server = {
        order: [],
        next: null,
        total: 0,
        groups: null,
        groupRows: new Map(),
        groupNext: new Map(),
        rows: new Map(),
        loading: true,
        error: null,
        version: 0,
      };
    const state = this.server;
    if (!state) return;
    state.loading = true;
    state.error = null;
    state.version++;
    this.buildServer();
    try {
      const answer = await this.host.query(this.databaseId, this.requestFor(after, groupKey));
      if (this.closed || generation !== this.generation || state !== this.server) return;
      for (const row of answer.rows) state.rows.set(row.id, row);
      const ids = answer.rows.map((r) => r.id);
      if (groupKey === undefined) {
        const have = new Set(state.order);
        state.order.push(...ids.filter((id) => !have.has(id)));
        state.next = answer.next;
        state.total = answer.total;
        if (answer.groups) state.groups = answer.groups;
      } else {
        const list = state.groupRows.get(groupKey) ?? [];
        const have = new Set(list);
        list.push(...ids.filter((id) => !have.has(id)));
        state.groupRows.set(groupKey, list);
        state.groupNext.set(groupKey, answer.next);
      }
      state.loading = false;
    } catch (error) {
      if (this.closed || generation !== this.generation || state !== this.server) return;
      state.loading = false;
      const code = noticeCode(error);
      if (code === 'offline' || code === 'auth.required') {
        // The rows on this device, until the server answers again.
        this.offline = true;
        this.refresh();
        return;
      }
      state.error = code;
    }
    state.version++;
    this.buildServer();
  }

  private buildServer() {
    const state = this.server;
    const database = this.host.database(this.databaseId);
    if (!state || !database) return this.set({ ...LOADING });
    const ctx = this.host.queryContext();
    const local = this.host.rowList(this.databaseId);
    const key = [state, state.version, database, local, ctx, this.host.computeKey(database)];
    if (same(key, this.key)) return;
    this.key = key;
    const { rowRecords } = this.host.session.mirror;
    /** The freshest copy of a row: this device's when it holds one (an edit shows at once). */
    const fresh = (id: Id) => rowRecords.get(id) ?? state.rows.get(id);
    const live = (row: RowRecord | undefined): row is RowRecord =>
      !!row && !row.trashedAt && !row.isTemplate && row.databaseId === this.databaseId;
    const shown = new Set<Id>();
    const rows: RowRecord[] = [];
    for (const id of state.order) {
      const row = fresh(id);
      if (!live(row)) continue;
      shown.add(id);
      rows.push(this.host.withComputed(row));
    }
    // Rows made since the view opened (here, or brought by the feed) that its filter takes.
    const added: RowRecord[] = [];
    for (const row of local)
      if (
        live(row) &&
        !shown.has(row.id) &&
        !state.rows.has(row.id) &&
        row.createdAt >= this.openedAt &&
        matchesFilter(database, row, this.request.spec.filter, ctx)
      )
        added.push(this.host.withComputed(row));
    const gone = state.order.length - shown.size;
    const total = Math.max(0, state.total + added.length - gone);
    if (state.groups && this.request.spec.group) {
      const extra = new Set<Id>();
      for (const list of state.groupRows.values()) for (const id of list) extra.add(id);
      const pool = [...rows];
      for (const id of extra) {
        if (shown.has(id)) continue;
        const row = fresh(id);
        if (live(row)) pool.push(this.host.withComputed(row));
      }
      pool.push(...added);
      const groups = this.grouped(
        database,
        pool,
        state.groups,
        ctx,
        (g, groupRows) =>
          state.next === null || state.groupNext.get(g.key) === null || groupRows.length >= g.count,
      );
      return this.set({
        rows: groups!.flatMap((g) => g.rows),
        groups,
        total,
        complete: groups!.every((g) => g.complete),
        localOnly: false,
        loading: state.loading,
        error: state.error,
      });
    }
    this.set({
      rows: added.length ? [...rows, ...added] : rows,
      groups: null,
      total,
      complete: state.next === null,
      localOnly: false,
      loading: state.loading,
      error: state.error,
    });
  }

  // ---- RowSource ---------------------------------------------------------------------------------

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
    const state = this.server;
    if (this.mode !== 'server' || !state || state.loading) return;
    if (groupKey !== undefined && state.groups) {
      if (state.next === null || state.groupNext.get(groupKey) === null) return;
      void this.fetch(state.groupNext.get(groupKey) ?? null, groupKey);
    } else if (state.next !== null) void this.fetch(state.next);
  }

  retry() {
    this.offline = false;
    this.mode = 'pending';
    void this.restart();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.listeners.clear();
    for (const closer of this.closers) closer();
  }
}
