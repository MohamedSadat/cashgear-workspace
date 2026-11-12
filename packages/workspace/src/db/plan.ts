// The database rules the planners apply (contract section 2; ops.ts and remote.ts call these):
// per-property merges of a database's properties, every value written coerced to its property's
// type, a type change converting every held row, relations kept two-way on held rows, and the
// reverse property a relation names added to its target database. The conversions themselves are
// the core's (`coerceValue`, `convertProperty`, `planRelationChange`), the functions the server's
// port runs too (server/src/Cgw.Core/Databases/DatabaseOps.cs), so a device and the server reach
// the same values: rows are converted in id order, as the server reads them.
import { OpError, type PageRecord, type RowRecord } from '../types';
import type { Id } from '../ids';
import { convertProperty } from './convert';
import { isPropertyId } from './ids';
import { applyRelationEdit, planRelationChange, relationTypeChangeEffects } from './relations';
import {
  STORED_TYPES,
  TITLE_PROPERTY,
  type DatabaseRecord,
  type PropertyDef,
  type PropertyId,
  type PropertyType,
  type RollupFunction,
  type Value,
} from './types';
import { cellValue, coerceValue } from './values';

/** What the database rules read: the planner's overlay, or a store's reader. */
export interface DbReader {
  page(id: Id): Promise<PageRecord | undefined>;
  database(id: Id): Promise<DatabaseRecord | undefined>;
  rows(databaseId: Id): Promise<RowRecord[]>;
}

/** The title property a database is given when it has none (the server gives the same). */
export const TITLE_DEF: PropertyDef = { id: TITLE_PROPERTY, name: 'Name', type: 'title' };

/** As the server holds them (DatabaseOps.cs): properties per database, their JSON, names. */
export const MAX_PROPERTIES = 500;
export const MAX_PROPERTIES_CHARS = 1_000_000;
const MAX_NAME = 200;
const MAX_OPTIONS = 1000;
const MAX_EXPRESSION = 10_000;

const TYPES = new Set<PropertyType>([
  'title',
  'text',
  'number',
  'date',
  'checkbox',
  'select',
  'multiSelect',
  'status',
  'person',
  'url',
  'email',
  'phone',
  'files',
  'relation',
  'formula',
  'rollup',
  'createdTime',
  'createdBy',
  'lastEditedTime',
  'lastEditedBy',
]);

const ROLLUP_FUNCTIONS = new Set<RollupFunction>([
  'count',
  'countValues',
  'countUnique',
  'countEmpty',
  'countNotEmpty',
  'percentEmpty',
  'percentNotEmpty',
  'sum',
  'average',
  'median',
  'min',
  'max',
  'range',
  'earliest',
  'latest',
  'checked',
  'unchecked',
  'percentChecked',
  'showOriginal',
]);

const invalid = (why: string) => new OpError('invalid', why);

/** Throws unless the def is one a database may hold, by the rules the server checks too. */
function checkDef(def: PropertyDef) {
  if (!TYPES.has(def.type)) throw invalid(`Not a property type: ${String(def.type)}`);
  if (def.id === TITLE_PROPERTY) {
    if (def.type !== 'title') throw invalid('The title property stays a title');
    if (def.trashedAt) throw invalid('The title property cannot be deleted');
  } else {
    if (!isPropertyId(def.id)) throw invalid(`Not a property id: ${def.id}`);
    if (def.type === 'title') throw invalid('A database has one title property');
  }
  if (typeof def.name !== 'string') throw invalid('A property has a name');
  if (def.name.length > MAX_NAME) throw invalid("A property's name is at most 200 characters");
  if (def.options !== undefined) {
    if (!Array.isArray(def.options) || def.options.length > MAX_OPTIONS)
      throw invalid('Options are a list of at most 1,000');
    const ids = new Set<string>();
    for (const option of def.options) {
      if (!isPropertyId(option?.id) || option.id === TITLE_PROPERTY || ids.has(option.id))
        throw invalid('Each option has its own id of 8 base-62 characters');
      ids.add(option.id);
      if (typeof option.name !== 'string' || option.name.length > MAX_NAME)
        throw invalid('Each option has a name of at most 200 characters');
    }
  }
  if (def.type === 'relation' && !def.relation?.databaseId)
    throw invalid('A relation names its database');
  const reverse = def.relation?.reversePropertyId;
  if (reverse != null && (!isPropertyId(reverse) || reverse === TITLE_PROPERTY))
    throw invalid(`Not a property id: ${reverse}`);
  if (
    def.type === 'rollup' &&
    (!def.rollup?.relationPropertyId ||
      !def.rollup.targetPropertyId ||
      !ROLLUP_FUNCTIONS.has(def.rollup.fn))
  )
    throw invalid('A rollup names its relation, its property and its function');
  if (
    def.type === 'formula' &&
    (typeof def.formula?.expression !== 'string' || def.formula.expression.length > MAX_EXPRESSION)
  )
    throw invalid('A formula has an expression of at most 10,000 characters');
}

function checkSize(properties: PropertyDef[]) {
  if (properties.length > MAX_PROPERTIES)
    throw invalid(`A database holds at most ${MAX_PROPERTIES} properties`);
  if (JSON.stringify(properties).length > MAX_PROPERTIES_CHARS)
    throw invalid('The properties are too large');
}

/** A new database's properties: as given, checked, with the title property first if none is. */
export function startProperties(properties: PropertyDef[]): PropertyDef[] {
  const seen = new Set<PropertyId>();
  for (const def of properties) {
    checkDef(def);
    if (seen.has(def.id)) throw invalid(`Property ${def.id} given twice`);
    seen.add(def.id);
  }
  const out = seen.has(TITLE_PROPERTY)
    ? structuredClone(properties)
    : [{ ...TITLE_DEF }, ...structuredClone(properties)];
  checkSize(out);
  return out;
}

const stored = (def: PropertyDef) => STORED_TYPES.includes(def.type);

/**
 * Values written to a row, merged per property over `current`: each coerced to its property's
 * current type (`coerceValue`); null, or a value that cannot be coerced, clears it. A property
 * the database does not have, or one whose value is not stored on the row (the title, formulas,
 * rollups, created and edited time and by), is refused.
 */
export function writeValues(
  db: DatabaseRecord,
  current: Record<PropertyId, Value>,
  changes: Record<PropertyId, Value | null>,
): Record<PropertyId, Value> {
  const out = { ...current };
  for (const [id, raw] of Object.entries(changes)) {
    const def = db.properties.find((p) => p.id === id);
    if (!def) throw invalid(`No property ${id}`);
    if (!stored(def)) throw invalid(`Property ${id} is not written on a row`);
    const value = coerceValue(def, raw);
    if (value === undefined) delete out[id];
    else out[id] = value;
  }
  return out;
}

/**
 * The reverse properties a database's relations need in their targets: a relation naming a
 * `reversePropertyId` its target lacks adds it there, pointing back, named after the database (a
 * self-relation's, a second property in the same database, after the relation). Targets this
 * device does not hold are left to the server, which adds the same.
 */
export async function planReverseProperties(
  db: DatabaseRecord,
  defs: PropertyDef[],
  reader: DbReader,
): Promise<DatabaseRecord[]> {
  const changed = new Map<Id, DatabaseRecord>();
  const title = (await reader.page(db.id))?.title ?? '';
  for (const def of defs) {
    const relation = def.type === 'relation' ? def.relation : undefined;
    if (!relation?.reversePropertyId) continue;
    const self = relation.databaseId === db.id;
    const target =
      changed.get(relation.databaseId) ?? (self ? db : await reader.database(relation.databaseId));
    if (!target || target.properties.some((p) => p.id === relation.reversePropertyId)) continue;
    const reverse: PropertyDef = {
      id: relation.reversePropertyId,
      name: (self ? `${def.name} (reverse)` : title || def.name).slice(0, MAX_NAME),
      type: 'relation',
      relation: { databaseId: db.id, reversePropertyId: def.id },
    };
    checkDef(reverse);
    changed.set(target.id, {
      ...target,
      properties: [...target.properties, reverse],
      version: self ? target.version : target.version + 1,
    });
  }
  return [...changed.values()];
}

/** What a `db.update` writes: the database (and targets given reverse properties), and held rows. */
export interface DatabaseChange {
  databases: DatabaseRecord[];
  rows: RowRecord[];
}

const byId = (a: { id: Id }, b: { id: Id }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * A `db.update` merged per property: each def replaces the property with its id or is added at the
 * end; a type change converts every held row's stored value (`convertProperty`, which also makes
 * the options a conversion needs; rows in id order; a formula, rollup or created/edited property
 * converts what its cells read as, `cellValue`), raising each changed row's version; `order` puts
 * the ids it names first, the rest keeping their places after them. A relation that no longer
 * pairs with its reverse property (changed into another type, database or reverse) leaves that
 * property one-way in a held target (`relationTypeChangeEffects`), its values kept. Deleting a
 * property (its `trashedAt`) or an option never rewrites a row.
 */
export async function planDatabaseUpdate(
  db: DatabaseRecord,
  update: { properties?: PropertyDef[]; order?: PropertyId[] },
  reader: DbReader,
  at: string,
): Promise<DatabaseChange> {
  let properties = structuredClone(db.properties);
  let rows: RowRecord[] | null = null;
  const touched = new Map<Id, RowRecord>();
  const given = new Set<PropertyId>();
  const incoming = update.properties ?? [];
  const merged: PropertyDef[] = [];
  const pairings: { before: PropertyDef; after: PropertyDef }[] = [];
  for (const raw of incoming) {
    checkDef(raw);
    if (given.has(raw.id)) throw invalid(`Property ${raw.id} given twice`);
    given.add(raw.id);
  }
  for (const raw of incoming) {
    let def = structuredClone(raw);
    const index = properties.findIndex((p) => p.id === def.id);
    const before = index >= 0 ? properties[index] : undefined;
    if (before?.type === 'relation') pairings.push({ before, after: def });
    if (before && before.type !== def.type) {
      rows ??= [...(await reader.rows(db.id))].sort(byId);
      const current = rows.map((row) => touched.get(row.id) ?? row);
      // A stored type converts its stored value; a formula, rollup or created/edited property
      // converts what its cells read as (the server's result, the page's fields).
      const converted = convertProperty(
        before,
        def,
        current.map((row) => (stored(before) ? row.values[def.id] : cellValue(db, row, def.id))),
        db.id,
      );
      def = converted.def;
      current.forEach((row, i) => {
        const value = converted.values[i];
        if (sameValue(value, row.values[def.id])) return;
        const values = { ...row.values };
        if (value === undefined) delete values[def.id];
        else values[def.id] = value;
        touched.set(row.id, { ...row, values, version: row.version + 1, updatedAt: at });
      });
    }
    if (index >= 0) properties[index] = def;
    else properties.push(def);
    merged.push(def);
  }
  if (update.order?.length) {
    const named = [...new Set(update.order)].filter((id) => properties.some((p) => p.id === id));
    const first = named.map((id) => properties.find((p) => p.id === id)!);
    properties = [...first, ...properties.filter((p) => !named.includes(p.id))];
  }
  checkSize(properties);
  const next: DatabaseRecord = { ...db, properties, version: db.version + 1 };
  const changed = new Map<Id, DatabaseRecord>([[db.id, next]]);
  for (const target of await planReverseProperties(next, merged, reader))
    changed.set(target.id, target);
  // A relation that no longer pairs with its reverse leaves the reverse one-way, in a held target
  // (the server does the same in its transaction, also for targets this device does not hold).
  for (const { before, after } of pairings) {
    const id = before.relation!.databaseId;
    const target = changed.get(id) ?? (await reader.database(id));
    for (const effect of relationTypeChangeEffects(next, before, after, target ?? null)) {
      const base = changed.get(effect.databaseId) ?? target!;
      changed.set(effect.databaseId, {
        ...base,
        properties: base.properties.map(
          (p) => effect.properties.find((e) => e.id === p.id) ?? structuredClone(p),
        ),
        version: changed.has(effect.databaseId) ? base.version : base.version + 1,
      });
    }
  }
  return { databases: [...changed.values()], rows: [...touched.values()] };
}

/**
 * Relations kept two-way on held rows: when `row`'s relation values changed from `before` (null
 * for a new row), each row it now names gains `row` in the reverse property and each it no longer
 * names loses it (`planRelationChange`, `applyRelationEdit`), its version rising. Rows this device
 * does not hold are left to the server, which makes the same edits in the same transaction.
 * Returns the rows changed; `row` itself among them when it is its own target (a self-relation).
 */
export async function planRelationEdits(
  db: DatabaseRecord,
  row: RowRecord,
  before: Record<PropertyId, Value> | null,
  reader: DbReader,
  at: string,
): Promise<RowRecord[]> {
  const edits = planRelationChange(db, before && { id: row.id, values: before }, row);
  if (!edits.length) return [];
  const changed = new Map<Id, RowRecord>([[row.id, row]]);
  const held = new Map<Id, Map<Id, RowRecord>>();
  for (const edit of edits) {
    let rows = held.get(edit.databaseId);
    if (!rows)
      held.set(
        edit.databaseId,
        (rows = new Map((await reader.rows(edit.databaseId)).map((r) => [r.id, r]))),
      );
    const target = changed.get(edit.rowId) ?? rows.get(edit.rowId);
    if (!target || target.databaseId !== edit.databaseId) continue;
    const value = applyRelationEdit(target.values[edit.propertyId], edit);
    if (sameValue(value, target.values[edit.propertyId])) continue;
    const values = { ...target.values };
    if (value === undefined) delete values[edit.propertyId];
    else values[edit.propertyId] = value;
    // The row's own version rose with its write already.
    const version = target.id === row.id ? target.version : target.version + 1;
    changed.set(target.id, { ...target, values, version, updatedAt: at });
  }
  return [...changed.values()].filter((r) => r !== row);
}

/**
 * A database the server changed whose property types differ from the held record's: held rows the
 * batch did not carry (one with an edit waiting here, say) take each such value coerced to the new
 * type, as the server coerces an edit that reaches it after a type change.
 */
export function coerceHeldRows(
  before: DatabaseRecord,
  after: DatabaseRecord,
  rows: RowRecord[],
): RowRecord[] {
  const changedTypes = after.properties.filter((def) => {
    const old = before.properties.find((p) => p.id === def.id);
    return old && old.type !== def.type && stored(def);
  });
  if (!changedTypes.length) return [];
  const out: RowRecord[] = [];
  for (const row of rows) {
    let values: Record<PropertyId, Value> | null = null;
    for (const def of changedTypes) {
      const value = row.values[def.id];
      if (value === undefined) continue;
      const coerced = coerceValue(def, value);
      if (sameValue(coerced, value)) continue;
      values ??= { ...row.values };
      if (coerced === undefined) delete values[def.id];
      else values[def.id] = coerced;
    }
    if (values) out.push({ ...row, values });
  }
  return out;
}

function sameValue(a: Value | undefined, b: Value | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
