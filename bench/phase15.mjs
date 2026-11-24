// Phase 15's budgets (IMPLEMENTATION_PLAN.md, Phase 15, Performance benchmarks), measured and gated:
//   pnpm bench:phase15                   the rules in Chrome against the server stack, and the
//                                        server's date triggers over 50,000 rows
//   pnpm bench:phase15 -- --server       the server's date triggers only (Phase15Bench)
//   pnpm bench:phase15 -- --no-server    without them
// The client part needs `pnpm build`; the web app under vite preview on 127.0.0.1:4273 and the server
// stack on 127.0.0.1:5280 (scripts/server-stack.mjs --e2e) are reused when they answer, else started
// here and stopped at the end.
//
// The figures:
//   - a rule's first step after the change that starts it, shown in an open tab: a database of 20
//     rows (bench/phase15-seed.mjs) open in Chrome as a table, a rule "Points changed: Notes is
//     seen", and another device of the same person changing one row's Points at a time through the
//     operations route; from that push to the row's Notes showing "seen" in the tab (the epoch
//     clock: the page's `timeOrigin` plus its time), p95 of twelve after a first (budget 2 s);
//   - a paste of 1,000 cells that starts a rule in each row: Phase 8's paste (bench/phase8-cells.mjs,
//     100 lines of 10 cells into a table of 100 rows) with a rule on its Amount column changing
//     ("Seen is seen", a run a row: the rule's own limit, 100 a minute, is the paste's size), from
//     the paste to every run done (budget 60 s), while another device of the person types on
//     another page at a key every 35 ms: Phase 6's keystroke budget there (keydown to the end of the
//     editor's transaction p95 8 ms, 16 on CI's runner; to the next frame p95 33 ms);
//   - date triggers over a database of 50,000 rows (server/tests/Cgw.Tests/Phase15Bench.cs,
//     `dotnet test -c Release`): the worker's time a pass after a row changed (the rows written
//     since read), and a pass reading every row's date (after the rule is saved, and every ten
//     minutes), p95, each budget 500 ms; the first pass and passes with nothing changed tracked.
// The fourth budget, the server's processor time per push to a database with 10 rules within 10 % of
// the same push with none, is bench/phase8-server.mjs's (`--rows --before . --rules-before 0
// --rules-after 10`), over real processes and taken locally (PROGRESS.md, Phase 15).
// Each figure is checked against its budget and, when bench/previous/phase15.json holds the last
// run on main on the same processor (CI downloads it), against that: worse by half again and by
// more than a small margin fails. Writes bench/results/phase15.json.
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
import { P, opOf, push, rowsByTitle, runsOf, saveRule, seedTasks } from './phase15-seed.mjs';
import { pasteText, seedPasteDatabase } from './phase8-cells.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const previousFile = join(root, 'bench/previous/phase15.json');
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

// The keystroke budget on CI's hosted runner is a frame (bench/phase5.mjs's note, Phase 6).
const KEY_WORK_MAX = process.env.CI ? 16 : 8;
/** Budgets, with the margin a regression must also exceed to fail (runners are noisy). */
const BUDGETS = {
  firstStepShownP95Ms: { max: 2000, unit: 'ms', slack: 300 },
  pasteRunsDoneMs: { max: 60000, unit: 'ms', slack: 5000 },
  pasteKeyWorkP95: { max: KEY_WORK_MAX, unit: 'ms', slack: 2 },
  pasteKeyFrameP95: { max: 33, unit: 'ms', slack: 5 },
  dates50000AfterChangeP95Ms: { max: 500, unit: 'ms', slack: 75 },
  dates50000FullP95Ms: { max: 500, unit: 'ms', slack: 75 },
  // Tracked, not budgeted.
  firstStepShownP50Ms: { max: Infinity, unit: 'ms', slack: 300 },
  dates50000FirstPassMs: { max: Infinity, unit: 'ms', slack: 500 },
  dates50000HeldP95Ms: { max: Infinity, unit: 'ms', slack: 20 },
};

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

/** A signed-in Chrome page of its own (a device of the person), Synced. */
async function deviceOf(browser, account, errors) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${APP}/`);
  await signInPage(page, account, `${APP}/`);
  await page
    .getByTestId('sync-status')
    .filter({ hasText: /^Synced$/ })
    .waitFor({ timeout: 180000 });
  return { context, page };
}

// ------------------------------------------------------------------ the first step, shown
/** In the page: the epoch moment row `title` shows `text`, looked at every frame. */
function shownIn([title, text]) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const check = () => {
      for (const row of document.querySelectorAll('.cgw-database-page [role="row"][aria-rowindex]'))
        if (
          row.querySelector('.cgw-title-text')?.textContent === title &&
          row.textContent?.includes(text)
        )
          return resolve(performance.timeOrigin + performance.now());
      if (performance.now() - started > 30000) return reject(new Error(`${title} never showed`));
      requestAnimationFrame(check);
    };
    check();
  });
}

async function firstStep(browser, errors) {
  const account = await newAccount('Phase 15 first step bench');
  const api = await apiSession(account);
  const runs = 13;
  try {
    const seeded = await seedTasks(api, { rows: runs, name: 'Phase 15 first step' });
    await saveRule(api, seeded, {
      name: 'Points seen',
      trigger: { kind: 'propertyChanged', propertyId: P.points },
      steps: [{ kind: 'set', values: { [P.notes]: 'seen' } }],
    });
    const rows = await rowsByTitle(api, seeded.databaseId);
    const { context, page } = await deviceOf(browser, account, errors);
    await page.evaluate((id) => (location.hash = `#/p/${id}`), seeded.databaseId);
    await page
      .locator(`.cgw-database-page [role="row"][aria-rowindex="${runs + 1}"] .cgw-title-text`)
      .waitFor({ timeout: 60000 });
    const times = [];
    for (let i = 0; i < runs; i++) {
      const title = `Task ${i}`;
      const shown = page.evaluate(shownIn, [title, 'seen']);
      const pushed = Date.now();
      await push(api, seeded.workspaceId, [
        opOf(seeded.workspaceId, 'row.update', rows.get(title).id, {
          values: { [P.points]: 100 + i },
        }),
      ]);
      const ms = (await shown) - pushed;
      times.push(ms);
      log(`  ${title}: shown ${Math.round(ms)} ms after the push`);
      await sleep(300);
    }
    await context.close();
    const [first, ...rest] = times;
    return {
      changes: runs,
      firstMs: Math.round(first),
      p50: Math.round(percentile(rest, 0.5)),
      p95: Math.round(percentile(rest, 0.95)),
      max: Math.round(Math.max(...rest)),
    };
  } finally {
    await api.dispose();
  }
}

// ------------------------------------------------------------------ the paste and its runs
/** Keydown to the next frame painted, and to the end of the editor's transaction (Phase 1's). */
function probes() {
  if (window.__keys) return;
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
    if (!view?.editor) return false;
    if (view.__watched) return true;
    view.__watched = true;
    view.editor.on('transaction', ({ transaction }) => {
      if (start === null || !transaction.docChanged) return;
      window.__keys.work.push(performance.now() - start);
      start = null;
    });
    return true;
  };
}

/** In the page: the paste dispatched on the table's grid, as the browser sends one; its epoch. */
function pasteOn(text) {
  const grid = document.querySelector('.cgw-database-page [role="grid"]');
  if (!grid) throw new Error('No table on the page');
  grid.focus();
  const data = new DataTransfer();
  data.setData('text/plain', text);
  const at = performance.timeOrigin + performance.now();
  grid.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
  );
  return at;
}

async function paste(browser, errors) {
  const account = await newAccount('Phase 15 paste bench');
  const api = await apiSession(account);
  try {
    const seeded = await seedPasteDatabase(api);
    // A property the rule writes, and the rule: a run for each row whose Amount the paste changes.
    const seen = 'PSeen001';
    await push(api, seeded.workspaceId, [
      opOf(seeded.workspaceId, 'db.update', seeded.databaseId, {
        properties: [{ id: seen, name: 'Seen', type: 'text' }],
      }),
    ]);
    const rule = await saveRule(api, seeded, {
      name: 'Amount seen',
      trigger: { kind: 'propertyChanged', propertyId: 'PAmount1' },
      steps: [{ kind: 'set', values: { [seen]: 'seen' } }],
    });

    // The typist: another device of the person, on another page.
    const typist = await deviceOf(browser, account, errors);
    await typist.page.evaluate(probes);
    await typist.page.evaluate((id) => (location.hash = `#/p/${id}`), seeded.other);
    // A page made with no document: its editor, empty, takes what is typed.
    const editor = typist.page.locator('.cgw-page .ProseMirror');
    await editor.waitFor({ timeout: 60000 });
    await editor.click();
    await typist.page.waitForFunction(() => window.__watchEditor?.());
    // The paster: the database's table, its first cell.
    const paster = await deviceOf(browser, account, errors);
    await paster.page.evaluate((id) => (location.hash = `#/p/${id}`), seeded.databaseId);
    await paster.page.waitForFunction(
      () =>
        document.querySelector('.cgw-database-page .cgw-table-foot')?.textContent === 'Rows: 100',
      null,
      { timeout: 60000 },
    );
    const grid = paster.page.locator('.cgw-database-page [role="grid"]');
    await grid.focus();
    await grid.press('Control+Home');
    await grid.press('ArrowDown');

    // Typing from before the paste until every run is done.
    await typist.page.keyboard.type('warm ', { delay: 35 });
    await typist.page.evaluate(() => {
      window.__keys.frame.length = 0;
      window.__keys.work.length = 0;
    });
    let done = false;
    const text = 'the quick brown fox jumps over the lazy dog and keeps on typing ';
    const typing = (async () => {
      for (let chunk = 0; !done; chunk = (chunk + 8) % text.length)
        await typist.page.keyboard.type(text.slice(chunk, chunk + 8), { delay: 35 });
    })();
    await sleep(1000);
    const pastedAt = await paster.page.evaluate(pasteOn, pasteText(1));
    let doneAt = null;
    let finished = [];
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      finished = (await runsOf(api, seeded, rule.id)).filter((r) => r.status !== 'running');
      if (finished.length >= 100) {
        doneAt = Date.now();
        break;
      }
      await sleep(250);
    }
    done = true;
    await typing;
    const keys = await typist.page.evaluate(() => window.__keys);
    const statuses = {};
    for (const run of finished) statuses[run.status] = (statuses[run.status] ?? 0) + 1;
    const runsDoneMs = doneAt === null ? Infinity : Math.round(doneAt - pastedAt);
    log(
      `  ${finished.length} runs ended (${JSON.stringify(statuses)}) ${runsDoneMs} ms after the paste; ${keys.frame.length} keys: work p95 ${round(percentile(keys.work, 0.95))} ms, next frame p95 ${round(percentile(keys.frame, 0.95))} ms`,
    );
    await typist.context.close();
    await paster.context.close();
    if (statuses.done !== 100) throw new Error(`Runs: ${JSON.stringify(statuses)}`);
    return {
      runs: finished.length,
      statuses,
      runsDoneMs,
      keys: keys.frame.length,
      workP50: round(percentile(keys.work, 0.5)),
      workP95: round(percentile(keys.work, 0.95)),
      frameP50: round(percentile(keys.frame, 0.5)),
      frameP95: round(percentile(keys.frame, 0.95)),
    };
  } finally {
    await api.dispose();
  }
}

async function web() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const errors = [];
  try {
    log("A rule's first step after the change that starts it, shown in an open tab");
    const first = await firstStep(browser, errors);
    log('A paste of 1,000 cells that starts a rule in each row, typing on another page');
    const pasted = await paste(browser, errors);
    if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
    return { browser: browser.version(), first, paste: pasted };
  } catch (error) {
    for (const context of browser.contexts())
      for (const [i, page] of context.pages().entries())
        await page
          .screenshot({ path: join(results, `phase15-failure-${i}.png`) })
          .catch(() => undefined);
    throw error;
  } finally {
    await browser.close();
  }
}

/** Phase15Bench in Release, with its switch on; reads the file it writes. */
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
  const path = join(results, 'phase15-server.json');
  rmSync(path, { force: true });
  log('Running Phase15Bench (dotnet test -c Release)');
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
      '*Phase15Bench',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        CGW_TEST_LOG: process.env.CGW_TEST_LOG ?? 'Error',
        PHASE15_BENCH: '1',
      },
    },
  );
  if (!existsSync(path)) throw new Error('Phase15Bench wrote nothing (phase15-server.json)');
  return {
    ...JSON.parse(readFileSync(path, 'utf8')),
    testsPassed: ran.status === 0,
    minutes: Math.round((Date.now() - started) / 6000) / 10,
  };
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
  firstStepShownP95Ms: out.web?.first?.p95,
  firstStepShownP50Ms: out.web?.first?.p50,
  pasteRunsDoneMs: out.web?.paste?.runsDoneMs,
  pasteKeyWorkP95: out.web?.paste?.workP95,
  pasteKeyFrameP95: out.web?.paste?.frameP95,
  dates50000AfterChangeP95Ms: out.server?.afterChange?.p95,
  dates50000FullP95Ms: out.server?.full?.p95,
  dates50000FirstPassMs: out.server?.firstPassMs,
  dates50000HeldP95Ms: out.server?.held?.p95,
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
writeFileSync(join(results, 'phase15.json'), JSON.stringify(out, null, 2) + '\n');
log('\nBudget                           value      budget   last main');
for (const g of gate)
  log(
    `${g.overBudget || g.regressed ? 'FAIL' : 'ok  '} ${g.name.padEnd(30)} ${String(g.value).padStart(7)} ${g.unit.padEnd(3)} ${String(g.budget ?? 'none').padStart(7)}   ${g.previous ?? '-'}${g.regressed ? '  (regressed)' : ''}`,
  );
if (!last) log('(No run on main to compare with: budgets only.)');
else if (!sameMachine)
  log(
    `(The last run on main ran on ${last.machine?.cpu ?? 'a processor it did not record'}, this one on ${out.machine.cpu}: budgets only.)`,
  );
const testsFailed = out.server && !out.server.testsPassed;
if (testsFailed) log('A server benchmark test failed (see its output above).');
process.exitCode = gate.some((g) => g.overBudget || g.regressed) || testsFailed ? 1 : 0;
