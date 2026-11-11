// Installs, updates and uninstalls the Windows installer as a person would (Phase 1, M1.9; pnpm
// desktop:installer-test, after pnpm build). Adapted from Sheet. It builds the installer twice, a
// version apart, signed with a throwaway certificate and a throwaway updater key, serves the
// second as an update on 127.0.0.1, then:
//   1. installs the first silently into a folder of its own, and checks that its programs are
//      signed with the certificate, that the notices are beside it, and that its link scheme is
//      registered to open the app;
//   2. opens a deep link through the shell, as a click in a browser or a mail does: Windows runs
//      the scheme's open command, and the app starts on the link's route; a second link while it
//      runs goes to the same window (one instance);
//   3. has the top bar offer the update, and installs it from the update dialog;
//   4. checks that the app the installer starts again is the new version;
//   5. uninstalls it silently and checks that nothing is left behind.
// The test builds install as a product of their own, with a link scheme of their own, so they can
// run beside a real install of Cash Gear Workspace and never touch its keys, shortcuts or data.
// Needs the WebView2 Runtime and the Windows SDK (signtool).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { chromium } from '@playwright/test';
import { pnpmCommand, root, run, windowsPowerShell } from './lib.mjs';
import { makeTestCertificate } from './test-certificate.mjs';

if (process.platform !== 'win32') throw new Error('The installer test runs on Windows.');
const product = 'CGW Installer Test';
const identifier = 'com.cashgear.workspace.installertest';
const scheme = 'cgw-installer-test';
const feedPort = 47822;
const started = Date.now();
const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)} s] ${line}`);
// The temp folder's long name: the uninstaller removes the Start menu shortcut only when its
// target matches the install folder exactly, and CI's temp folder is an 8.3 short name.
const work = join(realpathSync.native(tmpdir()), `cgw-installer-${randomBytes(4).toString('hex')}`);
const feed = join(work, 'feed');
const installDir = join(work, 'app');
// The installers, uninstallers and app keep their temporary files in here too: the updater never
// removes its download, nor NSIS its copy of the uninstaller.
const temp = join(work, 'temp');
mkdirSync(feed, { recursive: true });
mkdirSync(temp, { recursive: true });
const tempEnv = { ...process.env, TEMP: temp, TMP: temp };
const results = { versions: [], installer: {}, steps: {} };

const reg = (args) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
const uninstallRoot = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const uninstallKey = `${uninstallRoot}\\${product}`;
// A silent uninstall keeps this key, which records the install folder for the next install.
const publisherKey = `HKCU\\Software\\${product}`;
const schemeKey = `HKCU\\Software\\Classes\\${scheme}`;
const desktop = windowsPowerShell("[Environment]::GetFolderPath('Desktop')");
const shortcuts = [
  join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs', `${product}.lnk`),
  join(desktop, `${product}.lnk`),
];
const dataFolders = [process.env.APPDATA, process.env.LOCALAPPDATA].map((folder) =>
  join(folder, identifier),
);

function uninstallEntry() {
  const query = reg(['query', uninstallKey]);
  if (query.status !== 0) return null;
  return {
    version: query.stdout.match(/DisplayVersion\s+REG_SZ\s+(\S+)/)?.[1] ?? null,
    uninstaller: query.stdout.match(/UninstallString\s+REG_SZ\s+"?([^"\r\n]+)/)?.[1] ?? null,
  };
}

/** A key and everything under it, as reg prints it, or '' when it isn't there. */
const keyDump = (key) => {
  const query = reg(['query', key, '/s']);
  return query.status === 0 ? query.stdout.trim() : '';
};

/** What the person's own setup holds for a real install, which must not change. */
const usersOwn = () =>
  [
    'HKCU\\Software\\Classes\\cashgear-workspace',
    'HKCU\\Software\\CashGear\\Cash Gear Workspace',
    `${uninstallRoot}\\Cash Gear Workspace`,
  ]
    .map((key) => `${key}\n${keyDump(key)}`)
    .join('\n');
const usersOwnBefore = usersOwn();

/** What an install under the test's name has left on this machine. */
const leftBehind = () => [
  ...[uninstallKey, publisherKey, schemeKey].filter((key) => reg(['query', key]).status === 0),
  ...[...shortcuts, ...dataFolders].filter((path) => existsSync(path)),
];

async function until(what, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function freePort() {
  const listener = createNetServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

const appExe = () =>
  join(
    installDir,
    readdirSync(installDir).find((name) => /\.exe$/i.test(name) && !/^uninstall/i.test(name)),
  );

function stopApp() {
  windowsPowerShell(
    `Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${work}') } | Stop-Process -Force -ErrorAction SilentlyContinue`,
  );
}

const forceRemove = (path) =>
  rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });

/** Takes out an install under the test's name, finished or not, this run's or a killed one's. */
async function removeInstall() {
  const uninstaller = uninstallEntry()?.uninstaller;
  stopApp();
  if (uninstaller && existsSync(uninstaller)) {
    spawnSync(`"${uninstaller}" /S`, { shell: true, windowsHide: true, env: tempEnv });
    await until(
      'the uninstaller to finish',
      () => !uninstallEntry() && !existsSync(uninstaller),
      120_000,
    ).catch((error) => log(error.message));
  }
  for (const key of [uninstallKey, publisherKey, schemeKey]) reg(['delete', key, '/f']);
  for (const path of [...shortcuts, ...dataFolders]) await forceRemove(path);
}

/** A killed run's folders. */
async function removeKilledRuns() {
  const parent = dirname(work);
  for (const name of readdirSync(parent)) {
    const path = join(parent, name);
    if (name.startsWith('cgw-installer-') && path !== work) await forceRemove(path);
  }
}

/** Attaches to the app's WebView2 and returns the page once the frame has painted. */
async function attach(port) {
  const endpoint = `http://127.0.0.1:${port}`;
  await until(
    'the app to accept a debugger',
    () =>
      fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) }).then(
        (r) => r.ok,
        () => false,
      ),
    60_000,
  );
  const browser = await chromium.connectOverCDP(endpoint);
  // On a slow machine the webview answers before it has opened its page.
  const context = await until('the webview', () => browser.contexts()[0], 30_000);
  const page = context.pages()[0] ?? (await context.waitForEvent('page', { timeout: 60_000 }));
  await until('the app to load', () => page.url().startsWith('http'), 30_000);
  await page.waitForSelector('.cgw-first-run, .cgw-frame', { timeout: 60_000 });
  return { browser, page };
}

/** The registry's open command for the scheme. */
const openCommand = () =>
  reg(['query', `${schemeKey}\\shell\\open\\command`, '/ve']).stdout.match(/REG_SZ\s+(.+)/)?.[1];

function checkRegistered(exe) {
  const expected = `"${exe}" "%1"`;
  if (openCommand()?.trim() !== expected)
    throw new Error(`${scheme}:// opens with ${openCommand()}, not ${expected}.`);
  if (reg(['query', schemeKey, '/v', 'URL Protocol']).status !== 0)
    throw new Error(`${scheme} is not registered as a URL protocol.`);
}

/** Opens a link through the shell, as a click on it in a browser or mail does. */
function shellOpen(url, env) {
  const childEnv = { ...env };
  for (const name of Object.keys(childEnv))
    if (name.toLowerCase() === 'psmodulepath') delete childEnv[name];
  const ran = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference = 'Stop'; Start-Process '${url.replace(/'/g, "''")}'`,
    ],
    { encoding: 'utf8', env: childEnv, windowsHide: true },
  );
  if (ran.status !== 0) throw new Error(`Opening ${url} failed: ${ran.stdout} ${ran.stderr}`);
}

const policyKey = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';
const hostedRunner =
  process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
let policyName = null;
let server;
try {
  await removeInstall();
  await removeKilledRuns();

  // Two installers a version apart, signed with a throwaway certificate and updater key.
  const certificate = makeTestCertificate(join(work, 'certificate'));
  const keyPath = join(work, 'updater.key');
  const keyPassword = randomBytes(12).toString('hex');
  await run(
    ...pnpmCommand([
      '--filter',
      '@cgw/desktop',
      'tauri',
      'signer',
      'generate',
      '--ci',
      '-w',
      keyPath,
      `--password=${keyPassword}`,
    ]),
    { stdio: 'ignore' },
  );
  const base = JSON.parse(
    readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
  ).version;
  const [major, minor, patch] = base.split('.').map(Number);
  const versions = [base, `${major}.${minor}.${patch + 1}`];
  results.versions = versions;
  const env = {
    ...process.env,
    CGW_TEST_PRODUCT: product,
    CGW_TEST_IDENTIFIER: identifier,
    CGW_TEST_SCHEME: scheme,
    CGW_SIGN_PFX: certificate.pfx,
    CGW_SIGN_PASSWORD: certificate.password,
    CGW_SIGN_TIMESTAMP: '0',
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, 'utf8'),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: keyPassword,
    CGW_UPDATER_PUBKEY: readFileSync(keyPath + '.pub', 'utf8').trim(),
    CGW_UPDATER_URL: `http://127.0.0.1:${feedPort}/latest.json`,
  };
  const bundle = join(root, 'target/release/bundle/nsis');
  const setups = [];
  for (const version of versions) {
    log(`Building the ${version} installer`);
    const building = Date.now();
    await run(process.execPath, [join(root, 'scripts/desktop-installer.mjs')], {
      env: { ...env, CGW_VERSION: version },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const name = `${product}_${version}_x64-setup.exe`;
    copyFileSync(join(bundle, name), join(feed, name));
    copyFileSync(join(bundle, name + '.sig'), join(feed, name + '.sig'));
    setups.push(join(feed, name));
    results.installer[version] = {
      bytes: statSync(join(feed, name)).size,
      buildSeconds: Math.round((Date.now() - building) / 1000),
    };
  }

  // The update feed.
  const update = basename(setups[1]);
  const manifest = {
    version: versions[1],
    notes: 'The installer test update.',
    pub_date: new Date().toISOString(),
    platforms: Object.fromEntries(
      ['windows-x86_64', 'windows-x86_64-nsis'].map((platform) => [
        platform,
        {
          signature: readFileSync(setups[1] + '.sig', 'utf8'),
          url: `http://127.0.0.1:${feedPort}/${encodeURIComponent(update)}`,
        },
      ]),
    ),
  };
  writeFileSync(join(feed, 'latest.json'), JSON.stringify(manifest));
  server = createServer((request, response) => {
    const file = join(
      feed,
      decodeURIComponent(new URL(request.url, 'http://feed').pathname.slice(1)),
    );
    if (!file.startsWith(feed) || !existsSync(file)) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Length': statSync(file).size });
    response.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(feedPort, '127.0.0.1', resolve));

  // 1. Install silently, and check the signatures, the notices and the scheme.
  log(`Installing ${versions[0]} into ${installDir}`);
  let step = Date.now();
  const installed = spawnSync(`"${setups[0]}" /S /D=${installDir}`, {
    shell: true,
    windowsHide: true,
    env: tempEnv,
  });
  if (installed.status !== 0) throw new Error(`The installer failed (${installed.status}).`);
  results.steps.installSeconds = (Date.now() - step) / 1000;
  if (uninstallEntry()?.version !== versions[0])
    throw new Error('The install left no uninstall entry.');
  const files = JSON.parse(
    windowsPowerShell(
      `@(Get-ChildItem -Path '${installDir}' -Recurse -Include *.exe,*.dll | ForEach-Object { ` +
        `$s = Get-AuthenticodeSignature $_.FullName; ` +
        `[pscustomobject]@{ file = $_.FullName.Substring(${installDir.length + 1}); signer = $s.SignerCertificate.Thumbprint } }) | ConvertTo-Json`,
    ),
  );
  const unsigned = [files].flat().filter((file) => file.signer !== certificate.thumbprint);
  results.signedFiles = [files].flat().length;
  if (unsigned.length)
    throw new Error('Unsigned files: ' + unsigned.map((file) => file.file).join(', '));
  const notices = join(installDir, 'licences/THIRD-PARTY-NOTICES.txt');
  if (!existsSync(notices) || !readFileSync(notices, 'utf8').includes('Rust crates ('))
    throw new Error('The install lacks its third-party notices.');
  checkRegistered(appExe());
  results.steps.registeredScheme = `${scheme}://`;
  log(`Installed: ${results.signedFiles} programs, all signed, ${scheme}:// registered`);

  const port = await freePort();
  const profile = join(work, 'webview2');
  const browserArguments = `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`;
  // Elevated WebView2 hosts ignore browser arguments from the environment. On GitHub's disposable
  // runners, which run elevated, the documented policy passes them to our executable only, as the
  // desktop smoke test does.
  if (hostedRunner) {
    policyName = basename(appExe());
    const added = reg([
      'add',
      policyKey,
      '/v',
      policyName,
      '/t',
      'REG_SZ',
      '/d',
      browserArguments,
      '/f',
      '/reg:64',
    ]);
    if (added.status !== 0) {
      policyName = null;
      throw new Error('Could not set the WebView2 test policy: ' + added.stderr);
    }
  }
  // No CGW_DATA_DIR: the test product keeps its store in its own data folder, and runs as one
  // instance, as a real install does.
  const appEnv = {
    ...tempEnv,
    WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArguments,
  };

  // 2. A deep link through the shell starts the app on its route; a second one goes to it.
  step = Date.now();
  shellOpen(`${scheme}://settings`, appEnv);
  let { browser, page } = await attach(port);
  await until(
    'the link to open settings',
    () => page.evaluate(() => location.hash === '#/settings'),
    30_000,
  );
  await page.locator('#cgw-settings-title').waitFor({ timeout: 30_000 });
  results.steps.deepLinkColdSeconds = (Date.now() - step) / 1000;
  step = Date.now();
  shellOpen(`${scheme}://trash`, appEnv);
  await until(
    'the second link to reach the running app',
    () => page.evaluate(() => location.hash === '#/trash'),
    30_000,
  );
  const processes = Number(
    windowsPowerShell(`@(Get-Process | Where-Object { $_.Path -eq '${appExe()}' }).Count`),
  );
  if (processes !== 1) throw new Error(`${processes} copies of the app run after two links.`);
  results.steps.deepLinkRunningSeconds = (Date.now() - step) / 1000;
  log('Deep links opened their routes, the second in the running app');
  await browser.close().catch(() => {});
  stopApp();

  // 3. Start it, and update it from the dialog the top bar offers.
  const start = () =>
    spawn(appExe(), [], { windowsHide: true, env: appEnv, stdio: 'ignore', detached: false });
  const app = start();
  const exited = new Promise((resolve) => app.once('exit', resolve));
  ({ browser, page } = await attach(port));
  const before = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('app_info'));
  if (before.version !== versions[0]) throw new Error(`The installed app is ${before.version}.`);
  // The top bar is drawn once there is a frame: settings has one before any workspace exists.
  await page.evaluate(() => (location.hash = '#/settings'));
  // The first check is 10 s after start.
  await page.getByTestId('update-status').waitFor({ timeout: 60_000 });
  const offered = await page.getByTestId('update-status').textContent();
  if (offered?.trim() !== `Update to ${versions[1]}`)
    throw new Error(`The top bar says ${offered}.`);
  log(`Updating to ${versions[1]}`);
  step = Date.now();
  await page.getByTestId('update-status').click();
  await page.getByTestId('update-install').click();
  await until('the app to close for the installer', () => exited.then(() => true), 120_000);
  await browser.close().catch(() => {});
  await until('the update to install', () => uninstallEntry()?.version === versions[1], 180_000);
  results.steps.updateSeconds = (Date.now() - step) / 1000;

  // 4. The installer starts the new version. It starts it as the desktop's user, which a CI
  // runner's service session may not have: then the test starts it, and records that.
  try {
    ({ browser, page } = await attach(port));
    results.steps.restartedByInstaller = true;
  } catch (error) {
    log(`The installer did not start the app again (${error.message}): starting it`);
    results.steps.restartedByInstaller = false;
    start();
    ({ browser, page } = await attach(port));
  }
  const after = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('app_info'));
  if (after.version !== versions[1])
    throw new Error(`After the update the app is ${after.version}.`);
  results.steps.restartedVersion = after.version;
  checkRegistered(appExe());
  log(`Updated: the app runs as ${after.version}, its scheme still registered`);
  await browser.close().catch(() => {});
  stopApp();

  // 5. Uninstall silently: nothing may be left.
  step = Date.now();
  spawnSync(`"${join(installDir, 'uninstall.exe')}" /S`, {
    shell: true,
    windowsHide: true,
    env: tempEnv,
  });
  await until(
    'the uninstaller to finish',
    () => !uninstallEntry() && !existsSync(join(installDir, 'uninstall.exe')),
    120_000,
  );
  const left = existsSync(installDir) ? readdirSync(installDir) : [];
  if (left.length) throw new Error('The uninstaller left: ' + left.join(', '));
  // Kept by design, and taken by the test afterwards: the install-folder key (the next install
  // goes back there), and the app's data, which only the uninstaller's "Delete the application
  // data" box removes, so pages outlive a reinstall.
  const kept = dataFolders.filter((path) => existsSync(path));
  results.steps.keptAppData = kept.map((path) => ({
    folder: path.replace(identifier, '<identifier>'),
    holds: readdirSync(path),
  }));
  const leftKeys = leftBehind().filter((item) => item !== publisherKey && !kept.includes(item));
  if (leftKeys.length) throw new Error('The uninstaller left: ' + leftKeys.join(', '));
  if (usersOwn() !== usersOwnBefore) throw new Error("A real install's keys changed.");
  results.steps.uninstallSeconds = (Date.now() - step) / 1000;
  log('Uninstalled: nothing left behind');
  mkdirSync(join(root, 'bench/results'), { recursive: true });
  writeFileSync(join(root, 'bench/results/installer-test.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  server?.close();
  if (policyName) reg(['delete', policyKey, '/v', policyName, '/f', '/reg:64']);
  await removeInstall().catch((error) => log(`Removing the install failed: ${error.message}`));
  await forceRemove(work).catch((error) =>
    log(`Removing the temp folder failed: ${error.message}`),
  );
  const left = leftBehind();
  if (existsSync(work)) left.push(work);
  if (usersOwn() !== usersOwnBefore) left.push("changes to a real install's registry keys");
  if (left.length) {
    console.error('The test left behind: ' + left.join(', '));
    process.exitCode = 1;
  }
}
