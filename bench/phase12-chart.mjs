// Phase 12's chart view budget (IMPLEMENTATION_PLAN.md, Phase 12, Performance benchmarks: "a chart
// view of 50,000 rows by count: first drawn ≤ 1 s"), as a piece for bench/phase12.mjs to run and
// gate with its other figures, and also alone (`node bench/phase12-chart.mjs`, after `pnpm build`):
// the web app under vite preview on 127.0.0.1:4273 and the server stack on 127.0.0.1:5280
// (scripts/server-stack.mjs --e2e) are reused when they answer, else started and stopped at the
// end; alone it writes bench/results/phase12-chart.json. Written by the chart stream and not run
// there (the parent's proof runs the benches, which own the server stack and the ports).
//
//   import { CHART_BUDGETS, measureChart, seedChartDatabase } from './phase12-chart.mjs';
//   const seeded = await seedChartDatabase(api);           // through the API, as phase4.mjs seeds
//   // a Chrome page signed in as that account (scripts/cloud-account.mjs `signInPage`), then
//   const { figures } = await measureChart(page, seeded, { log });
//
// The database: a title, a Stage select of five options, an Amount number, Notes and Created by;
// its first view a chart (bars, a count of rows by Stage), then a table. 50,000 rows through the
// server's import route (`POST /databases/{id}/import`, as the import dialog sends a large file):
// row `i` is in stage `i % 5` with an amount of `5 + (i % 7) * 10` (`chartRow`, which the specs
// read too).
// Over `LOCAL_ROW_LIMIT`, so the server answers the chart's query: one grouped query whose group
// counts are the bars (a count reads no rows of its own).
//   - first drawn: from setting the database page's route (from another page) to the chart's
//     first bar on screen (`CgChart`'s `[data-cg-chart-point]`); the first open (the server reads
//     the database's rows into its cache, and the chart's drawing loads: tracked), then eight more,
//     each from another page; p95 of those eight (budget 1 s).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** Budgets, with the margin a regression must also exceed to fail, as bench/phase4.mjs has them. */
export const CHART_BUDGETS = {
  chartFirstDrawnP95Ms: { max: 1000, unit: 'ms', slack: 150 },
  // Tracked, not budgeted.
  chartFirstDrawnColdMs: { max: Infinity, unit: 'ms', slack: 1000 },
  chartImport50kMs: { max: Infinity, unit: 'ms', slack: 10000 },
};

const ROWS = Number(process.env.PHASE12_CHART_ROWS ?? 50000);
const OPENS = Number(process.env.PHASE12_CHART_OPENS ?? 8);
/** Property ids (8 characters of base 62) and the Stage options. */
export const CHART_P = {
  stage: 'Stage001',
  amount: 'Amount01',
  notes: 'Notes001',
  /** Created by: a person, whose values a share link or a site never shows (the specs' refusal). */
  creator: 'Creator1',
};
export const STAGES = ['Backlog', 'Planned', 'Doing', 'Review', 'Done'];
export const STAGE_IDS = STAGES.map((_, i) => `Stg0000${i}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n, width = 2) => String(n).padStart(width, '0');

/** A UUIDv7, as the clients make ids (the specs' operations take them too). */
export function uuidv7() {
  const bytes = randomBytes(16);
  let time = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Row `i`: its title, its stage's index and its amount (the import's and the specs' one rule). */
export function chartRow(i) {
  return { title: `Item ${pad(i, 5)}`, stage: i % 5, amount: 5 + (i % 7) * 10 };
}

/**
 * A chart view's settings as this build writes them (`ViewConfig.chart`, the view's properties
 * showing the title, the group's and the measure's properties): `shown` overrides the properties
 * shown (a hand-made view that hides what it measures).
 */
export function chartConfig({
  kind = 'bar',
  measure = { kind: 'count' },
  group = CHART_P.stage,
  title = null,
  shown,
} = {}) {
  const all = ['title', CHART_P.stage, CHART_P.amount, CHART_P.notes, CHART_P.creator];
  const show = shown ?? [
    'title',
    ...(group ? [group] : []),
    ...(measure.kind !== 'count' ? [measure.propertyId] : []),
  ];
  return {
    filter: null,
    sorts: [],
    group: group ? { propertyId: group } : null,
    properties: { order: show, hidden: all.filter((p) => !show.includes(p)), widths: {} },
    chart: { kind, measure, title },
  };
}

/**
 * A workspace with a database of `rows` rows (default 50,000) and its views, through the API as a
 * client makes them, the rows by the import route: `charts` are its first views (each `{ name,
 * ...chartConfig's options }`), then a table. Gives its ids, its views' ids by name and the
 * import's time.
 */
export async function seedChartDatabase(
  api,
  {
    rows = ROWS,
    name = 'Phase 12 chart',
    title = 'Fifty thousand rows',
    charts = [{ name: 'By stage' }],
  } = {},
) {
  const workspaceId = uuidv7();
  await api.post('/api/v1/workspaces', { id: workspaceId, name });
  const now = new Date().toISOString();
  const op = (type, entityId, payload) => ({
    opId: uuidv7(),
    type,
    workspaceId,
    entityId,
    baseVersion: null,
    payload,
    createdAt: now,
  });
  const check = (answer) => {
    const refused = answer.results.filter((r) => r.status !== 'applied');
    if (refused.length) throw new Error('Operations refused: ' + JSON.stringify(refused[0]));
  };
  const section = uuidv7();
  const databaseId = uuidv7();
  const other = uuidv7();
  const page = (id, kind, pageTitle, orderKey, extra = {}) => ({
    id,
    workspaceId,
    sectionId: section,
    parentPageId: null,
    orderKey,
    kind,
    title: pageTitle,
    icon: null,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    trashRootId: null,
    ...extra,
  });
  check(
    await api.post(`/api/v1/workspaces/${workspaceId}/ops`, {
      ops: [
        op('section.create', section, {
          id: section,
          workspaceId,
          name: 'Shared',
          orderKey: 'a0',
          visibility: 'workspace',
          version: 1,
          createdAt: now,
        }),
        op('page.create', other, page(other, 'page', 'Another page', 'a0')),
        op(
          'page.create',
          databaseId,
          page(databaseId, 'database', title, 'a1', {
            database: {
              properties: [
                { id: 'title', name: 'Name', type: 'title' },
                {
                  id: CHART_P.stage,
                  name: 'Stage',
                  type: 'select',
                  options: STAGES.map((n, i) => ({ id: STAGE_IDS[i], name: n, colour: 'blue' })),
                },
                { id: CHART_P.amount, name: 'Amount', type: 'number' },
                { id: CHART_P.notes, name: 'Notes', type: 'text' },
                { id: CHART_P.creator, name: 'Created by', type: 'createdBy' },
              ],
            },
          }),
        ),
      ],
    }),
  );
  const views = {};
  const view = (id, viewName, type, orderKey, config) => ({
    id,
    workspaceId,
    databaseId,
    name: viewName,
    type,
    orderKey,
    config,
    version: 1,
    createdAt: now,
    // As a build that knows the chart sends it.
    viewTypes: 7,
  });
  const tableId = uuidv7();
  const ops = charts.map((chart, i) => {
    const id = uuidv7();
    views[chart.name] = id;
    return op('view.upsert', id, view(id, chart.name, 'chart', `a${i}`, chartConfig(chart)));
  });
  ops.push(
    op(
      'view.upsert',
      tableId,
      view(tableId, 'Table', 'table', `a${charts.length}`, {
        filter: null,
        sorts: [],
        group: null,
        properties: { order: [], hidden: [], widths: {} },
        wrap: false,
      }),
    ),
  );
  views.Table = tableId;
  check(await api.post(`/api/v1/workspaces/${workspaceId}/ops`, { ops }));
  // The rows, through the import route (as the import dialog sends a file over 5,000 rows).
  const lines = ['Name,Stage,Amount,Notes'];
  for (let i = 0; i < rows; i++) {
    const row = chartRow(i);
    lines.push(`${row.title},${STAGES[row.stage]},${row.amount},Note number ${i}`);
  }
  const started = Date.now();
  const answer = await api.post(`/api/v1/databases/${databaseId}/import`, {
    csv: lines.join('\r\n') + '\r\n',
    columns: ['title', CHART_P.stage, CHART_P.amount, CHART_P.notes],
    header: true,
  });
  const importMs = Date.now() - started;
  if (answer.created !== rows)
    throw new Error(`The import made ${answer.created} rows: ${JSON.stringify(answer.problems)}`);
  return { workspaceId, databaseId, other, views, tableId, importMs, rows };
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};
const round = (n) => Math.round(n * 10) / 10;

/** From setting the route to the chart's first bar drawn, in the page. */
function openTimed(databaseId) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    location.hash = `#/p/${databaseId}`;
    const check = () => {
      if (document.querySelector('.cgw-database-page .cgw-db-chart [data-cg-chart-point]'))
        return resolve(performance.now() - started);
      if (performance.now() - started > 60000) return reject(new Error('No bar in 60 s'));
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

/**
 * The figures, in a page signed in as the seeding account (the database's own page, a fresh
 * profile: its first view, the chart): the first open's time and the p95 of the opens after it.
 */
export async function measureChart(page, seeded, { opens = OPENS, log = console.log } = {}) {
  log(`First drawing of a chart view of ${seeded.rows.toLocaleString('en')} rows by count`);
  const times = [];
  for (let i = 0; i <= opens; i++) {
    await page.evaluate((id) => (location.hash = `#/p/${id}`), seeded.other);
    await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 30000 });
    await sleep(i === 0 ? 0 : 500);
    times.push(await page.evaluate(openTimed, seeded.databaseId));
  }
  const [cold, ...warm] = times;
  // Every stage is a bar, counted by the server's query (beside "No Stage", a bar of none).
  const counts = await page
    .locator('.cgw-database-page .cgw-db-chart [data-cg-chart-point]')
    .evaluateAll((points) =>
      Object.fromEntries(points.map((p) => [p.dataset.cgArgument, p.dataset.cgValue])),
    );
  const each = (seeded.rows / STAGES.length).toLocaleString('en');
  for (const stage of STAGES)
    if (counts[stage] !== each)
      throw new Error(`The chart's ${stage} says ${counts[stage]}, not ${each}`);
  log(`  first open ${round(cold)} ms; then ${warm.map(round).join(', ')} ms`);
  const p95 = round(percentile(warm, 0.95));
  log(`  p95 ${p95} ms (budget ${CHART_BUDGETS.chartFirstDrawnP95Ms.max})`);
  return {
    firstDrawn: {
      coldMs: round(cold),
      warm: warm.map(round),
      medianMs: round(percentile(warm, 0.5)),
      p95Ms: p95,
    },
    figures: {
      chartFirstDrawnP95Ms: p95,
      chartFirstDrawnColdMs: round(cold),
      chartImport50kMs: seeded.importMs,
    },
  };
}

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

/** Alone: the stack and the preview (reused or started), one account, the figures gated. */
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
    const account = await newAccount('Phase 12 chart bench');
    const api = await apiSession(account);
    const browser = await chromium.launch({ channel: 'chrome' });
    try {
      log(`A chart view over ${ROWS.toLocaleString('en')} rows (seeding through the import route)`);
      const seeded = await seedChartDatabase(api);
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${APP}/`);
      await signInPage(page, account, `${APP}/`);
      await page
        .getByTestId('sync-status')
        .filter({ hasText: /^Synced$/ })
        .waitFor({ timeout: 180000 });
      const measured = await measureChart(page, seeded, { log });
      if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
      out.browser = browser.version();
      out.chart = measured.firstDrawn;
      out.figures = measured.figures;
    } catch (error) {
      const page = browser.contexts()[0]?.pages()[0];
      await page?.screenshot({ path: join(results, 'phase12-chart-failure.png') }).catch(() => {});
      throw error;
    } finally {
      await browser.close();
      await api.dispose();
    }
  } finally {
    for (const child of started.reverse()) stopTree(child);
  }
  out.gate = Object.entries(out.figures).map(([name, value]) => ({
    name,
    value,
    budget: Number.isFinite(CHART_BUDGETS[name].max) ? CHART_BUDGETS[name].max : null,
    unit: CHART_BUDGETS[name].unit,
    overBudget: value > CHART_BUDGETS[name].max,
  }));
  writeFileSync(join(results, 'phase12-chart.json'), JSON.stringify(out, null, 2) + '\n');
  for (const g of out.gate)
    log(
      `${g.overBudget ? 'FAIL' : 'ok  '} ${g.name.padEnd(30)} ${String(g.value).padStart(7)} ${g.unit} (budget ${g.budget ?? 'none'})`,
    );
  process.exitCode = out.gate.some((g) => g.overBudget) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await alone();
