// Phase 19's print spike in Chrome and Edge (`node bench/print-spike/run.mjs`): each engine's PDF
// of the print document (`Page.printToPDF`, the print preview's own pipeline), then the print
// dialog's path for real: `window.print()` with `--kiosk-printing` and "Save as PDF" as the
// remembered destination, which saves without a dialog. Both ways an app would print are tried: a
// frame of its own, and the app's own document with print media. Results to
// `bench/results/print-spike.json`. Spike code: it never ships.
import { mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { judge, readPdf } from './check.mjs';
import { SIZES, spikeFiles } from './pages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'package.json'));
const { chromium } = require('@playwright/test');
const work = join(root, 'target', 'print-spike');
const www = join(work, 'www');
rmSync(work, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
for (const [name, data] of Object.entries(spikeFiles())) writeFileSync(join(www, name), data);
// The WebView2 and WKWebView runs read the same pages from here.
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };
const server = createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
  try {
    const body = readFileSync(join(www, name));
    res.writeHead(200, { 'content-type': TYPES[extname(name)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(4293, '127.0.0.1', ok));
const base = 'http://127.0.0.1:4293';

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const results = { at: new Date().toISOString(), runs: [] };
const record = async (run, bytes) => {
  const read = await readPdf(bytes);
  const verdict = judge(read, run.size);
  results.runs.push({ ...run, ...verdict });
  console.log(
    `${run.engine} ${run.how} ${run.page}: ${verdict.pass ? 'pass' : 'FAIL'}`,
    JSON.stringify({ ...verdict, rowsSplit: verdict.rowsSplit.length }),
  );
  return read;
};

for (const channel of ['chrome', 'msedge']) {
  // 1. The engine's own PDF of the print document, and of the app printing itself.
  const browser = await chromium.launch({ channel });
  const page = await browser.newPage();
  for (const size of Object.keys(SIZES))
    for (const name of [`doc-${size}`, `main-${size}`, `main-fixed-${size}`, `paged-${size}`]) {
      await page.goto(`${base}/${name}.html`);
      await page.waitForFunction(() => [...document.images].every((i) => i.complete));
      const bytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      writeFileSync(join(work, `${channel}-pdf-${name}.pdf`), bytes);
      await record({ engine: channel, how: 'printToPDF', page: name, size }, bytes);
    }
  await browser.close();

  // 2. The print dialog's path: window.print() saved by kiosk printing to "Save as PDF".
  for (const headless of [true, false]) {
    const profile = join(work, `${channel}-profile-${headless ? 'headless' : 'headed'}`);
    const saved = join(work, `${channel}-saved-${headless ? 'headless' : 'headed'}`);
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
              isCssBackgroundEnabled: true,
            }),
          },
        },
        savefile: { default_directory: saved },
        download: { default_directory: saved, prompt_for_download: false },
      }),
    );
    const context = await chromium.launchPersistentContext(profile, {
      channel,
      headless,
      args: ['--kiosk-printing'],
    });
    const tab = context.pages()[0] ?? (await context.newPage());
    for (const size of Object.keys(SIZES))
      for (const name of [`frame-${size}`, `main-${size}`, `main-fixed-${size}`]) {
        for (const f of readdirSync(saved)) rmSync(join(saved, f), { force: true });
        await tab.goto(`${base}/${name}.html`);
        await tab.waitForFunction(() =>
          [
            ...document.images,
            ...(document.querySelector('iframe')?.contentDocument?.images ?? []),
          ].every((i) => i.complete),
        );
        // Read the file on every change in the folder: Edge writes it, then moves it away within
        // about 100 ms. The last whole read, once the folder has been quiet a second, is the PDF.
        let bytes = null;
        let changed = 0;
        const watcher = watch(saved, (_, file) => {
          changed = Date.now();
          if (!file?.endsWith('.pdf')) return;
          try {
            const now = readFileSync(join(saved, file));
            if (now.length > (bytes?.length ?? 0)) bytes = now;
          } catch {
            // Gone already: the read before this one holds it.
          }
        });
        const started = Date.now();
        await tab.evaluate(() => window.printView()).catch((error) => console.warn(String(error)));
        while (Date.now() - started < 20_000 && !(bytes && Date.now() - changed > 1000))
          await sleep(100);
        watcher.close();
        const run = {
          engine: channel,
          how: headless ? 'print() headless' : 'print() headed',
          page: name,
          size,
        };
        if (!bytes) {
          results.runs.push({ ...run, pass: false, saved: false });
          console.log(`${channel} ${run.how} ${name}: nothing saved`);
          continue;
        }
        writeFileSync(
          join(work, `${channel}-${headless ? 'kiosk' : 'kiosk-headed'}-${name}.pdf`),
          bytes,
        );
        await record(run, bytes);
      }
    await context.close();
  }
}
server.close();
mkdirSync(join(root, 'bench', 'results'), { recursive: true });
writeFileSync(join(root, 'bench', 'results', 'print-spike.json'), JSON.stringify(results, null, 1));
