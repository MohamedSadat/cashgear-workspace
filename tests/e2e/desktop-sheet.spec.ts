// Phase 9, M9.3 (Track S6): on the desktop, "Open in Cash Gear Sheet" opens Sheet's desktop app by
// its deep link when the system has something for `cashgear-sheet`, else Sheet's web app as
// before; from the click on. The app is started with its test settings (as CGW_AUTH_URL_FILE is):
// `CGW_SHEET_APP=installed|missing` answers whether Sheet's app is installed, and
// `CGW_OPEN_URL_FILE` takes the link the app would hand the system. With `installed` the link is a
// desktop launch whose ticket redeems only from the desktop app's origin (`http://tauri.localhost`)
// and is used up by a web origin's try; with `missing` the web link goes to the system browser
// (caught in the page, so no browser opens) and nothing is written to the file.
//
// Desktop run only (CGW_E2E_TARGET=desktop, the release build): each test starts the app itself,
// with these settings, on the fixtures' one debugging port, and asks for no `page` fixture.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { test, expect, desktop, DESKTOP_PORT } from './fixtures';
import { newAccount } from './cloud';
import { signedInWorkspace, signers, signOutDesktop } from './database';
import {
  MOCK_SHEET,
  newWorkbook,
  sessionOf,
  sheetSession,
  workbookOf,
  workspaceIdOf,
} from './ecosystem';

test.skip(!desktop, 'The desktop app’s own link to Sheet’s app: the desktop run');

const root = resolve(import.meta.dirname, '../..');
const TAURI_ORIGIN = 'http://tauri.localhost';
const DESKTOP_LINK = /^cashgear-sheet:\/\/workspace\/launch#ticket=([A-Za-z0-9_-]{43})$/;

async function until<T>(what: string, check: () => Promise<T | undefined | false>, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out: ' + what);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** The release app with a data folder of its own and these test settings, driven over CDP. */
async function startApp(folder: string, sheetApp: 'installed' | 'missing' | null) {
  const args = `--remote-debugging-port=${DESKTOP_PORT} --remote-debugging-address=127.0.0.1`;
  const child: ChildProcess = spawn(join(root, 'target/release/cgw-desktop.exe'), [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name !== 'CGW_SHEET_APP' && name !== 'CGW_OPEN_URL_FILE',
        ),
      ),
      WEBVIEW2_USER_DATA_FOLDER: join(folder, 'webview2'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: args,
      CGW_DATA_DIR: join(folder, 'data'),
      CGW_SAVE_DIR: join(folder, 'saved'),
      CGW_AUTH_URL_FILE: join(folder, 'authorize-url.txt'),
      CGW_KEYCHAIN_SERVICE: `com.cashgear.workspace.e2e.${randomUUID().slice(0, 8)}`,
      // null: no stand-ins (the variables left out: the app takes an empty one as set), the
      // system answers and opens (the real app's acceptance run).
      ...(sheetApp
        ? { CGW_SHEET_APP: sheetApp, CGW_OPEN_URL_FILE: join(folder, 'sheet-link.txt') }
        : {}),
    },
  });
  const endpoint = `http://127.0.0.1:${DESKTOP_PORT}`;
  await until(
    'the app to accept a debugger',
    async () => (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })).ok,
    60000,
  );
  const browser: Browser = await chromium.connectOverCDP(endpoint);
  const context = await until('the webview', async () => browser.contexts()[0], 30000);
  const page: Page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await until('the app to load', async () => page.url().startsWith('http'), 30000);
  const origin = new URL(page.url()).origin;
  const goto = page.goto.bind(page);
  page.goto = (url, options) => goto(url.startsWith('/') ? origin + url : url, options);
  return {
    page,
    authUrlFile: join(folder, 'authorize-url.txt'),
    linkFile: join(folder, 'sheet-link.txt'),
    stop: async () => {
      await signOutDesktop(page).catch(() => {});
      await browser.close().catch(() => {});
      if (child.pid)
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      await new Promise((r) => setTimeout(r, 800));
    },
  };
}

/**
 * Links handed to the system browser, caught in the page so none opens (the opener plugin's
 * command, as `openExternal` calls it).
 */
async function catchBrowserLinks(page: Page) {
  // The opener plugin's call reaches the native side as a fetch to `http://ipc.localhost` (as
  // `connectErpDesktop` in ecosystem.ts stands in for the system browser): answered here, its URL
  // kept. Replacing `__TAURI_INTERNALS__.invoke` does not take in WebView2.
  await page.evaluate(() => {
    const w = window as unknown as { __cgwOpened?: string[] };
    if (w.__cgwOpened) return;
    w.__cgwOpened = [];
    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('http://ipc.localhost/plugin%3Aopener%7Copen_url')) {
        try {
          w.__cgwOpened!.push((JSON.parse(String(init?.body ?? '{}')) as { url: string }).url);
        } catch {
          w.__cgwOpened!.push(String(init?.body ?? ''));
        }
        return Promise.resolve(
          new Response('null', {
            headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
          }),
        );
      }
      return original(input, init);
    };
  });
  return () =>
    page.evaluate(() => (window as unknown as { __cgwOpened: string[] }).__cgwOpened ?? []);
}

const redeem = (ticket: string, origin: string) =>
  sheetSession('/redeem', {
    origin,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });

const cloud = signers();
test.afterEach(async () => {
  await cloud.close();
});

test('with Sheet’s app installed, the click hands the system a desktop launch that redeems from the app’s origin', async () => {
  test.setTimeout(300000);
  const folder = mkdtempSync(join(tmpdir(), 'cgw-e2e-sheet-app-'));
  const app = await startApp(folder, 'installed');
  const owner = await newAccount('Desk sheet user');
  const api = await sessionOf(owner);
  try {
    const { page } = app;
    await signedInWorkspace(page, owner, 'Desk space', app.authUrlFile, cloud.signer);
    const workspaceId = await workspaceIdOf(api, 'Desk space');
    const workbookId = await newWorkbook(
      api,
      workspaceId,
      'Desk book',
      workbookOf([
        ['Item', 'Cost'],
        ['Chair', 120],
      ]),
    );
    const browserLinks = await catchBrowserLinks(page);
    await page.goto('/#/workbooks');
    const asked: (string | null)[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith(`/workbooks/${workbookId}/launch`)) asked.push(r.postData());
    });
    await page.getByRole('button', { name: 'Open in Cash Gear Sheet: Desk book' }).click();
    await expect.poll(() => existsSync(app.linkFile), { timeout: 15000 }).toBe(true);
    const link = readFileSync(app.linkFile, 'utf8');
    const ticket = DESKTOP_LINK.exec(link)?.[1];
    expect(ticket, link).toBeTruthy();
    expect(asked.map((body) => JSON.parse(body ?? '{}'))).toEqual([{ target: 'desktop' }]);
    // Nothing went to the browser.
    expect(await browserLinks()).toEqual([]);

    // Sheet's desktop app redeems it from its WebView's origin: the workbook's session.
    const redeemed = await redeem(ticket!, TAURI_ORIGIN);
    expect(redeemed.status).toBe(200);
    const session = (await redeemed.json()) as { workbook: { id: string }; token: string };
    expect(session.workbook.id).toBe(workbookId);
    await sheetSession('/end', {
      origin: TAURI_ORIGIN,
      headers: { 'X-Workspace-File-Session': session.token },
    });

    // Another click, another ticket: tried from Sheet's web origin first, it is used up.
    rmSync(app.linkFile);
    await page.getByRole('button', { name: 'Open in Cash Gear Sheet: Desk book' }).click();
    await expect.poll(() => existsSync(app.linkFile), { timeout: 15000 }).toBe(true);
    const second = DESKTOP_LINK.exec(readFileSync(app.linkFile, 'utf8'))![1];
    expect(second).not.toBe(ticket);
    const fromWeb = await redeem(second, MOCK_SHEET);
    expect(fromWeb.status).toBe(401);
    expect(((await fromWeb.json()) as { code: string }).code).toBe('ticket.invalid');
    expect((await redeem(second, TAURI_ORIGIN)).status).toBe(401);
  } finally {
    await api.dispose();
    await app.stop();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('with Sheet’s app missing, the click opens Sheet’s web app as before', async () => {
  test.setTimeout(300000);
  const folder = mkdtempSync(join(tmpdir(), 'cgw-e2e-sheet-web-'));
  const app = await startApp(folder, 'missing');
  const owner = await newAccount('Web sheet user');
  const api = await sessionOf(owner);
  try {
    const { page } = app;
    await signedInWorkspace(page, owner, 'Web desk space', app.authUrlFile, cloud.signer);
    const workspaceId = await workspaceIdOf(api, 'Web desk space');
    const workbookId = await newWorkbook(api, workspaceId, 'Web book', workbookOf([['A', 1]]));
    await page.goto('/#/workbooks');
    const open = page.getByRole('button', { name: 'Open in Cash Gear Sheet: Web book' });
    await expect(open).toBeVisible({ timeout: 30000 });
    // Caught once the page is loaded: a navigation of the desktop's own may load it afresh.
    const browserLinks = await catchBrowserLinks(page);
    const launched = page.waitForResponse((r) =>
      r.url().endsWith(`/workbooks/${workbookId}/launch`),
    );
    await open.click();
    const answer = await launched;
    expect(answer.request().postData() ?? '').not.toContain('desktop');
    const { url } = (await answer.json()) as { url: string };
    expect(url).toMatch(new RegExp(`^${MOCK_SHEET.replace(/[.:/]/g, '\\$&')}/cloud#launch=`));
    await expect.poll(browserLinks, { timeout: 15000 }).toEqual([url]);
    expect(existsSync(app.linkFile)).toBe(false);
  } finally {
    await api.dispose();
    await app.stop();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

/** The titles of Sheet's desktop app's windows (its process `cgs-desktop`), as Windows has them. */
function sheetWindows(): string[] {
  const listed = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-Process cgs-desktop -ErrorAction SilentlyContinue | ForEach-Object { $_.MainWindowTitle }',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  return listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// The acceptance run (Phase 9): Sheet's real desktop app installed on this machine, built by Track
// S6's notes against this stack (`VITE_WORKSPACE_API_URL=http://127.0.0.1:5280`). No stand-ins:
// the system says the scheme has a handler, the link goes to it, and Sheet redeems the ticket and
// opens the workbook in a window of its own. Run with REAL_SHEET_APP=1.
test('with Sheet’s real app installed, the click opens it on the workbook', async () => {
  test.skip(!process.env.REAL_SHEET_APP, 'Needs Sheet’s desktop app installed (REAL_SHEET_APP=1)');
  test.setTimeout(300000);
  const folder = mkdtempSync(join(tmpdir(), 'cgw-e2e-sheet-real-'));
  const app = await startApp(folder, null);
  const owner = await newAccount('Real Sheet user');
  const api = await sessionOf(owner);
  const name = `Real book ${randomUUID().slice(0, 6)}`;
  try {
    const { page } = app;
    await signedInWorkspace(page, owner, 'Real desk space', app.authUrlFile, cloud.signer);
    const workspaceId = await workspaceIdOf(api, 'Real desk space');
    await newWorkbook(
      api,
      workspaceId,
      name,
      workbookOf([
        ['Item', 'Cost'],
        ['Desk', 300],
      ]),
    );
    await page.goto('/#/workbooks');
    const open = page.getByRole('button', { name: `Open in Cash Gear Sheet: ${name}` });
    await expect(open).toBeVisible({ timeout: 30000 });
    const launched = page.waitForResponse((r) => r.url().includes('/launch'));
    await open.click();
    const answer = await launched;
    expect(answer.request().postData() ?? '').toContain('desktop');
    // Sheet's own window, titled by the workbook it redeemed the ticket for.
    const title = await until(
      'Sheet’s window on the workbook',
      async () => sheetWindows().find((t) => t.includes(name)),
      90000,
    );
    // Sheet writes "<name> – CashGear Sheet"; PowerShell's console output may turn the dash into "-".
    expect(title).toMatch(new RegExp(`^${name} [–-] CashGear Sheet$`));
    expect(existsSync(join(folder, 'sheet-link.txt'))).toBe(false);
  } finally {
    // Sheet's windows closed as a person closes them (each ends its file session).
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-Process cgs-desktop -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }',
      ],
      { windowsHide: true },
    );
    await api.dispose();
    await app.stop();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
