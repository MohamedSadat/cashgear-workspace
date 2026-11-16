// Phase 8's budgets (IMPLEMENTATION_PLAN.md, Phase 8, Performance benchmarks), measured and gated:
//   pnpm bench:phase8     the web app in Chrome against the server stack
// Needs `pnpm build`. The web app under vite preview on 127.0.0.1:4273 and the server stack on
// 127.0.0.1:5280 (scripts/server-stack.mjs --e2e) are reused when they answer, else started here
// and stopped at the end.
//
// The figures:
//   - a paste of 1,000 cells (bench/phase8-cells.mjs): 100 lines of 10 cells in Excel's shape into
//     a synced database's table, from the paste event to the cells and the notice shown (budget
//     500 ms) and to the server's rows holding them (budget 5 s); six pastes, the first a warm-up
//     (tracked), the worst of the others gated;
//   - a 1,000-page Notion export imported on the device (bench/phase8-import.mjs) into a local
//     workspace, so nothing is uploaded: from the file handed to the import panel to its report
//     (budget 60 s), reading and writing tracked apart; three imports, the worst gated.
// Each figure is checked against its budget and, when bench/previous/phase8.json holds the last
// run on main on the same processor (CI downloads it), against that: worse by half again and by
// more than a small margin fails. Writes bench/results/phase8.json.
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
import { CELL_BUDGETS, measurePaste, seedPasteDatabase } from './phase8-cells.mjs';
import { IMPORT_BUDGET, measureImport } from './phase8-import.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PASTES = Number(process.env.PHASE8_PASTES ?? 6);
const IMPORTS = Number(process.env.PHASE8_IMPORTS ?? 3);
const previousFile = join(root, 'bench/previous/phase8.json');
const results = join(root, 'bench/results');
const log = (line) => console.log(line);

/** Budgets, with the margin a regression must also exceed to fail (runners are noisy). */
const BUDGETS = {
  ...CELL_BUDGETS,
  notion1000Ms: IMPORT_BUDGET.notion1000Ms,
  // Tracked, not budgeted.
  notion1000ReadingMs: { max: Infinity, unit: 'ms', slack: 5000 },
  notion1000WritingMs: { max: Infinity, unit: 'ms', slack: 5000 },
};

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

/** The paste's figures: a synced workspace made through the API, its database's table in Chrome. */
async function paste(browser, errors) {
  const account = await newAccount('Phase 8 paste bench');
  const api = await apiSession(account);
  try {
    const seeded = await seedPasteDatabase(api);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${APP}/`);
    await signInPage(page, account, `${APP}/`);
    await page
      .getByTestId('sync-status')
      .filter({ hasText: /^Synced$/ })
      .waitFor({ timeout: 120000 });
    log(`A paste of 1,000 cells, ${PASTES} pastes (the first a warm-up)`);
    const figures = await measurePaste(page, api, seeded, { runs: PASTES, log });
    log(
      `  shown: worst ${figures.paste1000ShownMs} ms (p50 ${figures.paste1000ShownP50}); on the server: worst ${figures.paste1000ServerMs} ms (p50 ${figures.paste1000ServerP50})`,
    );
    await context.close();
    return figures;
  } finally {
    await api.dispose();
  }
}

/** The import's figures: a fresh profile, a local workspace, so nothing is uploaded. */
async function imports(browser, errors) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const figures = await measureImport(page, { app: APP, runs: IMPORTS, log });
  if (!figures.allMade) throw new Error('An import did not make every page of the export');
  log(
    `  worst ${figures.notion1000Ms.max} ms (p50 ${figures.notion1000Ms.p50}); reading worst ${figures.readingMs.max} ms, writing worst ${figures.writingMs.max} ms`,
  );
  await context.close();
  return figures;
}

async function web() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const errors = [];
  try {
    const pasted = await paste(browser, errors);
    const imported = await imports(browser, errors);
    if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
    return { browser: browser.version(), paste: pasted, import: imported };
  } catch (error) {
    for (const context of browser.contexts())
      for (const [i, page] of context.pages().entries())
        await page
          .screenshot({ path: join(results, `phase8-failure-${i}.png`) })
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

const figures = {
  paste1000ShownMs: out.web?.paste?.paste1000ShownMs,
  paste1000ServerMs: out.web?.paste?.paste1000ServerMs,
  paste1000ShownFirstMs: out.web?.paste?.paste1000ShownFirstMs,
  paste1000ServerFirstMs: out.web?.paste?.paste1000ServerFirstMs,
  notion1000Ms: out.web?.import?.notion1000Ms?.max,
  notion1000ReadingMs: out.web?.import?.readingMs?.max,
  notion1000WritingMs: out.web?.import?.writingMs?.max,
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
writeFileSync(join(results, 'phase8.json'), JSON.stringify(out, null, 2) + '\n');
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
