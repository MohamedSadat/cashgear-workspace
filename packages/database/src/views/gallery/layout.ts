// The gallery's arithmetic: how many cards fit in a row at the view's card size, each grid row's
// height (its tallest card: the picture, the title and the lines with values), the picture a card
// shows, and keyboard moves through the grid (left and right mirrored in RTL). Pure.
import type { Id, RowRecord } from '@cgw/workspace';
import type { PropertyDef, ViewConfig } from '../../core';
import type { AssetInfo } from '../../host';
import { layoutOf, type ListLayout } from '../../table/windowing';
import { cardHeight } from '../board/layout';

export type CardSize = NonNullable<ViewConfig['cardSize']>;

export const GALLERY_GAP = 16;
export const GALLERY_PADDING = 12;
export const CARD_MIN_WIDTH: Record<CardSize, number> = { small: 180, medium: 240, large: 320 };
export const COVER_HEIGHT: Record<CardSize, number> = { small: 96, medium: 136, large: 184 };
/** The "New" tile's height when there is no card to match. */
export const NEW_TILE = 64;

/** Cards in a grid row for a box `width` pixels wide. */
export function galleryColumns(width: number, size: CardSize): number {
  const inner = Math.max(0, width - GALLERY_PADDING * 2);
  return Math.max(1, Math.floor((inner + GALLERY_GAP) / (CARD_MIN_WIDTH[size] + GALLERY_GAP)));
}

/** A card's width when `cols` share a box `width` pixels wide. */
export function cardWidth(width: number, cols: number): number {
  const inner = Math.max(0, width - GALLERY_PADDING * 2);
  return Math.max(80, Math.floor((inner - GALLERY_GAP * (cols - 1)) / cols));
}

/** The view's cover kind, and whether a card has a picture area at all. */
export const coverOf = (config: ViewConfig) => config.cover ?? { kind: 'pageCover' as const };
export const sizeOf = (config: ViewConfig): CardSize => config.cardSize ?? 'medium';
export const hasCover = (config: ViewConfig) => coverOf(config).kind !== 'none';

/**
 * The grid rows of `count` tiles (the rows' cards, then a "New" tile when `withNew`): each row as
 * tall as its tallest card, plus the gap.
 */
export function galleryLayout(
  rows: readonly RowRecord[],
  shown: readonly PropertyDef[],
  cols: number,
  cover: number,
  withNew: boolean,
): ListLayout {
  const tiles = rows.length + (withNew ? 1 : 0);
  const gridRows = Math.ceil(tiles / cols);
  return layoutOf(gridRows, (r) => {
    let tallest = 0;
    for (let i = r * cols; i < Math.min(rows.length, (r + 1) * cols); i++)
      tallest = Math.max(tallest, cardHeight(rows[i], shown, cover));
    if (!tallest) tallest = cover ? cover + NEW_TILE : NEW_TILE;
    return tallest + GALLERY_GAP;
  });
}

/**
 * The picture of a card: none, the row's page cover, or the first image among the files of a
 * property (a file whose type is not known yet is tried; a failed one shows no picture).
 */
export function coverAsset(
  row: RowRecord,
  config: ViewConfig,
  info: (id: Id) => AssetInfo | undefined,
): Id | null {
  const cover = coverOf(config);
  if (cover.kind === 'none') return null;
  if (cover.kind === 'pageCover') return row.coverAssetId;
  const files = row.values[cover.propertyId];
  if (!Array.isArray(files)) return null;
  for (const id of files) {
    const type = info(id)?.contentType;
    if (type === undefined || type.startsWith('image/')) return id;
  }
  return null;
}

/** The tile a key moves to in a grid of `count` tiles, `cols` to a row; null when it stays. */
export function galleryMove(
  index: number,
  count: number,
  cols: number,
  key: string,
  rtl: boolean,
): number | null {
  if (count === 0) return null;
  let next: number;
  switch (key) {
    case 'ArrowLeft':
      next = index + (rtl ? 1 : -1);
      break;
    case 'ArrowRight':
      next = index + (rtl ? -1 : 1);
      break;
    case 'ArrowUp':
      next = index - cols;
      break;
    case 'ArrowDown':
      next = index + cols;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = count - 1;
      break;
    default:
      return null;
  }
  if (next < 0 || next >= count) return key === 'ArrowDown' && index < count - 1 ? count - 1 : null;
  return next;
}
