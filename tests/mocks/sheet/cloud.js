// The mock Sheet's `/cloud` launch route (Track S2's, as a mock; Sheet's
// docs/workspace-contract.md, `sheet-session.1`): reads `#launch=<ticket>`, takes it out of the
// address bar and history, redeems it at Workspace's API, reads the workbook by its signed URL
// and shows it. "Save" writes a new version the mock makes: the workbook with one value changed
// (the first number plus one, else A1), or a fresh workbook when it has no version yet, with
// `If-Match` or `If-None-Match: *`. The session token lives in this module only.
import { XLSX_TYPE, readXlsx, writeXlsx } from '/xlsx.mjs';

const API = document.querySelector('meta[name="cgw-api"]').content.replace(/\/$/, '');
const $ = (id) => document.getElementById(id);
const ticket = /^#launch=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1] ?? null;
history.replaceState(null, '', '/');

let token = null;
let session = null;
let etag = null;
let book = null;
let saves = 0;

function report(kind, detail = {}) {
  fetch('/__mock/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 'cloud', kind, ...detail }),
    keepalive: true,
  }).catch(() => {});
}

function setStatus(state, text) {
  $('status').dataset.state = state;
  $('status').textContent = text;
}

function showError(step, code) {
  $('error').textContent = `${step}: ${code}`;
  $('error').dataset.code = code;
  setStatus('error', `Failed to ${step}`);
  report('error', { step, code });
}

function call(path, { headers = {}, ...init } = {}) {
  return fetch(API + path, {
    ...init,
    mode: 'cors',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    headers: token ? { ...headers, 'X-Workspace-File-Session': token } : headers,
  });
}

async function codeOf(response) {
  try {
    const body = await response.json();
    return typeof body.code === 'string' ? body.code : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

function render() {
  const sheet = book?.sheets.find((s) => s.kind === 'worksheet' && s.state === 'visible');
  if (!sheet) {
    $('sheet').textContent = book ? 'No visible worksheet' : 'Empty workbook (no version yet)';
    return;
  }
  const table = document.createElement('table');
  table.dir = sheet.rtl ? 'rtl' : 'ltr';
  table.dataset.sheet = sheet.name;
  const rows = new Map();
  for (const [ref, value] of sheet.cells) {
    const [, letters, row] = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push([letters.length, letters, ref, value]);
  }
  for (const row of [...rows.keys()].sort((a, b) => a - b).slice(0, 50)) {
    const tr = table.insertRow();
    const sorted = rows.get(row).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    for (const [, , ref, value] of sorted.slice(0, 20)) {
      const td = tr.insertCell();
      td.dataset.ref = ref;
      td.textContent = String(value);
    }
  }
  $('sheet').replaceChildren(table);
}

async function load() {
  setStatus('loading', 'Reading the workbook');
  const response = await call('/api/v1/sheet-sessions/workbook');
  if (!response.ok) return showError('read', await codeOf(response));
  const info = await response.json();
  etag = info.etag;
  $('name').textContent = info.name;
  $('etag').textContent = etag ?? '(none)';
  if (info.readUrl) {
    let blob;
    try {
      blob = await fetch(info.readUrl, {
        mode: 'cors',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
    } catch {
      return showError('read', 'network');
    }
    if (!blob.ok) return showError('read', `HTTP ${blob.status}`);
    try {
      book = await readXlsx(new Uint8Array(await blob.arrayBuffer()));
    } catch {
      return showError('read', 'not a workbook');
    }
  } else {
    book = null;
  }
  render();
  $('save').disabled = session.access !== 'edit';
  $('reload').disabled = false;
  setStatus('ready', book ? 'Workbook open' : 'Empty workbook');
  report('loaded', { etag, empty: !book });
}

/** The workbook with one value changed, or a fresh one (right to left for Arabic). */
function nextVersion() {
  saves++;
  if (!book) {
    return writeXlsx({
      sheets: [
        {
          name: session.language === 'ar' ? 'ورقة1' : 'Sheet1',
          rtl: session.language === 'ar',
          rows: [
            ['Item', 'Quantity'],
            ['Saved by the mock', saves],
          ],
        },
      ],
    });
  }
  const sheets = book.sheets
    .filter((s) => s.kind === 'worksheet')
    .map((s) => ({
      name: s.name,
      rtl: s.rtl,
      state: s.state === 'visible' ? undefined : s.state,
      cells: new Map(s.cells),
    }));
  const first = sheets.find((s) => !s.state) ?? sheets[0];
  const number = [...first.cells].find(([, value]) => typeof value === 'number');
  if (number) first.cells.set(number[0], number[1] + 1);
  else first.cells.set('A1', `Saved by the mock ${saves}`);
  return writeXlsx({ sheets });
}

async function save() {
  $('save').disabled = true;
  $('error').textContent = '';
  const bytes = nextVersion();
  const response = await call('/api/v1/sheet-sessions/workbook/versions', {
    method: 'POST',
    headers: {
      'Content-Type': XLSX_TYPE,
      ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }),
    },
    body: bytes,
  });
  $('save').disabled = false;
  if (response.status === 201) {
    const saved = await response.json();
    etag = saved.etag;
    book = await readXlsx(bytes);
    $('etag').textContent = etag;
    render();
    setStatus('saved', 'Saved');
    report('saved', { etag, versionId: saved.versionId, bytes: bytes.length });
    return;
  }
  if (response.status === 412) {
    const body = await response.json().catch(() => ({}));
    $('error').dataset.current = body.current?.etag ?? '';
    return showError('save', `version.conflict (current ${body.current?.etag ?? '?'})`);
  }
  showError('save', await codeOf(response));
}

async function start() {
  if (!ticket) return showError('launch', 'no ticket');
  setStatus('redeeming', 'Opening');
  let response;
  try {
    response = await call('/api/v1/sheet-sessions/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
  } catch {
    return showError('redeem', 'network');
  }
  if (!response.ok) return showError('redeem', await codeOf(response));
  const redeemed = await response.json();
  token = redeemed.token;
  session = { ...redeemed, token: undefined };
  document.documentElement.lang = session.language;
  document.documentElement.dir = session.language === 'ar' ? 'rtl' : 'ltr';
  $('access').textContent = session.access;
  $('user').textContent = session.user?.name ?? '';
  report('redeemed', {
    workbook: session.workbook,
    access: session.access,
    language: session.language,
  });
  await load();
}

$('save').addEventListener('click', () => save().catch(() => showError('save', 'network')));
$('reload').addEventListener('click', () => load().catch(() => showError('read', 'network')));
window.addEventListener('pagehide', () => {
  if (token)
    call('/api/v1/sheet-sessions/end', { method: 'POST', keepalive: true }).catch(() => {});
});
start().catch(() => showError('open', 'network'));
