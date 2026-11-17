// Phase 9's budgets (IMPLEMENTATION_PLAN.md, Phase 9, Performance benchmarks), measured and gated:
//   pnpm bench:phase9     the site over HTTP and the timeline in Chrome, against the server stack
// Needs `pnpm build`. The web app under vite preview on 127.0.0.1:4273 and the server stack on
// 127.0.0.1:5280 with the Sites process on localhost:5290 (scripts/server-stack.mjs --e2e) are
// reused when they answer, else started here and stopped at the end.
//
// The figures:
//   - a published page of 2,000 blocks (bench/phase9-site.mjs): 20 such pages under one published
//     root, each one's first answer's first byte (rendered fresh, budget 1 s at p95) and ten more
//     each (from the cache, budget 200 ms at p95), over HTTP with no account;
//   - a timeline over 50,000 rows (bench/phase9-timeline.mjs): from opening the database page to
//     its first bar (the median of five opens after a first, budget 500 ms) and a bar dragged along
//     its line (frame intervals' p95, budget 17.5 ms: 60 frames a second, as Phase 4's board).
// Each figure is checked against its budget and, when bench/previous/phase9.json holds the last
// run on main on the same processor (CI downloads it), against that: worse by half again and by
// more than a small margin fails. Writes bench/results/phase9.json.
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
import { SITES, SITE_BUDGETS, measureSite, seedSite } from './phase9-site.mjs';
import { TIMELINE_BUDGETS, measureTimeline, seedTimelineDatabase } from './phase9-timeline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const previousFile = join(root, 'bench/previous/phase9.json');
const results = join(root, 'bench/results');
const log = (line) => console.log(line);

/** Budgets, with the margin a regression must also exceed to fail (runners are noisy). */
const BUDGETS = { ...SITE_BUDGETS, ...TIMELINE_BUDGETS };

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

/** The site's figures: a published page of 2,000 blocks read over HTTP with no account. */
async function site() {
  const account = await newAccount('Phase 9 site bench');
  const api = await apiSession(account);
  try {
    log('A published site of 2,000-block pages');
    const seeded = await seedSite(api, { log });
    return await measureSite(seeded, { log });
  } finally {
    await api.dispose();
  }
}

/** The timeline's figures: a synced 50,000-row database's timeline in Chrome. */
async function timeline(browser, errors) {
  const account = await newAccount('Phase 9 timeline bench');
  const api = await apiSession(account);
  try {
    log('A timeline over 50,000 rows (seeding through the import route)');
    const seeded = await seedTimelineDatabase(api);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${APP}/`);
    await signInPage(page, account, `${APP}/`);
    await page
      .getByTestId('sync-status')
      .filter({ hasText: /^Synced$/ })
      .waitFor({ timeout: 180000 });
    const measured = await measureTimeline(page, seeded, { log });
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
    const drawn = await timeline(browser, errors);
    if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
    return { browser: browser.version(), timeline: drawn };
  } catch (error) {
    for (const context of browser.contexts())
      for (const [i, page] of context.pages().entries())
        await page
          .screenshot({ path: join(results, `phase9-failure-${i}.png`) })
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
  await waitFor(`${SITES}/health/live`, 120000);
  await startIfMissing(
    APP,
    `vite preview on ${APP}`,
    process.execPath,
    [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview'],
    { cwd: join(root, 'apps/web') },
  );
  out.site = await site();
  out.web = await web();
} finally {
  for (const child of started.reverse()) stopTree(child);
}

const figures = {
  siteCachedFirstByteP95Ms: out.site?.siteCachedFirstByteP95Ms,
  siteFreshFirstByteP95Ms: out.site?.siteFreshFirstByteP95Ms,
  siteSeedMs: out.site?.siteSeedMs,
  siteBytes: out.site?.siteBytes,
  ...(out.web?.timeline?.figures ?? {}),
};
const last = existsSync(previousFile) ? JSON.parse(readFileSync(previousFile, 'utf8')) : null;
const sameMachine = !!last && last.machine?.cpu === out.machine.cpu;
const previous = sameMachine ? (last.figures ?? null) : null;
const gate = [];
for (const [name, value] of Object.entries(figures)) {
  if (value === undefined || value === null) continue;
  const budget = BUDGETS[name];
  if (!budget) continue;
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
writeFileSync(join(results, 'phase9.json'), JSON.stringify(out, null, 2) + '\n');
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
