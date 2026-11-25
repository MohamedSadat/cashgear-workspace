// Phase 17's budgets (IMPLEMENTATION_PLAN.md, Phase 17, Performance benchmarks), measured and gated:
//   pnpm bench:phase17                   the browser's parts against the server stack, and the
//                                        server's (Phase17Bench)
//   pnpm bench:phase17 -- --server       the server's only
//   pnpm bench:phase17 -- --no-server    without them
// The browser's parts need `pnpm build`; the web app under vite preview on 127.0.0.1:4273 and the
// server stack on 127.0.0.1:5280 (scripts/server-stack.mjs --e2e) are reused when they answer, else
// started here and stopped at the end. They seed relations' values with one SQL statement through
// `sqlcmd` against the stack's database (cgw_e2e on `PHASE17_SQL_SERVER`, LocalDB by default), as a
// long-used workspace holds them: 40,000 operations would take the run's whole time.
//
// The figures:
//   - the table with sub-items: Phase 9's database of 50,000 rows (bench/phase9-timeline.mjs),
//     Parent and Sub-items switched on, the first 10,000 rows parents of four sub-items each, its
//     table first: from setting its route to the table's tree grid drawing its first row, the median
//     of five opens after a first, each from another page (Phase 4's budget, 500 ms);
//   - a timeline of 50,000 rows with 10,000 dependencies: the same database with Blocked by and
//     Blocking, every fifth row blocked by the row before it; Phase 9's first bars (median of five,
//     budget 500 ms) and a bar dragged along its line, the frames' p95 (budget 17.5 ms), its arrows
//     drawn;
//   - the server's (server/tests/Cgw.Tests/Phase17Bench.cs, `dotnet test -c Release`): with 10,000
//     runs waiting, a pass finding the 50 due p95 (budget 200 ms); 10,000 reminders due in a minute,
//     the largest lag from a reminder's moment to its inbox entry (budget 60 s); the tree's first
//     page of the 50,000-row table p95 (Phase 4's server query budget, 300 ms).
// Each figure is checked against its budget and, when bench/previous/phase17.json holds the last
// run on main on the same processor (CI downloads it), against that: worse by half again and by more
// than a small margin fails. Writes bench/results/phase17.json.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { TIMELINE_P, measureTimeline, seedTimelineDatabase } from './phase9-timeline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const previousFile = join(root, 'bench/previous/phase17.json');
const results = join(root, 'bench/results');
const log = (line) => console.log(line);
const args = process.argv.slice(2);
const serverOnly = args.includes('--server');
const withServer = !args.includes('--no-server');
const withWeb = !serverOnly;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Math.round(n * 10) / 10;
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};

/** Budgets, with the margin a regression must also exceed to fail (runners are noisy). */
const BUDGETS = {
  subItemsFirstRows50kMs: { max: 500, unit: 'ms', slack: 100 },
  depsTimelineFirstBars50kMs: { max: 500, unit: 'ms', slack: 100 },
  depsTimelineDragFrameP95: { max: 17.5, unit: 'ms', slack: 3 },
  waitsFoundP95Ms: { max: 200, unit: 'ms', slack: 30 },
  reminders10000MaxLagS: { max: 60, unit: 's', slack: 10 },
  treeQuery50kP95Ms: { max: 300, unit: 'ms', slack: 50 },
  // Tracked, not budgeted.
  subItemsFirstRows50kColdMs: { max: Infinity, unit: 'ms', slack: 1000 },
  depsTimelineFirstBars50kColdMs: { max: Infinity, unit: 'ms', slack: 1000 },
  waitsNoneDueP95Ms: { max: Infinity, unit: 'ms', slack: 30 },
  reminders10000P95LagS: { max: Infinity, unit: 's', slack: 10 },
};

const PARENT = 'Prnt0001';
const SUBS = 'Subs0001';
const BLOCKED_BY = 'BlkBy001';
const BLOCKING = 'Blkng001';

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

/** The pair of relations to the database itself, with their roles, as this build adds them. */
async function addPair(
  api,
  seeded,
  [first, firstName, firstRole],
  [second, secondName, secondRole],
  shift,
) {
  const relation = (id, name, reverse, role) => ({
    id,
    name,
    type: 'relation',
    relation: {
      databaseId: seeded.databaseId,
      reversePropertyId: reverse,
      role,
      ...(shift && role === 'blockedBy' ? { shift: true } : {}),
    },
  });
  const now = new Date().toISOString();
  const answer = await api.post(`/api/v1/workspaces/${seeded.workspaceId}/ops`, {
    ops: [
      {
        opId: crypto.randomUUID(),
        type: 'db.update',
        workspaceId: seeded.workspaceId,
        entityId: seeded.databaseId,
        baseVersion: null,
        payload: {
          properties: [
            relation(first, firstName, second, firstRole),
            relation(second, secondName, first, secondRole),
          ],
          propertyTypes: 22,
        },
        createdAt: now,
      },
    ],
  });
  if (answer.results[0].status !== 'applied')
    throw new Error('The relations were refused: ' + JSON.stringify(answer.results[0]));
}

/** The server the stack's database is on (scripts/server-stack.mjs's default: LocalDB). */
const SQL_SERVER = process.env.PHASE17_SQL_SERVER ?? '(localdb)\\MSSQLLocalDB';

/** One SQL statement against the stack's database, through sqlcmd. */
function sql(text) {
  const file = join(results, 'phase17-seed.sql');
  writeFileSync(file, text);
  const ran = spawnSync(
    'sqlcmd',
    ['-S', SQL_SERVER, '-E', '-d', 'cgw_e2e', '-b', '-I', '-i', file],
    { cwd: root, encoding: 'utf8' },
  );
  if (ran.error?.code === 'ENOENT' && process.platform === 'win32') {
    // No sqlcmd on this machine: the SqlServer module's own.
    const ps = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Invoke-Sqlcmd -ServerInstance '${SQL_SERVER}' -Database cgw_e2e -InputFile '${file}' -QueryTimeout 600 -ErrorAction Stop`,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    if (ps.status !== 0) throw new Error(`Invoke-Sqlcmd failed: ${ps.stdout}${ps.stderr}`);
    return;
  }
  if (ran.status !== 0)
    throw new Error(`sqlcmd failed: ${ran.stdout}${ran.stderr}${ran.error ?? ''}`);
}

const hex = (id) => id.replaceAll('-', '').toUpperCase();
/** A row id's text from its binary(16) in RFC order, as the server writes ids into values. */
const ID_TEXT = (column) =>
  `LOWER(STUFF(STUFF(STUFF(STUFF(CONVERT(varchar(32), ${column}, 2), 9, 0, '-'), 14, 0, '-'), 19, 0, '-'), 24, 0, '-'))`;

/**
 * Each row titled `Item n` (with n chosen by `where`) gets the row `Item m` (m by `other`) in a
 * relation, its rows' stamps raised past the database's so every cache reads them again.
 */
function relate(databaseId, property, where, other) {
  sql(`SET NOCOUNT ON;
DECLARE @db binary(16) = 0x${hex(databaseId)};
DECLARE @v bigint = (SELECT [RowsVersion] + 1 FROM [Databases] WHERE [PageId] = @db);
WITH items AS (
  SELECT p.[Id], CAST(SUBSTRING(p.[Title], 6, 5) AS int) AS n FROM [Pages] p
  WHERE p.[ParentPageId] = @db AND p.[IsTemplate] = 0 AND p.[Title] LIKE 'Item _____'
)
UPDATE r SET r.[Values] = JSON_MODIFY(r.[Values], '$."${property}"', JSON_QUERY(CONCAT('["', ${ID_TEXT('o.[Id]')}, '"]'))), r.[Seq] = @v
FROM [DatabaseRows] r JOIN items i ON r.[PageId] = i.[Id] JOIN items o ON o.n = ${other}
WHERE ${where};
UPDATE [Databases] SET [RowsVersion] = @v WHERE [PageId] = @db;
`);
}

/** The table moved before the timeline: the database opens on it. */
async function tableFirst(api, seeded) {
  const now = new Date().toISOString();
  const tree = await api.get(`/api/v1/workspaces/${seeded.workspaceId}/tree`);
  const timeline = tree.views.find((v) => v.id === seeded.timelineId);
  const answer = await api.post(`/api/v1/workspaces/${seeded.workspaceId}/ops`, {
    ops: [
      {
        opId: crypto.randomUUID(),
        type: 'view.upsert',
        workspaceId: seeded.workspaceId,
        entityId: seeded.timelineId,
        baseVersion: null,
        payload: { ...timeline, orderKey: 'a2', viewTypes: 8 },
        createdAt: now,
      },
    ],
  });
  if (answer.results[0].status !== 'applied')
    throw new Error('The view was refused: ' + JSON.stringify(answer.results[0]));
}

/** In the page: from setting the database's route to its tree grid's first row drawn. */
function openTreeTimed(databaseId) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    location.hash = `#/p/${databaseId}`;
    const check = () => {
      if (
        document.querySelector(
          '.cgw-database-page [role="treegrid"] [role="row"][aria-rowindex] .cgw-title-text',
        )
      )
        return resolve(performance.now() - started);
      if (performance.now() - started > 60000) return reject(new Error('No row in 60 s'));
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

async function devicePage(browser, account, errors) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${APP}/`);
  await page.evaluate(() => localStorage.setItem('cgw-persist-notice', new Date().toISOString()));
  await signInPage(page, account, `${APP}/`);
  await page
    .getByTestId('sync-status')
    .filter({ hasText: /^Synced$/ })
    .waitFor({ timeout: 180000 });
  return { context, page };
}

async function subItems(browser, errors) {
  const account = await newAccount('Phase 17 sub-items bench');
  const api = await apiSession(account);
  try {
    log('Seeding 50,000 rows, 10,000 of them parents of four sub-items each');
    const seeded = await seedTimelineDatabase(api, { name: 'Phase 17 sub-items' });
    await addPair(api, seeded, [PARENT, 'Parent', 'parent'], [SUBS, 'Sub-items', 'subItems']);
    relate(seeded.databaseId, PARENT, 'i.n >= 10000', '(i.n - 10000) % 10000');
    await tableFirst(api, seeded);
    const { context, page } = await devicePage(browser, account, errors);
    const times = [];
    for (let i = 0; i < 6; i++) {
      await page.evaluate((id) => (location.hash = `#/p/${id}`), seeded.other);
      await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 30000 });
      await sleep(i === 0 ? 0 : 500);
      times.push(await page.evaluate(openTreeTimed, seeded.databaseId));
    }
    const [cold, ...warm] = times;
    log(`  first open ${round(cold)} ms; then ${warm.map(round).join(', ')} ms`);
    // Its first parent nests its four sub-items.
    const expanded = await page
      .locator(
        '.cgw-database-page [role="treegrid"] [role="row"][aria-level="1"][aria-expanded="true"]',
      )
      .count();
    await context.close();
    if (!expanded) throw new Error('No parent shown with its sub-items');
    return {
      rows: seeded.rows,
      importMs: seeded.importMs,
      coldMs: round(cold),
      warm: warm.map(round),
      medianMs: round(percentile(warm, 0.5)),
    };
  } finally {
    await api.dispose();
  }
}

async function dependencies(browser, errors) {
  const account = await newAccount('Phase 17 dependencies bench');
  const api = await apiSession(account);
  try {
    log('Seeding 50,000 rows with 10,000 dependencies');
    const seeded = await seedTimelineDatabase(api, { name: 'Phase 17 dependencies' });
    await addPair(
      api,
      seeded,
      [BLOCKED_BY, 'Blocked by', 'blockedBy'],
      [BLOCKING, 'Blocking', 'blocking'],
      true,
    );
    relate(seeded.databaseId, BLOCKED_BY, 'i.n % 5 = 0 AND i.n > 0', 'i.n - 1');
    const { context, page } = await devicePage(browser, account, errors);
    const measured = await measureTimeline(page, seeded, { log });
    const arrows = await page.locator('.cgw-database-page [data-cg-timeline-link]').count();
    log(`  ${arrows} arrows drawn`);
    await context.close();
    if (!arrows) throw new Error('No dependency drawn');
    return { ...measured, arrows, start: TIMELINE_P.start };
  } finally {
    await api.dispose();
  }
}

async function web() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const errors = [];
  try {
    log('The table with sub-items: its first rows');
    const tree = await subItems(browser, errors);
    log('A timeline with dependencies: its first bars and a drag');
    const deps = await dependencies(browser, errors);
    if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
    return { browser: browser.version(), subItems: tree, dependencies: deps };
  } catch (error) {
    for (const context of browser.contexts())
      for (const [i, page] of context.pages().entries())
        await page
          .screenshot({ path: join(results, `phase17-failure-${i}.png`) })
          .catch(() => undefined);
    throw error;
  } finally {
    await browser.close();
  }
}

/** Phase17Bench in Release, with its switch on; reads the file it writes. */
function dotnetBench() {
  const ffi = join(
    root,
    'target/ffi',
    process.platform === 'win32' ? 'cgw_ydoc.dll' : 'libcgw_ydoc.so',
  );
  if (!existsSync(ffi)) {
    log('Building cgw-ydoc for the worker');
    const built = spawnSync('cargo', ['build', '-p', 'cgw-ydoc', '--profile', 'ffi'], {
      cwd: root,
      stdio: 'inherit',
    });
    if (built.status !== 0) throw new Error('cargo build -p cgw-ydoc --profile ffi failed');
  }
  const path = join(results, 'phase17-server.json');
  rmSync(path, { force: true });
  log('Running Phase17Bench (dotnet test -c Release)');
  const started = Date.now();
  const ran = spawnSync(
    'dotnet',
    [
      'test',
      '--solution',
      'server/Cgw.Server.slnx',
      '-c',
      'Release',
      '--',
      '--filter-class',
      '*Phase17Bench',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        CGW_TEST_LOG: process.env.CGW_TEST_LOG ?? 'Error',
        PHASE17_BENCH: '1',
      },
    },
  );
  if (!existsSync(path)) throw new Error('Phase17Bench wrote nothing (phase17-server.json)');
  return {
    ...JSON.parse(readFileSync(path, 'utf8')),
    testsPassed: ran.status === 0,
    minutes: Math.round((Date.now() - started) / 6000) / 10,
  };
}

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
  if (withWeb) {
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
    out.web = await web();
  }
} finally {
  for (const child of started.reverse()) stopTree(child);
}
if (withServer) out.server = dotnetBench();

const figures = {
  subItemsFirstRows50kMs: out.web?.subItems?.medianMs,
  subItemsFirstRows50kColdMs: out.web?.subItems?.coldMs,
  depsTimelineFirstBars50kMs: out.web?.dependencies?.figures?.timelineFirstBars50kMs,
  depsTimelineFirstBars50kColdMs: out.web?.dependencies?.figures?.timelineFirstBars50kColdMs,
  depsTimelineDragFrameP95: out.web?.dependencies?.figures?.timelineDragFrameP95,
  waitsFoundP95Ms: out.server?.waits?.found?.p95,
  waitsNoneDueP95Ms: out.server?.waits?.noneDue?.p95,
  reminders10000MaxLagS: out.server?.reminders?.lagSeconds?.max,
  reminders10000P95LagS: out.server?.reminders?.lagSeconds?.p95,
  treeQuery50kP95Ms: out.server?.tree?.query?.p95,
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
writeFileSync(join(results, 'phase17.json'), JSON.stringify(out, null, 2) + '\n');
log('\nBudget                             value      budget   last main');
for (const g of gate)
  log(
    `${g.overBudget || g.regressed ? 'FAIL' : 'ok  '} ${g.name.padEnd(32)} ${String(g.value).padStart(7)} ${g.unit.padEnd(3)} ${String(g.budget ?? 'none').padStart(7)}   ${g.previous ?? '-'}${g.regressed ? '  (regressed)' : ''}`,
  );
if (!last) log('(No run on main to compare with: budgets only.)');
else if (!sameMachine)
  log(
    `(The last run on main ran on ${last.machine?.cpu ?? 'a processor it did not record'}, this one on ${out.machine.cpu}: budgets only.)`,
  );
const testsFailed = out.server && !out.server.testsPassed;
if (testsFailed) log('A server benchmark test failed (see its output above).');
process.exitCode = gate.some((g) => g.overBudget || g.regressed) || testsFailed ? 1 : 0;
