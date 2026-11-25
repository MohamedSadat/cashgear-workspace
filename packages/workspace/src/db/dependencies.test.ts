// Phase 17: a database's tasks. The relations holding a role, and a loop of dependencies refused as
// far as the device can see (the server's `DatabaseOps` refuses the rest, `SubItemTests`).
import { describe, expect, it } from 'vitest';
import type { RowRecord } from '../types';
import { dependencyLoop, roleDef } from './dependencies';
import type { DatabaseRecord } from './types';

const DB = 'db';
const database: DatabaseRecord = {
  id: DB,
  workspaceId: 'w',
  version: 1,
  rowCount: 0,
  createdAt: '',
  properties: [
    { id: 'title', name: 'Name', type: 'title' },
    {
      id: 'pBlk0001',
      name: 'Blocked by',
      type: 'relation',
      relation: { databaseId: DB, reversePropertyId: 'pBkg0001', role: 'blockedBy' },
    },
    {
      id: 'pBkg0001',
      name: 'Blocking',
      type: 'relation',
      relation: { databaseId: DB, reversePropertyId: 'pBlk0001', role: 'blocking' },
    },
    {
      id: 'pOther01',
      name: 'Elsewhere',
      type: 'relation',
      relation: { databaseId: 'other', reversePropertyId: null, role: 'blockedBy' },
    },
  ],
} as DatabaseRecord;

const row = (id: string, blockedBy: string[] = []): RowRecord =>
  ({
    id,
    databaseId: DB,
    kind: 'row',
    trashedAt: null,
    values: blockedBy.length ? { pBlk0001: blockedBy } : {},
  }) as unknown as RowRecord;

describe('dependencies', () => {
  it('finds the relation of the database to itself holding a role', () => {
    expect(roleDef(database, 'blockedBy')?.id).toBe('pBlk0001');
    expect(roleDef(database, 'blocking')?.id).toBe('pBkg0001');
    expect(roleDef(database, 'parent')).toBeNull();
  });

  it('refuses a row blocked by a row it blocks, itself among them', () => {
    const held = new Map([
      ['a', row('a')],
      ['b', row('b', ['a'])],
      ['c', row('c', ['b'])],
    ]);
    expect(dependencyLoop(database, held, [row('a', ['c'])])).toBe(true);
    expect(dependencyLoop(database, held, [row('b', ['a', 'b'])])).toBe(true);
    expect(dependencyLoop(database, held, [row('c', ['a', 'b'])])).toBe(false);
    // A row this device does not hold stops the walk there.
    expect(dependencyLoop(database, new Map(), [row('a', ['c'])])).toBe(false);
    // A row in the trash blocks nothing.
    const trashed = new Map(held);
    trashed.set('b', { ...row('b', ['a']), trashedAt: '2026-11-25T00:00:00Z' });
    expect(dependencyLoop(database, trashed, [row('a', ['c'])])).toBe(false);
  });
});
