// The mock Sheet embed's own reading of sheet-embed.1 (docs/INTEGRATIONS.md, "Contract
// `sheet-embed.1`"): written apart from packages/editor/src/sheet/contract.ts, as Sheet's is, so
// the shared vectors check two implementations. It validates what an embed receives (parent
// messages); runs in Node and in the mock's `/embed` page.

export const CONTRACT = 'sheet-embed.1';

export const ERROR_CODES = Object.freeze([
  'source.unavailable',
  'source.forbidden',
  'view.notFound',
  'workbook.tooLarge',
  'range.tooLarge',
  'contract.unsupported',
]);

export const LIMITS = Object.freeze({
  workbookBytes: 20 * 1024 * 1024,
  rangeCells: 5000,
  previewBytes: 2 * 1024 * 1024,
  previewSide: 4096,
});

/** The origins an `init` may come from: Workspace's live, desktop and development pages. */
export const WORKSPACE_ORIGINS = Object.freeze([
  'https://workspace.cashgearerp.com',
  'tauri://localhost',
  'http://tauri.localhost',
  'http://127.0.0.1:5273',
  'http://127.0.0.1:4273',
  'http://localhost:5273',
  'http://localhost:4273',
]);

const toString = (value) => Object.prototype.toString.call(value);

/** The own data properties of a plain object, if its keys are exactly these; else undefined. */
function take(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (toString(value) !== '[object Object]') return undefined;
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && Object.getPrototypeOf(proto) !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) return undefined;
  if (required.some((key) => !keys.includes(key))) return undefined;
  const out = new Map();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!('value' in descriptor)) return undefined;
    out.set(key, descriptor.value);
  }
  return out;
}

const text = (value, min, max) =>
  typeof value === 'string' && value.length >= min && value.length <= max;
const among = (value, options) => typeof value === 'string' && options.includes(value);
const whole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function sourceUrl(value) {
  if (!text(value, 1, 4096)) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  const secure = value.startsWith('https://');
  if (!secure && !value.startsWith('http://')) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return secure ? url.host.length > 0 : ['127.0.0.1', 'localhost'].includes(url.hostname);
}

function etag(value) {
  if (!text(value, 3, 256) || value[0] !== '"' || value[value.length - 1] !== '"') return false;
  for (let i = 1; i < value.length - 1; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x22 || code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

export function sheetName(value) {
  if (!text(value, 1, 31)) return false;
  for (const bad of '[]:*?/\\') if (value.includes(bad)) return false;
  return true;
}

/** `{top, left, bottom, right}` of `A1` or `A1:D20` (corners in either order), or null. */
export function rangeBounds(value) {
  if (typeof value !== 'string') return null;
  const corners = value.split(':');
  if (corners.length > 2) return null;
  const cells = [];
  for (const corner of corners) {
    const match = /^([A-Z]+)([0-9]+)$/.exec(corner);
    if (!match || match[1].length > 3 || match[2][0] === '0' || match[2].length > 7) return null;
    let col = 0;
    for (const letter of match[1]) col = col * 26 + letter.charCodeAt(0) - 64;
    const row = Number(match[2]);
    if (col > 16384 || row > 1048576) return null;
    cells.push({ col, row });
  }
  const [a, b = a] = cells;
  return {
    top: Math.min(a.row, b.row),
    left: Math.min(a.col, b.col),
    bottom: Math.max(a.row, b.row),
    right: Math.max(a.col, b.col),
  };
}

function view(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
  const sheetOk = (sheet) => sheet === null || sheetName(sheet);
  if (kind === 'range') {
    const f = take(value, ['kind', 'sheet', 'range']);
    if (!f || !sheetOk(f.get('sheet'))) return undefined;
    if (f.get('range') !== null && !rangeBounds(f.get('range'))) return undefined;
    return { kind, sheet: f.get('sheet'), range: f.get('range') };
  }
  if (kind === 'chart') {
    const f = take(value, ['kind', 'sheet', 'chartId']);
    if (!f || !sheetOk(f.get('sheet')) || !text(f.get('chartId'), 1, 128)) return undefined;
    return { kind, sheet: f.get('sheet'), chartId: f.get('chartId') };
  }
  return undefined;
}

function source(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
  if (kind === 'url') {
    const f = take(value, ['kind', 'url', 'etag']);
    return f && sourceUrl(f.get('url')) && etag(f.get('etag'))
      ? { kind, url: f.get('url'), etag: f.get('etag') }
      : undefined;
  }
  if (kind === 'bytes') {
    const f = take(value, ['kind', 'bytes', 'etag']);
    return f && toString(f.get('bytes')) === '[object ArrayBuffer]' && etag(f.get('etag'))
      ? { kind, bytes: f.get('bytes'), etag: f.get('etag') }
      : undefined;
  }
  return undefined;
}

const look = (f) =>
  among(f.get('theme'), ['light', 'dark']) &&
  among(f.get('direction'), ['ltr', 'rtl']) &&
  among(f.get('locale'), ['en', 'ar']);

/** The `type` of a plain object's own data property, or undefined. */
function typeOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, 'type')?.value;
}

/** A parent message the embed may use, rebuilt from its fields, or null. */
export function parseParentMessage(value) {
  const type = typeOf(value);
  if (type === 'init') {
    const keys = ['type', 'contract', 'source', 'view', 'theme', 'direction', 'locale'];
    const f = take(value, keys);
    if (!f || f.get('contract') !== CONTRACT || !look(f)) return null;
    const s = source(f.get('source'));
    const v = view(f.get('view'));
    if (!s || !v) return null;
    return {
      type,
      contract: CONTRACT,
      source: s,
      view: v,
      theme: f.get('theme'),
      direction: f.get('direction'),
      locale: f.get('locale'),
    };
  }
  if (type === 'setView') {
    const f = take(value, ['type', 'view']);
    const v = f && view(f.get('view'));
    return v ? { type, view: v } : null;
  }
  if (type === 'setTheme') {
    const f = take(value, ['type', 'theme', 'direction', 'locale']);
    return f && look(f)
      ? { type, theme: f.get('theme'), direction: f.get('direction'), locale: f.get('locale') }
      : null;
  }
  if (type === 'refresh') {
    const f = take(value, ['type', 'source']);
    const s = f && source(f.get('source'));
    return s ? { type, source: s } : null;
  }
  if (type === 'requestPreview') {
    const f = take(value, ['type', 'id', 'maxWidth', 'maxHeight', 'scale']);
    if (!f) return null;
    const id = f.get('id');
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    if (!whole(f.get('maxWidth'), 16, 4096) || !whole(f.get('maxHeight'), 16, 4096)) return null;
    if (![1, 1.5, 2, 3].includes(f.get('scale'))) return null;
    return {
      type,
      id,
      maxWidth: f.get('maxWidth'),
      maxHeight: f.get('maxHeight'),
      scale: f.get('scale'),
    };
  }
  return null;
}

/**
 * The contract an `init` offers when it names one this embed does not speak: such an `init`
 * (with a port) is answered `contract.unsupported` and counts; null otherwise.
 */
export function otherContract(value) {
  if (typeOf(value) !== 'init') return null;
  const contract = Object.getOwnPropertyDescriptor(value, 'contract')?.value;
  return text(contract, 1, 64) && contract !== CONTRACT ? contract : null;
}
