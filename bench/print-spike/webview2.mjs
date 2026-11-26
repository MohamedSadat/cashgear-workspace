// Phase 19's print spike in WebView2 (`node bench/print-spike/webview2.mjs`, after `run.mjs` has
// written the pages and `cargo build -p cgw-webview2-host`): WebView2's own `PrintToPdf`, with no
// dialog, over the same pages, its print settings' page size and orientation from the layout and
// its margins either the layout's or none (the page's `@page` margin then). Results to
// `bench/results/print-spike-webview2.json`. Spike code: it never ships.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { judge, readPdf } from './check.mjs';
import { SIZES } from './pages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = join(root, 'target', 'print-spike');
const host = join(root, 'target', 'debug', 'cgw-webview2-host.exe');
const results = { at: new Date().toISOString(), runs: [] };
const FLAGS = {
  'a4-portrait': ['--page', 'a4'],
  'letter-landscape': ['--page', 'letter', '--landscape'],
};
for (const size of Object.keys(SIZES))
  for (const name of [`doc-${size}`, `frame-${size}`, `main-${size}`, `main-fixed-${size}`])
    for (const margins of ['settings', 'css']) {
      const out = join(work, `webview2-${name}-${margins}.pdf`);
      rmSync(out, { force: true });
      const url = pathToFileURL(join(work, 'www', `${name}.html`)).href;
      const args = [
        url,
        '--pdf',
        out,
        ...FLAGS[size],
        ...(margins === 'css' ? ['--css-margins'] : []),
      ];
      const started = Date.now();
      const run = spawnSync(host, args, { encoding: 'utf8', timeout: 60_000 });
      const record = {
        engine: 'webview2',
        how: `PrintToPdf, ${margins} margins`,
        page: name,
        size,
      };
      if (!existsSync(out)) {
        results.runs.push({
          ...record,
          pass: false,
          saved: false,
          stdout: run.stdout,
          stderr: run.stderr,
        });
        console.log(`webview2 ${name} ${margins}: nothing saved`, run.stderr?.slice(0, 200));
        continue;
      }
      const verdict = judge(await readPdf(readFileSync(out)), size);
      results.runs.push({ ...record, ...verdict, ms: Date.now() - started });
      console.log(
        `webview2 ${name} ${margins}: ${verdict.pass ? 'pass' : 'FAIL'}`,
        JSON.stringify({ ...verdict, rowsSplit: verdict.rowsSplit.length }),
      );
    }
mkdirSync(join(root, 'bench', 'results'), { recursive: true });
writeFileSync(
  join(root, 'bench', 'results', 'print-spike-webview2.json'),
  JSON.stringify(results, null, 1),
);
