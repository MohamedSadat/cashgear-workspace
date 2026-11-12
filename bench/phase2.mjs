// Phase 2's budgets (IMPLEMENTATION_PLAN.md, Phase 2, Performance benchmarks), measured and gated.
//   pnpm bench:phase2                    both parts
//   pnpm bench:phase2 -- --server        the server part only (CI: the Linux server job)
//   pnpm bench:phase2 -- --first-sync    the first sync only (CI: the Windows job, after e2e)
//
// The server part. Yjs 13 writes the corpus (bench/editor/src/phase2-corpus.test.ts, into
// bench/results/phase2-corpus); then server/tests/Cgw.Tests/Phase2Bench.cs runs, built with
// -c Release, in process on SQL Server and Azurite through the real API and worker: push round
// trips one at a time, pulls of 200 validated updates, the change feed of 1,000 changes, search at
// 10,000 pages in English and Arabic, compaction of a document of about 1 MB, and the load test
// (200 people typing for a minute while pulling, every update checked). It writes
// bench/results/phase2-server.json. Needs .NET 10, cargo (cgw-ydoc's library is built when
// target/ffi lacks it) and SQL Server: LocalDB (no full-text: search takes the LIKE path), or the
// server in CGW_TEST_SQL (CI's has full-text). PHASE2_LOAD_USERS, PHASE2_LOAD_SECONDS,
// PHASE2_LOAD_WORKSPACES, PHASE2_LOAD_PER_PAGE, PHASE2_LOAD_INTERVAL_MS and PHASE2_LOAD_TIMEOUT_S
// shape the load test (Phase2Bench.cs has the defaults).
//
// The first sync. The web app as built (pnpm build first) under vite preview on 127.0.0.1:4273,
// and the server stack on 127.0.0.1:5280: each is reused when it answers, else started here
// (scripts/server-stack.mjs --e2e) and stopped at the end. An account and its 1,000-page
// workspace (metadata only) are made through the API; then a fresh Chrome context signs in on the
// API's page, and the time from landing back in the app to all 1,000 pages being in its IndexedDB
// store (cgw-workspace, store "pages") is taken. The median of PHASE2_FIRST_SYNC_RUNS (5) runs.
//
// Each figure is checked against its budget and, when bench/previous/phase2.json holds the last
// run on main (CI downloads it), against that: worse by half again and by more than a small margin
// fails. Writes bench/results/phase2.json.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, request } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const only = args.includes('--server')
  ? 'server'
  : args.includes('--first-sync')
    ? 'firstSync'
    : null;
const previousFile = join(root, 'bench/previous/phase2.json');
const results = join(root, 'bench/results');
const API = 'http://127.0.0.1:5280';
const APP = 'http://127.0.0.1:4273';

/** Budgets, with the margin a regression must also exceed to fail (runners are noisy). */
const BUDGETS = {
  pushP95: { max: 200, unit: 'ms', slack: 20 },
  pull200P95: { max: 300, unit: 'ms', slack: 30 },
  feed1000P95: { max: 500, unit: 'ms', slack: 50 },
  searchP95: { max: 300, unit: 'ms', slack: 30 },
  compaction1MBP95: { max: 200, unit: 'ms', slack: 20 },
  firstSync1000Ms: { max: 5000, unit: 'ms', slack: 500 },
  loadMissed: { max: 0, unit: '', slack: 0 },
  loadErrorRatePct: { max: 0.1, unit: '%', slack: 0.05 },
  // An edit reaches the page's other readers within 5 s at p95 with 200 people typing (DECISIONS.md,
  // 2026-11-12: Phase 3); 26 to 65 s at the end of Phase 2.
  loadVisibleP95: { max: 5000, unit: 'ms', slack: 1000 },
};

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};
const log = (line) => console.log(line);
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function answers(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function waitFor(url, ms) {
  const deadline = Date.now() + ms;
  while (!(await answers(url))) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + url);
    await sleep(500);
  }
}

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

// ------------------------------------------------------------------ the server part
function server() {
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
  const corpus = join(results, 'phase2-corpus');
  log('Writing the corpus with Yjs');
  const written = spawnSync(
    process.execPath,
    [join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'bench/editor/src/phase2-corpus.test.ts'],
    { cwd: root, stdio: 'inherit', env: { ...process.env, PHASE2_CORPUS: corpus } },
  );
  if (written.status !== 0 || !existsSync(join(corpus, 'load.json')))
    throw new Error('The corpus was not written');

  const file = join(results, 'phase2-server.json');
  rmSync(file, { force: true });
  log('Running the server benchmarks (dotnet test -c Release, Phase2Bench)');
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
      '*Phase2Bench*',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      // The API logs a warning for every push under the test server (no body size feature).
      env: {
        ...process.env,
        PHASE2_CORPUS: corpus,
        CGW_TEST_LOG: process.env.CGW_TEST_LOG ?? 'Error',
      },
    },
  );
  const figures = readJson(file);
  if (!figures)
    throw new Error('The server benchmarks wrote nothing (bench/results/phase2-server.json)');
  return {
    ...figures,
    testsPassed: ran.status === 0,
    minutes: Math.round((Date.now() - started) / 6000) / 10,
  };
}

// ------------------------------------------------------------------ the first sync in the browser
const MAILS = [join(root, '.cgw-dev/e2e/mail'), join(root, '.cgw-dev/mail')];

/** The newest mail to an address in the stack's pickup folder, quoted-printable undone. */
async function mailTo(address) {
  for (let i = 0; i < 200; i++) {
    for (const folder of MAILS) {
      let files;
      try {
        files = readdirSync(folder)
          .filter((f) => f.endsWith('.eml'))
          .map((f) => join(folder, f))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
          .slice(0, 50);
      } catch {
        continue;
      }
      for (const path of files) {
        let text;
        try {
          text = readFileSync(path, 'utf8')
            .replace(/=\r?\n/g, '')
            .replace(/=3D/g, '=');
        } catch {
          continue;
        }
        if (text.toLowerCase().includes(address.toLowerCase())) return text;
      }
    }
    await sleep(100);
  }
  throw new Error(`No mail to ${address}`);
}

/** A confirmed account, as tests/e2e/cloud.ts makes one. */
async function newAccount() {
  const email = `bench-${Date.now()}-${randomBytes(4).toString('hex')}@example.test`;
  const password = `a long bench password ${randomBytes(6).toString('hex')}`;
  const register = await fetch(`${API}/api/v1/account/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName: 'First sync', locale: 'en' }),
  });
  if (register.status !== 202) throw new Error(`Sign-up answered ${register.status}`);
  const link = (await mailTo(email)).match(/http:\/\/127\.0\.0\.1:5280\/account\/confirm[^\s"<>]+/);
  if (!link) throw new Error('No confirmation link in the mail');
  const url = new URL(link[0].replace(/&amp;/g, '&'));
  const confirmed = await fetch(`${API}/api/v1/account/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: url.searchParams.get('userId'),
      code: url.searchParams.get('code'),
    }),
  });
  if (confirmed.status !== 204) throw new Error(`Confirming answered ${confirmed.status}`);
  return { email, password };
}

function uuidv7() {
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

/** The workspace through the API as a signed-in client makes it: 50 pages with 19 under each. */
async function seedWorkspace(account) {
  const api = await request.newContext({ baseURL: API });
  try {
    const form = await (await api.get('/account/signin')).text();
    const token = form.match(/name="__RequestVerificationToken" value="([^"]+)"/)?.[1];
    if (!token) throw new Error('No antiforgery token on the sign-in page');
    const signedIn = await api.post('/account/signin', {
      form: {
        __RequestVerificationToken: token
          .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/&amp;/g, '&'),
        Email: account.email,
        Password: account.password,
        ReturnUrl: '',
      },
      maxRedirects: 0,
    });
    if (signedIn.status() !== 302) throw new Error(`Sign-in answered ${signedIn.status()}`);
    const csrf = await (await api.get('/api/v1/account/antiforgery')).json();
    const headers = { [csrf.header ?? 'X-CSRF-TOKEN']: csrf.token };
    const post = async (path, data) => {
      const response = await api.post(path, { data, headers });
      if (!response.ok()) throw new Error(`${path}: ${response.status()} ${await response.text()}`);
      return response.json();
    };
    const workspaceId = uuidv7();
    await post('/api/v1/workspaces', { id: workspaceId, name: 'First sync, 1,000 pages' });
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
    const digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const key = (i) => 'a' + digits[i];
    const shared = uuidv7();
    const personal = uuidv7();
    const section = (id, name, orderKey, visibility) =>
      op('section.create', id, {
        id,
        workspaceId,
        name,
        orderKey,
        visibility,
        version: 1,
        createdAt: now,
      });
    const page = (id, parentPageId, orderKey, title) =>
      op('page.create', id, {
        id,
        workspaceId,
        sectionId: shared,
        parentPageId,
        orderKey,
        kind: 'page',
        title,
        icon: null,
        coverAssetId: null,
        isTemplate: false,
        templateOfPageId: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
        trashedAt: null,
        trashRootId: null,
      });
    const check = (answer) => {
      const refused = answer.results.filter((r) => r.status !== 'applied');
      if (refused.length) throw new Error('Operations refused: ' + JSON.stringify(refused[0]));
    };
    check(
      await post(`/api/v1/workspaces/${workspaceId}/ops`, {
        ops: [
          section(shared, 'Shared', 'a0', 'workspace'),
          section(personal, 'Private', 'a1', 'private'),
        ],
      }),
    );
    for (let batch = 0; batch < 10; batch++) {
      const ops = [];
      for (let p = batch * 5; p < batch * 5 + 5; p++) {
        const parent = uuidv7();
        ops.push(page(parent, null, key(p), `Project ${p + 1}`));
        for (let c = 0; c < 19; c++)
          ops.push(page(uuidv7(), parent, key(c), `Project ${p + 1}, task ${c + 1}`));
      }
      check(await post(`/api/v1/workspaces/${workspaceId}/ops`, { ops }));
    }
    return workspaceId;
  } finally {
    await api.dispose();
  }
}

/** Polls the app's own store until the workspace holds `want` pages; returns the page's Date.now(). */
function pagesStored({ workspaceId, want }) {
  const count = async () => {
    // Never open the store before the app has made it: an open without a version would make an
    // empty version-1 store that the app's upgrade then builds on.
    const info = (await indexedDB.databases()).find((d) => d.name === 'cgw-workspace');
    if (!info || !info.version || info.version < 2) return 0;
    return new Promise((resolveCount) => {
      const open = indexedDB.open('cgw-workspace');
      open.onerror = () => resolveCount(0);
      open.onblocked = () => resolveCount(0);
      open.onsuccess = () => {
        const db = open.result;
        db.onversionchange = () => db.close();
        try {
          const counted = db
            .transaction('pages', 'readonly')
            .objectStore('pages')
            .index('workspace')
            .count(workspaceId);
          counted.onsuccess = () => {
            db.close();
            resolveCount(counted.result);
          };
          counted.onerror = () => {
            db.close();
            resolveCount(0);
          };
        } catch {
          db.close();
          resolveCount(0);
        }
      };
    });
  };
  return (async () => {
    for (;;) {
      if ((await count()) >= want) return Date.now();
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
}

async function firstSync() {
  if (!existsSync(join(root, 'apps/web/dist/index.html'))) throw new Error('Run pnpm build first.');
  const started = [];
  try {
    if (!(await answers(`${API}/health/live`))) {
      log('Starting the server stack (scripts/server-stack.mjs --e2e)');
      started.push(
        spawn(process.execPath, [join(root, 'scripts/server-stack.mjs'), '--e2e'], {
          cwd: root,
          stdio: 'ignore',
        }),
      );
      await waitFor(`${API}/health/live`, 600000);
    } else log('Reusing the server stack on 127.0.0.1:5280');
    if (!(await answers(APP))) {
      log('Starting vite preview on 127.0.0.1:4273');
      started.push(
        spawn(process.execPath, [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview'], {
          cwd: join(root, 'apps/web'),
          stdio: 'ignore',
        }),
      );
      await waitFor(APP, 60000);
    } else log('Reusing the web app on 127.0.0.1:4273');

    const account = await newAccount();
    const seeding = Date.now();
    const workspaceId = await seedWorkspace(account);
    log(`  seeded 1,000 pages through the API in ${Date.now() - seeding} ms`);

    const browser = await chromium.launch({ channel: 'chrome' });
    const runs = [];
    const errors = [];
    try {
      for (let i = 0; i < Number(process.env.PHASE2_FIRST_SYNC_RUNS ?? 5); i++) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        try {
          const page = await context.newPage();
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(`${API}/account/signin?returnUrl=${encodeURIComponent(APP + '/')}`);
          await page.getByLabel('Email').fill(account.email);
          await page.getByLabel('Password').fill(account.password);
          await page.getByRole('button', { name: 'Sign in' }).click();
          await page.waitForURL((url) => url.origin === APP, {
            waitUntil: 'commit',
            timeout: 30000,
          });
          const landed = Date.now();
          let done = null;
          for (let attempt = 0; done === null && attempt < 20; attempt++) {
            try {
              done = await Promise.race([
                page.evaluate(pagesStored, { workspaceId, want: 1000 }),
                sleep(60000).then(() => {
                  throw new Error('The first sync did not finish within 60 s');
                }),
              ]);
            } catch (error) {
              // The app replaced its document (a redirect of its own): poll the new one.
              if (!/Execution context was destroyed|navigation/i.test(String(error))) throw error;
            }
          }
          if (done === null) throw new Error('The page kept navigating');
          runs.push(done - landed);
          log(`  run ${i + 1}: ${done - landed} ms from landing to 1,000 pages stored`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
    if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
    return {
      pages: 1000,
      statistic: 'median',
      runs,
      median: percentile(runs, 0.5),
      max: Math.max(...runs),
      browser: 'Chrome',
    };
  } finally {
    for (const child of started.reverse()) stopTree(child);
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
if (only !== 'firstSync') out.server = server();
if (only !== 'server') out.firstSync = await firstSync();

const s = out.server;
const figures = {
  pushP95: s?.push?.p95,
  pull200P95: s?.pull200?.p95,
  feed1000P95: s?.feed1000?.p95,
  searchP95: s?.search?.p95,
  // The step itself: the page's update rows merged and garbage-collected (the whole job, with SQL
  // and Blob, is in server.compaction.job).
  compaction1MBP95: s?.compaction?.p95,
  firstSync1000Ms: out.firstSync?.median,
  loadMissed: s?.load ? s.load.missed + s.load.missingInState + s.load.textsWrong : undefined,
  loadErrorRatePct: s?.load?.errorRatePct,
  loadVisibleP95: s?.load?.visibleToOthers?.p95,
};
// Compared with the last run on main only on the same processor (runners differ; phase1.mjs).
const last = readJson(previousFile);
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
    budget: budget.max,
    unit: budget.unit,
    previous: before ?? null,
    overBudget,
    regressed,
  });
}
out.figures = figures;
out.gate = gate;
writeFileSync(join(results, 'phase2.json'), JSON.stringify(out, null, 2) + '\n');

log('\nBudget                 value      budget   last main');
for (const g of gate)
  log(
    `${g.overBudget || g.regressed ? 'FAIL' : 'ok  '} ${g.name.padEnd(20)} ${String(g.value).padStart(7)} ${g.unit.padEnd(3)} ${String(g.budget).padStart(6)}   ${g.previous ?? '-'}${g.regressed ? '  (regressed)' : ''}`,
  );
if (s) {
  log(`\nSearch took the ${s.search?.path ?? '?'} path on ${s.environment?.sql ?? '?'}.`);
  if (s.load)
    log(
      `Load test: ${s.load.users} people, ${s.load.updatesPushed} updates pushed, ${s.load.updatesChecked} deliveries checked, ${s.load.missed} missed, ${s.load.errors} errors in ${s.load.requests} requests.`,
    );
  if (s.load?.visibleToOthers)
    log(
      `An edit reached the page's other readers in p50 ${s.load.visibleToOthers.p50} ms, p95 ${s.load.visibleToOthers.p95} ms; the worker validated it in p95 ${s.load.validatedAfterAck?.p95} ms.`,
    );
  if (!s.testsPassed) log('The server benchmark tests failed: see their output above.');
}
if (!last) log('(No run on main to compare with: budgets only.)');
else if (!sameMachine)
  log(
    `(The last run on main ran on ${last.machine?.cpu ?? 'a processor it did not record'}, this one on ${out.machine.cpu}: budgets only.)`,
  );
process.exitCode = gate.some((g) => g.overBudget || g.regressed) || (s && !s.testsPassed) ? 1 : 0;
