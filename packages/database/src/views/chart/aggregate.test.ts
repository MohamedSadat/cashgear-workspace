// What the chart draws from a view's rows: a point per group in the query's order, counted by the
// query or summed and averaged from the rows (numbers and formula results, empty cells left out),
// one number for every row, which rows still need loading, and the cap.
import { describe, expect, it } from 'vitest';
import type { DatabaseRecord, RowRecord } from '@cgw/workspace';
import type { RowGroup, RowSnapshot } from '../../host';
import { ROW_CAP, measureProperty, nextToLoad, numberOf, pointsOf, totalOf } from './aggregate';

const database: DatabaseRecord = {
  id: 'db',
  workspaceId: 'ws',
  properties: [
    { id: 'title', name: 'Name', type: 'title' },
    { id: 'amount', name: 'Amount', type: 'number' },
    { id: 'twice', name: 'Twice', type: 'formula', formula: { expression: 'prop("amount") * 2' } },
    { id: 'notes', name: 'Notes', type: 'text' },
    { id: 'gone', name: 'Gone', type: 'number', trashedAt: '2026-11-01T00:00:00Z' },
    {
      id: 'status',
      name: 'Status',
      type: 'status',
      options: [
        { id: 'todo', name: 'To do', colour: 'gray', group: 'todo' },
        { id: 'done', name: 'Done', colour: 'green', group: 'complete' },
      ],
    },
  ],
  version: 1,
  rowCount: 4,
  createdAt: '2026-11-01T00:00:00Z',
};

const row = (id: string, values: Record<string, unknown>, computed: Record<string, unknown> = {}) =>
  ({ id, kind: 'row', databaseId: 'db', title: id, values, computed }) as unknown as RowRecord;

const rows = {
  a: row('a', { amount: 10, status: 'todo' }, { twice: 20 }),
  b: row('b', { amount: 5.5, status: 'todo' }, { twice: 11 }),
  c: row('c', { status: 'done' }, { twice: null }),
  d: row('d', { amount: -2, status: 'done' }, { twice: { error: 'formula.type' } }),
};
const group = (key: string, list: RowRecord[], count = list.length, complete = true): RowGroup => ({
  key,
  count,
  rows: list,
  complete,
});
const labels = (key: string) => ({ '': 'No Status', todo: 'To do', done: 'Done' })[key] ?? key;

describe('the chart points', () => {
  const groups = [group('', []), group('todo', [rows.a, rows.b]), group('done', [rows.c, rows.d])];

  it('count each group from the query, in its order, the empty group too', () => {
    const counted = pointsOf(database, groups, { kind: 'count' }, labels);
    expect(counted).toEqual({
      points: [
        { key: '', label: 'No Status', value: 0, count: 0 },
        { key: 'todo', label: 'To do', value: 2, count: 2 },
        { key: 'done', label: 'Done', value: 2, count: 2 },
      ],
      partial: false,
    });
    // The query's count, not the rows loaded: a count never needs them.
    const many = pointsOf(
      database,
      [group('todo', [rows.a], 900, false)],
      { kind: 'count' },
      labels,
    );
    expect(many.points[0].value).toBe(900);
    expect(many.partial).toBe(false);
  });

  it('sum and average numbers, leaving out empty cells', () => {
    expect(
      pointsOf(database, groups, { kind: 'sum', propertyId: 'amount' }, labels).points.map(
        (p) => p.value,
      ),
    ).toEqual([0, 15.5, -2]);
    expect(
      pointsOf(database, groups, { kind: 'average', propertyId: 'amount' }, labels).points.map(
        (p) => p.value,
      ),
    ).toEqual([null, 7.75, -2]);
    // A formula's result counts when it is a number; an empty or failed one does not.
    expect(
      pointsOf(database, groups, { kind: 'average', propertyId: 'twice' }, labels).points.map(
        (p) => p.value,
      ),
    ).toEqual([null, 15.5, null]);
  });

  it('say when a sum or average read only some of a group', () => {
    const partial = pointsOf(
      database,
      [group('todo', [rows.a], 5, false)],
      { kind: 'sum', propertyId: 'amount' },
      labels,
    );
    expect(partial).toEqual({
      points: [{ key: 'todo', label: 'To do', value: 10, count: 5 }],
      partial: true,
    });
  });
});

describe('one number for every row', () => {
  const snapshot = (list: RowRecord[], total: number, complete = true): RowSnapshot => ({
    rows: list,
    groups: null,
    total,
    complete,
    localOnly: false,
    loading: false,
    error: null,
  });

  it('counts from the query and sums or averages the rows', () => {
    const all = Object.values(rows);
    expect(totalOf(database, snapshot(all, 4), { kind: 'count' })).toEqual({
      value: 4,
      partial: false,
    });
    expect(totalOf(database, snapshot([], 4000, false), { kind: 'count' })).toEqual({
      value: 4000,
      partial: false,
    });
    expect(totalOf(database, snapshot(all, 4), { kind: 'sum', propertyId: 'amount' })).toEqual({
      value: 13.5,
      partial: false,
    });
    expect(
      totalOf(database, snapshot(all.slice(0, 2), 4, false), {
        kind: 'average',
        propertyId: 'amount',
      }),
    ).toEqual({ value: 7.75, partial: true });
  });

  it('reads numbers only from numbers and numeric results', () => {
    expect(numberOf(database, rows.a, 'amount')).toBe(10);
    expect(numberOf(database, rows.c, 'amount')).toBeNull();
    expect(numberOf(database, rows.a, 'twice')).toBe(20);
    expect(numberOf(database, rows.d, 'twice')).toBeNull();
    expect(numberOf(database, row('e', { notes: '12' }), 'notes')).toBeNull();
  });

  it('measures only a live number, formula or rollup property', () => {
    expect(measureProperty(database, { kind: 'sum', propertyId: 'amount' })?.id).toBe('amount');
    expect(measureProperty(database, { kind: 'sum', propertyId: 'twice' })?.id).toBe('twice');
    expect(measureProperty(database, { kind: 'sum', propertyId: 'notes' })).toBeUndefined();
    expect(measureProperty(database, { kind: 'sum', propertyId: 'gone' })).toBeUndefined();
    expect(measureProperty(database, { kind: 'count' })).toBeUndefined();
  });
});

describe('what to load next', () => {
  const base: RowSnapshot = {
    rows: [],
    groups: null,
    total: 0,
    complete: false,
    localOnly: false,
    loading: false,
    error: null,
  };
  const sum = { kind: 'sum', propertyId: 'amount' } as const;

  it('nothing for a count, while loading or after an error', () => {
    expect(nextToLoad(base, { kind: 'count' })).toBeNull();
    expect(nextToLoad({ ...base, loading: true }, sum)).toBeNull();
    expect(nextToLoad({ ...base, error: 'offline' }, sum)).toBeNull();
  });

  it('the next page, or the first group not complete, up to the cap', () => {
    expect(nextToLoad(base, sum)).toEqual({});
    expect(nextToLoad({ ...base, complete: true }, sum)).toBeNull();
    const groups = [group('a', [], 0), group('b', [rows.a], 3, false)];
    expect(nextToLoad({ ...base, groups }, sum)).toEqual({ group: 'b' });
    expect(nextToLoad({ ...base, groups: [group('a', [])] }, sum)).toBeNull();
    const capped = Array.from({ length: ROW_CAP }, (_, i) => row(`r${i}`, {}));
    expect(nextToLoad({ ...base, rows: capped, groups }, sum)).toBeNull();
  });
});
