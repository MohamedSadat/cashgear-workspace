// A selection of cells in the table: from an anchor to the active cell (the end the keys and the
// pointer move), as a rectangle of the table's items and columns; or whole rows, whole columns,
// everything. Pure, and kept in the table's state, not in its rows: the virtual window scrolls
// under it, and a row drawn as it comes into the window takes its marks from it. Item indices are
// the table's (group headers, "load more" and "New" items included); only row items hold cells.
import { navigate, type GridPos, type GridShape, type NavKey } from './navigation';

export type SelectMode = 'cells' | 'rows' | 'columns' | 'all';

export interface TableSelection {
  /** Where the selection started; the active cell is its other end. */
  anchor: GridPos;
  mode: SelectMode;
}

/** A rectangle of items and columns, both ends included. */
export interface CellRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The rectangle a selection covers, given the active cell (the active cell alone without one). */
export function selectionRect(
  selection: TableSelection | null,
  active: GridPos,
  shape: Pick<GridShape, 'count' | 'cols'>,
): CellRect {
  const lastItem = Math.max(0, shape.count - 1);
  const lastCol = Math.max(0, shape.cols - 1);
  const clampItem = (i: number) => Math.max(0, Math.min(lastItem, i));
  const clampCol = (c: number) => Math.max(0, Math.min(lastCol, c));
  if (!selection) {
    const item = clampItem(active.item);
    const col = clampCol(active.col);
    return { top: item, bottom: item, left: col, right: col };
  }
  const { anchor, mode } = selection;
  const rows =
    mode === 'columns' || mode === 'all'
      ? { top: 0, bottom: lastItem }
      : {
          top: clampItem(Math.min(anchor.item, active.item)),
          bottom: clampItem(Math.max(anchor.item, active.item)),
        };
  const cols =
    mode === 'rows' || mode === 'all'
      ? { left: 0, right: lastCol }
      : {
          left: clampCol(Math.min(anchor.col, active.col)),
          right: clampCol(Math.max(anchor.col, active.col)),
        };
  return { ...rows, ...cols };
}

/** Whether a rectangle is more than one cell. */
export const isRange = (rect: CellRect) => rect.top !== rect.bottom || rect.left !== rect.right;

export const rectContains = (rect: CellRect, item: number, col: number) =>
  item >= rect.top && item <= rect.bottom && col >= rect.left && col <= rect.right;

/** The keys that extend a selection with Shift held (as they move the active cell without it). */
const EXTENDING = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

export const extendsSelection = (event: NavKey) =>
  !!event.shiftKey && !event.altKey && EXTENDING.has(event.key);

/**
 * Where Shift and a key moves the active end of a selection: as the key alone moves the active
 * cell (left and right follow the reading direction), kept in the body (the header row is not a
 * cell of a selection). Null when the key does not extend.
 */
export function extendTo(pos: GridPos, event: NavKey, shape: GridShape): GridPos | null {
  if (!extendsSelection(event)) return null;
  const next = navigate(pos, { ...event, shiftKey: false }, shape);
  if (next === null || next === 'leave') return null;
  return { item: Math.max(0, next.item), col: next.col };
}

/**
 * The selection after Shift and a key, or a click with Shift: the anchor stays where it was (the
 * active cell, when there was no selection), the mode too (whole rows stay whole rows).
 */
export function extended(
  selection: TableSelection | null,
  active: GridPos,
  mode: SelectMode = 'cells',
): TableSelection {
  return selection ?? { anchor: { item: Math.max(0, active.item), col: active.col }, mode };
}

/**
 * Whole rows (Shift+Space, the row handle) or whole columns (Ctrl+Space, Shift and a click on a
 * header) of what is selected now.
 */
export function wholeOf(
  selection: TableSelection | null,
  active: GridPos,
  mode: 'rows' | 'columns',
): TableSelection {
  const anchor = selection?.anchor ?? { item: Math.max(0, active.item), col: active.col };
  if (selection?.mode === 'all') return selection;
  if (selection && selection.mode !== 'cells' && selection.mode !== mode)
    return { anchor, mode: 'all' };
  return { anchor, mode };
}

/** Row items in a rectangle, top to bottom (each item once: a row grouped twice is two items). */
export function rowItemsIn(rect: CellRect, isRow: (item: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = rect.top; i <= rect.bottom; i++) if (isRow(i)) out.push(i);
  return out;
}

/**
 * The cell under a point, from the grid's geometry (a drag that leaves the cells, or scrolls the
 * window under the pointer): the item by the rows' offsets, the column by their widths from the
 * inline start, where the title column sticks. `x` and `y` are from the grid's own box: `y` under
 * its sticky header, `x` from its inline-start edge (the right edge in RTL).
 */
export function cellAtPoint(
  offsets: ArrayLike<number>,
  count: number,
  widths: readonly number[],
  scrollTop: number,
  scrollInline: number,
  x: number,
  y: number,
): GridPos {
  const top = scrollTop + Math.max(0, y);
  let lo = 0;
  let hi = Math.max(0, count - 1);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= top) lo = mid;
    else hi = mid - 1;
  }
  let col = 0;
  if (widths.length > 1 && x >= widths[0]) {
    const across = Math.max(0, x) + Math.abs(scrollInline);
    let edge = 0;
    col = widths.length - 1;
    for (let c = 0; c < widths.length; c++) {
      edge += widths[c];
      if (across < edge) {
        col = Math.max(1, c);
        break;
      }
    }
  }
  return { item: lo, col };
}
