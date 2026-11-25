// Phase 17: a database's tasks (DATA_MODEL.md, Databases): its relations to itself that are its
// Parent and Sub-items, and its Blocked by and Blocking (their defs' `relation.role`), and the loop
// of dependencies the planner refuses, as the server does (C#'s `Dependencies`). No React, no DOM.
import type { Id } from '../ids';
import type { RowRecord } from '../types';
import type { DatabaseRecord, PropertyDef, RelationRole } from './types';

/** The live relation of the database to itself holding the role, else null. */
export function roleDef(database: DatabaseRecord, role: RelationRole): PropertyDef | null {
  return (
    database.properties.find(
      (p) =>
        !p.trashedAt &&
        p.type === 'relation' &&
        p.relation?.databaseId === database.id &&
        p.relation.role === role,
    ) ?? null
  );
}

const idsOf = (value: unknown): Id[] =>
  Array.isArray(value) ? value.filter((v): v is Id => typeof v === 'string') : [];

/**
 * Whether any of `changed` is blocked, through Blocked by, by a row it blocks (itself among them):
 * walked over the rows this device has (`rows`, with `changed` over them). A row not held stops the
 * walk there: the server, which holds them all, refuses what this misses.
 */
export function dependencyLoop(
  database: DatabaseRecord,
  rows: ReadonlyMap<Id, RowRecord>,
  changed: readonly RowRecord[],
): boolean {
  const def = roleDef(database, 'blockedBy');
  if (!def) return false;
  const byId = new Map(rows);
  for (const row of changed) byId.set(row.id, row);
  for (const row of changed) {
    if (row.databaseId !== database.id) continue;
    const stack = idsOf(row.values[def.id]);
    const seen = new Set<Id>();
    while (stack.length) {
      const id = stack.pop()!;
      if (id === row.id) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const next = byId.get(id);
      if (next && !next.trashedAt && next.databaseId === database.id)
        stack.push(...idsOf(next.values[def.id]));
    }
  }
  return false;
}
