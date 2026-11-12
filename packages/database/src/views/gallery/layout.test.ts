// The gallery's and the list's arithmetic: cards to a row by size, grid row heights, the picture a
// card shows, grid and list keyboard moves, and list lines over the table's items and window.
import { describe, expect, it } from 'vitest';
import { keysBetween } from '@cgw/workspace';
import type { RowSnapshot } from '../../host';
import { buildItems } from '../../table/items';
import { layoutOf, visibleRange } from '../../table/windowing';
import { P, rowRecord, tasksProperties } from '../../testing/fixtures';
import { CARD_LINE, CARD_PADDING, CARD_TITLE } from '../board/layout';
import { LIST_GROUP, LIST_ROW, listItemHeight, listMove } from '../list/layout';
import {
  GALLERY_GAP,
  NEW_TILE,
  cardWidth,
  coverAsset,
  galleryColumns,
  galleryLayout,
  galleryMove,
} from './layout';

const defs = tasksProperties('0190a000-0000-7000-8000-00000000dddd');
const keys = keysBetween(null, null, 10);
const row = (i: number, values = {}, cover: string | null = null) => ({
  ...rowRecord(
    `0190a000-0000-7000-8000-0000000001${String(i).padStart(2, '0')}`,
    'db',
    `R${i}`,
    keys[i],
    values,
  ),
  coverAssetId: cover,
});

describe('the gallery grid', () => {
  it('fits cards to a row by size', () => {
    expect(galleryColumns(960, 'medium')).toBe(3);
    expect(galleryColumns(960, 'small')).toBe(4);
    expect(galleryColumns(960, 'large')).toBe(2);
    expect(galleryColumns(200, 'large')).toBe(1);
    expect(cardWidth(960, 3)).toBe(Math.floor((960 - 24 - 2 * GALLERY_GAP) / 3));
  });

  it('makes each grid row as tall as its tallest card, with the New tile last', () => {
    const notes = defs.filter((p) => p.id === P.notes);
    const rows = [row(0), row(1, { [P.notes]: 'x' }), row(2), row(3)];
    const layout = galleryLayout(rows, notes, 3, 100, true);
    const base = 100 + CARD_PADDING * 2 + CARD_TITLE;
    expect(layout.count).toBe(2);
    expect(layout.offsets[1]).toBe(base + CARD_LINE + GALLERY_GAP);
    expect(layout.offsets[2] - layout.offsets[1]).toBe(base + GALLERY_GAP);
    // The New tile alone on a row is as tall as a picture and its button.
    const alone = galleryLayout(rows.slice(0, 3), notes, 3, 0, true);
    expect(alone.count).toBe(2);
    expect(alone.offsets[2] - alone.offsets[1]).toBe(NEW_TILE + GALLERY_GAP);
    expect(galleryLayout([], notes, 3, 0, false).count).toBe(0);
  });

  it('picks the page cover, or the first image among a files property', () => {
    const empty = {
      filter: null,
      sorts: [],
      group: null,
      properties: { order: [], hidden: [], widths: {} },
    };
    const types: Record<string, string> = { pdf: 'application/pdf', img: 'image/png' };
    const info = (id: string) =>
      types[id] ? { fileName: id, sizeBytes: 1, contentType: types[id] } : undefined;
    const r = row(1, { [P.files]: ['pdf', 'img'] }, 'cover');
    expect(coverAsset(r, { ...empty, cover: { kind: 'none' } }, info)).toBeNull();
    expect(coverAsset(r, { ...empty, cover: { kind: 'pageCover' } }, info)).toBe('cover');
    expect(coverAsset(r, empty, info)).toBe('cover');
    expect(
      coverAsset(r, { ...empty, cover: { kind: 'property', propertyId: P.files } }, info),
    ).toBe('img');
    expect(
      coverAsset(
        row(2, { [P.files]: ['pdf'] }),
        { ...empty, cover: { kind: 'property', propertyId: P.files } },
        info,
      ),
    ).toBeNull();
    // A file whose type is not known yet is tried.
    expect(
      coverAsset(
        row(3, { [P.files]: ['new'] }),
        { ...empty, cover: { kind: 'property', propertyId: P.files } },
        info,
      ),
    ).toBe('new');
  });

  it('moves through the grid, mirrored in RTL', () => {
    expect(galleryMove(0, 10, 3, 'ArrowRight', false)).toBe(1);
    expect(galleryMove(0, 10, 3, 'ArrowRight', true)).toBeNull();
    expect(galleryMove(1, 10, 3, 'ArrowLeft', true)).toBe(2);
    expect(galleryMove(1, 10, 3, 'ArrowDown', false)).toBe(4);
    expect(galleryMove(8, 10, 3, 'ArrowDown', false)).toBe(9);
    expect(galleryMove(9, 10, 3, 'ArrowDown', false)).toBeNull();
    expect(galleryMove(4, 10, 3, 'ArrowUp', false)).toBe(1);
    expect(galleryMove(4, 10, 3, 'End', false)).toBe(9);
    expect(galleryMove(4, 10, 3, 'Tab', false)).toBeNull();
  });
});

describe('the list', () => {
  const snapshot = (groups: boolean): RowSnapshot => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(i % 10));
    return {
      rows,
      groups: groups
        ? [
            { key: '', count: 400, rows: rows.slice(0, 400), complete: true },
            { key: 'a', count: 700, rows: rows.slice(400), complete: false },
          ]
        : null,
      total: 1100,
      complete: !groups,
      localOnly: false,
      loading: false,
      error: null,
    };
  };

  it('draws only the lines in the window', () => {
    const items = buildItems(snapshot(false), new Set(), true);
    const layout = layoutOf(items.length, (i) => listItemHeight(items[i]));
    expect(layout.total).toBe(1000 * LIST_ROW + 34);
    const range = visibleRange(layout, LIST_ROW * 500, 600, 10);
    expect(range.start).toBe(490);
    expect(range.end - range.start).toBeLessThan(40);
  });

  it('heads groups, and a collapsed group shows only its header', () => {
    const items = buildItems(snapshot(true), new Set(['']), false);
    expect(items[0]).toMatchObject({ kind: 'group', group: '', collapsed: true });
    expect(items[1]).toMatchObject({ kind: 'group', group: 'a' });
    expect(listItemHeight(items[0])).toBe(LIST_GROUP);
    expect(items.at(-1)).toMatchObject({ kind: 'more', group: 'a' });
  });

  it('moves between lines with the arrows, Home, End and the page keys', () => {
    expect(listMove(0, 10, 'ArrowDown', 5)).toBe(1);
    expect(listMove(0, 10, 'ArrowUp', 5)).toBeNull();
    expect(listMove(3, 10, 'PageDown', 5)).toBe(8);
    expect(listMove(8, 10, 'PageDown', 5)).toBe(9);
    expect(listMove(8, 10, 'Home', 5)).toBe(0);
    expect(listMove(2, 10, 'End', 5)).toBe(9);
    expect(listMove(2, 0, 'End', 5)).toBeNull();
    expect(listMove(2, 10, 'Enter', 5)).toBeNull();
  });
});
