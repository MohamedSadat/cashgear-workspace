import { describe, expect, it } from 'vitest';
import type { RowRecord } from '../types';
import {
  compareRows,
  groupKeys,
  matchesFilter,
  operatorsFor,
  propertyKind,
  queryRows,
} from './query';
import type { DatabaseRecord, FilterOperator, QueryContext, QuerySpec } from './types';
import { ALICE, P, TITLE, database, prop, row } from './vectors/fixtures';

const CTX: QueryContext = { today: '2026-03-01', offsetMinutes: 0, me: ALICE };
const FORMULA = prop('pFor0001', 'formula', { formula: { expression: 'prop("pNum0001") * 2' } });
const DB_ = database([TITLE, P.number, P.select, P.multi, P.date, FORMULA]) as DatabaseRecord;
const rows = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    row(i + 1, {
      title: `Row ${i % 7}`,
      orderKey: `a${i % 5}`,
      values: {
        ...(i % 4 ? { pNum0001: i % 9 } : {}),
        pSel0001: ['optTodo1', 'optDone1', 'optLate1'][i % 3],
        pMul0001: i % 2 ? ['tagRed01', 'tagBlue1'] : ['tagBlue1'],
        pDate001: { start: `2026-03-${String((i % 28) + 1).padStart(2, '0')}` },
      },
      computed: { pFor0001: i },
    }),
  ) as RowRecord[];

describe('queries', () => {
  it('give a total order: shuffled rows sort the same', () => {
    const all = rows(300);
    const sorts = [
      { propertyId: 'pSel0001', direction: 'desc' as const },
      { propertyId: 'pNum0001', direction: 'asc' as const },
    ];
    const once = queryRows(DB_, all, { filter: null, sorts, group: null }, CTX).rows.map(
      (r) => r.id,
    );
    const shuffled = [...all].reverse();
    expect(
      queryRows(DB_, shuffled, { filter: null, sorts, group: null }, CTX).rows.map((r) => r.id),
    ).toEqual(once);
    const compare = compareRows(DB_, sorts, CTX);
    for (let i = 1; i < once.length; i++) {
      const a = all.find((r) => r.id === once[i - 1])!;
      const b = all.find((r) => r.id === once[i])!;
      expect(compare(a, b)).toBeLessThan(0);
      expect(compare(b, a)).toBeGreaterThan(0);
    }
  });

  it("read this device's formula results before the server's", () => {
    const all = rows(10);
    const spec: QuerySpec = {
      filter: {
        kind: 'group',
        op: 'and',
        children: [{ kind: 'condition', propertyId: 'pFor0001', operator: 'eq', value: 100 }],
      },
      sorts: [],
      group: null,
    };
    expect(queryRows(DB_, all, spec, CTX).rows).toHaveLength(0);
    const computed = (r: RowRecord) => (r.id === all[3].id ? { pFor0001: 100 } : undefined);
    expect(queryRows(DB_, all, spec, CTX, { computed }).rows.map((r) => r.id)).toEqual([all[3].id]);
  });

  it('count a multi-select row in each of its groups, and list it once', () => {
    const all = rows(6);
    const result = queryRows(
      DB_,
      all,
      { filter: null, sorts: [], group: { propertyId: 'pMul0001' } },
      CTX,
    );
    expect(result.groups).toEqual([
      { key: '', count: 0 },
      { key: 'tagRed01', count: 3 },
      { key: 'tagBlue1', count: 6 },
      { key: 'tagAr001', count: 0 },
    ]);
    expect(result.rows).toHaveLength(6);
    expect(groupKeys(DB_, all[1], { propertyId: 'pMul0001' }, CTX)).toEqual([
      'tagRed01',
      'tagBlue1',
    ]);
    expect(groupKeys(DB_, all[1], { propertyId: 'nothere1' }, CTX)).toEqual(['']);
  });

  it('match a null filter and a lone condition', () => {
    const r = rows(2)[1];
    expect(matchesFilter(DB_, r, null, CTX)).toBe(true);
    expect(
      matchesFilter(
        DB_,
        r,
        { kind: 'condition', propertyId: 'pNum0001', operator: 'eq', value: 1 },
        CTX,
      ),
    ).toBe(true);
    expect(
      matchesFilter(
        DB_,
        r,
        { kind: 'condition', propertyId: 'pNum0001', operator: 'eq', value: 2 },
        CTX,
      ),
    ).toBe(false);
  });

  it('give every property type a kind and its operators', () => {
    const all: FilterOperator[] = [];
    for (const def of [TITLE, ...Object.values(P), FORMULA]) {
      const kind = propertyKind(DB_, def);
      if (def.type === 'rollup') expect(kind).toBe('number');
      else expect(kind, def.type).not.toBeNull();
      if (kind) all.push(...operatorsFor(kind));
    }
    const every: FilterOperator[] = [
      'is',
      'isNot',
      'contains',
      'doesNotContain',
      'startsWith',
      'endsWith',
      'isEmpty',
      'isNotEmpty',
      'eq',
      'ne',
      'gt',
      'lt',
      'ge',
      'le',
      'before',
      'after',
      'onOrBefore',
      'onOrAfter',
      'group',
    ];
    expect(new Set(all)).toEqual(new Set(every));
  });

  it('filter, sort and group 5,000 rows quickly', () => {
    const all = rows(5000);
    const started = performance.now();
    const result = queryRows(
      DB_,
      all,
      {
        filter: {
          kind: 'group',
          op: 'and',
          children: [
            { kind: 'condition', propertyId: 'title', operator: 'contains', value: 'row' },
            { kind: 'condition', propertyId: 'pNum0001', operator: 'ge', value: 2 },
          ],
        },
        sorts: [{ propertyId: 'pDate001', direction: 'desc' }],
        group: { propertyId: 'pSel0001' },
        search: 'ro',
      },
      CTX,
    );
    const ms = performance.now() - started;
    expect(result.rows.length).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(2000);
  });
});
