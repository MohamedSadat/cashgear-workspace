// The cases of `packages/editor/vectors/sheet-embed-vectors.json`: every message type each way,
// every field's bounds, the wrong contract, wrong types, junk, prototype keys. Each verdict
// follows docs/INTEGRATIONS.md's field table; where the table leaves a point open the case's
// name says which reading it takes (also listed in the Phase 5 sheet-contract note). Track S5
// runs the same file through Sheet's validators. `vectors.test.ts` writes the file from these
// (`SHEET_VECTORS_WRITE=1`, then Prettier) and runs every vector.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface SheetVector {
  name: string;
  message: Json;
  valid: boolean;
}

export interface SheetEmbedVectors {
  about: string;
  contract: string;
  parent: SheetVector[];
  embed: SheetVector[];
}

const ABOUT =
  'sheet-embed.1 validator vectors (docs/INTEGRATIONS.md, "Contract `sheet-embed.1`"). ' +
  '`parent`: messages a Workspace page sends (init on the window, the rest on the port), run ' +
  'through parseParentMessage; `embed`: messages Sheet sends, through parseEmbedMessage. ' +
  '`valid` is the verdict. An object that is exactly {"$bytes": "<base64>"} stands for an ' +
  'ArrayBuffer of those bytes; {"$bytes": "<base64>", "$length": n} for those bytes followed by ' +
  'zero bytes up to n bytes in all. Keys such as "__proto__" are own properties (as JSON.parse ' +
  'and a structured clone make them): decode with defineProperty, never assignment.';

type Obj = { [key: string]: Json };

/** A copy of `base` with `key` set as an own property (so `__proto__` stays a key). */
function set(base: Obj, key: string, value: Json): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(base)) define(out, k, v);
  define(out, key, value);
  return out;
}

function define(target: Obj, key: string, value: Json): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** A copy of `base` without `key`. */
function drop(base: Obj, key: string): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(base)) if (k !== key) define(out, k, v);
  return out;
}

const bytes = (base64: string): Obj => ({ $bytes: base64 });
const padded = (base64: string, length: number): Obj => ({ $bytes: base64, $length: length });
const repeat = (text: string, n: number) => text.repeat(n);

/** `{"junk": {"junk": … }}`, `depth` levels. */
function deepObject(depth: number): Json {
  let value: Json = 'bottom';
  for (let i = 0; i < depth; i++) value = { junk: value };
  return value;
}

/** `[[[ … ]]]`, `depth` levels. */
function deepArray(depth: number): Json {
  let value: Json = [];
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

/** A 1x1 white PNG. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';
/** The start of a zip, as an xlsx's bytes begin. */
const ZIP = 'UEsDBBQAAAAIAA==';
/** A JPEG's start. */
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';
const PREVIEW_LIMIT = 2 * 1024 * 1024;

const ETAG = '"0193a1c0-0000-7000-8000-0000000b1001"';
const BLOB =
  'https://cgwstore.blob.core.windows.net/workbooks/0193a1c0-0000-7000-8000-0000000b0001/' +
  '0193a1c0-0000-7000-8000-0000000b1001.xlsx?sv=2025-07-05&se=2026-11-14T10%3A05%3A00Z&sr=b' +
  '&sp=r&skoid=0193&sig=k3Jd%2B9%2FqX0aZ%3D';
const urlSource: Obj = { kind: 'url', url: BLOB, etag: ETAG };
const bytesSource: Obj = { kind: 'bytes', bytes: bytes(ZIP), etag: ETAG };
const rangeView: Obj = { kind: 'range', sheet: 'Budget', range: 'A1:D20' };
const firstSheet: Obj = { kind: 'range', sheet: null, range: null };
const chartView: Obj = { kind: 'chart', sheet: 'Budget', chartId: 'Chart 1' };

const init: Obj = {
  type: 'init',
  contract: 'sheet-embed.1',
  source: urlSource,
  view: rangeView,
  theme: 'light',
  direction: 'ltr',
  locale: 'en',
};
const setView = (view: Json): Obj => ({ type: 'setView', view });
const setTheme: Obj = { type: 'setTheme', theme: 'dark', direction: 'rtl', locale: 'ar' };
const refresh = (source: Json): Obj => ({ type: 'refresh', source });
const requestPreview: Obj = {
  type: 'requestPreview',
  id: 'preview-1',
  maxWidth: 800,
  maxHeight: 600,
  scale: 2,
};
const withUrl = (url: Json): Obj => refresh({ kind: 'url', url, etag: ETAG });
const withEtag = (etag: Json): Obj => refresh({ kind: 'url', url: BLOB, etag });
const withSheet = (sheet: Json): Obj => setView({ kind: 'range', sheet, range: null });
const withRange = (range: Json): Obj => setView({ kind: 'range', sheet: null, range });

const yes = (name: string, message: Json): SheetVector => ({ name, message, valid: true });
const no = (name: string, message: Json): SheetVector => ({ name, message, valid: false });

const parent: SheetVector[] = [
  // Not a message at all.
  no('null', null),
  no('a string', 'init'),
  no('a number', 1),
  no('true', true),
  no('an array holding a valid init', [init]),
  no('bytes instead of an object', bytes(ZIP)),
  no('no type', drop(init, 'type')),
  no('type is not a string', set(init, 'type', 1)),
  no('an unknown type', { type: 'save', source: urlSource }),
  no('type in another case', set(init, 'type', 'Init')),
  no('an embed message (ready) sent by the parent', {
    type: 'ready',
    contracts: ['sheet-embed.1'],
  }),

  // init
  yes('init: a signed URL and a named range', init),
  yes(
    'init: the first sheet and its used range (null sheet and range)',
    set(init, 'view', firstSheet),
  ),
  yes('init: a chart', set(init, 'view', chartView)),
  yes(
    'init: a chart on the first sheet holding it (null sheet)',
    set(init, 'view', { kind: 'chart', sheet: null, chartId: 'Chart 1' }),
  ),
  yes('init: bytes (transferred)', set(init, 'source', bytesSource)),
  yes(
    'init: empty bytes are a valid message (the embed answers source.unavailable)',
    set(init, 'source', { kind: 'bytes', bytes: bytes(''), etag: ETAG }),
  ),
  yes('init: dark, right to left, Arabic', {
    ...init,
    theme: 'dark',
    direction: 'rtl',
    locale: 'ar',
  }),
  no(
    "init: another contract (an embed answers contract.unsupported; the vector is the validator's verdict)",
    set(init, 'contract', 'sheet-embed.2'),
  ),
  no('init: no contract', drop(init, 'contract')),
  no('init: contract is a number', set(init, 'contract', 1)),
  no('init: contract is a list', set(init, 'contract', ['sheet-embed.1'])),
  no('init: no source', drop(init, 'source')),
  no('init: no view', drop(init, 'view')),
  no('init: no theme', drop(init, 'theme')),
  no('init: no direction', drop(init, 'direction')),
  no('init: no locale', drop(init, 'locale')),
  no('init: theme "Dark"', set(init, 'theme', 'Dark')),
  no('init: theme "auto"', set(init, 'theme', 'auto')),
  no('init: direction "auto"', set(init, 'direction', 'auto')),
  no('init: locale "fr"', set(init, 'locale', 'fr')),
  no('init: locale "en-US"', set(init, 'locale', 'en-US')),
  no('init: locale null', set(init, 'locale', null)),
  no(
    "init: an extra field (no field beyond the table's)",
    set(init, 'workbookId', '0193a1c0-0000-7000-8000-0000000b0001'),
  ),
  no('init: an own "__proto__" key', set(init, '__proto__', { polluted: true })),
  no('init: a "constructor" key', set(init, 'constructor', { prototype: { polluted: true } })),
  no('init: a "prototype" key', set(init, 'prototype', { polluted: true })),
  no('init: deep junk in an extra field', set(init, 'junk', deepObject(64))),
  no('init: deep arrays as the view', set(init, 'view', deepArray(64))),
  no(
    'init: deep junk inside the source',
    set(init, 'source', set(urlSource, 'junk', deepObject(64))),
  ),
  no(
    'init: an own "__proto__" key inside the view',
    set(init, 'view', set(rangeView, '__proto__', { kind: 'range' })),
  ),

  // source
  yes('source: https to any host', withUrl('https://example.com/book.xlsx')),
  yes(
    'source: http on 127.0.0.1 with a port (Azurite)',
    withUrl('http://127.0.0.1:10000/devstoreaccount1/workbooks/b1.xlsx?sig=x'),
  ),
  yes('source: http on localhost', withUrl('http://localhost:4281/blob/b1?sig=x')),
  yes(
    'source: a URL of 4,096 characters',
    withUrl('https://example.com/' + repeat('a', 4096 - 20)),
  ),
  no('source: a URL of 4,097 characters', withUrl('https://example.com/' + repeat('a', 4097 - 20))),
  no('source: http to another host', withUrl('http://example.com/book.xlsx')),
  no('source: http to 127.0.0.2', withUrl('http://127.0.0.2/book.xlsx')),
  no(
    'source: http to [::1] (only 127.0.0.1 and localhost)',
    withUrl('http://[::1]:10000/book.xlsx'),
  ),
  no('source: http to a host ending in localhost', withUrl('http://localhost.evil.test/book.xlsx')),
  no(
    'source: http to a host starting with localhost',
    withUrl('http://localhost@evil.test/book.xlsx'),
  ),
  no(
    'source: a user name and password (reading: never in a signed URL)',
    withUrl('https://user:secret@example.com/book.xlsx'),
  ),
  no('source: ftp', withUrl('ftp://example.com/book.xlsx')),
  no('source: javascript', withUrl('javascript:alert(1)')),
  no('source: data', withUrl('data:application/octet-stream;base64,UEsDBA==')),
  no('source: blob', withUrl('blob:https://example.com/0193a1c0')),
  no('source: a relative URL', withUrl('/workbooks/b1.xlsx')),
  no(
    'source: the scheme in capitals (reading: written https:// or http://)',
    withUrl('HTTPS://example.com/book.xlsx'),
  ),
  no(
    'source: https without slashes (reading: written https://)',
    withUrl('https:example.com/book.xlsx'),
  ),
  no(
    'source: a space in the URL (reading: visible ASCII only)',
    withUrl('https://example.com/my book.xlsx'),
  ),
  no('source: a leading space', withUrl(' https://example.com/book.xlsx')),
  no(
    'source: a non-ASCII character (reading: visible ASCII only)',
    withUrl('https://example.com/دفتر.xlsx'),
  ),
  no('source: an empty URL', withUrl('')),
  no('source: URL is not a string', withUrl(1)),
  yes('etag: 3 characters', withEtag('"a"')),
  yes('etag: 256 characters', withEtag('"' + repeat('a', 254) + '"')),
  no('etag: 257 characters', withEtag('"' + repeat('a', 255) + '"')),
  no('etag: empty quotes', withEtag('""')),
  no('etag: not quoted', withEtag('0193a1c0-0000-7000-8000-0000000b1001')),
  no('etag: weak (reading: the API sends strong tags)', withEtag('W/"0193a1c0"')),
  no('etag: a quote inside', withEtag('"ab"cd"')),
  no('etag: a space inside', withEtag('"ab cd"')),
  no('etag: a non-ASCII character (reading: visible ASCII only)', withEtag('"نسخة"')),
  no('etag: null', withEtag(null)),
  no('source: no etag', refresh({ kind: 'url', url: BLOB })),
  no('source: another kind', refresh({ kind: 'blob', url: BLOB, etag: ETAG })),
  no('source: no kind', refresh({ url: BLOB, etag: ETAG })),
  no('source: a URL source carrying bytes too', refresh({ ...urlSource, bytes: bytes(ZIP) })),
  no(
    'source: kind url with bytes instead of a URL',
    refresh({ kind: 'url', bytes: bytes(ZIP), etag: ETAG }),
  ),
  no('source: bytes as base64 text', refresh({ kind: 'bytes', bytes: ZIP, etag: ETAG })),
  no(
    'source: bytes as a list of numbers',
    refresh({ kind: 'bytes', bytes: [80, 75, 3, 4], etag: ETAG }),
  ),
  no('source: null', refresh(null)),

  // setView and the view
  yes('setView: a named range', setView(rangeView)),
  yes('setView: the used range of the first sheet', setView(firstSheet)),
  yes('setView: a chart', setView(chartView)),
  no('setView: no view', { type: 'setView' }),
  no('setView: view null', setView(null)),
  no('setView: an extra field', set(setView(rangeView), 'source', urlSource)),
  no('view: an unknown kind', setView({ kind: 'table', sheet: null, range: null })),
  no('view: no kind', setView({ sheet: null, range: null })),
  no(
    'view: no sheet key (reading: a null field is written, never left out)',
    setView({ kind: 'range', range: 'A1' }),
  ),
  no('view: no range key', setView({ kind: 'range', sheet: 'Budget' })),
  no('view: a range view with a chartId', setView({ ...rangeView, chartId: 'Chart 1' })),
  no('view: a chart view with a range', setView({ ...chartView, range: 'A1' })),
  no('view: a chart view without chartId', setView({ kind: 'chart', sheet: 'Budget' })),
  yes(
    'chartId: 128 characters',
    setView({ kind: 'chart', sheet: null, chartId: repeat('c', 128) }),
  ),
  no('chartId: 129 characters', setView({ kind: 'chart', sheet: null, chartId: repeat('c', 129) })),
  no('chartId: empty', setView({ kind: 'chart', sheet: null, chartId: '' })),
  no('chartId: null', setView({ kind: 'chart', sheet: null, chartId: null })),
  yes('sheet: 1 character', withSheet('A')),
  yes('sheet: 31 characters', withSheet(repeat('s', 31))),
  no('sheet: 32 characters', withSheet(repeat('s', 32))),
  no('sheet: empty', withSheet('')),
  yes('sheet: Arabic', withSheet('الميزانية')),
  yes(
    'sheet: spaces, dots and apostrophes (only [ ] : * ? / \\ are refused)',
    withSheet("'Q1 2026. Plan'"),
  ),
  yes('sheet: 15 characters outside the BMP (30 UTF-16 code units)', withSheet(repeat('📊', 15))),
  no(
    'sheet: 16 characters outside the BMP (32 UTF-16 code units; lengths count code units)',
    withSheet(repeat('📊', 16)),
  ),
  no('sheet: holds [', withSheet('Q[1]')),
  no('sheet: holds ]', withSheet('Q1]')),
  no('sheet: holds :', withSheet('Q1:Q2')),
  no('sheet: holds *', withSheet('Q*')),
  no('sheet: holds ?', withSheet('Q?')),
  no('sheet: holds /', withSheet('Q1/Q2')),
  no('sheet: holds \\', withSheet('Q1\\Q2')),
  no('sheet: a number', withSheet(1)),
  yes('range: one cell', withRange('A1')),
  yes('range: two corners', withRange('A1:D20')),
  yes('range: the last cell', withRange('XFD1048576')),
  yes(
    'range: the whole sheet (a valid message; the embed answers range.tooLarge)',
    withRange('A1:XFD1048576'),
  ),
  yes('range: corners in either order', withRange('D20:A1')),
  yes('range: one cell written as two corners', withRange('B2:B2')),
  no('range: column past XFD', withRange('XFE1')),
  no('range: four letters', withRange('AAAA1')),
  no('range: row past 1,048,576', withRange('A1048577')),
  no('range: row 0', withRange('A0')),
  no('range: a leading zero (reading: rows without leading zeros)', withRange('A01')),
  no('range: small letters (reading: capitals only)', withRange('a1:d20')),
  no('range: with $', withRange('$A$1:$D$20')),
  no('range: with a sheet', withRange('Budget!A1:D20')),
  no('range: whole columns', withRange('A:D')),
  no('range: whole rows', withRange('1:20')),
  no('range: a corner missing', withRange('A1:')),
  no('range: three corners', withRange('A1:B2:C3')),
  no('range: spaces', withRange(' A1:D20')),
  no('range: R1C1', withRange('R1C1')),
  no('range: empty', withRange('')),
  no('range: a number', withRange(1)),

  // setTheme
  yes('setTheme: dark, right to left, Arabic', setTheme),
  yes('setTheme: light, left to right, English', {
    type: 'setTheme',
    theme: 'light',
    direction: 'ltr',
    locale: 'en',
  }),
  no('setTheme: no locale', drop(setTheme, 'locale')),
  no('setTheme: no direction', drop(setTheme, 'direction')),
  no('setTheme: theme "high-contrast"', set(setTheme, 'theme', 'high-contrast')),
  no('setTheme: an extra field', set(setTheme, 'view', rangeView)),

  // refresh
  yes('refresh: a new signed URL', refresh(urlSource)),
  yes('refresh: bytes', refresh(bytesSource)),
  no('refresh: no source', { type: 'refresh' }),
  no('refresh: an extra view', set(refresh(urlSource), 'view', rangeView)),

  // requestPreview
  yes('requestPreview', requestPreview),
  yes('id: 64 characters', set(requestPreview, 'id', repeat('a', 64))),
  yes('id: every allowed character', set(requestPreview, 'id', 'AZaz09_-')),
  no('id: 65 characters', set(requestPreview, 'id', repeat('a', 65))),
  no('id: empty', set(requestPreview, 'id', '')),
  no('id: a dot', set(requestPreview, 'id', 'preview.1')),
  no('id: a space', set(requestPreview, 'id', 'preview 1')),
  no('id: a number', set(requestPreview, 'id', 1)),
  no('requestPreview: no id', drop(requestPreview, 'id')),
  yes('maxWidth: 16', set(requestPreview, 'maxWidth', 16)),
  yes('maxWidth: 4,096', set(requestPreview, 'maxWidth', 4096)),
  no('maxWidth: 15', set(requestPreview, 'maxWidth', 15)),
  no('maxWidth: 4,097', set(requestPreview, 'maxWidth', 4097)),
  no('maxWidth: not an integer', set(requestPreview, 'maxWidth', 800.5)),
  no('maxWidth: text', set(requestPreview, 'maxWidth', '800')),
  yes('maxHeight: 16', set(requestPreview, 'maxHeight', 16)),
  yes('maxHeight: 4,096', set(requestPreview, 'maxHeight', 4096)),
  no('maxHeight: 15', set(requestPreview, 'maxHeight', 15)),
  no('maxHeight: 4,097', set(requestPreview, 'maxHeight', 4097)),
  no('maxHeight: negative', set(requestPreview, 'maxHeight', -600)),
  no('requestPreview: no maxHeight', drop(requestPreview, 'maxHeight')),
  yes('scale: 1', set(requestPreview, 'scale', 1)),
  yes('scale: 1.5', set(requestPreview, 'scale', 1.5)),
  yes('scale: 3', set(requestPreview, 'scale', 3)),
  no('scale: 2.5', set(requestPreview, 'scale', 2.5)),
  no('scale: 0', set(requestPreview, 'scale', 0)),
  no('scale: 4', set(requestPreview, 'scale', 4)),
  no('scale: text', set(requestPreview, 'scale', '2')),
  no('requestPreview: no scale', drop(requestPreview, 'scale')),
  no('requestPreview: an extra theme', set(requestPreview, 'theme', 'light')),
];

const sheets: Json = [
  { name: 'Budget', direction: 'ltr' },
  { name: 'الميزانية', direction: 'rtl' },
];
const loaded: Obj = {
  type: 'loaded',
  etag: ETAG,
  view: rangeView,
  sheets,
  charts: [],
  size: { width: 640, height: 420 },
  capped: false,
};
const withView = (view: Json) => set(loaded, 'view', view);
const withSize = (size: Json) => set(loaded, 'size', size);
const chart = { id: 'Chart 1', title: 'Spending by month', sheet: 'Budget' };
const withChart = (entry: Json) => set(loaded, 'charts', [entry]);
const preview: Obj = {
  type: 'preview',
  id: 'preview-1',
  bytes: bytes(PNG),
  width: 640,
  height: 420,
  etag: ETAG,
  view: rangeView,
};
const error = (code: Json, extra: Obj = {}): Obj => ({
  type: 'error',
  code,
  message: '',
  ...extra,
});
const ready = (contracts: Json): Obj => ({ type: 'ready', contracts });

const embed: SheetVector[] = [
  no('null', null),
  no('a string', 'ready'),
  no('an array', [ready(['sheet-embed.1'])]),
  no('bytes instead of an object', bytes(PNG)),
  no('no type', drop(loaded, 'type')),
  no('an unknown type', { type: 'saved', etag: ETAG }),
  no('type in another case', set(ready(['sheet-embed.1']), 'type', 'Ready')),
  no('a parent message (init) sent by the embed', init),
  no(
    'an own "__proto__" key holding a type',
    JSON.parse('{"__proto__": {"type": "openRequested"}}') as Json,
  ),

  // ready
  yes('ready: sheet-embed.1', ready(['sheet-embed.1'])),
  yes('ready: several contracts', ready(['sheet-embed.1', 'sheet-embed.2'])),
  yes(
    'ready: only a later contract (a valid message; the parent finds none in common)',
    ready(['sheet-embed.2']),
  ),
  yes(
    'ready: 16 contracts (reading: at most 16)',
    ready(Array.from({ length: 16 }, (_, i) => `sheet-embed.${i + 1}`)),
  ),
  no('ready: 17 contracts', ready(Array.from({ length: 17 }, (_, i) => `sheet-embed.${i + 1}`))),
  yes('ready: a contract name of 64 characters (reading: 1 to 64)', ready([repeat('c', 64)])),
  no('ready: a contract name of 65 characters', ready([repeat('c', 65)])),
  no('ready: no contracts (reading: at least one)', ready([])),
  no('ready: an empty contract name', ready([''])),
  no('ready: a contract that is not a string', ready([1])),
  no('ready: contracts as one string', ready('sheet-embed.1')),
  no('ready: no contracts field', { type: 'ready' }),
  no('ready: an extra field', set(ready(['sheet-embed.1']), 'version', '0.5.0')),

  // loaded
  yes('loaded: a range', loaded),
  yes('loaded: one cell', withView({ kind: 'range', sheet: 'Budget', range: 'A1' })),
  yes('loaded: a used range cut to the limit', {
    ...loaded,
    view: { kind: 'range', sheet: 'Budget', range: 'A1:AX100' },
    capped: true,
  }),
  yes('loaded: a chart', { ...loaded, view: chartView, charts: [chart] }),
  yes('loaded: a chart on a chart sheet, no worksheets listed', {
    ...loaded,
    view: { kind: 'chart', sheet: 'Chart1', chartId: 'Chart 1' },
    sheets: [],
    charts: [{ id: 'Chart 1', title: 'Chart 1', sheet: 'Chart1' }],
  }),
  yes(
    'loaded: 40 sheets (the table sets no bound on the lists)',
    set(
      loaded,
      'sheets',
      Array.from({ length: 40 }, (_, i) => ({ name: `S${i + 1}`, direction: 'ltr' })),
    ),
  ),
  no('loaded: a sheet entry that is not an object', set(loaded, 'sheets', ['Budget'])),
  no(
    "loaded: the view's sheet not resolved (null)",
    withView({ kind: 'range', sheet: null, range: 'A1:D20' }),
  ),
  no(
    "loaded: the view's range not resolved (null)",
    withView({ kind: 'range', sheet: 'Budget', range: null }),
  ),
  no(
    'loaded: a range not written top-left first',
    withView({ kind: 'range', sheet: 'Budget', range: 'D20:A1' }),
  ),
  no(
    'loaded: a range written bottom-left to top-right',
    withView({ kind: 'range', sheet: 'Budget', range: 'A20:D1' }),
  ),
  no(
    'loaded: one cell written as two corners (drawn as A1)',
    withView({ kind: 'range', sheet: 'Budget', range: 'A1:A1' }),
  ),
  no(
    "loaded: a chart view's sheet not resolved (null)",
    withView({ kind: 'chart', sheet: null, chartId: 'Chart 1' }),
  ),
  no('loaded: no view', drop(loaded, 'view')),
  no('loaded: an invalid etag', set(loaded, 'etag', 'v1')),
  no('loaded: no etag', drop(loaded, 'etag')),
  yes('size: 1 by 1', withSize({ width: 1, height: 1 })),
  yes('size: 100,000 by 100,000', withSize({ width: 100000, height: 100000 })),
  no('size: width 0', withSize({ width: 0, height: 420 })),
  no('size: height 100,001', withSize({ width: 640, height: 100001 })),
  no('size: a fraction', withSize({ width: 640.5, height: 420 })),
  no('size: negative', withSize({ width: -640, height: 420 })),
  no('size: no height', withSize({ width: 640 })),
  no('size: an extra field', withSize({ width: 640, height: 420, scale: 2 })),
  no('size: text', withSize({ width: '640', height: '420' })),
  no('size: a list', withSize([640, 420])),
  no('sheets: an entry without direction', set(loaded, 'sheets', [{ name: 'Budget' }])),
  no('sheets: direction "auto"', set(loaded, 'sheets', [{ name: 'Budget', direction: 'auto' }])),
  no(
    'sheets: a name of 32 characters',
    set(loaded, 'sheets', [{ name: repeat('s', 32), direction: 'ltr' }]),
  ),
  no('sheets: a name holding /', set(loaded, 'sheets', [{ name: 'Q1/Q2', direction: 'ltr' }])),
  no(
    'sheets: an entry with an extra field',
    set(loaded, 'sheets', [{ name: 'Budget', direction: 'ltr', hidden: false }]),
  ),
  no('sheets: a string', set(loaded, 'sheets', 'Budget')),
  no('sheets: missing', drop(loaded, 'sheets')),
  yes(
    'charts: a title of 255 characters (reading: 1 to 255)',
    withChart({ ...chart, title: repeat('t', 255) }),
  ),
  no('charts: a title of 256 characters', withChart({ ...chart, title: repeat('t', 256) })),
  no(
    "charts: an empty title (reading: the chart's name when it has none)",
    withChart({ ...chart, title: '' }),
  ),
  yes('charts: an id of 128 characters', withChart({ ...chart, id: repeat('c', 128) })),
  no('charts: an id of 129 characters', withChart({ ...chart, id: repeat('c', 129) })),
  no('charts: a null sheet', withChart({ ...chart, sheet: null })),
  no('charts: an entry with an extra field', withChart({ ...chart, kind: 'bar' })),
  no('charts: missing', drop(loaded, 'charts')),
  no('capped: text', set(loaded, 'capped', 'true')),
  no('capped: missing', drop(loaded, 'capped')),
  no('loaded: an extra field', set(loaded, 'workbook', { name: 'Budget.xlsx' })),
  no('loaded: an own "__proto__" key', set(loaded, '__proto__', { capped: true })),
  no('loaded: deep junk as the size', withSize(deepObject(64))),

  // resize
  yes('resize', { type: 'resize', size: { width: 640, height: 900 } }),
  no('resize: no size', { type: 'resize' }),
  no('resize: width 0', { type: 'resize', size: { width: 0, height: 900 } }),
  no('resize: an extra field', {
    type: 'resize',
    size: { width: 640, height: 900 },
    capped: false,
  }),

  // preview
  yes('preview: a PNG', preview),
  yes(
    'preview: a PNG of exactly 2 MiB (2,097,152 bytes)',
    set(preview, 'bytes', padded(PNG, PREVIEW_LIMIT)),
  ),
  no('preview: a PNG of 2,097,153 bytes', set(preview, 'bytes', padded(PNG, PREVIEW_LIMIT + 1))),
  yes(
    'preview: only the PNG signature (the validator checks the signature and the size)',
    set(preview, 'bytes', bytes('iVBORw0KGgo=')),
  ),
  no('preview: 7 bytes of the signature', set(preview, 'bytes', bytes('iVBORw0KGg=='))),
  no('preview: a JPEG', set(preview, 'bytes', bytes(JPEG))),
  no('preview: no bytes', set(preview, 'bytes', bytes(''))),
  no('preview: bytes as base64 text', set(preview, 'bytes', PNG)),
  no('preview: bytes missing', drop(preview, 'bytes')),
  yes('preview: 4,096 by 4,096 CSS pixels', { ...preview, width: 4096, height: 4096 }),
  yes('preview: 1 by 1', { ...preview, width: 1, height: 1 }),
  no('preview: width 4,097', set(preview, 'width', 4097)),
  no('preview: width 0', set(preview, 'width', 0)),
  no('preview: height a fraction', set(preview, 'height', 420.5)),
  no('preview: an invalid id', set(preview, 'id', 'preview 1')),
  no('preview: no id', drop(preview, 'id')),
  no('preview: an invalid etag', set(preview, 'etag', '"')),
  no('preview: the view not resolved', set(preview, 'view', firstSheet)),
  no('preview: an extra scale', set(preview, 'scale', 2)),

  // openRequested
  yes('openRequested', { type: 'openRequested' }),
  no('openRequested: an extra field', { type: 'openRequested', workbookId: 'b1' }),

  // error
  yes('error: source.unavailable', error('source.unavailable', { message: 'HTTP 404' })),
  yes('error: source.forbidden', error('source.forbidden')),
  yes('error: view.notFound', error('view.notFound')),
  yes('error: workbook.tooLarge', error('workbook.tooLarge')),
  yes('error: range.tooLarge', error('range.tooLarge')),
  yes('error: contract.unsupported', error('contract.unsupported')),
  yes('error: with the id of a requestPreview', error('source.unavailable', { id: 'preview-1' })),
  yes(
    'error: a message of 500 characters',
    error('source.unavailable', { message: repeat('m', 500) }),
  ),
  no(
    'error: a message of 501 characters',
    error('source.unavailable', { message: repeat('m', 501) }),
  ),
  no(
    'error: no message (reading: the field is always there, possibly empty)',
    drop(error('view.notFound'), 'message'),
  ),
  no('error: message is not a string', error('view.notFound', { message: 404 })),
  no('error: an unknown code', error('timeout')),
  no('error: a Workspace API code', error('access.denied')),
  no('error: no code', drop(error('view.notFound'), 'code')),
  no('error: an invalid id', error('source.unavailable', { id: 'p/1' })),
  no(
    'error: id null (reading: left out when not answering a requestPreview)',
    error('source.unavailable', { id: null }),
  ),
  no('error: an extra field', error('source.unavailable', { status: 404 })),
  no(
    'error: an own "__proto__" key',
    set(error('view.notFound'), '__proto__', { code: 'view.notFound' }),
  ),
];

export const sheetEmbedVectors: SheetEmbedVectors = {
  about: ABOUT,
  contract: 'sheet-embed.1',
  parent,
  embed,
};

/**
 * A vector's message as a sender holds it: `{"$bytes"}` objects become ArrayBuffers, and every
 * key stays an own property (`__proto__` included), as a structured clone keeps it.
 */
export function decodeVector(value: Json): unknown {
  if (Array.isArray(value)) return value.map(decodeVector);
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  const length = value.$length;
  if (
    typeof value.$bytes === 'string' &&
    keys.every((k) => k === '$bytes' || k === '$length') &&
    (length === undefined || typeof length === 'number')
  ) {
    const head = Uint8Array.from(atob(value.$bytes), (c) => c.charCodeAt(0));
    const out = new Uint8Array(typeof length === 'number' ? length : head.length);
    out.set(head);
    return out.buffer;
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    Object.defineProperty(out, key, {
      value: decodeVector(value[key]!),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
