// Phase 12's budgets (IMPLEMENTATION_PLAN.md, Phase 12, Performance benchmarks), measured and gated:
//   pnpm bench:phase12    the chart view and the pins in Chrome, against the server stack
// Needs `pnpm build`. The web app under vite preview on 127.0.0.1:4273 and the server stack on
// 127.0.0.1:5280 (scripts/server-stack.mjs --e2e) are reused when they answer, else started here and
// stopped at the end.
//
// The figures:
//   - a chart view of 50,000 rows by count (bench/phase12-chart.mjs): from opening the database page
//     to the chart's first bar, p95 of eight opens after a first (budget 1 s);
//   - pinning a 5,000-row database whose rows all have documents (bench/phase12-pins.mjs): from the
//     pin to every row's document on the device (budget 120 s), with Phase 1's keystroke budget held
//     on another page meanwhile (work per key and key to the next frame, p95).
// The third budget, the ERP's first page of a 100,000-record connector within 500 ms, is Track E10's
// own measure, taken in the ERP's repository on LocalDB (PROGRESS.md, Phase 12).
// Each figure is checked against its budget and, when bench/previous/phase12.json holds the last
// run on main on the same processor (CI downloads it), against that: worse by half again and by
// more than a small margin fails. Writes bench/results/phase12.json.
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
import { CHART_BUDGETS, measureChart, seedChartDatabase } from './phase12-chart.mjs';
import { PINS_BUDGETS, measurePins, seedPinnedDatabase } from './phase12-pins.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const previousFile = join(root, 'bench/previous/phase12.json');
const results = join(root, 'bench/results');
const log = (line) => console.log(line);

/** Budgets, with the margin a regression must also exceed to fail (runners are noisy). */
const BUDGETS = { ...CHART_BUDGETS, ...PINS_BUDGETS };

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

/** A fresh account, its seed through the API, then a signed-in Chrome page measuring it. */
async function inChrome(browser, errors, name, seed, measure) {
  const account = await newAccount(name);
  const api = await apiSession(account);
  try {
    const seeded = await seed(api);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${APP}/`);
    await signInPage(page, account, `${APP}/`);
    await page
      .getByTestId('sync-status')
      .filter({ hasText: /^Synced$/ })
      .waitFor({ timeout: 180000 });
    const measured = await measure(page, seeded);
    await context.close();
    return measured;
  } finally {
    await api.dispose();
  }
}

async function web() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const errors = [];
  try {
    log('A chart view of 50,000 rows by count (seeding through the import route)');
    const chart = await inChrome(
      browser,
      errors,
      'Phase 12 chart bench',
      seedChartDatabase,
      (page, seeded) => measureChart(page, seeded, { log }),
    );
    log('Pinning a 5,000-row database with its documents while typing');
    const pins = await inChrome(
      browser,
      errors,
      'Phase 12 pins bench',
      seedPinnedDatabase,
      (page, seeded) => measurePins(page, seeded, { log }),
    );
    if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
    return { browser: browser.version(), chart, pins };
  } catch (error) {
    for (const context of browser.contexts())
      for (const [i, page] of context.pages().entries())
        await page
          .screenshot({ path: join(results, `phase12-failure-${i}.png`) })
          .catch(() => undefined);
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
  out.web = await web();
} finally {
  for (const child of started.reverse()) stopTree(child);
}

const figures = { ...(out.web?.chart?.figures ?? {}), ...(out.web?.pins?.figures ?? {}) };
const last = existsSync(previousFile) ? JSON.parse(readFileSync(previousFile, 'utf8')) : null;
const sameMachine = !!last && last.machine?.cpu === out.machine.cpu;
const previous = sameMachine ? (last.figures ?? null) : null;
const gate = [];
for (const [name, value] of Object.entries(figures)) {
  if (value === undefined || value === null) continue;
  const budget = BUDGETS[name];
  if (!budget) continue;
  const max = budget.max;
  const before = previous?.[name];
  const overBudget = value > max;
  const regressed =
    typeof before === 'number' && value > before * 1.5 && value - before > (budget.slack ?? 0);
  gate.push({
    name,
    value,
    budget: Number.isFinite(max) ? max : null,
    unit: budget.unit,
    previous: before ?? null,
    overBudget,
    regressed,
  });
}
out.figures = figures;
out.gate = gate;
writeFileSync(join(results, 'phase12.json'), JSON.stringify(out, null, 2) + '\n');
log('\nBudget                         value      budget   last main');
for (const g of gate)
  log(
    `${g.overBudget || g.regressed ? 'FAIL' : 'ok  '} ${g.name.padEnd(28)} ${String(g.value).padStart(7)} ${g.unit.padEnd(5)} ${String(g.budget ?? 'none').padStart(7)}   ${g.previous ?? '-'}${g.regressed ? '  (regressed)' : ''}`,
  );
if (!last) log('(No run on main to compare with: budgets only.)');
else if (!sameMachine)
  log(
    `(The last run on main ran on ${last.machine?.cpu ?? 'a processor it did not record'}, this one on ${out.machine.cpu}: budgets only.)`,
  );
process.exitCode = gate.some((g) => g.overBudget || g.regressed) ? 1 : 0;
