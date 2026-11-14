// The mock Sheet's `/embed` page (sheet-embed.1, docs/INTEGRATIONS.md): posts `ready`, takes one
// `init` from Workspace's origins with a port, reads the workbook from the source, draws the
// view as a table and answers on the port: `loaded`, `resize`, `preview` from a canvas, `error`.
// Faults set with `POST /__mock/fault` replace the next answers. What it does is reported to
// `/__mock/event` (never a URL or the bytes). Readings of the open points follow Sheet's
// (sheet-embed-readings.md): sheet names match without case, a null range over the limit keeps
// the top-left corner, a preview is the view's top-left (top-right on a right-to-left sheet) cut
// to fit, in light colours.
import {
  CONTRACT,
  LIMITS,
  WORKSPACE_ORIGINS,
  otherContract,
  parseParentMessage,
  rangeBounds,
} from '/protocol.mjs';
import { columnLetters, readXlsx } from '/xlsx.mjs';

const root = document.getElementById('root');
const openButton = document.getElementById('open');
const status = document.getElementById('status');

let initTaken = false;
let port = null;
let book = null;
let view = null;
let drawn = null;
let lastError = null;
let lastSize = null;
let queue = Promise.resolve();

function report(kind, detail = {}) {
  fetch('/__mock/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 'embed', kind, ...detail }),
    keepalive: true,
  }).catch(() => {});
}

async function nextFault(type) {
  try {
    const response = await fetch(`/__mock/next-fault?on=${type}`, {
      method: 'POST',
      cache: 'no-store',
    });
    return response.ok ? (await response.json()).code : null;
  } catch {
    return null;
  }
}

function setStatus(state, text) {
  status.dataset.state = state;
  status.textContent = text;
}

function send(message, transfer = []) {
  port.postMessage(message, transfer);
  const shown = { ...message };
  delete shown.bytes;
  report(`sent:${message.type}`, { message: shown });
}

function fail(code, message, id) {
  if (id === undefined) {
    lastError = code;
    book = code === 'view.notFound' || code === 'range.tooLarge' ? book : null;
    drawn = null;
    root.replaceChildren();
    setStatus('error', code);
  }
  send(id === undefined ? { type: 'error', code, message } : { type: 'error', code, message, id });
}

async function read(source) {
  let bytes;
  if (source.kind === 'url') {
    let response;
    try {
      response = await fetch(source.url, {
        mode: 'cors',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
    } catch {
      return { error: 'source.unavailable', message: 'The workbook could not be fetched' };
    }
    if (response.status === 403) return { error: 'source.forbidden', message: 'HTTP 403' };
    if (!response.ok) return { error: 'source.unavailable', message: `HTTP ${response.status}` };
    if (Number(response.headers.get('content-length')) > LIMITS.workbookBytes) {
      return { error: 'workbook.tooLarge', message: 'Over 20 MB' };
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    bytes = new Uint8Array(source.bytes);
  }
  if (bytes.byteLength > LIMITS.workbookBytes) {
    return { error: 'workbook.tooLarge', message: 'Over 20 MB' };
  }
  try {
    const { sheets } = await readXlsx(bytes);
    return { book: { etag: source.etag, sheets } };
  } catch {
    return { error: 'source.unavailable', message: 'Not a workbook the mock reads' };
  }
}

const visibleSheets = () =>
  book.sheets.filter((sheet) => sheet.kind === 'worksheet' && sheet.state === 'visible');

function usedBounds(sheet) {
  let bounds = null;
  for (const ref of sheet.cells.keys()) {
    const b = rangeBounds(ref);
    if (!bounds) bounds = { ...b };
    else {
      bounds.top = Math.min(bounds.top, b.top);
      bounds.left = Math.min(bounds.left, b.left);
      bounds.bottom = Math.max(bounds.bottom, b.bottom);
      bounds.right = Math.max(bounds.right, b.right);
    }
  }
  return bounds;
}

/** The used range cut to the cell limit from its top-left corner (Sheet's reading 5). */
function capped(bounds) {
  const rows = bounds.bottom - bounds.top + 1;
  const cols = bounds.right - bounds.left + 1;
  if (rows * cols <= LIMITS.rangeCells) return { bounds, capped: false };
  const keptCols =
    cols <= 50 ? cols : Math.min(cols, Math.max(50, Math.floor(LIMITS.rangeCells / rows)));
  const keptRows = Math.min(rows, Math.floor(LIMITS.rangeCells / keptCols));
  return {
    bounds: { ...bounds, right: bounds.left + keptCols - 1, bottom: bounds.top + keptRows - 1 },
    capped: true,
  };
}

const written = (b) => {
  const start = `${columnLetters(b.left)}${b.top}`;
  return b.top === b.bottom && b.left === b.right
    ? start
    : `${start}:${columnLetters(b.right)}${b.bottom}`;
};

function measure() {
  const table = root.querySelector('table');
  const rect = table.getBoundingClientRect();
  const side = (n) => Math.max(1, Math.min(100000, Math.ceil(n)));
  return { width: side(rect.width), height: side(rect.height) };
}

function drawTable(sheet, bounds) {
  const table = document.createElement('table');
  table.dir = sheet.rtl ? 'rtl' : 'ltr';
  const head = table.createTHead().insertRow();
  head.append(document.createElement('th'));
  for (let col = bounds.left; col <= bounds.right; col++) {
    const th = document.createElement('th');
    th.textContent = columnLetters(col);
    head.append(th);
  }
  const body = table.createTBody();
  for (let row = bounds.top; row <= bounds.bottom; row++) {
    const tr = body.insertRow();
    const th = document.createElement('th');
    th.textContent = String(row);
    tr.append(th);
    for (let col = bounds.left; col <= bounds.right; col++) {
      const td = tr.insertCell();
      const value = sheet.cells.get(`${columnLetters(col)}${row}`);
      if (value !== undefined) {
        td.textContent = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
        if (typeof value === 'number') td.className = 'number';
      }
    }
  }
  root.replaceChildren(table);
  resizeObserver.observe(table);
}

/** Draws `view` from the workbook held, and answers `loaded` or `error`. */
function show(next) {
  view = next;
  if (next.kind === 'chart') return fail('view.notFound', 'The mock draws no charts');
  const sheets = visibleSheets();
  const wanted = next.sheet?.toUpperCase();
  const sheet =
    next.sheet === null ? sheets[0] : sheets.find((s) => s.name.toUpperCase() === wanted);
  if (!sheet) return fail('view.notFound', 'No such sheet');
  let bounds;
  let cut = false;
  if (next.range === null) {
    const used = usedBounds(sheet);
    if (!used) bounds = { top: 1, left: 1, bottom: 1, right: 1 };
    else ({ bounds, capped: cut } = capped(used));
  } else {
    bounds = rangeBounds(next.range);
    const cells = (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1);
    if (cells > LIMITS.rangeCells) return fail('range.tooLarge', `${cells} cells`);
  }
  drawTable(sheet, bounds);
  const resolved = { kind: 'range', sheet: sheet.name, range: written(bounds) };
  lastSize = measure();
  drawn = { view: resolved, sheet, bounds, capped: cut };
  lastError = null;
  setStatus('loaded', `${sheet.name}!${resolved.range}`);
  sendLoaded();
}

function sendLoaded() {
  send({
    type: 'loaded',
    etag: book.etag,
    view: drawn.view,
    sheets: visibleSheets().map((s) => ({ name: s.name, direction: s.rtl ? 'rtl' : 'ltr' })),
    charts: [],
    size: lastSize,
    capped: drawn.capped,
  });
}

const resizeObserver = new ResizeObserver(() => {
  if (!drawn || !port || !root.querySelector('table')) return;
  const size = measure();
  if (lastSize && size.width === lastSize.width && size.height === lastSize.height) return;
  lastSize = size;
  send({ type: 'resize', size });
});

function applyLook({ theme, direction, locale }) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dir = direction;
  document.documentElement.lang = locale;
  openButton.textContent = locale === 'ar' ? 'فتح في Cash Gear Sheet' : 'Open in Cash Gear Sheet';
}

async function load(source, next) {
  setStatus('loading', 'Loading');
  const result = await read(source);
  if (result.error) {
    book = null;
    return fail(result.error, result.message);
  }
  book = result.book;
  show(next);
}

/** Paints the drawn table onto a canvas in light colours, `density` device pixels a CSS pixel. */
function paint(width, height, density) {
  const table = root.querySelector('table');
  const origin = table.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * density));
  canvas.height = Math.max(1, Math.round(height * density));
  const g = canvas.getContext('2d');
  g.scale(density, density);
  // Right to left: the cut keeps the top-right corner.
  const shift = table.dir === 'rtl' ? origin.width - width : 0;
  g.translate(-shift, 0);
  g.fillStyle = '#ffffff';
  g.fillRect(shift, 0, width, height);
  g.textBaseline = 'middle';
  for (const cell of table.querySelectorAll('th, td')) {
    const r = cell.getBoundingClientRect();
    const x = r.left - origin.left;
    const y = r.top - origin.top;
    g.fillStyle = cell.tagName === 'TH' ? '#f1f3f5' : '#ffffff';
    g.fillRect(x, y, r.width, r.height);
    g.strokeStyle = '#d0d5dd';
    g.strokeRect(x + 0.5, y + 0.5, r.width, r.height);
    g.fillStyle = '#1f2328';
    g.font = getComputedStyle(cell).font;
    const right = cell.classList.contains('number') !== (table.dir === 'rtl');
    g.textAlign = right ? 'right' : 'left';
    g.fillText(cell.textContent, right ? x + r.width - 6 : x + 6, y + r.height / 2, r.width - 12);
  }
  return canvas;
}

async function preview({ id, maxWidth, maxHeight, scale }) {
  if (lastError) return fail(lastError, 'The last answer was an error', id);
  if (!drawn) return fail('source.unavailable', 'Nothing is drawn', id);
  const width = Math.min(maxWidth, lastSize.width);
  const height = Math.min(maxHeight, lastSize.height);
  const densities = [scale, 2, 1.5, 1, 0.75, 0.5, 0.25].filter(
    (d, i, all) => d <= scale && all.indexOf(d) === i,
  );
  for (const density of densities) {
    if (width * density > LIMITS.previewSide || height * density > LIMITS.previewSide) continue;
    const canvas = paint(width, height, density);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) break;
    const bytes = await blob.arrayBuffer();
    if (bytes.byteLength > LIMITS.previewBytes) continue;
    send({ type: 'preview', id, bytes, width, height, etag: book.etag, view: drawn.view }, [bytes]);
    report('preview', { id, width, height, density, size: bytes.byteLength });
    return;
  }
  fail('source.unavailable', 'The picture did not fit', id);
}

async function handle(message) {
  if (message.type === 'init' || message.type === 'setView') view = message.view;
  if (message.type !== 'setTheme') {
    const fault = await nextFault(message.type);
    if (fault) {
      report('fault', { on: message.type, code: fault });
      if (message.type === 'init') applyLook(message);
      if (fault === 'contract.unsupported' && message.type === 'init') port.onmessage = null;
      return fail(fault, 'A fault set by the test', message.id);
    }
  }
  switch (message.type) {
    case 'init':
      applyLook(message);
      return load(message.source, message.view);
    case 'setView':
      if (!book) return fail(lastError ?? 'source.unavailable', 'No workbook is loaded');
      return show(message.view);
    case 'setTheme':
      applyLook(message);
      return;
    case 'refresh':
      // The ETag already drawn reads nothing (Sheet's reading 10).
      if (book && message.source.etag === book.etag) return drawn ? sendLoaded() : show(view);
      return load(message.source, view);
    case 'requestPreview':
      return preview(message);
  }
}

function enqueue(message) {
  queue = queue.then(() => handle(message)).catch(() => {});
}

window.addEventListener('message', (event) => {
  if (initTaken || event.source !== window.parent) return;
  if (!WORKSPACE_ORIGINS.includes(event.origin) || event.ports.length !== 1) return;
  const other = otherContract(event.data);
  if (other !== null) {
    initTaken = true;
    port = event.ports[0];
    report('init', { contract: other, origin: event.origin });
    send({ type: 'error', code: 'contract.unsupported', message: `This embed speaks ${CONTRACT}` });
    setStatus('error', 'contract.unsupported');
    return;
  }
  const init = parseParentMessage(event.data);
  if (!init || init.type !== 'init') {
    report('dropped', { on: 'window' });
    return;
  }
  initTaken = true;
  port = event.ports[0];
  port.onmessage = (e) => {
    const message = parseParentMessage(e.data);
    if (!message || message.type === 'init') {
      report('dropped', { on: 'port' });
      return;
    }
    report(
      `received:${message.type}`,
      message.type === 'refresh' ? { etag: message.source.etag } : {},
    );
    enqueue(message);
  };
  report('init', {
    contract: init.contract,
    origin: event.origin,
    source: { kind: init.source.kind, etag: init.source.etag },
    view: init.view,
    theme: init.theme,
    direction: init.direction,
    locale: init.locale,
  });
  enqueue(init);
});

openButton.addEventListener('click', () => {
  if (port) send({ type: 'openRequested' });
});

setStatus('waiting', 'Waiting for init');
window.parent.postMessage({ type: 'ready', contracts: [CONTRACT] }, '*');
report('ready');
