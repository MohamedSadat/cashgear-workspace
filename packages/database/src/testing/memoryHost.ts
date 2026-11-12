// A `DatabaseHost` in memory, for the tests and the browser harness: databases, views and rows
// kept as plain records, the operations the views send applied by the core's own rules
// (`coerceValue`, `convertProperty`, relations two-way), rows queried by `queryRows` and computed by
// `computeRow`. Optionally paged, as the server's query is, to exercise "load more". It is not the
// planner: the stores stream's planner is what the app runs.
import {
  compareSiblings,
  keyBetween,
  normaliseText,
  searchTerms,
  type Id,
  type Operation,
  type PageRecord,
  type RowRecord,
} from '@cgw/workspace';
import {
  coerceValue,
  computeRow,
  convertProperty,
  groupKeys,
  queryRows,
  type CellValue,
  type DatabaseRecord,
  type PropertyDef,
  type PropertyId,
  type QueryContext,
  type QuerySpec,
  type Value,
  type ViewRecord,
} from '../core';
import type {
  AssetInfo,
  DatabaseAssets,
  DatabaseHost,
  DatabaseRef,
  Person,
  RowGroup,
  RowPlace,
  RowRef,
  RowRequest,
  RowSnapshot,
  RowSource,
} from '../host';

export interface MemoryHostOptions {
  /** Rows per page the sources give (null: every row at once, as a full local hold does). */
  pageSize?: number | null;
  people?: Person[];
  me?: Person | null;
  canEdit?: boolean;
  /** The query context's today (default: the local date). */
  today?: string;
}

interface Listener {
  (): void;
}

let idCounter = 0;
/** Ids for tests: UUID-shaped, increasing, unique in the process. */
export function testId(): Id {
  idCounter++;
  const hex = idCounter.toString(16).padStart(12, '0');
  return `0190a000-0000-7000-8000-${hex}`;
}

export class MemoryDatabaseHost implements DatabaseHost {
  readonly pages = new Map<Id, PageRecord>();
  readonly records = new Map<Id, DatabaseRecord>();
  readonly viewRecords = new Map<Id, ViewRecord>();
  readonly rowRecords = new Map<Id, RowRecord>();
  readonly applied: Operation[] = [];
  readonly opened: { kind: 'row' | 'page' | 'link'; id: string }[] = [];
  private listeners = new Set<Listener>();
  private rowListeners = new Set<(changed: Set<Id>, props: Set<PropertyId> | null) => void>();
  private viewCache = new Map<Id, ViewRecord[]>();
  private templateCache = new Map<Id, RowRecord[]>();
  private databaseCache: DatabaseRef[] | null = null;
  private peopleList: Person[];
  private mePerson: Person | null;
  editable: boolean;
  pageSize: number | null;
  today: string;
  assets: DatabaseAssets;
  private files = new Map<Id, { info: AssetInfo; url: string | null }>();

  constructor(options: MemoryHostOptions = {}) {
    this.peopleList = options.people ?? [];
    this.mePerson = options.me ?? this.peopleList[0] ?? null;
    this.editable = options.canEdit ?? true;
    this.pageSize = options.pageSize ?? null;
    const now = new Date();
    this.today =
      options.today ??
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    this.assets = {
      url: async (id) => this.files.get(id)?.url ?? null,
      info: (id) => this.files.get(id)?.info,
      store: async (file) => {
        const id = this.newId();
        this.files.set(id, {
          info: { fileName: file.name, sizeBytes: file.size, contentType: file.type },
          url: null,
        });
        return { assetId: id, width: null, height: null };
      },
      pick: async () => [],
      open: (id) => this.opened.push({ kind: 'link', id }),
    };
  }

  // ---- Seeding ------------------------------------------------------------------------------
  addDatabase(page: PageRecord, record: DatabaseRecord, views: ViewRecord[], rows: RowRecord[]) {
    this.pages.set(page.id, page);
    this.records.set(record.id, record);
    for (const v of views) this.viewRecords.set(v.id, v);
    for (const r of rows) this.rowRecords.set(r.id, r);
    this.viewCache.delete(record.id);
    this.templateCache.delete(record.id);
    this.databaseCache = null;
    this.emit(new Set(rows.map((r) => r.id)), null);
  }

  addFile(id: Id, info: AssetInfo) {
    this.files.set(id, { info, url: null });
  }

  // ---- Records ------------------------------------------------------------------------------
  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  database = (id: Id) => this.records.get(id) ?? null;
  views = (id: Id) => {
    let list = this.viewCache.get(id);
    if (!list) {
      list = [...this.viewRecords.values()]
        .filter((v) => v.databaseId === id)
        .sort(compareSiblings);
      this.viewCache.set(id, list);
    }
    return list;
  };
  page = (id: Id) => this.pages.get(id) ?? this.withComputed(this.rowRecords.get(id)) ?? null;
  pageTitle = (id: Id) => this.pages.get(id)?.title ?? this.rowRecords.get(id)?.title;
  rowTemplates = (id: Id) => {
    let list = this.templateCache.get(id);
    if (!list) {
      list = [...this.rowRecords.values()].filter(
        (r) => r.databaseId === id && r.isTemplate && !r.trashedAt,
      );
      this.templateCache.set(id, list);
    }
    return list;
  };
  databases = () => {
    this.databaseCache ??= [...this.records.keys()].map((id) => ({
      id,
      title: this.pages.get(id)?.title ?? '',
      icon: this.pages.get(id)?.icon ?? null,
    }));
    return this.databaseCache;
  };
  me = () => this.mePerson;
  people = () => this.peopleList;
  canEdit = () => this.editable;
  queryContext = (): QueryContext => ({
    today: this.today,
    offsetMinutes: -new Date().getTimezoneOffset(),
    me: this.mePerson?.id ?? null,
    people: Object.fromEntries(this.peopleList.map((p) => [p.id, p.name])),
  });
  newId = () => testId();
  openRow = (id: Id) => void this.opened.push({ kind: 'row', id });
  openPage = (id: Id) => void this.opened.push({ kind: 'page', id });
  openExternal = (url: string) => void this.opened.push({ kind: 'link', id: url });

  setCanEdit(editable: boolean) {
    this.editable = editable;
    this.notify();
  }

  // ---- Rows -----------------------------------------------------------------------------------
  rowsOf(databaseId: Id): RowRecord[] {
    const out: RowRecord[] = [];
    for (const r of this.rowRecords.values()) if (r.databaseId === databaseId) out.push(r);
    return out;
  }

  private related = (databaseId: Id, ids: Id[]) => {
    const database = this.records.get(databaseId);
    if (!database) return null;
    return {
      database,
      rows: ids.map((id) => this.rowRecords.get(id)).filter((r): r is RowRecord => Boolean(r)),
    };
  };

  private computedCache = new WeakMap<RowRecord, RowRecord>();
  /** The row with its formulas and rollups computed here, cached per record object. */
  withComputed(row: RowRecord | undefined): RowRecord | undefined {
    if (!row) return undefined;
    const database = this.records.get(row.databaseId);
    if (!database || !database.properties.some((p) => p.type === 'formula' || p.type === 'rollup'))
      return row;
    let out = this.computedCache.get(row);
    if (!out) {
      const computed: Record<PropertyId, CellValue> = {
        ...row.computed,
        ...computeRow(database, row, this.related),
      };
      out = { ...row, computed };
      this.computedCache.set(row, out);
    }
    return out;
  }

  rows(databaseId: Id, request: RowRequest): RowSource {
    return new MemorySource(this, databaseId, request.spec, request.pageSize ?? 100);
  }

  /** Called by sources: the rows that changed and the properties changed (null: anything). */
  onRows(listener: (changed: Set<Id>, props: Set<PropertyId> | null) => void) {
    this.rowListeners.add(listener);
    return () => void this.rowListeners.delete(listener);
  }

  async searchRows(
    databaseId: Id,
    query: string,
    options: { limit?: number } = {},
  ): Promise<RowRef[]> {
    const terms = searchTerms(normaliseText(query));
    const out: RowRef[] = [];
    for (const row of this.rowsOf(databaseId)) {
      if (row.trashedAt || row.isTemplate) continue;
      if (terms.length) {
        const words = normaliseText(row.title).split(' ');
        if (!terms.every((t) => words.some((w) => w.startsWith(t)))) continue;
      }
      out.push({ id: row.id, databaseId, title: row.title, icon: row.icon });
      if (out.length >= (options.limit ?? 25)) break;
    }
    return out;
  }

  rowOrderKey(databaseId: Id, place: RowPlace): string {
    const rows = this.rowsOf(databaseId).sort(compareSiblings);
    const keyOf = (id: Id | null) => (id ? (this.rowRecords.get(id)?.orderKey ?? null) : null);
    let a: string | null;
    let b: string | null;
    if (place === 'end') {
      a = rows[rows.length - 1]?.orderKey ?? null;
      b = null;
    } else if (place === 'start') {
      a = null;
      b = rows[0]?.orderKey ?? null;
    } else {
      a = keyOf(place.after);
      b = keyOf(place.before);
      if (place.after && !place.before) {
        const at = rows.findIndex((r) => r.id === place.after);
        b = rows[at + 1]?.orderKey ?? null;
      }
    }
    try {
      return keyBetween(a, b);
    } catch {
      return keyBetween(a, null);
    }
  }

  // ---- Changes --------------------------------------------------------------------------------
  async apply(ops: Operation[]): Promise<void> {
    const changed = new Set<Id>();
    let props: Set<PropertyId> | null = new Set();
    for (const op of ops) {
      this.applied.push(op);
      const now = op.createdAt;
      switch (op.type) {
        case 'page.create': {
          const { row, database: _db, ...page } = op.payload;
          void _db;
          if (page.kind === 'row') {
            const db = this.records.get(page.parentPageId ?? '');
            if (!db) break;
            const values: Record<PropertyId, Value> = {};
            for (const [id, raw] of Object.entries(row?.values ?? {})) {
              const def = db.properties.find((p) => p.id === id);
              const v = def ? coerceValue(def, raw) : undefined;
              if (v !== undefined) values[id] = v;
            }
            const record: RowRecord = {
              ...page,
              kind: 'row',
              databaseId: db.id,
              values,
              versions: {},
              computed: {},
              computedVersion: null,
              createdBy: this.mePerson?.id ?? null,
              updatedBy: this.mePerson?.id ?? null,
            };
            this.rowRecords.set(record.id, record);
            this.records.set(db.id, { ...db, rowCount: db.rowCount + 1 });
            this.relate(record, {}, changed);
            changed.add(record.id);
            props = null;
            this.templateCache.delete(db.id);
          } else this.pages.set(page.id, page as PageRecord);
          break;
        }
        case 'page.update': {
          const row = this.rowRecords.get(op.entityId);
          if (row) {
            this.rowRecords.set(row.id, this.touch({ ...row, ...op.payload }, now));
            changed.add(row.id);
            if (op.payload.title !== undefined) props?.add('title');
            else props = null;
          } else {
            const page = this.pages.get(op.entityId);
            if (page) this.pages.set(page.id, { ...page, ...op.payload });
            this.databaseCache = null;
          }
          break;
        }
        case 'page.trash': {
          const row = this.rowRecords.get(op.entityId);
          if (row) {
            this.rowRecords.set(row.id, { ...row, trashedAt: now, trashRootId: row.id });
            changed.add(row.id);
            props = null;
          }
          break;
        }
        case 'page.move': {
          const row = this.rowRecords.get(op.entityId);
          if (row) {
            this.rowRecords.set(row.id, this.touch({ ...row, orderKey: op.payload.orderKey }, now));
            changed.add(row.id);
            props = null;
          }
          break;
        }
        case 'row.update': {
          const row = this.rowRecords.get(op.entityId);
          const db = row && this.records.get(row.databaseId);
          if (!row || !db) break;
          const values = { ...row.values };
          for (const [id, raw] of Object.entries(op.payload.values)) {
            const def = db.properties.find((p) => p.id === id);
            const v = def && raw !== null ? coerceValue(def, raw) : undefined;
            if (v === undefined) delete values[id];
            else values[id] = v;
            props?.add(id);
          }
          const next = this.touch({ ...row, values }, now);
          this.rowRecords.set(row.id, next);
          this.relate(next, row.values, changed);
          changed.add(row.id);
          break;
        }
        case 'db.update': {
          const db = this.records.get(op.entityId);
          if (!db) break;
          let properties = [...db.properties];
          for (const incoming of op.payload.properties ?? []) {
            let def: PropertyDef = structuredClone(incoming);
            const at = properties.findIndex((p) => p.id === def.id);
            const before = at >= 0 ? properties[at] : undefined;
            if (before && before.type !== def.type) {
              const rows = this.rowsOf(db.id);
              const converted = convertProperty(
                before,
                def,
                rows.map((r) => r.values[def.id]),
                db.id,
              );
              def = converted.def;
              rows.forEach((r, i) => {
                const values = { ...r.values };
                const v = converted.values[i];
                if (v === undefined) delete values[def.id];
                else values[def.id] = v;
                this.rowRecords.set(r.id, { ...r, values });
                changed.add(r.id);
              });
            }
            if (at >= 0) properties[at] = def;
            else properties.push(def);
            if (def.type === 'relation' && def.relation?.reversePropertyId) {
              const target = this.records.get(def.relation.databaseId);
              const reverseId = def.relation.reversePropertyId;
              const reverse: PropertyDef = {
                id: reverseId,
                name: `${def.name} (reverse)`,
                type: 'relation',
                relation: { databaseId: db.id, reversePropertyId: def.id },
              };
              if (target && target.id === db.id) {
                if (!properties.some((p) => p.id === reverseId)) properties.push(reverse);
              } else if (target && !target.properties.some((p) => p.id === reverseId))
                this.records.set(target.id, {
                  ...target,
                  properties: [...target.properties, reverse],
                  version: target.version + 1,
                });
            }
          }
          if (op.payload.order?.length) {
            const named = op.payload.order.filter((id) => properties.some((p) => p.id === id));
            properties = [
              ...named.map((id) => properties.find((p) => p.id === id)!),
              ...properties.filter((p) => !named.includes(p.id)),
            ];
          }
          this.records.set(db.id, { ...db, properties, version: db.version + 1 });
          props = null;
          for (const r of this.rowsOf(db.id)) changed.add(r.id);
          break;
        }
        case 'view.upsert': {
          const before = this.viewRecords.get(op.entityId);
          this.viewRecords.set(op.entityId, {
            ...op.payload,
            version: (before?.version ?? 0) + 1,
          });
          this.viewCache.delete(op.payload.databaseId);
          break;
        }
        case 'view.delete': {
          const before = this.viewRecords.get(op.entityId);
          if (before) {
            this.viewRecords.delete(op.entityId);
            this.viewCache.delete(before.databaseId);
          }
          break;
        }
        default:
          break;
      }
    }
    if (props === null)
      for (const id of changed) {
        const row = this.rowRecords.get(id);
        if (row) this.templateCache.delete(row.databaseId);
      }
    this.emit(changed, props);
  }

  private touch(row: RowRecord, at: string): RowRecord {
    return {
      ...row,
      version: row.version + 1,
      updatedAt: at,
      updatedBy: this.mePerson?.id ?? null,
    };
  }

  /** Keeps relations two-way: rows added to a relation get this row in the reverse property. */
  private relate(row: RowRecord, before: Record<PropertyId, Value>, changed: Set<Id>) {
    const db = this.records.get(row.databaseId);
    if (!db) return;
    for (const def of db.properties) {
      if (def.type !== 'relation' || !def.relation?.reversePropertyId) continue;
      const reverse = def.relation.reversePropertyId;
      const was = new Set((before[def.id] as string[] | undefined) ?? []);
      const now = new Set((row.values[def.id] as string[] | undefined) ?? []);
      for (const id of new Set([...was, ...now])) {
        if (was.has(id) === now.has(id)) continue;
        const other = this.rowRecords.get(id);
        if (!other) continue;
        const list = new Set((other.values[reverse] as string[] | undefined) ?? []);
        if (now.has(id)) list.add(row.id);
        else list.delete(row.id);
        const values = { ...other.values };
        if (list.size) values[reverse] = [...list];
        else delete values[reverse];
        this.rowRecords.set(id, { ...other, values });
        changed.add(id);
      }
    }
  }

  notify() {
    this.emit(new Set(), new Set());
  }

  private emit(changed: Set<Id>, props: Set<PropertyId> | null) {
    for (const l of this.rowListeners) l(changed, props);
    for (const l of this.listeners) l();
  }
}

/** Whether a query reads a property: then a change to it may move rows, and the query runs again. */
function specReads(spec: QuerySpec, props: Set<PropertyId>): boolean {
  if ((spec.search && props.has('title')) || spec.sorts.some((s) => props.has(s.propertyId)))
    return true;
  if (spec.group && props.has(spec.group.propertyId)) return true;
  const walk = (node: QuerySpec['filter']): boolean =>
    !!node && node.children.some((c) => (c.kind === 'group' ? walk(c) : props.has(c.propertyId)));
  return walk(spec.filter);
}

class MemorySource implements RowSource {
  private listeners = new Set<() => void>();
  private current: RowSnapshot;
  private all: {
    rows: RowRecord[];
    groups: { key: string; count: number; rows: RowRecord[] }[] | null;
  };
  private limit: number;
  private groupLimits = new Map<string, number>();
  private stop: () => void;

  constructor(
    private host: MemoryDatabaseHost,
    private databaseId: Id,
    private spec: QuerySpec,
    private pageSize: number,
  ) {
    this.limit = host.pageSize ?? Number.POSITIVE_INFINITY;
    this.all = this.query();
    this.current = this.build();
    this.stop = host.onRows((changed, props) => this.update(changed, props));
  }

  private query() {
    const db = this.host.database(this.databaseId);
    if (!db) return { rows: [], groups: null };
    const rows = this.host.rowsOf(this.databaseId).map((r) => this.host.withComputed(r)!);
    const ctx = this.host.queryContext();
    const result = queryRows(db, rows, this.spec, ctx);
    if (!result.groups || !this.spec.group) return { rows: result.rows, groups: null };
    const byKey = new Map(result.groups.map((g) => [g.key, [] as RowRecord[]]));
    for (const row of result.rows)
      for (const key of groupKeys(db, row, this.spec.group, ctx)) byKey.get(key)?.push(row);
    return {
      rows: result.rows,
      groups: result.groups.map((g) => ({ key: g.key, count: g.count, rows: byKey.get(g.key)! })),
    };
  }

  private build(): RowSnapshot {
    const paged = this.host.pageSize !== null;
    if (this.all.groups) {
      const groups: RowGroup[] = this.all.groups.map((g) => {
        const limit = paged ? (this.groupLimits.get(g.key) ?? this.host.pageSize!) : Infinity;
        const rows = g.rows.slice(0, limit);
        return { key: g.key, count: g.count, rows, complete: rows.length >= g.rows.length };
      });
      return {
        rows: groups.flatMap((g) => g.rows),
        groups,
        total: this.all.rows.length,
        complete: groups.every((g) => g.complete),
        localOnly: false,
        loading: false,
        error: null,
      };
    }
    const rows = paged ? this.all.rows.slice(0, this.limit) : this.all.rows;
    return {
      rows,
      groups: null,
      total: this.all.rows.length,
      complete: rows.length >= this.all.rows.length,
      localOnly: false,
      loading: false,
      error: null,
    };
  }

  private update(changed: Set<Id>, props: Set<PropertyId> | null) {
    if (!changed.size) return;
    if (props && !specReads(this.spec, props)) {
      // Nothing the query reads changed: the changed rows are replaced where they are.
      const fresh = (r: RowRecord) => this.host.withComputed(this.host.rowRecords.get(r.id)) ?? r;
      const patch = (rows: RowRecord[]) => {
        if (changed.size > 64) return rows.map((r) => (changed.has(r.id) ? fresh(r) : r));
        const out = rows.slice();
        for (const id of changed) {
          const at = out.findIndex((r) => r.id === id);
          if (at >= 0) out[at] = fresh(out[at]);
        }
        return out;
      };
      this.all = {
        rows: patch(this.all.rows),
        groups: this.all.groups?.map((g) => ({ ...g, rows: patch(g.rows) })) ?? null,
      };
    } else this.all = this.query();
    this.current = this.build();
    for (const l of this.listeners) l();
  }

  snapshot = () => this.current;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  loadMore(groupKey?: string) {
    if (this.current.complete) return;
    if (groupKey !== undefined && this.all.groups) {
      const limit = this.groupLimits.get(groupKey) ?? this.host.pageSize ?? this.pageSize;
      this.groupLimits.set(groupKey, limit + (this.host.pageSize ?? this.pageSize));
    } else this.limit += this.host.pageSize ?? this.pageSize;
    this.current = this.build();
    for (const l of this.listeners) l();
  }
  retry() {}
  close() {
    this.stop();
    this.listeners.clear();
  }
}
