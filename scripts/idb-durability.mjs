// Does Chrome keep IndexedDB transactions it reported complete when it is killed? A page that
// writes nothing but a counter, one transaction a write, tells Node each value as its transaction
// completes; Chrome is killed at a random moment and started again on the same profile, and the
// stored value is compared with the last one reported. Relaxed (Chrome's default) and strict
// durability take turns, each on a profile of its own, so both meet the same machine at the same
// time (DECISIONS.md, Phase 3: "How the web kill test kills"; Phase 8: strict durability).
//   node scripts/idb-durability.mjs [--trials 200] [--kill tree|immediate] [--modes relaxed,strict]
//     [--gap 30] [--bytes 64] [--kill-min 300] [--kill-max 3000] [--starve [--burners N]]
//     [--out bench/results/idb-durability.json]
// --gap: milliseconds between writes (the app's live saves come every 30 to 60 ms). --kill-min,
// --kill-max: when the kill comes, after the page's first write. --kill tree is taskkill over the
// whole tree (the kill test's default for the web), immediate ends Chrome's browser process first.
// --bytes: the size of the record each write adds (under 64 kB, which Chrome would keep as a file).
// After each start the profile's LevelDB LOG (Chrome's IndexedDB is LevelDB, its log reused across
// starts) is read for what its recovery dropped, and Chrome's own log for a store it found corrupt
// and deleted. A torn log record needs the kill to land between a record's two writes, which an
// idle machine rarely does: scripts/idb-torn-log.mjs makes one on purpose.
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttp } from 'node:http';
import { createServer as createNet } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { root } from './lib.mjs';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const trials = Number(arg('trials', 200));
const killHow = arg('kill', 'tree');
const modes = arg('modes', 'relaxed,strict').split(',');
const gap = Number(arg('gap', 30));
const killMin = Number(arg('kill-min', 300));
const killMax = Number(arg('kill-max', 3000));
const bytes = Number(arg('bytes', 64));
// A crowded machine, roughly as CI's four cores with the server stack beside Chrome: busy threads
// at Chrome's own priority, twice as many as there are processors (--burners N), so Chrome's
// threads wait for a processor and are preempted between their writes.
const starve = process.argv.includes('--starve');
const burnerCount = Number(arg('burners', 0)) || null;
const out = arg('out', join(root, 'bench/results/idb-durability.json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const random = (n) => Math.floor(Math.random() * n);

// The page: opens the database, then writes the counter's next value every `gap` ms, each in its
// own transaction, and reports it once the transaction completes. `?read` only reads.
const PAGE = `<!doctype html><meta charset="utf-8"><title>probe</title><script>
const q = new URLSearchParams(location.search);
const mode = q.get('mode');
const gap = Number(q.get('gap'));
const bytes = Number(q.get('bytes'));
const open = indexedDB.open('probe', 1);
open.onupgradeneeded = () => open.result.createObjectStore('kv');
open.onsuccess = () => {
  const db = open.result;
  const read = db.transaction('kv').objectStore('kv').get('n');
  read.onsuccess = () => {
    const start = read.result ?? 0;
    window.__probe?.({ kind: 'start', start });
    if (q.has('read')) return;
    let n = start;
    const write = () => {
      const options = mode === 'default' ? undefined : { durability: mode };
      const tx = db.transaction('kv', 'readwrite', options);
      const value = ++n;
      const begun = performance.now();
      tx.objectStore('kv').put(value, 'n');
      // A record per value too, about the size of a typed word's update.
      tx.objectStore('kv').put(new Uint8Array(bytes + (value % 64)), 'u' + value);
      tx.oncomplete = () => {
        window.__probe?.({ kind: 'done', value, ms: performance.now() - begun });
        setTimeout(write, gap);
      };
      tx.onabort = () => window.__probe?.({ kind: 'abort', value });
    };
    write();
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
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean))
    if (existsSync(candidate)) return candidate;
  return chromium.executablePath();
}

function sweep(tag) {
  if (process.platform !== 'win32') return;
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      // Until none is left (on a crowded machine a killed tree takes a while to go, and one that
      // still holds the database's LOCK makes the next start fail to open it).
      `for ($i = 0; $i -lt 100; $i++) { $left = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${tag}*' -and $_.ProcessId -ne $PID }); if ($left.Count -eq 0) { break }; $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 200 }`,
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
}

function kill(child, tag) {
  if (killHow === 'tree')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  else
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  sweep(tag);
}

const http = createHttp((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end(PAGE);
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${http.address().port}`;

const burners = [];
if (starve) {
  const { Worker } = await import('node:worker_threads');
  const { availableParallelism } = await import('node:os');
  for (let i = 0; i < (burnerCount ?? 2 * availableParallelism()); i++)
    burners.push(new Worker('for (;;) {}', { eval: true }));
}

const profiles = Object.fromEntries(
  modes.map((mode) => [mode, mkdtempSync(join(tmpdir(), `cgw-idb-${mode}-`))]),
);

/** Starts Chrome on a profile at the page; `onProbe` hears the page's reports. */
async function start(mode, query, onProbe) {
  const profile = profiles[mode];
  const port = await freePort();
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${join(profile, 'chrome')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    '--window-size=800,600',
    // Chrome's own log (chrome_debug.log in the profile): a database it found corrupt and deleted.
    '--enable-logging',
    '--v=0',
    'about:blank',
  ];
  const child = spawn(chromePath(), args, { stdio: 'ignore' });
  await waitFor(`http://127.0.0.1:${port}/json/version`, 45000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.exposeBinding('__probe', (_source, event) => onProbe(event));
  await page.goto(`${origin}/?mode=${mode}&gap=${gap}&bytes=${bytes}${query}`);
  return { child, browser, page, tag: basename(profile) };
}

/** The stored counter, read by a fresh start that writes nothing; closed as a person closes it. */
async function readStored(mode) {
  let value = null;
  const app = await start(mode, '&read', (event) => {
    if (event.kind === 'start') value = event.start;
  });
  for (let i = 0; i < 600 && value === null; i++) await sleep(50);
  const cdp = await app.browser.newBrowserCDPSession();
  await cdp.send('Browser.close').catch(() => {});
  for (let i = 0; i < 50 && app.child.exitCode === null; i++) await sleep(100);
  await app.browser.close().catch(() => {});
  if (app.child.exitCode === null) kill(app.child, app.tag);
  return value;
}

/** What Chrome logged on its last start about IndexedDB corruption (it deletes such a database). */
function chromeCorruption(mode) {
  const path = join(profiles[mode], 'chrome', 'chrome_debug.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => /indexed_db|leveldb/i.test(line) && /corrupt|failed to open/i.test(line))
    .map((line) => line.trim().slice(0, 300));
}

/**
 * What the last two opens of the profile's IndexedDB LevelDB logged about their recovery: lines
 * that say it dropped bytes or met corruption (LevelDB logs "(ignoring error) ...: dropping N
 * bytes; ..." when a log record does not read back).
 */
function leveldbDrops(mode) {
  const base = join(profiles[mode], 'chrome', 'Default', 'IndexedDB');
  const lines = [];
  for (const dir of existsSync(base) ? readdirSync(base) : [])
    for (const file of ['LOG.old', 'LOG']) {
      const path = join(base, dir, file);
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, 'utf8').split('\n'))
        if (/dropping|corrupt|checksum|bad record|missing start/i.test(line))
          lines.push(`${file}: ${line}`);
    }
  return lines;
}

const results = {
  chrome: null,
  bytes,
  kill: killHow,
  gap,
  killWindow: [killMin, killMax],
  startedAt: new Date().toISOString(),
  modes: Object.fromEntries(
    modes.map((m) => [
      m,
      {
        trials: 0,
        lossTrials: 0,
        wholeSessionLost: 0,
        lostValues: 0,
        reported: 0,
        opensDropping: 0,
        drops: [],
        deleted: 0,
        commitMs: [],
        losses: [],
      },
    ]),
  ),
};

try {
  for (let trial = 0; trial < trials; trial++) {
    for (const mode of modes) {
      const r = results.modes[mode];
      let sessionStart = null;
      let lastDone = null;
      let firstAt = null;
      let lastDoneAt = null;
      const app = await start(mode, '', (event) => {
        if (event.kind === 'start') sessionStart = event.start;
        if (event.kind === 'done') {
          lastDone = event.value;
          lastDoneAt = Date.now();
          firstAt ??= Date.now();
          r.commitMs.push(event.ms);
        }
      });
      results.chrome ??= app.browser.version();
      for (let i = 0; i < 200 && firstAt === null; i++) await sleep(10);
      const killAfter = killMin + random(killMax - killMin);
      await sleep(Math.max(0, firstAt + killAfter - Date.now()));
      const killedAt = Date.now();
      const reported = lastDone;
      kill(app.child, app.tag);
      await app.browser.close().catch(() => {});
      await sleep(300);
      const stored = await readStored(mode);
      const drops = leveldbDrops(mode);
      const corrupt = chromeCorruption(mode);
      if (corrupt.some((line) => /deleted/i.test(line))) r.deleted++;
      if (drops.length) {
        r.opensDropping++;
        r.drops.push({ trial, lines: drops.slice(0, 6) });
      }
      r.trials++;
      r.reported += (reported ?? sessionStart) - (sessionStart ?? 0);
      if (stored === null || (reported !== null && stored < reported)) {
        r.lossTrials++;
        r.lostValues += reported - (stored ?? 0);
        if (stored === sessionStart) r.wholeSessionLost++;
        r.losses.push({
          trial,
          sessionStart,
          reported,
          stored,
          lastReportedBeforeKillMs: killedAt - lastDoneAt,
          killAfterFirstWriteMs: killedAt - firstAt,
          leveldb: drops,
          chrome: corrupt,
        });
        console.log(`LOSS ${mode}`, JSON.stringify(r.losses.at(-1)));
      }
    }
    if ((trial + 1) % 10 === 0)
      console.log(
        `${trial + 1} trials: ` +
          modes
            .map(
              (m) =>
                `${m} ${results.modes[m].lossTrials} lost (${results.modes[m].wholeSessionLost} whole sessions)`,
            )
            .join(', '),
      );
  }
} finally {
  http.close();
  for (const burner of burners) await burner.terminate();
  results.starved = starve ? burners.length : 0;
  for (const mode of modes) {
    sweep(basename(profiles[mode]));
    const r = results.modes[mode];
    const sorted = r.commitMs.sort((a, b) => a - b);
    r.commit = {
      samples: sorted.length,
      p50: Math.round(sorted[Math.floor(sorted.length * 0.5)] * 10) / 10,
      p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
      max: Math.round((sorted.at(-1) ?? 0) * 10) / 10,
    };
    delete r.commitMs;
    rmSync(profiles[mode], { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  results.finishedAt = new Date().toISOString();
  mkdirSync(join(root, 'bench/results'), { recursive: true });
  writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
}
