import { describe, expect, it } from 'vitest';
import type { RowRecord } from '../types';
import { computeRow } from './compute';
import { applyRelationEdit, planRelationChange } from './relations';
import type { DatabaseRecord, PropertyDef } from './types';
import { DB, DB2, TITLE, database, prop, row, rowId } from './vectors/fixtures';

const relation = prop('pRel0001', 'relation', {
  relation: { databaseId: DB2, reversePropertyId: 'pRev0001' },
});
const reverse = prop('pRev0001', 'relation', {
  relation: { databaseId: DB, reversePropertyId: 'pRel0001' },
});
const rollup = prop('pRol0001', 'rollup', {
  rollup: { relationPropertyId: 'pRel0001', targetPropertyId: 'qNum0001', fn: 'sum' },
});
const usesRollup = prop('pFor0001', 'formula', { formula: { expression: 'prop("pRol0001") * 2' } });
const A = database([TITLE, relation, rollup, usesRollup]) as DatabaseRecord;
const B = database([TITLE, prop('qNum0001', 'number'), reverse], DB2) as DatabaseRecord;

describe('computeRow', () => {
  const r = row(1, {
    values: { pRel0001: [rowId(11), rowId(12)] },
    computed: { pRol0001: 99 },
  }) as RowRecord;
  const bRows = [
    row(11, { databaseId: DB2, values: { qNum0001: 3 } }),
    row(12, { databaseId: DB2, values: { qNum0001: 4 } }),
  ] as RowRecord[];

  it('computes a rollup from held rows, and formulas from it', () => {
    const related = (id: string, ids: string[]) =>
      id === DB2 ? { database: B, rows: bRows.filter((b) => ids.includes(b.id)) } : null;
    expect(computeRow(A, r, related)).toEqual({ pRol0001: 7, pFor0001: 14 });
  });

  it("leaves a rollup out when its rows are not held, and formulas read the server's result", () => {
    expect(computeRow(A, r, () => null)).toEqual({ pFor0001: 198 });
  });

  it('computes nothing for a deleted rollup or formula', () => {
    const trashed = (def: PropertyDef) => ({ ...def, trashedAt: '2026-01-01T00:00:00Z' });
    const db = database([TITLE, relation, trashed(rollup), trashed(usesRollup)]) as DatabaseRecord;
    expect(computeRow(db, r, () => ({ database: B, rows: bRows }))).toEqual({});
  });
});

describe('relations', () => {
  it('keep both sides in step through any run of edits', () => {
    // Apply random edits to A's rows; apply the planned reverse edits to B's; then every A → B
    // link has its B → A link and nothing else.
    const aValues = new Map<string, string[]>();
    const bValues = new Map<string, string[]>();
    let seed = 5;
    const random = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
    const aIds = [1, 2, 3, 4].map(rowId);
    const bIds = [11, 12, 13, 14, 15].map(rowId);
    for (let step = 0; step < 300; step++) {
      const id = aIds[random(aIds.length)];
      const before = aValues.get(id) ?? [];
      const after = bIds.filter(() => random(2) === 1);
      const edits = planRelationChange(
        A,
        { id, values: before.length ? { pRel0001: before } : {} },
        { id, values: after.length ? { pRel0001: after } : {} },
      );
      aValues.set(id, after);
      for (const edit of edits) {
        expect(edit.databaseId).toBe(DB2);
        expect(edit.propertyId).toBe('pRev0001');
        const next = applyRelationEdit(bValues.get(edit.rowId), edit);
        bValues.set(edit.rowId, (next as string[] | undefined) ?? []);
      }
    }
    for (const b of bIds)
      for (const a of aIds)
        expect((bValues.get(b) ?? []).includes(a), `${a} ↔ ${b}`).toBe(
          (aValues.get(a) ?? []).includes(b),
        );
  });
});
