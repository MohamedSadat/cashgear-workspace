// The board's arithmetic, pure and tested on its own: a card's height (its title and a line for
// each shown property that has a value), a column's layout and the cards inside a scrolled window,
// where a dragged card lands, which neighbours a drop is between and whether it needs a new order
// key, the value a card takes in another column, and keyboard moves between cards and columns.
import type { RowRecord } from '@cgw/workspace';
import type { DateValue, GroupRule, PropertyDef, Value } from '../../core';
import type { RowPlace } from '../../host';
import { isDateValue, readCell } from '../../model/format';
import { indexAt, layoutOf, type ListLayout, type Range } from '../../table/windowing';
import { dayNumber, monthsBetween, shiftDays, shiftMonths } from '../calendar/dates';

// ---- Cards -----------------------------------------------------------------------------------

/** Block padding of a card, on each side, in CSS pixels. */
export const CARD_PADDING = 8;
export const CARD_TITLE = 22;
export const CARD_LINE = 24;
/** Space between two cards in a column. */
export const CARD_GAP = 8;
/** A column's header (name, count, menu), sticky at the top of the board. */
export const COLUMN_HEAD = 44;
/** The "New" and "Load more" buttons under a column's cards. */
export const COLUMN_FOOT = 36;

/** Whether a card shows a line for a property: it has a value (a checkbox always shows). */
export function hasLine(row: RowRecord, def: PropertyDef): boolean {
  if (def.type === 'title') return false;
  if (def.type === 'checkbox') return true;
  const value = readCell(row, def);
  return !(
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** The properties a card shows a line for, in the view's order. */
export const cardLines = (row: RowRecord, shown: readonly PropertyDef[]): PropertyDef[] =>
  shown.filter((def) => hasLine(row, def));

/** A card's height without the gap after it; `cover` is its picture's height (a gallery's). */
export const cardHeight = (row: RowRecord, shown: readonly PropertyDef[], cover = 0): number =>
  cover + CARD_PADDING * 2 + CARD_TITLE + cardLines(row, shown).length * CARD_LINE;

/** A draft card (a title being typed) is a card with no lines. */
export const DRAFT_HEIGHT = CARD_PADDING * 2 + CARD_TITLE + 6;

/** A column's cards laid out one under another, each followed by the gap. */
export const columnLayout = (
  rows: readonly RowRecord[],
  shown: readonly PropertyDef[],
): ListLayout => layoutOf(rows.length, (i) => cardHeight(rows[i], shown) + CARD_GAP);

/** The cards a window `[top, bottom)` of the column's own coordinates shows (with overscan). */
export function cardsIn(layout: ListLayout, top: number, bottom: number): Range {
  if (layout.count === 0 || bottom <= 0 || top >= layout.total) return { start: 0, end: 0 };
  const start = indexAt(layout, Math.max(0, top));
  const end = indexAt(layout, Math.max(0, bottom - 1)) + 1;
  return { start, end: Math.min(layout.count, end) };
}

// ---- Dropping --------------------------------------------------------------------------------

/**
 * Where a card dropped at `y` (the column's own coordinates) goes: before the first card whose
 * middle is below it, else at the end. Counted with every card of the column, the dragged one
 * included.
 */
export function dropIndex(layout: ListLayout, y: number): number {
  const { offsets, count } = layout;
  for (let i = 0; i < count; i++) {
    const middle = (offsets[i] + offsets[i + 1] - CARD_GAP) / 2;
    if (y < middle) return i;
  }
  return count;
}

/**
 * The drop's index among the column's other cards: in its own column, a card dropped after itself
 * counts one fewer. Null when it lands where it already is.
 */
export function targetIndex(sameColumn: boolean, from: number, index: number): number | null {
  if (!sameColumn || from < 0) return index;
  if (index === from || index === from + 1) return null;
  return index > from ? index - 1 : index;
}

/** The rows a drop at `index` of the other cards goes between. */
export function placeAt(others: readonly RowRecord[], index: number): RowPlace {
  return { after: others[index - 1]?.id ?? null, before: others[index]?.id ?? null };
}

const precedes = (a: RowRecord, b: RowRecord) =>
  a.orderKey < b.orderKey || (a.orderKey === b.orderKey && a.id < b.id);

/**
 * Whether a row dropped at `index` of the other cards needs a new order key: not when its key
 * already falls between its new neighbours'.
 */
export function needsMove(row: RowRecord, others: readonly RowRecord[], index: number): boolean {
  const after = others[index - 1];
  const before = others[index];
  return !((!after || precedes(after, row)) && (!before || precedes(row, before)));
}

/** Group properties a card can be moved between columns of: the stored ones. */
export function movableGroup(def: PropertyDef | undefined): boolean {
  if (!def || def.trashedAt) return false;
  return ['select', 'status', 'multiSelect', 'checkbox', 'person', 'date'].includes(def.type);
}

/**
 * The value a card's group property takes when it moves from column `from` to column `to`: an
 * option or a person swapped for the other (several kept), checked or not, a date moved by the
 * columns' distance (keeping its time and length); null clears it; undefined when it cannot move.
 */
export function movedGroupValue(
  def: PropertyDef | undefined,
  rule: GroupRule,
  row: RowRecord,
  from: string,
  to: string,
): Value | null | undefined {
  if (!def || !movableGroup(def) || from === to) return undefined;
  const current = row.values[def.id];
  switch (def.type) {
    case 'select':
    case 'status':
      return to === '' ? null : to;
    case 'checkbox':
      return to === 'true' ? true : null;
    case 'multiSelect':
    case 'person': {
      if (to === '') return null;
      const list = Array.isArray(current) ? current.filter((id) => id !== from) : [];
      if (!list.includes(to)) list.push(to);
      return list;
    }
    case 'date': {
      if (to === '') return null;
      if (Number.isNaN(dayNumber(to))) return undefined;
      const value = isDateValue(current) ? (current as DateValue) : null;
      if (!value || from === '') return { start: to };
      const by = rule.dateBy ?? 'month';
      if (by === 'month' || by === 'year') return shiftMonths(value, monthsBetween(from, to));
      return shiftDays(value, dayNumber(to) - dayNumber(from));
    }
    default:
      return undefined;
  }
}

// ---- Keyboard --------------------------------------------------------------------------------

export interface BoardPos {
  /** The column's index among the shown columns. */
  col: number;
  /** The card's index in its column. */
  index: number;
}

export type BoardKey = 'up' | 'down' | 'previous' | 'next' | 'first' | 'last';

/**
 * Where the focus goes from a card: up and down in its column, to the previous or next column that
 * has cards (the same index, or its last card), to the column's first or last card. Null when it
 * stays.
 */
export function moveFocus(
  counts: readonly number[],
  pos: BoardPos,
  key: BoardKey,
): BoardPos | null {
  const count = counts[pos.col] ?? 0;
  switch (key) {
    case 'up':
      return pos.index > 0 ? { col: pos.col, index: pos.index - 1 } : null;
    case 'down':
      return pos.index < count - 1 ? { col: pos.col, index: pos.index + 1 } : null;
    case 'first':
      return count && pos.index !== 0 ? { col: pos.col, index: 0 } : null;
    case 'last':
      return count && pos.index !== count - 1 ? { col: pos.col, index: count - 1 } : null;
    case 'previous':
    case 'next': {
      const step = key === 'next' ? 1 : -1;
      for (let col = pos.col + step; col >= 0 && col < counts.length; col += step)
        if (counts[col] > 0) return { col, index: Math.min(pos.index, counts[col] - 1) };
      return null;
    }
  }
}

/**
 * Where a picked-up card would land after a key: an insertion index (0 to the count of the other
 * cards) in a column. Moving to another column keeps the index, cut to its length.
 */
export function moveDrop(counts: readonly number[], pos: BoardPos, key: BoardKey): BoardPos | null {
  const max = counts[pos.col] ?? 0;
  switch (key) {
    case 'up':
      return pos.index > 0 ? { col: pos.col, index: pos.index - 1 } : null;
    case 'down':
      return pos.index < max ? { col: pos.col, index: pos.index + 1 } : null;
    case 'first':
      return pos.index !== 0 ? { col: pos.col, index: 0 } : null;
    case 'last':
      return pos.index !== max ? { col: pos.col, index: max } : null;
    case 'previous':
    case 'next': {
      const col = pos.col + (key === 'next' ? 1 : -1);
      if (col < 0 || col >= counts.length) return null;
      return { col, index: Math.min(pos.index, counts[col]) };
    }
  }
}

/** The arrow keys as board moves: left and right swap in RTL, where the next column is on the left. */
export function boardKey(key: string, rtl: boolean): BoardKey | null {
  switch (key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return rtl ? 'next' : 'previous';
    case 'ArrowRight':
      return rtl ? 'previous' : 'next';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    default:
      return null;
  }
}
