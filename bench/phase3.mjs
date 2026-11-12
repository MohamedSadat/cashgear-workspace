// Phase 3's budgets (IMPLEMENTATION_PLAN.md, Phase 3, Performance benchmarks), measured and gated:
//   pnpm bench:phase3                  the web app in Chrome against the server stack
//   pnpm bench:phase3 -- --desktop     and the desktop app's cold start with no server answering
// Needs `pnpm build` (and for --desktop the release build); the web app under vite preview on
// 127.0.0.1:4273 and the server stack on 127.0.0.1:5280 are reused when they answer, else started
// here (scripts/server-stack.mjs --e2e) and stopped at the end.
//
// The workspace, made through the API as a client makes one: two pages with 499 pages inside
// each (1,000), and a page of 200 blocks, every page with a first document written by @cgw/doc
// (bench/editor/src/phase3-corpus.test.ts: a few paragraphs, Arabic and English) and pushed as a
// device of the account would, then validated by the worker before anything is timed. Then, in a
// fresh Chrome profile signed in as that person:
//   - pinning a 500-page subtree while typing: the 200-block page open, the first subtree pinned
//     from its page menu, and typing into the open page at a key every 35 ms until every page of
//     the subtree is on the device; the time to that, and keystroke to the next frame meanwhile
//     (Phase 1's measure: from keydown to the frame after it painted), p95 (budget 33 ms);
//   - the local store for 1,000 cached pages: the second subtree pinned too, and once all are held,
//     IndexedDB's usage (navigator.storage.estimate) and the document bytes in the store (no
//     budget: tracked against the last run);
//   - reconnect with 1,000 waiting updates across 50 pages: offline (Playwright's offline mode),
//     50 pages of the first subtree each get 20 saved edits (a word typed, then the save, 20 times:
//     each save is one update in the store, as an autosave makes them), the status saying so; then
//     the network back, and the time until the status says Synced (budget 30 s), after which the
//     server's derived text of each page must hold its last word.
// With --desktop: the desktop app signed in (its sign-in through CGW_AUTH_URL_FILE, a Chrome page,
// as the e2e specs do) with a synced workspace, then started five times with no server answering
// (its window's network through a proxy that is not there, and so its native side's too, as
// HTTP_PROXY): process start to the first editable page, median (budget 1,500 ms, Phase 1's cold
// start online, which is measured the same way beside it).
//
// Each figure is checked against its budget and, when bench/previous/phase3.json holds the last
// run on main on the same processor (CI downloads it), against that: worse by half again and by
// more than a small margin fails. Writes bench/results/phase3.json.
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
  desktopSignIn,
  newAccount,
  serverDoc,
  signInPage,
  waitFor,
} from '../scripts/cloud-account.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const withDesktop = args.includes('--desktop');
// The desktop part alone (to try it): --desktop --no-web.
const withWeb = !args.includes('--no-web');
const previousFile = join(root, 'bench/previous/phase3.json');
const results = join(root, 'bench/results');
const log = (line) => console.log(line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Budgets, with the margin a regression must also exceed to fail (runners are noisy). */
const BUDGETS = {
  reconnect1000Ms: { max: 30000, unit: 'ms', slack: 3000 },
  pin500HeldMs: { max: 120000, unit: 'ms', slack: 10000 },
  pin500KeyFrameP95: { max: 33, unit: 'ms', slack: 5 },
  desktopColdStartOfflineMs: { max: 1500, unit: 'ms', slack: 150 },
  // Tracked, not budgeted (the plan: "recorded and tracked").
  store1000MB: { max: Infinity, unit: 'MB', slack: 5 },
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

/** Runs `fn` over `items`, `n` at a time. */
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

// ------------------------------------------------------------------ the workspace
/**
 * Through the API as a client makes it: sections, two parents with 499 pages inside each and a
 * 200-block page; each page's first document pushed as one update from a client id this session
 * registered, then waited for until the worker has validated every one.
 */
async function seedWorkspace(api) {
  const workspaceId = uuidv7();
  await api.post('/api/v1/workspaces', { id: workspaceId, name: 'Phase 3 bench' });
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
  const shared = uuidv7();
  const personal = uuidv7();
  const section = (id, name, orderKey, visibility) =>
    op('section.create', id, {
      id,
      workspaceId,
      name,
      orderKey,
      visibility,
      version: 1,
      createdAt: now,
    });
  const page = (id, parentPageId, orderKey, title) =>
    op('page.create', id, {
      id,
      workspaceId,
      sectionId: shared,
      parentPageId,
      orderKey,
      kind: 'page',
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
    });
  const check = (answer) => {
    const refused = answer.results.filter((r) => r.status !== 'applied');
    if (refused.length) throw new Error('Operations refused: ' + JSON.stringify(refused[0]));
  };
  check(
    await api.post(`/api/v1/workspaces/${workspaceId}/ops`, {
      ops: [
        section(shared, 'Shared', 'a0', 'workspace'),
        section(personal, 'Private', 'a1', 'private'),
      ],
    }),
  );
  const digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  // Integer order keys of three characters ('b' and two base-62 digits: D19's format).
  const key = (i) => 'b' + digits[Math.floor(i / 62)] + digits[i % 62];
  const typing = uuidv7();
  const parents = [uuidv7(), uuidv7()];
  const children = [[], []];
  const ops = [page(typing, null, key(0), 'Typing page')];
  parents.forEach((id, p) => ops.push(page(id, null, key(p + 1), p ? 'Cached 500' : 'Pinned 500')));
  for (let p = 0; p < 2; p++)
    for (let c = 0; c < 499; c++) {
      const id = uuidv7();
      children[p].push(id);
      ops.push(page(id, parents[p], key(c), `${p ? 'Cached' : 'Pinned'} page ${c + 1}`));
    }
  for (let i = 0; i < ops.length; i += 100)
    check(await api.post(`/api/v1/workspaces/${workspaceId}/ops`, { ops: ops.slice(i, i + 100) }));

  // The documents, written by @cgw/doc as one registered client of this session.
  const clientId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
  const registered = await api.post(`/api/v1/workspaces/${workspaceId}/yjs-clients`, {
    issue: null,
    register: [clientId],
  });
  if (!registered.registered.map(Number).includes(clientId))
    throw new Error('The client id was not registered: ' + JSON.stringify(registered));
  const corpus = join(results, 'phase3-corpus');
  mkdirSync(corpus, { recursive: true });
  const all = [
    { id: typing, blocks: 200 },
    ...parents.map((id) => ({ id, blocks: 3 })),
    ...children.flat().map((id) => ({ id, blocks: 3 + (id.charCodeAt(35) % 5) })),
  ];
  writeFileSync(join(corpus, 'pages.json'), JSON.stringify({ clientId, pages: all }));
  const written = spawnSync(
    process.execPath,
    [join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'bench/editor/src/phase3-corpus.test.ts'],
    { cwd: root, stdio: 'inherit', env: { ...process.env, PHASE3_CORPUS: corpus } },
  );
  if (written.status !== 0) throw new Error('The corpus was not written');
  const docs = JSON.parse(readFileSync(join(corpus, 'docs.json'), 'utf8'));
  await pool(all, 8, async ({ id }) => {
    await api.post(`/api/v1/pages/${id}/doc/updates`, {
      epoch: 0,
      clientSchemaVersion: 2,
      updates: [{ updateId: uuidv7(), data: docs[id] }],
    });
  });
  // Every page validated (its head moved) before anything is timed.
  const deadline = Date.now() + 300000;
  for (;;) {
    const tree = await api.get(`/api/v1/workspaces/${workspaceId}/tree`);
    const waiting = tree.pages.filter((p) => Number(p.docHeadSeq) < 1).length;
    if (!waiting) break;
    if (Date.now() > deadline) throw new Error(`${waiting} pages still not validated`);
    await sleep(1000);
  }
  return { workspaceId, typing, parents, children };
}

// ------------------------------------------------------------------ in the page
/** Keystroke to the frame after it painted (Phase 1's measure, bench/editor/src/app.tsx). */
function keyProbe() {
  window.__keys = [];
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
      if (event.key.length !== 1) return;
      const start = event.timeStamp;
      void afterPaint().then(() => window.__keys.push(performance.now() - start));
    },
    true,
  );
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

/** The store's document bytes (logs' snapshots and updates) for the given pages. */
function docBytesOf(ids) {
  return new Promise((done) => {
    const wanted = new Set(ids);
    const open = indexedDB.open('cgw-workspace');
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['docLogs', 'docUpdates']);
      let bytes = 0;
      const logs = tx.objectStore('docLogs').openCursor();
      logs.onsuccess = () => {
        const c = logs.result;
        if (!c) return;
        if (wanted.has(c.value.pageId)) bytes += c.value.snapshot?.byteLength ?? 0;
        c.continue();
      };
      const updates = tx.objectStore('docUpdates').openCursor();
      updates.onsuccess = () => {
        const c = updates.result;
        if (!c) return;
        if (wanted.has(c.value.pageId)) bytes += c.value.data?.byteLength ?? 0;
        c.continue();
      };
      tx.oncomplete = () => (db.close(), done(bytes));
    };
  });
}

const status = (page) => page.getByTestId('sync-status').textContent();

async function pinFromMenu(page, pageId) {
  await page.evaluate((id) => (location.hash = `#/p/${id}`), pageId);
  await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 30000 });
  await page.locator('.cgw-topbar-button[aria-label="Page actions"]').click();
  await page
    .getByRole('menuitem', { name: 'Make available offline, with the pages inside' })
    .click();
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
}

// ------------------------------------------------------------------ the browser part
async function web(account, seeded) {
  const browser = await chromium.launch({ channel: 'chrome' });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(keyProbe);
    await page.goto(`${APP}/`);
    await signInPage(page, account, `${APP}/`);
    await page
      .getByTestId('sync-status')
      .filter({ hasText: /^Synced$/ })
      .waitFor({ timeout: 120000 });

    // Pinning a 500-page subtree while typing in an open 200-block page.
    log('Pinning a 500-page subtree while typing');
    const subtree = [seeded.parents[0], ...seeded.children[0]];
    await openTyping(page, seeded.typing, 200);
    await pinFromMenu(page, seeded.parents[0]);
    const pinned = Date.now();
    await openTyping(page, seeded.typing, 200);
    await page.evaluate(() => window.__keys.splice(0));
    let held = 0;
    let heldMs = null;
    const text = 'the quick brown fox jumps over the lazy dog and keeps on typing ';
    for (let chunk = 0; Date.now() - pinned < 150000; chunk = (chunk + 16) % text.length) {
      // A key every 35 ms, and how many pages are held looked at every 16 keys.
      await page.keyboard.type(text.slice(chunk, chunk + 16), { delay: 35 });
      held = await page.evaluate(heldOf, subtree);
      if (held >= subtree.length) {
        heldMs = Date.now() - pinned;
        break;
      }
    }
    const keys = await page.evaluate(() => window.__keys.splice(0));
    log(
      `  ${held} of 500 held in ${heldMs ?? '>150000'} ms; ${keys.length} keys, frame p95 ${round(percentile(keys, 0.95))} ms`,
    );

    // The store with 1,000 cached pages.
    log('Caching the second subtree: 1,000 pages');
    const second = [seeded.parents[1], ...seeded.children[1]];
    await pinFromMenu(page, seeded.parents[1]);
    const allPinned = [...subtree, ...second];
    const cacheStarted = Date.now();
    while ((await page.evaluate(heldOf, allPinned)) < allPinned.length) {
      if (Date.now() - cacheStarted > 300000) throw new Error('The second subtree was not held');
      await sleep(1000);
    }
    const estimate = await page.evaluate(async () => {
      const e = await navigator.storage.estimate();
      return { usage: e.usage, details: e.usageDetails ?? null };
    });
    const docBytes = await page.evaluate(docBytesOf, allPinned);
    const indexedDB = estimate.details?.indexedDB ?? estimate.usage;
    log(
      `  1,000 pages held: IndexedDB ${round(indexedDB / 1048576)} MB, documents ${round(docBytes / 1048576)} MB`,
    );

    // Reconnect with 1,000 waiting updates across 50 pages.
    log('Offline: 20 saved edits in each of 50 pages');
    await context.setOffline(true);
    await page
      .getByTestId('sync-status')
      .filter({ hasText: /^Offline/ })
      .waitFor({ timeout: 30000 });
    const fifty = seeded.children[0].slice(0, 50);
    const lastWord = (i) => `p${i}w19`;
    for (let i = 0; i < fifty.length; i++) {
      await page.evaluate((id) => (location.hash = `#/p/${id}`), fifty[i]);
      await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 30000 });
      await page.locator('.cgw-page .cgw-editor > [data-block] .cgw-body').last().click();
      await page.keyboard.press('End');
      for (let e = 0; e < 20; e++) {
        await page.keyboard.type(` p${i}w${e}`);
        await page.waitForFunction(
          () =>
            document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state') ===
            'saved',
          null,
          { timeout: 10000 },
        );
      }
    }
    const waitingText = await status(page);
    const waiting = Number(waitingText?.match(/(\d+) changes waiting/)?.[1] ?? NaN);
    log(`  status: ${waitingText}`);
    const back = Date.now();
    await context.setOffline(false);
    await page
      .getByTestId('sync-status')
      .filter({ hasText: /^Synced$/ })
      .waitFor({ timeout: 120000 });
    const reconnectMs = Date.now() - back;
    log(`  synced ${reconnectMs} ms after the network came back`);
    // Every page's last word reached the server (the worker's derived text).
    const api = await apiSession(account);
    let missing = [];
    try {
      const deadline = Date.now() + 120000;
      for (;;) {
        missing = [];
        await pool(
          fifty.map((id, i) => ({ id, i })),
          8,
          async ({ id, i }) => {
            const doc = await serverDoc(api, id).catch(() => null);
            if (!doc?.blocks.join('\n').includes(lastWord(i))) missing.push(id);
          },
        );
        if (!missing.length || Date.now() > deadline) break;
        await sleep(2000);
      }
    } finally {
      await api.dispose();
    }
    if (missing.length)
      throw new Error(`${missing.length} pages lack their last edit on the server`);
    if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
    return {
      browser: browser.version(),
      pin500: {
        heldMs,
        held,
        keys: keys.length,
        frameP50: round(percentile(keys, 0.5)),
        frameP95: round(percentile(keys, 0.95)),
      },
      store1000: {
        pages: allPinned.length,
        indexedDBBytes: indexedDB,
        usageBytes: estimate.usage,
        details: estimate.details,
        docBytes,
      },
      reconnect: {
        pages: fifty.length,
        updates: fifty.length * 20,
        waitingShown: waiting,
        ms: reconnectMs,
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

async function desktop(account) {
  const exe = join(root, 'target/release/cgw-desktop.exe');
  if (!existsSync(exe)) throw new Error('The desktop build is missing: run pnpm desktop:build.');
  const profile = mkdtempSync(join(tmpdir(), 'cgw-phase3-desktop-'));
  // A keychain name of this run's own, removed at the end whatever the sign-out managed.
  const keychainService = `com.cashgear.workspace.bench.${basename(profile)}`;
  const authUrlFile = join(profile, 'authorize-url.txt');
  const hostedRunner =
    process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
  const policyKey =
    'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';
  const reg = (a) => spawnSync('reg.exe', a, { encoding: 'utf8', windowsHide: true });
  // Nothing listens on port 9: the proxy that is not there, so nothing reaches the server.
  const dead = 'http://127.0.0.1:9';
  const start = async ({ offline }) => {
    const port = await freePort();
    const browserArgs =
      `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` +
      (offline ? ` --proxy-server=${dead} --proxy-bypass-list=<-loopback>` : '');
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
    const started = Date.now();
    const child = spawn(exe, [], {
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview2'),
        CGW_DATA_DIR: join(profile, 'data'),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs,
        CGW_AUTH_URL_FILE: authUrlFile,
        CGW_KEYCHAIN_SERVICE: keychainService,
        ...(offline ? { HTTP_PROXY: dead, HTTPS_PROXY: dead, ALL_PROXY: dead, NO_PROXY: '' } : {}),
      },
    });
    await waitFor(`http://127.0.0.1:${port}/json/version`, 60000);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    return { child, started, browser, page };
  };
  const stop = async (app) => {
    await app.browser.close().catch(() => {});
    spawnSync('taskkill', ['/PID', String(app.child.pid), '/T', '/F'], { windowsHide: true });
    await sleep(1500);
  };
  const editableAt = async (app) => {
    await app.page.waitForFunction(
      () => performance.getEntriesByName('cgw-editable').length > 0,
      null,
      {
        timeout: 60000,
      },
    );
    const at = await app.page.evaluate(
      () => performance.timeOrigin + performance.getEntriesByName('cgw-editable')[0].startTime,
    );
    return Math.round(at - app.started);
  };
  let signer = null;
  let app = null;
  try {
    // Signed in, with a synced workspace and a page typed into.
    app = await start({ offline: false });
    await app.page.getByLabel('Workspace name').fill('Cold start offline', { timeout: 60000 });
    await app.page.keyboard.press('Enter');
    await app.page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 60000 });
    signer = await chromium.launch({ channel: 'chrome' });
    await desktopSignIn(app.page, signer, authUrlFile, account);
    await app.page
      .getByRole('button', { name: `Account: ${account.name}` })
      .waitFor({ timeout: 30000 });
    await app.page.getByRole('button', { name: 'Upload to my account' }).click();
    await app.page
      .getByTestId('sync-status')
      .filter({ hasText: /^Synced$/ })
      .waitFor({ timeout: 60000 });
    await stop(app);
    const runs = { online: [], offline: [] };
    for (let i = 0; i < 5; i++)
      for (const offline of [true, false]) {
        app = await start({ offline });
        runs[offline ? 'offline' : 'online'].push(await editableAt(app));
        if (offline) {
          // Signed in with the cached account, and saying it is offline.
          await app.page
            .getByRole('button', { name: `Account: ${account.name}` })
            .waitFor({ timeout: 15000 });
          await app.page
            .getByTestId('sync-status')
            .filter({ hasText: /^Offline/ })
            .waitFor({ timeout: 15000 });
        }
        await stop(app);
      }
    log(
      `  desktop cold start offline ${runs.offline.join(', ')} ms; online ${runs.online.join(', ')} ms`,
    );
    // The test's sign-in leaves the keychain.
    app = await start({ offline: false });
    await app.page.goto(new URL('#/settings', app.page.url()).toString());
    await app.page
      .getByRole('button', { name: 'Sign out' })
      .click({ timeout: 15000 })
      .catch(() => {});
    await sleep(1500);
    await stop(app);
    return {
      offline: { runs: runs.offline, p50: percentile(runs.offline, 0.5) },
      online: { runs: runs.online, p50: percentile(runs.online, 0.5) },
    };
  } finally {
    await signer?.close().catch(() => {});
    if (hostedRunner) reg(['delete', policyKey, '/v', 'cgw-desktop.exe', '/f', '/reg:64']);
    for (const part of ['', '#1', '#2', '#3'])
      spawnSync('cmdkey', [`/delete:${API}${part}.${keychainService}`], {
        windowsHide: true,
        stdio: 'ignore',
      });
    // An app left running by a failure is stopped first, or its folder cannot go.
    if (app && app.child.exitCode === null) await stop(app).catch(() => {});
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      log(`  (could not remove ${profile}: ${error.code})`);
    }
  }
}

// ------------------------------------------------------------------ main
if (!existsSync(join(root, 'apps/web/dist/index.html'))) throw new Error('Run pnpm build first.');
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
const started = [];
try {
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

  const account = await newAccount('Phase 3 bench');
  const api = await apiSession(account);
  if (withWeb) {
    const seeding = Date.now();
    let seeded;
    try {
      seeded = await seedWorkspace(api);
    } finally {
      await api.dispose();
    }
    out.seedMs = Date.now() - seeding;
    log(`Seeded 1,001 pages with their documents, validated, in ${out.seedMs} ms`);
    out.web = await web(account, seeded);
  } else await api.dispose();
  // An account of its own: the web part's 1,000-page workspace would sync to the desktop too.
  if (withDesktop) out.desktop = await desktop(await newAccount('Phase 3 desktop'));
} finally {
  for (const child of started.reverse()) stopTree(child);
}

const figures = {
  reconnect1000Ms: out.web?.reconnect?.ms,
  pin500HeldMs: out.web?.pin500?.heldMs ?? (out.web ? Infinity : undefined),
  pin500KeyFrameP95: out.web?.pin500?.frameP95,
  desktopColdStartOfflineMs: out.desktop?.offline?.p50,
  store1000MB: out.web ? round(out.web.store1000.indexedDBBytes / 1048576) : undefined,
};
const last = existsSync(previousFile) ? JSON.parse(readFileSync(previousFile, 'utf8')) : null;
const sameMachine = !!last && last.machine?.cpu === out.machine.cpu;
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
out.figures = figures;
out.gate = gate;
writeFileSync(join(results, 'phase3.json'), JSON.stringify(out, null, 2) + '\n');
log('\nBudget                       value      budget   last main');
for (const g of gate)
  log(
    `${g.overBudget || g.regressed ? 'FAIL' : 'ok  '} ${g.name.padEnd(26)} ${String(g.value).padStart(7)} ${g.unit.padEnd(3)} ${String(g.budget ?? 'none').padStart(7)}   ${g.previous ?? '-'}${g.regressed ? '  (regressed)' : ''}`,
  );
if (!last) log('(No run on main to compare with: budgets only.)');
else if (!sameMachine)
  log(
    `(The last run on main ran on ${last.machine?.cpu ?? 'a processor it did not record'}, this one on ${out.machine.cpu}: budgets only.)`,
  );
process.exitCode = gate.some((g) => g.overBudget || g.regressed) ? 1 : 0;
