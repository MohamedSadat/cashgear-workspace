// Sub-items and dependencies (Phase 17): which relations of a database to itself are its Parent
// and Sub-items, and its Blocked by and Blocking (their defs' `relation.role`), and the change of
// its properties that switches either on (picking a two-way relation it has, or making one) or
// off. Pure: no React, no DOM.
import { newPropertyId, type DatabaseRecord, type PropertyDef, type RelationRole } from '../core';
import { liveProperties } from '../model/properties';

export type TaskPair = 'subItems' | 'dependencies';

const ROLES: Record<TaskPair, [RelationRole, RelationRole]> = {
  subItems: ['parent', 'subItems'],
  dependencies: ['blockedBy', 'blocking'],
};

/** A live two-way relation of the database to itself, with the reverse it pairs with. */
export interface SelfPair {
  first: PropertyDef;
  second: PropertyDef;
}

/** The database's two-way relations to itself, each pair once (its first in database order). */
export function selfPairs(database: DatabaseRecord): SelfPair[] {
  const live = liveProperties(database);
  const pairs: SelfPair[] = [];
  const seen = new Set<string>();
  for (const def of live) {
    const rel = def.type === 'relation' ? def.relation : undefined;
    if (!rel || rel.databaseId !== database.id || !rel.reversePropertyId || seen.has(def.id))
      continue;
    const other = live.find((p) => p.id === rel.reversePropertyId);
    if (
      !other ||
      other.id === def.id ||
      other.type !== 'relation' ||
      other.relation?.databaseId !== database.id ||
      other.relation.reversePropertyId !== def.id
    )
      continue;
    seen.add(def.id);
    seen.add(other.id);
    pairs.push({ first: def, second: other });
  }
  return pairs;
}

/** The pair switched on for sub-items (Parent, Sub-items) or dependencies (Blocked by, Blocking). */
export function taskPair(database: DatabaseRecord, pair: TaskPair): SelfPair | null {
  const [a, b] = ROLES[pair];
  for (const { first, second } of selfPairs(database)) {
    if (first.relation?.role === a && second.relation?.role === b) return { first, second };
    if (second.relation?.role === a && first.relation?.role === b)
      return { first: second, second: first };
  }
  return null;
}

/** Whether moving a blocker moves the rows it blocks (its Blocked by's `relation.shift`). */
export const shiftsDependents = (database: DatabaseRecord) =>
  taskPair(database, 'dependencies')?.first.relation?.shift === true;

const withRole = (def: PropertyDef, role: RelationRole | null, shift?: boolean): PropertyDef => {
  const { role: _role, shift: _shift, ...relation } = def.relation!;
  void _role;
  void _shift;
  return {
    ...def,
    relation: {
      ...relation,
      ...(role ? { role } : {}),
      ...(role === 'blockedBy' && shift ? { shift: true } : {}),
    },
  };
};

/**
 * The defs a switch changes: `choice` a pair's first property id (it becomes Parent or Blocked by,
 * its reverse Sub-items or Blocking), `new` a pair made with the given names, or null to switch it
 * off (the relations stay, without their roles). Every other def keeps its role but this pair's.
 */
export function switchPair(
  database: DatabaseRecord,
  pair: TaskPair,
  choice: string | 'new' | null,
  names: { first: string; second: string },
  shift = false,
): PropertyDef[] {
  const [a, b] = ROLES[pair];
  const changed = new Map<string, PropertyDef>();
  // Whatever held these roles before lets them go.
  for (const def of database.properties)
    if (def.type === 'relation' && (def.relation?.role === a || def.relation?.role === b))
      changed.set(def.id, withRole(def, null));
  if (choice === 'new') {
    const first = newPropertyId();
    const second = newPropertyId();
    changed.set(first, {
      id: first,
      name: names.first,
      type: 'relation',
      relation: {
        databaseId: database.id,
        reversePropertyId: second,
        role: a,
        ...(a === 'blockedBy' && shift ? { shift: true } : {}),
      },
    });
    changed.set(second, {
      id: second,
      name: names.second,
      type: 'relation',
      relation: { databaseId: database.id, reversePropertyId: first, role: b },
    });
  } else if (choice) {
    const found = selfPairs(database).find((p) => p.first.id === choice || p.second.id === choice);
    if (found) {
      const first = found.first.id === choice ? found.first : found.second;
      const second = first === found.first ? found.second : found.first;
      changed.set(first.id, withRole(changed.get(first.id) ?? first, a, shift));
      changed.set(second.id, withRole(changed.get(second.id) ?? second, b));
    }
  }
  return [...changed.values()];
}

/** A row's count of sub-items (its Sub-items relation), for a board's card and a list's line. */
export function subItemCount(database: DatabaseRecord, values: Record<string, unknown>): number {
  const pair = taskPair(database, 'subItems');
  const ids = pair ? values[pair.second.id] : undefined;
  return Array.isArray(ids) ? ids.length : 0;
}
