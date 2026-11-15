// Phase 7's budgets (IMPLEMENTATION_PLAN.md, Phase 7, Performance benchmarks), measured and gated:
//   pnpm bench:phase7     the web app in Chrome against the server stack, the mock ERP
//                         (tests/mocks/erp) and the mock AI provider (tests/mocks/ai)
// Needs `pnpm build`. The web app under vite preview on 127.0.0.1:4273, the server stack on
// 127.0.0.1:5280 (scripts/server-stack.mjs --e2e, its API pointed at the mock provider) and the two
// mocks (4282 and 4284; 4286) are reused when they answer, else started here and stopped at the
// end.
//
// The figures:
//   - review of 500 changed records: a page holding an ERP view of Vendors, 500 rows a page,
//     connected as the mock's gina (Vendors' Edit), "Edit data", then "Prepare changes with AI"
//     filled with one change to each of the 500 records on screen (the mock provider scripted to
//     propose them); from the click on "Review changes" to the review screen holding its 500 rows,
//     to the frame after it painted, less the time the ERP's dry run was in flight (the union of
//     the ERP's requests' Resource Timing spans in that window: the ERP's own time). Six reviews,
//     back to editing between them; p95 of what is left (budget 2 s); the ERP's time and the total
//     tracked;
//   - the first AI token: "Summarise this page" in the AI panel on a page of text; from the click on
//     "Ask" to the first text of the answer drawn, to the frame after it painted, less the
//     provider's own time to its first text (the mock records it: `firstTextMs`). Six asks; p95 of
//     what is left (budget 2 s); the provider's time and the total tracked.
// Each figure is checked against its budget and, when bench/previous/phase7.json holds the last
// run on main on the same processor (CI downloads it), against that: worse by half again and by
// more than a small margin fails. Writes bench/results/phase7.json.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  API,
  APP,
  answers,
  apiSession,
  newAccount,
  signInPage,
  waitFor,
} from '../scripts/cloud-account.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const ERP_API = 'http://127.0.0.1:4282';
const MOCK_AI = process.env.CGW_MOCK_AI_URL ?? 'http://127.0.0.1:4286';
const RUNS = Number(process.env.PHASE7_RUNS ?? 6);
const RECORDS = 500;
const KEY = 'sk-mock-phase7-bench-key-0001';
const previousFile = join(root, 'bench/previous/phase7.json');
const results = join(root, 'bench/results');
const log = (line) => console.log(line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Budgets, with the margin a regression must also exceed to fail (runners are noisy). */
const BUDGETS = {
  erpReview500P95: { max: 2000, unit: 'ms', slack: 300 },
  aiFirstTokenP95: { max: 2000, unit: 'ms', slack: 300 },
  // Tracked, not budgeted.
  erpReviewErpP95: { max: Infinity, unit: 'ms', slack: 1000 },
  erpReviewTotalP95: { max: Infinity, unit: 'ms', slack: 1000 },
  aiProviderFirstTextP95: { max: Infinity, unit: 'ms', slack: 1000 },
  aiFirstTokenTotalP95: { max: Infinity, unit: 'ms', slack: 1000 },
};

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};
const round = (n) => Math.round(n * 10) / 10;
const summary = (values) => ({
  p50: round(percentile(values, 0.5)),
  p95: round(percentile(values, 0.95)),
});

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

// ------------------------------------------------------------------ the ERP and the provider
/** The workspace linked to the mock ERP's company, as the link screen links it. */
async function link(api, workspaceId, workspaceName) {
  const ticket = (await (await post(`${ERP_API}/__mock/link-ticket`, { user: 'dan' })).json())
    .ticket;
  const redeemed = await fetch(`${ERP_API}/api/system/WorkspaceLink/Redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4273' },
    body: JSON.stringify({ ticket, workspaceId, workspaceName }),
  });
  const erp = await redeemed.json();
  await api.post(`/api/v1/workspaces/${workspaceId}/erp-links`, {
    erpLinkId: erp.linkId,
    erpBaseUrl: ERP_API,
    company: erp.company,
    companyName: erp.companyName,
  });
}

/** The first `count` of Kit's vendors in the ERP's order, as the block's first page lists them. */
async function kitVendors(count) {
  const state = await (await fetch(`${ERP_API}/__mock/state`)).json();
  return state.records.vendors.filter((r) => r.company === 'Kit').slice(0, count);
}

// ------------------------------------------------------------------ in the page
/** The frame after the next paint. */
function afterPaintSource() {
  return () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
      }),
    );
}

async function newPage(page, title) {
  const before = new URL(page.url()).hash;
  await page
    .getByRole('button', { name: /^Add a page in/ })
    .first()
    .click();
  await page.waitForFunction(
    (before) => {
      const input = document.querySelector('[aria-label="Page title"]');
      return location.hash !== before && input?.value === '' && document.activeElement === input;
    },
    before,
    { timeout: 30000 },
  );
  await page.getByLabel('Page title').fill(title);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.closest('.cgw-editor'));
}

const saved = (page) =>
  page.waitForFunction(
    () => document.querySelector('[data-testid="save-status"]')?.textContent === 'Saved',
    null,
    {
      timeout: 30000,
    },
  );

/** A page with an ERP view of Vendors, 500 rows a page, connected as gina, with 500 changes. */
async function erpWithChanges(page) {
  await newPage(page, 'Vendors to tidy');
  await page.keyboard.type('Vendors to tidy.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/erp');
  await page.getByRole('option', { name: /^ERP data/, selected: true }).waitFor();
  await page.keyboard.press('Enter');
  const block = page.getByTestId('erp-view');
  const opened = page.waitForEvent('popup');
  await block.getByTestId('erp-not-connected').getByRole('button').click();
  const popup = await opened;
  await popup.locator('#user').selectOption('gina');
  const closed = popup.waitForEvent('close');
  await popup.locator('#connect').click();
  await closed;
  await block.locator('[data-connector="vendors"]').click();
  await block.getByTestId('erp-table').waitFor({ timeout: 30000 });
  await block.getByLabel('Rows a page').selectOption(String(RECORDS));
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="erp-table"] tbody tr').length === n,
    RECORDS,
    { timeout: 60000 },
  );
  // One change to each record on screen, proposed by the (scripted) provider.
  const records = await kitVendors(RECORDS);
  await post(`${MOCK_AI}/__mock/script`, {
    key: KEY,
    json: {
      changes: records.map((r, i) => ({
        id: r.id,
        field: 'address',
        to: `${i + 1} Bench Quay Rd`,
      })),
    },
  });
  await block.getByRole('button', { name: 'Edit data', exact: true }).click();
  await block.getByRole('button', { name: 'Prepare changes with AI' }).click();
  await block.getByLabel('What should change?').fill('Give every vendor the bench address');
  await block.getByRole('button', { name: 'Prepare', exact: true }).click();
  await page.waitForFunction(
    (n) =>
      document.querySelector('[data-testid="erp-change-count"]')?.textContent ===
      `Changes not committed: ${n}`,
    RECORDS,
    { timeout: 120000 },
  );
  return block;
}

/** "Review changes", `RUNS` times: to the review's rows painted, less the ERP's dry run. */
async function reviews(page, block) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    await sleep(500);
    runs.push(
      await page.evaluate(
        ({ erp, rows, afterPaint }) =>
          new Promise((resolve, reject) => {
            const paint = new Function(`return (${afterPaint})()`);
            const button = [...document.querySelectorAll('[data-testid="erp-view"] button')].find(
              (b) => b.textContent?.trim() === 'Review changes',
            );
            if (!button) return reject(new Error('No "Review changes" button'));
            performance.clearResourceTimings();
            const started = performance.now();
            button.click();
            const check = () => {
              const review = document.querySelector('[data-testid="erp-review"]');
              const shown = review?.querySelectorAll('tbody tr').length ?? 0;
              if (review?.getAttribute('data-phase') === 'reviewed' && shown === rows)
                return void paint().then(() => {
                  const ended = performance.now();
                  const spans = performance
                    .getEntriesByType('resource')
                    .filter((e) => e.name.startsWith(erp) && e.startTime >= started - 1)
                    .map((e) => [
                      e.startTime,
                      Math.min(e.responseEnd || e.startTime + e.duration, ended),
                    ])
                    .sort((a, b) => a[0] - b[0]);
                  let busy = 0;
                  let reach = -Infinity;
                  for (const [from, to] of spans) {
                    const begin = Math.max(from, reach);
                    if (to > begin) busy += to - begin;
                    reach = Math.max(reach, to);
                  }
                  resolve({ total: ended - started, erp: busy, requests: spans.length });
                });
              if (
                review?.getAttribute('data-phase') === 'invalid' ||
                review?.getAttribute('data-phase') === 'failed'
              )
                return reject(new Error(`The review ended ${review.getAttribute('data-phase')}`));
              if (performance.now() - started > 60000)
                return reject(new Error('No review in 60 s'));
              requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          }),
        { erp: ERP_API, rows: RECORDS, afterPaint: afterPaintSource().toString() },
      ),
    );
    await block.getByRole('button', { name: 'Back to editing', exact: true }).click();
    await block.getByTestId('erp-editbar').waitFor();
  }
  const left = runs.map((r) => r.total - r.erp);
  return {
    runs: runs.map((r) => ({ total: round(r.total), erp: round(r.erp), requests: r.requests })),
    ...summary(left),
    erpP95: summary(runs.map((r) => r.erp)).p95,
    totalP95: summary(runs.map((r) => r.total)).p95,
  };
}

/** "Summarise this page", `RUNS` times: to the answer's first text painted, less the provider's. */
async function firstTokens(page) {
  await newPage(page, 'A page to summarise');
  for (let i = 1; i <= 12; i++) {
    await page.keyboard.insertText(
      `Paragraph ${i}: the quarterly review covers suppliers, costs and the plan ahead.`,
    );
    await page.keyboard.press('Enter');
  }
  await saved(page);
  await page
    .getByRole('region', { name: 'Page' })
    .getByRole('button', { name: 'Page actions' })
    .click();
  await page.getByRole('menuitem', { name: 'AI…' }).click();
  const panel = page.getByTestId('ai-panel');
  await panel.waitFor();
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    await panel.getByRole('radio', { name: 'Summarise this page' }).check();
    await sleep(300);
    const before = (await (await fetch(`${MOCK_AI}/__mock/requests?action=summarise`)).json())
      .requests.length;
    const total = await page.evaluate(
      ({ afterPaint }) =>
        new Promise((resolve, reject) => {
          const paint = new Function(`return (${afterPaint})()`);
          const panel = document.querySelector('[data-testid="ai-panel"]');
          const button = [...(panel?.querySelectorAll('button') ?? [])].find(
            (b) => b.textContent?.trim() === 'Ask',
          );
          if (!button) return reject(new Error('No "Ask" button'));
          const started = performance.now();
          button.click();
          const check = () => {
            const text = panel.querySelector('[data-testid="ai-answer"] .cgw-ai-text');
            if (text?.textContent?.trim())
              return void paint().then(() => resolve(performance.now() - started));
            if (panel.querySelector('[data-testid="ai-answer"] [role="alert"]'))
              return reject(new Error('The AI answered with an error'));
            if (performance.now() - started > 60000) return reject(new Error('No answer in 60 s'));
            requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        }),
      { afterPaint: afterPaintSource().toString() },
    );
    // The provider's own time to its first text, for this request.
    let provider = null;
    for (let tries = 0; tries < 50 && provider === null; tries++) {
      const list = (await (await fetch(`${MOCK_AI}/__mock/requests?action=summarise`)).json())
        .requests;
      if (list.length > before && list.at(-1).firstTextMs !== null)
        provider = list.at(-1).firstTextMs;
      else await sleep(100);
    }
    if (provider === null) throw new Error('The mock provider recorded no first text');
    runs.push({ total, provider });
    // The answer done, then discarded: the page is never changed.
    await panel.getByRole('button', { name: 'Discard', exact: true }).click();
  }
  const left = runs.map((r) => r.total - r.provider);
  return {
    runs: runs.map((r) => ({ total: round(r.total), provider: round(r.provider) })),
    ...summary(left),
    providerP95: summary(runs.map((r) => r.provider)).p95,
    totalP95: summary(runs.map((r) => r.total)).p95,
  };
}

// ------------------------------------------------------------------ the browser part
async function web(account, api) {
  const browser = await chromium.launch({ channel: 'chrome' });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${APP}/`);
    await signInPage(page, account, `${APP}/`);
    await page.getByLabel('Workspace name').fill('Phase 7 bench');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 60000 });
    await page
      .getByTestId('sync-status')
      .filter({ hasText: /^Synced$/ })
      .waitFor({ timeout: 120000 });
    const workspaceId = (await api.get('/api/v1/workspaces')).find(
      (w) => w.name === 'Phase 7 bench',
    ).id;
    await link(api, workspaceId, 'Phase 7 bench');
    // AI on with the workspace's (mock) key, as an owner does in Settings; the app read again.
    await api.put(`/api/v1/workspaces/${workspaceId}/ai-settings`, { apiKey: KEY });
    await api.put(`/api/v1/workspaces/${workspaceId}/ai-settings`, { enabled: true });
    await page.reload();
    await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 60000 });

    log(`Making an ERP view of ${RECORDS} vendors with a change to each`);
    const block = await erpWithChanges(page);
    log(`Review of ${RECORDS} changed records, ${RUNS} times`);
    const review = await reviews(page, block);
    log(
      `  less the ERP's time: p50 ${review.p50} ms, p95 ${review.p95} ms (the ERP's own p95 ${review.erpP95} ms; in all p95 ${review.totalP95} ms)`,
    );
    // Leave without committing: discard, so the page can be left without the warning.
    await block.getByRole('button', { name: 'Discard changes' }).click();
    const confirm = page.getByRole('alertdialog');
    if (await confirm.isVisible().catch(() => false))
      await confirm.getByRole('button', { name: /Discard/ }).click();

    log(`The first AI token, ${RUNS} asks`);
    const tokens = await firstTokens(page);
    log(
      `  less the provider's time: p50 ${tokens.p50} ms, p95 ${tokens.p95} ms (the provider's own p95 ${tokens.providerP95} ms; in all p95 ${tokens.totalP95} ms)`,
    );
    if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
    return { browser: browser.version(), review, tokens };
  } catch (error) {
    const page = browser.contexts()[0]?.pages()[0];
    await page?.screenshot({ path: join(results, 'phase7-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------ main
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
const startIfMissing = async (url, what, command, commandArgs, options = {}) => {
  if (await answers(url)) return log(`Reusing ${what}`);
  log(`Starting ${what}`);
  started.push(spawn(command, commandArgs, { cwd: root, stdio: 'ignore', ...options }));
  await waitFor(url, options.waitMs ?? 60000);
};
try {
  if (!existsSync(join(root, 'apps/web/dist/index.html'))) throw new Error('Run pnpm build first.');
  await startIfMissing(`${MOCK_AI}/__mock/state`, 'the mock AI provider', process.execPath, [
    join(root, 'tests/mocks/ai/server.mjs'),
  ]);
  await startIfMissing(
    `${API}/health/live`,
    'the server stack (scripts/server-stack.mjs --e2e)',
    process.execPath,
    [join(root, 'scripts/server-stack.mjs'), '--e2e'],
    { waitMs: 600000 },
  );
  await startIfMissing(
    APP,
    `vite preview on ${APP}`,
    process.execPath,
    [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview'],
    { cwd: join(root, 'apps/web') },
  );
  await startIfMissing(`${ERP_API}/__mock/state`, 'the mock ERP', process.execPath, [
    join(root, 'tests/mocks/erp/server.mjs'),
    '--workspace-url',
    'http://127.0.0.1:4273',
  ]);
  // More of Kit's vendors than the seed's 150, so a page holds 500, none locked; the provider fresh.
  await post(`${ERP_API}/__mock/reset`, { kitVendors: RECORDS + 20, locks: false });
  await post(`${MOCK_AI}/__mock/reset`);
  const account = await newAccount('Phase 7 bench');
  const api = await apiSession(account);
  try {
    out.web = await web(account, api);
  } finally {
    await api.dispose();
    await post(`${ERP_API}/__mock/reset`);
  }
} finally {
  for (const child of started.reverse()) stopTree(child);
}

const figures = {
  erpReview500P95: out.web?.review?.p95,
  erpReviewErpP95: out.web?.review?.erpP95,
  erpReviewTotalP95: out.web?.review?.totalP95,
  aiFirstTokenP95: out.web?.tokens?.p95,
  aiProviderFirstTextP95: out.web?.tokens?.providerP95,
  aiFirstTokenTotalP95: out.web?.tokens?.totalP95,
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
writeFileSync(join(results, 'phase7.json'), JSON.stringify(out, null, 2) + '\n');
log('\nBudget                         value      budget   last main');
for (const g of gate)
  log(
    `${g.overBudget || g.regressed ? 'FAIL' : 'ok  '} ${g.name.padEnd(28)} ${String(g.value).padStart(7)} ${g.unit.padEnd(3)} ${String(g.budget ?? 'none').padStart(7)}   ${g.previous ?? '-'}${g.regressed ? '  (regressed)' : ''}`,
  );
if (!last) log('(No run on main to compare with: budgets only.)');
else if (!sameMachine)
  log(
    `(The last run on main ran on ${last.machine?.cpu ?? 'a processor it did not record'}, this one on ${out.machine.cpu}: budgets only.)`,
  );
process.exitCode = gate.some((g) => g.overBudget || g.regressed) ? 1 : 0;
