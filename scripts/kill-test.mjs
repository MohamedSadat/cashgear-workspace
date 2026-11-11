// The kill test (SYNC_DESIGN.md, "Tests that guard this design"): type into a page, kill the
// whole app at a random moment, reopen it, and check that nothing reported saved was lost and
// nothing appeared that was never typed. Run after run on the same profile, so each run also
// checks the one before.
//   node scripts/kill-test.mjs --target web|desktop [--runs 1000] [--out file]
// web: Chrome on the built app (`pnpm preview` on 4273, started if not running), killed with its
// whole process tree. desktop: target/release/cgw-desktop.exe with its own data folder.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { root } from './lib.mjs';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const target = arg('target', 'web');
const runs = Number(arg('runs', 25));
const out = arg('out', join(root, `bench/results/kill-${target}.json`));
const BASE = 'http://127.0.0.1:4273/';

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function waitFor(url, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + url);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Kills a process and every process it started, as a crash or a power cut would. */
function killTree(pid) {
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else process.kill(-pid, 'SIGKILL');
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);
  // Found by its file: on Windows `chrome.exe --version` starts the browser, which never exits
  // where no Chrome is running yet (CI run 43073289097 hung on it).
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return chromium.executablePath();
}

let preview = null;
async function ensurePreview() {
  try {
    await waitFor(BASE, 1500);
  } catch {
    preview = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['preview'], {
      cwd: root,
      shell: true,
      stdio: 'ignore',
    });
    await waitFor(BASE, 30000);
  }
}

const profile = mkdtempSync(join(tmpdir(), `cgw-kill-${target}-`));

// On GitHub-hosted runners the WebView2 host runs elevated and ignores the debugging switch from
// the environment; the documented HKLM policy, scoped to our executable, is set for the run and
// removed after (as scripts/desktop-smoke.mjs does).
const policyKey = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';
const hostedRunner =
  target === 'desktop' &&
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.RUNNER_ENVIRONMENT === 'github-hosted';
const reg = (args) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
const setPolicy = (port) =>
  hostedRunner &&
  reg([
    'add',
    policyKey,
    '/v',
    'cgw-desktop.exe',
    '/t',
    'REG_SZ',
    '/d',
    `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    '/f',
    '/reg:64',
  ]);

/** Starts the app on the profile and returns a page attached over CDP. */
async function launch() {
  const port = await freePort();
  let child;
  if (target === 'web') {
    child = spawn(
      chromePath(),
      [
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${join(profile, 'chrome')}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate',
        '--window-size=1200,800',
        BASE,
      ],
      { stdio: 'ignore', detached: process.platform !== 'win32' },
    );
  } else {
    setPolicy(port);
    child = spawn(join(root, 'target/release/cgw-desktop.exe'), [], {
      env: {
        ...process.env,
        CGW_DATA_DIR: join(profile, 'data'),
        WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview2'),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
      },
      stdio: 'ignore',
    });
  }
  await waitFor(`http://127.0.0.1:${port}/json/version`, 45000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().startsWith('http')) ?? context.pages()[0];
  if (!page) page = await context.waitForEvent('page');
  return { child, browser, page };
}

const words = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'كتاب',
  'قلم',
  'epsilon',
  'zeta',
  'مدرسة',
  'theta',
];
const random = (n) => Math.floor(Math.random() * n);

/** The first block's text and the save state, read in one turn of the page's event loop. */
const read = (page) =>
  page.evaluate(() => ({
    text: document.querySelector('.cgw-editor [data-block] > .cgw-body')?.textContent ?? null,
    state:
      document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state') ?? null,
  }));

const results = {
  target,
  runs: 0,
  failures: [],
  startedAt: new Date().toISOString(),
  savedChecks: 0,
  killsWhileSaving: 0,
  durableMs: [],
};
let saved = '';
let typed = '';

try {
  if (target === 'web') await ensurePreview();
  for (let run = 0; run < runs; run++) {
    const { child, browser, page } = await launch();
    try {
      if (run === 0) {
        if (target === 'web') await page.goto(BASE);
        await page.getByRole('button', { name: 'Create workspace' }).click();
        await page
          .getByRole('button', { name: /^Add a page in/ })
          .first()
          .click();
        // The new page is open once its title is empty (CI run 43083799788 typed into the page
        // before it).
        await page.waitForFunction(
          () => document.querySelector('textarea[aria-label="Page title"]')?.value === '',
          null,
          { timeout: 30000 },
        );
        await page.getByLabel('Page title').fill('Kill test');
        await page.keyboard.press('Enter');
      } else {
        // The app reopens on its first page; open ours by title.
        await page.getByRole('treeitem', { name: /Kill test/ }).click({ timeout: 30000 });
      }
      await page.locator('.cgw-editor').waitFor({ timeout: 30000 });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="save-status"]'),
        null,
        { timeout: 30000 },
      );
      const reopened = (await read(page)).text ?? '';
      // What was reported saved is there, and nothing that was never typed.
      if (!reopened.startsWith(saved) || !typed.startsWith(reopened))
        results.failures.push({ run, saved, typed, reopened });
      saved = reopened;
      typed = reopened;
      await page.locator('.cgw-editor [data-block] > .cgw-body').first().click();
      // The logical end of the text: End goes to the visual end, which in mixed Arabic and
      // English text is not where the text ends.
      await page.evaluate(() => {
        const body = document.querySelector('.cgw-editor [data-block] > .cgw-body .cgw-text');
        const range = document.createRange();
        range.selectNodeContents(body);
        range.collapse(false);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
      const killAt = Date.now() + 150 + random(1500);
      let killed = false;
      while (!killed) {
        const word = words[random(words.length)] + ' ';
        typed += word;
        await page.keyboard.type(word, { delay: random(3) ? 0 : 20 });
        let now = await read(page);
        if (random(3) === 0) {
          // A pause: the edit must be durable within a second of the last key (budget 1 s).
          const lastKey = Date.now();
          while (now.state !== 'saved' && Date.now() - lastKey < 2000) {
            await new Promise((r) => setTimeout(r, 25));
            now = await read(page);
          }
          if (now.state === 'saved') results.durableMs.push(Date.now() - lastKey);
          else results.failures.push({ run, error: 'not saved 2 s after the last key' });
        }
        if (now.state === 'saved' && now.text !== null) {
          saved = now.text;
          results.savedChecks++;
        }
        if (Date.now() >= killAt) {
          if (now.state === 'saving' || now.state === 'unsaved') results.killsWhileSaving++;
          killTree(child.pid);
          killed = true;
        }
      }
    } catch (error) {
      results.failures.push({ run, error: String(error).slice(0, 400) });
      killTree(child.pid);
      if (results.failures.length > 5) break;
    }
    await browser.close().catch(() => {});
    results.runs = run + 1;
    if ((run + 1) % 25 === 0)
      console.log(`${target}: ${run + 1} runs, ${results.failures.length} failures`);
  }
} finally {
  if (preview) killTree(preview.pid);
  if (hostedRunner) reg(['delete', policyKey, '/v', 'cgw-desktop.exe', '/f', '/reg:64']);
  results.finishedAt = new Date().toISOString();
  results.finalTextLength = typed.length;
  const sorted = [...results.durableMs].sort((a, b) => a - b);
  results.durable = {
    samples: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? null,
    max: sorted.at(-1) ?? null,
  };
  delete results.durableMs;
  mkdirSync(join(root, 'bench/results'), { recursive: true });
  writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify({ ...results, failures: results.failures.slice(0, 3) }, null, 2));
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
if (results.failures.length) process.exitCode = 1;
