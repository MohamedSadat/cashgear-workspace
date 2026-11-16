// What Chrome's IndexedDB does after a crash that tore its log (Phase 8, the web kill test's loss on
// CI run 43746282731), made to happen on purpose rather than waited for.
//
// Chrome keeps an origin's IndexedDB in LevelDB. Its environment writes a log record's 7-byte
// header and its payload as two unbuffered writes (env_chromium.cc: Append writes at once, Flush
// does nothing), and it reuses the last log from start to start (`reuse_logs`, on except on
// Chrome OS and low-end devices). A crash between the two writes leaves a header with no payload
// at the log's end. The next start reads that as the end of the log (log_reader.cc: "assume the
// writer died in the middle of writing the record") and appends its own records right after it.
// The start after that reads the header again, now followed by those records. If they fit inside
// the length the torn header claims, they are read as its unfinished payload and dropped in
// silence: every transaction that session made, though reported complete, is gone (CI's case).
// If they run past it, the checksum fails, and since Chrome opens IndexedDB's LevelDB with
// paranoid checks the open fails and Chrome deletes the whole database ("IndexedDB recovering
// from a corrupted (and deleted) database" in its own log). Strict durability changes neither.
//
// Each trial here: a session writes a few values and is closed; a torn header is appended to the
// log (what the crash leaves), claiming a short record's length or, with a long claim, the rest
// of the block; session A writes values (reported complete) and is closed as a person closes it;
// session B reads what is stored; after a long claim, a session that writes more than the claim
// and one that reads. With `pad`, session A's first write is a record larger than a log block, so
// its later writes start in the next block (an idea for a fix: it makes things worse, the open
// failing on the checksum).
//   node scripts/idb-torn-log.mjs [--trials 10] [--case name] [--debug] [--out file]
// --debug prints one trial's LevelDB folder, its LOG files and Chrome's own log lines, then stops.
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttp } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNet } from 'node:net';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { root } from './lib.mjs';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const trials = Number(arg('trials', 20));
// Prints the LevelDB folder and its LOG after each session.
const debug = process.argv.includes('--debug');
// One case by its name ("strict, padded first").
const only = arg('case', null);
// The app's own store (with and without the journal) rather than the counter page.
const app = process.argv.includes('--app');
const out = arg('out', join(root, 'bench/results/idb-torn-log.json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const random = (n) => Math.floor(Math.random() * n);

const PAGE = `<!doctype html><meta charset="utf-8"><title>torn</title><script>
const q = new URLSearchParams(location.search);
const writes = Number(q.get('writes') ?? 0);
const durability = q.get('durability') ?? 'relaxed';
const open = indexedDB.open('probe', 1);
open.onupgradeneeded = () => open.result.createObjectStore('kv');
const tx = (db, body) => new Promise((done, fail) => {
  const t = db.transaction('kv', 'readwrite', { durability });
  body(t.objectStore('kv'));
  t.oncomplete = () => done();
  t.onabort = () => fail(t.error);
});
open.onsuccess = async () => {
  const db = open.result;
  const read = db.transaction('kv').objectStore('kv').get('n');
  read.onsuccess = async () => {
    let n = read.result ?? 0;
    window.__probe?.({ kind: 'start', start: n });
    if (q.has('pad')) {
      // Larger than a log block, and incompressible.
      const pad = new Uint8Array(33 * 1024);
      for (let i = 0; i < pad.length; i += 65536) crypto.getRandomValues(pad.subarray(i, i + 65536));
      await tx(db, (s) => s.put(pad, 'pad'));
    }
    for (let i = 0; i < writes; i++) {
      const value = ++n;
      await tx(db, (s) => {
        s.put(value, 'n');
        s.put(new Uint8Array(200), 'u' + value);
      });
      window.__probe?.({ kind: 'done', value });
      await new Promise((r) => setTimeout(r, 20));
    }
    window.__probe?.({ kind: 'finished', value: n });
  };
};
</script>`;

const freePort = () =>
  new Promise((resolve) => {
    const server = createNet();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function waitFor(url, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + url);
    await sleep(100);
  }
}

function chromePath() {
  for (const candidate of [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean))
    if (existsSync(candidate)) return candidate;
  return chromium.executablePath();
}

// --app: the app's own store (`@cgw/store-web`, the journal on or off) in a page built by Vite
// from scripts/idb-torn-app, instead of the counter page.
const appDir = join(root, 'target/idb-torn-app');
if (app) {
  // Vite is the web app's dependency, not hoisted to the root.
  const vite = createRequire(join(root, 'apps/web/package.json')).resolve('vite');
  const { build } = await import(pathToFileURL(vite).href);
  await build({
    root: join(root, 'scripts/idb-torn-app'),
    logLevel: 'warn',
    build: { outDir: appDir, emptyOutDir: true },
    // The page sits outside the workspace's packages: their sources by path (their own imports
    // resolve from their folders).
    resolve: {
      alias: {
        '@cgw/workspace': join(root, 'packages/workspace/src/index.ts'),
        '@cgw/store-web': join(root, 'packages/store-web/src/index.ts'),
      },
    },
  });
}
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };
const http = createHttp((req, res) => {
  if (!app) {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    return res.end(PAGE);
  }
  const path = new URL(req.url, 'http://x').pathname;
  const file = join(appDir, path === '/' ? 'index.html' : path.slice(1));
  if (!file.startsWith(appDir) || !existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(readFileSync(file));
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${http.address().port}`;

/** Chrome on the profile; `drive` runs in its page; then closed as a person closes it. */
async function chromeSession(profile, drive) {
  const port = await freePort();
  const child = spawn(
    chromePath(),
    [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${join(profile, 'chrome')}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Chrome's own log (chrome_debug.log in the profile): what it did on open.
      ...(debug || app ? ['--enable-logging', '--v=0'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  await waitFor(`http://127.0.0.1:${port}/json/version`, 45000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  let result;
  try {
    result = await drive(page);
  } finally {
    // Closed as a person closes it: nothing is killed in this experiment but the log's record.
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.close').catch(() => {});
    for (let i = 0; i < 100 && child.exitCode === null; i++) await sleep(100);
    await browser.close().catch(() => {});
    if (child.exitCode === null)
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(300);
  }
  return result;
}

/** One Chrome session on the profile: the counter page with `query`, until it says it finished. */
function session(profile, query) {
  return chromeSession(profile, async (page) => {
    const seen = { start: null, last: null, finished: false };
    await page.exposeBinding('__probe', (_s, event) => {
      if (event.kind === 'start') seen.start = event.start;
      if (event.kind === 'done') seen.last = event.value;
      if (event.kind === 'finished') seen.finished = true;
    });
    await page.goto(`${origin}/?${query}`);
    for (let i = 0; i < 300 && !seen.finished; i++) await sleep(50);
    return seen;
  });
}

/** One Chrome session on the app's store page: `window.cgwTorn[call](...args)`'s answer. */
function appSession(profile, journal, call, ...args) {
  return chromeSession(profile, async (page) => {
    await page.goto(`${origin}/?journal=${journal ? 1 : 0}`);
    await page.waitForFunction(() => !!window.cgwTorn, null, { timeout: 30000 });
    return page.evaluate(([name, values]) => window.cgwTorn[name](...values), [call, args]);
  });
}

/** What Chrome logged about the profile's IndexedDB at its last start. */
function chromeSaid(profile) {
  const file = join(profile, 'chrome', 'chrome_debug.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => /indexed_db/i.test(line) && /corrupt|failed to open/i.test(line))
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, '').slice(0, 200));
}

const leveldbDir = (profile) => {
  const base = join(profile, 'chrome', 'Default', 'IndexedDB');
  return join(
    base,
    readdirSync(base).find((d) => d.endsWith('.leveldb')),
  );
};

/** What a crash between a record's two writes leaves: a full-record header with no payload. */
function tearLog(profile, claim) {
  const dir = leveldbDir(profile);
  const log = readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .sort()
    .at(-1);
  const path = join(dir, log);
  const header = Buffer.alloc(7);
  // The record's length: short (a small record's), or as long as the block allows (a large one's,
  // longer than what the next session writes, which is then read as its unfinished payload).
  const room = 32768 - (statSync(path).size % 32768) - 7;
  const length = claim === 'long' ? Math.max(0, room - 7) : Math.min(room, 300 + random(2000));
  header.writeUInt32LE(0x12345678, 0); // a checksum: whatever it is, the payload is not there
  header.writeUInt16LE(length, 4);
  header.writeUInt8(1, 6); // kFullType
  appendFileSync(path, header);
  return { log, size: statSync(path).size, length };
}

function show(profile, label) {
  const dir = leveldbDir(profile);
  console.log(`--- ${label}`);
  for (const f of readdirSync(dir)) console.log(`  ${f} ${statSync(join(dir, f)).size}`);
  for (const f of ['LOG.old', 'LOG'])
    if (existsSync(join(dir, f)))
      console.log(
        `  ${f}:
` + readFileSync(join(dir, f), 'utf8'),
      );
}

const drops = (profile) => {
  const dir = leveldbDir(profile);
  const lines = [];
  for (const file of ['LOG.old', 'LOG'])
    if (existsSync(join(dir, file)))
      for (const line of readFileSync(join(dir, file), 'utf8').split('\n'))
        if (/dropping|corrupt|checksum|bad record|missing start/i.test(line))
          lines.push(`${file}: ${line.trim()}`);
  return lines;
};

const results = { chrome: null, startedAt: new Date().toISOString(), cases: {} };

/**
 * The app's store: a synced workspace and page with two acknowledged updates; the log torn;
 * session A saves updates through the store (each resolved: "Saved"); session B opens the store,
 * and if the page is gone (Chrome deleted the store) the workspace comes back as the server would
 * send it. With the journal, A's updates must be in B's log, unsent; without, they are what is
 * lost.
 */
async function appTrials() {
  const appCases = [
    { name: 'journal, a long torn record (the silent loss)', journal: true, claim: 'long' },
    { name: 'journal, a short torn record (the store deleted)', journal: true, claim: 'short' },
    { name: 'no journal, a long torn record', journal: false, claim: 'long' },
    { name: 'no journal, a short torn record', journal: false, claim: 'short' },
  ];
  for (let trial = 0; trial < trials; trial++)
    for (const c of appCases.filter((k) => !only || k.name === only)) {
      const r = (results.cases[c.name] ??= {
        trials: 0,
        // B's start: the store kept (A's writes silently gone) or deleted by Chrome.
        storeDeleted: 0,
        aLostByIndexedDb: 0,
        aBack: 0,
        aLost: 0,
        restoredAtOpen: 0,
        restoredLater: 0,
        journalOn: 0,
        examples: [],
      });
      const profile = mkdtempSync(join(tmpdir(), 'cgw-torn-app-'));
      try {
        const records = await appSession(profile, c.journal, 'setup');
        const torn = tearLog(profile, c.claim);
        const a = await appSession(profile, c.journal, 'write', records.page.id, 3 + random(6));
        const b = await appSession(profile, c.journal, 'read', records);
        const said = chromeSaid(profile);
        r.trials++;
        if (a.journal.state === 'on') r.journalOn++;
        if (!b.hadPage) r.storeDeleted++;
        const held = new Set(b.ids);
        const unsent = new Set(b.unsent);
        const back = a.ids.filter((id) => held.has(id) && unsent.has(id));
        if (b.atOpen?.restored || b.atOpen?.waiting || !b.hadPage || back.length < a.ids.length)
          r.aLostByIndexedDb++;
        if (back.length === a.ids.length) r.aBack++;
        else r.aLost++;
        r.restoredAtOpen += b.atOpen?.restored ?? 0;
        r.restoredLater += b.after?.restoredLater ?? 0;
        if (r.examples.length < 2)
          r.examples.push({
            trial,
            torn,
            saved: a.ids.length,
            backUnsent: back.length,
            hadPage: b.hadPage,
            atOpen: b.atOpen,
            after: b.after,
            chrome: said.slice(0, 3),
          });
      } finally {
        spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${basename(profile)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
          ],
          { stdio: 'ignore' },
        );
        rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      }
      console.log(
        `${trial + 1} ${c.name}: ${r.aBack} of ${r.trials} had every save back (${r.storeDeleted} stores deleted)`,
      );
    }
}

const cases = [
  { name: 'relaxed', query: 'durability=relaxed', claim: 'short' },
  { name: 'strict', query: 'durability=strict', claim: 'short' },
  { name: 'relaxed, padded first', query: 'durability=relaxed&pad=1', claim: 'short' },
  { name: 'strict, padded first', query: 'durability=strict&pad=1', claim: 'short' },
  // CI's case: the torn record claims more than the next session writes.
  { name: 'relaxed, long claim', query: 'durability=relaxed', claim: 'long' },
  { name: 'strict, long claim', query: 'durability=strict', claim: 'long' },
];
try {
  if (app) await appTrials();
  for (let trial = 0; trial < (app ? 0 : trials); trial++)
    for (const c of cases.filter((k) => !only || k.name === only)) {
      const r = (results.cases[c.name] ??= {
        trials: 0,
        lossTrials: 0,
        lost: 0,
        // Of the losses: the database deleted (nothing left), or only session A's writes gone.
        deleted: 0,
        sessionOnly: 0,
        examples: [],
      });
      const profile = mkdtempSync(join(tmpdir(), 'cgw-torn-'));
      try {
        // A few values first, so the log holds records before the torn one.
        await session(profile, `writes=${1 + random(20)}&${c.query.replace(/&?pad=1/, '')}`);
        if (debug) show(profile, 'after the first session');
        const torn = tearLog(profile, c.claim);
        const a = await session(profile, `writes=${3 + random(8)}&${c.query}`);
        if (debug) show(profile, `after session A ${JSON.stringify(a)}`);
        const b = await session(profile, 'writes=0');
        if (debug) show(profile, `after session B ${JSON.stringify(b)}`);
        if (debug && existsSync(join(profile, 'chrome', 'chrome_debug.log')))
          console.log(
            readFileSync(join(profile, 'chrome', 'chrome_debug.log'), 'utf8')
              .split(/\r?\n/)
              .filter((l) => /indexed|leveldb|corrupt|idb/i.test(l))
              .join('\n'),
          );
        if (debug) process.exit(0);
        r.trials++;
        if (b.start < a.last) {
          r.lossTrials++;
          r.lost += a.last - b.start;
          if (b.start === 0) r.deleted++;
          else if (b.start === a.start) r.sessionOnly++;
          if (r.examples.length < 3)
            r.examples.push({
              trial,
              before: a.start,
              reportedComplete: a.last,
              stored: b.start,
              torn,
              leveldb: drops(profile).slice(0, 4),
            });
        }
        if (c.claim === 'long' && b.start > 0) {
          // And then: a session that writes more than the torn record claims, and one that reads.
          const more = await session(profile, `writes=60&${c.query}`);
          const after = await session(profile, 'writes=0');
          r.later ??= { trials: 0, deleted: 0, kept: 0, lostMore: 0 };
          r.later.trials++;
          if (after.start === 0) r.later.deleted++;
          else if (after.start >= more.last) r.later.kept++;
          else r.later.lostMore++;
        }
      } finally {
        spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${basename(profile)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
          ],
          { stdio: 'ignore' },
        );
        rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      }
      console.log(`${trial + 1} ${c.name}: ${r.lossTrials} of ${r.trials} lost`);
    }
} finally {
  http.close();
  results.finishedAt = new Date().toISOString();
  mkdirSync(join(root, 'bench/results'), { recursive: true });
  writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
}
