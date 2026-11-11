// Spike S9: Cash Gear Sheet's deployed web app inside a sandboxed iframe, in Chrome and in
// WebView2, from a parent page shaped like Workspace's (no COEP) and from a cross-origin
// isolated parent, to see what cross-origin isolation the embed needs (Q4).
//   node bench/sheet-embed/run.mjs [sheet origin]
// Writes bench/results/s9-embed.json and a screenshot per case.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SHEET = process.argv[2] ?? 'https://proud-desert-008137810.4.azurestaticapps.net';

const parents = {
  // As Workspace serves its pages: no COEP, a CSP that allows only the Sheet origin to be framed.
  plain: {
    headers: {
      'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src ${SHEET}`,
    },
    iframe: `sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"`,
  },
  // A cross-origin isolated parent that delegates isolation to the frame.
  isolated: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src ${SHEET}`,
    },
    iframe: `sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" allow="cross-origin-isolated"`,
  },
};

const page = (
  kind,
) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>S9 ${kind}</title>
<style>body{margin:0;font-family:system-ui}iframe{width:1200px;height:700px;border:1px solid #888}</style></head>
<body><p id="top">Parent isolated: <span id="iso"></span></p>
<iframe id="sheet" title="Cash Gear Sheet" width="1200" height="700" ${parents[kind].iframe} src="${SHEET}/"></iframe>
<script>document.getElementById('iso').textContent = String(self.crossOriginIsolated);</script></body></html>`;

const server = createServer((req, res) => {
  const kind = req.url.slice(1).split('?')[0];
  if (!parents[kind]) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...parents[kind].headers });
  res.end(page(kind));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const freePort = () =>
  new Promise((done) => {
    const s = netServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

async function open(kind) {
  if (kind === 'chrome') {
    const browser = await chromium.launch({ channel: 'chrome' });
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    return { page: p, version: browser.version(), close: () => browser.close() };
  }
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'cgw-s9-webview2-'));
  const child = spawn(join(root, 'target/release/cgw-webview2-host.exe'), ['about:blank'], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 45000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch {
      /* starting */
    }
    if (Date.now() > deadline) throw new Error('WebView2 did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const p = browser.contexts()[0].pages()[0];
  return {
    page: p,
    version: browser.version(),
    close: async () => {
      await browser.close().catch(() => {});
      child.kill();
      await new Promise((r) => setTimeout(r, 1000));
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    },
  };
}

// A real workbook with values and formats, made by Sheet's own fixture code (read, not changed).
const fixtures = await import(
  new URL('file:///D:/CashGear/Projects/cashgear-sheet/tests/fixtures/workbooks.mjs').href
);
const workbook = join(mkdtempSync(join(tmpdir(), 'cgw-s9-book-')), 'formatting.xlsx');
writeFileSync(workbook, fixtures.formattingBook());

const results = { sheet: SHEET, workbook: 'formattingBook() from cashgear-sheet/tests/fixtures' };
mkdirSync(join(root, 'bench/results'), { recursive: true });
for (const browserKind of ['chrome', 'webview2']) {
  const opened = await open(browserKind);
  results[browserKind] = { version: opened.version };
  try {
    for (const parent of Object.keys(parents)) {
      const errors = [];
      const onConsole = (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200));
      opened.page.on('console', onConsole);
      await opened.page.goto(`${base}/${parent}`);
      const outcome = { parentIsolated: await opened.page.textContent('#iso') };
      try {
        const frame = await (async () => {
          const deadline = Date.now() + 30000;
          for (;;) {
            const found = opened.page.frames().find((f) => f.url().startsWith(SHEET));
            if (found) return found;
            if (Date.now() > deadline) return null;
            await new Promise((r) => setTimeout(r, 250));
          }
        })();
        outcome.frameLoaded = !!frame;
        if (frame) {
          // Open the workbook the way a user can inside a frame: drop it on Sheet's window. (Its
          // "Open" button uses the File System Access picker, which a cross-origin frame lacks.)
          await frame
            .getByText(/Open a workbook/)
            .first()
            .waitFor({ timeout: 30000 });
          await frame.evaluate((b64) => {
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const data = new DataTransfer();
            data.items.add(
              new File([bytes], 'formatting.xlsx', {
                type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              }),
            );
            const shell = document.querySelector('.cgs-shell');
            shell.dispatchEvent(
              new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }),
            );
            shell.dispatchEvent(
              new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
            );
          }, readFileSync(workbook).toString('base64'));
          await frame
            .waitForFunction(
              () =>
                document.querySelector('[data-testid="sheet-canvas"]')?.dataset.ready === 'true',
              null,
              { timeout: 60000 },
            )
            .then(() => (outcome.gridDrawn = true))
            .catch(() => (outcome.gridDrawn = false));
          Object.assign(
            outcome,
            await frame.evaluate(() => ({
              frameIsolated: self.crossOriginIsolated,
              sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
              engineStatus:
                document.querySelector('[data-testid="engine-status"]')?.textContent ?? null,
              sharedMemory:
                document.querySelector('.cgs-shell')?.getAttribute('data-shared-memory') ?? null,
              canvasSize: (() => {
                const c = document.querySelector('[data-testid="sheet-canvas"] canvas, canvas');
                return c ? `${c.width}x${c.height}` : null;
              })(),
            })),
          );
        }
      } catch (error) {
        outcome.error = String(error).slice(0, 300);
      }
      outcome.consoleErrors = errors.slice(0, 5);
      opened.page.off('console', onConsole);
      await opened.page.screenshot({
        path: join(root, `bench/results/s9-${browserKind}-${parent}.png`),
      });
      results[browserKind][parent] = outcome;
      console.log(browserKind, parent, JSON.stringify(outcome));
    }
  } finally {
    await opened.close();
  }
}
server.close();
writeFileSync(join(root, 'bench/results/s9-embed.json'), JSON.stringify(results, null, 2) + '\n');
const pass = ['chrome', 'webview2'].every((b) => results[b].plain?.gridDrawn);
console.log(
  pass
    ? 'S9: Sheet draws its grid inside an iframe on a page without COEP.'
    : 'S9: the embed did not draw.',
);
process.exit(pass ? 0 : 1);
