// Phase 8's import budget (IMPLEMENTATION_PLAN.md, Phase 8, Performance benchmarks): a 1,000-page
// Notion export imported on the device ≤ 60 s, the uploads apart. A piece of `bench/phase8.mjs`,
// which the parent runs (written, not run, by stream C):
//
//   import { measureImport, IMPORT_BUDGET } from './phase8-import.mjs';
//   const figures = await measureImport(page, { app: 'http://127.0.0.1:4273', runs: 3 });
//
// `page` is a Playwright page of the built web app under `vite preview` (or the desktop app's
// window over CDP), on a fresh profile. The first run makes a local workspace (so nothing is
// uploaded: the uploads are apart by construction); each run then imports into it (every import
// goes under a new page of its own), opening Settings → Your data → Import from
// Markdown, Notion or Word, chooses "A Notion export" and hands it the export made by
// `largeNotionExport(1000)` (packages/shell/src/exchange/fixtures/fixtures.ts, made by code). The
// figure is from the file handed to the panel to its report drawn (reading, planning in the
// worker, writing every page, row, asset and document through the session), and its two parts:
// reading (to the first "Writing" status) and writing (from there to the report). The report's
// page count is checked against the export's. Returns the p50 and the worst of the runs.
import { largeNotionExport } from '../packages/shell/src/exchange/fixtures/fixtures.ts';

export const IMPORT_BUDGET = { notion1000Ms: { max: 60_000, unit: 'ms', slack: 5_000 } };

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};

/** One import of the export, timed in the page; the panel's status changes are recorded there. */
async function oneRun(page, app, fixture, run) {
  await page.goto(`${app}/`);
  if (run === 0) {
    await page.getByLabel('Workspace name').fill('Import bench');
    await page.keyboard.press('Enter');
    await page.locator('.cgw-editor').first().waitFor();
  }
  await page.goto(`${app}/#/settings`);
  await page.getByRole('button', { name: 'Import from Markdown, Notion or Word' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import pages' });
  await dialog.getByRole('radio', { name: /^A Notion export/ }).check();
  await page.evaluate(() => {
    const marks = (window.__importMarks = {});
    const observer = new MutationObserver(() => {
      const panel = document.querySelector('[data-testid="import-panel"]');
      const text = panel?.textContent ?? '';
      if (!marks.writing && /Writing the pages/.test(text)) marks.writing = performance.now();
      if (!marks.report && panel?.querySelector('[data-testid="import-report"]')) {
        marks.report = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    const input = document.querySelector('[data-testid="import-file"]');
    input.addEventListener('change', () => (marks.start = performance.now()), {
      once: true,
      capture: true,
    });
  });
  await dialog.getByTestId('import-file').setInputFiles({
    name: fixture.name,
    mimeType: 'application/zip',
    buffer: Buffer.from(fixture.bytes),
  });
  await page.getByTestId('import-report').waitFor({ timeout: 180_000 });
  const marks = await page.evaluate(() => window.__importMarks);
  const pages = Number(
    /Pages: (\d+)/.exec(await page.getByTestId('import-report').innerText())?.[1] ?? 0,
  );
  const rows = Number(
    /Rows: (\d+)/.exec(await page.getByTestId('import-report').innerText())?.[1] ?? 0,
  );
  return {
    totalMs: marks.report - marks.start,
    readingMs: (marks.writing ?? marks.report) - marks.start,
    writingMs: marks.report - (marks.writing ?? marks.start),
    // Pages, databases and rows the report says were made (the database is one).
    made: pages + rows + 1,
  };
}

/**
 * The import budget's figures over `runs` runs: total, reading and writing (p50 and worst), and
 * whether every run made the export's pages.
 */
export async function measureImport(
  page,
  { app = 'http://127.0.0.1:4273', runs = 3, pages = 1000, log = console.log } = {},
) {
  const fixture = largeNotionExport(pages);
  log(
    `Import: a Notion export of ${fixture.pages} pages, ${Math.round(fixture.bytes.length / 1024)} KB zipped`,
  );
  const results = [];
  for (let run = 0; run < runs; run++) {
    const result = await oneRun(page, app, fixture, run);
    log(
      `  run ${run + 1}: ${Math.round(result.totalMs)} ms (reading ${Math.round(result.readingMs)}, writing ${Math.round(result.writingMs)}), ${result.made} pages made`,
    );
    results.push(result);
  }
  const of = (key) => ({
    p50: Math.round(
      percentile(
        results.map((r) => r[key]),
        0.5,
      ),
    ),
    max: Math.round(Math.max(...results.map((r) => r[key]))),
  });
  return {
    pages: fixture.pages,
    allMade: results.every((r) => r.made === fixture.pages),
    notion1000Ms: of('totalMs'),
    readingMs: of('readingMs'),
    writingMs: of('writingMs'),
  };
}
