// Phase 4's budgets (IMPLEMENTATION_PLAN.md, Phase 4, Performance benchmarks), measured and gated:
//   pnpm bench:phase4                    the web app in Chrome against the server stack, and the
//                                        server's query (Phase4Bench)
//   pnpm bench:phase4 -- --desktop       and a cell edit on the desktop app's SQLite store
//   pnpm bench:phase4 -- --server        the server's query only (CI: the Linux server job)
//   pnpm bench:phase4 -- --no-server     without it (CI: the Windows job)
// The web part needs `pnpm build` (and --desktop the release build); the web app under vite
// preview on 127.0.0.1:4273 and the server stack on 127.0.0.1:5280 are reused when they answer,
// else started here (scripts/server-stack.mjs --e2e) and stopped at the end.
//
// The web part. A database made through the API as a client makes one (a title, Size, Stage,
// Due and Notes; a table view and a board by Stage), and 50,000 rows imported through the
// server's import route (`POST /databases/{id}/import`, as the import dialog sends a large file).
// Then, in a fresh Chrome profile signed in as that person:
//   - first rows: from setting the database page's route to its table drawing its first row
//     (the server's query, keyset paged; the device holds the database partially, over
//     LOCAL_ROW_LIMIT): the first open (the server reads the database's rows into its cache:
//     tracked) and the median of five opens after it (budget 500 ms);
//   - scroll: the table scrolled 40 px a frame (2,400 px/s) for 5 s from the top, pages of rows
//     loading as it goes; frame intervals by requestAnimationFrame, p95 (budget 17.5 ms: 60
//     frames a second, a frame's 16.7 ms and timer jitter; frames per second tracked);
//   - board drag: the board by Stage, a card dragged by the mouse (pointer events, page.mouse)
//     over 120 moves to the next column but one, after a warm-up drag (the first drag in a
//     fresh Chrome has one long frame with no script in it); frame intervals p95 (budget
//     17.5 ms: no frame over 16 ms of work);
//   - a cell edit: 40 Notes cells typed into and committed with Enter: from Enter's keydown to
//     the cell showing the value (local: budget 16 ms, p95), to the frame after that painted
//     (budget 33 ms, p95: two frames, as Phase 1's keystroke after Q19), and to the change being
//     in IndexedDB (the host's `cgw-db-applied` mark, once the store's transaction resolved;
//     budget 1 s, p95).
// The desktop part (--desktop): the release app on a local workspace (SQLite), a Tasks database,
// the same 40 cell edits.
// The server part: server/tests/Cgw.Tests/Phase4Bench.cs (`dotnet test -c Release`,
// PHASE4_BENCH=1): 50,000 rows, one filter and one sort, through the API, p95 (budget 300 ms);
// on LocalDB unless CGW_TEST_SQL names a server (CI's Linux job).
//
// Each figure is checked against its budget and, when bench/previous/phase4.json holds the last
// run on main on the same processor (CI downloads it), against that: worse by half again and by
// more than a small margin fails. Writes bench/results/phase4.json.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  API,
  APP,
  answers,
  apiSession,
  newAccount,
  signInPage,
  waitFor,
} from '../scripts/cloud-account.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const serverOnly = args.includes('--server');
const withServer = !args.includes('--no-server');
const withDesktop = args.includes('--desktop') && !serverOnly;
const withWeb = !serverOnly && !args.includes('--no-web');
const ROWS = Number(process.env.PHASE4_ROWS ?? 50000);
/** Cell edits measured on each target (a p95 of 40 is the third-worst edit, not a single one). */
const EDITS = Number(process.env.PHASE4_EDITS ?? 40);
const previousFile = join(root, 'bench/previous/phase4.json');
const results = join(root, 'bench/results');
const log = (line) => console.log(line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Budgets, with the margin a regression must also exceed to fail (runners are noisy). */
const BUDGETS = {
  firstRows50kMs: { max: 500, unit: 'ms', slack: 100 },
  scroll50kFrameP95: { max: 17.5, unit: 'ms', slack: 3 },
  boardDragFrameP95: { max: 17.5, unit: 'ms', slack: 3 },
  // "Editing a cell: local ≤ 16 ms": Enter to the cell showing the value. The frame after it is
  // read as Phase 1's keystroke was (Q19: the wait for the next 60 Hz frame alone reaches
  // 16.7 ms): two frames.
  cellEditLocalP95: { max: 16, unit: 'ms', slack: 4 },
  cellEditFrameP95: { max: 33, unit: 'ms', slack: 5 },
  cellEditDurableP95: { max: 1000, unit: 'ms', slack: 100 },
  cellEditDesktopLocalP95: { max: 16, unit: 'ms', slack: 4 },
  cellEditDesktopFrameP95: { max: 33, unit: 'ms', slack: 5 },
  cellEditDesktopDurableP95: { max: 1000, unit: 'ms', slack: 100 },
  serverQueryP95: { max: 300, unit: 'ms', slack: 50 },
  // Tracked, not budgeted.
  firstRows50kColdMs: { max: Infinity, unit: 'ms', slack: 1000 },
  scroll50kFps: { max: Infinity, unit: 'fps', slack: 0 },
  import50kMs: { max: Infinity, unit: 'ms', slack: 10000 },
};

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};
const round = (n) => Math.round(n * 10) / 10;

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

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

// ------------------------------------------------------------------ the database
const P = { size: 'Size0001', stage: 'Stage001', due: 'Due00001', notes: 'Notes001' };
const STAGES = ['Backlog', 'Planned', 'Doing', 'Review', 'Done'];
const STAGE_IDS = STAGES.map((_, i) => `Stg0000${i}`);

/** A workspace with a 50,000-row database, through the API as a client makes it. */
async function seedDatabase(api) {
  const workspaceId = uuidv7();
  await api.post('/api/v1/workspaces', { id: workspaceId, name: 'Phase 4 bench' });
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
  const config = (group) => ({
    filter: null,
    sorts: [],
    group,
    properties: { order: [], hidden: [], widths: {} },
  });
  const view = (id, name, type, orderKey, group = null) => ({
    id,
    workspaceId,
    databaseId,
    name,
    type,
    orderKey,
    config: config(group),
    version: 1,
    createdAt: now,
  });
  const other = uuidv7();
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
          page(databaseId, 'database', 'Fifty thousand', 'a1', {
            database: {
              properties: [
                { id: 'title', name: 'Name', type: 'title' },
                {
                  id: P.size,
                  name: 'Size',
                  type: 'number',
                  number: { format: 'number', decimals: null },
                },
                {
                  id: P.stage,
                  name: 'Stage',
                  type: 'select',
                  options: STAGES.map((name, i) => ({ id: STAGE_IDS[i], name, colour: 'blue' })),
                },
                { id: P.due, name: 'Due', type: 'date', date: { includeTime: false } },
                { id: P.notes, name: 'Notes', type: 'text' },
              ],
            },
          }),
        ),
      ],
    }),
  );
  const tableId = uuidv7();
  const boardId = uuidv7();
  check(
    await api.post(`/api/v1/workspaces/${workspaceId}/ops`, {
      ops: [
        op('view.upsert', tableId, view(tableId, 'Table', 'table', 'a0')),
        op('view.upsert', boardId, view(boardId, 'Board', 'board', 'a1', { propertyId: P.stage })),
      ],
    }),
  );
  // The rows, through the import route (as the import dialog sends a file over 5,000 rows).
  const lines = ['Name,Size,Stage,Due,Notes'];
  for (let i = 1; i <= ROWS; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    lines.push(
      `Item ${String(i).padStart(5, '0')},${i},${STAGES[i % 5]},2026-11-${day},Note number ${i}`,
    );
  }
  const started = Date.now();
  const answer = await api.post(`/api/v1/databases/${databaseId}/import`, {
    csv: lines.join('\r\n') + '\r\n',
    columns: ['title', P.size, P.stage, P.due, P.notes],
    header: true,
  });
  const importMs = Date.now() - started;
  if (answer.created !== ROWS)
    throw new Error(`The import made ${answer.created} rows: ${JSON.stringify(answer.problems)}`);
  return { workspaceId, databaseId, other, tableId, boardId, importMs };
}

// ------------------------------------------------------------------ in the page
/**
 * A cell edit, from Enter's keydown in the cell's editor: to the cell showing the value (local),
 * to the frame after that painted (Phase 1's measure), and to the store holding it (the host's
 * `cgw-db-applied` mark: durable).
 */
function editProbe() {
  window.__edits = [];
  const afterPaint = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
      }),
    );
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter' || !event.target?.classList?.contains('cgw-inline-editor')) return;
      const start = event.timeStamp;
      const value = event.target.value;
      const id = event.target.closest('[role="gridcell"]')?.id;
      const edit = { local: null, frame: null, durable: null };
      window.__edits.push(edit);
      const shown = () => {
        const cell = id ? document.getElementById(id) : null;
        if (!cell || cell.querySelector('.cgw-inline-editor') || !cell.textContent.includes(value))
          return false;
        edit.local = performance.now() - start;
        observer.disconnect();
        void afterPaint().then(() => (edit.frame = performance.now() - start));
        return true;
      };
      const observer = new MutationObserver(() => void shown());
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      setTimeout(() => observer.disconnect(), 10000);
      const seen = () => {
        const mark = performance.getEntriesByName('cgw-db-applied').at(-1);
        if (mark && mark.startTime > start) edit.durable = mark.startTime - start;
        else if (performance.now() - start < 10000) setTimeout(seen, 5);
      };
      setTimeout(seen, 0);
    },
    true,
  );
}

/** Frame intervals while `run` goes on (requestAnimationFrame), in the page. */
function startFrames() {
  window.__frames = [];
  window.__framing = true;
  let last = performance.now();
  const tick = (now) => {
    window.__frames.push(now - last);
    last = now;
    if (window.__framing) requestAnimationFrame(tick);
  };
  requestAnimationFrame((now) => {
    last = now;
    requestAnimationFrame(tick);
  });
}
const stopFrames = () => {
  window.__framing = false;
  return window.__frames.splice(0);
};

/** From setting the route to the table's first row drawn, in the page. */
function openTimed(databaseId) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    location.hash = `#/p/${databaseId}`;
    const check = () => {
      const first = document.querySelector(
        '.cgw-database-page [role="grid"] [role="row"][aria-rowindex="2"] .cgw-title-text',
      );
      if (first?.textContent) return resolve(performance.now() - started);
      if (performance.now() - started > 60000) return reject(new Error('No first row in 60 s'));
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

/** Notes cells (`EDITS`) typed into and committed with Enter; each edit's local, frame and durable times. */
async function cellEdits(page, scope) {
  await page.evaluate(() => window.__edits.splice(0));
  const grid = page.locator(`${scope} [role="grid"]`);
  const notes = await grid
    .locator('[role="columnheader"]')
    .evaluateAll((cells) =>
      cells.findIndex((c) => /^Notes, /.test(c.getAttribute('aria-label') ?? '')),
    );
  if (notes < 0) throw new Error('No Notes column');
  for (let i = 0; i < EDITS; i++) {
    // The first ten rows, over and over: all inside the table's window (it draws only those).
    const row = grid.locator(`[role="row"][aria-rowindex="${(i % 10) + 2}"]`);
    const cell = row.locator(`[role="gridcell"][aria-colindex="${notes + 1}"]`);
    const editor = page.locator(`${scope} .cgw-inline-editor`);
    // A click on the active cell edits it; on another, it only makes it active.
    await cell.click();
    if (!(await editor.count())) await page.keyboard.press('Enter');
    await editor.waitFor({ timeout: 10000 });
    await editor.fill(`Edited ${i} ${Date.now()}`);
    await page.keyboard.press('Enter');
    await editor.waitFor({ state: 'detached', timeout: 10000 });
    await sleep(150);
  }
  await page.waitForFunction(() => window.__edits.every((e) => e.frame !== null), null, {
    timeout: 30000,
  });
  await sleep(1200);
  const edits = await page.evaluate(() => window.__edits.splice(0));
  const all = (key) => edits.map((e) => e[key]).filter((v) => v !== null);
  const [local, frames, durable] = [all('local'), all('frame'), all('durable')];
  const p95 = (values) =>
    values.length === edits.length ? round(percentile(values, 0.95)) : Infinity;
  return {
    edits: edits.length,
    localP50: round(percentile(local, 0.5)),
    localP95: p95(local),
    frameP50: round(percentile(frames, 0.5)),
    frameP95: p95(frames),
    durableP50: round(percentile(durable, 0.5)),
    durableP95: p95(durable),
  };
}

// ------------------------------------------------------------------ the browser part
async function web(account, seeded) {
  const browser = await chromium.launch({ channel: 'chrome' });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(editProbe);
    await page.goto(`${APP}/`);
    await signInPage(page, account, `${APP}/#/p/${seeded.other}`);
    await page
      .getByTestId('sync-status')
      .filter({ hasText: /^Synced$/ })
      .waitFor({ timeout: 120000 });
    await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 60000 });

    // First rows: the first open, then five more, each from another page.
    log('First rows of the 50,000-row database');
    const opens = [];
    for (let i = 0; i < 6; i++) {
      await page.evaluate((id) => (location.hash = `#/p/${id}`), seeded.other);
      await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 30000 });
      await sleep(i === 0 ? 0 : 500);
      opens.push(await page.evaluate(openTimed, seeded.databaseId));
    }
    const [cold, ...warm] = opens;
    log(`  first open ${round(cold)} ms; then ${warm.map(round).join(', ')} ms`);
    const status = await page.locator('.cgw-database-page .cgw-table-foot').textContent();
    log(`  ${status}`);

    // Scroll: 40 px a frame for 5 s, on whatever scrolls the table (the page on a database's own
    // page).
    log('Scrolling the table');
    const grid = page.locator('.cgw-database-page [role="grid"]');
    await grid.evaluate((el) => {
      let box = el;
      while (
        box &&
        !(
          box.scrollHeight > box.clientHeight + 1 &&
          /auto|scroll/.test(getComputedStyle(box).overflowY)
        )
      )
        box = box.parentElement;
      window.__scroller = box ?? document.scrollingElement;
      window.__scroller.scrollTop = 0;
    });
    await sleep(500);
    await page.evaluate(startFrames);
    await page.evaluate(
      () =>
        new Promise((done) => {
          const el = window.__scroller;
          const until = performance.now() + 5000;
          const step = () => {
            el.scrollTop += 40;
            if (performance.now() < until) requestAnimationFrame(step);
            else done();
          };
          requestAnimationFrame(step);
        }),
    );
    const scrollFrames = (await page.evaluate(stopFrames)).slice(2);
    const scrolledTo = await page.evaluate(() => window.__scroller.scrollTop);
    const loaded = await page.locator('.cgw-database-page .cgw-table-foot').textContent();
    const fps = round((scrollFrames.length * 1000) / scrollFrames.reduce((a, b) => a + b, 0));
    log(
      `  ${scrollFrames.length} frames, ${fps} fps, p95 ${round(percentile(scrollFrames, 0.95))} ms; ${scrolledTo} px; ${loaded}`,
    );

    // A cell edit, at the top of the table.
    log(`${EDITS} cell edits (IndexedDB)`);
    await page.evaluate(() => (window.__scroller.scrollTop = 0));
    await sleep(500);
    const edit = await cellEdits(page, '.cgw-database-page');
    log(
      `  shown p95 ${edit.localP95} ms; next frame p95 ${edit.frameP95} ms; durable p50 ${edit.durableP50} ms, p95 ${edit.durableP95} ms`,
    );

    // Board drag: a warm-up drag, then the measured one.
    log('Dragging a card on the board');
    const boardTab = page.getByRole('tab', { name: 'Board' });
    await boardTab.focus();
    await page.keyboard.press('Enter');
    const columns = page.locator('.cgw-database-page [data-group]');
    await columns.nth(2).locator('[role="article"]').first().waitFor({ timeout: 60000 });
    const drag = async (from, to, measure) => {
      const card = columns.nth(from).locator('[role="article"]').first();
      const a = await card.boundingBox();
      const b = await columns.nth(to).boundingBox();
      const x0 = a.x + a.width / 2;
      const y0 = a.y + 12;
      const x1 = b.x + b.width / 2;
      const y1 = b.y + 120;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      if (measure) await page.evaluate(startFrames);
      const steps = 120;
      for (let i = 1; i <= steps; i++)
        await page.mouse.move(
          x0 + ((x1 - x0) * i) / steps,
          y0 + ((y1 - y0) * i) / steps + Math.sin(i / 6) * 40,
        );
      const frames = measure ? (await page.evaluate(stopFrames)).slice(2) : [];
      await page.mouse.up();
      await sleep(800);
      return frames;
    };
    await drag(1, 0, false);
    const dragFrames = await drag(1, 3, true);
    log(
      `  ${dragFrames.length} frames, p50 ${round(percentile(dragFrames, 0.5))} ms, p95 ${round(percentile(dragFrames, 0.95))} ms, max ${round(Math.max(...dragFrames))} ms`,
    );
    if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
    return {
      browser: browser.version(),
      firstRows: {
        coldMs: round(cold),
        warm: warm.map(round),
        medianMs: round(percentile(warm, 0.5)),
      },
      scroll: {
        frames: scrollFrames.length,
        fps,
        frameP50: round(percentile(scrollFrames, 0.5)),
        frameP95: round(percentile(scrollFrames, 0.95)),
        over20: scrollFrames.filter((f) => f > 20).length,
        scrolledPx: scrolledTo,
        loaded,
      },
      cellEdit: edit,
      boardDrag: {
        frames: dragFrames.length,
        frameP50: round(percentile(dragFrames, 0.5)),
        frameP95: round(percentile(dragFrames, 0.95)),
        max: round(Math.max(...dragFrames)),
      },
    };
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------ the desktop part
async function freePort() {
  const listener = createServer();
  await new Promise((done) => listener.listen(0, '127.0.0.1', done));
  const { port } = listener.address();
  await new Promise((done) => listener.close(done));
  return port;
}

async function desktop() {
  const exe = join(root, 'target/release/cgw-desktop.exe');
  if (!existsSync(exe)) throw new Error('The desktop build is missing: run pnpm desktop:build.');
  const profile = mkdtempSync(join(tmpdir(), 'cgw-phase4-desktop-'));
  const hostedRunner =
    process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
  const policyKey =
    'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';
  const reg = (a) => spawnSync('reg.exe', a, { encoding: 'utf8', windowsHide: true });
  const port = await freePort();
  const browserArgs = `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`;
  if (hostedRunner)
    reg([
      'add',
      policyKey,
      '/v',
      'cgw-desktop.exe',
      '/t',
      'REG_SZ',
      '/d',
      browserArgs,
      '/f',
      '/reg:64',
    ]);
  const child = spawn(exe, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview2'),
      CGW_DATA_DIR: join(profile, 'data'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs,
      // Never signed in here, but a keychain name of its own all the same.
      CGW_KEYCHAIN_SERVICE: `com.cashgear.workspace.bench.${basename(profile)}`,
    },
  });
  let browser = null;
  try {
    await waitFor(`http://127.0.0.1:${port}/json/version`, 60000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    await page.getByLabel('Workspace name').waitFor({ timeout: 60000 });
    await page.evaluate(editProbe);
    await page.getByLabel('Workspace name').fill('Desktop databases');
    await page.keyboard.press('Enter');
    await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 60000 });
    await page.locator('[data-action="new-database"]').first().click();
    await page.getByRole('menuitem', { name: 'New database', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New database' });
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await page.locator('.cgw-database-page [role="grid"]').waitFor({ timeout: 30000 });
    // An empty database's three rows, and a Notes column for the edits.
    const db = page.locator('.cgw-database-page');
    await db.locator('.cgw-th-add button').click();
    await page
      .getByRole('menu', { name: 'Add a property of type…' })
      .getByRole('menuitem', { name: 'Text', exact: true })
      .press('Enter');
    const name = page.getByRole('textbox', { name: 'Property name' });
    await name.fill('Notes');
    await name.press('Enter');
    await page.keyboard.press('Escape');
    for (let i = 0; i < 17; i++) {
      await db.locator('.cgw-new-row').last().click();
      await db.locator('.cgw-inline-editor').fill(`Row ${i + 4}`);
      await page.keyboard.press('Enter');
      await sleep(100);
    }
    log(`${EDITS} cell edits (SQLite)`);
    const edit = await cellEdits(page, '.cgw-database-page');
    log(
      `  shown p95 ${edit.localP95} ms; next frame p95 ${edit.frameP95} ms; durable p50 ${edit.durableP50} ms, p95 ${edit.durableP95} ms`,
    );
    return { cellEdit: edit };
  } finally {
    await browser?.close().catch(() => {});
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    if (hostedRunner) reg(['delete', policyKey, '/v', 'cgw-desktop.exe', '/f', '/reg:64']);
    await sleep(1500);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      log(`  (could not remove ${profile}: ${error.code})`);
    }
  }
}

// ------------------------------------------------------------------ the server part
function server() {
  const ffi = join(
    root,
    'target/ffi',
    process.platform === 'win32' ? 'cgw_ydoc.dll' : 'libcgw_ydoc.so',
  );
  if (!existsSync(ffi)) {
    log('Building cgw-ydoc for the worker');
    const built = spawnSync('cargo', ['build', '-p', 'cgw-ydoc', '--profile', 'ffi'], {
      cwd: root,
      stdio: 'inherit',
    });
    if (built.status !== 0) throw new Error('cargo build -p cgw-ydoc --profile ffi failed');
  }
  const file = join(results, 'phase4-server.json');
  rmSync(file, { force: true });
  log('Running the server benchmark (dotnet test -c Release, Phase4Bench)');
  const started = Date.now();
  const ran = spawnSync(
    'dotnet',
    [
      'test',
      '--solution',
      'server/Cgw.Server.slnx',
      '-c',
      'Release',
      '--',
      '--filter-class',
      '*Phase4Bench*',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        PHASE4_BENCH: '1',
        PHASE4_ROWS: String(ROWS),
        CGW_TEST_LOG: process.env.CGW_TEST_LOG ?? 'Error',
      },
    },
  );
  if (!existsSync(file)) throw new Error('The server benchmark wrote nothing (phase4-server.json)');
  return {
    ...JSON.parse(readFileSync(file, 'utf8')),
    testsPassed: ran.status === 0,
    minutes: Math.round((Date.now() - started) / 6000) / 10,
  };
}

// ------------------------------------------------------------------ main
mkdirSync(results, { recursive: true });
const out = {
  at: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? null,
  rows: ROWS,
  machine: {
    cpu: cpus()[0]?.model?.trim() ?? null,
    threads: cpus().length,
    memoryGB: Math.round(totalmem() / 1073741824),
    os: `${process.platform} ${process.arch}`,
  },
};
const started = [];
try {
  if (withWeb) {
    if (!existsSync(join(root, 'apps/web/dist/index.html')))
      throw new Error('Run pnpm build first.');
    if (!(await answers(`${API}/health/live`))) {
      log('Starting the server stack (scripts/server-stack.mjs --e2e)');
      started.push(
        spawn(process.execPath, [join(root, 'scripts/server-stack.mjs'), '--e2e'], {
          cwd: root,
          stdio: 'ignore',
        }),
      );
      await waitFor(`${API}/health/live`, 600000);
    } else log(`Reusing the server stack on ${API}`);
    if (!(await answers(APP))) {
      log(`Starting vite preview on ${APP}`);
      started.push(
        spawn(process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview'], {
          cwd: join(root, 'apps/web'),
          stdio: 'ignore',
        }),
      );
      await waitFor(APP, 60000);
    } else log(`Reusing the web app on ${APP}`);
    const account = await newAccount('Phase 4 bench');
    const api = await apiSession(account);
    let seeded;
    try {
      log(`Seeding a database of ${ROWS.toLocaleString('en')} rows through the import route`);
      seeded = await seedDatabase(api);
    } finally {
      await api.dispose();
    }
    out.importMs = seeded.importMs;
    log(`  imported in ${seeded.importMs} ms`);
    out.web = await web(account, seeded);
  }
  if (withDesktop) out.desktop = await desktop();
} finally {
  for (const child of started.reverse()) stopTree(child);
}
if (withServer) out.server = server();

const figures = {
  firstRows50kMs: out.web?.firstRows?.medianMs,
  firstRows50kColdMs: out.web?.firstRows?.coldMs,
  scroll50kFrameP95: out.web?.scroll?.frameP95,
  scroll50kFps: out.web?.scroll?.fps,
  boardDragFrameP95: out.web?.boardDrag?.frameP95,
  cellEditLocalP95: out.web?.cellEdit?.localP95,
  cellEditFrameP95: out.web?.cellEdit?.frameP95,
  cellEditDurableP95: out.web?.cellEdit?.durableP95,
  cellEditDesktopLocalP95: out.desktop?.cellEdit?.localP95,
  cellEditDesktopFrameP95: out.desktop?.cellEdit?.frameP95,
  cellEditDesktopDurableP95: out.desktop?.cellEdit?.durableP95,
  serverQueryP95: out.server?.query?.filterAndSort?.p95,
  import50kMs: out.importMs,
};
const last = existsSync(previousFile) ? JSON.parse(readFileSync(previousFile, 'utf8')) : null;
const sameMachine = !!last && last.machine?.cpu === out.machine.cpu;
const previous = sameMachine ? (last.figures ?? null) : null;
const gate = [];
for (const [name, value] of Object.entries(figures)) {
  if (value === undefined || value === null) continue;
  const budget = BUDGETS[name];
  const before = previous?.[name];
  // Frames per second: higher is better; tracked only.
  const overBudget = value > budget.max;
  const regressed =
    name !== 'scroll50kFps' &&
    typeof before === 'number' &&
    value > before * 1.5 &&
    value - before > budget.slack;
  gate.push({
    name,
    value,
    budget: Number.isFinite(budget.max) ? budget.max : null,
    unit: budget.unit,
    previous: before ?? null,
    overBudget,
    regressed,
  });
}
out.figures = figures;
out.gate = gate;
writeFileSync(join(results, 'phase4.json'), JSON.stringify(out, null, 2) + '\n');
log('\nBudget                         value      budget   last main');
for (const g of gate)
  log(
    `${g.overBudget || g.regressed ? 'FAIL' : 'ok  '} ${g.name.padEnd(28)} ${String(g.value).padStart(7)} ${g.unit.padEnd(3)} ${String(g.budget ?? 'none').padStart(7)}   ${g.previous ?? '-'}${g.regressed ? '  (regressed)' : ''}`,
  );
if (out.server && !out.server.testsPassed)
  log('The server benchmark failed: see its output above.');
if (!last) log('(No run on main to compare with: budgets only.)');
else if (!sameMachine)
  log(
    `(The last run on main ran on ${last.machine?.cpu ?? 'a processor it did not record'}, this one on ${out.machine.cpu}: budgets only.)`,
  );
process.exitCode =
  gate.some((g) => g.overBudget || g.regressed) || (out.server && !out.server.testsPassed) ? 1 : 0;
