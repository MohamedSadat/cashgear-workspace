// The e2e specs run in Chrome and Edge, and with CGW_E2E_TARGET=desktop on the built desktop app
// (playwright.desktop.config.ts). On the desktop each test starts target/release/cgw-desktop.exe
// with a data folder and a WebView2 profile of its own and drives its window over CDP; `page`
// is that window, `goto('/…')` goes to the app's own origin, and `restart` closes the app and
// starts it again on the same data, as a person reopening it would.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test as base, type Browser, type Page } from '@playwright/test';

export { expect };
export const desktop = process.env.CGW_E2E_TARGET === 'desktop';
/** One app at a time, on one debugging port (on hosted runners WebView2's policy names it). */
export const DESKTOP_PORT = 9334;
const root = resolve(import.meta.dirname, '../..');

async function until<T>(what: string, check: () => Promise<T | undefined | false>, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out: ' + what);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** One run of the desktop app: its process, its window, and how to stop it. */
class DesktopApp {
  child!: ChildProcess;
  browser!: Browser;
  page!: Page;
  constructor(
    readonly folder: string,
    readonly port: number,
  ) {}

  async start(): Promise<Page> {
    const args = `--remote-debugging-port=${this.port} --remote-debugging-address=127.0.0.1`;
    this.child = spawn(join(root, 'target/release/cgw-desktop.exe'), [], {
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        WEBVIEW2_USER_DATA_FOLDER: join(this.folder, 'webview2'),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: args,
        CGW_DATA_DIR: join(this.folder, 'data'),
        CGW_SAVE_DIR: join(this.folder, 'saved'),
      },
    });
    const endpoint = `http://127.0.0.1:${this.port}`;
    await until(
      'the app to accept a debugger',
      async () =>
        (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })).ok,
      60000,
    );
    this.browser = await chromium.connectOverCDP(endpoint);
    const context = await until('the webview', async () => this.browser.contexts()[0], 30000);
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    await until('the app to load', async () => page.url().startsWith('http'), 30000);
    const origin = new URL(page.url()).origin;
    // Paths go to the app's own origin, as baseURL does in a browser.
    const goto = page.goto.bind(page);
    page.goto = (url, options) => goto(url.startsWith('/') ? origin + url : url, options);
    this.page = page;
    return page;
  }

  async stop() {
    await this.browser?.close().catch(() => {});
    if (this.child?.pid)
      spawnSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true });
    await new Promise((r) => setTimeout(r, 800));
  }
}

export interface Fixtures {
  /**
   * Opens the app again on the same data: a new tab in a browser, the app started again on the
   * desktop. With `fresh`, on new data instead.
   */
  restart(options?: { fresh?: boolean }): Promise<Page>;
  /** Where the desktop app saves files in tests (CGW_SAVE_DIR); null in a browser. */
  savedFolder: string | null;
}

let app: DesktopApp | null = null;

type Use<T> = (value: T) => Promise<void>;

/** The desktop's window as `page`: no browser is started. */
// eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's needs from this pattern
async function desktopPage({}: object, use: Use<Page>) {
  const folder = mkdtempSync(join(tmpdir(), 'cgw-e2e-desktop-'));
  app = new DesktopApp(folder, DESKTOP_PORT);
  try {
    await use(await app.start());
  } finally {
    await app.stop();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    app = null;
  }
}

async function desktopRestart({ page }: { page: Page }, use: Use<Fixtures['restart']>) {
  void page;
  await use(async ({ fresh } = {}) => {
    const current = app!;
    await current.stop();
    if (fresh) rmSync(join(current.folder, 'data'), { recursive: true, force: true });
    return current.start();
  });
}

async function browserRestart(
  { page, context }: { page: Page; context: import('@playwright/test').BrowserContext },
  use: Use<Fixtures['restart']>,
) {
  await use(async ({ fresh } = {}) => {
    if (fresh) {
      await page.evaluate(async () => {
        localStorage.clear();
        await new Promise<void>((done) => {
          const request = indexedDB.deleteDatabase('cgw-workspace');
          request.onsuccess = request.onerror = request.onblocked = () => done();
        });
      });
      return page;
    }
    await page.close();
    return context.newPage();
  });
}

export const test = (
  desktop
    ? base.extend<Fixtures>({
        page: desktopPage as never,
        restart: desktopRestart as never,
        savedFolder: async ({ page }, use) => {
          void page;
          await use(join(app!.folder, 'saved'));
        },
      })
    : base.extend<Fixtures>({
        restart: browserRestart as never,
        // eslint-disable-next-line no-empty-pattern -- as above
        savedFolder: async ({}, use) => use(null),
      })
) as ReturnType<typeof base.extend<Fixtures>>;
