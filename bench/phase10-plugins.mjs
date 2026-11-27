// Phase 10's client budget (IMPLEMENTATION_PLAN.md, Phase 10, Performance benchmarks): a page with
// 10 third-party plugin frames stays within the keystroke budget (Phase 1's: editor work per key,
// and keystroke to the next frame). Measured and gated, like bench/phase5.mjs's ten-embeds case.
//
//   node bench/phase10-plugins.mjs
//
// The web app under `vite preview` on 127.0.0.1:4273 must be a build made with
// VITE_CGW_PLUGINS=http://localhost:5291, and the server stack (scripts/server-stack.mjs --e2e,
// which binds the plugins origin on 5291) on 127.0.0.1:5280 must be running (the parent starts
// both for the proof; this bench waits for them). The reference plugin (tests/fixtures/plugins) is the
// one framed, ten times on one page, a paragraph between each; typing in the paragraph in the
// middle gives the figures. Writes bench/results/phase10-plugins.json; gated against the budgets
// and bench/previous/phase10-plugins.json (the last run on main on the same processor).
//
//   node bench/phase10-plugins.mjs --network
//
// Phase 13's case (IMPLEMENTATION_PLAN.md, Phase 13, Performance benchmarks): the same page with ten
// networked plugins (tests/fixtures/plugins/network, "Ping", its host allowed as it is added), each
// frame sending to the mock host on localhost:4288 (tests/mocks/net/server.mjs, which the parent
// starts) and writing its props back once drawn; Phase 10's budget. Writes
// bench/results/phase13-plugins.json, figures key10NetworkedPlugins*.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  API,
  APP,
  apiSession,
  newAccount,
  signInPage,
  waitFor,
} from '../scripts/cloud-account.mjs';
import { writePluginBundles } from '../tests/fixtures/plugins/make.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const results = join(root, 'bench/results');
const previousFile = join(
  root,
  `bench/previous/${process.argv.includes('--network') ? 'phase13' : 'phase10'}-plugins.json`,
);
const log = (line) => console.log(line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const network = process.argv.includes('--network');
/** The plugin framed ten times: its bundle, its name in the slash menu, and its frame's sign of ready. */
const PLUGIN = network
  ? { bundle: 'network', name: 'Ping', ready: ['#summary', /Done/], file: 'phase13-plugins.json' }
  : {
      bundle: 'reference',
      name: 'Notes',
      ready: ['#status', /Ready|Choose/],
      file: 'phase10-plugins.json',
    };
const FIGURES = network
  ? { work: 'key10NetworkedPluginsWorkP95', frame: 'key10NetworkedPluginsFrameP95' }
  : { work: 'key10PluginsWorkP95', frame: 'key10PluginsFrameP95' };

// The keystroke budget on CI's hosted runner is a frame (bench/phase5.mjs's note, Phase 6).
const KEY_WORK_MAX = process.env.CI ? 16 : 8;
const BUDGETS = {
  [FIGURES.work]: { max: KEY_WORK_MAX, unit: 'ms', slack: 2 },
  [FIGURES.frame]: { max: 33, unit: 'ms', slack: 5 },
};

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};
const round = (n) => Math.round(n * 10) / 10;

/** In the Workspace page: keydown to the next frame painted, and to the end of the editor's transaction. */
function probes() {
  const afterPaint = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
      }),
    );
  window.__keys = { frame: [], work: [] };
  let start = null;
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key.length !== 1) return;
      start = event.timeStamp;
      void afterPaint().then(() => window.__keys.frame.push(performance.now() - event.timeStamp));
    },
    true,
  );
  window.__watchEditor = () => {
    const view = document.querySelector('.cgw-page .ProseMirror');
    if (!view?.editor || view.__watched) return false;
    view.__watched = true;
    view.editor.on('transaction', ({ transaction }) => {
      if (start === null || !transaction.docChanged) return;
      window.__keys.work.push(performance.now() - start);
      start = null;
    });
    return true;
  };
}

async function newPage(page, title) {
  const before = new URL(page.url()).hash;
  await page
    .getByRole('button', { name: /^Add a page in/ })
    .first()
    .click();
  await page.waitForFunction(
    (was) => {
      const input = document.querySelector('[aria-label="Page title"]');
      return location.hash !== was && input?.value === '' && document.activeElement === input;
    },
    before,
    { timeout: 30000 },
  );
  await page.getByLabel('Page title').fill(title);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.closest('.cgw-editor'));
}

const saved = (page) =>
  page.getByTestId('save-status').filter({ hasText: /Saved/ }).waitFor({ timeout: 30000 });

async function typeKeys(page, text) {
  await page.evaluate(() => {
    window.__keys.frame.length = 0;
    window.__keys.work.length = 0;
  });
  await page.keyboard.type(text, { delay: 35 });
  await sleep(500);
  const keys = await page.evaluate(() => window.__keys);
  return {
    keys: keys.frame.length,
    workP50: round(percentile(keys.work, 0.5)),
    workP95: round(percentile(keys.work, 0.95)),
    frameP50: round(percentile(keys.frame, 0.5)),
    frameP95: round(percentile(keys.frame, 0.95)),
  };
}

/** Installs the plugin through Settings (a networked one's host allowed as it is added). */
async function installPlugin(page, bundle) {
  await page.goto(`${APP}/#/settings/integrations`);
  const section = page.getByTestId('plugins-settings');
  await section.waitFor({ timeout: 30000 });
  const chooser = page.waitForEvent('filechooser');
  await section.getByTestId('plugins-add').click();
  await (await chooser).setFiles(bundle);
  await page.getByTestId('plugins-review').waitFor({ timeout: 30000 });
  await page.getByTestId('plugins-confirm').click();
  await section
    .getByTestId('plugins-list')
    .filter({ hasText: PLUGIN.name })
    .waitFor({ timeout: 30000 });
}

/** A page with 10 plugin frames and a paragraph between each; typing in the middle one. */
async function tenPlugins(page) {
  await newPage(page, 'Ten plugins');
  for (let i = 1; i <= 10; i++) {
    await page.keyboard.type(`/${PLUGIN.name}`);
    await page.getByRole('option', { name: PLUGIN.name, exact: true }).waitFor();
    await page.keyboard.press('Enter');
    await page
      .locator('.cgw-page [data-body="pluginBlock"] iframe')
      .nth(i - 1)
      .waitFor({ timeout: 30000 });
    await page.keyboard.insertText(i < 10 ? `Between ${i} and ${i + 1}.` : 'After the last.');
    await page.keyboard.press('Enter');
  }
  await saved(page);
  // Every frame says it is ready (its handshake done; a networked one, its requests answered), or
  // the figure means less than it says.
  for (let i = 0; i < 10; i++)
    await page
      .frameLocator('.cgw-page [data-body="pluginBlock"] iframe')
      .nth(i)
      .locator(PLUGIN.ready[0])
      .filter({ hasText: PLUGIN.ready[1] })
      .waitFor({ timeout: 30000 });
  // A networked frame writes its props back once drawn: saved again before typing.
  if (network) await saved(page);
  // Into the paragraph between the fifth and sixth frames.
  await page.getByText('Between 5 and 6.').click();
  await page.keyboard.press('End');
  await page.waitForFunction(() => window.__watchEditor?.());
  return typeKeys(page, ' the quick brown fox jumps over the lazy dog and keeps on typing');
}

async function run() {
  mkdirSync(results, { recursive: true });
  const bundle = writePluginBundles(mkdtempSync(join(tmpdir(), 'cgw-phase10-plugins-')))[
    PLUGIN.bundle
  ];
  await waitFor(`${API}/health/live`, 180000);
  await waitFor(APP, 60000);
  const account = await newAccount(network ? 'Phase 13 plugins bench' : 'Phase 10 plugins bench');
  const api = await apiSession(account);
  const browser = await chromium.launch({ channel: 'chrome' });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(probes);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${APP}/`);
    await signInPage(page, account, `${APP}/`);
    await page.getByLabel('Workspace name').fill('Plugins bench');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 60000 });
    await page
      .getByTestId('sync-status')
      .filter({ hasText: /^Synced$/ })
      .waitFor({ timeout: 120000 });
    log(`Installing the ${network ? 'networked' : 'reference'} plugin`);
    await installPlugin(page, bundle);
    log(`Typing between ten ${network ? 'networked ' : ''}plugin frames`);
    const keys = await tenPlugins(page);
    log(
      `  ${keys.keys} keys: work p50 ${keys.workP50} ms, p95 ${keys.workP95} ms; next frame p50 ${keys.frameP50} ms, p95 ${keys.frameP95} ms`,
    );
    if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
    return { browser: browser.version(), keys };
  } finally {
    await browser.close();
    await api.dispose();
  }
}

function gate(measured) {
  const figures = {
    [FIGURES.work]: measured.keys.workP95,
    [FIGURES.frame]: measured.keys.frameP95,
  };
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(previousFile, 'utf8')).figures ?? null;
  } catch {
    // No baseline on this machine.
  }
  const failures = [];
  for (const [name, budget] of Object.entries(BUDGETS)) {
    const value = figures[name];
    if (value > budget.max + budget.slack)
      failures.push(`${name} ${value}${budget.unit} over ${budget.max}${budget.unit}`);
    const was = previous?.[name];
    if (was !== undefined && value > was * 1.5 + budget.slack)
      failures.push(`${name} ${value}${budget.unit} regressed from ${was}${budget.unit}`);
  }
  return { figures, failures };
}

run().then(
  (measured) => {
    const { figures, failures } = gate(measured);
    writeFileSync(
      join(results, PLUGIN.file),
      JSON.stringify(
        { at: new Date().toISOString(), browser: measured.browser, figures, keys: measured.keys },
        null,
        2,
      ) + '\n',
    );
    if (failures.length) {
      console.error(
        `Phase ${network ? 13 : 10} plugin budgets failed:\n  ` + failures.join('\n  '),
      );
      process.exit(1);
    }
    log(`Phase ${network ? 13 : 10} plugin budgets met.`);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);

process.on('SIGINT', () => process.exit(130));
