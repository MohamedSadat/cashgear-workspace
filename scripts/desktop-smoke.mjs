// Launches the release desktop build, attaches Playwright to its WebView2 over CDP and checks
// what the browser smoke checks: the shell renders its settings in light, dark, English and
// Arabic; the window's own theme follows the page; the page is not cross-origin isolated (no
// COEP); and the CSP refused nothing. Adapted from cashgear-sheet.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { root } from './lib.mjs';

const appVersion = JSON.parse(
  await readFile(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
).version;

if (process.platform !== 'win32') throw new Error('The desktop smoke test targets Windows.');
const runtimeKeys = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
];
const runtimeVersion = runtimeKeys
  .map(
    (key) =>
      spawnSync('reg', ['query', key, '/v', 'pv'], {
        encoding: 'utf8',
        windowsHide: true,
      }).stdout?.match(/REG_SZ\s+([\d.]+)/)?.[1],
  )
  .find((version) => version && version !== '0.0.0.0');
if (!runtimeVersion)
  throw new Error('WebView2 Runtime is missing. Run scripts/setup-webview2.ps1 first.');
console.log('WebView2 Runtime: ' + runtimeVersion);

const listener = createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const profilePrefix = join(tmpdir(), 'cgw-webview2-smoke-');
const profile = await mkdtemp(profilePrefix);
const browserArguments =
  '--remote-debugging-port=' + port + ' --remote-debugging-address=127.0.0.1';
// Elevated WebView2 hosts ignore environment browser arguments. Use the documented HKLM override
// only on disposable GitHub-hosted runners, scoped to our executable.
// https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags
const policyKey = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';
const policyName = 'cgw-desktop.exe';
const hostedRunner =
  process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
let previousPolicy;
const reg = (args) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
const setPolicy = (value) =>
  reg(['add', policyKey, '/v', policyName, '/t', 'REG_SZ', '/d', value, '/f', '/reg:64']);
if (hostedRunner) {
  const existing = reg(['query', policyKey, '/v', policyName, '/reg:64']);
  if (existing.status === 0) {
    previousPolicy = existing.stdout.match(/REG_SZ\s+(.+)/)?.[1];
    if (previousPolicy === undefined) throw new Error('Unexpected existing WebView2 test policy');
  }
  const added = setPolicy(browserArguments);
  if (added.status !== 0)
    throw new Error('Could not configure WebView2 test policy: ' + added.stderr);
}

/** What the app's CSP refused, from the console. The smoke fails on any. */
const policyViolations = [];
const pageErrors = [];

async function launch() {
  const child = spawn(join(root, 'target/release/cgw-desktop.exe'), [], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArguments,
    },
    stdio: 'inherit',
  });
  let launchError;
  child.on('error', (error) => {
    launchError = error;
  });
  const started = Date.now();
  const endpoint = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 45000;
  while (true) {
    if (launchError) throw launchError;
    if (child.exitCode !== null)
      throw new Error('Desktop exited before debugging was ready: ' + child.exitCode);
    try {
      const response = await fetch(endpoint + '/json/version', {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) break;
    } catch {
      /* Wait for WebView2 to create its debugging endpoint. */
    }
    if (Date.now() > deadline) throw new Error('WebView2 debugging endpoint timed out');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  let browser;
  while (!browser) {
    try {
      browser = await chromium.connectOverCDP(endpoint);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  page.on('pageerror', (error) => {
    console.error('Page error: ' + error.message);
    pageErrors.push(error.message);
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    console.error('Console error: ' + message.text());
    if (message.text().includes('Content Security Policy')) policyViolations.push(message.text());
    else pageErrors.push(message.text());
  });
  return { child, browser, page, started };
}

const windowTheme = (page) =>
  page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|theme', { label: 'main' }));

let app;
try {
  app = await launch();
  const { page } = app;
  // The window starts loading the app before the debugger attaches: wait for the frame first.
  await expect(page.locator('.cgw-frame')).toBeVisible({ timeout: 30000 });
  await page.evaluate(() => {
    location.hash = '#/settings';
  });
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible({
    timeout: 30000,
  });
  const results = {
    runtimeVersion,
    browser: app.browser.version(),
    url: page.url(),
    startToHeadingMs: Date.now() - app.started,
  };
  await expect(page.getByTestId('host-info')).toHaveText(`Desktop Version ${appVersion}`);
  if (await page.evaluate(() => crossOriginIsolated))
    throw new Error('The desktop page is cross-origin isolated; Workspace sends no COEP.');
  results.crossOriginIsolated = false;

  const html = page.locator('html');
  const theme = page.getByRole('group', { name: 'Theme' });
  for (const [label, value] of [
    ['Light', 'light'],
    ['Dark', 'dark'],
  ]) {
    await theme.getByRole('radio', { name: label }).check();
    await expect(html).toHaveAttribute('data-cg-theme', value);
    await expect.poll(() => windowTheme(page), { timeout: 10000 }).toBe(value);
  }
  results.windowTheme = 'follows the page';

  await page
    .getByRole('group', { name: 'Language' })
    .getByRole('radio', { name: 'العربية' })
    .check();
  await expect(html).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'الإعدادات' })).toBeVisible();
  await expect(page.getByTestId('host-info')).toHaveText(`سطح المكتب الإصدار ${appVersion}`);
  results.arabic = 'rtl';

  await mkdir(join(root, 'bench/results'), { recursive: true });
  await page.screenshot({ path: join(root, 'bench/results/desktop-dark-arabic.png') });

  if (policyViolations.length)
    throw new Error('The CSP refused: ' + [...new Set(policyViolations)].join(' | '));
  if (pageErrors.length) throw new Error('The page logged errors: ' + pageErrors.join(' | '));
  await writeFile(
    join(root, 'bench/results/desktop-smoke.json'),
    JSON.stringify(results, null, 2) + '\n',
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await app?.browser.close().catch((error) => {
    console.error('Could not close the desktop browser: ' + error.message);
    process.exitCode = 1;
  });
  app?.child.kill();
  if (hostedRunner) {
    const restored =
      previousPolicy === undefined
        ? reg(['delete', policyKey, '/v', policyName, '/f', '/reg:64'])
        : setPolicy(previousPolicy);
    if (restored.status !== 0) {
      console.error('Could not restore WebView2 test policy: ' + restored.stderr);
      process.exitCode = 1;
    }
  }
  if (profile.startsWith(profilePrefix))
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(
      (error) => console.warn('Temporary folder cleanup: ' + error.message),
    );
}
