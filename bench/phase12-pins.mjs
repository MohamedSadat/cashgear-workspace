// Phase 12's pins budget (IMPLEMENTATION_PLAN.md, Phase 12, Performance benchmarks: "pinning a
// 5,000-row database with its documents ≤ 120 s, the keystroke budget held meanwhile"), as a piece
// for bench/phase12.mjs to run and gate with its other figures; it also runs alone. Written by the
// pins stream and not run there (the parent's proof runs the benches, which own the server stack
// and the ports).
//
//   import { PINS_BUDGETS, measurePins, seedPinnedDatabase } from './phase12-pins.mjs';
//   const seeded = await seedPinnedDatabase(api);   // an apiSession (scripts/cloud-account.mjs)
//   // a Chrome page signed in as that account (`signInPage`), Synced, then
//   const { figures } = await measurePins(page, seeded, { log });
//
//   node bench/phase12-pins.mjs                      alone: an account, the seed, Chrome, the gate
//
// Alone it needs the web app under `vite preview` on 127.0.0.1:4273 (`pnpm build`) and the server
// stack (scripts/server-stack.mjs --e2e) on 127.0.0.1:5280, and waits for both; writes
// bench/results/phase12-pins.json, gated against the budgets and bench/previous/phase12-pins.json
// (the last run on main on the same processor): worse by half again and by more than a small
// margin fails.
//
// The workspace, through the API as a client makes it (bench/phase3.mjs's way): a typing page of
// 200 blocks and a database of 5,000 rows, the rows by the server's import route (`POST
// /databases/{id}/import`, as the import dialog sends a large file), then every row's first
// document and the typing page's written by the product's own document code (@cgw/doc's
// `newDocumentUpdate`, through bench/editor/src/phase3-corpus.test.ts) and pushed as a device of
// the account pushes them, from a Yjs client id registered to the person, eight at a time; then
// waited for until the worker has validated every one (each row's `docHeadSeq` past 0). Then, in
// the signed-in page (a fresh profile that holds none of it):
//   - the 200-block page open, the database pinned from its page's menu ("Make available
//     offline"), the 200-block page opened again and typed into at a key every 35 ms until every
//     row's document is on the device (a document cursor in its store): the time from the pin to
//     that (budget 120 s), and meanwhile Phase 1's keystroke figures as bench/phase3.mjs and
//     bench/phase10-plugins.mjs measure them: keydown to the next frame painted, p95 (budget 33 ms),
//     and keydown to the end of the editor's transaction, p95 (8 ms, 16 on CI's runner);
//   - tracked: the batch pulls and single pulls the page made, any 429 it met, and the seed's times.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const results = join(root, 'bench/results');
const previousFile = join(root, 'bench/previous/phase12-pins.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The keystroke budget on CI's hosted runner is a frame (bench/phase5.mjs's note, Phase 6), as
// bench/phase10-plugins.mjs gates it.
const KEY_WORK_MAX = process.env.CI ? 16 : 8;
/** Budgets, with the margin a regression must also exceed to fail (runners are noisy). */
export const PINS_BUDGETS = {
  pin5000RowsHeldMs: { max: 120000, unit: 'ms', slack: 10000 },
  pin5000RowsKeyWorkP95: { max: KEY_WORK_MAX, unit: 'ms', slack: 2 },
  pin5000RowsKeyFrameP95: { max: 33, unit: 'ms', slack: 5 },
  // Tracked, not budgeted.
  pin5000RowsImportMs: { max: Infinity, unit: 'ms', slack: 10000 },
  pin5000RowsSeedDocsMs: { max: Infinity, unit: 'ms', slack: 30000 },
};

const ROWS = Number(process.env.PHASE12_PINS_ROWS ?? 5000);
/** How long the typing goes on for at most, waiting for the documents. */
const LIMIT_MS = Number(process.env.PHASE12_PINS_LIMIT_MS ?? 180000);
const NOTES = 'Notes001';

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};
const round = (n) => Math.round(n * 10) / 10;

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

/** Runs `fn` over `items`, `n` at a time. */
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

// ------------------------------------------------------------------ the seed
/**
 * A workspace with a 200-block typing page and a database of `rows` rows (default 5,000), every
 * row with a first document, through the API as a client makes them, all validated. Gives their
 * ids and the seed's times.
 */
export async function seedPinnedDatabase(
  api,
  { rows = ROWS, name = 'Phase 12 pins', log = console.log } = {},
) {
  const workspaceId = uuidv7();
  await api.post('/api/v1/workspaces', { id: workspaceId, name });
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
  const typing = uuidv7();
  const databaseId = uuidv7();
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
  const tableId = uuidv7();
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
        op('page.create', typing, page(typing, 'page', 'Typing page', 'a0')),
        op(
          'page.create',
          databaseId,
          page(databaseId, 'database', 'Five thousand rows', 'a1', {
            database: {
              properties: [
                { id: 'title', name: 'Name', type: 'title' },
                { id: NOTES, name: 'Notes', type: 'text' },
              ],
            },
          }),
        ),
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

  log(`  ${rows.toLocaleString('en')} rows through the import route`);
  const lines = ['Name,Notes'];
  for (let i = 1; i <= rows; i++) lines.push(`Row ${String(i).padStart(5, '0')},Note number ${i}`);
  const imported = Date.now();
  const answer = await api.post(`/api/v1/databases/${databaseId}/import`, {
    csv: lines.join('\r\n') + '\r\n',
    columns: ['title', NOTES],
    header: true,
  });
  const importMs = Date.now() - imported;
  if (answer.created !== rows)
    throw new Error(`The import made ${answer.created} rows: ${JSON.stringify(answer.problems)}`);
  const rowIds = [];
  for (let after = null; ;) {
    const query = after ? `limit=1000&after=${after}` : 'limit=1000';
    const got = await api.get(`/api/v1/databases/${databaseId}/rows?${query}`);
    rowIds.push(...got.rows.filter((r) => !r.isTemplate && !r.trashedAt).map((r) => r.id));
    if (!got.next) break;
    after = got.next;
  }
  if (rowIds.length !== rows) throw new Error(`${rowIds.length} rows read back, not ${rows}`);

  log(`  every row's first document, and the typing page's`);
  const docsStarted = Date.now();
  const clientId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
  const registered = await api.post(`/api/v1/workspaces/${workspaceId}/yjs-clients`, {
    issue: null,
    register: [clientId],
  });
  if (!registered.registered.map(Number).includes(clientId))
    throw new Error('The client id was not registered: ' + JSON.stringify(registered));
  const corpus = join(results, 'phase12-pins-corpus');
  mkdirSync(corpus, { recursive: true });
  const all = [
    { id: typing, blocks: 200 },
    ...rowIds.map((id) => ({ id, blocks: 2 + (id.charCodeAt(35) % 4) })),
  ];
  writeFileSync(join(corpus, 'pages.json'), JSON.stringify({ clientId, pages: all }));
  const written = spawnSync(
    process.execPath,
    [join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'bench/editor/src/phase3-corpus.test.ts'],
    { cwd: root, stdio: 'inherit', env: { ...process.env, PHASE3_CORPUS: corpus } },
  );
  if (written.status !== 0) throw new Error('The documents were not written');
  const docs = JSON.parse(readFileSync(join(corpus, 'docs.json'), 'utf8'));
  // The documents carry @cgw/doc's schema version: pushed as an older client's, the worker
  // refuses them as newer than their pusher (bench/phase3.mjs's note).
  const docVersion = Math.max(
    ...Object.keys(
      JSON.parse(readFileSync(join(root, 'packages/doc/vectors/schema-elements.json'), 'utf8')),
    ).map(Number),
  );
  await pool(all, 8, async ({ id }) => {
    await api.post(`/api/v1/pages/${id}/doc/updates`, {
      epoch: 0,
      clientSchemaVersion: docVersion,
      updates: [{ updateId: uuidv7(), data: docs[id] }],
    });
  });
  // Every document validated (its head moved) before anything is timed.
  const deadline = Date.now() + 600000;
  for (;;) {
    let waiting = 0;
    for (let after = null; ;) {
      const query = after ? `limit=1000&after=${after}` : 'limit=1000';
      const got = await api.get(`/api/v1/databases/${databaseId}/rows?${query}`);
      waiting += got.rows.filter((r) => !r.isTemplate && Number(r.docHeadSeq) < 1).length;
      if (!got.next) break;
      after = got.next;
    }
    const tree = await api.get(`/api/v1/workspaces/${workspaceId}/tree`);
    if (Number(tree.pages.find((p) => p.id === typing)?.docHeadSeq ?? 0) < 1) waiting++;
    if (!waiting) break;
    if (Date.now() > deadline) throw new Error(`${waiting} documents still not validated`);
    await sleep(1000);
  }
  const docsMs = Date.now() - docsStarted;
  log(`  imported in ${importMs} ms; documents written and validated in ${docsMs} ms`);
  return { workspaceId, databaseId, typing, rowIds, rows, importMs, docsMs };
}

// ------------------------------------------------------------------ in the page
/** Keydown to the next frame painted, and to the end of the editor's transaction (Phase 1's). */
function probes() {
  if (window.__keys) return;
  const afterPaint = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
      }),
    );
  window.__keys = { frame: [], work: [] };
  let start = null;
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key.length !== 1) return;
      start = event.timeStamp;
      void afterPaint().then(() => window.__keys.frame.push(performance.now() - event.timeStamp));
    },
    true,
  );
  window.__watchEditor = () => {
    const view = document.querySelector('.cgw-page .ProseMirror');
    if (!view?.editor) return false;
    if (view.__watched) return true;
    view.__watched = true;
    view.editor.on('transaction', ({ transaction }) => {
      if (start === null || !transaction.docChanged) return;
      window.__keys.work.push(performance.now() - start);
      start = null;
    });
    return true;
  };
}

/** How many of `ids` the device holds (a document cursor in its store). */
function heldOf(ids) {
  return new Promise((done) => {
    const open = indexedDB.open('cgw-workspace');
    open.onerror = () => done(0);
    open.onsuccess = () => {
      const db = open.result;
      const keys = db.transaction('docCursors').objectStore('docCursors').getAllKeys();
      keys.onsuccess = () => {
        db.close();
        const held = new Set(keys.result);
        done(ids.filter((id) => held.has(id)).length);
      };
      keys.onerror = () => (db.close(), done(0));
    };
  });
}

async function openTyping(page, pageId, blocks) {
  await page.evaluate((id) => (location.hash = `#/p/${id}`), pageId);
  await page.waitForFunction(
    (n) => (document.querySelector('.cgw-page .cgw-editor')?.childElementCount ?? 0) >= n,
    blocks,
    { timeout: 60000 },
  );
  const body = page.locator('.cgw-page .cgw-editor > [data-block] .cgw-body');
  await body.nth(Math.floor(blocks / 2)).click();
  await page.keyboard.press('End');
  await page.waitForFunction(() => window.__watchEditor?.());
}

/** The database kept offline from its page's menu, as a person does it. */
async function pinDatabase(page, databaseId) {
  await page.evaluate((id) => (location.hash = `#/p/${id}`), databaseId);
  await page.locator('.cgw-database-page').waitFor({ timeout: 60000 });
  await page.locator('.cgw-topbar-button[aria-label="Page actions"]').click();
  await page.getByRole('menuitem', { name: 'Make available offline', exact: true }).click();
}

/**
 * The figures, in a page signed in as the seeding account and Synced (a fresh profile, holding
 * nothing of the database): the time from the pin to every row's document held, and the keys
 * typed meanwhile.
 */
export async function measurePins(page, seeded, { log = console.log, limitMs = LIMIT_MS } = {}) {
  await page.evaluate(probes);
  const pulls = { batch: 0, single: 0, limited: 0 };
  const onRequest = (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/api\/v1\/workspaces\/[^/]+\/docs\/pull$/.test(path)) pulls.batch++;
    else if (/\/api\/v1\/pages\/[^/]+\/doc$/.test(path)) pulls.single++;
  };
  const onResponse = (response) => {
    if (response.status() === 429) pulls.limited++;
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  try {
    log(`Pinning a ${seeded.rows.toLocaleString('en')}-row database while typing`);
    await openTyping(page, seeded.typing, 200);
    await pinDatabase(page, seeded.databaseId);
    const pinned = Date.now();
    await openTyping(page, seeded.typing, 200);
    await page.evaluate(() => {
      window.__keys.frame.length = 0;
      window.__keys.work.length = 0;
    });
    let held = 0;
    let heldMs = null;
    const text = 'the quick brown fox jumps over the lazy dog and keeps on typing ';
    for (let chunk = 0; Date.now() - pinned < limitMs; chunk = (chunk + 16) % text.length) {
      // A key every 35 ms, and how many documents are held looked at every 16 keys.
      await page.keyboard.type(text.slice(chunk, chunk + 16), { delay: 35 });
      held = await page.evaluate(heldOf, seeded.rowIds);
      if (held >= seeded.rowIds.length) {
        heldMs = Date.now() - pinned;
        break;
      }
    }
    const keys = await page.evaluate(() => window.__keys);
    const work = keys.work;
    const frame = keys.frame;
    log(
      `  ${held} of ${seeded.rowIds.length} documents held in ${heldMs ?? `>${limitMs}`} ms; ${frame.length} keys: work p95 ${round(percentile(work, 0.95))} ms, next frame p95 ${round(percentile(frame, 0.95))} ms`,
    );
    log(
      `  ${pulls.batch} batch pulls, ${pulls.single} single pulls, ${pulls.limited} answers of 429`,
    );
    return {
      pin: {
        rows: seeded.rowIds.length,
        held,
        heldMs,
        keys: frame.length,
        workP50: round(percentile(work, 0.5)),
        workP95: round(percentile(work, 0.95)),
        frameP50: round(percentile(frame, 0.5)),
        frameP95: round(percentile(frame, 0.95)),
        pulls,
      },
      figures: {
        pin5000RowsHeldMs: heldMs ?? Infinity,
        pin5000RowsKeyWorkP95: round(percentile(work, 0.95)),
        pin5000RowsKeyFrameP95: round(percentile(frame, 0.95)),
        pin5000RowsImportMs: seeded.importMs,
        pin5000RowsSeedDocsMs: seeded.docsMs,
      },
    };
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
}

// ------------------------------------------------------------------ alone
function gate(figures) {
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(previousFile, 'utf8')).figures ?? null;
  } catch {
    // No baseline on this machine.
  }
  const failures = [];
  for (const [name, budget] of Object.entries(PINS_BUDGETS)) {
    const value = figures[name];
    if (value > budget.max + budget.slack)
      failures.push(`${name} ${value}${budget.unit} over ${budget.max}${budget.unit}`);
    const was = previous?.[name];
    if (was !== undefined && Number.isFinite(budget.max) && value > was * 1.5 + budget.slack)
      failures.push(`${name} ${value}${budget.unit} regressed from ${was}${budget.unit}`);
  }
  return failures;
}

async function alone() {
  const { chromium } = await import('@playwright/test');
  const { API, APP, apiSession, newAccount, signInPage, waitFor } =
    await import('../scripts/cloud-account.mjs');
  const log = (line) => console.log(line);
  mkdirSync(results, { recursive: true });
  await waitFor(`${API}/health/live`, 180000);
  await waitFor(APP, 60000);
  const account = await newAccount('Phase 12 pins bench');
  const api = await apiSession(account);
  let seeded;
  try {
    log(`Seeding a database of ${ROWS.toLocaleString('en')} rows with their documents`);
    seeded = await seedPinnedDatabase(api, { log });
  } finally {
    await api.dispose();
  }
  const browser = await chromium.launch({ channel: 'chrome' });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${APP}/`);
    await signInPage(page, account, `${APP}/`);
    await page
      .getByTestId('sync-status')
      .filter({ hasText: /^Synced$/ })
      .waitFor({ timeout: 180000 });
    const measured = await measurePins(page, seeded, { log });
    if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
    return { browser: browser.version(), ...measured };
  } catch (error) {
    for (const context of browser.contexts())
      for (const [i, page] of context.pages().entries())
        await page
          .screenshot({ path: join(results, `phase12-pins-failure-${i}.png`) })
          .catch(() => undefined);
    throw error;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.on('SIGINT', () => process.exit(130));
  alone().then(
    (measured) => {
      const failures = gate(measured.figures);
      writeFileSync(
        join(results, 'phase12-pins.json'),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            browser: measured.browser,
            figures: measured.figures,
            pin: measured.pin,
          },
          null,
          2,
        ) + '\n',
      );
      if (failures.length) {
        console.error('Phase 12 pins budgets failed:\n  ' + failures.join('\n  '));
        process.exit(1);
      }
      console.log('Phase 12 pins budgets met.');
    },
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
