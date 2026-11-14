// A workbook block's view in sheet-embed.1's terms, and the sizes of the pictures it asks for. No
// DOM, no network: the block (SheetBlock.tsx) and its tests share these.
import { canonicalRange, type SheetBlockAttrs, type SheetScale, type SheetView } from '@cgw/editor';

/** The frame's most height when the block sets none, CSS pixels. */
export const DEFAULT_HEIGHT = 480;
/** The least and most height the view picker takes. */
export const MIN_HEIGHT = 120;
export const MAX_HEIGHT = 4000;
/** A range in A1 notation, as the range fields' example (the same in every language). */
export const RANGE_EXAMPLE = 'A1:D20';
/** A picture's side at most, in device pixels (the server checks the PNG's own pixels). */
const MAX_PIXELS = 4096;

/** The view a block's attributes name: a chart when it has one, else a range of a sheet. */
export function blockView(attrs: Pick<SheetBlockAttrs, 'sheet' | 'range' | 'chartId'>): SheetView {
  return attrs.chartId
    ? { kind: 'chart', sheet: attrs.sheet ?? null, chartId: attrs.chartId }
    : { kind: 'range', sheet: attrs.sheet ?? null, range: attrs.range ?? null };
}

/**
 * Whether the view the embed drew is the block's view. What it drew names the sheet and range in
 * the workbook's own spelling, so a null sheet or range matches any, sheet names match without
 * case and ranges by their canonical form.
 */
export function drawnIs(drawn: SheetView, wanted: SheetView): boolean {
  if (drawn.kind !== wanted.kind) return false;
  const sameSheet =
    wanted.sheet === null || drawn.sheet?.toLocaleLowerCase() === wanted.sheet.toLocaleLowerCase();
  if (!sameSheet) return false;
  if (wanted.kind === 'chart') return drawn.kind === 'chart' && drawn.chartId === wanted.chartId;
  if (drawn.kind !== 'range') return false;
  return wanted.range === null || canonicalRange(wanted.range) === canonicalRange(drawn.range);
}

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, Math.round(value)));

/**
 * What to ask the embed for: the frame's width and height in CSS pixels (16 to 4,096), at the
 * screen's density but at most 2, lowered until neither side passes 4,096 device pixels.
 */
export function previewRequest(
  width: number,
  height: number,
  devicePixelRatio = 1,
): { maxWidth: number; maxHeight: number; scale: SheetScale } {
  const maxWidth = clamp(width || 0, 16, MAX_PIXELS);
  const maxHeight = clamp(height || 0, 16, MAX_PIXELS);
  const wanted = devicePixelRatio >= 2 ? 2 : devicePixelRatio >= 1.5 ? 1.5 : 1;
  const scales: SheetScale[] = [2, 1.5, 1];
  const scale =
    scales.find((s) => s <= wanted && maxWidth * s <= MAX_PIXELS && maxHeight * s <= MAX_PIXELS) ??
    1;
  return { maxWidth, maxHeight, scale };
}

/** The version id a content entity tag names (`"<versionId>"`). */
export const versionOfEtag = (etag: string) => etag.replace(/^"|"$/g, '');
