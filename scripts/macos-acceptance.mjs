// The macOS acceptance run (Phase 3, M3.6; .github/workflows/macos.yml) on GitHub's macOS runner,
// for "The macOS app installs, signs in, edits offline and syncs". It builds the app twice, a
// version apart, with the test-only bridge (cargo feature e2e-bridge: WKWebView has no debugging
// port, so the run drives the window through apps/desktop/src-tauri/src/bridge.rs) and a
// throwaway updater key, then, as a person would:
//   1. installs the first build from its DMG into an Applications folder of its own, and checks
//      it: signed (ad-hoc), the cashgear-workspace:// scheme registered to this copy;
//   2. starts it (with `open`, through LaunchServices) on a data folder of its own and with no
//      server reachable: the first run makes a workspace, a new page is typed into and is Saved;
//   3. quits and starts again: the text is there; types more and presses ⌘Q at once (System
//      Events keystrokes; where the runner cannot press keys, the bridge runs the Quit menu
//      item's handler a moment after typing): the app menu's Quit writes pending saves first, so
//      the last text typed is there after the next start;
//   4. makes another page and types into it, still with no server reachable;
//   5. opens cashgear-workspace://p/<id> with `open` while the app is not running (it starts on
//      that page) and while it runs (the window goes there; still one process);
//   6. the keychain: signs in with the native sign-in against a stand-in token endpoint on
//      127.0.0.1 (the authorise page is the browser's part, so the run answers the app's loopback
//      callback itself), finds the refresh token in the login keychain under a test service, in
//      two parts; after a restart the app refreshes with exactly that token, read back from the
//      keychain; signing out revokes it and leaves nothing behind;
//   7. updates from a feed on 127.0.0.1 to the second build, through the update the top bar
//      offers: the app replaces itself, starts again as the new version, and has its pages;
//   8. with CGW_MACOS_API_BASE, CGW_MACOS_TEST_EMAIL and CGW_MACOS_TEST_PASSWORD (the deployed
//      API and a CI test account): a build for that API signs in through the API's own page in a
//      browser (Playwright, as tests/e2e/desktop-cloud.spec.ts does), uploads a workspace written
//      offline, makes a page while the API is blocked, and is Synced once it is reachable again.
//      Without them the results say "skipped: no deployed API configured".
// Results go to bench/results/macos-acceptance.json, with screenshots and the app's logs beside
// it. The run installs the real bundle identifier and link scheme, so it runs only on a disposable
// Mac: GitHub's runner, or one named with --scratch-mac.
//   node scripts/macos-acceptance.mjs [--scratch-mac]   (after pnpm build)
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { resolve4, resolve6 } from 'node:dns/promises';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createConnection, createServer as createNetServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pnpmCommand, root, run } from './lib.mjs';
import { BRIDGE_MARKERS, Bridge, newToken } from './macos-bridge.mjs';
import { buildMac } from './macos-build.mjs';

export const EDITOR = '.cgw-page .cgw-editor';
export const TITLE = { label: 'Page title' };
export const SAVE_STATUS = { testId: 'save-status' };
export const SYNC_STATUS = { testId: 'sync-status' };
/** The stand-in token endpoint's port; test builds may sign in there (CGW_API_BASES). */
export const STAND_IN_PORT = 47380;
export const STAND_IN = `http://127.0.0.1:${STAND_IN_PORT}`;
/** The page's own API in a test build: nothing listens there, so no server is reachable. */
const TEST_BASES = ['http://127.0.0.1:5280', 'http://localhost:5280', STAND_IN];
const KEYCHAIN_SERVICE = 'com.cashgear.workspace.e2e';
const SCHEME = 'cashgear-workspace';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const literal = (text) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const pnpm = (args) => (process.env.npm_execpath ? pnpmCommand(args) : ['pnpm', args]);

async function until(what, check, timeoutMs = 30_000, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms: ${what}`);
    await sleep(everyMs);
  }
}

async function freePort() {
  const listener = createNetServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

/** Whether anything accepts a connection on 127.0.0.1 at that port. */
export const listening = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

// -----------------------------------------------------------------------------------------------
// What a person does in the window (the bridge's page helpers, scripts/macos-bridge.mjs)

/** Waits for the app's first screen: the first-run form or the frame. */
export function ready(app, timeoutMs = 60_000) {
  return app.until(
    'the app to draw its first screen',
    () =>
      document.readyState === 'complete' &&
      !!document.querySelector('.cgw-first-run, .cgw-frame') &&
      location.href,
    [],
    { timeoutMs },
  );
}

/** The first run: a new workspace, which opens on its Getting started page. */
export async function createWorkspace(app, name) {
  await app.waitFor('#cgw-workspace-name', { timeoutMs: 30_000 });
  await app.fill('#cgw-workspace-name', name);
  await app.click({ role: 'button', name: 'Create workspace' });
  await app.waitFor(EDITOR, { timeoutMs: 30_000 });
  await app.waitForText(TITLE, 'Getting started', { timeoutMs: 30_000 });
}

/** A new page in the first section, titled, with the caret in its body; returns its id. */
export async function newPage(app, title) {
  const before = await app.hash();
  await app.click({ role: 'button', name: { source: '^Add a page in', flags: '' } });
  const id = await app.until(
    'the new page to open',
    (lib, before) => {
      const match = location.hash.match(/^#\/p\/([0-9a-f-]{36})$/);
      return match && location.hash !== before ? match[1] : false;
    },
    [before],
  );
  await app.waitForText(TITLE, '');
  await app.fill(TITLE, title);
  // Enter in the title moves the caret to the page's first block.
  await app.press('Enter');
  await app.until(
    'the caret to move into the page',
    (lib, css) => !!document.activeElement?.closest(css),
    [EDITOR],
  );
  return id;
}

/** Types where the caret is, and waits for the text and then for "Saved". */
export async function typeAndSave(app, text) {
  await app.type(text);
  await app.waitForText(EDITOR, literal(text), { timeoutMs: 15_000 });
  await app.waitForText(SAVE_STATUS, 'Saved', { timeoutMs: 30_000 });
}

/** Opens a page by its route and waits for its text. */
export async function openPage(app, id, text) {
  await app.evaluate((id) => {
    if (location.hash !== '#/p/' + id) location.hash = '#/p/' + id;
    return true;
  }, id);
  await app.waitForText(EDITOR, literal(text), { timeoutMs: 30_000 });
}

/** The sync status as the top bar shows it, or null. */
export const syncStatus = (app) =>
  app.page((lib, spec) => {
    const [el] = lib.all(spec);
    return el ? lib.words(el.textContent) : null;
  }, SYNC_STATUS);

// -----------------------------------------------------------------------------------------------
// The stand-in token endpoint (Identity's /connect/token and /connect/revoke, as the app uses them)

export async function standInAuth(port = STAND_IN_PORT) {
  const state = {
    code: 'e2e-code-' + randomBytes(8).toString('hex'),
    expected: null,
    issued: [],
    exchanges: [],
    refreshes: [],
    revoked: [],
    other: 0,
  };
  // A first refresh token longer than one Windows credential holds, so it is kept in two parts.
  const long = () => 'refresh-1-' + randomBytes(2400).toString('base64url').slice(0, 2990);
  const short = () => `refresh-${state.issued.length + 1}-` + randomBytes(24).toString('hex');
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://stand-in');
    if (request.method !== 'POST' || !url.pathname.startsWith('/connect/')) {
      // Not this stand-in's: as if no server answered.
      state.other += 1;
      request.socket.destroy();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const form = new URLSearchParams(body);
      const reply = (status, json) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(json));
      };
      if (url.pathname === '/connect/revoke') {
        state.revoked.push(form.get('token'));
        return reply(200, {});
      }
      if (url.pathname !== '/connect/token' || form.get('client_id') !== 'cgw-desktop')
        return reply(400, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        const challenge = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url');
        const ok =
          !!state.expected &&
          form.get('code') === state.code &&
          challenge === state.expected.challenge &&
          form.get('redirect_uri') === state.expected.redirect;
        state.exchanges.push({ ok, pkce: challenge === state.expected?.challenge });
        if (!ok) return reply(400, { error: 'invalid_grant' });
        state.issued.push(long());
        return reply(200, {
          access_token: 'access-1',
          refresh_token: state.issued.at(-1),
          token_type: 'Bearer',
          expires_in: 900,
        });
      }
      if (form.get('grant_type') === 'refresh_token') {
        const given = form.get('refresh_token');
        state.refreshes.push(given);
        if (given !== state.issued.at(-1)) return reply(400, { error: 'invalid_grant' });
        state.issued.push(short());
        return reply(200, {
          access_token: `access-${state.issued.length}`,
          refresh_token: state.issued.at(-1),
          token_type: 'Bearer',
          expires_in: 900,
        });
      }
      return reply(400, { error: 'unsupported_grant_type' });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    state,
    expect: (challenge, redirect) => (state.expected = { challenge, redirect }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * The native sign-in, as "Sign in to sync" starts it, against the stand-in. The app writes the
 * authorise URL to CGW_AUTH_URL_FILE instead of opening a browser; the run then does what the
 * server's page would, sending the browser to the app's loopback listener with a code.
 */
export async function nativeSignIn(app, auth, authUrlFile) {
  rmSync(authUrlFile, { force: true });
  await app.evaluate((base) => {
    window.__cgwSignIn = window.__TAURI_INTERNALS__
      .invoke('auth_sign_in', {
        apiBase: base,
        language: 'en',
        deviceName: null,
      })
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error: JSON.stringify(error) }),
      );
    return true;
  }, STAND_IN);
  await until('the authorise URL', () => existsSync(authUrlFile), 15_000);
  const authorize = new URL(readFileSync(authUrlFile, 'utf8').trim());
  const query = Object.fromEntries(authorize.searchParams);
  if (authorize.origin + authorize.pathname !== `${STAND_IN}/connect/authorize`)
    throw new Error(`The app sent the browser to ${authorize.origin}${authorize.pathname}`);
  if (query.client_id !== 'cgw-desktop' || query.code_challenge_method !== 'S256')
    throw new Error('The authorise URL is not the code flow with PKCE: ' + authorize.search);
  auth.expect(query.code_challenge, query.redirect_uri);
  const callback = new URL(query.redirect_uri);
  if (callback.hostname !== '127.0.0.1') throw new Error('The callback is not on 127.0.0.1');
  callback.searchParams.set('code', auth.state.code);
  callback.searchParams.set('state', query.state);
  const page = await (await fetch(callback)).text();
  const signedIn = await app.evaluate(() => window.__cgwSignIn);
  if (!signedIn?.ok || signedIn.value !== true)
    throw new Error('The sign-in did not finish: ' + JSON.stringify(signedIn));
  return {
    deviceName: query.device_name,
    language: query.ui_locales,
    callbackPage: /You are signed in/.test(page),
  };
}

// -----------------------------------------------------------------------------------------------
// macOS

/** Runs a command; none may hang the run (a system prompt no one answers, say). */
const sh = (command, args, options = {}) => {
  const ran = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options });
  return { status: ran.status, out: `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim() };
};
const must = (command, args, options) => {
  const ran = sh(command, args, options);
  if (ran.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${ran.out}`);
  return ran.out;
};
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const plistOf = (app) =>
  JSON.parse(must('plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')]));
/** The app LaunchServices opens a URL with, as a click on a link does. */
const handlerOf = (url) =>
  sh('osascript', [
    '-l',
    'JavaScript',
    '-e',
    'ObjC.import("AppKit"); function run(argv) { const app = $.NSWorkspace.sharedWorkspace' +
      '.URLForApplicationToOpenURL($.NSURL.URLWithString(argv[0])); return app.isNil() ? "" : ' +
      'ObjC.unwrap(app.path); }',
    url,
  ]).out;
const inKeychain = (account) =>
  sh('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account]).status === 0;
const sudo = (args, input) => must('sudo', ['-n', ...args], input ? { input } : {});

/** Keeps a host unreachable for new connections, until remove(): the hosts file and pf. */
async function block(host) {
  const addresses = [
    ...(await resolve4(host).catch(() => [])),
    ...(await resolve6(host).catch(() => [])),
  ];
  const mark = '# cgw-macos-acceptance';
  sudo([
    'sh',
    '-c',
    `printf '\\n127.0.0.1 ${host} ${mark}\\n::1 ${host} ${mark}\\n' >> /etc/hosts`,
  ]);
  const flush = () => {
    sh('sudo', ['-n', 'dscacheutil', '-flushcache']);
    sh('sudo', ['-n', 'killall', '-HUP', 'mDNSResponder']);
  };
  flush();
  // An anchor under com.apple/, which macOS's own pf.conf already evaluates.
  let token = null;
  if (addresses.length) {
    sudo(
      ['pfctl', '-a', 'com.apple/cgw-macos-acceptance', '-f', '-'],
      `block drop out quick proto tcp from any to { ${addresses.join(' ')} }\n`,
    );
    token = sh('sudo', ['-n', 'pfctl', '-E']).out.match(/Token : (\d+)/)?.[1] ?? null;
  }
  return {
    addresses,
    remove() {
      sh('sudo', ['-n', 'sed', '-i', '', `/${mark}$/d`, '/etc/hosts']);
      flush();
      if (addresses.length) {
        sh('sudo', ['-n', 'pfctl', '-a', 'com.apple/cgw-macos-acceptance', '-F', 'all']);
        if (token) sh('sudo', ['-n', 'pfctl', '-X', token]);
      }
    },
  };
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('The macOS acceptance run runs on a Mac.');
  if (process.env.GITHUB_ACTIONS !== 'true' && !process.argv.includes('--scratch-mac'))
    throw new Error(
      'This installs the real bundle identifier and link scheme and drives the login keychain: ' +
        'run it on a disposable Mac (GitHub runner), or pass --scratch-mac.',
    );
  const started = Date.now();
  const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)} s] ${line}`);
  const out = join(root, 'bench/results');
  const shots = join(out, 'macos-acceptance');
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  // The runner's own temp folder, a plain folder in its home (else the system's).
  const work = join(
    realpathSync(process.env.RUNNER_TEMP ?? tmpdir()),
    `cgw-macos-${randomBytes(4).toString('hex')}`,
  );
  const apps = join(work, 'Applications');
  const logs = join(shots, 'logs');
  for (const dir of [apps, logs, join(work, 'feed')]) mkdirSync(dir, { recursive: true });
  const conf = JSON.parse(
    readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
  );
  const results = {
    runner: {
      macos: sh('sw_vers', ['-productVersion']).out,
      arch: sh('uname', ['-m']).out,
      cpus: sh('sysctl', ['-n', 'hw.ncpu']).out,
    },
    builds: {},
    install: {},
    steps: {},
    deployed: null,
    screenshots: [],
  };
  const shot = (name) => {
    const file = join(shots, `${name}.png`);
    const ran = sh('screencapture', ['-x', '-t', 'png', file], { timeout: 15_000 });
    if (ran.status === 0 && existsSync(file) && statSync(file).size > 0)
      results.screenshots.push(relative(root, file));
    else results.screenshotError ??= ran.out || `screencapture exit ${ran.status}`;
  };

  const token = newToken();
  const bridgePort = await freePort();
  const feedPort = await freePort();
  const authUrlFile = join(work, 'authorize-url.txt');
  let appPath = null;
  let exe = null;
  let app = null;
  let feed = null;
  let auth = null;
  let mount = null;
  let blocked = null;
  let logFlags = true;
  let launches = 0;
  const pids = () =>
    exe ? sh('pgrep', ['-f', exe]).out.split('\n').filter(Boolean).map(Number) : [];
  const settings = (dataDir) =>
    writeFileSync(
      join(apps, 'cgw-e2e-settings.json'),
      JSON.stringify(
        {
          CGW_E2E_BRIDGE_PORT: String(bridgePort),
          CGW_E2E_BRIDGE_TOKEN: token,
          CGW_DATA_DIR: dataDir,
          CGW_SAVE_DIR: join(work, 'saved'),
          CGW_AUTH_URL_FILE: authUrlFile,
          CGW_KEYCHAIN_SERVICE: KEYCHAIN_SERVICE,
        },
        null,
        2,
      ),
    );

  /** Starts the app through LaunchServices (`open`), as the Finder or a link does. */
  async function start(openArgs, waitMs = 90_000) {
    const file = join(logs, `launch-${++launches}.log`);
    writeFileSync(file, '');
    let ran = logFlags ? sh('open', ['--stdout', file, '--stderr', file, ...openArgs]) : null;
    if (!ran || ran.status !== 0) {
      logFlags = false;
      ran = sh('open', openArgs);
    }
    if (ran.status !== 0) throw new Error(`open ${openArgs.join(' ')} failed: ${ran.out}`);
    const bridge = await Bridge.connect(bridgePort, token, { timeoutMs: waitMs });
    await ready(bridge, waitMs);
    return bridge;
  }

  /** Closes the window as its close button does, and waits for the app to end. */
  async function quit(bridge) {
    await bridge?.quit().catch(() => {});
    bridge?.close();
    const ended = await until('the app to end', () => pids().length === 0, 30_000).catch(
      () => false,
    );
    if (!ended) {
      for (const pid of pids()) sh('kill', ['-9', String(pid)]);
      await sleep(1000);
      return false;
    }
    return true;
  }

  try {
    // Builds: the version installed, and the next one, which the feed offers.
    log('Making a throwaway updater key');
    const keyPath = join(work, 'updater.key');
    const keyPassword = randomBytes(12).toString('hex');
    await run(
      ...pnpm([
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
    const buildEnv = {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, 'utf8'),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: keyPassword,
    };
    const [major, minor, patch] = conf.version.split('.').map(Number);
    const next = `${major}.${minor}.${patch + 1}`;
    const common = {
      bridge: true,
      quick: true,
      apiBases: TEST_BASES,
      updaterUrl: `http://127.0.0.1:${feedPort}/latest.json`,
      updaterPubkey: readFileSync(keyPath + '.pub', 'utf8').trim(),
      env: buildEnv,
    };
    log(`Building ${conf.version} with the test-only bridge`);
    const first = await buildMac({ ...common, bundles: ['app', 'dmg'] });
    const dmg = join(work, basename(first.dmg));
    copyFileSync(first.dmg, dmg);
    const builtExe = join(first.app, 'Contents/MacOS', plistOf(first.app).CFBundleExecutable);
    const program = readFileSync(builtExe);
    results.builds.first = {
      version: first.version,
      seconds: first.seconds,
      dmgBytes: first.dmgBytes,
      // The release check (scripts/macos-verify.mjs) looks for these: here they must be found.
      bridgeMarkers: BRIDGE_MARKERS.filter((marker) => program.includes(Buffer.from(marker))),
    };
    if (results.builds.first.bridgeMarkers.length !== BRIDGE_MARKERS.length)
      throw new Error(
        "The test build lacks the bridge's names, so the release check proves nothing.",
      );
    // Only the installed copy may claim the scheme: LaunchServices could prefer another.
    sh(LSREGISTER, ['-u', first.app]);
    rmSync(first.app, { recursive: true, force: true });
    log(`Building ${next}, the update`);
    const second = await buildMac({ ...common, version: next, bundles: ['app'] });
    if (!second.update) throw new Error('The second build made no update.');
    const update = `Cash-Gear-Workspace_${next}.app.tar.gz`;
    copyFileSync(second.update.tarball, join(work, 'feed', update));
    sh(LSREGISTER, ['-u', second.app]);
    rmSync(second.app, { recursive: true, force: true });
    results.builds.second = {
      version: next,
      seconds: second.seconds,
      updateBytes: statSync(second.update.tarball).size,
    };
    const entry = {
      signature: second.update.signature,
      url: `http://127.0.0.1:${feedPort}/${update}`,
    };
    writeFileSync(
      join(work, 'feed/latest.json'),
      JSON.stringify({
        version: next,
        notes: 'The macOS acceptance run’s update.',
        pub_date: new Date().toISOString(),
        platforms: { 'darwin-aarch64': entry, 'darwin-x86_64': entry },
      }),
    );

    // 1. Install from the DMG, as a person drags the app to Applications.
    log('Installing from the DMG');
    let step = Date.now();
    mount = join(work, 'mount');
    must('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg]);
    const bundleName = readdirSync(mount).find((name) => name.endsWith('.app'));
    if (!bundleName) throw new Error('The DMG holds no app.');
    results.install.dmgHasApplicationsLink = existsSync(join(mount, 'Applications'));
    appPath = join(apps, bundleName);
    must('ditto', [join(mount, bundleName), appPath]);
    must('hdiutil', ['detach', mount]);
    mount = null;
    must(LSREGISTER, ['-f', appPath]);
    const plist = plistOf(appPath);
    exe = join(appPath, 'Contents/MacOS', plist.CFBundleExecutable);
    const schemes = (plist.CFBundleURLTypes ?? []).flatMap((type) => type.CFBundleURLSchemes ?? []);
    if (!schemes.includes(SCHEME))
      throw new Error(`The bundle registers ${schemes}, not ${SCHEME}.`);
    const verified = sh('codesign', ['--verify', '--deep', '--strict', appPath]);
    if (verified.status !== 0) throw new Error('The installed app fails codesign: ' + verified.out);
    const handler = await until(
      'LaunchServices to know the scheme',
      () => {
        const found = handlerOf(`${SCHEME}://`);
        return found && realpathSync(found) === realpathSync(appPath) ? found : null;
      },
      30_000,
    ).catch(() => null);
    if (!handler)
      throw new Error(
        `${SCHEME}:// opens ${handlerOf(`${SCHEME}://`) || 'nothing'}, not ${appPath}`,
      );
    Object.assign(results.install, {
      seconds: (Date.now() - step) / 1000,
      identifier: plist.CFBundleIdentifier,
      version: plist.CFBundleShortVersionString,
      minimumMacos: plist.LSMinimumSystemVersion,
      signature: /Signature=adhoc/.test(sh('codesign', ['-dv', appPath]).out) ? 'ad-hoc' : 'other',
      schemeOpens: 'this copy',
    });
    log(`Installed ${appPath}; ${SCHEME}:// opens it`);

    // 2. First start, with no server reachable: a workspace, a page, typed into and saved.
    if (await listening(5280)) throw new Error('Something listens on 127.0.0.1:5280.');
    rmSync(join(homedir(), 'Library/WebKit', plist.CFBundleIdentifier), {
      recursive: true,
      force: true,
    });
    settings(join(work, 'data'));
    step = Date.now();
    app = await start(['-a', appPath]);
    results.steps.firstStart = {
      seconds: (Date.now() - step) / 1000,
      title: await app.title(),
      version: (await app.invoke('app_info')).version,
    };
    await createWorkspace(app, 'macOS acceptance');
    const offline = { text: 'Typed on macOS with no server reachable' };
    offline.id = await newPage(app, 'Offline notes');
    await typeAndSave(app, offline.text);
    results.steps.firstPage = {
      saved: true,
      serverReachable: await listening(5280),
      syncStatus: await syncStatus(app),
    };
    shot('1-first-page');
    log('First run: a workspace and a saved page');

    // 3. Quit and start again: the page is there.
    results.steps.quitGracefully = await quit(app);
    step = Date.now();
    app = await start(['-a', appPath]);
    await openPage(app, offline.id, offline.text);
    results.steps.restart = { seconds: (Date.now() - step) / 1000, textKept: true };
    log('Started again: the text is there');

    // 3b. ⌘Q straight after typing: the menu's Quit closes the window, which writes pending saves.
    step = Date.now();
    const lastWords = ' then Command-Q at once';
    await app.caretAtEnd(EDITOR);
    must('open', ['-a', appPath]); // To the front, for the keystrokes.
    await sleep(1000);
    const keys = (lines) =>
      sh(
        'osascript',
        lines.flatMap((line) => ['-e', `tell application "System Events" to ${line}`]),
        {
          timeout: 30_000,
        },
      );
    // Whether System Events may press keys here, and they reach the editor.
    const probe = ' typed by System Events';
    const probed = keys([`keystroke ${JSON.stringify(probe)}`]);
    const reached =
      probed.status === 0 &&
      (await app
        .waitForText(EDITOR, literal(offline.text + probe), { timeoutMs: 5000 })
        .then(() => true)
        .catch(() => false));
    const commandQ = {};
    if (reached) {
      await app.waitForText(SAVE_STATUS, 'Saved');
      // The words and ⌘Q in one go: no pause after the last key.
      const pressed = keys([
        `keystroke ${JSON.stringify(lastWords)}`,
        'keystroke "q" using command down',
      ]);
      if (pressed.status !== 0) throw new Error('System Events could not press ⌘Q: ' + pressed.out);
      commandQ.by = 'System Events keystrokes and ⌘Q';
    } else {
      commandQ.systemEvents = probed.out || 'the keystrokes did not reach the editor';
      await app.type(lastWords, 0);
      commandQ.saveStatusAtQuit = await app.text(SAVE_STATUS);
      await app.menu('quit');
      commandQ.by = "the bridge: the Quit menu item's handler, just after typing";
    }
    app.close();
    if (
      !(await until('the app to end after ⌘Q', () => pids().length === 0, 30_000).catch(
        () => false,
      ))
    )
      throw new Error('The app did not end after ⌘Q.');
    app = await start(['-a', appPath]);
    await openPage(app, offline.id, lastWords);
    await openPage(app, offline.id, offline.text);
    results.steps.commandQ = {
      ...commandQ,
      seconds: (Date.now() - step) / 1000,
      lastWordsKept: true,
    };
    log(`⌘Q kept the last words typed (${commandQ.by})`);

    // 4. Another page, made and typed into with no server reachable.
    const made = { text: 'A page made while no server could be reached' };
    made.id = await newPage(app, 'Made offline');
    await typeAndSave(app, made.text);
    results.steps.newPageOffline = { saved: true, serverReachable: await listening(5280) };
    log('A new page, saved with no server');

    // 5. Deep links: to an app that is not running, then to the running one.
    await quit(app);
    step = Date.now();
    app = await start([`${SCHEME}://p/${offline.id}`]);
    await app.until('the link to open its page', (lib, id) => location.hash === '#/p/' + id, [
      offline.id,
    ]);
    await openPage(app, offline.id, offline.text);
    results.steps.deepLinkCold = {
      seconds: (Date.now() - step) / 1000,
      route: `#/p/${offline.id}`,
    };
    shot('2-deep-link-cold');
    step = Date.now();
    must('open', [`${SCHEME}://p/${made.id}`]);
    await app.until(
      'the link to reach the running app',
      (lib, id) => location.hash === '#/p/' + id,
      [made.id],
    );
    await openPage(app, made.id, made.text);
    const running = pids().length;
    if (running !== 1) throw new Error(`${running} copies of the app run after two links.`);
    results.steps.deepLinkRunning = { seconds: (Date.now() - step) / 1000, processes: running };
    log('Deep links opened their pages, cold and running');

    // 6. The keychain, through the native sign-in.
    auth = await standInAuth();
    const signIn = await nativeSignIn(app, auth, authUrlFile);
    const kept = { whole: inKeychain(STAND_IN), parts: inKeychain(`${STAND_IN}#1`) };
    if (!kept.whole || !kept.parts)
      throw new Error(
        'The refresh token is not in the keychain in two parts: ' + JSON.stringify(kept),
      );
    const firstToken = await app.invoke('auth_token', { apiBase: STAND_IN });
    await quit(app);
    app = await start(['-a', appPath]);
    const secondToken = await app.invoke('auth_token', { apiBase: STAND_IN });
    if (auth.state.refreshes[0] !== auth.state.issued[0] || secondToken !== 'access-2')
      throw new Error("After a restart the app did not refresh with the keychain's token.");
    const rolled = { whole: inKeychain(STAND_IN), parts: inKeychain(`${STAND_IN}#1`) };
    if (!rolled.whole || rolled.parts)
      throw new Error('The rolled refresh token is not kept whole: ' + JSON.stringify(rolled));
    await app.invoke('auth_sign_out', { apiBase: STAND_IN });
    const gone = !inKeychain(STAND_IN) && !inKeychain(`${STAND_IN}#1`);
    if (!gone || auth.state.revoked.at(-1) !== auth.state.issued.at(-1))
      throw new Error('Signing out left the token in the keychain, or did not revoke it.');
    results.steps.keychain = {
      service: KEYCHAIN_SERVICE,
      deviceName: signIn.deviceName,
      callbackPage: signIn.callbackPage,
      pkce: auth.state.exchanges.every((exchange) => exchange.pkce),
      firstRefreshTokenChars: auth.state.issued[0].length,
      keptInParts: true,
      accessToken: firstToken === 'access-1',
      readBackAfterRestart: true,
      rolledTokenKeptWhole: true,
      revokedAndRemovedOnSignOut: true,
      pageRequestsToTheStandIn: auth.state.other,
    };
    await auth.close();
    auth = null;
    log(`The keychain held the refresh token across a restart (device "${signIn.deviceName}")`);

    // 7. The update, from the top bar.
    await quit(app);
    // What the app asked the feed for, in the results.
    const feedRequests = [];
    feed = createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url, 'http://feed').pathname);
      const file = join(work, 'feed', path);
      const found = file.startsWith(join(work, 'feed')) && existsSync(file);
      feedRequests.push(`${request.method} ${path} ${found ? 200 : 404}`);
      if (!found) return response.writeHead(404).end();
      response.writeHead(200, { 'Content-Length': statSync(file).size });
      response.end(readFileSync(file));
    });
    await new Promise((resolve) => feed.listen(feedPort, '127.0.0.1', resolve));
    app = await start(['-a', appPath]);
    await openPage(app, offline.id, offline.text);
    const before = pids();
    // The first check is 10 s after start. Should the offer not show, the updater's own answer
    // (or its error) and what the top bar holds go into the results.
    await app
      .waitForText({ testId: 'update-status' }, `Update to ${next}`, { timeoutMs: 90_000 })
      .catch(async (error) => {
        const updater = await app
          .invoke('update_check')
          .then((value) => ({ offers: value }))
          .catch((failure) => ({ error: failure.message }));
        const topBar = await app
          .page((lib) =>
            lib.all('[data-testid="update-status"]').map((el) => lib.words(lib.shown(el))),
          )
          .catch((failure) => failure.message);
        results.steps.update = { feedRequests, updater, topBar };
        throw new Error(
          `${error.message}; the updater says ${JSON.stringify(updater)}, the top bar ${JSON.stringify(topBar)}`,
          { cause: error },
        );
      });
    step = Date.now();
    await app.click({ testId: 'update-status' });
    await app.waitFor({ testId: 'update-install' });
    await app.click({ testId: 'update-install' });
    await until(
      'the app to close for the update',
      () => before.every((pid) => !pids().includes(pid)),
      180_000,
    );
    app.close();
    // The updater starts the new version through LaunchServices; if it did not, the run does,
    // and records it.
    let restartedByUpdater = true;
    try {
      app = await Bridge.connect(bridgePort, token, { timeoutMs: 60_000 });
      await ready(app, 60_000);
    } catch (error) {
      log(`The app did not start again after the update (${error.message}): starting it`);
      restartedByUpdater = false;
      await quit(app?.closed === false ? app : null);
      app = await start(['-a', appPath]);
    }
    const after = (await app.invoke('app_info')).version;
    const installed = plistOf(appPath).CFBundleShortVersionString;
    if (after !== next || installed !== next)
      throw new Error(`After the update the app is ${after}, its bundle ${installed}.`);
    await openPage(app, offline.id, offline.text);
    const stillOpens = handlerOf(`${SCHEME}://`);
    results.steps.update = {
      feedRequests,
      from: conf.version,
      to: after,
      seconds: (Date.now() - step) / 1000,
      restartedByUpdater,
      pagesKept: true,
      schemeOpensThisCopy: !!stillOpens && realpathSync(stillOpens) === realpathSync(appPath),
    };
    shot('3-updated');
    log(`Updated to ${after}${restartedByUpdater ? ', restarted by the updater' : ''}`);
    await quit(app);
    app = null;
    feed.close();
    feed = null;

    // 8. Sign-in and sync against the deployed API.
    results.deployed = await deployedRun();
  } catch (error) {
    results.error = error.stack ?? String(error);
    if (app && !app.closed) {
      try {
        results.failedAt = { hash: await app.hash(), title: await app.title() };
      } catch {
        /* The window may be gone. */
      }
    }
    shot('failure');
    process.exitCode = 1;
  } finally {
    blocked?.remove();
    await quit(app).catch(() => {});
    feed?.close();
    await auth?.close();
    if (mount) sh('hdiutil', ['detach', '-force', mount]);
    for (const account of [STAND_IN, `${STAND_IN}#1`])
      sh('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], {
        timeout: 10_000,
      });
    if (appPath) sh(LSREGISTER, ['-u', appPath]);
    rmSync(work, { recursive: true, force: true });
    results.seconds = Math.round((Date.now() - started) / 1000);
    results.passed = !results.error;
    writeFileSync(join(out, 'macos-acceptance.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify(results, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        [
          `### macOS acceptance run: ${results.passed ? 'passed' : 'failed'}`,
          '',
          ...Object.entries(results.steps).map(
            ([name, item]) => `- ${name}: ${JSON.stringify(item)}`,
          ),
          `- deployed API: ${results.deployed?.skipped ?? JSON.stringify(results.deployed)}`,
          ...(results.error ? ['', '```', results.error, '```'] : []),
          '',
        ].join('\n'),
      );
  }

  /**
   * Step 8: sign-in and sync against the deployed API with the CI test account. A build of its
   * own (the page's API, the native side's allowed base and the CSP are fixed when it is built),
   * installed over the test install, on new data.
   */
  async function deployedRun() {
    const base = process.env.CGW_MACOS_API_BASE?.trim().replace(/\/+$/, '');
    const email = process.env.CGW_MACOS_TEST_EMAIL?.trim();
    const password = process.env.CGW_MACOS_TEST_PASSWORD;
    if (!base || !email || !password)
      return {
        skipped:
          'skipped: no deployed API configured (CGW_MACOS_API_BASE, CGW_MACOS_TEST_EMAIL, ' +
          'CGW_MACOS_TEST_PASSWORD)',
      };
    if (!/^https:\/\/[^/]+$/.test(base))
      throw new Error('CGW_MACOS_API_BASE is not an https origin.');
    // Progress is kept in the results as it goes, so a failure shows how far it got.
    const result = (results.deployed = { api: new URL(base).hostname });
    log(`Building for ${result.api}`);
    await run(...pnpm(['--filter', '@cgw/web', 'build']), {
      env: { ...process.env, VITE_CGW_API: base },
    });
    const build = await buildMac({
      bridge: true,
      quick: true,
      bundles: ['app'],
      apiBases: [base],
      connect: [base],
      // No update during this part: the feed is a closed port.
      updaterUrl: 'http://127.0.0.1:9/latest.json',
    });
    rmSync(appPath, { recursive: true, force: true });
    must('ditto', [build.app, appPath]);
    sh(LSREGISTER, ['-u', build.app]);
    rmSync(build.app, { recursive: true, force: true });
    must(LSREGISTER, ['-f', appPath]);
    settings(join(work, 'data-deployed'));
    const name = `macOS CI ${process.env.GITHUB_RUN_ID ?? Date.now()}`;
    app = await start(['-a', appPath]);
    await createWorkspace(app, name);
    const written = {
      text: `Written on macOS before signing in ${randomBytes(4).toString('hex')}`,
    };
    written.id = await newPage(app, 'Written before signing in');
    await typeAndSave(app, written.text);

    // Sign in on the API's own page, in a browser, as tests/e2e/desktop-cloud.spec.ts does.
    rmSync(authUrlFile, { force: true });
    await app.click({ role: 'button', name: 'Sign in to sync' });
    await until('the authorise URL', () => existsSync(authUrlFile), 30_000);
    const authorize = readFileSync(authUrlFile, 'utf8').trim();
    if (!authorize.startsWith(`${base}/connect/authorize?`))
      throw new Error('The app sent the browser elsewhere: ' + new URL(authorize).origin);
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
    try {
      const tab = await browser.newPage();
      await tab.goto(authorize);
      await tab.getByLabel('Email').fill(email);
      await tab.getByLabel('Password').fill(password);
      await tab.getByRole('button', { name: 'Sign in' }).click();
      await tab.getByText(`as ${email}?`).waitFor({ timeout: 30_000 });
      await tab.getByRole('button', { name: 'Continue' }).click();
      await tab.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/callback/, { timeout: 30_000 });
    } finally {
      await browser.close();
    }
    result.keychain = inKeychain(base);
    await app.waitFor({ role: 'button', name: 'Upload to my account' }, { timeoutMs: 30_000 });
    await app.click({ role: 'button', name: 'Upload to my account' });
    await app.waitForText(SYNC_STATUS, 'Synced', { timeoutMs: 120_000 });
    result.uploaded = true;
    log('Signed in and uploaded');

    // Edits with the API unreachable, then synced once it is back.
    await quit(app);
    blocked = await block(result.api);
    result.blockedAddresses = blocked.addresses.length;
    app = await start(['-a', appPath]);
    await openPage(app, written.id, written.text);
    const unreachable = {
      text: `Made on macOS while the API was unreachable ${randomBytes(4).toString('hex')}`,
    };
    unreachable.id = await newPage(app, 'Made while offline');
    await typeAndSave(app, unreachable.text);
    result.statusWhileBlocked = await app
      .waitForText(
        SYNC_STATUS,
        { source: 'Offline|waiting|paused', flags: 'i' },
        { timeoutMs: 60_000 },
      )
      .then(() => syncStatus(app))
      .catch(async () => `not shown (${await syncStatus(app)})`);
    await quit(app);
    blocked.remove();
    blocked = null;
    app = await start(['-a', appPath]);
    await app.waitForText(SYNC_STATUS, 'Synced', { timeoutMs: 180_000 });
    result.syncedAfterwards = true;
    shot('4-deployed-synced');

    // What the server holds, then the workspace goes and the device signs out.
    const server = await app.evaluateFor(
      90_000,
      async (base, name, text) => {
        const token = await window.__TAURI_INTERNALS__.invoke('auth_token', { apiBase: base });
        const headers = { Authorization: `Bearer ${token}` };
        const list = await (await fetch(`${base}/api/v1/workspaces`, { headers })).json();
        const workspace = (Array.isArray(list) ? list : (list.items ?? [])).find(
          (w) => w.name === name,
        );
        if (!workspace) return { found: false };
        let searched = null;
        for (let i = 0; i < 20 && !searched; i++) {
          const answer = await fetch(
            `${base}/api/v1/workspaces/${workspace.id}/search?q=${encodeURIComponent(text)}`,
            { headers },
          );
          const body = answer.ok ? await answer.json() : null;
          if (JSON.stringify(body ?? {}).includes(text.split(' ').at(-1))) searched = true;
          else await new Promise((resolve) => setTimeout(resolve, 3000));
        }
        const removed = await fetch(`${base}/api/v1/workspaces/${workspace.id}`, {
          method: 'DELETE',
          headers,
        });
        return { found: true, searchFindsTheOfflinePage: !!searched, deleted: removed.status };
      },
      base,
      name,
      unreachable.text,
    );
    Object.assign(result, { server });
    await app.evaluate(() => {
      location.hash = '#/settings';
      return true;
    });
    // The account's own Sign out (after the devices list, whose rows have one each), which also
    // takes this device off the account.
    await app
      .waitFor({ css: 'ul.cgw-list + button', name: 'Sign out' }, { timeoutMs: 30_000 })
      .then(() => app.click({ css: 'ul.cgw-list + button', name: 'Sign out' }))
      .catch(() => app.invoke('auth_sign_out', { apiBase: base }));
    await until('the sign-out', () => !inKeychain(base), 30_000).catch(() => {});
    result.signedOut = !inKeychain(base);
    await quit(app);
    app = null;
    if (!server.found) throw new Error('The deployed API has no workspace named ' + name);
    return result;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
  // Should a socket or server outlive the run, it does not keep the job waiting.
  setTimeout(() => process.exit(process.exitCode ?? 0), 5000).unref();
}
