// Two-way relations (Phase 4 contracts, section 2): a relation property names its database and
// the property there kept in step with it. Setting row A's relation to add B and remove C adds A
// to B's reverse value and removes A from C's, in the same transaction on the server and for held
// rows here. A relation changed into anything else leaves its reverse one-way
// (`relationTypeChangeEffects`). Shared vectors: db-compute-vectors.json (`relationChange`,
// `relationTypeChange`, `applyRelationEdit`).
import type { Id } from '../ids';
import type { RowRecord } from '../types';
import { RELATION_LIMIT } from './convert';
import type { DatabaseRecord, PropertyDef, PropertyId, Value } from './types';

/** One reverse-side change: on row `rowId` of `databaseId`, property `propertyId`. */
export interface RelationEdit {
  databaseId: Id;
  rowId: Id;
  propertyId: PropertyId;
  /** Row ids to add (in the order they were added) and to remove. */
  add: Id[];
  remove: Id[];
}

export type RowValues = Pick<RowRecord, 'id' | 'values'>;

function ids(value: Value | undefined): Id[] {
  if (!Array.isArray(value)) return [];
  const out: Id[] = [];
  for (const id of value)
    if (typeof id === 'string' && id !== '' && !out.includes(id)) out.push(id);
  return out;
}

/**
 * The reverse-side edits a change of one row's values makes: for each relation property not
 * deleted that has a reverse property, the ids it lost (in `before`'s order) remove the row from
 * their reverse value, and the ids it gained (in `after`'s order) add it. One edit per target row
 * and property, in the order first touched; a row's own edit of its own property (a symmetric
 * self-relation naming itself) is left out. `before` null is a new row; `after` null a removed one.
 */
export function planRelationChange(
  database: DatabaseRecord,
  before: RowValues | null,
  after: RowValues | null,
): RelationEdit[] {
  const rowId = after?.id ?? before?.id;
  if (!rowId) return [];
  const edits = new Map<string, RelationEdit>();
  const edit = (databaseId: Id, target: Id, propertyId: PropertyId) => {
    const key = `${databaseId}\u0000${target}\u0000${propertyId}`;
    let found = edits.get(key);
    if (!found) {
      found = { databaseId, rowId: target, propertyId, add: [], remove: [] };
      edits.set(key, found);
    }
    return found;
  };
  for (const def of database.properties) {
    if (def.type !== 'relation' || def.trashedAt || !def.relation?.reversePropertyId) continue;
    const { databaseId, reversePropertyId } = def.relation;
    const was = ids(before?.values?.[def.id]);
    const now = ids(after?.values?.[def.id]);
    const self = (target: Id) =>
      databaseId === database.id && target === rowId && reversePropertyId === def.id;
    for (const target of was)
      if (!now.includes(target) && !self(target)) {
        const e = edit(databaseId, target, reversePropertyId);
        e.add = e.add.filter((id) => id !== rowId);
        if (!e.remove.includes(rowId)) e.remove.push(rowId);
      }
    for (const target of now)
      if (!was.includes(target) && !self(target)) {
        const e = edit(databaseId, target, reversePropertyId);
        e.remove = e.remove.filter((id) => id !== rowId);
        if (!e.add.includes(rowId)) e.add.push(rowId);
      }
  }
  return [...edits.values()];
}

/** A reverse value after an edit: `remove` taken out, `add` appended (once each), the first 1,000 kept. */
export function applyRelationEdit(
  current: Value | undefined,
  edit: Pick<RelationEdit, 'add' | 'remove'>,
): Value | undefined {
  const next = ids(current).filter((id) => !edit.remove.includes(id));
  for (const id of edit.add) if (!next.includes(id)) next.push(id);
  next.splice(RELATION_LIMIT);
  return next.length ? next : undefined;
}

/** A `db.update` another database needs: the defs that replace its properties with those ids. */
export interface RelationPairingChange {
  databaseId: Id;
  properties: PropertyDef[];
}

/**
 * What a change of a relation property's def does to its reverse property: when `before` was a
 * relation with a reverse property and `after` no longer pairs with it (another type, another
 * database, another or no reverse property), the reverse property in `target` becomes one-way
 * (its `relation.reversePropertyId` set to null) and keeps its values; no row is rewritten. Only a
 * reverse property that still points back (`relation.databaseId` is `database.id` and its
 * `reversePropertyId` is `before.id`) changes; a symmetric self-relation (its own reverse) changes
 * nothing. `target` is the database `before` points into, `database` itself for a self-relation
 * (the default then); null when it is not held here, and nothing is planned (the server does it).
 * The planner and the server both call this, in the same transaction as the type change.
 */
export function relationTypeChangeEffects(
  database: Pick<DatabaseRecord, 'id' | 'properties'>,
  before: PropertyDef,
  after: PropertyDef,
  target: Pick<DatabaseRecord, 'id' | 'properties'> | null = before.relation?.databaseId ===
  database.id
    ? database
    : null,
): RelationPairingChange[] {
  const pairing = before.type === 'relation' ? before.relation : undefined;
  if (!pairing?.reversePropertyId || !target || target.id !== pairing.databaseId) return [];
  const still =
    after.type === 'relation' &&
    after.relation?.databaseId === pairing.databaseId &&
    after.relation?.reversePropertyId === pairing.reversePropertyId;
  if (still) return [];
  if (target.id === database.id && pairing.reversePropertyId === before.id) return [];
  const reverse = target.properties.find((p) => p.id === pairing.reversePropertyId);
  if (
    !reverse ||
    reverse.type !== 'relation' ||
    reverse.relation?.databaseId !== database.id ||
    reverse.relation.reversePropertyId !== before.id
  )
    return [];
  return [
    {
      databaseId: target.id,
      properties: [{ ...reverse, relation: { ...reverse.relation, reversePropertyId: null } }],
    },
  ];
}
