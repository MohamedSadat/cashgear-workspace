// Phase 10's ERP budget (IMPLEMENTATION_PLAN.md, Phase 10, Performance benchmarks): the review of
// 500 changed customers, less the ERP's dry run, p95 at most 2 s, as bench/phase7.mjs's Vendors
// case measures it. A piece of bench/phase10.mjs, which wires it in:
//   import { ERP_BUDGETS, ERP_RECORDS, measureErpReview, prepareErpMock } from './phase10-erp.mjs';
// and also alone (`node bench/phase10-erp.mjs`, after `pnpm build`): the web app under vite preview
// on 127.0.0.1:4273, the server stack on 127.0.0.1:5280 (scripts/server-stack.mjs --e2e, its API
// pointed at the mock AI provider), the mock ERP (4282, 4284) and the mock AI provider (4286) are
// reused when they answer, else started and stopped at the end. Writes
// bench/results/phase10-erp.json alone.
//
// The figure: a page holding an ERP view of Customers, 500 rows a page, connected as the mock's
// faris (Customers' Edit and AdvEdit, and every customer: no ownership rule), "Edit data", then
// "Prepare changes with AI" filled with one change to each of the 500 customers on screen (the mock
// provider scripted to propose them); from the click on "Review changes" to the review screen
// holding its 500 rows, to the frame after it painted, less the time the ERP's dry run was in
// flight (the union of the ERP's requests' Resource Timing spans in that window). Six reviews, back
// to editing between them; p95 of what is left (budget 2 s); the ERP's time and the total tracked.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
export const ERP_API = 'http://127.0.0.1:4282';
export const MOCK_AI = process.env.CGW_MOCK_AI_URL ?? 'http://127.0.0.1:4286';
const RUNS = Number(process.env.PHASE10_ERP_RUNS ?? 6);
export const ERP_RECORDS = 500;
/** The workspace's (mock) Anthropic key, as an owner sets it in Settings. */
export const ERP_BENCH_KEY = 'sk-mock-phase10-erp-bench-0001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Budgets, with the margin a regression must also exceed to fail (runners are noisy). */
export const ERP_BUDGETS = {
  erpCustomersReview500P95: { max: 2000, unit: 'ms', slack: 300 },
  // Tracked, not budgeted.
  erpCustomersReviewErpP95: { max: Infinity, unit: 'ms', slack: 1000 },
  erpCustomersReviewTotalP95: { max: Infinity, unit: 'ms', slack: 1000 },
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

const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

/** More of Kit's customers than the seed's 240, so one page holds 500; the provider fresh. */
export async function prepareErpMock() {
  const reset = await post(`${ERP_API}/__mock/reset`, { kitCustomers: ERP_RECORDS + 20 });
  if (!reset.ok) throw new Error(`The mock ERP's reset answered ${reset.status}`);
  await post(`${MOCK_AI}/__mock/reset`);
}

/** The mock ERP back to its seed. */
export const resetErpMock = () => post(`${ERP_API}/__mock/reset`);

/** The workspace linked to the mock ERP's company, as the link screen links it. */
export async function linkErp(api, workspaceId, workspaceName) {
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

/** The first `count` of Kit's customers in the ERP's order, as the block's first page lists them. */
async function kitCustomers(count) {
  const state = await (await fetch(`${ERP_API}/__mock/state`)).json();
  return state.records.customers.filter((r) => r.company === 'Kit').slice(0, count);
}

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

/** A page with an ERP view of Customers, 500 rows a page, connected as faris, with 500 changes. */
async function customersWithChanges(page) {
  await newPage(page, 'Customers to tidy');
  await page.keyboard.type('Customers to tidy.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/erp');
  await page.getByRole('option', { name: /^ERP data/, selected: true }).waitFor();
  await page.keyboard.press('Enter');
  const block = page.getByTestId('erp-view');
  const opened = page.waitForEvent('popup');
  await block.getByTestId('erp-not-connected').getByRole('button').click();
  const popup = await opened;
  await popup.locator('#user').selectOption('faris');
  const closed = popup.waitForEvent('close');
  await popup.locator('#connect').click();
  await closed;
  await block.locator('[data-connector="customers"]').click();
  await block.getByTestId('erp-table').waitFor({ timeout: 30000 });
  await block.getByLabel('Rows a page').selectOption(String(ERP_RECORDS));
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="erp-table"] tbody tr').length === n,
    ERP_RECORDS,
    { timeout: 60000 },
  );
  // One change to each customer on screen, proposed by the (scripted) provider.
  const records = await kitCustomers(ERP_RECORDS);
  await post(`${MOCK_AI}/__mock/script`, {
    key: ERP_BENCH_KEY,
    json: {
      changes: records.map((r, i) => ({
        id: r.id,
        field: 'address',
        to: `${i + 1} Bench Corniche St`,
      })),
    },
  });
  await block.getByRole('button', { name: 'Edit data', exact: true }).click();
  await block.getByRole('button', { name: 'Prepare changes with AI' }).click();
  await block.getByLabel('What should change?').fill('Give every customer the bench address');
  await block.getByRole('button', { name: 'Prepare', exact: true }).click();
  await page.waitForFunction(
    (n) =>
      document.querySelector('[data-testid="erp-change-count"]')?.textContent ===
      `Changes not committed: ${n}`,
    ERP_RECORDS,
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
        { erp: ERP_API, rows: ERP_RECORDS, afterPaint: afterPaintSource().toString() },
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

/**
 * The review of 500 changed customers in `page`, signed in to a synced workspace `workspaceId`
 * that `api` (its owner) links to the mock ERP and turns AI on for (the mock key). The mock ERP
 * must have been prepared (`prepareErpMock`). Discards the changes after. Gives the figures.
 */
export async function measureErpReview(page, api, workspaceId, { log = console.log } = {}) {
  await linkErp(api, workspaceId, 'Phase 10 ERP bench');
  await api.put(`/api/v1/workspaces/${workspaceId}/ai-settings`, { apiKey: ERP_BENCH_KEY });
  await api.put(`/api/v1/workspaces/${workspaceId}/ai-settings`, { enabled: true });
  await page.reload();
  await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 60000 });
  log(`Making an ERP view of ${ERP_RECORDS} customers with a change to each`);
  const block = await customersWithChanges(page);
  log(`Review of ${ERP_RECORDS} changed customers, ${RUNS} times`);
  const review = await reviews(page, block);
  log(
    `  less the ERP's time: p50 ${review.p50} ms, p95 ${review.p95} ms (the ERP's own p95 ${review.erpP95} ms; in all p95 ${review.totalP95} ms)`,
  );
  // Leave without committing: discard, so the page can be left without the warning.
  await block.getByRole('button', { name: 'Discard changes' }).click();
  return {
    review,
    figures: {
      erpCustomersReview500P95: review.p95,
      erpCustomersReviewErpP95: review.erpP95,
      erpCustomersReviewTotalP95: review.totalP95,
    },
  };
}

// ------------------------------------------------------------------ alone
function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

async function alone() {
  const { chromium } = await import('@playwright/test');
  const { API, APP, answers, apiSession, newAccount, signInPage, waitFor } =
    await import('../scripts/cloud-account.mjs');
  const log = (line) => console.log(line);
  const results = join(root, 'bench/results');
  mkdirSync(results, { recursive: true });
  const started = [];
  const startIfMissing = async (url, what, command, commandArgs, options = {}) => {
    if (await answers(url)) return log(`Reusing ${what}`);
    log(`Starting ${what}`);
    started.push(spawn(command, commandArgs, { cwd: root, stdio: 'ignore', ...options }));
    await waitFor(url, options.waitMs ?? 60000);
  };
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
  try {
    if (!existsSync(join(root, 'apps/web/dist/index.html')))
      throw new Error('Run pnpm build first.');
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
    await prepareErpMock();
    const account = await newAccount('Phase 10 ERP bench');
    const api = await apiSession(account);
    const browser = await chromium.launch({ channel: 'chrome' });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${APP}/`);
      await signInPage(page, account, `${APP}/`);
      await page.getByLabel('Workspace name').fill('Phase 10 ERP bench');
      await page.getByRole('button', { name: 'Create workspace' }).click();
      await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 60000 });
      await page
        .getByTestId('sync-status')
        .filter({ hasText: /^Synced$/ })
        .waitFor({ timeout: 120000 });
      const workspaceId = (await api.get('/api/v1/workspaces')).find(
        (w) => w.name === 'Phase 10 ERP bench',
      ).id;
      const measured = await measureErpReview(page, api, workspaceId, { log });
      if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
      out.browser = browser.version();
      out.review = measured.review;
      out.figures = measured.figures;
    } catch (error) {
      const page = browser.contexts()[0]?.pages()[0];
      await page?.screenshot({ path: join(results, 'phase10-erp-failure.png') }).catch(() => {});
      throw error;
    } finally {
      await browser.close();
      await api.dispose();
      await resetErpMock();
    }
  } finally {
    for (const child of started.reverse()) stopTree(child);
  }
  out.gate = Object.entries(out.figures).map(([name, value]) => ({
    name,
    value,
    budget: Number.isFinite(ERP_BUDGETS[name].max) ? ERP_BUDGETS[name].max : null,
    unit: ERP_BUDGETS[name].unit,
    overBudget: value > ERP_BUDGETS[name].max,
  }));
  writeFileSync(join(results, 'phase10-erp.json'), JSON.stringify(out, null, 2) + '\n');
  for (const g of out.gate)
    log(
      `${g.overBudget ? 'FAIL' : 'ok  '} ${g.name.padEnd(30)} ${String(g.value).padStart(7)} ${g.unit} (budget ${g.budget ?? 'none'})`,
    );
  process.exitCode = out.gate.some((g) => g.overBudget) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await alone();
