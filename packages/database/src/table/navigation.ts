// Keyboard movement in the table's grid (ARIA grid pattern). The active cell is an item (a row,
// or a group header, "load more" or "New" item, which hold one cell) and a column; item -1 is the
// header row. Left and right follow the reading direction: in RTL ArrowLeft goes to the next
// column. Pure: the table maps keydown events through `navigate` and draws the result.

export interface GridPos {
  /** -1 is the header row. */
  item: number;
  /** For items of one cell, the column kept for when movement reaches a row again. */
  col: number;
}

export interface GridShape {
  /** Items under the header. */
  count: number;
  /** Columns of a row (and of the header). */
  cols: number;
  /** Whether an item is a row of cells; other items are one cell wide. */
  isRow(item: number): boolean;
  /** Items a PageUp or PageDown moves by. */
  pageSize: number;
  rtl: boolean;
}

export interface NavKey {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** Where a key moves the active cell, `'leave'` when Tab leaves the grid, null when it is not a move. */
export function navigate(pos: GridPos, event: NavKey, shape: GridShape): GridPos | 'leave' | null {
  const { count, cols } = shape;
  const mod = event.ctrlKey || event.metaKey;
  const lastItem = count - 1;
  const lastCol = Math.max(0, cols - 1);
  const wide = (item: number) => item === -1 || shape.isRow(item);
  const at = (item: number, col: number): GridPos => ({
    item: Math.max(-1, Math.min(lastItem, item)),
    col: Math.max(0, Math.min(lastCol, col)),
  });
  if (event.altKey) return null;
  switch (event.key) {
    case 'ArrowUp':
      return at(mod ? -1 : pos.item - 1, pos.col);
    case 'ArrowDown':
      return at(mod ? lastItem : pos.item + 1, pos.col);
    case 'ArrowLeft':
    case 'ArrowRight': {
      if (!wide(pos.item)) return pos;
      const forward = (event.key === 'ArrowRight') !== shape.rtl;
      if (mod) return at(pos.item, forward ? lastCol : 0);
      return at(pos.item, pos.col + (forward ? 1 : -1));
    }
    case 'Home':
      return mod ? at(-1, 0) : at(pos.item, 0);
    case 'End':
      return mod ? at(lastItem, lastCol) : at(pos.item, lastCol);
    case 'PageUp':
      return at(pos.item - shape.pageSize, pos.col);
    case 'PageDown':
      return at(pos.item + shape.pageSize, pos.col);
    case 'Tab': {
      if (event.shiftKey) {
        if (wide(pos.item) && pos.col > 0) return at(pos.item, pos.col - 1);
        if (pos.item <= -1) return 'leave';
        const prev = pos.item - 1;
        return at(prev, wide(prev) ? lastCol : 0);
      }
      if (wide(pos.item) && pos.col < lastCol) return at(pos.item, pos.col + 1);
      if (pos.item >= lastItem) return 'leave';
      return at(pos.item + 1, 0);
    }
    default:
      return null;
  }
}

/** Whether a key, pressed on a cell that is not being edited, starts typing into it. */
export function startsTyping(event: NavKey & { isComposing?: boolean }): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
  return event.key.length === 1 && event.key !== ' ';
}
