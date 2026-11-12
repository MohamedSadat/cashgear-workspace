// Which items of a long list are drawn: the table lays its items (group headers, rows, the "load
// more" and "New" rows) one under another at fixed heights per kind, and draws only those inside
// the scrolled window plus an overscan on each side. Pure arithmetic, tested on its own.

export interface ListLayout {
  /** `offsets[i]` is item i's top; `offsets[count]` is the whole height. */
  offsets: Float64Array;
  count: number;
  total: number;
}

export function layoutOf(count: number, heightOf: (index: number) => number): ListLayout {
  const offsets = new Float64Array(count + 1);
  let y = 0;
  for (let i = 0; i < count; i++) {
    offsets[i] = y;
    y += heightOf(i);
  }
  offsets[count] = y;
  return { offsets, count, total: y };
}

/** The item at a vertical offset (the last item for an offset past the end, 0 when empty). */
export function indexAt(layout: ListLayout, y: number): number {
  const { offsets, count } = layout;
  if (count === 0 || y <= 0) return 0;
  if (y >= layout.total) return count - 1;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface Range {
  /** First item drawn. */
  start: number;
  /** One past the last item drawn. */
  end: number;
}

/**
 * The items to draw for a window `[scrollTop, scrollTop + viewport)` of the list's own
 * coordinates, with `overscan` items more on each side.
 */
export function visibleRange(
  layout: ListLayout,
  scrollTop: number,
  viewport: number,
  overscan: number,
): Range {
  if (layout.count === 0) return { start: 0, end: 0 };
  const first = indexAt(layout, Math.max(0, scrollTop));
  const last = indexAt(layout, Math.max(0, scrollTop + Math.max(0, viewport) - 1));
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(layout.count, last + 1 + overscan),
  };
}

/** Whether two ranges draw the same items (the table re-renders only when they differ). */
export const sameRange = (a: Range, b: Range) => a.start === b.start && a.end === b.end;

/**
 * The scroll position that brings an item fully into view under a sticky header of
 * `stickyTop` pixels, or null when it is already in view.
 */
export function revealScroll(
  layout: ListLayout,
  index: number,
  scrollTop: number,
  viewport: number,
  stickyTop: number,
): number | null {
  if (index < 0 || index >= layout.count) return null;
  const top = layout.offsets[index];
  const bottom = layout.offsets[index + 1];
  const visibleTop = scrollTop;
  const visibleBottom = scrollTop + viewport - stickyTop;
  if (top < visibleTop) return top;
  if (bottom > visibleBottom) return Math.max(0, bottom - (viewport - stickyTop));
  return null;
}

/**
 * The columns to draw for a horizontal window: the title column (0) is always drawn (it sticks);
 * of the rest, those that reach into `[scrollX, scrollX + viewport)`, plus `overscan` on each
 * side. `scrollX` is the distance scrolled from the inline start (positive in RTL too).
 */
export function columnRange(
  widths: readonly number[],
  scrollX: number,
  viewport: number,
  overscan: number,
): Range {
  if (widths.length <= 1) return { start: 1, end: widths.length };
  let x = widths[0];
  let start = -1;
  let end = widths.length;
  for (let col = 1; col < widths.length; col++) {
    const left = x;
    x += widths[col];
    if (start < 0 && x > scrollX + widths[0]) start = col;
    if (left >= scrollX + viewport) {
      end = col;
      break;
    }
  }
  if (start < 0) start = widths.length - 1;
  return {
    start: Math.max(1, start - overscan),
    end: Math.min(widths.length, end + overscan),
  };
}
