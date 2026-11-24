// Phase 16's budgets (IMPLEMENTATION_PLAN.md, Phase 16, Performance benchmarks), measured and gated:
//   pnpm bench:phase16      a form link's page, an answer to its row in an open tab, and 50 answers
//                           a second across links for a minute with typing in the app meanwhile
// Needs `pnpm build`; the web app under vite preview on 127.0.0.1:4273 and the server stack on
// 127.0.0.1:5280 with the Sites process on localhost:5290 (scripts/server-stack.mjs --e2e, whose
// answers' limits are raised for one address) are reused when they answer, else started here and
// stopped at the end.
//
// The figures:
//   - a form link's page, first byte: `GET /_form/{token}` on the Sites process, its first page
//     drawn once and then answered from the cache, sixty times after five, the time to its headers,
//     p95 (budget 200 ms, Phase 9's);
//   - an answer to its row in an open tab: a database open in Chrome as a table, an answer posted
//     to `POST /api/v1/forms/{token}` as the Sites process sends a last page on, from the post to
//     the row's title in the tab (the epoch clock: the page's `timeOrigin` plus its time), p95 of
//     twelve after a first (budget 2 s);
//   - 50 answers a second across five forms' links for a minute (3,000, each sent on its moment
//     whatever the others' answers), the answer route's time to its 303, p95 (budget 300 ms), while
//     another device of the person types on another page at a key every 35 ms: Phase 6's keystroke
//     budget there (keydown to the end of the editor's transaction p95 8 ms, 16 on CI's runner; to
//     the next frame p95 33 ms).
// Each figure is checked against its budget and, when bench/previous/phase16.json holds the last
// run on main on the same processor (CI downloads it), against that: worse by half again and by
// more than a small margin fails. Writes bench/results/phase16.json.
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest, Agent } from 'node:http';
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
import { answerFields, opOf, push, rowsByTitle, seedForm, uuidv7 } from './phase16-seed.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const previousFile = join(root, 'bench/previous/phase16.json');
const results = join(root, 'bench/results');
const log = (line) => console.log(line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Math.round(n * 10) / 10;
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};
const SITES = 'http://localhost:5290';

// The keystroke budget on CI's hosted runner is a frame (bench/phase5.mjs's note, Phase 6).
const KEY_WORK_MAX = process.env.CI ? 16 : 8;
/** Budgets, with the margin a regression must also exceed to fail (runners are noisy). */
const BUDGETS = {
  linkPageFirstByteP95Ms: { max: 200, unit: 'ms', slack: 30 },
  answerShownP95Ms: { max: 2000, unit: 'ms', slack: 300 },
  loadAnswerP95Ms: { max: 300, unit: 'ms', slack: 50 },
  loadKeyWorkP95: { max: KEY_WORK_MAX, unit: 'ms', slack: 2 },
  loadKeyFrameP95: { max: 33, unit: 'ms', slack: 5 },
  // Tracked, not budgeted.
  linkPageFirstByteP50Ms: { max: Infinity, unit: 'ms', slack: 30 },
  answerShownP50Ms: { max: Infinity, unit: 'ms', slack: 300 },
  loadAnswerP50Ms: { max: Infinity, unit: 'ms', slack: 50 },
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

// ------------------------------------------------------------------ a link's page, first byte
/** One GET's time to its headers, on a kept-alive connection. */
function firstByte(url, agent) {
  return new Promise((resolveTime, reject) => {
    const started = performance.now();
    const req = httpRequest(url, { agent }, (res) => {
      const ms = performance.now() - started;
      res.resume();
      res.on('end', () =>
        res.statusCode === 200 ? resolveTime(ms) : reject(new Error(`${url}: ${res.statusCode}`)),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function linkPage(api) {
  const seeded = await seedForm(api, { name: 'Phase 16 link page' });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    for (let i = 0; i < 5; i++) await firstByte(seeded.url, agent);
    const times = [];
    for (let i = 0; i < 60; i++) times.push(await firstByte(seeded.url, agent));
    log(
      `  first byte: p50 ${round(percentile(times, 0.5))} ms, p95 ${round(percentile(times, 0.95))} ms`,
    );
    return {
      requests: times.length,
      p50: round(percentile(times, 0.5)),
      p95: round(percentile(times, 0.95)),
    };
  } finally {
    agent.destroy();
  }
}

// ------------------------------------------------------------------ an answer, shown
/** In the page: the epoch moment a row titled `title` is in the table, looked at every frame. */
function shownIn(title) {
  return new Promise((resolveAt, reject) => {
    const started = performance.now();
    const check = () => {
      for (const row of document.querySelectorAll('.cgw-database-page [role="row"][aria-rowindex]'))
        if (row.querySelector('.cgw-title-text')?.textContent === title)
          return resolveAt(performance.timeOrigin + performance.now());
      if (performance.now() - started > 30000) return reject(new Error(`${title} never showed`));
      requestAnimationFrame(check);
    };
    check();
  });
}

/** An answer posted to the API as the Sites process sends a last page on: its time to the 303. */
async function answer(token, fields) {
  const started = performance.now();
  const response = await fetch(`${API}/api/v1/forms/${token}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  await response.arrayBuffer();
  return {
    ms: performance.now() - started,
    status: response.status,
    location: response.headers.get('location'),
  };
}

async function answerShown(browser, account, api, errors) {
  const seeded = await seedForm(api, { name: 'Phase 16 answer shown', rows: 2 });
  const { context, page } = await deviceOf(browser, account, errors);
  try {
    await page.evaluate((id) => (location.hash = `#/p/${id}`), seeded.databaseId);
    await page
      .locator('.cgw-database-page [role="row"][aria-rowindex="3"] .cgw-title-text')
      .waitFor({ timeout: 60000 });
    const times = [];
    for (let i = 0; i < 13; i++) {
      const title = `Shown ${i}`;
      const shown = page.evaluate(shownIn, title);
      const posted = Date.now();
      const sent = await answer(seeded.token, answerFields(title));
      if (sent.status !== 303 || !sent.location?.endsWith('/done'))
        throw new Error(`An answer was answered ${sent.status} ${sent.location}`);
      const ms = (await shown) - posted;
      times.push(ms);
      log(`  ${title}: shown ${Math.round(ms)} ms after the post`);
      await sleep(300);
    }
    const [first, ...rest] = times;
    return {
      answers: times.length,
      firstMs: Math.round(first),
      p50: Math.round(percentile(rest, 0.5)),
      p95: Math.round(percentile(rest, 0.95)),
      max: Math.round(Math.max(...rest)),
    };
  } finally {
    await context.close();
  }
}

// ------------------------------------------------------------------ 50 answers a second, typing
/** Keydown to the next frame painted, and to the end of the editor's transaction (Phase 1's). */
function probes() {
  if (window.__keys) return;
  const afterPaint = () =>
    new Promise((resolveFrame) =>
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolveFrame();
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

const RATE = 50;
const SECONDS = 60;
const LINKS = 5;

async function load(browser, account, api, errors) {
  const links = [];
  for (let i = 0; i < LINKS; i++) links.push(await seedForm(api, { name: `Phase 16 load ${i}` }));
  // The typist's page: a plain page of the first workspace, with no document yet.
  const first = links[0];
  const other = uuidv7();
  const now = new Date().toISOString();
  await push(api, first.workspaceId, [
    opOf(first.workspaceId, 'page.create', other, {
      id: other,
      workspaceId: first.workspaceId,
      sectionId: first.sectionId,
      parentPageId: null,
      orderKey: 'a5',
      kind: 'page',
      title: 'Notes while answers come',
      icon: null,
      coverAssetId: null,
      isTemplate: false,
      templateOfPageId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      trashRootId: null,
    }),
  ]);
  const typist = await deviceOf(browser, account, errors);
  try {
    await typist.page.evaluate(probes);
    await typist.page.evaluate((id) => (location.hash = `#/p/${id}`), other);
    const editor = typist.page.locator('.cgw-page .ProseMirror');
    await editor.waitFor({ timeout: 60000 });
    await editor.click();
    await typist.page.waitForFunction(() => window.__watchEditor?.());
    // Every link warm (its form read, a first answer written) before the minute.
    for (const link of links) await answer(link.token, answerFields('Warm'));
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
    const total = RATE * SECONDS;
    const sent = [];
    const startedAt = performance.now();
    for (let i = 0; i < total; i++) {
      const due = startedAt + (i * 1000) / RATE;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
      const link = links[i % LINKS];
      sent.push(
        answer(link.token, answerFields(`Load ${i}`)).catch((error) => ({
          ms: Infinity,
          status: 0,
          error: String(error),
        })),
      );
    }
    const answered = await Promise.all(sent);
    const tookSeconds = (performance.now() - startedAt) / 1000;
    done = true;
    await typing;
    const keys = await typist.page.evaluate(() => window.__keys);
    const times = answered.map((a) => a.ms);
    const statuses = {};
    for (const a of answered) statuses[a.status] = (statuses[a.status] ?? 0) + 1;
    const rows = [];
    for (const link of links) rows.push((await rowsByTitle(api, link.databaseId)).size);
    log(
      `  ${answered.length} answers in ${round(tookSeconds)} s (${JSON.stringify(statuses)}): p50 ${round(percentile(times, 0.5))} ms, p95 ${round(percentile(times, 0.95))} ms; rows ${rows.join(', ')}; ${keys.frame.length} keys: work p95 ${round(percentile(keys.work, 0.95))} ms, next frame p95 ${round(percentile(keys.frame, 0.95))} ms`,
    );
    if (statuses[303] !== total) throw new Error(`Answers: ${JSON.stringify(statuses)}`);
    // Each link's warm answer and its share of the minute's.
    if (rows.some((n) => n !== 1 + total / LINKS)) throw new Error(`Rows: ${rows.join(', ')}`);
    return {
      answers: answered.length,
      seconds: round(tookSeconds),
      perSecond: round(answered.length / tookSeconds),
      p50: round(percentile(times, 0.5)),
      p95: round(percentile(times, 0.95)),
      max: round(Math.max(...times)),
      keys: keys.frame.length,
      workP50: round(percentile(keys.work, 0.5)),
      workP95: round(percentile(keys.work, 0.95)),
      frameP50: round(percentile(keys.frame, 0.5)),
      frameP95: round(percentile(keys.frame, 0.95)),
    };
  } finally {
    await typist.context.close();
  }
}

async function web() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const errors = [];
  const account = await newAccount('Phase 16 bench');
  const api = await apiSession(account);
  try {
    log("A form link's page, first byte from the cache");
    const page = await linkPage(api);
    log('An answer to its row in an open tab');
    const shown = await answerShown(browser, account, api, errors);
    log('50 answers a second across links for a minute, typing on another page');
    const loaded = await load(browser, account, api, errors);
    if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
    return { browser: browser.version(), page, shown, load: loaded };
  } catch (error) {
    for (const context of browser.contexts())
      for (const [i, page] of context.pages().entries())
        await page
          .screenshot({ path: join(results, `phase16-failure-${i}.png`) })
          .catch(() => undefined);
    throw error;
  } finally {
    await api.dispose();
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
  out.web = await web();
} finally {
  for (const child of started.reverse()) stopTree(child);
}

const figures = {
  linkPageFirstByteP95Ms: out.web?.page?.p95,
  linkPageFirstByteP50Ms: out.web?.page?.p50,
  answerShownP95Ms: out.web?.shown?.p95,
  answerShownP50Ms: out.web?.shown?.p50,
  loadAnswerP95Ms: out.web?.load?.p95,
  loadAnswerP50Ms: out.web?.load?.p50,
  loadKeyWorkP95: out.web?.load?.workP95,
  loadKeyFrameP95: out.web?.load?.frameP95,
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
writeFileSync(join(results, 'phase16.json'), JSON.stringify(out, null, 2) + '\n');
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
process.exitCode = gate.some((g) => g.overBudget || g.regressed) ? 1 : 0;
