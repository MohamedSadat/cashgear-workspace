// The table's items, top to bottom: for each group (or once, ungrouped) its header, its rows,
// a "load more" item while rows remain, and a "New" item when the person may add rows. Pure.
import type { RowRecord } from '@cgw/workspace';
import type { RowSnapshot } from '../host';

export type TableItem =
  | { kind: 'group'; key: string; group: string; count: number; collapsed: boolean }
  | { kind: 'row'; key: string; group: string | null; row: RowRecord }
  | { kind: 'more'; key: string; group: string | null }
  | { kind: 'new'; key: string; group: string | null };

// Row items are kept per row record (and group), so a snapshot where one row changed gives the
// same item objects for the others and their memoised rows are not drawn again.
const rowItems = new WeakMap<RowRecord, Map<string | null, Extract<TableItem, { kind: 'row' }>>>();
function rowItem(row: RowRecord, group: string | null): TableItem {
  let byGroup = rowItems.get(row);
  if (!byGroup) rowItems.set(row, (byGroup = new Map()));
  let item = byGroup.get(group);
  if (!item) {
    item = {
      kind: 'row',
      key: group === null ? `r:${row.id}` : `r:${group}:${row.id}`,
      group,
      row,
    };
    byGroup.set(group, item);
  }
  return item;
}

/**
 * The items for a snapshot. With the previous items (ungrouped), rows still at their index are
 * found by identity, so a snapshot where one row changed costs a compare per row, not a lookup.
 */
export function buildItems(
  snapshot: RowSnapshot,
  collapsed: ReadonlySet<string>,
  canAdd: boolean,
  previous?: readonly TableItem[],
): TableItem[] {
  if (!snapshot.groups && previous) {
    const rows = snapshot.rows;
    const extra = (snapshot.complete ? 0 : 1) + (canAdd ? 1 : 0);
    if (previous.length === rows.length + extra) {
      const items = new Array<TableItem>(previous.length);
      for (let i = 0; i < rows.length; i++) {
        const before = previous[i];
        items[i] =
          before.kind === 'row' && before.row === rows[i] && before.group === null
            ? before
            : rowItem(rows[i], null);
      }
      let at = rows.length;
      if (!snapshot.complete) items[at++] = { kind: 'more', key: 'm:', group: null };
      if (canAdd) items[at] = { kind: 'new', key: 'n:', group: null };
      return items;
    }
  }
  const items: TableItem[] = [];
  if (snapshot.groups) {
    for (const g of snapshot.groups) {
      const closed = collapsed.has(g.key);
      items.push({
        kind: 'group',
        key: `g:${g.key}`,
        group: g.key,
        count: g.count,
        collapsed: closed,
      });
      if (closed) continue;
      for (const row of g.rows) items.push(rowItem(row, g.key));
      if (!g.complete) items.push({ kind: 'more', key: `m:${g.key}`, group: g.key });
      if (canAdd) items.push({ kind: 'new', key: `n:${g.key}`, group: g.key });
    }
    return items;
  }
  for (const row of snapshot.rows) items.push(rowItem(row, null));
  if (!snapshot.complete) items.push({ kind: 'more', key: 'm:', group: null });
  if (canAdd) items.push({ kind: 'new', key: 'n:', group: null });
  return items;
}

/** Item heights in CSS pixels: rows (cut to one line, or wrapped), group headers, the rest. */
export const ROW_HEIGHT = 34;
export const WRAPPED_ROW_HEIGHT = 76;
export const GROUP_HEIGHT = 42;
export const HEADER_HEIGHT = 34;

export const itemHeight = (item: TableItem, wrap: boolean) =>
  item.kind === 'group'
    ? GROUP_HEIGHT
    : item.kind === 'row' && wrap
      ? WRAPPED_ROW_HEIGHT
      : ROW_HEIGHT;

/** The item index of a row (by id, in a group when given), or -1. */
export function indexOfRow(
  items: readonly TableItem[],
  rowId: string,
  group?: string | null,
): number {
  return items.findIndex(
    (item) =>
      item.kind === 'row' && item.row.id === rowId && (group === undefined || item.group === group),
  );
}
