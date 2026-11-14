// Phase 5's budgets (IMPLEMENTATION_PLAN.md, Phase 5, Performance benchmarks), measured and gated:
//   pnpm bench:phase5                    the web app in Chrome against the server stack, the mock
//                                        Sheet (tests/mocks/sheet) and the mock ERP
//                                        (tests/mocks/erp)
//   pnpm bench:phase5 -- --desktop       and the embed's first paint and the keystrokes on the
//                                        desktop app (signed in through its system-browser flow)
//   pnpm bench:phase5 -- --real-sheet    the embed against Sheet's preview on 127.0.0.1:4173 (the
//                                        web build made with VITE_CGW_SHEET=http://127.0.0.1:4173,
//                                        the stack with Sheet__Origin set to it; Sheet's
//                                        hand-over says how to run its preview)
// The web part needs `pnpm build` (and --desktop the release build). The web app under vite
// preview on 127.0.0.1:4273, the server stack on 127.0.0.1:5280 and the two mocks (4283; 4282 and
// 4284) are reused when they answer, else started here and stopped at the end.
//
// The figures:
//   - an embed's first paint: a page whose workbook block (a 1,000-cell range, 50 rows by 20
//     columns) lies far below the fold, so its frame is not made; the block scrolled into view at
//     once; from that scroll to the later of the block showing its live frame and (the mock) the
//     frame's first cells drawn, each to the frame after it painted (timed on the shared clock,
//     `performance.timeOrigin + now()`, in both documents). Six times, the block put out of reach
//     (its frame destroyed) between them; p95 (budget 2 s). The stored picture's first paint is
//     tracked;
//   - a page with 10 embeds (ten live frames, paragraphs between them), typing in the paragraph
//     in the middle: editor work per keystroke (from the keydown to the end of the transaction it
//     caused, Q19: budget 8 ms, p95) and keystroke to the next frame (budget 33 ms, p95);
//   - an ERP block's first page: a page holding an ERP view of Vendors, opened in a tab already
//     connected; from setting the route to the table's first row drawn, less the time an ERP
//     request was in flight (the union of the ERP's requests' Resource Timing spans in that
//     window: the ERP's own time). Six opens; p95 of what is left (budget 1 s); the ERP's time and
//     the total tracked.
// Each figure is checked against its budget and, when bench/previous/phase5.json holds the last
// run on main on the same processor (CI downloads it), against that: worse by half again and by
// more than a small margin fails. Writes bench/results/phase5.json.
import { spawn, spawnSync } from 'node:child_process';
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
  desktopSignIn,
  newAccount,
  signInPage,
  waitFor,
} from '../scripts/cloud-account.mjs';
import { XLSX_TYPE, writeXlsx } from '../tests/mocks/sheet/xlsx.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const withDesktop = args.includes('--desktop');
const realSheet = args.includes('--real-sheet');
const MOCK_SHEET = 'http://127.0.0.1:4283';
const SHEET = realSheet ? (process.env.CGW_BENCH_SHEET ?? 'http://127.0.0.1:4173') : MOCK_SHEET;
const ERP_API = 'http://127.0.0.1:4282';
const RUNS = Number(process.env.PHASE5_RUNS ?? 6);
const previousFile = join(root, 'bench/previous/phase5.json');
const results = join(root, 'bench/results');
const log = (line) => console.log(line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Budgets, with the margin a regression must also exceed to fail (runners are noisy). */
const BUDGETS = {
  embedFirstPaintP95: { max: 2000, unit: 'ms', slack: 300 },
  key10EmbedsWorkP95: { max: 8, unit: 'ms', slack: 2 },
  key10EmbedsFrameP95: { max: 33, unit: 'ms', slack: 5 },
  erpFirstPageP95: { max: 1000, unit: 'ms', slack: 150 },
  embedFirstPaintDesktopP95: { max: 2000, unit: 'ms', slack: 300 },
  key10EmbedsDesktopWorkP95: { max: 8, unit: 'ms', slack: 2 },
  key10EmbedsDesktopFrameP95: { max: 33, unit: 'ms', slack: 5 },
  // Tracked, not budgeted.
  embedPictureP95: { max: Infinity, unit: 'ms', slack: 1000 },
  erpOwnTimeP95: { max: Infinity, unit: 'ms', slack: 1000 },
  erpTotalP95: { max: Infinity, unit: 'ms', slack: 1000 },
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

async function freePort() {
  const listener = createServer();
  await new Promise((done) => listener.listen(0, '127.0.0.1', done));
  const { port } = listener.address();
  await new Promise((done) => listener.close(done));
  return port;
}

// ------------------------------------------------------------------ workbooks and links
/** 50 rows by 20 columns: 1,000 cells, all numbers but the header row. */
const thousandCells = () =>
  writeXlsx({
    sheets: [
      {
        name: 'Thousand',
        rows: [
          Array.from({ length: 20 }, (_, c) => `Column ${c + 1}`),
          ...Array.from({ length: 49 }, (_, r) =>
            Array.from({ length: 20 }, (_, c) => (r + 1) * 100 + c),
          ),
        ],
      },
    ],
  });
const smallBook = () =>
  writeXlsx({
    sheets: [
      {
        name: 'Small',
        rows: [
          ['Item', 'Q1', 'Q2', 'Q3'],
          ['Rent', 1200, 1250, 1300],
          ['Travel', 300, 280, 310],
          ['Tools', 99, 120, 80],
        ],
      },
    ],
  });

const sheetSession = (path, init) =>
  fetch(`${API}/api/v1/sheet-sessions${path}`, {
    method: 'POST',
    redirect: 'error',
    ...init,
    headers: { Origin: MOCK_SHEET, ...init.headers },
  });

/** A workbook with one version, saved as Sheet saves one (sheet-session.1). */
async function workbook(api, workspaceId, name, bytes) {
  const made = await api.post(`/api/v1/workspaces/${workspaceId}/workbooks`, { id: null, name });
  const { url } = await api.post(`/api/v1/workbooks/${made.id}/launch`);
  const ticket = /#launch=([A-Za-z0-9_-]{43})$/.exec(url)[1];
  const redeemed = await sheetSession('/redeem', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  if (redeemed.status !== 200) throw new Error(`Redeem answered ${redeemed.status}`);
  const { token } = await redeemed.json();
  const saved = await sheetSession('/workbook/versions', {
    headers: {
      'X-Workspace-File-Session': token,
      'Content-Type': XLSX_TYPE,
      'If-None-Match': '*',
    },
    body: bytes,
  });
  if (saved.status !== 201) throw new Error(`The save answered ${saved.status}`);
  await sheetSession('/end', { headers: { 'X-Workspace-File-Session': token } });
  return made.id;
}

/** The workspace linked to the mock ERP's company, as the link screen links it. */
async function link(api, workspaceId, workspaceName) {
  const ticket = (
    await (
      await fetch(`${ERP_API}/__mock/link-ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'dan' }),
      })
    ).json()
  ).ticket;
  const redeemed = await fetch(`${ERP_API}/api/system/WorkspaceLink/Redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4273' },
    body: JSON.stringify({ ticket, workspaceId, workspaceName }),
  });
  const erp = await redeemed.json();
  await api.post(`/api/v1/workspaces/${workspaceId}/erp-links`, {
    erpLinkId: erp.linkId,
    erpBaseUrl: ERP_API,
    company: erp.company,
    companyName: erp.companyName,
  });
}

// ------------------------------------------------------------------ in the pages
/**
 * In every frame: in Workspace's page, keystrokes (keydown to the next frame painted, and to the
 * end of the editor's transaction); in the mock embed, when its first cells were drawn and painted.
 */
function probes(sheetOrigin) {
  const now = () => performance.timeOrigin + performance.now();
  const afterPaint = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
      }),
    );
  if (location.origin === sheetOrigin && location.pathname === '/embed') {
    const watch = new MutationObserver(() => {
      if (window.__cells || !document.querySelector('td')) return;
      window.__cells = now();
      void afterPaint().then(() => (window.__cellsPainted = now()));
      watch.disconnect();
    });
    watch.observe(document, { subtree: true, childList: true, characterData: true });
    return;
  }
  window.__keys = { frame: [], work: [] };
  let start = null;
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key.length !== 1) return;
      const at = event.timeStamp;
      start = at;
      void afterPaint().then(() => window.__keys.frame.push(performance.now() - at));
    },
    true,
  );
  window.__watchEditor = () => {
    const view = document.querySelector('.cgw-page .ProseMirror');
    if (!view?.editor || view.__watched) return false;
    view.__watched = true;
    view.editor.on('transaction', ({ transaction }) => {
      if (start === null || !transaction.docChanged) return;
      window.__keys.work.push(performance.now() - start);
      start = null;
    });
    return true;
  };
}

/** The element that scrolls the page's editor. */
function markScroller() {
  let box = document.querySelector('.cgw-page .ProseMirror');
  while (
    box &&
    !(
      box.scrollHeight > box.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(box).overflowY)
    )
  )
    box = box.parentElement;
  window.__scroller = box ?? document.scrollingElement;
}

/** A page's paragraphs, typed as a person types them (inserted text, then Enter). */
async function paragraphs(page, count, label) {
  for (let i = 1; i <= count; i++) {
    await page.keyboard.insertText(`${label} paragraph ${i}: words to make the page long.`);
    await page.keyboard.press('Enter');
  }
}

async function insertWorkbook(page, name) {
  await page.keyboard.type('/existing');
  // The one item, chosen by the keys (a click races the menu placing itself at a page's foot).
  await page.getByRole('option', { name: /^Existing workbook/, selected: true }).waitFor();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Choose a workbook' });
  await dialog.getByRole('combobox').fill(name);
  await dialog
    .getByRole('option', { name: new RegExp(name) })
    .first()
    .click();
  await dialog.waitFor({ state: 'detached' });
}

async function newPage(page, title) {
  const before = new URL(page.url()).hash;
  await page
    .getByRole('button', { name: /^Add a page in/ })
    .first()
    .click();
  // The new page open, its title empty and focused (as tests/e2e/helpers.ts's newPage waits).
  await page.waitForFunction(
    (before) => {
      const input = document.querySelector('[aria-label="Page title"]');
      return location.hash !== before && input?.value === '' && document.activeElement === input;
    },
    before,
    { timeout: 30000 },
  );
  await page.getByLabel('Page title').fill(title);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.closest('.cgw-editor'));
  return new URL(page.url()).hash.match(/#\/p\/([0-9a-f-]{36})/)[1];
}

const saved = (page) =>
  page.getByTestId('save-status').filter({ hasText: /Saved/ }).waitFor({ timeout: 30000 });

/** The embed's first paint, `RUNS` times; and the stored picture's. */
async function embedFirstPaint(page, frameProbe) {
  await page.evaluate(markScroller);
  const runs = [];
  const pictures = [];
  for (let i = 0; i < RUNS; i++) {
    // Out of reach: at the top, the block's frame is destroyed (beyond 2,400 px).
    await page.evaluate(() => (window.__scroller.scrollTop = 0));
    await page.locator('.cgw-sheet').waitFor({ state: 'detached', timeout: 30000 });
    await sleep(500);
    const t0 = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const holder = document.querySelector('[data-body="sheetEmbed"]');
          holder.scrollIntoView({ block: 'center' });
          const box = holder.getBoundingClientRect();
          if (box.bottom < 0 || box.top > innerHeight) throw new Error('Not in view');
          resolve(performance.timeOrigin + performance.now());
        }),
    );
    // The block shows its live frame: the next frame after `data-shown`, on the page's clock.
    const shown = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const limit = performance.now() + 30000;
          const step = () => {
            if (document.querySelector('.cgw-sheet-picture img') && !window.__picture)
              window.__picture = performance.timeOrigin + performance.now();
            if (document.querySelector('.cgw-sheet-live[data-shown] iframe'))
              return requestAnimationFrame(() => {
                const channel = new MessageChannel();
                channel.port1.onmessage = () => resolve(performance.timeOrigin + performance.now());
                channel.port2.postMessage(0);
              });
            if (performance.now() > limit) return reject(new Error('No live frame in 30 s'));
            requestAnimationFrame(step);
          };
          window.__picture = null;
          step();
        }),
    );
    let cells = null;
    if (frameProbe) {
      const frame = page.frames().find((f) => f.url().startsWith(`${SHEET}/embed`));
      cells = await frame.waitForFunction(() => window.__cellsPainted, null, { timeout: 30000 });
      cells = await cells.jsonValue();
      const drawn = await frame.evaluate(() => document.querySelectorAll('td').length);
      if (drawn !== 1000) throw new Error(`The embed drew ${drawn} cells, not 1,000`);
    }
    const picture = await page.evaluate(() => window.__picture);
    runs.push(Math.max(shown, cells ?? 0) - t0);
    if (picture) pictures.push(picture - t0);
    log(
      `  run ${i + 1}: ${round(Math.max(shown, cells ?? 0) - t0)} ms (frame shown ${round(shown - t0)}${cells ? `, cells ${round(cells - t0)}` : ''}${picture ? `, picture ${round(picture - t0)}` : ''})`,
    );
  }
  return {
    runs: runs.map(round),
    p50: round(percentile(runs, 0.5)),
    p95: round(percentile(runs, 0.95)),
    picture: pictures.length
      ? { runs: pictures.map(round), p95: round(percentile(pictures, 0.95)) }
      : null,
  };
}

/** Ten embeds with paragraphs between them, all live; typing in the middle one. */
async function tenEmbeds(page) {
  const middle = page.locator('.cgw-page .cgw-editor [data-block] .cgw-body', {
    hasText: 'Between 5 and 6',
  });
  await middle.waitFor({ timeout: 30000 });
  // The middle of the page in view: every frame is within reach and made.
  await middle.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.locator('.cgw-sheet[data-state="loaded"]').nth(9).waitFor({ timeout: 120000 });
  const live = await page.locator('.cgw-sheet[data-state="loaded"]').count();
  await sleep(1500);
  await middle.click();
  await page.keyboard.press('End');
  if (!(await page.evaluate(() => window.__watchEditor()))) throw new Error('No editor to watch');
  await sleep(500);
  await page.evaluate(() => {
    window.__keys.frame.length = 0;
    window.__keys.work.length = 0;
  });
  await page.keyboard.type(' the quick brown fox jumps over the lazy dog and keeps on typing', {
    delay: 35,
  });
  await sleep(500);
  const keys = await page.evaluate(() => window.__keys);
  const stillLive = await page.locator('.cgw-sheet[data-state="loaded"]').count();
  return {
    embeds: live,
    liveAfter: stillLive,
    keys: keys.frame.length,
    workP50: round(percentile(keys.work, 0.5)),
    workP95: round(percentile(keys.work, 0.95)),
    frameP50: round(percentile(keys.frame, 0.5)),
    frameP95: round(percentile(keys.frame, 0.95)),
  };
}

/** The pages and blocks the embed figures use, in a signed-in app (browser or desktop). */
async function embedPages(page, api, workspaceId) {
  await workbook(api, workspaceId, 'Thousand cells', thousandCells());
  await workbook(api, workspaceId, 'Small book', smallBook());
  // The far block: 150 paragraphs above it.
  const far = await newPage(page, 'Far embed');
  await paragraphs(page, 150, 'Above');
  await insertWorkbook(page, 'Thousand cells');
  await page.keyboard.press('Enter');
  await paragraphs(page, 3, 'Below');
  await saved(page);
  // Ten embeds, a paragraph between each.
  const ten = await newPage(page, 'Ten embeds');
  for (let i = 1; i <= 10; i++) {
    await insertWorkbook(page, 'Small book');
    await page
      .locator('.cgw-sheet')
      .nth(i - 1)
      .waitFor({ timeout: 30000 });
    await page.keyboard.insertText(i < 10 ? `Between ${i} and ${i + 1}.` : 'After the last.');
    await page.keyboard.press('Enter');
  }
  await saved(page);
  return { far, ten };
}

// ------------------------------------------------------------------ the browser part
async function web(account, api) {
  const browser = await chromium.launch({ channel: 'chrome' });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(probes, SHEET);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${APP}/`);
    await signInPage(page, account, `${APP}/`);
    // A workspace made as the first run makes one, synced, then linked to the mock ERP.
    await page.getByLabel('Workspace name').fill('Phase 5 bench');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 60000 });
    await page
      .getByTestId('sync-status')
      .filter({ hasText: /^Synced$/ })
      .waitFor({ timeout: 120000 });
    const workspaceId = (await api.get('/api/v1/workspaces')).find(
      (w) => w.name === 'Phase 5 bench',
    ).id;
    await link(api, workspaceId, 'Phase 5 bench');
    log('Making the pages: a far embed, ten embeds, an ERP view');
    const pages = await embedPages(page, api, workspaceId);
    // The ERP view of Vendors, connected in this tab.
    const erpPage = await newPage(page, 'ERP view');
    await page.keyboard.type('/erp');
    await page.getByRole('option', { name: /^ERP data/, selected: true }).waitFor();
    await page.keyboard.press('Enter');
    const block = page.getByTestId('erp-view');
    const opened = page.waitForEvent('popup');
    await block.getByTestId('erp-not-connected').getByRole('button').click();
    const popup = await opened;
    await popup.locator('#user').selectOption('alice');
    const closed = popup.waitForEvent('close');
    await popup.locator('#connect').click();
    await closed;
    await block.locator('[data-connector="vendors"]').click();
    await block.getByTestId('erp-table').waitFor({ timeout: 30000 });
    await saved(page);

    log(`The embed's first paint (a 1,000-cell range scrolled into view), ${RUNS} times`);
    await page.evaluate((id) => (location.hash = `#/p/${id}`), pages.far);
    await page.locator('.cgw-page .cgw-editor').waitFor();
    await sleep(1000);
    const firstPaint = await embedFirstPaint(page, !realSheet);
    log(`  p50 ${firstPaint.p50} ms, p95 ${firstPaint.p95} ms`);

    log('Typing between ten embeds');
    await page.evaluate((id) => (location.hash = `#/p/${id}`), pages.ten);
    const keys = await tenEmbeds(page);
    log(
      `  ${keys.embeds} live frames; ${keys.keys} keys: work p95 ${keys.workP95} ms, next frame p95 ${keys.frameP95} ms`,
    );

    log(`An ERP block's first page, ${RUNS} opens`);
    const erp = await erpFirstPage(page, erpPage, pages.ten);
    log(
      `  less the ERP's time: p50 ${erp.p50} ms, p95 ${erp.p95} ms (the ERP's own p95 ${erp.ownP95} ms; in all p95 ${erp.totalP95} ms)`,
    );
    if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
    return { browser: browser.version(), firstPaint, keys, erp };
  } catch (error) {
    const page = browser.contexts()[0]?.pages()[0];
    await page?.screenshot({ path: join(results, 'phase5-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

/** Opens the ERP page from another, `RUNS` times: to the table's first row, less the ERP's time. */
async function erpFirstPage(page, erpPage, otherPage) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    await page.evaluate((id) => (location.hash = `#/p/${id}`), otherPage);
    await page.locator('.cgw-page .cgw-editor').waitFor();
    await sleep(700);
    runs.push(
      await page.evaluate(
        ({ id, erp }) =>
          new Promise((resolve, reject) => {
            performance.clearResourceTimings();
            const started = performance.now();
            location.hash = `#/p/${id}`;
            const check = () => {
              const row = document.querySelector('[data-testid="erp-table"] tbody tr td');
              if (row?.textContent) {
                const ended = performance.now();
                // The union of the ERP's requests in flight between the two.
                const spans = performance
                  .getEntriesByType('resource')
                  .filter((e) => e.name.startsWith(erp) && e.startTime >= started - 1)
                  .map((e) => [
                    e.startTime,
                    Math.min(e.responseEnd || e.startTime + e.duration, ended),
                  ])
                  .sort((a, b) => a[0] - b[0]);
                let busy = 0;
                let reach = -Infinity;
                for (const [from, to] of spans) {
                  const begin = Math.max(from, reach);
                  if (to > begin) busy += to - begin;
                  reach = Math.max(reach, to);
                }
                return resolve({ total: ended - started, erp: busy, requests: spans.length });
              }
              if (performance.now() - started > 30000)
                return reject(new Error('No ERP rows in 30 s'));
              requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          }),
        { id: erpPage, erp: ERP_API },
      ),
    );
  }
  const left = runs.map((r) => r.total - r.erp);
  return {
    runs: runs.map((r) => ({ total: round(r.total), erp: round(r.erp), requests: r.requests })),
    p50: round(percentile(left, 0.5)),
    p95: round(percentile(left, 0.95)),
    ownP95: round(
      percentile(
        runs.map((r) => r.erp),
        0.95,
      ),
    ),
    totalP95: round(
      percentile(
        runs.map((r) => r.total),
        0.95,
      ),
    ),
  };
}

// ------------------------------------------------------------------ the desktop part
async function desktop(account, api) {
  const exe = join(root, 'target/release/cgw-desktop.exe');
  if (!existsSync(exe)) throw new Error('The desktop build is missing: run pnpm desktop:build.');
  const profile = mkdtempSync(join(tmpdir(), 'cgw-phase5-desktop-'));
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
  const authUrlFile = join(profile, 'authorize-url.txt');
  const child = spawn(exe, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview2'),
      CGW_DATA_DIR: join(profile, 'data'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs,
      CGW_AUTH_URL_FILE: authUrlFile,
      // A keychain name of its own: runs beside the e2e specs never share a sign-in.
      CGW_KEYCHAIN_SERVICE: `com.cashgear.workspace.bench.${basename(profile)}`,
    },
  });
  let app = null;
  let signer = null;
  try {
    await waitFor(`http://127.0.0.1:${port}/json/version`, 60000);
    app = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = app.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    await page.getByLabel('Workspace name').waitFor({ timeout: 60000 });
    // The probes (in every frame, the embed's too), then the app loaded again under them.
    await context.addInitScript(probes, SHEET);
    await page.reload();
    await page.getByLabel('Workspace name').waitFor({ timeout: 60000 });
    await page.getByLabel('Workspace name').fill('Desktop embeds');
    await page.keyboard.press('Enter');
    await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 60000 });
    signer = await chromium.launch({ channel: 'chrome' });
    await desktopSignIn(page, signer, authUrlFile, account);
    await page.getByRole('button', { name: 'Upload to my account' }).click();
    await page
      .getByTestId('sync-status')
      .filter({ hasText: /^Synced$/ })
      .waitFor({ timeout: 120000 });
    const workspaces = await api.get('/api/v1/workspaces');
    const workspaceId = workspaces.find((w) => w.name === 'Desktop embeds').id;
    log('Desktop: making the pages');
    const pages = await embedPages(page, api, workspaceId);
    log(`Desktop: the embed's first paint, ${RUNS} times`);
    await page.evaluate((id) => (location.hash = `#/p/${id}`), pages.far);
    await page.locator('.cgw-page .cgw-editor').waitFor();
    await sleep(1000);
    const firstPaint = await embedFirstPaint(page, !realSheet);
    log(`  p50 ${firstPaint.p50} ms, p95 ${firstPaint.p95} ms`);
    log('Desktop: typing between ten embeds');
    await page.evaluate((id) => (location.hash = `#/p/${id}`), pages.ten);
    const keys = await tenEmbeds(page);
    log(
      `  ${keys.embeds} live frames; ${keys.keys} keys: work p95 ${keys.workP95} ms, next frame p95 ${keys.frameP95} ms`,
    );
    // Signed out, so the test keychain name holds nothing.
    await page.evaluate(() => (location.hash = '#/settings'));
    await page
      .getByRole('button', { name: 'Sign out' })
      .click({ timeout: 15000 })
      .catch(() => {});
    await sleep(500);
    return { firstPaint, keys };
  } finally {
    await signer?.close().catch(() => {});
    await app?.close().catch(() => {});
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

// ------------------------------------------------------------------ main
mkdirSync(results, { recursive: true });
const out = {
  at: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? null,
  sheet: realSheet ? 'real' : 'mock',
  sheetOrigin: SHEET,
  machine: {
    cpu: cpus()[0]?.model?.trim() ?? null,
    threads: cpus().length,
    memoryGB: Math.round(totalmem() / 1073741824),
    os: `${process.platform} ${process.arch}`,
  },
};
const started = [];
const startIfMissing = async (url, what, command, commandArgs, options = {}) => {
  if (await answers(url)) return log(`Reusing ${what}`);
  log(`Starting ${what}`);
  started.push(spawn(command, commandArgs, { cwd: root, stdio: 'ignore', ...options }));
  await waitFor(url, options.waitMs ?? 60000);
};
try {
  if (!existsSync(join(root, 'apps/web/dist/index.html'))) throw new Error('Run pnpm build first.');
  await startIfMissing(
    `${API}/health/live`,
    'the server stack (scripts/server-stack.mjs --e2e)',
    process.execPath,
    [join(root, 'scripts/server-stack.mjs'), '--e2e'],
    { waitMs: 600000 },
  );
  await startIfMissing(
    APP,
    `vite preview on ${APP}`,
    process.execPath,
    [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview'],
    { cwd: join(root, 'apps/web') },
  );
  await startIfMissing(`${MOCK_SHEET}/__mock/state`, 'the mock Sheet', process.execPath, [
    join(root, 'tests/mocks/sheet/server.mjs'),
  ]);
  await startIfMissing(`${ERP_API}/__mock/state`, 'the mock ERP', process.execPath, [
    join(root, 'tests/mocks/erp/server.mjs'),
    '--workspace-url',
    'http://127.0.0.1:4273',
  ]);
  if (realSheet && !(await answers(`${SHEET}/embed`)))
    throw new Error(`--real-sheet: no Sheet preview on ${SHEET} (Sheet's hand-over says how)`);
  log(`Sheet: ${SHEET}${realSheet ? ' (real)' : ' (mock)'}`);
  const account = await newAccount('Phase 5 bench');
  const api = await apiSession(account);
  try {
    out.web = await web(account, api);
    if (withDesktop) out.desktop = await desktop(account, api);
  } finally {
    await api.dispose();
  }
} finally {
  for (const child of started.reverse()) stopTree(child);
}

const figures = {
  embedFirstPaintP95: out.web?.firstPaint?.p95,
  embedPictureP95: out.web?.firstPaint?.picture?.p95,
  key10EmbedsWorkP95: out.web?.keys?.workP95,
  key10EmbedsFrameP95: out.web?.keys?.frameP95,
  erpFirstPageP95: out.web?.erp?.p95,
  erpOwnTimeP95: out.web?.erp?.ownP95,
  erpTotalP95: out.web?.erp?.totalP95,
  embedFirstPaintDesktopP95: out.desktop?.firstPaint?.p95,
  key10EmbedsDesktopWorkP95: out.desktop?.keys?.workP95,
  key10EmbedsDesktopFrameP95: out.desktop?.keys?.frameP95,
};
const last = existsSync(previousFile) ? JSON.parse(readFileSync(previousFile, 'utf8')) : null;
const sameMachine = !!last && last.machine?.cpu === out.machine.cpu && last.sheet === out.sheet;
const previous = sameMachine ? (last.figures ?? null) : null;
const gate = [];
for (const [name, value] of Object.entries(figures)) {
  if (value === undefined || value === null) continue;
  const budget = BUDGETS[name];
  const before = previous?.[name];
  const overBudget = value > budget.max;
  const regressed =
    typeof before === 'number' && value > before * 1.5 && value - before > budget.slack;
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
// Ten live frames, or the keystroke figure means less than it says.
const tenLive = [out.web, out.desktop].filter(Boolean).every((part) => part.keys.embeds === 10);
out.figures = figures;
out.gate = gate;
writeFileSync(join(results, 'phase5.json'), JSON.stringify(out, null, 2) + '\n');
log('\nBudget                         value      budget   last main');
for (const g of gate)
  log(
    `${g.overBudget || g.regressed ? 'FAIL' : 'ok  '} ${g.name.padEnd(28)} ${String(g.value).padStart(7)} ${g.unit.padEnd(3)} ${String(g.budget ?? 'none').padStart(7)}   ${g.previous ?? '-'}${g.regressed ? '  (regressed)' : ''}`,
  );
if (!tenLive) log('FAIL fewer than ten live frames while typing');
if (!last) log('(No run on main to compare with: budgets only.)');
else if (!sameMachine)
  log(
    `(The last run on main ran on ${last.machine?.cpu ?? 'a processor it did not record'}${last.sheet !== out.sheet ? ` against the ${last.sheet} Sheet` : ''}, this one on ${out.machine.cpu}: budgets only.)`,
  );
process.exitCode = gate.some((g) => g.overBudget || g.regressed) || !tenLive ? 1 : 0;
