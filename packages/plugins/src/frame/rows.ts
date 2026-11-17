// A database view's rows as `plugin-frame.1` shows them to a plugin (`Rows`): read through the
// shell's `DatabaseHost`, so as the reader may read them; the view's own filter and sorts; its shown
// properties only; never a person (person, created-by and edited-by cells, and a formula or a
// rollup that reads one, are left out, as the share link's wire leaves them out); at most 500 rows.
import type { DatabaseHost, RowRequest, RowSnapshot } from '@cgw/database';
import {
  shownProperties,
  type DatabaseRecord,
  type PropertyDef,
  type RowRecord,
  type ViewRecord,
} from '@cgw/workspace';
import {
  PLUGIN_LIMITS,
  ROWS_PROPERTY_TYPES,
  ROWS_TEXT,
  isRowsId,
  isRowsValue,
  type JsonValue,
  type Rows,
  type RowsOption,
  type RowsProperty,
  type RowsPropertyType,
} from './contract';

const PEOPLE = new Set(['person', 'createdBy', 'lastEditedBy']);
const PROP_REFERENCE = /prop\(\s*"([^"]*)"\s*\)/g;
const MAX_DEPTH = 8;

/**
 * Whether a property's values may be shown to a plugin: not a person's; a formula only of such
 * properties; a rollup only of such a property of a database the host has. Anything that cannot
 * be decided (a cycle, too deep, a database not here) is not shown.
 */
export function shownToPlugins(
  host: Pick<DatabaseHost, 'database'>,
  database: DatabaseRecord,
  def: PropertyDef,
  seen: Set<string> = new Set(),
  depth = 0,
): boolean {
  if (def.trashedAt || PEOPLE.has(def.type)) return false;
  if (!(ROWS_PROPERTY_TYPES as readonly string[]).includes(def.type)) return false;
  if (depth > MAX_DEPTH) return false;
  const key = `${database.id}/${def.id}`;
  if (seen.has(key)) return false;
  seen.add(key);
  if (def.type === 'formula') {
    for (const match of (def.formula?.expression ?? '').matchAll(PROP_REFERENCE)) {
      const read = database.properties.find((p) => p.id === match[1]);
      // A formula naming something that is not there reads nothing of it.
      if (read && !shownToPlugins(host, database, read, seen, depth + 1)) return false;
    }
    return true;
  }
  if (def.type === 'rollup') {
    const relation = database.properties.find((p) => p.id === def.rollup?.relationPropertyId);
    const target = relation?.relation?.databaseId;
    if (!relation || relation.type !== 'relation' || !target) return false;
    const other = host.database(target);
    const read = other?.properties.find((p) => p.id === def.rollup?.targetPropertyId);
    return !!other && !!read && shownToPlugins(host, other, read, seen, depth + 1);
  }
  return true;
}

/** The view's shown properties a plugin may see, in the view's order, the title first. */
export function rowsProperties(
  host: Pick<DatabaseHost, 'database'>,
  database: DatabaseRecord,
  view: ViewRecord,
): PropertyDef[] {
  return shownProperties(database, view.config)
    .filter((def) => isRowsId(def.id) && shownToPlugins(host, database, def))
    .slice(0, PLUGIN_LIMITS.properties);
}

/** The query a plugin's rows are read by: the view's filter and sorts, no group, 500 at most. */
export function rowsRequest(view: ViewRecord): RowRequest {
  return {
    viewId: view.id,
    spec: { filter: view.config.filter, sorts: view.config.sorts, group: null },
    pageSize: PLUGIN_LIMITS.rows,
  };
}

const COLOURS = new Set([
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
]);
const GROUPS = new Set(['todo', 'inProgress', 'complete']);

const cut = (text: unknown, max: number) => (typeof text === 'string' ? text.slice(0, max) : '');

function propertyOf(def: PropertyDef): RowsProperty {
  const out: RowsProperty = {
    id: def.id,
    name: cut(def.name, ROWS_TEXT.name),
    type: def.type as RowsPropertyType,
  };
  if (def.type === 'select' || def.type === 'multiSelect' || def.type === 'status') {
    out.options = (def.options ?? [])
      .filter((o) => isRowsId(o.id))
      .slice(0, 1000)
      .map((o) => {
        const option: RowsOption = {
          id: o.id,
          name: cut(o.name, ROWS_TEXT.name),
          colour: (COLOURS.has(o.colour) ? o.colour : 'default') as RowsOption['colour'],
        };
        const group = (o as { group?: string }).group;
        if (def.type === 'status' && group && GROUPS.has(group))
          option.group = group as RowsOption['group'];
        return option;
      });
  }
  return out;
}

/** A row's value of a property as a plugin is shown it, or undefined for none. */
function valueOf(row: RowRecord, def: PropertyDef): JsonValue | undefined {
  switch (def.type) {
    case 'title':
      return undefined;
    case 'formula':
    case 'rollup': {
      const value = row.computed?.[def.id];
      return value === null || value === undefined ? undefined : (value as JsonValue);
    }
    case 'createdTime':
      return row.createdAt ? { start: row.createdAt } : undefined;
    case 'lastEditedTime':
      return row.updatedAt ? { start: row.updatedAt } : undefined;
    default: {
      const value = row.values?.[def.id];
      if (value === undefined || value === null || value === '') return undefined;
      if (Array.isArray(value) && !value.length) return undefined;
      return value as JsonValue;
    }
  }
}

/** The rows a snapshot holds, as `Rows`: at most 500, each with its shown values. */
export function rowsOf(
  database: DatabaseRecord,
  view: ViewRecord,
  defs: readonly PropertyDef[],
  snapshot: RowSnapshot,
): Rows {
  const seen = new Set<string>();
  const rows: Rows['rows'] = [];
  for (const row of snapshot.rows) {
    if (rows.length >= PLUGIN_LIMITS.rows) break;
    if (seen.has(row.id) || !isRowsId(row.id)) continue;
    seen.add(row.id);
    const values: Record<string, JsonValue> = {};
    for (const def of defs) {
      const value = valueOf(row, def);
      // What the contract cannot carry (a text past its bound) is left out, never cut.
      if (value !== undefined && isRowsValue(value))
        Object.defineProperty(values, def.id, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    rows.push({ id: row.id, title: cut(row.title, ROWS_TEXT.title), values });
  }
  const total = Math.max(snapshot.total, rows.length);
  return {
    databaseId: database.id,
    viewId: view.id,
    properties: defs.map(propertyOf),
    rows,
    total,
    complete: snapshot.complete && rows.length === total,
  };
}
