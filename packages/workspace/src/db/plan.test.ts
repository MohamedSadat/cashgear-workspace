import { describe, expect, it } from 'vitest';
import type { PageRecord, RowRecord } from '../types';
import { planDatabaseUpdate, type DbReader } from './plan';
import type { DatabaseRecord, PropertyDef } from './types';
import { DB, DB2, TITLE, database, prop, row, rowId } from './vectors/fixtures';

const DB3 = '01900000-0000-7000-8000-000000000003';
const AT = '2026-03-01T00:00:00.000Z';

const full = (db: ReturnType<typeof database>): DatabaseRecord => ({
  workspaceId: 'w',
  rowCount: 0,
  createdAt: AT,
  ...db,
});

function readerOf(databases: DatabaseRecord[], rows: RowRecord[]): DbReader {
  return {
    page: async (id) => ({ id, title: 'Tasks' }) as PageRecord,
    database: async (id) => databases.find((d) => d.id === id),
    rows: async (databaseId) => rows.filter((r) => r.databaseId === databaseId),
  };
}

const relationTo = (id: string, databaseId: string, reversePropertyId: string | null, name = id) =>
  prop(id, 'relation', { relation: { databaseId, reversePropertyId } }, name);

describe('a type change in planDatabaseUpdate', () => {
  it('converts what a formula, rollup or created property reads as, not a stored value', async () => {
    const formula = prop('pFor0001', 'formula', { formula: { expression: '1' } }, 'Score');
    const rollup = prop('pRol0001', 'rollup', {
      rollup: { relationPropertyId: 'pRel0001', targetPropertyId: 'x', fn: 'sum' },
    });
    const created = prop('pCrt0001', 'createdTime', {}, 'Created');
    const db = full(database([TITLE, formula, rollup, created]));
    const rows = [
      row(1, { computed: { pFor0001: 3.5, pRol0001: 7 }, createdAt: '2026-01-05T08:00:00.000Z' }),
      row(2, { computed: { pFor0001: { error: 'formula.type' } } }),
    ] as RowRecord[];
    const change = await planDatabaseUpdate(
      db,
      {
        properties: [
          { ...formula, type: 'text', formula: undefined },
          { ...rollup, type: 'number', rollup: undefined },
          { ...created, type: 'date' },
        ],
      },
      readerOf([db], rows),
      AT,
    );
    const byId = new Map(change.rows.map((r) => [r.id, r.values]));
    expect(byId.get(rowId(1))).toEqual({
      pFor0001: '3.5',
      pRol0001: 7,
      pCrt0001: { start: '2026-01-05T08:00:00Z' },
    });
    expect(byId.get(rowId(2))).toEqual({ pCrt0001: { start: '2026-01-01T09:00:00Z' } });
  });

  it('still converts a stored value from its stored value', async () => {
    const db = full(database([TITLE, prop('pText001', 'text')]));
    const rows = [row(1, { values: { pText001: '1,234' } })] as RowRecord[];
    const change = await planDatabaseUpdate(
      db,
      { properties: [prop('pText001', 'number')] },
      readerOf([db], rows),
      AT,
    );
    expect(change.rows.map((r) => r.values)).toEqual([{ pText001: 1234 }]);
  });
});

describe('a relation that no longer pairs with its reverse', () => {
  const source = relationTo('pRel0001', DB2, 'pRev0001', 'Projects');
  const reverse = relationTo('pRev0001', DB, 'pRel0001', 'Tasks');
  const A = full(database([TITLE, source]));
  const B = full(database([TITLE, reverse, prop('qNum0001', 'number')], DB2, 4));
  const rows = [
    row(1, { values: { pRel0001: [rowId(11)] } }),
    row(11, { databaseId: DB2, values: { pRev0001: [rowId(1)] } }),
  ] as RowRecord[];

  it('leaves the reverse property one-way, its values kept, when changed into another type', async () => {
    const change = await planDatabaseUpdate(
      A,
      { properties: [{ ...source, type: 'text', relation: undefined }] },
      readerOf([A, B], rows),
      AT,
    );
    const target = change.databases.find((d) => d.id === DB2)!;
    expect(target.version).toBe(5);
    expect(target.properties.find((p) => p.id === 'pRev0001')).toEqual({
      ...reverse,
      relation: { databaseId: DB, reversePropertyId: null },
    });
    expect(target.properties.find((p) => p.id === 'qNum0001')).toEqual(B.properties[2]);
    // The target's rows are not rewritten; the source's relation values convert to nothing.
    expect(change.rows.map((r) => [r.id, r.values])).toEqual([[rowId(1), {}]]);
  });

  it('plans nothing for a target this device does not hold', async () => {
    const change = await planDatabaseUpdate(
      A,
      { properties: [{ ...source, type: 'number', relation: undefined }] },
      readerOf([A], rows),
      AT,
    );
    expect(change.databases.map((d) => d.id)).toEqual([DB]);
  });

  it('when it points at another reverse: the old one is one-way and the new one is added', async () => {
    const moved = relationTo('pRel0001', DB2, 'pNew0001', 'Projects');
    const change = await planDatabaseUpdate(A, { properties: [moved] }, readerOf([A, B], rows), AT);
    const target = change.databases.find((d) => d.id === DB2)!;
    expect(target.version).toBe(5);
    expect(
      target.properties.map((p) => [p.id, p.relation?.reversePropertyId ?? undefined]),
    ).toEqual([
      ['title', undefined],
      ['pRev0001', undefined],
      ['qNum0001', undefined],
      ['pNew0001', 'pRel0001'],
    ]);
    expect(target.properties[1].relation).toEqual({ databaseId: DB, reversePropertyId: null });
  });

  it('in a self-relation, changes the second property in the same record, once', async () => {
    const blocks = relationTo('pBlk0001', DB, 'pBby0001', 'Blocks');
    const blockedBy = relationTo('pBby0001', DB, 'pBlk0001', 'Blocked by');
    const self = full(database([TITLE, blocks, blockedBy], DB, 2));
    const change = await planDatabaseUpdate(
      self,
      { properties: [{ ...blocks, type: 'text', relation: undefined }] },
      readerOf([self], []),
      AT,
    );
    expect(change.databases).toHaveLength(1);
    expect(change.databases[0].version).toBe(3);
    expect(
      change.databases[0].properties.map((p: PropertyDef) => [p.id, p.type, p.relation]),
    ).toEqual([
      ['title', 'title', undefined],
      ['pBlk0001', 'text', undefined],
      ['pBby0001', 'relation', { databaseId: DB, reversePropertyId: null }],
    ]);
  });

  it('leaves a reverse that no longer points back alone', async () => {
    const elsewhere = full(
      database([TITLE, relationTo('pRev0001', DB3, 'pRel0001', 'Tasks')], DB2, 4),
    );
    const change = await planDatabaseUpdate(
      A,
      { properties: [{ ...source, type: 'text', relation: undefined }] },
      readerOf([A, elsewhere], rows),
      AT,
    );
    expect(change.databases.map((d) => d.id)).toEqual([DB]);
  });
});
