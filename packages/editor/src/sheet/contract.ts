// Contract `sheet-embed.1` in code (docs/INTEGRATIONS.md, "Contract `sheet-embed.1`"): the
// messages between a Workspace page and Cash Gear Sheet's `/embed` frame, and the validators both
// ends run on every message before using it. The vectors in `vectors/sheet-embed-vectors.json`
// hold each verdict; Sheet's validators run the same file (Track S5). No DOM, no network.
//
// Every message is a plain object with a known `type`, exactly the fields its table names (none
// missing, none extra: a contract version never changes once shipped), and every field as the
// field table says. A parsed message is a fresh object holding only those fields, so nothing the
// sender added (a getter, an own `__proto__`) reaches the caller.

/** The one contract version this code speaks. */
export const SHEET_EMBED_CONTRACT = 'sheet-embed.1';

/** The contract's limits (decisions, 2026-11-14). */
export const SHEET_LIMITS = Object.freeze({
  /** A workbook the embed loads; past it the embed answers `workbook.tooLarge`. */
  workbookBytes: 20 * 1024 * 1024,
  /** A named range the embed draws; past it `range.tooLarge` (a null range is cut instead). */
  rangeCells: 5000,
  /** A preview's PNG. */
  previewBytes: 2 * 1024 * 1024,
  /** A preview's `width` and `height`, CSS pixels; also `maxWidth` and `maxHeight`'s top. */
  previewSide: 4096,
});

/** Every code an `error` may carry, and what each means (INTEGRATIONS.md, "Error codes"). */
export const SHEET_ERROR_CODES = [
  'source.unavailable',
  'source.forbidden',
  'view.notFound',
  'workbook.tooLarge',
  'range.tooLarge',
  'contract.unsupported',
] as const;

export type SheetErrorCode = (typeof SHEET_ERROR_CODES)[number];

/** A signed URL to exactly one version's xlsx (about 5 minutes), or the bytes, transferred. */
export type SheetSource =
  { kind: 'url'; url: string; etag: string } | { kind: 'bytes'; bytes: ArrayBuffer; etag: string };

/**
 * Which part of the workbook is drawn. A null sheet is the first visible worksheet; a null range
 * the used range, cut to the cell limit. In `loaded` and `preview` the view is the one drawn:
 * the sheet named (in the workbook's spelling) and a range written top-left first.
 */
export type SheetView =
  | { kind: 'range'; sheet: string | null; range: string | null }
  | { kind: 'chart'; sheet: string | null; chartId: string };

export type SheetTheme = 'light' | 'dark';
/** The page's direction; each sheet keeps its own in `loaded.sheets`. */
export type SheetDirection = 'ltr' | 'rtl';
export type SheetLocale = 'en' | 'ar';
export type SheetScale = 1 | 1.5 | 2 | 3;

/** CSS pixels, positive integers, at most 100,000. */
export interface SheetSize {
  width: number;
  height: number;
}

export interface SheetInfo {
  name: string;
  direction: SheetDirection;
}

export interface SheetChartInfo {
  id: string;
  title: string;
  sheet: string;
}

export interface SheetInitMessage {
  type: 'init';
  contract: typeof SHEET_EMBED_CONTRACT;
  source: SheetSource;
  view: SheetView;
  theme: SheetTheme;
  direction: SheetDirection;
  locale: SheetLocale;
}

export interface SheetSetViewMessage {
  type: 'setView';
  view: SheetView;
}

export interface SheetSetThemeMessage {
  type: 'setTheme';
  theme: SheetTheme;
  direction: SheetDirection;
  locale: SheetLocale;
}

export interface SheetRefreshMessage {
  type: 'refresh';
  source: SheetSource;
}

export interface SheetRequestPreviewMessage {
  type: 'requestPreview';
  id: string;
  maxWidth: number;
  maxHeight: number;
  scale: SheetScale;
}

/** Parent to embed: `init` on the window, the rest on the port. */
export type SheetParentMessage =
  | SheetInitMessage
  | SheetSetViewMessage
  | SheetSetThemeMessage
  | SheetRefreshMessage
  | SheetRequestPreviewMessage;

export interface SheetReadyMessage {
  type: 'ready';
  contracts: string[];
}

export interface SheetLoadedMessage {
  type: 'loaded';
  etag: string;
  view: SheetView;
  sheets: SheetInfo[];
  charts: SheetChartInfo[];
  size: SheetSize;
  capped: boolean;
}

export interface SheetResizeMessage {
  type: 'resize';
  size: SheetSize;
}

export interface SheetPreviewMessage {
  type: 'preview';
  id: string;
  bytes: ArrayBuffer;
  width: number;
  height: number;
  etag: string;
  view: SheetView;
}

export interface SheetOpenRequestedMessage {
  type: 'openRequested';
}

export interface SheetErrorMessage {
  type: 'error';
  code: SheetErrorCode;
  /** For the log only; Workspace shows its own text by `code`. */
  message: string;
  /** Only in answer to `requestPreview`. */
  id?: string;
}

/** Embed to parent: `ready` on the window, the rest on the port. */
export type SheetEmbedMessage =
  | SheetReadyMessage
  | SheetLoadedMessage
  | SheetResizeMessage
  | SheetPreviewMessage
  | SheetOpenRequestedMessage
  | SheetErrorMessage;

// Bounds the field table leaves open (listed in the vectors' cases).
const MAX_CONTRACTS = 16;
const MAX_CONTRACT_NAME = 64;
const MAX_CHART_TITLE = 255;
const MAX_SIZE = 100_000;
const MAX_URL = 4096;
const MAX_MESSAGE = 500;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type Fields = Record<string, unknown>;

/**
 * A plain object (an `Object.prototype` of any realm, or none) whose own keys are exactly
 * `required` plus any of `optional`, each a data property: its values in a fresh map, or null.
 */
function fields(
  data: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Fields | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const proto: unknown = Object.getPrototypeOf(data);
  if (proto !== null && Object.getPrototypeOf(proto) !== null) return null;
  if (Object.prototype.toString.call(data) !== '[object Object]') return null;
  const out: Fields = Object.create(null) as Fields;
  let seen = 0;
  for (const key of Reflect.ownKeys(data)) {
    if (typeof key !== 'string') return null;
    if (!required.includes(key) && !optional.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(data, key);
    if (!descriptor || !('value' in descriptor)) return null;
    out[key] = descriptor.value;
    if (required.includes(key)) seen++;
  }
  return seen === required.length ? out : null;
}

/** The message's own `type`, when it is a plain object with a string one. */
function typeOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(data, 'type');
  return descriptor && typeof descriptor.value === 'string' ? descriptor.value : null;
}

const isString = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= max;

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

const oneOf = <T extends string>(value: unknown, options: readonly T[]): value is T =>
  typeof value === 'string' && (options as readonly string[]).includes(value);

const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  Object.prototype.toString.call(value) === '[object ArrayBuffer]';

/** `"…"`: a strong entity tag of visible ASCII, 3 to 256 characters with its quotes. */
export function isEtag(value: unknown): value is string {
  return isString(value, 3, 256) && /^"[\x21\x23-\x7e]+"$/.test(value);
}

/**
 * `https://` to any host, or `http://` to 127.0.0.1 or localhost; visible ASCII only, at most
 * 4,096 characters, no user name or password.
 */
export function isSourceUrl(value: unknown): value is string {
  if (!isString(value, 1, MAX_URL) || !/^[\x21-\x7e]+$/.test(value)) return false;
  const https = value.startsWith('https://');
  if (!https && !value.startsWith('http://')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  if (https) return url.protocol === 'https:' && url.hostname !== '';
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}

/** 1 to 31 characters (UTF-16 code units), none of `[ ] : * ? / \`. */
export function isSheetName(value: unknown): value is string {
  return isString(value, 1, 31) && !/[[\]:*?/\\]/.test(value);
}

/** A range's corners: columns 1 to 16,384 (`A` to `XFD`), rows 1 to 1,048,576. */
export interface RangeBounds {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

const RANGE = /^([A-Z]{1,3})([1-9][0-9]{0,6})(?::([A-Z]{1,3})([1-9][0-9]{0,6}))?$/;
const MAX_COLUMN = 16_384;
const MAX_ROW = 1_048_576;

function columnNumber(letters: string): number {
  let n = 0;
  for (const letter of letters) n = n * 26 + (letter.charCodeAt(0) - 64);
  return n;
}

function columnLetters(n: number): string {
  let text = '';
  for (let rest = n; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    text = String.fromCharCode(65 + ((rest - 1) % 26)) + text;
  }
  return text;
}

/**
 * A range in A1 notation without a sheet or `$` (`A1` or `A1:D20`, capital letters, rows without
 * leading zeros, corners in either order), as its bounds; null for anything else.
 */
export function parseRange(range: unknown): RangeBounds | null {
  if (typeof range !== 'string') return null;
  const match = RANGE.exec(range);
  if (!match) return null;
  const c1 = columnNumber(match[1]!);
  const r1 = Number(match[2]);
  const c2 = match[3] === undefined ? c1 : columnNumber(match[3]);
  const r2 = match[4] === undefined ? r1 : Number(match[4]);
  if (c1 > MAX_COLUMN || c2 > MAX_COLUMN || r1 > MAX_ROW || r2 > MAX_ROW) return null;
  return {
    top: Math.min(r1, r2),
    left: Math.min(c1, c2),
    bottom: Math.max(r1, r2),
    right: Math.max(c1, c2),
  };
}

/** The number of cells in a range, or null when it is not one. */
export function rangeCells(range: unknown): number | null {
  const b = parseRange(range);
  return b ? (b.bottom - b.top + 1) * (b.right - b.left + 1) : null;
}

/** A range written as a drawn view gives it: top-left first, one cell as `A1`; null if none. */
export function canonicalRange(range: unknown): string | null {
  const b = parseRange(range);
  if (!b) return null;
  const start = `${columnLetters(b.left)}${b.top}`;
  return b.top === b.bottom && b.left === b.right
    ? start
    : `${start}:${columnLetters(b.right)}${b.bottom}`;
}

/** A view; `drawn` (in `loaded` and `preview`) also needs the sheet and a canonical range. */
function parseView(data: unknown, drawn: boolean): SheetView | null {
  const kind = typeOfKind(data);
  const sheetOk = (sheet: unknown) => (sheet === null && !drawn) || isSheetName(sheet);
  if (kind === 'range') {
    const f = fields(data, ['kind', 'sheet', 'range']);
    if (!f || !sheetOk(f.sheet)) return null;
    const range = f.range;
    const rangeOk = drawn
      ? typeof range === 'string' && canonicalRange(range) === range
      : range === null || parseRange(range) !== null;
    if (!rangeOk) return null;
    return { kind, sheet: f.sheet as string | null, range: range as string | null };
  }
  if (kind === 'chart') {
    const f = fields(data, ['kind', 'sheet', 'chartId']);
    if (!f || !sheetOk(f.sheet) || !isString(f.chartId, 1, 128)) return null;
    return { kind, sheet: f.sheet as string | null, chartId: f.chartId };
  }
  return null;
}

function typeOfKind(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(data, 'kind');
  return descriptor && typeof descriptor.value === 'string' ? descriptor.value : null;
}

function parseSource(data: unknown): SheetSource | null {
  const kind = typeOfKind(data);
  if (kind === 'url') {
    const f = fields(data, ['kind', 'url', 'etag']);
    if (!f || !isSourceUrl(f.url) || !isEtag(f.etag)) return null;
    return { kind, url: f.url, etag: f.etag };
  }
  if (kind === 'bytes') {
    const f = fields(data, ['kind', 'bytes', 'etag']);
    if (!f || !isArrayBuffer(f.bytes) || !isEtag(f.etag)) return null;
    return { kind, bytes: f.bytes, etag: f.etag };
  }
  return null;
}

function parseSize(data: unknown): SheetSize | null {
  const f = fields(data, ['width', 'height']);
  if (!f || !isInteger(f.width, 1, MAX_SIZE) || !isInteger(f.height, 1, MAX_SIZE)) return null;
  return { width: f.width, height: f.height };
}

function parseList<T>(data: unknown, max: number, item: (value: unknown) => T | null): T[] | null {
  if (!Array.isArray(data) || data.length > max) return null;
  const out: T[] = [];
  for (let i = 0; i < data.length; i++) {
    const parsed = item(data[i]);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

const THEMES = ['light', 'dark'] as const;
const DIRECTIONS = ['ltr', 'rtl'] as const;
const LOCALES = ['en', 'ar'] as const;
const isId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const isScale = (value: unknown): value is SheetScale =>
  value === 1 || value === 1.5 || value === 2 || value === 3;
const isPreviewSide = (value: unknown): value is number =>
  isInteger(value, 16, SHEET_LIMITS.previewSide);

function isPng(bytes: unknown): bytes is ArrayBuffer {
  if (!isArrayBuffer(bytes)) return false;
  if (bytes.byteLength < PNG_SIGNATURE.length || bytes.byteLength > SHEET_LIMITS.previewBytes) {
    return false;
  }
  const head = new Uint8Array(bytes, 0, PNG_SIGNATURE.length);
  return PNG_SIGNATURE.every((byte, i) => head[i] === byte);
}

/** A message from the parent (`init` on the window, the rest on the port), or null. */
export function parseParentMessage(data: unknown): SheetParentMessage | null {
  switch (typeOf(data)) {
    case 'init': {
      const f = fields(data, [
        'type',
        'contract',
        'source',
        'view',
        'theme',
        'direction',
        'locale',
      ]);
      if (!f || f.contract !== SHEET_EMBED_CONTRACT) return null;
      const source = parseSource(f.source);
      const view = parseView(f.view, false);
      if (!source || !view) return null;
      if (!oneOf(f.theme, THEMES) || !oneOf(f.direction, DIRECTIONS)) return null;
      if (!oneOf(f.locale, LOCALES)) return null;
      return {
        type: 'init',
        contract: SHEET_EMBED_CONTRACT,
        source,
        view,
        theme: f.theme,
        direction: f.direction,
        locale: f.locale,
      };
    }
    case 'setView': {
      const f = fields(data, ['type', 'view']);
      const view = f && parseView(f.view, false);
      return view ? { type: 'setView', view } : null;
    }
    case 'setTheme': {
      const f = fields(data, ['type', 'theme', 'direction', 'locale']);
      if (!f || !oneOf(f.theme, THEMES) || !oneOf(f.direction, DIRECTIONS)) return null;
      if (!oneOf(f.locale, LOCALES)) return null;
      return { type: 'setTheme', theme: f.theme, direction: f.direction, locale: f.locale };
    }
    case 'refresh': {
      const f = fields(data, ['type', 'source']);
      const source = f && parseSource(f.source);
      return source ? { type: 'refresh', source } : null;
    }
    case 'requestPreview': {
      const f = fields(data, ['type', 'id', 'maxWidth', 'maxHeight', 'scale']);
      if (!f || !isId(f.id) || !isPreviewSide(f.maxWidth) || !isPreviewSide(f.maxHeight)) {
        return null;
      }
      if (!isScale(f.scale)) return null;
      return {
        type: 'requestPreview',
        id: f.id,
        maxWidth: f.maxWidth,
        maxHeight: f.maxHeight,
        scale: f.scale,
      };
    }
    default:
      return null;
  }
}

/** A message from the embed (`ready` on the window, the rest on the port), or null. */
export function parseEmbedMessage(data: unknown): SheetEmbedMessage | null {
  switch (typeOf(data)) {
    case 'ready': {
      const f = fields(data, ['type', 'contracts']);
      const contracts =
        f &&
        parseList(f.contracts, MAX_CONTRACTS, (c) =>
          isString(c, 1, MAX_CONTRACT_NAME) ? c : null,
        );
      return contracts && contracts.length > 0 ? { type: 'ready', contracts } : null;
    }
    case 'loaded': {
      const f = fields(data, ['type', 'etag', 'view', 'sheets', 'charts', 'size', 'capped']);
      if (!f || !isEtag(f.etag) || typeof f.capped !== 'boolean') return null;
      const view = parseView(f.view, true);
      const size = parseSize(f.size);
      const sheets = parseList(f.sheets, Infinity, (s): SheetInfo | null => {
        const g = fields(s, ['name', 'direction']);
        return g && isSheetName(g.name) && oneOf(g.direction, DIRECTIONS)
          ? { name: g.name, direction: g.direction }
          : null;
      });
      const charts = parseList(f.charts, Infinity, (c): SheetChartInfo | null => {
        const g = fields(c, ['id', 'title', 'sheet']);
        if (!g || !isString(g.id, 1, 128) || !isString(g.title, 1, MAX_CHART_TITLE)) return null;
        return isSheetName(g.sheet) ? { id: g.id, title: g.title, sheet: g.sheet } : null;
      });
      if (!view || !size || !sheets || !charts) return null;
      return { type: 'loaded', etag: f.etag, view, sheets, charts, size, capped: f.capped };
    }
    case 'resize': {
      const f = fields(data, ['type', 'size']);
      const size = f && parseSize(f.size);
      return size ? { type: 'resize', size } : null;
    }
    case 'preview': {
      const f = fields(data, ['type', 'id', 'bytes', 'width', 'height', 'etag', 'view']);
      if (!f || !isId(f.id) || !isPng(f.bytes) || !isEtag(f.etag)) return null;
      if (!isInteger(f.width, 1, SHEET_LIMITS.previewSide)) return null;
      if (!isInteger(f.height, 1, SHEET_LIMITS.previewSide)) return null;
      const view = parseView(f.view, true);
      if (!view) return null;
      return {
        type: 'preview',
        id: f.id,
        bytes: f.bytes,
        width: f.width,
        height: f.height,
        etag: f.etag,
        view,
      };
    }
    case 'openRequested':
      return fields(data, ['type']) ? { type: 'openRequested' } : null;
    case 'error': {
      const f = fields(data, ['type', 'code', 'message'], ['id']);
      if (!f || !oneOf(f.code, SHEET_ERROR_CODES) || !isString(f.message, 0, MAX_MESSAGE)) {
        return null;
      }
      if ('id' in f && !isId(f.id)) return null;
      return 'id' in f
        ? { type: 'error', code: f.code, message: f.message, id: f.id as string }
        : { type: 'error', code: f.code, message: f.message };
    }
    default:
      return null;
  }
}

/**
 * The `contract` an `init`-shaped message names, for the embed's side: an `init` naming a
 * contract it does not speak (and carrying a port) is answered `contract.unsupported` and counts
 * as the one `init`; one that fails validation otherwise is dropped and does not count.
 */
export function initContract(data: unknown): string | null {
  if (typeOf(data) !== 'init') return null;
  const descriptor = Object.getOwnPropertyDescriptor(data, 'contract');
  return descriptor && isString(descriptor.value, 1, MAX_CONTRACT_NAME) ? descriptor.value : null;
}

/** JSON with every object's keys sorted, no spaces: the text a hash is taken over. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Workspace's key for a picture of a view (decisions, 2026-11-14): the lower-case hex SHA-256 of
 * `{"v":1,"view":…}` as canonical JSON (keys sorted). Give it the view as drawn (`loaded.view`).
 * The theme is not in it: a picture is always drawn in the file's own light colours.
 */
export async function viewHash(view: SheetView): Promise<string> {
  const canonical =
    view.kind === 'range'
      ? { kind: view.kind, sheet: view.sheet, range: view.range }
      : { kind: view.kind, sheet: view.sheet, chartId: view.chartId };
  const text = canonicalJson({ v: 1, view: canonical });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
