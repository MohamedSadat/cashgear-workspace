// The kill test (SYNC_DESIGN.md, "Tests that guard this design"): type into a page, kill the
// whole app at a random moment, reopen it, and check that nothing reported saved was lost and
// nothing appeared that was never typed. Run after run on the same profile, so each run also
// checks the one before.
//   node scripts/kill-test.mjs --target web|desktop [--runs 1000] [--out file] [--kill immediate|tree]
//   node scripts/kill-test.mjs --target web|desktop --sync [--runs 1000] [--check-every 25]
// web: Chrome on the built app (`pnpm preview` on 4273, started if not running). desktop:
// target/release/cgw-desktop.exe with its own data folder. A kill is TerminateProcess on the
// process that holds the store (Chrome's browser process, cgw-desktop.exe), at once, as a crash or
// a power cut would; the rest of its process tree goes after (found by parent id), before the app
// starts again. `--kill tree` is Phase 1's kill instead: taskkill over the whole tree. Chrome
// itself sometimes loses a whole session's completed IndexedDB transactions when only its browser
// process is ended at once (seen in a page that writes nothing but a counter, with either
// durability), so in the browser `--kill tree` is the default; the desktop's store is SQLite in
// the app's own process, and its default is the immediate kill.
//
// --sync (Phase 3, "1,000 random kills during sync lose nothing that was reported saved"): the
// same, signed in to the e2e server stack (scripts/server-stack.mjs --e2e, started if not running)
// with the page in a synced workspace, so kills land while pushes, pulls and feed reads are in
// flight (counted from the page's requests). Some runs have the API cut off (blocked through CDP)
// from the start, for one to three runs, and some lose it in the middle of typing; the next runs
// have it back. Every --check-every runs, and after the last, the reopened app must say "Synced"
// and the server's text of the page (the worker's derived JSON) must equal the device's exactly:
// nothing lost, nothing doubled. Results: bench/results/kill-sync-{web,desktop}.json.
//
// Kills during local compaction (both modes): the store's compaction is watched (in the browser
// the IndexedDB transaction only compactDoc opens, from the page; on the desktop the `compactDoc`
// frame its window sends to the native store, seen over CDP), and on most runs a compaction that
// starts is the kill's moment. In the browser the compaction's transaction is held open for a
// random 150 to 400 ms first (more requests on it: a slow disk), so the kill lands before it
// commits; on the desktop the kill follows the request within a few milliseconds. After such a
// kill the store is read (IndexedDB from the reopened page, SQLite through cgw-store-cli before
// the app starts again) to tell a compaction rolled back from one committed. The app compacts a
// page's log after 200 saved updates; `cgw-test:compactAfter` in localStorage (--compact-after,
// default 8) asks for it sooner, where the build reads that test-only setting. With
// --until-compaction every run saves word by word until a compaction starts and is killed in it
// (bench/results/kill-compaction-{web,desktop}.json).
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { root } from './lib.mjs';
import {
  API,
  apiSession,
  desktopSignIn,
  newAccount,
  serverDoc,
  signInPage,
} from './cloud-account.mjs';
import { openStoreCli } from './store-cli.mjs';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const target = arg('target', 'web');
const runs = Number(arg('runs', 25));
const sync = process.argv.includes('--sync');
const checkEvery = Number(arg('check-every', 25));
const offlineEvery = Number(arg('offline-every', 12));
const compactAfter = Number(arg('compact-after', 8));
// Every run types, saving each word, until a compaction starts, and is killed during it.
const untilCompaction = process.argv.includes('--until-compaction');
const killHow = arg('kill', target === 'web' ? 'tree' : 'immediate');
const out = arg(
  'out',
  join(
    root,
    `bench/results/kill-${untilCompaction ? 'compaction-' : sync ? 'sync-' : ''}${target}.json`,
  ),
);
const BASE = 'http://127.0.0.1:4273/';
// Every failure in full as it happens, beside the results (the console shows the start of it).
const failuresFile = out.replace(/\.json$/, '') + '.failures.jsonl';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(150);
  }
}

/** Kills a process and every process it started. */
function killTree(pid) {
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  else
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* gone */
    }
}

/**
 * The kill: TerminateProcess on the process that holds the store, now (process.kill is that on
 * Windows; taskkill takes tens of milliseconds to start), then whatever is left of its tree.
 */
function kill(child) {
  // --kill tree: Phase 1's way, taskkill over the whole tree, which takes some tens of
  // milliseconds to reach the process that holds the store.
  if (killHow === 'tree') return killTree(child.pid);
  try {
    process.kill(child.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  // Its children outlive it for a while (Chrome's utility processes hold the profile's
  // IndexedDB open): ended too, found by the parent id Windows keeps for an orphan, before the
  // app is started again, as a restart after a crash finds them gone.
  if (process.platform === 'win32')
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId; function Kids($id) { foreach ($p in $all) { if ($p.ParentProcessId -eq $id -and $p.ProcessId -ne $id) { $p.ProcessId; Kids $p.ProcessId } } }; Kids ${child.pid} | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`,
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
  else killTree(child.pid);
}

const profile = mkdtempSync(join(tmpdir(), `cgw-kill-${sync ? 'sync-' : ''}${target}-`));
const tag = basename(profile);

/** Ends any process of this test's profile still running (children orphaned by a kill). */
function sweep() {
  if (process.platform !== 'win32') return;
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${tag}*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
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

const started = [];
async function ensurePreview() {
  try {
    await waitFor(BASE, 1500);
  } catch {
    started.push(
      spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['preview'], {
        cwd: root,
        shell: true,
        stdio: 'ignore',
      }),
    );
    await waitFor(BASE, 30000);
  }
}

async function ensureServer() {
  try {
    await waitFor(`${API}/health/live`, 1500);
    console.log(`Reusing the server stack on ${API}`);
  } catch {
    console.log('Starting the server stack (scripts/server-stack.mjs --e2e)');
    started.push(
      spawn(process.execPath, [join(root, 'scripts/server-stack.mjs'), '--e2e'], {
        cwd: root,
        stdio: 'ignore',
      }),
    );
    await waitFor(`${API}/health/live`, 600000);
  }
}

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

const authUrlFile = join(profile, 'authorize-url.txt');
const dataDir = join(profile, 'data');

/**
 * Watches the browser's local store for compaction (a test probe; the app is not changed): the
 * IndexedDB transaction only compactDoc opens (read-write over exactly these four stores), held
 * open for `hold` ms when set. Each start is told to Node through the `__cgwProbe` binding. (The
 * desktop's store requests are watched from Node instead: `watchDesktopStore`.)
 */
function probe() {
  if (window.__cgwKill) return;
  const state = (window.__cgwKill = { compactions: 0, compacting: 0, hold: 0 });
  const tell = (event) => {
    try {
      window.__cgwProbe?.(event);
    } catch {
      /* no binding yet */
    }
  };
  if (typeof IDBDatabase !== 'undefined') {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
      const tx = transaction.call(this, names, mode, ...rest);
      const list = (typeof names === 'string' ? [names] : [...names]).sort().join(',');
      if (mode === 'readwrite' && list === 'docLogs,docUpdates,pages,workspaces') {
        state.compactions++;
        state.compacting++;
        const hold = state.hold;
        const begun = performance.now();
        let open = true;
        const end = () => {
          if (open) state.compacting--;
          open = false;
        };
        tx.addEventListener('complete', () => {
          end();
          tell({ kind: 'compactionDone' });
        });
        tx.addEventListener('abort', end);
        // The log record it writes says what it covers (the judgement after a kill).
        const objectStore = tx.objectStore.bind(tx);
        tx.objectStore = (name) => {
          const store = objectStore(name);
          if (name === 'docLogs' && !store.cgwWatched) {
            const put = store.put.bind(store);
            store.put = (value, ...more) => {
              if (typeof value?.snapshotCovers === 'number')
                tell({ kind: 'compactionCovers', covers: value.snapshotCovers });
              return put(value, ...more);
            };
            store.cgwWatched = true;
          }
          return store;
        };
        tell({ kind: 'compaction', hold });
        if (hold > 0) {
          // More requests on the same transaction keep it from committing: a slow disk.
          const logs = tx.objectStore('docLogs');
          const keep = () => {
            if (!open || performance.now() - begun >= hold) return;
            try {
              logs.get('cgw-kill-hold').onsuccess = keep;
            } catch {
              /* finished */
            }
          };
          keep();
        }
      }
      return tx;
    };
  }
}

/**
 * The desktop's store requests, from Node: Tauri sends each `store` frame as the body of a request
 * to http://ipc.localhost/store, which CDP shows. A `compactDoc` frame (what it covers in its
 * header) starts a compaction; its answer ends it. (The page's `__TAURI_INTERNALS__.invoke` cannot
 * be wrapped: Tauri defines it read-only.)
 */
function watchDesktopStore(page, app) {
  const compacting = new Set();
  page.on('request', (request) => {
    if (request.url() !== 'http://ipc.localhost/store') return;
    const body = request.postDataBuffer();
    if (!body || body.length < 4) return;
    let header;
    try {
      header = JSON.parse(body.subarray(4, 4 + body.readUInt32LE(0)).toString('utf8'));
    } catch {
      return;
    }
    if (header?.op !== 'compactDoc') return;
    compacting.add(request);
    app.onProbe?.({ kind: 'compaction', pageId: header.pageId, covers: header.coversLocalUpTo });
  });
  const settle = (request) => {
    if (compacting.delete(request)) app.onProbe?.({ kind: 'compactionDone' });
  };
  page.on('requestfinished', settle);
  page.on('requestfailed', settle);
}

/** Starts the app on the profile and returns a page attached over CDP, the probe in place. */
async function launch({ blocked = false } = {}) {
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
        'about:blank',
      ],
      { stdio: 'ignore', detached: process.platform !== 'win32' },
    );
  } else {
    setPolicy(port);
    child = spawn(join(root, 'target/release/cgw-desktop.exe'), [], {
      env: {
        ...process.env,
        CGW_DATA_DIR: dataDir,
        WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview2'),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
        // Sign-in in tests: the authorise URL to a file, the refresh token under a keychain name
        // of the test's own (never the person's own sign-in).
        CGW_AUTH_URL_FILE: authUrlFile,
        CGW_KEYCHAIN_SERVICE: `com.cashgear.workspace.killtest.${tag}`,
      },
      stdio: 'ignore',
    });
  }
  try {
    await waitFor(`http://127.0.0.1:${port}/json/version`, 45000);
  } catch (error) {
    killTree(child.pid);
    throw error;
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().startsWith('http')) ?? context.pages()[0];
  if (!page) page = await context.waitForEvent('page');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const block = async (on) =>
    cdp.send('Network.setBlockedURLs', {
      urls: on ? [`${API.replace(/^https?:\/\//, '*')}/*`] : [],
    });
  if (blocked) await block(true);
  const app = { child, browser, page, block, events: [], inflight: new Map() };
  await page.exposeBinding('__cgwProbe', (_source, event) => app.onProbe?.(event));
  // The page's requests to the API, by kind, to say what a kill interrupted.
  const kind = (request) => {
    const url = request.url();
    if (!url.startsWith(API)) return null;
    const path = new URL(url).pathname;
    if (/\/doc\/updates$/.test(path)) return 'push';
    if (/\/pages\/[^/]+\/doc$/.test(path)) return 'pull';
    if (/\/changes$/.test(path)) return 'feed';
    if (/\/ops$/.test(path)) return 'ops';
    return 'other';
  };
  page.on('request', (r) => {
    const k = kind(r);
    if (k) app.inflight.set(r, k);
  });
  page.on('requestfinished', (r) => app.inflight.delete(r));
  page.on('requestfailed', (r) => app.inflight.delete(r));
  if (target === 'desktop') {
    watchDesktopStore(page, app);
    // The desktop's sign-in commands (its token refresh), for a report if a kill signs it out.
    app.authCalls = [];
    const calls = new Map();
    page.on('request', (r) => {
      if (!r.url().startsWith('http://ipc.localhost/auth_')) return;
      const call = { cmd: r.url().slice(21), at: Date.now() - launched, ms: null };
      calls.set(r, call);
      app.authCalls.push(call);
    });
    const done = (r) => {
      const call = calls.get(r);
      if (call) call.ms = Date.now() - launched - call.at;
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
  }
  // For a report if a kill ever signs the device out: refusals, the session checks (whether the
  // request carried the session cookie, and what came back), and new session cookies (names only).
  app.denied = [];
  app.sessions = [];
  app.cookiesSet = [];
  const launched = Date.now();
  app.launched = launched;
  page.on('response', async (r) => {
    if (!r.url().startsWith(API)) return;
    const path = new URL(r.url()).pathname;
    if (r.status() === 401 || r.status() === 403)
      app.denied.push(`${r.request().method()} ${path} ${r.status()}`);
    const set = (await r.headerValue('set-cookie').catch(() => null)) ?? '';
    for (const line of set.split('\n').filter(Boolean))
      app.cookiesSet.push(`${line.split('=')[0].trim()} ${path} +${Date.now() - launched} ms`);
    if (path === '/api/v1/account/session') {
      const headers = await r
        .request()
        .allHeaders()
        .catch(() => ({}));
      const body = await r.json().catch(() => null);
      app.sessions.push({
        cookie: /(^|;\s*)cgw_session=/.test(headers.cookie ?? ''),
        status: r.status(),
        account: !!body?.account,
        at: Date.now() - launched,
      });
    }
  });
  if (target === 'web') {
    await page.addInitScript(probe);
    await page.goto(BASE);
  } else {
    await page.waitForFunction(() => location.href.startsWith('http'), null, { timeout: 30000 });
    await page.evaluate(probe);
  }
  return app;
}

/** Closes the app as a person would (the web through CDP's Browser.close), not a kill. */
async function close(app) {
  try {
    if (target === 'web') {
      const cdp = await app.browser.newBrowserCDPSession();
      await cdp.send('Browser.close').catch(() => {});
    } else {
      // Everything the desktop keeps is written as it happens (SQLite, the keychain).
      await sleep(1500);
    }
  } catch {
    /* already closing */
  }
  for (let i = 0; i < 50 && app.child.exitCode === null; i++) await sleep(100);
  await app.browser.close().catch(() => {});
  if (app.child.exitCode === null) killTree(app.child.pid);
  await sleep(500);
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

/** The first block's text, the save state and the sync status, read in one turn of the page. */
const read = (page) =>
  page.evaluate(() => ({
    text: document.querySelector('.cgw-editor [data-block] > .cgw-body')?.textContent ?? null,
    state:
      document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state') ?? null,
    sync: document.querySelector('[data-testid="sync-status"]')?.textContent ?? null,
  }));

/** Every top-level block's text, as the server's derived JSON lists them. */
const blockTexts = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.cgw-page .cgw-editor > [data-block] > .cgw-body')].map(
      (body) => body.textContent ?? '',
    ),
  );

const percentiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? null,
    max: sorted.at(-1) ?? null,
  };
};

const results = {
  target,
  mode: untilCompaction ? 'until-compaction' : sync ? 'sync' : 'local',
  kill: killHow,
  runs: 0,
  failures: [],
  startedAt: new Date().toISOString(),
  savedChecks: 0,
  killsWhileSaving: 0,
  durableMs: [],
  compaction: {
    seen: 0,
    killsDuring: 0,
    rolledBack: 0,
    committed: 0,
    unknown: 0,
    doneBeforeKill: 0,
    compactAfterAsked: compactAfter,
  },
};
if (sync)
  Object.assign(results, {
    killsWhile: { push: 0, pull: 0, feed: 0, ops: 0, other: 0, anyRequest: 0 },
    offlineRuns: 0,
    cutRuns: 0,
    killsOffline: 0,
    signedOutAfterKill: 0,
    // The status said "signed out" at a start, then went on to sync with no action.
    staleSignedOut: [],
    serverChecks: 0,
    serverCheckMs: [],
  });
let saved = '';
let typed = '';
let account = null;
let api = null;
let signer = null;
let pageId = null;

/** The device says Synced with nothing unsaved, and the server's text equals the device's. */
async function serverCheck(app, run) {
  const begun = Date.now();
  let now = await read(app.page);
  while (!(now.sync === 'Synced' && now.state === 'saved')) {
    if (Date.now() - begun > 120000) {
      results.failures.push({ run, check: 'server', error: `not synced: ${now.sync}` });
      return;
    }
    await sleep(200);
    now = await read(app.page);
  }
  const device = await blockTexts(app.page);
  let server;
  for (;;) {
    server = await serverDoc(api, pageId).catch((error) => ({ error: String(error) }));
    if (JSON.stringify(server.blocks) === JSON.stringify(device)) break;
    if (Date.now() - begun > 120000) {
      results.failures.push({ run, check: 'server', device, server });
      return;
    }
    await sleep(400);
  }
  results.serverChecks++;
  results.serverCheckMs.push(Date.now() - begun);
}

/** The first start: signed in, a synced workspace, the page; closed (not killed) after. */
async function setUpSync() {
  await ensureServer();
  account = await newAccount('Kill sync');
  api = await apiSession(account);
  const app = await launch();
  const { page } = app;
  if (target === 'web') {
    await signInPage(page, account, BASE);
    await page
      .getByRole('button', { name: `Account: ${account.name}` })
      .waitFor({ timeout: 30000 });
    await page.getByLabel('Workspace name').fill('Kill sync');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 30000 });
  } else {
    await page.getByLabel('Workspace name').fill('Kill sync', { timeout: 30000 });
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 30000 });
    signer = await chromium.launch({ channel: 'chrome' });
    await desktopSignIn(page, signer, authUrlFile, account);
    await page
      .getByRole('button', { name: `Account: ${account.name}` })
      .waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Upload to my account' }).click();
  }
  await page
    .getByTestId('sync-status')
    .filter({ hasText: /^Synced$/ })
    .waitFor({ timeout: 60000 });
  await newKillPage(page);
  pageId = openPageId(page);
  if (!pageId) throw new Error('No page id in ' + page.url());
  await page.evaluate(
    (n) => localStorage.setItem('cgw-test:compactAfter', String(n)),
    compactAfter,
  );
  await page
    .getByTestId('sync-status')
    .filter({ hasText: /^Synced$/ })
    .waitFor({ timeout: 60000 });
  // Closed as a person closes it: the browser writes its cookies (a session it would otherwise
  // keep in memory for a while) and the desktop its sign-in, before the first kill.
  await close(app);
}

async function newKillPage(page) {
  await page
    .getByRole('button', { name: /^Add a page in/ })
    .first()
    .click();
  // The new page is open once its title is empty (CI run 43083799788 typed into the page before
  // it).
  await page.waitForFunction(
    () => document.querySelector('textarea[aria-label="Page title"]')?.value === '',
    null,
    { timeout: 30000 },
  );
  await page.getByLabel('Page title').fill('Kill test');
  await page.keyboard.press('Enter');
}

/**
 * A reopened text that does not start with what was saved, or that holds what was never typed:
 * where the texts part, around there, and what the page showed (its title, blocks, notices).
 */
async function prefixFailure(page, run, { saved, typed, reopened, judged = null, before }) {
  const lost = !reopened.startsWith(saved);
  const other = lost ? saved : typed;
  let at = 0;
  while (at < reopened.length && at < other.length && reopened[at] === other[at]) at++;
  const around = (text) => text.slice(Math.max(0, at - 60), at + 120);
  const shown = await page
    .evaluate(() => ({
      url: location.hash,
      title: document.querySelector('textarea[aria-label="Page title"]')?.value ?? null,
      blocks: document.querySelectorAll('.cgw-page .cgw-editor > [data-block]').length,
      notices: [...document.querySelectorAll('[role="alert"]')].map((n) => n.textContent),
      save: document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state'),
      sync: document.querySelector('[data-testid="sync-status"]')?.textContent,
    }))
    .catch(() => null);
  // Where the page's bytes are: its log in the store (each update's local and server sequence and
  // size), what was set aside or put in the corrupt area, its cursor; and the server's head.
  const store =
    target === 'web'
      ? await page.evaluate(storeDump, pageId).catch((error) => String(error))
      : null;
  const server = sync
    ? await api
        .get(`/api/v1/pages/${pageId}/doc?after=0`)
        .then((pull) => ({
          headSeq: pull.headSeq,
          epoch: pull.epoch,
          snapshot: !!pull.snapshot,
          updates: pull.updates.length,
        }))
        .catch((error) => String(error))
    : null;
  return {
    run,
    error: lost ? 'lost text reported saved' : 'text that was never typed',
    store,
    server,
    lengths: { saved: saved.length, typed: typed.length, reopened: reopened.length },
    partsAt: at,
    reopenedThere: around(reopened),
    expectedThere: around(other),
    shown,
    compactionJudged: judged,
    before,
  };
}

/** The page's log, quarantine, corrupt area and cursor in the browser's store (a failure report). */
function storeDump(id) {
  const all = (db, name) =>
    new Promise((done) => {
      try {
        const request = db.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => done(request.result);
        request.onerror = () => done([]);
      } catch {
        done([]);
      }
    });
  return new Promise((done) => {
    const open = indexedDB.open('cgw-workspace');
    open.onerror = () => done(null);
    open.onsuccess = async () => {
      const db = open.result;
      const log = (await all(db, 'docLogs')).find((l) => l.pageId === id);
      const updates = (await all(db, 'docUpdates'))
        .filter((u) => u.pageId === id)
        .map((u) => `${u.localSeq}:${u.seq ?? '-'}:${u.data?.byteLength}`);
      const quarantine = (await all(db, 'quarantine')).map((q) => ({
        reason: q.reason,
        status: q.status,
        at: q.at,
        parts: q.parts?.length,
      }));
      const corrupt = (await all(db, 'corrupt')).filter((c) => c.pageId === id).length;
      const cursor = (await all(db, 'docCursors')).find((c) => c.pageId === id) ?? null;
      const unsent = (await all(db, 'unsentPages')).some((u) => u.pageId === id);
      db.close();
      done({
        log: log
          ? {
              nextSeq: log.nextSeq,
              snapshotCovers: log.snapshotCovers,
              snapshot: log.snapshot?.byteLength ?? 0,
            }
          : null,
        updates: updates.slice(-12),
        updateCount: updates.length,
        quarantine,
        corrupt,
        cursor,
        unsent,
      });
    };
  });
}

/** What the store holds of the page's log after a kill during compaction. */
async function compactionOutcome(app, covers) {
  if (typeof covers !== 'number') return 'unknown';
  let held;
  if (target === 'desktop') {
    const store = await openStoreCli(dataDir);
    try {
      held = (await store.call({ op: 'loadDoc', pageId })).ok.snapshotCovers;
    } finally {
      await store.close();
    }
  } else
    held = await app.page.evaluate(
      (id) =>
        new Promise((done) => {
          const open = indexedDB.open('cgw-workspace');
          open.onerror = () => done(null);
          open.onsuccess = () => {
            const db = open.result;
            const get = db.transaction('docLogs').objectStore('docLogs').get(id);
            get.onsuccess = () => (db.close(), done(get.result?.snapshotCovers ?? 0));
            get.onerror = () => (db.close(), done(null));
          };
        }),
      pageId,
    );
  if (typeof held !== 'number') return 'unknown';
  return held >= covers ? 'committed' : 'rolledBack';
}

/** The page's id, from the address of the open page. */
const openPageId = (page) => new URL(page.url()).hash.match(/#\/p\/([0-9a-f-]{36})/)?.[1] ?? null;

let offlineLeft = 0;
let reported = 0;
let lastKill = null;
let savedAt = Date.now();
let checkDue = false;
// A compaction a kill interrupted: what it covers, and whether it had finished; judged on reopen.
let pendingCompaction = null;
try {
  if (target === 'web') await ensurePreview();
  if (sync) await setUpSync();
  for (let run = 0; run < runs; run++) {
    // The network for this run (sync mode): cut off from the start for one to three runs, or lost
    // while typing, else there.
    let network = 'online';
    if (sync) {
      if (offlineLeft === 0 && random(offlineEvery) === 0) offlineLeft = 1 + random(3);
      if (offlineLeft > 0) {
        offlineLeft--;
        network = 'offline';
        results.offlineRuns++;
      } else if (random(offlineEvery) === 0) {
        network = 'cut';
        results.cutRuns++;
      }
      if (run > 0 && run % checkEvery === 0) checkDue = true;
    }
    if (pendingCompaction && target === 'desktop') {
      // Read before the app starts again (and could compact once more).
      try {
        results.compaction[await compactionOutcome(null, pendingCompaction.covers)]++;
      } catch (error) {
        results.failures.push({ run, error: 'store after kill: ' + String(error).slice(0, 300) });
      }
      pendingCompaction = null;
    }
    let app;
    try {
      app = await launch({ blocked: network === 'offline' });
    } catch (error) {
      // An app that does not start is a failure of its own; once more after the profile's
      // processes are ended, then the test stops.
      results.failures.push({ run, error: 'did not start: ' + String(error).slice(0, 200) });
      sweep();
      await sleep(2000);
      try {
        app = await launch({ blocked: network === 'offline' });
      } catch {
        break;
      }
    }
    const { child, page } = app;
    let killed = false;
    let killedFor = 'time';
    const killNow = (why = 'time') => {
      if (killed) return;
      killed = true;
      killedFor = why;
      kill(child);
      lastKill = {
        run,
        why: killedFor,
        // How long before the kill the last text was seen reported saved.
        sinceSavedMs: Date.now() - savedAt,
        savedLength: saved.length,
        killAt: Date.now() - app.launched,
        authCalls: app.authCalls,
        network,
        kinds: [...new Set(app.inflight.values())],
        denied: app.denied,
        cookiesSet: app.cookiesSet,
        sessions: app.sessions,
      };
      if (sync) {
        const kinds = new Set(app.inflight.values());
        for (const k of kinds) results.killsWhile[k]++;
        if (kinds.size) results.killsWhile.anyRequest++;
        if (network !== 'online') results.killsOffline++;
      }
    };
    try {
      if (!sync && run === 0) {
        await page.getByRole('button', { name: 'Create workspace' }).click();
        await newKillPage(page);
        pageId = openPageId(page);
        if (untilCompaction) {
          // A large second block (some 400 kB of text), so each compaction writes a large
          // snapshot and takes long enough to be killed in; the check reads the first block.
          await page.keyboard.press('Enter');
          await page.keyboard.insertText('ledger budget report '.repeat(20000));
          await page.waitForFunction(
            () =>
              document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state') ===
              'saved',
            null,
            { timeout: 30000 },
          );
        }
      } else {
        // The app reopens on its last page; open ours by title.
        await page.getByRole('treeitem', { name: /Kill test/ }).click({ timeout: 30000 });
      }
      await page.locator('.cgw-editor').waitFor({ timeout: 30000 });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="save-status"]'),
        null,
        { timeout: 30000 },
      );
      // Test-only: compact sooner, where the build reads it (read at the app's start).
      await page.evaluate(
        (n) => localStorage.setItem('cgw-test:compactAfter', String(n)),
        compactAfter,
      );
      let judged = null;
      if (pendingCompaction && target === 'web') {
        try {
          judged = await compactionOutcome(app, pendingCompaction.covers);
          results.compaction[judged]++;
        } catch {
          results.compaction.unknown++;
        }
        pendingCompaction = null;
      }
      const opened = await read(page);
      const reopened = opened.text ?? '';
      // What was reported saved is there, and nothing that was never typed.
      if (!reopened.startsWith(saved) || !typed.startsWith(reopened))
        results.failures.push(
          await prefixFailure(page, run, { saved, typed, reopened, judged, before: lastKill }),
        );
      saved = reopened;
      typed = reopened;
      if (sync) {
        if (/^Sign in to sync|^Signed out/.test(opened.sync ?? '')) {
          // The status says signed out. Either a stale status (the account came back and the
          // next status replaces it, with no action) or a session that really ended: which one,
          // what the server refused, the session checks, which cookies the browser kept (names
          // only), and the kill before. A real one is signed in again, so the runs go on.
          const begun = Date.now();
          let status = opened.sync;
          while (/^Sign in to sync|^Signed out/.test(status ?? '') && Date.now() - begun < 15000) {
            await sleep(200);
            status = (await read(page)).sync;
          }
          const report = {
            run,
            status: opened.sync,
            after: status,
            recoveredInMs: Date.now() - begun,
            denied: app.denied,
            sessions: app.sessions,
            cookies: (await page.context().cookies(API)).map(
              (c) => `${c.name}${c.expires > 0 ? '' : ' (session)'}`,
            ),
            before: lastKill,
          };
          if (!/^Sign in to sync|^Signed out/.test(status ?? '')) {
            results.staleSignedOut.push(report);
          } else {
            results.signedOutAfterKill++;
            await page
              .screenshot({
                path: join(root, `bench/results/kill-signed-out-${target}-${run}.png`),
              })
              .catch(() => {});
            report.screen = (await page.evaluate(() => document.body.innerText).catch(() => ''))
              .slice(0, 600)
              .replace(/\s+/g, ' ');
            results.failures.push({ ...report, error: `signed out after the kill: ${status}` });
            if (target === 'desktop') {
              await desktopSignIn(page, signer, authUrlFile, account);
            } else await signInPage(page, account, BASE);
            await page.getByRole('treeitem', { name: /Kill test/ }).click({ timeout: 30000 });
            await page.locator('.cgw-editor').waitFor({ timeout: 30000 });
          }
        }
        if (checkDue && network === 'online') {
          await serverCheck(app, run);
          checkDue = false;
        }
      }
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
      // Most runs: a compaction that starts is the moment of the kill.
      const armed = untilCompaction || random(5) !== 0;
      const hold = target === 'web' && armed ? 150 + random(250) : 0;
      await page.evaluate((h) => (window.__cgwKill.hold = h), hold);
      let compaction = null;
      app.onProbe = (event) => {
        if (event?.kind === 'compactionCovers' && compaction) compaction.covers = event.covers;
        if (event?.kind === 'compactionDone' && compaction) compaction.done = true;
        if (event?.kind !== 'compaction') return;
        results.compaction.seen++;
        compaction = { covers: event.covers ?? null, done: false };
        if (!armed || killed) return;
        const ours = compaction;
        setTimeout(
          () => {
            if (killed) return;
            results.compaction.killsDuring++;
            if (ours.done) results.compaction.doneBeforeKill++;
            pendingCompaction = ours;
            killNow('compaction');
          },
          target === 'web' ? random(Math.max(1, hold - 60)) : random(untilCompaction ? 20 : 6),
        );
      };
      // A safety net in --until-compaction runs: 200 saves take about 40 s.
      const killAt = Date.now() + (untilCompaction ? 180000 : 150 + random(1500));
      const cutAt = network === 'cut' ? Date.now() + random(killAt - Date.now()) : Infinity;
      let now = opened;
      while (!killed) {
        if (network === 'cut' && Date.now() >= cutAt) {
          await app.block(true);
          network = 'cut off';
        }
        const word = words[random(words.length)] + ' ';
        typed += word;
        await page.keyboard.type(word, { delay: random(3) ? 0 : 20 });
        now = await read(page);
        if (untilCompaction || random(3) === 0) {
          // A pause: the edit must be durable within a second of the last key (budget 1 s).
          const lastKey = Date.now();
          while (now.state !== 'saved' && Date.now() - lastKey < 2000) {
            await sleep(25);
            now = await read(page);
          }
          if (now.state === 'saved') results.durableMs.push(Date.now() - lastKey);
          else results.failures.push({ run, error: 'not saved 2 s after the last key' });
        }
        if (now.state === 'saved' && now.text !== null) {
          if (now.text !== saved) savedAt = Date.now();
          saved = now.text;
          results.savedChecks++;
        }
        if (Date.now() >= killAt) {
          if (untilCompaction) results.failures.push({ run, error: 'no compaction in 180 s' });
          if (now.state === 'saving' || now.state === 'unsaved') results.killsWhileSaving++;
          killNow();
        }
      }
    } catch (error) {
      // After a kill the page's calls fail: that is the kill, not a failure.
      if (!killed) {
        // What the window showed, for the report.
        const shot = join(root, `bench/results/kill-error-${target}-${run}.png`);
        await page.screenshot({ path: shot }).catch(() => {});
        const screen = await page
          .evaluate(() => `${location.hash} | ${document.body.innerText}`)
          .catch(() => '');
        results.failures.push({
          run,
          error: String(error).slice(0, 400),
          screen: screen.slice(0, 600).replace(/\s+/g, ' '),
          before: lastKill,
        });
        killNow();
        if (results.failures.length > 5) break;
      }
    }
    await app.browser.close().catch(() => {});
    results.runs = run + 1;
    for (const failure of results.failures.slice(reported)) {
      console.log('FAILURE', JSON.stringify(failure).slice(0, 2000));
      appendFileSync(failuresFile, JSON.stringify(failure) + '\n');
    }
    reported = results.failures.length;
    if ((run + 1) % 25 === 0) {
      sweep();
      console.log(
        `${target}${sync ? ' sync' : ''}: ${run + 1} runs, ${results.failures.length} failures, ` +
          `${results.compaction.killsDuring} kills during compaction` +
          (sync
            ? `, ${results.killsWhile.push} during a push, ${results.serverChecks} server checks`
            : ''),
      );
    }
  }
  if (results.failures.length <= 5 && results.runs === runs) {
    // The last check: the last kill too lost nothing (started once more, not killed); in sync
    // mode with the network, and everything reaches the server.
    if (pendingCompaction && target === 'desktop') {
      results.compaction[await compactionOutcome(null, pendingCompaction.covers)]++;
      pendingCompaction = null;
    }
    const app = await launch();
    try {
      await app.page.getByRole('treeitem', { name: /Kill test/ }).click({ timeout: 30000 });
      await app.page.locator('.cgw-editor').waitFor({ timeout: 30000 });
      if (pendingCompaction) {
        results.compaction[await compactionOutcome(app, pendingCompaction.covers)]++;
        pendingCompaction = null;
      }
      const reopened = (await read(app.page)).text ?? '';
      if (!reopened.startsWith(saved) || !typed.startsWith(reopened))
        results.failures.push(
          await prefixFailure(app.page, 'final', { saved, typed, reopened, before: lastKill }),
        );
      results.finalText = { device: reopened.length };
      if (sync) {
        await serverCheck(app, 'final');
        const server = await serverDoc(api, pageId).catch(() => null);
        results.finalText.server = server?.blocks?.[0]?.length ?? null;
      }
      if (sync && target === 'desktop') {
        // The test's sign-in leaves the keychain.
        await app.page.goto(new URL('#/settings', app.page.url()).toString());
        await app.page.getByRole('button', { name: 'Sign out' }).click({ timeout: 10000 });
        await sleep(1500);
      }
    } catch (error) {
      results.failures.push({ run: 'final', error: String(error).slice(0, 400) });
    } finally {
      await close(app);
    }
  }
} finally {
  for (const child of started.reverse()) killTree(child.pid);
  await signer?.close().catch(() => {});
  await api?.dispose().catch(() => {});
  sweep();
  if (hostedRunner) reg(['delete', policyKey, '/v', 'cgw-desktop.exe', '/f', '/reg:64']);
  if (sync && target === 'desktop' && process.platform === 'win32')
    // The test's own keychain name, whatever the sign-out at the end managed (its parts too).
    for (const part of ['', '#1', '#2', '#3'])
      spawnSync('cmdkey', [`/delete:${API}${part}.com.cashgear.workspace.killtest.${tag}`], {
        windowsHide: true,
        stdio: 'ignore',
      });
  results.finishedAt = new Date().toISOString();
  results.minutes =
    Math.round((Date.parse(results.finishedAt) - Date.parse(results.startedAt)) / 6000) / 10;
  results.finalTextLength = typed.length;
  results.durable = percentiles(results.durableMs);
  delete results.durableMs;
  if (sync) {
    results.serverCheck = percentiles(results.serverCheckMs);
    delete results.serverCheckMs;
  }
  mkdirSync(join(root, 'bench/results'), { recursive: true });
  writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify({ ...results, failures: results.failures.slice(0, 3) }, null, 2));
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
if (results.failures.length) process.exitCode = 1;
