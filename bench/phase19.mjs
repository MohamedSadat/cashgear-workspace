// Phase 19's budgets (IMPLEMENTATION_PLAN.md, Phase 19, Performance benchmarks), measured and gated:
//   pnpm bench:phase19    in Chrome against the web app under vite preview on 127.0.0.1:4273
//                         (reused when it answers, else started here; needs `pnpm build`)
// No server: the workspace is on the device, as a Word file and a print are made on it.
//
// The page: 2,000 blocks (headings, paragraphs in English and Arabic, bulleted, numbered and check
// lists, quotes, code, tables of four rows), 20 pictures (600 × 400 PNGs, each its own colour,
// pasted as files) and a database block showing a database of 1,000 rows imported from a CSV.
// The figures:
//   - Export to Word: from the menu's click to the file's download, while keys are typed on another
//     page of the same tab at a key every 35 ms (the export goes on when the page is left): budget
//     3 s; the keys held to Phase 1's budget there (keydown to the end of the editor's transaction
//     p95 8 ms, 16 on CI's runner), and, after 0.19.0, their next frame p95 to a frame (33 ms), the
//     page read in the export's worker. The keys type one sentence on through every run, a word
//     at a time, so no run leaves half a word or starts inside one: Chrome's first spelling mark
//     (its wavy line) took the GPU process up to about 300 ms once, holding every frame of the tab
//     while nothing ran on the page;
//   - Print: from the menu's click to `window.print()` being called with the print view laid out
//     (its pictures loaded), which opens the print dialog: budget 3 s; and, tracked, from the click
//     to the PDF the dialog's "Save as PDF" printer wrote (Chrome headed with `--kiosk-printing`:
//     the whole print of the page's pages, which the dialog's preview does as it opens).
// Each run is the median of three after a first, which is tracked. Each figure is checked against
// its budget and, when bench/previous/phase19.json holds the last run on main on the same processor
// (CI downloads it), against that: worse by half again and by more than a small margin fails.
// Writes bench/results/phase19.json.
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import { png } from './print-spike/pages.mjs';
import { bigContent } from './phase19-page.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const APP = 'http://127.0.0.1:4273';
const previousFile = join(root, 'bench/previous/phase19.json');
const results = join(root, 'bench/results');
const log = (line) => console.log(line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Math.round(n * 10) / 10;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};

const KEY_WORK_MAX = process.env.CI ? 16 : 8;
const BUDGETS = {
  wordMs: { max: 3000, unit: 'ms', slack: 300 },
  wordKeyWorkP95: { max: KEY_WORK_MAX, unit: 'ms', slack: 2 },
  // A key's next frame on the other page while the export runs (after 0.19.0: until then the
  // page's document was read on the main thread, and a key could wait 80 ms and more for it).
  wordKeyFrameP95: { max: 33, unit: 'ms', slack: 10 },
  // The print view laid out and `window.print()` called, which opens the dialog.
  printReadyMs: { max: 3000, unit: 'ms', slack: 300 },
  // Tracked, not budgeted: the whole print to the dialog's "Save as PDF" printer, the PDF written.
  printPdfMs: { max: Infinity, unit: 'ms', slack: 500 },
  wordFirstMs: { max: Infinity, unit: 'ms', slack: 500 },
  printPdfFirstMs: { max: Infinity, unit: 'ms', slack: 500 },
};

async function answers(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ the page
const COLOURS = Array.from({ length: 20 }, (_, i) => [
  (i * 37) % 256,
  (i * 91) % 256,
  (i * 53) % 256,
]);

/** A Chrome page with a local workspace: a database of 1,000 rows, and the big page open. */
async function seed(page) {
  await page.goto(`${APP}/`);
  await page.getByLabel('Workspace name').fill('Phase 19');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.locator('.cgw-editor').waitFor();
  // The other page, typed into while the file is written; then the big page.
  const newPage = async (title) => {
    const before = new URL(page.url()).hash;
    await page
      .getByRole('button', { name: /^Add a page in/ })
      .first()
      .click();
    await page.waitForFunction((hash) => location.hash !== hash, before);
    const field = page.getByLabel('Page title');
    for (let i = 0; i < 100 && (await field.inputValue()) !== ''; i++) await sleep(100);
    await page.getByLabel('Page title').fill(title);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.closest('.cgw-page .cgw-editor'));
    return new URL(page.url()).hash.match(/#\/p\/([0-9a-f-]{36})/)[1];
  };
  const typingId = await newPage('Typing');
  const bigId = await newPage('Big');
  // The database: 1,000 rows from a CSV, as a person imports one.
  const csv = ['Name,Amount,Due,Done,Kind'];
  for (let i = 1; i <= 1000; i++)
    csv.push(
      `Item ${i},${i * 3},2026-12-${String((i % 28) + 1).padStart(2, '0')},${i % 2 === 0},${['Hardware', 'Supplies', 'Services'][i % 3]}`,
    );
  await page.locator('[data-action="new-database"]').first().click();
  await page
    .getByRole('menuitem', { name: 'Import a CSV file as a new database', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Import CSV' });
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose a CSV file' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'Inventory.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`${csv.join('\r\n')}\r\n`),
  });
  await dialog.getByText(/Inventory.csv: 1,?000 rows/).waitFor({ timeout: 60000 });
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await dialog.getByText(/Imported rows: 1,?000/).waitFor({ timeout: 120000 });
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  const databaseId = new URL(page.url()).hash.match(/#\/p\/([0-9a-f-]{36})/)[1];
  // Back to the big page, its editor focused at its start.
  await page.evaluate((id) => (location.hash = `#/p/${id}`), bigId);
  await page.locator('.cgw-page .cgw-editor').click();
  await page.waitForFunction(() => document.activeElement?.closest('.cgw-page .cgw-editor'));
  // The page's content in one of the editor's transactions (a paste of so many blocks inserts
  // nothing, a follow-up of its own), the database block first, an empty line last.
  const content = [
    ...bigContent(databaseId),
    { type: 'block', content: [{ type: 'textBody', attrs: { kind: 'paragraph' } }] },
  ];
  await page.evaluate((content) => {
    const view = document.querySelector('.cgw-page .ProseMirror').editor.view;
    const doc = view.state.schema.nodeFromJSON({ type: 'doc', content });
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
  }, content);
  await page.waitForFunction(
    () =>
      (document.querySelector('.cgw-page .ProseMirror')?.editor?.state.doc.childCount ?? 0) >= 2000,
  );
  const atEnd = () => page.keyboard.press('Control+End');
  // 20 pictures, pasted as files at the end.
  for (const [i, colour] of COLOURS.entries()) {
    await atEnd();
    const bytes = [...png(600, 400, colour)];
    await page.locator('.cgw-page .cgw-editor').evaluate(
      (root, { bytes, name }) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
        root.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      },
      { bytes, name: `picture-${i + 1}.png` },
    );
  }
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '.cgw-page .cgw-editor img:not(.ProseMirror-separator):not([hidden])',
      ).length >= 20,
    null,
    { timeout: 120000 },
  );
  await page
    .getByTestId('save-status')
    .filter({ hasText: 'Saved' })
    .waitFor({ timeout: 60000 })
    .catch(() => undefined);
  await sleep(2000);
  return { databaseId, typingId, bigId };
}

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
    if (view.__watched === view.editor) return true;
    view.__watched = view.editor;
    view.editor.on('transaction', ({ transaction }) => {
      if (start === null || !transaction.docChanged) return;
      window.__keys.work.push(performance.now() - start);
      start = null;
    });
    return true;
  };
}

/** The sentence the keys type a word at a time, carried on from run to run: no word is cut. */
const WORDS = 'the quick brown fox jumps over the lazy dog '.split(/(?<= )/);
let typed = 0;

const menu = async (page, item) => {
  await page.locator('.cgw-topbar').getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
};

/** Export to Word, timed to the download, with keys typed on the other page meanwhile. */
async function word(page, ids) {
  await page.evaluate((id) => (location.hash = `#/p/${id}`), ids.bigId);
  await page.locator('.cgw-page .cgw-editor').waitFor();
  await page.evaluate(probes);
  const download = page.waitForEvent('download', { timeout: 120000 });
  const clicked = Date.now();
  await menu(page, 'Export to Word');
  // Leave for the other page once the dialog says it is preparing the page (its chunk loaded),
  // and type there until the file is saved.
  await page.getByTestId('out-dialog').waitFor({ timeout: 30000 });
  await page.evaluate((id) => (location.hash = `#/p/${id}`), ids.typingId);
  const editor = page.locator('.cgw-page .ProseMirror');
  await editor.waitFor();
  await editor.click();
  // At the end of what earlier runs typed, so the sentence goes on whole.
  await page.keyboard.press('Control+End');
  await page.waitForFunction(() => window.__watchEditor?.());
  await page.evaluate(() => {
    window.__keys.frame.length = 0;
    window.__keys.work.length = 0;
  });
  let saved = null;
  void download.then(() => (saved = Date.now()));
  while (saved === null && Date.now() - clicked < 60000)
    await page.keyboard.type(WORDS[typed++ % WORDS.length], { delay: 35 });
  const file = await download;
  const bytes = readFileSync(await file.path());
  // The file holds the page: every row of the database's table and every picture.
  const { unzipSync, strFromU8 } = createRequire(join(root, 'packages/shell/package.json'))(
    'fflate',
  );
  const parts = unzipSync(new Uint8Array(bytes));
  const rows = (strFromU8(parts['word/document.xml']).match(/<w:tr>/g) ?? []).length;
  const pictures = Object.keys(parts).filter((p) => p.startsWith('word/media/')).length;
  if (rows < 1000 || pictures < 20)
    throw new Error(`The Word file holds ${rows} table rows and ${pictures} pictures`);
  const keys = await page.evaluate(() => window.__keys);
  return { ms: saved - clicked, bytes: bytes.length, keys };
}

/** Print in the headless page: from the click to `window.print()`, the view laid out. */
async function printCalled(page, ids) {
  await page.evaluate((id) => (location.hash = `#/p/${id}`), ids.bigId);
  await page.locator('.cgw-page .cgw-editor').waitFor();
  await page.evaluate(() => {
    window.__printed = null;
    window.print = () => {
      // The view's own layout, as print media would make it: its pages and their pictures.
      const root = document.querySelector('.cgw-print-root');
      root.style.display = 'block';
      void root.getBoundingClientRect().height;
      window.__printed = performance.now();
      root.style.display = '';
      dispatchEvent(new Event('afterprint'));
    };
  });
  const clicked = await page.evaluate(() => performance.now());
  await menu(page, 'Print…');
  await page.waitForFunction(() => window.__printed !== null, null, { timeout: 60000 });
  return (await page.evaluate(() => window.__printed)) - clicked;
}

/** Print for real: the print dialog's "Save as PDF" printer saves it, timed to the file. */
async function printPdf(page, ids, saved) {
  await page.evaluate((id) => (location.hash = `#/p/${id}`), ids.bigId);
  await page.locator('.cgw-page .cgw-editor').waitFor();
  for (const f of readdirSync(saved)) rmSync(join(saved, f), { force: true });
  let bytes = 0;
  let wrote = null;
  const watcher = watch(saved, (_, file) => {
    if (!file?.endsWith('.pdf')) return;
    try {
      const size = statSync(join(saved, file)).size;
      if (size > bytes) {
        bytes = size;
        wrote = Date.now();
      }
    } catch {
      // Moved away (Edge does): the size before holds.
    }
  });
  const clicked = Date.now();
  await menu(page, 'Print…');
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !(wrote && Date.now() - wrote > 1000)) await sleep(50);
  watcher.close();
  if (!wrote) throw new Error('Nothing was printed');
  return { ms: wrote - clicked, bytes };
}

// ------------------------------------------------------------------ main
mkdirSync(results, { recursive: true });
const out = {
  at: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? null,
  machine: {
    cpu: cpus()[0]?.model?.trim() ?? null,
    threads: cpus().length,
    memoryGB: Math.round(totalmem() / 1073741824),
    os: `${process.platform} ${process.arch}`,
  },
};
let preview = null;
try {
  if (!existsSync(join(root, 'apps/web/dist/index.html'))) throw new Error('Run pnpm build first.');
  if (!(await answers(APP))) {
    log(`Starting vite preview on ${APP}`);
    preview = spawn(
      process.execPath,
      [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview'],
      {
        cwd: join(root, 'apps/web'),
        stdio: 'ignore',
      },
    );
    for (let i = 0; i < 100 && !(await answers(APP)); i++) await sleep(300);
  } else log(`Reusing ${APP}`);

  // A headed Chrome that prints with no dialog: "Save as PDF" remembered, `--kiosk-printing`.
  const profile = join(root, 'target/phase19-bench/profile');
  const saved = join(root, 'target/phase19-bench/saved');
  rmSync(join(root, 'target/phase19-bench'), { recursive: true, force: true });
  mkdirSync(join(profile, 'Default'), { recursive: true });
  mkdirSync(saved, { recursive: true });
  writeFileSync(
    join(profile, 'Default', 'Preferences'),
    JSON.stringify({
      printing: {
        print_preview_sticky_settings: {
          appState: JSON.stringify({
            recentDestinations: [{ id: 'Save as PDF', origin: 'local', account: '' }],
            selectedDestinationId: 'Save as PDF',
            version: 2,
            isHeaderFooterEnabled: false,
          }),
        },
      },
      savefile: { default_directory: saved },
      download: { default_directory: saved, prompt_for_download: false },
    }),
  );
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: false,
    args: ['--kiosk-printing'],
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const errors = [];
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('pageerror', (error) => errors.push(error.message));
    page.on(
      'console',
      (m) =>
        m.type() === 'error' &&
        !/ERR_CONNECTION|Failed to load/.test(m.text()) &&
        log(`  console: ${m.text().slice(0, 300)}`),
    );
    log('Seeding: a database of 1,000 rows and a page of 2,000 blocks and 20 pictures');
    const ids = await seed(page);
    log('Export to Word, typing on another page');
    const words = [];
    for (let run = 0; run < 4; run++) {
      const result = await word(page, ids);
      log(
        `  ${result.ms} ms, ${Math.round(result.bytes / 1024)} kB; ${result.keys.frame.length} keys: work p95 ${round(percentile(result.keys.work, 0.95))} ms, frame p95 ${round(percentile(result.keys.frame, 0.95))} ms`,
      );
      words.push(result);
    }
    const measured = words.slice(1);
    out.word = {
      firstMs: words[0].ms,
      ms: median(measured.map((w) => w.ms)),
      kB: Math.round(words[0].bytes / 1024),
      keyWorkP95: round(
        percentile(
          measured.flatMap((w) => w.keys.work),
          0.95,
        ),
      ),
      keyFrameP95: round(
        percentile(
          measured.flatMap((w) => w.keys.frame),
          0.95,
        ),
      ),
      keys: measured.reduce((n, w) => n + w.keys.frame.length, 0),
    };
    log('Print, saved by the print dialog’s "Save as PDF" printer');
    const pdfs = [];
    for (let run = 0; run < 4; run++) {
      const printed = await printPdf(page, ids, saved);
      log(`  ${printed.ms} ms, ${Math.round(printed.bytes / 1024)} kB`);
      pdfs.push(printed);
    }
    out.printPdf = {
      firstMs: pdfs[0].ms,
      ms: median(pdfs.slice(1).map((p) => p.ms)),
      kB: Math.round(pdfs[0].bytes / 1024),
    };
    log('Print: to window.print() with the view laid out');
    const called = [];
    for (let run = 0; run < 4; run++) called.push(await printCalled(page, ids));
    out.printCalled = { firstMs: round(called[0]), ms: round(median(called.slice(1))) };
    log(`  ${called.map((n) => Math.round(n)).join(', ')} ms`);
    if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
  } finally {
    await context.close();
  }
} finally {
  if (preview && process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(preview.pid), '/T', '/F'], { windowsHide: true });
}

// ------------------------------------------------------------------ the gate
const figures = {
  wordMs: out.word?.ms,
  wordKeyWorkP95: out.word?.keyWorkP95,
  wordKeyFrameP95: out.word?.keyFrameP95,
  printPdfMs: out.printPdf?.ms,
  printReadyMs: out.printCalled?.ms,
  wordFirstMs: out.word?.firstMs,
  printPdfFirstMs: out.printPdf?.firstMs,
};
const previous = existsSync(previousFile) ? JSON.parse(readFileSync(previousFile, 'utf8')) : null;
const failures = [];
for (const [name, value] of Object.entries(figures)) {
  if (value === undefined || value === null) continue;
  const budget = BUDGETS[name];
  if (value > budget.max)
    failures.push(`${name} ${value} ${budget.unit} over its budget of ${budget.max}`);
  const before = previous?.machine?.cpu === out.machine.cpu ? previous?.figures?.[name] : undefined;
  if (typeof before === 'number' && value > before * 1.5 && value - before > budget.slack)
    failures.push(`${name} ${value} ${budget.unit}, was ${before}`);
}
out.figures = figures;
out.failures = failures;
writeFileSync(join(results, 'phase19.json'), JSON.stringify(out, null, 1));
log(JSON.stringify(figures));
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
