// The table's selection: the rectangle from an anchor to the active cell, whole rows, columns and
// everything, Shift and the keys (left and right by the reading direction), and the cell under a
// point for a drag that leaves the cells (the title column sticks at the inline start).
import { describe, expect, it } from 'vitest';
import type { GridShape } from './navigation';
import {
  cellAtPoint,
  extended,
  extendTo,
  isRange,
  rowItemsIn,
  selectionRect,
  wholeOf,
} from './selection';

const shape = (rtl = false): GridShape => ({
  count: 10,
  cols: 5,
  isRow: (i) => i !== 0 && i !== 9,
  pageSize: 3,
  rtl,
});

describe('the selection', () => {
  it('is the active cell alone without one', () => {
    const rect = selectionRect(null, { item: 3, col: 2 }, shape());
    expect(rect).toEqual({ top: 3, bottom: 3, left: 2, right: 2 });
    expect(isRange(rect)).toBe(false);
  });

  it('runs from the anchor to the active cell, either way round', () => {
    const sel = { anchor: { item: 6, col: 4 }, mode: 'cells' as const };
    expect(selectionRect(sel, { item: 2, col: 1 }, shape())).toEqual({
      top: 2,
      bottom: 6,
      left: 1,
      right: 4,
    });
  });

  it('covers whole rows, whole columns, or everything', () => {
    const at = { item: 4, col: 2 };
    const rows = wholeOf(null, at, 'rows');
    expect(selectionRect(rows, { item: 5, col: 3 }, shape())).toEqual({
      top: 4,
      bottom: 5,
      left: 0,
      right: 4,
    });
    const cols = wholeOf(null, at, 'columns');
    expect(selectionRect(cols, { item: 5, col: 3 }, shape())).toEqual({
      top: 0,
      bottom: 9,
      left: 2,
      right: 3,
    });
    // Columns of whole rows are everything.
    expect(wholeOf(rows, at, 'columns').mode).toBe('all');
  });

  it('lists the row items in it, passing over group headers and New', () => {
    expect(rowItemsIn({ top: 0, bottom: 9, left: 0, right: 0 }, shape().isRow)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });
});

describe('Shift and a key', () => {
  it('moves the active end as the key alone moves the active cell, and keeps the anchor', () => {
    const pos = { item: 3, col: 1 };
    const sel = extended(null, pos);
    expect(sel.anchor).toEqual(pos);
    expect(extendTo(pos, { key: 'ArrowRight', shiftKey: true }, shape())).toEqual({
      item: 3,
      col: 2,
    });
    expect(extendTo(pos, { key: 'ArrowDown', shiftKey: true }, shape())).toEqual({
      item: 4,
      col: 1,
    });
    expect(extendTo(pos, { key: 'End', shiftKey: true, ctrlKey: true }, shape())).toEqual({
      item: 9,
      col: 4,
    });
  });

  it('follows the reading direction in RTL: ArrowLeft goes to the next column', () => {
    const pos = { item: 3, col: 1 };
    expect(extendTo(pos, { key: 'ArrowLeft', shiftKey: true }, shape(true))).toEqual({
      item: 3,
      col: 2,
    });
    expect(extendTo(pos, { key: 'ArrowRight', shiftKey: true }, shape(true))).toEqual({
      item: 3,
      col: 0,
    });
  });

  it('stays in the body (the header row is not a cell of a selection)', () => {
    expect(extendTo({ item: 0, col: 1 }, { key: 'ArrowUp', shiftKey: true }, shape())).toEqual({
      item: 0,
      col: 1,
    });
  });

  it('does not extend without Shift, with Alt, or for Tab', () => {
    const pos = { item: 3, col: 1 };
    expect(extendTo(pos, { key: 'ArrowRight' }, shape())).toBeNull();
    expect(extendTo(pos, { key: 'ArrowRight', shiftKey: true, altKey: true }, shape())).toBeNull();
    expect(extendTo(pos, { key: 'Tab', shiftKey: true }, shape())).toBeNull();
  });
});

describe('the cell under a point', () => {
  const offsets = Float64Array.from([0, 34, 68, 102, 136]);
  const widths = [280, 100, 100, 100];

  it('takes the title column at the inline start, whatever the scroll', () => {
    expect(cellAtPoint(offsets, 4, widths, 0, 500, 100, 10)).toEqual({ item: 0, col: 0 });
  });

  it('finds the column across the scroll, and the row down it', () => {
    expect(cellAtPoint(offsets, 4, widths, 34, 0, 290, 40)).toEqual({ item: 2, col: 1 });
    expect(cellAtPoint(offsets, 4, widths, 0, -100, 290, 0)).toEqual({ item: 0, col: 2 });
    expect(cellAtPoint(offsets, 4, widths, 0, 0, 5000, 5000)).toEqual({ item: 3, col: 3 });
  });
});
