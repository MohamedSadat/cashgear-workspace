// The board's arithmetic, pure and tested on its own: a card's height (its title and a line for
// each shown property that has a value), which neighbours a drop is between and whether it needs a
// new order key, the value a card takes in another column, and the columns' own order (Phase 8):
// the view's order over the group's, and a column's move. `CgKanbanBoard` lays the columns out,
// windows them, and works out drops and the keys; the gallery shares the cards' sizes and drops.
import type { RowRecord } from '@cgw/workspace';
import type { DateValue, GroupRule, PropertyDef, Value } from '../../core';
import type { RowPlace } from '../../host';
import { isDateValue, readCell } from '../../model/format';
import { dayNumber, monthsBetween, shiftDays, shiftMonths } from '../calendar/dates';

// ---- Cards -----------------------------------------------------------------------------------

/** Block padding of a card, on each side, in CSS pixels. */
export const CARD_PADDING = 8;
export const CARD_TITLE = 22;
export const CARD_LINE = 24;
/** Space between two cards in a column. */
export const CARD_GAP = 8;

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

// ---- Dropping --------------------------------------------------------------------------------

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

// ---- Column order (Phase 8) ----------------------------------------------------------------

/**
 * Groups in the board's order: the keys `order` names first, in its order, then the rest in the
 * order they came (the group's own: options by position, dates by time).
 */
export function orderedGroups<T extends { key: string }>(
  groups: readonly T[],
  order: readonly string[] | undefined,
): T[] {
  if (!order?.length) return groups as T[];
  const rank = new Map(order.map((key, i) => [key, i]));
  const named = groups.filter((g) => rank.has(g.key));
  named.sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  return [...named, ...groups.filter((g) => !rank.has(g.key))];
}

/** The keys with `key` moved to `index` among the others. */
export function movedOrder(keys: readonly string[], key: string, index: number): string[] {
  const others = keys.filter((k) => k !== key);
  others.splice(Math.max(0, Math.min(others.length, index)), 0, key);
  return others;
}
