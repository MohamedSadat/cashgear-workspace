// Phase 19: a page's print layout (DATA_MODEL.md, "A page's layout"): the page record's optional
// `layout`, which the server keeps as JSON and an older build's edit never sends, so it is kept.
// Absent or null, the page prints by `DEFAULT_LAYOUT`. Its paper is A4 or Letter, portrait or
// landscape, its margins narrow, normal or wide; its header and its footer each have three places
// (start, centre, end) of text, in which `{title}`, `{date}`, `{page}` and `{pages}` are the page's
// title, the day it is printed, the page's number and the count of pages. The print view and the
// Word file read it the same way. Keys this build does not know are kept: Page setup changes only
// the ones it shows. The server holds the same rules (`PageLayouts.cs`, held to
// `vectors/page-layout-vectors.json`). The package's entry `@cgw/workspace/layout`, loaded with
// Page setup, the Word writer and the print view; the planner checks only a layout's shape.

export const PAGE_SIZES = ['a4', 'letter'] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const ORIENTATIONS = ['portrait', 'landscape'] as const;
export type PageOrientation = (typeof ORIENTATIONS)[number];
export const MARGINS = ['narrow', 'normal', 'wide'] as const;
export type PageMargins = (typeof MARGINS)[number];
export const BAND_PLACES = ['start', 'center', 'end'] as const;
export type BandPlace = (typeof BAND_PLACES)[number];
export const LAYOUT_FIELDS = ['title', 'date', 'page', 'pages'] as const;
export type LayoutField = (typeof LAYOUT_FIELDS)[number];

/** A header's or a footer's place holds at most this many characters. */
export const MAX_BAND_TEXT = 200;
/** A layout, written as JSON, is at most this long (keys this build does not know included). */
export const MAX_LAYOUT_JSON = 4000;

export interface LayoutBand {
  start: string;
  center: string;
  end: string;
}

export interface PageLayout {
  size: PageSize;
  orientation: PageOrientation;
  margins: PageMargins;
  header: LayoutBand;
  footer: LayoutBand;
}

/** How a page prints with no layout: A4, portrait, normal margins, its number at the foot. */
export const DEFAULT_LAYOUT: PageLayout = Object.freeze({
  size: 'a4',
  orientation: 'portrait',
  margins: 'normal',
  header: Object.freeze({ start: '', center: '', end: '' }),
  footer: Object.freeze({ start: '', center: '{page}', end: '' }),
}) as PageLayout;

/** The paper's width and height in millimetres, portrait. */
export const PAPER_MM: Record<PageSize, readonly [number, number]> = {
  a4: [210, 297],
  letter: [215.9, 279.4],
};

/**
 * Each margin in millimetres, as Word names them: narrow half an inch all round, normal an inch,
 * wide an inch at the top and the foot and two at the sides.
 */
export const MARGIN_MM: Record<PageMargins, { block: number; inline: number }> = {
  narrow: { block: 12.7, inline: 12.7 },
  normal: { block: 25.4, inline: 25.4 },
  wide: { block: 25.4, inline: 50.8 },
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Text a band's place may hold: no control character, no line break. */
const placeText = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_BAND_TEXT && !/\p{Cc}/u.test(value);

/**
 * Why a layout is refused, or null when it is kept: null itself (no layout) or an object whose
 * known keys hold their values (each may be absent), at most `MAX_LAYOUT_JSON` long as JSON.
 */
export function checkLayout(raw: unknown): string | null {
  if (raw === null) return null;
  if (!isObject(raw)) return 'A layout is an object';
  if (JSON.stringify(raw).length > MAX_LAYOUT_JSON) return 'The layout is too long';
  const oneOf = (key: string, values: readonly string[]) =>
    raw[key] === undefined || values.includes(raw[key] as string)
      ? null
      : `${key} is one of ${values.join(', ')}`;
  const problem =
    oneOf('size', PAGE_SIZES) ?? oneOf('orientation', ORIENTATIONS) ?? oneOf('margins', MARGINS);
  if (problem) return problem;
  for (const band of ['header', 'footer'] as const) {
    const value = raw[band];
    if (value === undefined) continue;
    if (!isObject(value)) return `${band} is an object`;
    for (const place of BAND_PLACES)
      if (value[place] !== undefined && !placeText(value[place]))
        return `${band}.${place} is text of at most ${MAX_BAND_TEXT} characters on one line`;
  }
  return null;
}

/** A band as it prints: each place's text, or the default's where it has none it can use. */
function readBand(raw: unknown, fallback: LayoutBand): LayoutBand {
  const value = isObject(raw) ? raw : {};
  const place = (key: BandPlace) => (placeText(value[key]) ? value[key] : fallback[key]);
  return { start: place('start'), center: place('center'), end: place('end') };
}

/**
 * The layout a page prints by: its own, each key it cannot use taken from `DEFAULT_LAYOUT`. A
 * header or footer the page sets is used as it is set (a place left empty stays empty); only a
 * band it does not set is the default's.
 */
export function readLayout(raw: unknown): PageLayout {
  const value = isObject(raw) ? raw : {};
  const pick = <T extends string>(key: string, values: readonly T[], fallback: T): T =>
    values.includes(value[key] as T) ? (value[key] as T) : fallback;
  const empty = { start: '', center: '', end: '' };
  return {
    size: pick('size', PAGE_SIZES, DEFAULT_LAYOUT.size),
    orientation: pick('orientation', ORIENTATIONS, DEFAULT_LAYOUT.orientation),
    margins: pick('margins', MARGINS, DEFAULT_LAYOUT.margins),
    header: isObject(value.header) ? readBand(value.header, empty) : { ...DEFAULT_LAYOUT.header },
    footer: isObject(value.footer) ? readBand(value.footer, empty) : { ...DEFAULT_LAYOUT.footer },
  };
}

/**
 * A layout changed by Page setup: the page's own (keys this build does not know kept) with the
 * known ones it sets laid over.
 */
export function withLayout(raw: unknown, change: Partial<PageLayout>): Record<string, unknown> {
  return { ...(isObject(raw) ? raw : {}), ...change };
}

export type BandPart = { text: string } | { field: LayoutField };

/** A place's text cut into its text and its fields; a brace that names no field is text. */
export function bandParts(text: string): BandPart[] {
  const parts: BandPart[] = [];
  const pattern = /\{(title|date|page|pages)\}/g;
  let at = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > at) parts.push({ text: text.slice(at, match.index) });
    parts.push({ field: match[1] as LayoutField });
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** Whether a band prints anything. */
export const bandShown = (band: LayoutBand): boolean =>
  BAND_PLACES.some((place) => band[place].trim() !== '');

/** The printed page's size and margins in millimetres (width and height as it lies). */
export function pageBox(layout: PageLayout): {
  width: number;
  height: number;
  block: number;
  inline: number;
} {
  const [w, h] = PAPER_MM[layout.size];
  const landscape = layout.orientation === 'landscape';
  return {
    width: landscape ? h : w,
    height: landscape ? w : h,
    ...MARGIN_MM[layout.margins],
  };
}
