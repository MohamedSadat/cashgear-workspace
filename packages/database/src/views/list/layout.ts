// The list view's arithmetic: line heights by kind and keyboard moves between lines. The items
// (group headers, rows, "Load more", "New") and the window are the table's (`table/items.ts`,
// `table/windowing.ts`). Pure.
import type { TableItem } from '../../table/items';

export const LIST_ROW = 36;
export const LIST_GROUP = 40;
export const LIST_OTHER = 34;
/** Lines drawn above and below the window. */
export const LIST_OVERSCAN = 10;

export const listItemHeight = (item: TableItem): number =>
  item.kind === 'row' ? LIST_ROW : item.kind === 'group' ? LIST_GROUP : LIST_OTHER;

/** The line a key moves to from `index` of `count` lines, or null when the key is not a move. */
export function listMove(
  index: number,
  count: number,
  key: string,
  pageSize: number,
): number | null {
  if (count === 0) return null;
  const last = count - 1;
  let next: number;
  switch (key) {
    case 'ArrowDown':
      next = index + 1;
      break;
    case 'ArrowUp':
      next = index - 1;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = last;
      break;
    case 'PageDown':
      next = index + pageSize;
      break;
    case 'PageUp':
      next = index - pageSize;
      break;
    default:
      return null;
  }
  next = Math.max(0, Math.min(last, next));
  return next === index ? null : next;
}
