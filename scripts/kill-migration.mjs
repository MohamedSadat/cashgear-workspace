// Kill during a local store migration (Phase 3, M3.5; Phase 4 adds v3): a store written by an
// earlier release (crates/cgw-store/tests/fixtures/v1, v2 and v3, made by v0.1.0's, v0.2.0's and
// v0.3.0's own store code; their expected.json lists what that release answered to a fixed set of
// reads) is copied into a fresh data folder, the release desktop app is started on it and killed
// at a random moment of its start, which is when the store is copied aside (workspace.v{n}.db)
// and migrated to this build's schema (crates/cgw-store's SCHEMA_VERSION, 4 from Phase 4).
// The killed folder is then copied: on one copy the store is opened again by the store's own
// code (cgw-store-cli, the code the app runs at start) and every read of expected.json must give
// the release's answer and bytes exactly, and the copy beside it must be the old store byte for
// byte; on the other the app itself starts again, over CDP, and must migrate and open with the
// fixture's workspace and pages in its tree (its own start then writes as it always does: a
// visit, the trash's 60 days on the fixture's old trashed page; so that copy is checked for
// the schema, the old store beside it and the workspaces). A `readMirror` the release answered
// is compared without the databases and views schema 4 answers too, which must be empty.
//   node scripts/kill-migration.mjs [--runs 100] [--fixtures 1,2,3] [--out file]
// Kill moments, in turn: at once when the copy starts (its .part file appears) or when it is in
// place (the migration's transaction runs next), from a watch on the folder; a random time from
// the start to just after the copy is usually seen; and, twice as often, a random moment within 12 ms of when the copy has been
// seen to start in earlier runs. After each kill the folder is read (a copy of it, so nothing is
// touched) to say where the kill came: before the copy, during it, after it but before the
// migration committed, or after. Needs the release build (pnpm desktop:build) and cgw-store-cli
// (cargo build -p cgw-store --bin cgw-store-cli).
// Results: bench/results/kill-migration.json.
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from '@playwright/test';
import { root } from './lib.mjs';
import { openStoreCli } from './store-cli.mjs';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const runs = Number(arg('runs', 10));
const fixtures = arg('fixtures', '1,2,3').split(',').map(Number);
/** The schema this build migrates to, as the store's own code says it. */
const SCHEMA = Number(
  /pub const SCHEMA_VERSION: i64 = (\d+);/.exec(
    readFileSync(join(root, 'crates/cgw-store/src/lib.rs'), 'utf8'),
  )[1],
);
const out = arg('out', join(root, 'bench/results/kill-migration.json'));
const padMB = Number(arg('pad-mb', 96));
const exe = join(root, 'target/release/cgw-desktop.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const random = (n) => Math.floor(Math.random() * n);

if (!existsSync(exe)) throw new Error('The desktop build is missing: run pnpm desktop:build.');
const profile = mkdtempSync(join(tmpdir(), 'cgw-kill-migration-'));
const tag = basename(profile);

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

function killTree(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}

/** TerminateProcess on the app (which holds the store) at once, then the rest of its tree. */
function kill(child) {
  try {
    process.kill(child.pid, 'SIGKILL');
  } catch {
    /* gone */
  }
  killTree(child.pid);
}

function sweep() {
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${tag}*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
}

// On GitHub-hosted runners the WebView2 host runs elevated and takes the debugging port only from
// the documented HKLM policy (as scripts/desktop-smoke.mjs and kill-test.mjs do).
const policyKey = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';
const hostedRunner =
  process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
const reg = (a) => spawnSync('reg.exe', a, { encoding: 'utf8', windowsHide: true });

function start(folder, port, data = join(folder, 'data')) {
  const env = {
    ...process.env,
    CGW_DATA_DIR: data,
    WEBVIEW2_USER_DATA_FOLDER: join(folder, port ? 'webview2-again' : 'webview2'),
  };
  if (port) {
    const args = `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`;
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = args;
    if (hostedRunner)
      reg(['add', policyKey, '/v', 'cgw-desktop.exe', '/t', 'REG_SZ', '/d', args, '/f', '/reg:64']);
  }
  return spawn(exe, [], { env, stdio: 'ignore', windowsHide: true });
}

async function until(what, check, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out: ' + what);
    await sleep(100);
  }
}

/** The schema version the store's file says now, read from a copy (nothing is touched). */
function storedVersion(data) {
  const look = mkdtempSync(join(profile, 'look-'));
  try {
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(join(data, `workspace.db${suffix}`)))
        cpSync(join(data, `workspace.db${suffix}`), join(look, `workspace.db${suffix}`));
    const db = new DatabaseSync(join(look, 'workspace.db'));
    try {
      return Number(db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()?.value);
    } finally {
      db.close();
    }
  } catch (error) {
    return `unreadable: ${String(error).slice(0, 120)}`;
  } finally {
    rmSync(look, { recursive: true, force: true });
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** An answer as the release gave it: a migrated store's mirror has no databases or views yet. */
function asBefore(request, answer) {
  if (request.op !== 'readMirror' || !answer) return answer;
  const { databases, views, ...rest } = answer;
  return same(databases, []) && same(views, []) ? rest : answer;
}

/**
 * The fixture with `mb` megabytes of free pages added (a table of zeros made and dropped): the
 * same store, every read answers the same, but its copy before the migration takes long enough
 * (some hundreds of milliseconds) for a kill to land inside it.
 */
function padded(source, version, mb) {
  const file = join(profile, `padded-v${version}.db`);
  if (existsSync(file)) return file;
  cpSync(source, file);
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE cgw_kill_pad (b BLOB)');
    db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO cgw_kill_pad VALUES (zeroblob(1048576))');
    for (let i = 0; i < mb; i++) insert.run();
    db.exec('COMMIT');
    db.exec('DROP TABLE cgw_kill_pad');
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  } finally {
    db.close();
  }
  for (const suffix of ['-wal', '-shm']) rmSync(file + suffix, { force: true });
  return file;
}

/** Whether two files hold the same bytes. */
const sameFile = (a, b) => existsSync(a) && readFileSync(a).equals(readFileSync(b));

const median = (values, fallback) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : fallback;

const results = {
  runs: 0,
  fixtures,
  schema: SCHEMA,
  failures: [],
  startedAt: new Date().toISOString(),
  moments: { timed: 0, band: 0, copying: 0, copied: 0 },
  killedAt: {}, // where each kill came, from the folder after it
  startMs: [], // from the app's start to its copy's .part file, when seen
  reads: 0,
  appOpened: 0,
  late: 0,
  padded: 0,
  padMB,
  copyMs: [],
  copyPaddedMs: [],
};

try {
  for (let run = 0; run < runs; run++) {
    const version = fixtures[run % fixtures.length];
    const source = join(root, `crates/cgw-store/tests/fixtures/v${version}`);
    const expected = JSON.parse(readFileSync(join(source, 'expected.json'), 'utf8'));
    const mirror = expected.reads.find(
      (r) => r.request.op === 'readMirror' && r.request.workspaceId === null,
    ).answer;
    const folder = join(profile, `run-${run}`);
    const data = join(folder, 'data');
    mkdirSync(join(data, 'assets'), { recursive: true });
    // Every other run on the fixture with free pages added, so its copy can be killed in.
    const pad = padMB > 0 && run % 2 === 1;
    const oldStore = pad
      ? padded(join(source, 'workspace.db'), version, padMB)
      : join(source, 'workspace.db');
    if (pad) results.padded++;
    cpSync(oldStore, join(data, 'workspace.db'));
    cpSync(join(source, 'assets'), join(data, 'assets'), { recursive: true });
    const copyName = `workspace.v${version}.db`;
    const moment = ['copying', 'copied', 'band', 'timed', 'band'][run % 5];
    results.moments[moment]++;

    // 1. Started and killed during its start.
    const begun = Date.now();
    let child;
    let killedBy = null;
    let partSeen = 0;
    let copyDone = false;
    const watcher = watch(data, (_event, name) => {
      if (name === `${copyName}.part` && !partSeen) {
        partSeen = Date.now();
        results.startMs.push(partSeen - begun);
      }
      if (name === copyName && partSeen && !copyDone) {
        copyDone = true;
        (pad ? results.copyPaddedMs : results.copyMs).push(Date.now() - partSeen);
      }
      if (killedBy) return;
      // At once, in the watcher's own callback: the copy and the migration take milliseconds.
      if (
        (moment === 'copying' && name === `${copyName}.part`) ||
        (moment === 'copied' && name === copyName)
      ) {
        killedBy = moment;
        kill(child);
      } else if (name === copyName && (moment === 'band' || moment === 'timed')) {
        // Never later than just after the copy is in place: the migration's transaction comes
        // next and takes milliseconds; after it the app's page starts writing (a visit, the
        // trash's 60 days), which is not what this test is about.
        killedBy = moment;
        setTimeout(() => kill(child), random(10));
      }
    });
    child = start(folder, null);
    // `band`: a random moment within a few milliseconds of when the copy has been seen to start.
    const seen = [...results.startMs].sort((a, b) => a - b);
    const typical = seen[Math.floor(seen.length / 2)] ?? 900;
    // Never later than just after the migration: the app's page then starts writing (a visit,
    // the trash's 60 days), which is not what this test is about.
    const deadline =
      moment === 'timed'
        ? random(typical + 30 + (pad ? median(results.copyPaddedMs, 200) : 0))
        : moment === 'band'
          ? typical - 12 + random(24 + (pad ? median(results.copyPaddedMs, 200) : 0))
          : 5000;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!killedBy) killedBy = moment === 'timed' || moment === 'band' ? moment : 'late';
        kill(child);
      }, deadline);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    watcher.close();
    await sleep(300);
    const stored = storedVersion(data);
    const where = existsSync(join(data, `${copyName}.part`))
      ? 'during the copy'
      : !existsSync(join(data, copyName))
        ? 'before the copy'
        : stored === SCHEMA
          ? 'after the migration committed'
          : 'after the copy, before the migration committed';
    results.killedAt[where] = (results.killedAt[where] ?? 0) + 1;

    // The killed folder, twice: the app starts again on one, the store's own code on the other.
    const appData = join(folder, 'app-data');
    cpSync(data, appData, { recursive: true });

    if (killedBy === 'late') results.late++;
    // 2. Everything the fixture held, exactly: the store opened again (by the store code the
    // app runs, through cgw-store-cli, so no page is opened and nothing else is written) and
    // every read of expected.json answered as the release answered it, bytes and all; the copy
    // beside it is the old store byte for byte.
    try {
      const store = await openStoreCli(data);
      try {
        const { ok: now } = await store.call({ op: 'schemaVersion' });
        if (now !== SCHEMA) throw new Error(`schema ${now}`);
        // (A watch that missed the copy left the app running for 5 s: its page wrote.)
        for (const read of killedBy === 'late' ? [] : expected.reads) {
          const { ok, blobs } = await store.call(read.request);
          results.reads++;
          if (!same(read.answer, asBefore(read.request, ok)))
            results.failures.push({ run, version, where, read: read.request, problem: 'answer' });
          else if (
            !same(
              read.blobs,
              blobs.map((b) => [...b]),
            )
          )
            results.failures.push({ run, version, where, read: read.request, problem: 'bytes' });
        }
      } finally {
        await store.close();
      }
      if (!sameFile(join(data, copyName), oldStore))
        results.failures.push({ run, version, where, problem: `${copyName} is not the old store` });
    } catch (error) {
      results.failures.push({ run, version, where, error: String(error).slice(0, 300) });
    }

    // 3. The app started again on the other: it migrates, opens, and shows the fixture's
    // workspace and pages. (Its own start then writes as it always does: its visit to the page it
    // opens, and the trash's 60 days applied to the fixture's old trashed page; so its store is
    // checked for the schema, the copy and the workspaces, not read by read.)
    const port = await freePort();
    const again = start(folder, port, appData);
    let browser = null;
    try {
      await until(
        'the app to accept a debugger',
        async () =>
          (
            await fetch(`http://127.0.0.1:${port}/json/version`, {
              signal: AbortSignal.timeout(1000),
            })
          ).ok,
        60000,
      );
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const context = await until('the webview', async () => browser.contexts()[0], 30000);
      const page = context.pages()[0] ?? (await context.waitForEvent('page'));
      const first = [...mirror.workspaces].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
      const titles = mirror.pages
        .filter((p) => p.workspaceId === first.id && !p.parentPageId && !p.trashedAt)
        .map((p) => p.title);
      for (const title of titles)
        await page
          .getByRole('treeitem', { name: new RegExp(`^${title}`) })
          .first()
          .waitFor({ timeout: 30000 });
      await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 30000 });
      if (await page.locator('#cgw-refusal-title').count())
        throw new Error('The app refused the store');
      results.appOpened++;
    } catch (error) {
      results.failures.push({ run, version, where, app: true, error: String(error).slice(0, 300) });
    } finally {
      await browser?.close().catch(() => {});
      await sleep(500);
      kill(again);
      await new Promise((r) => (again.exitCode !== null ? r() : again.once('exit', r)));
      await sleep(300);
    }
    try {
      const store = await openStoreCli(appData);
      try {
        const { ok: now } = await store.call({ op: 'schemaVersion' });
        const { ok: held } = await store.call({ op: 'readMirror', workspaceId: null });
        if (now !== SCHEMA || !same(held.workspaces, mirror.workspaces))
          results.failures.push({ run, version, where, app: true, problem: `schema ${now}` });
      } finally {
        await store.close();
      }
      if (!sameFile(join(appData, copyName), oldStore))
        results.failures.push({ run, version, where, app: true, problem: `no ${copyName}` });
    } catch (error) {
      results.failures.push({ run, version, where, app: true, error: String(error).slice(0, 300) });
    }
    results.runs = run + 1;
    if (results.failures.length > 10) break;
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    if ((run + 1) % 10 === 0) {
      sweep();
      console.log(`${run + 1} runs, ${results.failures.length} failures`, results.killedAt);
    }
  }
} finally {
  sweep();
  if (hostedRunner) reg(['delete', policyKey, '/v', 'cgw-desktop.exe', '/f', '/reg:64']);
  results.finishedAt = new Date().toISOString();
  results.minutes =
    Math.round((Date.parse(results.finishedAt) - Date.parse(results.startedAt)) / 6000) / 10;
  const sorted = [...results.startMs].sort((a, b) => a - b);
  results.copySeenAfterMs = {
    samples: sorted.length,
    p50: sorted[Math.floor(sorted.length / 2)] ?? null,
    max: sorted.at(-1) ?? null,
  };
  delete results.startMs;
  results.copyMs = { samples: results.copyMs.length, p50: median(results.copyMs, null) };
  results.copyPaddedMs = {
    samples: results.copyPaddedMs.length,
    p50: median(results.copyPaddedMs, null),
  };
  mkdirSync(join(root, 'bench/results'), { recursive: true });
  writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify({ ...results, failures: results.failures.slice(0, 5) }, null, 2));
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
if (results.failures.length) process.exitCode = 1;
