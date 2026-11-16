// Phase 8's paste budgets (IMPLEMENTATION_PLAN.md, Phase 8, Performance benchmarks: "a paste of
// 1,000 cells shown ≤ 500 ms, on the server ≤ 5 s"), as a piece for bench/phase8.mjs to run and
// gate with its other figures. Written by the cells stream and not run there (the parent's proof
// runs the benches, which own the server stack and the ports).
//
//   import { CELL_BUDGETS, measurePaste, seedPasteDatabase } from './phase8-cells.mjs';
//   const seeded = await seedPasteDatabase(api);      // through the API, as phase4.mjs seeds
//   // a Chrome page signed in as that account (scripts/cloud-account.mjs `signInPage`), then
//   const figures = await measurePaste(page, api, seeded, { runs: 6, log });
//
// The database: a title and nine properties (text, number, date, checkbox, select, multi-select,
// URL, email, phone) and 100 rows. Each run pastes 100 lines of 10 cells (1,000 cells, Excel's
// shape: CRLF rows, thousands in numbers, ISO dates, TRUE and FALSE, option names, one cell in ten
// over two lines in quotes) into the table from its first cell, every cell a new value, as the
// browser sends a paste: a `ClipboardEvent` with its own `DataTransfer` on the table's grid.
//   - shown: from that event to every row in the table's window showing the run's titles and the
//     paste's notice on screen (the page's clock);
//   - server: from the same moment to the server's rows (`GET /databases/{id}/rows`) holding every
//     pasted title and note (the epoch clock: the page's `timeOrigin` plus the event's time).
// The first run is a warm-up (tracked); the figures are the median and the worst of the others.
import { randomBytes } from 'node:crypto';

/** Budgets, with the margin a regression must also exceed to fail, as bench/phase4.mjs has them. */
export const CELL_BUDGETS = {
  paste1000ShownMs: { max: 500, unit: 'ms', slack: 100 },
  paste1000ServerMs: { max: 5000, unit: 'ms', slack: 1000 },
  // Tracked, not budgeted.
  paste1000ShownFirstMs: { max: Infinity, unit: 'ms', slack: 500 },
  paste1000ServerFirstMs: { max: Infinity, unit: 'ms', slack: 2000 },
};

const ROWS = 100;
const P = {
  notes: 'PNotes01',
  amount: 'PAmount1',
  due: 'PDue0001',
  done: 'PDone001',
  stage: 'PStage01',
  tags: 'PTags001',
  site: 'PSite001',
  mail: 'PMail001',
  phone: 'PPhone01',
};
const STAGES = ['Backlog', 'Doing', 'Done'];
const TAGS = ['Finance', 'Legal', 'Ops'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n, width = 2) => String(n).padStart(width, '0');

function uuidv7() {
  const bytes = randomBytes(16);
  let time = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A workspace with the paste's database (100 rows), through the API as a client makes one. */
export async function seedPasteDatabase(api) {
  const workspaceId = uuidv7();
  await api.post('/api/v1/workspaces', { id: workspaceId, name: 'Phase 8 paste bench' });
  const now = new Date().toISOString();
  const op = (type, entityId, payload) => ({
    opId: uuidv7(),
    type,
    workspaceId,
    entityId,
    baseVersion: null,
    payload,
    createdAt: now,
  });
  const check = (answer) => {
    const refused = answer.results.filter((r) => r.status !== 'applied');
    if (refused.length) throw new Error('Operations refused: ' + JSON.stringify(refused[0]));
  };
  const section = uuidv7();
  const databaseId = uuidv7();
  const other = uuidv7();
  const page = (id, kind, title, orderKey, extra = {}) => ({
    id,
    workspaceId,
    sectionId: section,
    parentPageId: null,
    orderKey,
    kind,
    title,
    icon: null,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    trashRootId: null,
    ...extra,
  });
  const options = (names, prefix) =>
    names.map((name, i) => ({ id: `${prefix}${pad(i, 8 - prefix.length)}`, name, colour: 'blue' }));
  check(
    await api.post(`/api/v1/workspaces/${workspaceId}/ops`, {
      ops: [
        op('section.create', section, {
          id: section,
          workspaceId,
          name: 'Shared',
          orderKey: 'a0',
          visibility: 'workspace',
          version: 1,
          createdAt: now,
        }),
        op('page.create', other, page(other, 'page', 'Another page', 'a0')),
        op(
          'page.create',
          databaseId,
          page(databaseId, 'database', 'Paste bench', 'a1', {
            database: {
              properties: [
                { id: 'title', name: 'Name', type: 'title' },
                { id: P.notes, name: 'Notes', type: 'text' },
                {
                  id: P.amount,
                  name: 'Amount',
                  type: 'number',
                  number: { format: 'number', decimals: 2 },
                },
                { id: P.due, name: 'Due', type: 'date', date: { includeTime: false } },
                { id: P.done, name: 'Done', type: 'checkbox' },
                { id: P.stage, name: 'Stage', type: 'select', options: options(STAGES, 'Stg') },
                { id: P.tags, name: 'Tags', type: 'multiSelect', options: options(TAGS, 'Tag') },
                { id: P.site, name: 'Site', type: 'url' },
                { id: P.mail, name: 'Mail', type: 'email' },
                { id: P.phone, name: 'Phone', type: 'phone' },
              ],
            },
          }),
        ),
      ],
    }),
  );
  const tableId = uuidv7();
  check(
    await api.post(`/api/v1/workspaces/${workspaceId}/ops`, {
      ops: [
        op('view.upsert', tableId, {
          id: tableId,
          workspaceId,
          databaseId,
          name: 'Table',
          type: 'table',
          orderKey: 'a0',
          config: {
            filter: null,
            sorts: [],
            group: null,
            properties: { order: [], hidden: [], widths: {} },
          },
          version: 1,
          createdAt: now,
        }),
      ],
    }),
  );
  // The rows, through the import route (order keys made by the server).
  const csv = ['Name', ...Array.from({ length: ROWS }, (_, i) => `Row ${pad(i, 3)}`)];
  const answer = await api.post(`/api/v1/databases/${databaseId}/import`, {
    csv: csv.map((line) => `${line}\r\n`).join(''),
    columns: ['title'],
    header: true,
  });
  if (answer.created !== ROWS)
    throw new Error(`The import made ${answer.created} rows: ${JSON.stringify(answer.problems)}`);
  return { workspaceId, databaseId, other, tableId };
}

/** 100 lines of 10 cells as Excel writes them, every value the run's own. */
export function pasteText(run) {
  const lines = [];
  for (let i = 0; i < ROWS; i++) {
    const notes = i % 10 === 0 ? `"Run ${run} line ${i}\nsecond line"` : `Run ${run} note ${i}`;
    lines.push(
      [
        `R${run} ${pad(i, 3)}`,
        notes,
        `${(1000 * run + i).toLocaleString('en-US')}.25`,
        `2026-${pad(1 + (run % 12))}-${pad(1 + (i % 28))}`,
        (i + run) % 2 ? 'TRUE' : 'FALSE',
        STAGES[(i + run) % 3],
        TAGS[(i + run) % 3],
        `https://example.com/${run}/${i}`,
        `r${run}.${i}@example.com`,
        `+20 100 ${pad(run, 3)} ${pad(i, 4)}`,
      ].join('\t'),
    );
  }
  return lines.map((line) => `${line}\r\n`).join('');
}

/** In the page: the paste dispatched on the grid, until the window shows it; both clocks. */
function pasteInPage([text, prefix]) {
  return new Promise((resolve, reject) => {
    const grid = document.querySelector('.cgw-database-page [role="grid"]');
    if (!grid) return reject(new Error('No table on the page'));
    grid.focus();
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const start = performance.now();
    grid.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
    const check = () => {
      const titles = [...grid.querySelectorAll('.cgw-tbody [role="row"] .cgw-title-text')];
      const notice = document.querySelector('.cgw-database-page .cgw-db-cell-notice');
      if (notice && titles.length && titles.every((t) => t.textContent?.startsWith(prefix)))
        return resolve({ shown: performance.now() - start, epoch: performance.timeOrigin + start });
      if (performance.now() - start > 30000) return reject(new Error('The paste did not show'));
      requestAnimationFrame(check);
    };
    check();
  });
}

/** Whether the server's rows hold run `run`'s titles and notes. */
async function serverHolds(api, databaseId, run) {
  const { rows } = await api.get(`/api/v1/databases/${databaseId}/rows?limit=500`);
  const live = rows.filter((r) => !r.trashedAt);
  let held = 0;
  for (const row of live) {
    const i = Number(row.title.match(new RegExp(`^R${run} (\\d{3})$`))?.[1] ?? NaN);
    if (Number.isNaN(i)) continue;
    const notes = i % 10 === 0 ? `Run ${run} line ${i}\nsecond line` : `Run ${run} note ${i}`;
    if (row.values[P.notes] === notes) held++;
  }
  return held === ROWS;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};
const round = (n) => Math.round(n * 10) / 10;

/**
 * The paste's budgets on a signed-in page: `runs` pastes of 1,000 cells into the seeded
 * database's table (the first a warm-up), each timed to shown and to the server.
 */
export async function measurePaste(page, api, seeded, { runs = 6, log = console.log } = {}) {
  await page.evaluate((id) => (location.hash = `#/p/${id}`), seeded.databaseId);
  const grid = page.locator('.cgw-database-page [role="grid"]');
  await grid.locator('[role="row"][aria-rowindex="2"] .cgw-title-text').waitFor({ timeout: 60000 });
  await page.waitForFunction(
    () => document.querySelector('.cgw-database-page .cgw-table-foot')?.textContent === 'Rows: 100',
    null,
    { timeout: 60000 },
  );
  const shown = [];
  const server = [];
  for (let run = 1; run <= runs; run++) {
    // The first cell, by the keys; a notice from the run before is closed first.
    const close = page.locator('.cgw-database-page .cgw-db-cell-notice button', {
      hasText: 'Close',
    });
    if (await close.count()) await close.click();
    await grid.focus();
    await grid.press('Control+Home');
    await grid.press('ArrowDown');
    const timed = await page.evaluate(pasteInPage, [pasteText(run), `R${run} `]);
    let at = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (await serverHolds(api, seeded.databaseId, run)) {
        at = Date.now();
        break;
      }
      await sleep(100);
    }
    if (at === null) throw new Error(`Run ${run}: the server did not hold the paste in 60 s`);
    shown.push(timed.shown);
    server.push(at - timed.epoch);
    log(
      `  paste ${run}: shown ${round(timed.shown)} ms, on the server ${Math.round(at - timed.epoch)} ms`,
    );
    await sleep(500);
  }
  const [firstShown, ...restShown] = shown;
  const [firstServer, ...restServer] = server;
  return {
    pastes: runs,
    paste1000ShownFirstMs: round(firstShown),
    paste1000ServerFirstMs: Math.round(firstServer),
    paste1000ShownP50: round(median(restShown)),
    paste1000ShownMs: round(Math.max(...restShown)),
    paste1000ServerP50: Math.round(median(restServer)),
    paste1000ServerMs: Math.round(Math.max(...restServer)),
  };
}
