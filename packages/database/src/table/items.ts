// The table's items, top to bottom: for each group (or once, ungrouped) its header, its rows,
// a "load more" item while rows remain, and a "New" item when the person may add rows. Pure.
import type { RowRecord } from '@cgw/workspace';
import type { RowSnapshot } from '../host';

export type TableItem =
  | { kind: 'group'; key: string; group: string; count: number; collapsed: boolean }
  | {
      kind: 'row';
      key: string;
      group: string | null;
      row: RowRecord;
      /** Phase 17, sub-items nested: its line (absent for a flat table). */
      sub?: SubLine;
    }
  | { kind: 'more'; key: string; group: string | null }
  | { kind: 'new'; key: string; group: string | null };

/** Phase 17: a nested row's place: its depth, its shown sub-items, a parent shown for a match. */
export interface SubLine {
  depth: number;
  children: number;
  context: boolean;
  collapsed: boolean;
}

/** The key a row's sub-items are hidden by in the table's collapsed set. */
export const subKey = (rowId: string) => `t:${rowId}`;

/** Sub-items nest to five levels; a row at the fifth keeps those deeper beside it, with no toggle. */
const LAST_LEVEL = 4;

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
  if (snapshot.tree && !snapshot.groups) return treeItems(snapshot, collapsed, canAdd);
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

/**
 * Phase 17: a nested table's items: each row with its line, those under a collapsed row left out
 * (a row at the fifth level shows its deeper rows beside it and hides none).
 */
function treeItems(
  snapshot: RowSnapshot,
  collapsed: ReadonlySet<string>,
  canAdd: boolean,
): TableItem[] {
  const tree = snapshot.tree!;
  const items: TableItem[] = [];
  let hideBelow = -1;
  for (let i = 0; i < snapshot.rows.length; i++) {
    const row = snapshot.rows[i];
    const line = tree[i] ?? { depth: 0, children: 0, match: true };
    if (hideBelow >= 0) {
      if (line.depth > hideBelow) continue;
      hideBelow = -1;
    }
    const closed = line.children > 0 && line.depth < LAST_LEVEL && collapsed.has(subKey(row.id));
    items.push({
      kind: 'row',
      key: `r:${row.id}`,
      group: null,
      row,
      sub: {
        depth: line.depth,
        children: line.depth < LAST_LEVEL ? line.children : 0,
        context: !line.match,
        collapsed: closed,
      },
    });
    if (closed) hideBelow = line.depth;
  }
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

/**
 * How a screen reader counts the table's lines (Phase 12, M12.3), from the query's total rather
 * than the rows drawn or loaded. Chromium makes every `row` of a grid a row of its count, gives
 * a row without `aria-rowindex` the one after the row before it, and raises `aria-rowcount` to the
 * highest index it finds; so:
 *
 * - Ungrouped, the count is the header and the query's total; a row's index is its place among
 *   them. "Load more" stands where the first row not loaded yet will be (so it adds none), and the
 *   "New" line is no row (index 0: the table hides it from the accessibility tree and says it
 *   through its live region when it is reached).
 * - Grouped (a tree grid), each group is a row (level 1, its place among the groups), followed by
 *   the places of all of its rows when it is expanded, loaded or not (level 2, a row's place in
 *   its group of the group's count): a group's header must be a row of a tree grid, so it takes a
 *   place too, and a row's place in its group is what `aria-posinset` and `aria-setsize` say.
 */
export interface AriaLayout {
  /** `aria-rowcount`: the header and every line counted; -1 while the first page is loading. */
  rowCount: number;
  /** Each item's `aria-rowindex`, or 0 for an item that is no row (a "New" line). */
  rowIndex: Int32Array;
  /** Grouped only: each item's `aria-level` (1 a group, 2 a row or "load more"), else 0. */
  level: Uint8Array;
  /** Grouped only: `aria-posinset` (a row's place in its group, a group's among the groups). */
  posInSet: Int32Array;
  /** Grouped only: `aria-setsize` (the group's count of rows, or the number of groups). */
  setSize: Int32Array;
}

export function ariaLayout(items: readonly TableItem[], snapshot: RowSnapshot): AriaLayout {
  if (snapshot.tree && !snapshot.groups) return treeLayout(items, snapshot);
  const n = items.length;
  const rowIndex = new Int32Array(n);
  const level = new Uint8Array(n);
  const posInSet = new Int32Array(n);
  const setSize = new Int32Array(n);
  const grouped = snapshot.groups !== null;
  const groups = grouped
    ? items.reduce((sum, item) => sum + (item.kind === 'group' ? 1 : 0), 0)
    : 0;
  // `next` is the first index not taken (the header is 1); `start` the index of the current
  // group's first row (ungrouped: of the first row).
  let start = 2;
  let next = grouped ? 2 : 2 + Math.max(0, snapshot.total);
  let size = snapshot.total;
  let loaded = 0;
  let groupNo = 0;
  for (let i = 0; i < n; i++) {
    const item = items[i];
    if (item.kind === 'group') {
      rowIndex[i] = next;
      level[i] = 1;
      posInSet[i] = ++groupNo;
      setSize[i] = groups;
      start = next + 1;
      size = item.count;
      loaded = 0;
      next = start + (item.collapsed ? 0 : Math.max(0, size));
    } else if (item.kind === 'row' || item.kind === 'more') {
      // A "load more" stands for the first row not loaded yet: the place the next row will take.
      const at = item.kind === 'row' ? ++loaded : loaded + 1;
      rowIndex[i] = start + at - 1;
      next = Math.max(next, rowIndex[i] + 1);
      if (grouped) {
        level[i] = 2;
        posInSet[i] = at;
        setSize[i] = Math.max(size, at);
      }
    }
  }
  const rowCount = snapshot.loading && !snapshot.rows.length && !snapshot.complete ? -1 : next - 1;
  return { rowCount, rowIndex, level, posInSet, setSize };
}

/**
 * Phase 17: a nested table is a tree grid: each line is a row in the order shown (rows under a
 * collapsed one take no place), at its level (its depth and 1), its place among its siblings and
 * their count (its parent's sub-items, or the top level's rows). The count is the header and every
 * line shown, and the rows not loaded yet.
 */
function treeLayout(items: readonly TableItem[], snapshot: RowSnapshot): AriaLayout {
  const n = items.length;
  const rowIndex = new Int32Array(n);
  const level = new Uint8Array(n);
  const posInSet = new Int32Array(n);
  const setSize = new Int32Array(n);
  const tops = (snapshot.tree ?? []).filter((l) => l.depth === 0).length;
  // The place reached at each depth, and the sibling count there (its parent's sub-items).
  const places: number[] = [];
  const sizes: number[] = [];
  let next = 2;
  let shown = 0;
  for (let i = 0; i < n; i++) {
    const item = items[i];
    if (item.kind === 'row') {
      const depth = item.sub?.depth ?? 0;
      places.length = depth + 1;
      sizes.length = depth + 1;
      places[depth] = (places[depth] ?? 0) + 1;
      if (depth === 0) sizes[0] = tops;
      rowIndex[i] = next++;
      level[i] = depth + 1;
      posInSet[i] = places[depth];
      setSize[i] = Math.max(sizes[depth] ?? places[depth], places[depth]);
      // Its own sub-items, should they follow.
      places[depth + 1] = 0;
      sizes[depth + 1] = item.sub?.children ?? 0;
      shown++;
    } else if (item.kind === 'more') {
      rowIndex[i] = next;
      level[i] = 1;
      posInSet[i] = (places[0] ?? 0) + 1;
      setSize[i] = Math.max(tops, posInSet[i]);
    }
  }
  const rest = snapshot.complete ? 0 : Math.max(0, snapshot.total - snapshot.rows.length);
  const rowCount =
    snapshot.loading && !snapshot.rows.length && !snapshot.complete ? -1 : shown + rest + 1;
  return { rowCount, rowIndex, level, posInSet, setSize };
}

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
