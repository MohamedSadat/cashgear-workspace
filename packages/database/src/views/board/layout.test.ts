// The board's arithmetic: card heights and what a drop writes (order keys between neighbours, a
// group's value in another column). The board's window, drops and keys are `CgKanbanBoard`'s.
import { describe, expect, it } from 'vitest';
import { keysBetween, type RowRecord } from '@cgw/workspace';
import type { GroupRule, PropertyDef } from '../../core';
import { P, rowRecord, tasksProperties } from '../../testing/fixtures';
import {
  CARD_LINE,
  CARD_PADDING,
  CARD_TITLE,
  cardHeight,
  cardLines,
  movableGroup,
  movedGroupValue,
  needsMove,
  placeAt,
  targetIndex,
} from './layout';

const defs = tasksProperties('0190a000-0000-7000-8000-00000000dddd');
const def = (id: string) => defs.find((p) => p.id === id)!;
const keys = keysBetween(null, null, 6);
const row = (n: number, values: RowRecord['values'] = {}) =>
  rowRecord(
    `0190a000-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`,
    'db',
    `Row ${n}`,
    keys[n],
    values,
  );

describe('board cards', () => {
  const shown = [def(P.priority), def(P.amount), def(P.done), def(P.notes)];

  it('shows a line for each shown property with a value (a checkbox always)', () => {
    const r = row(1, { [P.priority]: 'prHigh01', [P.amount]: 12 });
    expect(cardLines(r, shown).map((d) => d.id)).toEqual([P.priority, P.amount, P.done]);
    expect(cardHeight(r, shown)).toBe(CARD_PADDING * 2 + CARD_TITLE + 3 * CARD_LINE);
    expect(cardHeight(row(2), [])).toBe(CARD_PADDING * 2 + CARD_TITLE);
    expect(cardHeight(row(2), [], 100)).toBe(100 + CARD_PADDING * 2 + CARD_TITLE);
  });
});

describe('dropping a card', () => {
  const rows = [row(0), row(1), row(2), row(3)];

  it('counts the index among the other cards, and knows a drop where the card is', () => {
    expect(targetIndex(false, -1, 2)).toBe(2);
    expect(targetIndex(true, 1, 1)).toBeNull();
    expect(targetIndex(true, 1, 2)).toBeNull();
    expect(targetIndex(true, 1, 0)).toBe(0);
    expect(targetIndex(true, 1, 4)).toBe(3);
  });

  it('places it between its new neighbours, and moves it only when its key is not already there', () => {
    const others = rows.filter((r) => r.id !== rows[1].id);
    expect(placeAt(others, 0)).toEqual({ after: null, before: rows[0].id });
    expect(placeAt(others, 2)).toEqual({ after: rows[2].id, before: rows[3].id });
    expect(placeAt(others, 3)).toEqual({ after: rows[3].id, before: null });
    // Row 1 between rows 0 and 2 is where its key already is.
    expect(needsMove(rows[1], others, 1)).toBe(false);
    expect(needsMove(rows[1], others, 0)).toBe(true);
    expect(needsMove(rows[1], others, 3)).toBe(true);
    // A card from another column whose key falls between its neighbours needs no new key.
    expect(needsMove(row(2), [row(1), row(3)], 1)).toBe(false);
    expect(needsMove(row(4), [row(1), row(3)], 1)).toBe(true);
    expect(needsMove(row(0), [], 0)).toBe(false);
  });
});

describe("a card's value in another column", () => {
  const rule: GroupRule = { propertyId: P.status };

  it('sets a select or status option, or clears it for the no-value column', () => {
    const r = row(1, { [P.status]: 'stTodo01' });
    expect(movedGroupValue(def(P.status), rule, r, 'stTodo01', 'stDone01')).toBe('stDone01');
    expect(movedGroupValue(def(P.status), rule, r, 'stTodo01', '')).toBeNull();
    expect(movedGroupValue(def(P.priority), rule, r, '', 'prHigh01')).toBe('prHigh01');
    expect(movedGroupValue(def(P.status), rule, r, 'stTodo01', 'stTodo01')).toBeUndefined();
  });

  it('swaps one option or person for the other and keeps the rest', () => {
    const r = row(1, { [P.tags]: ['tgFin001', 'tgOps001'], [P.owner]: ['p1'] });
    expect(movedGroupValue(def(P.tags), rule, r, 'tgFin001', 'tgLegal1')).toEqual([
      'tgOps001',
      'tgLegal1',
    ]);
    expect(movedGroupValue(def(P.tags), rule, r, 'tgFin001', 'tgOps001')).toEqual(['tgOps001']);
    expect(movedGroupValue(def(P.tags), rule, r, 'tgFin001', '')).toBeNull();
    expect(movedGroupValue(def(P.owner), rule, r, 'p1', 'p2')).toEqual(['p2']);
    expect(movedGroupValue(def(P.owner), rule, row(2), '', 'p2')).toEqual(['p2']);
  });

  it('checks or clears a checkbox', () => {
    expect(movedGroupValue(def(P.done), rule, row(1), 'false', 'true')).toBe(true);
    expect(
      movedGroupValue(def(P.done), rule, row(1, { [P.done]: true }), 'true', 'false'),
    ).toBeNull();
  });

  it('moves a date by the distance between its columns, keeping its length', () => {
    const due = def(P.due);
    const r = row(1, { [P.due]: { start: '2026-11-03', end: '2026-11-05' } });
    expect(
      movedGroupValue(due, { propertyId: P.due, dateBy: 'day' }, r, '2026-11-03', '2026-11-10'),
    ).toEqual({
      start: '2026-11-10',
      end: '2026-11-12',
    });
    expect(
      movedGroupValue(due, { propertyId: P.due, dateBy: 'week' }, r, '2026-11-02', '2026-11-16'),
    ).toEqual({
      start: '2026-11-17',
      end: '2026-11-19',
    });
    const end = row(2, { [P.due]: { start: '2026-01-31' } });
    expect(
      movedGroupValue(due, { propertyId: P.due, dateBy: 'month' }, end, '2026-01-01', '2026-02-01'),
    ).toEqual({
      start: '2026-02-28',
    });
    expect(
      movedGroupValue(due, { propertyId: P.due, dateBy: 'year' }, end, '2026-01-01', '2027-01-01'),
    ).toEqual({
      start: '2027-01-31',
    });
    expect(movedGroupValue(due, { propertyId: P.due }, row(3), '', '2026-05-01')).toEqual({
      start: '2026-05-01',
    });
    expect(movedGroupValue(due, { propertyId: P.due }, r, '2026-11-01', '')).toBeNull();
  });

  it('cannot move between groups the workspace works out', () => {
    const created: PropertyDef = { id: P.created, name: 'Created', type: 'createdTime' };
    expect(movableGroup(created)).toBe(false);
    expect(movableGroup({ ...def(P.status), trashedAt: '2026-11-01T00:00:00Z' })).toBe(false);
    expect(movedGroupValue(created, rule, row(1), '2026-11-01', '2026-11-02')).toBeUndefined();
    expect(movableGroup(def(P.status))).toBe(true);
  });
});
