// Phase 6's budgets (IMPLEMENTATION_PLAN.md, Phase 6, Performance benchmarks), measured and gated:
//   pnpm bench:phase6                    the hub under load and the keystroke budget in Chrome
//   pnpm bench:phase6 -- --desktop       and the keystroke budget in the desktop app
//   pnpm bench:phase6 -- --no-load       without the 2,000 connections and their reconnect storm
//   pnpm bench:phase6 -- --load-only     only the 2,000 connections and their reconnect storm
// Needs `pnpm build` (and for --desktop the release build); the web app under vite preview on
// 127.0.0.1:4273 and the server stack on 127.0.0.1:5280 (scripts/server-stack.mjs --e2e: the hub's
// metrics route, Realtime__Metrics, and the control port that recycles the API) are reused when
// they answer, else started here and stopped at the end.
//
// The figures:
//   - 20 editors on one page: 20 people of one workspace (its owner and 19 members by invitation),
//     each a Node client over the real hub (@microsoft/signalr, the app's own, WebSockets with no
//     negotiation, a ticket per connection) holding the page's Yjs document, writing as a Yjs
//     client id registered to its person: each types into its own paragraph, a key every
//     PHASE6_KEY_MS (200 ms, five keys a second) with a little jitter, each key one update pushed
//     through the hub (as the app pushes each live save) with its cursor sent as presence, and
//     applies every frame relayed to it; after a frame that could not carry its rows
//     (`complete: false`: a compaction took them between the relay's reads) it pulls the page, as
//     the app does. For PHASE6_SECONDS (30 s): the server's relay time (the metrics route: from a
//     push reaching the API to the frame carrying it sent, after the worker's validation), p95,
//     budget 150 ms; and from a push to each other editor's receipt of it (this process's clock),
//     tracked, with what reached an editor only by a pull counted apart; refusals, updates an
//     editor never got by either way, and documents that differ at the end fail the run;
//   - the keystroke budget on that page in Chrome, signed in as the owner, typing in the first
//     paragraph at a key every 35 ms while the 19 members type and their cursors move: editor work
//     per keystroke (keydown to the end of the transaction it caused) p95 ≤ 8 ms and keystroke to
//     the next frame p95 ≤ 33 ms, measured as bench/phase1.mjs does; with --desktop the same in the
//     desktop app;
//   - 2,000 connections on one node: 10 people with 10 devices each (cookie sign-ins), 20
//     connections a device (the hub's limits: 20 a device, 200 a person), each following its
//     person's workspace and joined to one of its 20 pages (10 on each): the API process's working
//     set, private bytes and CPU (Get-Process), idle with the keep-alives for PHASE6_SAMPLE_SECONDS
//     (30 s), then with presence from every connection every 10 s; recorded against sanity caps
//     (below); then the API recycled through the stack's control port and the time until all
//     2,000 are back (connected, following and joined again), each reconnecting on the app's own
//     schedule (1 s doubling to 30 s, equal jitter, a new ticket each attempt).
// Each figure is checked against its budget and, when bench/previous/phase6.json holds the last
// run on main on the same processor (CI downloads it), against that: worse by half again and by
// more than a small margin fails. Writes bench/results/phase6.json.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { cpus, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  API,
  APP,
  answers,
  apiSession,
  desktopSignIn,
  mailTo,
  newAccount,
  signInPage,
  waitFor,
} from '../scripts/cloud-account.mjs';
import { apiProcess, hasControl, restartApi } from '../scripts/stack-control.mjs';
import { cpuBetween, cpuLine, stackCpu } from './cpu.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
// The app's own SignalR client and Yjs (packages/shell's and packages/doc's dependencies).
const signalR = createRequire(join(root, 'packages/shell/package.json'))('@microsoft/signalr');
const Y = createRequire(join(root, 'packages/doc/package.json'))('yjs');
const args = process.argv.slice(2);
const withDesktop = args.includes('--desktop');
const withLoad = !args.includes('--no-load');
const loadOnly = args.includes('--load-only');
const KEY_MS = Number(process.env.PHASE6_KEY_MS ?? 200);
const SECONDS = Number(process.env.PHASE6_SECONDS ?? 30);
const SAMPLE_SECONDS = Number(process.env.PHASE6_SAMPLE_SECONDS ?? 30);
const CONNECTIONS = Number(process.env.PHASE6_CONNECTIONS ?? 2000);
const previousFile = join(root, 'bench/previous/phase6.json');
const results = join(root, 'bench/results');
const log = (line) => console.log(line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Budgets, with the margin a regression must also exceed to fail (runners are noisy). The 2,000
 * connections have no budget in the plan ("measured for memory and CPU"): their caps are sanity
 * caps, far above what one node needs, so a leak or a busy loop fails the run.
 */
const BUDGETS = {
  // The plan's 150 ms is the server's on the reference machine (75.6 and 80.8 ms). CI's hosted
  // runner gives its four cores to the 20 editors' clients, Chrome, the desktop app, SQL Server,
  // the API and the worker at once (282.5 ms there): there the figure is held to 500 ms, and to
  // the last run on main (DECISIONS.md, 2026-11-15).
  relay20P95: { max: process.env.CI ? 500 : 150, unit: 'ms', slack: 30 },
  // Q19's 8 ms is the reference machine's; on CI's hosted runner the work per key doubled once
  // the page went live (bench/phase5.mjs, KEY_WORK_MAX): there 16 ms, a frame, and the last run.
  key20WorkP95: { max: process.env.CI ? 16 : 8, unit: 'ms', slack: 2 },
  key20FrameP95: { max: 33, unit: 'ms', slack: 5 },
  key20DesktopWorkP95: { max: process.env.CI ? 16 : 8, unit: 'ms', slack: 2 },
  key20DesktopFrameP95: { max: 33, unit: 'ms', slack: 5 },
  // Tracked, not budgeted.
  pushToReceiptP95: { max: Infinity, unit: 'ms', slack: 50 },
  relay20WhileTypingP95: { max: Infinity, unit: 'ms', slack: 50 },
  // Sanity caps for 2,000 connections on one node.
  conn2000WorkingSetMB: { max: 2048, unit: 'MB', slack: 150 },
  conn2000PrivateMB: { max: 2048, unit: 'MB', slack: 150 },
  conn2000IdleCpuPct: { max: 50, unit: '%', slack: 10 },
  conn2000PresenceCpuPct: { max: 200, unit: '%', slack: 20 },
  storm2000Ms: { max: 90000, unit: 'ms', slack: 10000 },
};

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};
const round = (n) => (n === null || n === undefined ? n : Math.round(n * 10) / 10);

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

async function freePort() {
  const listener = createServer();
  await new Promise((done) => listener.listen(0, '127.0.0.1', done));
  const { port } = listener.address();
  await new Promise((done) => listener.close(done));
  return port;
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

/** Runs `fn` over `items`, `n` at a time. */
async function pool(items, n, fn) {
  let next = 0;
  const out = new Array(items.length);
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const docVersion = Math.max(
  ...Object.keys(
    JSON.parse(readFileSync(join(root, 'packages/doc/vectors/schema-elements.json'), 'utf8')),
  ).map(Number),
);

// ------------------------------------------------------------------ the API process
/** The API's process: its id from the stack's control port, else the listener on its port. */
async function apiPid() {
  if (await hasControl()) return (await apiProcess()).pid;
  const port = new URL(API).port || '80';
  const found = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1).OwningProcess`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  return Number(found.stdout.trim());
}

/** Working set, private bytes (MB) and the CPU time used so far (ms) of a process. */
function processSample(pid) {
  const out = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$p = Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.PrivateMemorySize64) $($p.TotalProcessorTime.TotalMilliseconds)"`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  const [ws, priv, cpu] = out.stdout.trim().split(/\s+/).map(Number);
  return { at: Date.now(), workingSetMB: ws / 1048576, privateMB: priv / 1048576, cpuMs: cpu };
}

/** Samples a process every few seconds for `seconds`: the peak memory and the CPU used. */
async function measure(pid, seconds) {
  const first = processSample(pid);
  const samples = [first];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    await sleep(Math.min(5000, end - Date.now()));
    samples.push(processSample(pid));
  }
  const last = samples.at(-1);
  return {
    workingSetMB: round(Math.max(...samples.map((s) => s.workingSetMB))),
    privateMB: round(Math.max(...samples.map((s) => s.privateMB))),
    // Of one core: 100 % is one core busy the whole time.
    cpuPct: round(((last.cpuMs - first.cpuMs) / (last.at - first.at)) * 100),
    seconds: round((last.at - first.at) / 1000),
  };
}

// ------------------------------------------------------------------ people
/** A member of the owner's workspace by invitation, accepted through the API. */
async function invite(owner, workspaceId, account) {
  await owner.post(`/api/v1/workspaces/${workspaceId}/invites`, {
    email: account.email,
    role: 'member',
  });
  const api = await apiSession(account);
  for (let i = 0; i < 100; i++) {
    const token = /\/#\/invite\/([A-Za-z0-9_-]+)/.exec(await mailTo(account.email));
    if (token) {
      await api.post('/api/v1/invites/accept', { token: token[1] });
      return api;
    }
    await sleep(200);
  }
  throw new Error(`No invitation in the mail to ${account.email}`);
}

/** A Yjs client id of this person's, registered for writing to the workspace. */
async function registeredClient(api, workspaceId) {
  const clientId = 1_000_000 + Math.floor(Math.random() * 2_000_000_000);
  const answer = await api.post(`/api/v1/workspaces/${workspaceId}/yjs-clients`, {
    issue: null,
    register: [clientId],
  });
  if (!answer.registered.map(Number).includes(clientId))
    throw new Error('The client id was not registered: ' + JSON.stringify(answer));
  return clientId;
}

// ------------------------------------------------------------------ the hub
/** One hub connection as the app makes it: a fresh ticket, then WebSockets with no negotiation. */
async function openHub(api, handlers = {}) {
  const { ticket } = await api.post('/api/v1/realtime/tickets', {});
  const connection = new signalR.HubConnectionBuilder()
    .withUrl(`${API}/api/v1/realtime?ticket=${encodeURIComponent(ticket)}`, {
      skipNegotiation: true,
      transport: signalR.HttpTransportType.WebSockets,
    })
    .configureLogging(signalR.LogLevel.None)
    .build();
  connection.keepAliveIntervalInMilliseconds = 15000;
  connection.serverTimeoutInMilliseconds = 30000;
  for (const [event, handler] of Object.entries(handlers)) connection.on(event, handler);
  await connection.start();
  return connection;
}

/** A hub method's value, or its refusal thrown. */
async function call(connection, method, ...callArgs) {
  const answer = await connection.invoke(method, ...callArgs);
  if (!answer?.ok) {
    const error = new Error(`${method}: ${answer?.status} ${answer?.code} ${answer?.title}`);
    error.status = answer?.status;
    error.code = answer?.code;
    throw error;
  }
  return answer.value;
}

/** A relative position in a Yjs text, as the app sends it (Y.encodeRelativePosition, base64). */
const relative = (type, index) =>
  Buffer.from(
    Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(type, index)),
  ).toString('base64');

/** An editor of the page: its document, its paragraph, the keys it types and what it receives. */
class Editor {
  constructor(name, api, workspaceId, pageId, paragraph) {
    Object.assign(this, { name, api, workspaceId, pageId, paragraph });
    this.doc = new Y.Doc();
    this.pushed = new Map(); // updateId → time pushed
    this.received = new Map(); // updateId → time received
    this.clocks = new Map(); // updateId → this client's Yjs clock after it
    this.refused = [];
    this.keys = 0;
    this.epoch = 0;
    this.incomplete = 0; // frames marked `complete: false`
    this.pulling = Promise.resolve();
    this.pullErrors = [];
    this.snapshotsGone = 0; // pulls made again: a compaction deleted the snapshot first
  }

  async start(state) {
    this.doc.clientID = await registeredClient(this.api, this.workspaceId);
    Y.applyUpdate(this.doc, state, 'remote');
    this.connection = await openHub(this.api, {
      Updates: (frame) => {
        const at = Date.now();
        if (frame.pageId !== this.pageId) return;
        for (const update of frame.updates) {
          this.received.set(update.updateId, at);
          Y.applyUpdate(this.doc, Buffer.from(update.data, 'base64'), 'remote');
        }
        // The rows were gone when the relay read them (the worker compacts a page every 200
        // updates): the frame carries none of them and the client pulls (SYNC_DESIGN.md).
        if (!frame.complete) {
          this.incomplete++;
          this.pull();
        }
      },
    });
    await call(this.connection, 'JoinWorkspaces', [this.workspaceId]);
    const joined = await call(this.connection, 'JoinPage', this.pageId);
    this.epoch = joined.epoch;
  }

  /** The page pulled as the app pulls it: its snapshot, then its updates; one pull at a time. */
  pull() {
    const once = async () => {
      let after = 0;
      for (;;) {
        const page = await this.api.get(`/api/v1/pages/${this.pageId}/doc?after=${after}`);
        if (page.snapshot) {
          const answer = await fetch(page.snapshot.url);
          if (!answer.ok)
            throw Object.assign(new Error(`The snapshot answered ${answer.status}`), {
              gone: answer.status === 404,
            });
          Y.applyUpdate(this.doc, new Uint8Array(await answer.arrayBuffer()), 'remote');
        }
        for (const u of page.updates)
          Y.applyUpdate(this.doc, Buffer.from(u.data, 'base64'), 'remote');
        if (!page.more) return;
        after = page.cursor;
      }
    };
    // A compaction after the answer deletes the snapshot it named: pull again.
    const run = async () => {
      for (let attempt = 1; ; attempt++)
        try {
          return await once();
        } catch (error) {
          if (!error.gone || attempt >= 5) throw error;
          this.snapshotsGone++;
        }
    };
    this.pulling = this.pulling
      .then(run)
      .catch((error) => void this.pullErrors.push(String(error?.message ?? error)));
    return this.pulling;
  }

  /** This editor's paragraph's text (the k-th block's body). */
  text() {
    const block = this.doc.getXmlFragment('content').get(this.paragraph);
    const body = block.get(0);
    for (const child of body.toArray()) if (child instanceof Y.XmlText) return child;
    throw new Error(`No text in block ${this.paragraph}`);
  }

  /** One key: a letter at the end of its paragraph, pushed, and the cursor after it told. */
  async key(letter) {
    const text = this.text();
    let update = null;
    const capture = (u, origin) => origin !== 'remote' && (update = u);
    this.doc.on('update', capture);
    this.doc.transact(() => text.insert(text.length, letter));
    this.doc.off('update', capture);
    const updateId = uuidv7();
    this.pushed.set(updateId, Date.now());
    this.clocks.set(updateId, Y.getState(this.doc.store, this.doc.clientID));
    this.keys++;
    try {
      await call(this.connection, 'PushUpdates', this.pageId, {
        epoch: this.epoch,
        clientSchemaVersion: docVersion,
        updates: [{ updateId, data: Buffer.from(update).toString('base64') }],
      });
    } catch (error) {
      this.refused.push(error.code ?? String(error));
    }
    const at = relative(text, text.length);
    this.connection
      .invoke('Awareness', this.pageId, {
        clientId: this.doc.clientID,
        cursor: { anchor: at, head: at },
      })
      .catch(() => {});
  }

  /** Types until `stop.at` (which may be moved), a key every KEY_MS (± a fifth). */
  async type(until, stop = { at: until }) {
    const letters = 'abcdefghijklmnopqrstuvwxyz ';
    await sleep(Math.random() * KEY_MS);
    while (Date.now() < stop.at) {
      const started = Date.now();
      await this.key(letters[this.keys % letters.length]);
      const wait = KEY_MS * (0.8 + Math.random() * 0.4) - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
  }

  async stop() {
    await this.connection?.stop().catch(() => {});
  }
}

const metrics = async () => (await fetch(`${API}/api/v1/realtime/metrics`)).json();
const resetMetrics = () => fetch(`${API}/api/v1/realtime/metrics`, { method: 'DELETE' });

/**
 * From each push to each other editor's receipt of it in a frame. An update no frame carried is
 * `pulled` when the editor's document holds it (its writer's clock reached), else `missing`.
 */
function receipts(editors) {
  const times = [];
  let missing = 0;
  let pulled = 0;
  for (const from of editors)
    for (const [updateId, pushed] of from.pushed)
      for (const to of editors) {
        if (to === from) continue;
        const got = to.received.get(updateId);
        if (got !== undefined) times.push(got - pushed);
        else if (Y.getState(to.doc.store, from.doc.clientID) >= from.clocks.get(updateId)) pulled++;
        else missing++;
      }
  return {
    count: times.length,
    missing,
    pulled,
    p50: round(percentile(times, 0.5)),
    p95: round(percentile(times, 0.95)),
    max: round(Math.max(...times)),
  };
}

// ------------------------------------------------------------------ the browser
/** Keystroke to the next frame, and keydown to the end of the editor's transaction (bench/phase5.mjs). */
function probes() {
  const afterPaint = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
      }),
    );
  window.__keys = { frame: [], work: [], wait: [] };
  let start = null;
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key.length !== 1) return;
      const at = event.timeStamp;
      start = at;
      // The first listener (added before the app's): what the key waited for the thread.
      window.__keys.wait.push(performance.now() - at);
      void afterPaint().then(() => window.__keys.frame.push(performance.now() - at));
    },
    true,
  );
  window.__watchEditor = () => {
    const view = document.querySelector('.cgw-page .ProseMirror');
    if (!view?.editor || view.__watched) return false;
    view.__watched = true;
    view.editor.on('transaction', ({ transaction }) => {
      if (start === null || !transaction.docChanged) return;
      window.__keys.work.push(performance.now() - start);
      start = null;
    });
    return true;
  };
}

async function web(owner, pageId, members) {
  const browser = await chromium.launch({ channel: 'chrome' });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(probes);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${APP}/`);
    await signInPage(page, owner.account, `${APP}/#/p/${pageId}`);
    await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 60000 });
    await page
      .getByTestId('sync-status')
      .filter({ hasText: /^Synced$/ })
      .waitFor({ timeout: 120000 });
    return await keystrokes(page, members, errors);
  } catch (error) {
    const page = browser.contexts()[0]?.pages()[0];
    await page?.screenshot({ path: join(results, 'phase6-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

/** The keystroke figures in an app page on the 20 editors' page, with the 19 members typing. */
async function keystrokes(page, members, errors) {
  await resetMetrics();
  const before = members.map((m) => m.keys);
  const refusedBefore = members.map((m) => m.refused.length);
  const run = await typeWhileOthersTypeFor(page, members);
  if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
  const relayed = (await metrics()).relayed;
  return {
    carets: run.carets,
    keys: run.keys.frame.length,
    othersKeys: members.reduce((n, m, i) => n + m.keys - before[i], 0),
    othersRefused: members.reduce((n, m, i) => n + m.refused.length - refusedBefore[i], 0),
    workP50: round(percentile(run.keys.work, 0.5)),
    workP95: round(percentile(run.keys.work, 0.95)),
    waitP50: round(percentile(run.keys.wait, 0.5)),
    waitP95: round(percentile(run.keys.wait, 0.95)),
    frameP50: round(percentile(run.keys.frame, 0.5)),
    frameP95: round(percentile(run.keys.frame, 0.95)),
    relayWhileTypingP95: round(relayed.p95Ms),
    cpu: run.cpu,
  };
}

/**
 * Types in the page's first paragraph at a key every 35 ms (as bench/phase5.mjs types) while the
 * `others` type in theirs, once their cursors are all drawn; they stop when it does.
 */
async function typeWhileOthersTypeFor(page, others) {
  const first = page.locator('.cgw-page .cgw-editor [data-block] > .cgw-body').first();
  await first.waitFor({ timeout: 30000 });
  await first.click();
  await page.keyboard.press('End');
  if (!(await page.evaluate(() => window.__watchEditor()))) throw new Error('No editor to watch');
  const stop = { at: Date.now() + 120000 };
  const typing = Promise.all(others.map((editor) => editor.type(stop.at, stop)));
  try {
    // The others under way and their cursors drawn before anything is timed.
    await page
      .locator('.cgw-page .cgw-presence-caret')
      .nth(others.length - 1)
      .waitFor({ timeout: 30000 });
    await sleep(2000);
    await page.evaluate(() => {
      window.__keys.frame.length = 0;
      window.__keys.work.length = 0;
      window.__keys.wait.length = 0;
    });
    const carets = await page.locator('.cgw-page .cgw-presence-caret').count();
    const before = stackCpu();
    await page.keyboard.type(
      ' the quick brown fox jumps over the lazy dog and keeps on typing while nineteen others type',
      { delay: 35 },
    );
    await sleep(500);
    // Phase 8: what each part of the stack spent meanwhile (bench/cpu.mjs), recorded only.
    const cpu = cpuBetween(before, stackCpu());
    return { keys: await page.evaluate(() => window.__keys), carets, cpu };
  } finally {
    stop.at = 0;
    await typing;
  }
}

// ------------------------------------------------------------------ the desktop
async function desktop(owner, workspaceName, pageId, members) {
  const exe = join(root, 'target/release/cgw-desktop.exe');
  if (!existsSync(exe)) throw new Error('The desktop build is missing: run pnpm desktop:build.');
  const profile = mkdtempSync(join(tmpdir(), 'cgw-phase6-desktop-'));
  const hostedRunner =
    process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
  const policyKey =
    'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';
  const reg = (a) => spawnSync('reg.exe', a, { encoding: 'utf8', windowsHide: true });
  const port = await freePort();
  const browserArgs = `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`;
  if (hostedRunner)
    reg([
      'add',
      policyKey,
      '/v',
      'cgw-desktop.exe',
      '/t',
      'REG_SZ',
      '/d',
      browserArgs,
      '/f',
      '/reg:64',
    ]);
  const authUrlFile = join(profile, 'authorize-url.txt');
  const child = spawn(exe, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview2'),
      CGW_DATA_DIR: join(profile, 'data'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs,
      CGW_AUTH_URL_FILE: authUrlFile,
      // A keychain name of its own: runs beside the e2e specs never share a sign-in.
      CGW_KEYCHAIN_SERVICE: `com.cashgear.workspace.bench.${basename(profile)}`,
    },
  });
  let app = null;
  let signer = null;
  const errors = [];
  try {
    await waitFor(`http://127.0.0.1:${port}/json/version`, 60000);
    app = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = app.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByLabel('Workspace name').waitFor({ timeout: 60000 });
    await context.addInitScript(probes);
    await page.reload();
    await page.getByLabel('Workspace name').waitFor({ timeout: 60000 });
    await page.getByLabel('Workspace name').fill('Desktop keys');
    await page.keyboard.press('Enter');
    await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 60000 });
    signer = await chromium.launch({ channel: 'chrome' });
    await desktopSignIn(page, signer, authUrlFile, owner.account);
    // The owner's workspace, from the switcher once it has synced here, and the page in it.
    for (let i = 0; ; i++) {
      await page.locator('.cgw-workspace-switcher').first().click();
      const item = page.getByRole('menuitem', { name: workspaceName, exact: true });
      if (await item.isVisible({ timeout: 2000 }).catch(() => false)) {
        await item.click();
        break;
      }
      await page.keyboard.press('Escape');
      if (i > 60) throw new Error(`The desktop never listed ${workspaceName}`);
      await sleep(1000);
    }
    await page.evaluate((id) => (location.hash = `#/p/${id}`), pageId);
    await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 60000 });
    await page
      .locator('.cgw-page .cgw-editor')
      .filter({ hasText: 'Line 19.' })
      .waitFor({ timeout: 120000 });
    log('Desktop: typing in the first paragraph while 19 others type');
    const figures = await keystrokes(page, members, errors);
    // Signed out, so the test keychain name holds nothing.
    await page.evaluate(() => (location.hash = '#/settings'));
    await page
      .getByRole('button', { name: 'Sign out' })
      .click({ timeout: 15000 })
      .catch(() => {});
    await sleep(500);
    return figures;
  } finally {
    await signer?.close().catch(() => {});
    await app?.close().catch(() => {});
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    if (hostedRunner) reg(['delete', policyKey, '/v', 'cgw-desktop.exe', '/f', '/reg:64']);
    await sleep(1500);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      log(`  (could not remove ${profile}: ${error.code})`);
    }
  }
}

// ------------------------------------------------------------------ 20 editors
const WORKSPACE = 'Phase 6 bench';

/** The owner and 19 members, the page of 20 paragraphs (made in the app), and the 20 editors. */
async function twentyEditors() {
  log('Making 20 people: an owner and 19 members by invitation');
  const ownerAccount = await newAccount('Owner 0');
  const ownerApi = await apiSession(ownerAccount);
  // The workspace and the page, made in the app as a person makes them.
  const browser = await chromium.launch({ channel: 'chrome' });
  let workspaceId;
  let pageId;
  try {
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 800 } })
    ).newPage();
    await page.goto(`${APP}/`);
    await signInPage(page, ownerAccount, `${APP}/`);
    await page.getByLabel('Workspace name').fill(WORKSPACE);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await page.locator('.cgw-page .cgw-editor').waitFor({ timeout: 60000 });
    await page
      .getByTestId('sync-status')
      .filter({ hasText: /^Synced$/ })
      .waitFor({ timeout: 120000 });
    await page
      .getByRole('button', { name: /^Add a page in/ })
      .first()
      .click();
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === 'Page title',
    );
    await page.getByLabel('Page title').fill('Twenty editors');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.closest('.cgw-editor'));
    for (let i = 0; i < 20; i++) {
      if (i) await page.keyboard.press('Enter');
      await page.keyboard.insertText(`Line ${i}.`);
    }
    await page.getByTestId('save-status').filter({ hasText: /Saved/ }).waitFor({ timeout: 30000 });
    await page
      .getByTestId('sync-status')
      .filter({ hasText: /^Synced$/ })
      .waitFor({ timeout: 120000 });
    pageId = new URL(page.url()).hash.match(/#\/p\/([0-9a-f-]{36})/)[1];
    workspaceId = (await ownerApi.get('/api/v1/workspaces')).find((w) => w.name === WORKSPACE).id;
  } finally {
    await browser.close();
  }
  const members = await pool(
    Array.from({ length: 19 }, (_, i) => i + 1),
    4,
    async (i) => {
      const account = await newAccount(`Member ${i}`);
      return { account, api: await invite(ownerApi, workspaceId, account) };
    },
  );
  // The page's document as validated, for every editor to start from.
  const deadline = Date.now() + 120000;
  let pull;
  for (;;) {
    pull = await ownerApi.get(`/api/v1/pages/${pageId}/doc?after=0`);
    const doc = new Y.Doc();
    for (const u of pull.updates) Y.applyUpdate(doc, Buffer.from(u.data, 'base64'));
    if (doc.getXmlFragment('content').length >= 20) break;
    if (Date.now() > deadline) throw new Error('The page never held its 20 paragraphs');
    await sleep(500);
  }
  if (pull.snapshot) throw new Error('The page was compacted before the bench read it');
  const state = Y.mergeUpdates(pull.updates.map((u) => Buffer.from(u.data, 'base64')));
  const owner = { account: ownerAccount, api: ownerApi };
  const editors = [
    new Editor('Owner 0', ownerApi, workspaceId, pageId, 0),
    ...members.map((m, i) => new Editor(m.account.name, m.api, workspaceId, pageId, i + 1)),
  ];
  await pool(editors, 5, (editor) => editor.start(state));
  log(`  ${editors.length} editors on the page through the hub`);
  return { owner, members, editors, workspaceId, pageId };
}

async function relayRun(editors) {
  log(`20 editors typing for ${SECONDS} s, a key every ${KEY_MS} ms each`);
  await resetMetrics();
  const until = Date.now() + SECONDS * 1000;
  await Promise.all(editors.map((editor) => editor.type(until)));
  await sleep(1500);
  // The pulls that incomplete frames started.
  await Promise.all(editors.map((editor) => editor.pulling));
  const relayed = (await metrics()).relayed;
  const keys = editors.reduce((n, e) => n + e.keys, 0);
  const refused = editors.flatMap((e) => e.refused);
  const out = {
    editors: editors.length,
    keys,
    refused: refused.length,
    refusedCodes: [...new Set(refused)],
    relayed: {
      count: relayed.count,
      p50: round(relayed.p50Ms),
      p95: round(relayed.p95Ms),
      max: round(relayed.maxMs),
    },
    receipts: receipts(editors),
    // Each frame goes to every editor: the most any one editor saw.
    incompleteFrames: Math.max(...editors.map((e) => e.incomplete)),
    pullErrors: [...new Set(editors.flatMap((e) => e.pullErrors))],
    pullsAgain: editors.reduce((n, e) => n + e.snapshotsGone, 0),
  };
  // Every editor's document is the same as every other's at the end.
  const texts = editors.map((e) =>
    e.doc
      .getXmlFragment('content')
      .toArray()
      .map((block) => block.get(0)?.toString())
      .join('\n'),
  );
  out.converged = texts.every((t) => t === texts[0]);
  return out;
}

// ------------------------------------------------------------------ 2,000 connections
/** One of the 2,000: a connection of a device, following its workspace, on one page. */
class Line {
  constructor(api, workspaceId, pageId) {
    Object.assign(this, { api, workspaceId, pageId });
    this.connected = false;
    this.attempt = 0;
    this.clientId = 1 + Math.floor(Math.random() * 4_000_000_000);
  }

  async open() {
    this.connection = await openHub(this.api);
    this.connection.onclose(() => this.dropped());
    await call(this.connection, 'JoinWorkspaces', [this.workspaceId]);
    await call(this.connection, 'JoinPage', this.pageId);
    this.connected = true;
    this.attempt = 0;
    this.backAt = Date.now();
  }

  /** The app's schedule: min(30 s, 1 s × 2^n) × (0.5 … 1), a new ticket each attempt. */
  dropped() {
    if (this.closing) return;
    this.connected = false;
    const retry = async () => {
      const base = Math.min(30000, 1000 * 2 ** this.attempt++);
      await sleep(base * (0.5 + Math.random() * 0.5));
      try {
        await this.open();
      } catch {
        await this.connection?.stop().catch(() => {});
        if (!this.closing && !this.connected) void retry();
      }
    };
    void retry();
  }

  presence() {
    if (!this.connected) return;
    this.connection
      .invoke('Awareness', this.pageId, { clientId: this.clientId, cursor: null })
      .catch(() => {});
  }

  async close() {
    this.closing = true;
    await this.connection?.stop().catch(() => {});
  }
}

async function twoThousand() {
  const people = 10;
  const devices = 10;
  const perDevice = Math.ceil(CONNECTIONS / (people * devices));
  log(
    `${CONNECTIONS} connections: ${people} people, ${devices} devices each, ${perDevice} connections a device`,
  );
  const pid = await apiPid();
  const out = { connections: CONNECTIONS, people, devices, perDevice };
  out.baseline = await measure(pid, 10);
  log(
    `  before: working set ${out.baseline.workingSetMB} MB, private ${out.baseline.privateMB} MB, CPU ${out.baseline.cpuPct} %`,
  );
  const lines = [];
  const now = new Date().toISOString();
  await pool(
    Array.from({ length: people }, (_, i) => i),
    3,
    async (p) => {
      const account = await newAccount(`Load ${p}`);
      const first = await apiSession(account);
      const workspaceId = uuidv7();
      await first.post('/api/v1/workspaces', { id: workspaceId, name: `Load ${p}` });
      const sectionId = uuidv7();
      const op = (type, entityId, payload) => ({
        opId: uuidv7(),
        type,
        workspaceId,
        entityId,
        baseVersion: null,
        payload,
        createdAt: now,
      });
      const pages = Array.from({ length: 20 }, () => uuidv7());
      const digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
      const answer = await first.post(`/api/v1/workspaces/${workspaceId}/ops`, {
        ops: [
          op('section.create', sectionId, {
            id: sectionId,
            workspaceId,
            name: 'Shared',
            orderKey: 'a0',
            visibility: 'workspace',
            version: 1,
            createdAt: now,
          }),
          ...pages.map((id, i) =>
            op('page.create', id, {
              id,
              workspaceId,
              sectionId,
              parentPageId: null,
              orderKey: 'b0' + digits[i],
              kind: 'page',
              title: `Page ${i}`,
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
          ),
        ],
      });
      const refused = answer.results.filter((r) => r.status !== 'applied');
      if (refused.length) throw new Error('Operations refused: ' + JSON.stringify(refused[0]));
      const sessions = [first];
      for (let d = 1; d < devices; d++) sessions.push(await apiSession(account));
      for (const [d, api] of sessions.entries())
        for (let c = 0; c < perDevice && lines.length < CONNECTIONS; c++)
          lines.push(new Line(api, workspaceId, pages[(d * perDevice + c) % pages.length]));
    },
  );
  const opened = Date.now();
  await pool(lines, 50, (line) => line.open());
  out.openMs = Date.now() - opened;
  const connected = () => lines.filter((l) => l.connected).length;
  log(`  ${connected()} connected and joined in ${out.openMs} ms`);
  out.hub = await metrics();
  await sleep(5000);
  out.idle = await measure(pid, SAMPLE_SECONDS);
  out.perConnectionKB = round(((out.idle.privateMB - out.baseline.privateMB) * 1024) / CONNECTIONS);
  log(
    `  idle (keep-alives): working set ${out.idle.workingSetMB} MB, private ${out.idle.privateMB} MB, CPU ${out.idle.cpuPct} % of a core`,
  );
  // Presence from every connection every 10 s, spread over the 10 s.
  const timers = lines.map((line, i) =>
    setTimeout(
      () => {
        line.presence();
        line.timer = setInterval(() => line.presence(), 10000);
      },
      (i * 10000) / lines.length,
    ),
  );
  await sleep(10000);
  out.presence = await measure(pid, SAMPLE_SECONDS);
  log(
    `  with presence every 10 s: working set ${out.presence.workingSetMB} MB, private ${out.presence.privateMB} MB, CPU ${out.presence.cpuPct} % of a core`,
  );
  for (const timer of timers) clearTimeout(timer);
  for (const line of lines) clearInterval(line.timer);

  // The reconnect storm: the API recycled, every connection back on the app's schedule.
  if (await hasControl()) {
    log('  the API recycled: a reconnect storm of all of them');
    for (const line of lines) line.backAt = null;
    const recycle = await restartApi();
    const deadline = Date.now() + 180000;
    while (connected() < lines.length && Date.now() < deadline) await sleep(250);
    const back = lines.map((l) => l.backAt).filter(Boolean);
    const last = Math.max(...back);
    out.storm = {
      back: back.length,
      apiDownMs: recycle.readyAt - recycle.stoppedAt,
      fromKillMs: last - recycle.stoppedAt,
      fromReadyMs: last - recycle.readyAt,
      p50FromReadyMs: round(
        percentile(
          back.map((t) => t - recycle.readyAt),
          0.5,
        ),
      ),
    };
    log(
      `  ${out.storm.back} of ${lines.length} back: the last ${out.storm.fromReadyMs} ms after the API answered again (${out.storm.fromKillMs} ms after it was ended; down ${out.storm.apiDownMs} ms)`,
    );
    const newPid = recycle.pid;
    out.afterStorm = await measure(newPid, 10);
  } else {
    log('  (no stack control port: the reconnect storm is skipped)');
  }
  await pool(lines, 100, (line) => line.close());
  return out;
}

// ------------------------------------------------------------------ main
mkdirSync(results, { recursive: true });
const out = {
  at: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? null,
  keyMs: KEY_MS,
  seconds: SECONDS,
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
  if (!(await fetch(`${API}/api/v1/realtime/metrics`)).ok)
    throw new Error(
      'The hub has no metrics route: start the stack with Realtime__Metrics=true (scripts/server-stack.mjs --e2e sets it).',
    );
  if (!loadOnly) {
    const setup = await twentyEditors();
    try {
      out.relay = await relayRun(setup.editors);
      log(
        `  ${out.relay.keys} keys, ${out.relay.refused} refused; relay p50 ${out.relay.relayed.p50} ms, p95 ${out.relay.relayed.p95} ms, max ${out.relay.relayed.max} ms; push to the others' receipt p95 ${out.relay.receipts.p95} ms (${out.relay.receipts.missing} never received; ${out.relay.receipts.pulled} pulled after ${out.relay.incompleteFrames} incomplete frames, ${out.relay.pullsAgain} pulled again for a snapshot gone); converged: ${out.relay.converged}`,
      );
      const members = setup.editors.slice(1);
      log('Chrome: typing in the first paragraph while the 19 members type and their cursors move');
      out.web = await web(setup.owner, setup.pageId, members);
      log(
        `  ${out.web.keys} keys (${out.web.carets} cursors drawn; the others typed ${out.web.othersKeys}, refused ${out.web.othersRefused}): work p50 ${out.web.workP50} ms, p95 ${out.web.workP95} ms (waiting for the thread p95 ${out.web.waitP95} ms), next frame p95 ${out.web.frameP95} ms`,
      );
      log(`    meanwhile: ${cpuLine(out.web.cpu)}`);
      if (withDesktop) {
        out.desktop = await desktop(setup.owner, WORKSPACE, setup.pageId, members);
        log(
          `  ${out.desktop.keys} keys (${out.desktop.carets} cursors drawn): work p50 ${out.desktop.workP50} ms, p95 ${out.desktop.workP95} ms (waiting for the thread p95 ${out.desktop.waitP95} ms), next frame p95 ${out.desktop.frameP95} ms`,
        );
        log(`    meanwhile: ${cpuLine(out.desktop.cpu)}`);
      }
    } finally {
      await Promise.all(setup.editors.map((e) => e.stop()));
      await setup.owner.api.dispose();
      for (const m of setup.members) await m.api.dispose();
    }
  }
  if (withLoad) out.load = await twoThousand();
} finally {
  for (const child of started.reverse()) stopTree(child);
}

const peak = (name) =>
  out.load?.idle && out.load?.presence
    ? Math.max(out.load.idle[name], out.load.presence[name])
    : undefined;
const figures = {
  relay20P95: out.relay?.relayed?.p95,
  pushToReceiptP95: out.relay?.receipts?.p95,
  key20WorkP95: out.web?.workP95,
  key20FrameP95: out.web?.frameP95,
  relay20WhileTypingP95: out.web?.relayWhileTypingP95,
  key20DesktopWorkP95: out.desktop?.workP95,
  key20DesktopFrameP95: out.desktop?.frameP95,
  // The peak of the two samples (the collector may run in either).
  conn2000WorkingSetMB: peak('workingSetMB'),
  conn2000PrivateMB: peak('privateMB'),
  conn2000IdleCpuPct: out.load?.idle?.cpuPct,
  conn2000PresenceCpuPct: out.load?.presence?.cpuPct,
  storm2000Ms: out.load?.storm?.fromReadyMs,
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
// What must hold besides the figures: nothing refused, every update received, the editors' and
// the cursors' counts, every connection back after the storm.
const problems = [];
if (out.relay) {
  if (out.relay.refused)
    problems.push(`${out.relay.refused} pushes refused (${out.relay.refusedCodes.join(', ')})`);
  if (out.relay.receipts.missing)
    problems.push(`${out.relay.receipts.missing} relayed updates never received`);
  if (out.relay.pullErrors.length)
    problems.push(`a pull after an incomplete frame failed: ${out.relay.pullErrors.join('; ')}`);
  if (!out.relay.converged) problems.push('the 20 editors ended with different documents');
}
for (const part of [out.web, out.desktop].filter(Boolean)) {
  if (part.carets < 19) problems.push(`only ${part.carets} of 19 cursors drawn while typing`);
  if (part.othersRefused)
    problems.push(`${part.othersRefused} of the others' pushes refused while typing`);
}
if (out.load) {
  if (out.load.hub?.connections < CONNECTIONS)
    problems.push(`the hub counted ${out.load.hub?.connections} connections`);
  if (out.load.storm && out.load.storm.back < CONNECTIONS)
    problems.push(`${CONNECTIONS - out.load.storm.back} connections not back after the storm`);
}
out.figures = figures;
out.gate = gate;
out.problems = problems;
writeFileSync(join(results, 'phase6.json'), JSON.stringify(out, null, 2) + '\n');
log('\nBudget                         value      budget   last main');
for (const g of gate)
  log(
    `${g.overBudget || g.regressed ? 'FAIL' : 'ok  '} ${g.name.padEnd(28)} ${String(g.value).padStart(7)} ${g.unit.padEnd(3)} ${String(g.budget ?? 'none').padStart(7)}   ${g.previous ?? '-'}${g.regressed ? '  (regressed)' : ''}`,
  );
for (const problem of problems) log(`FAIL ${problem}`);
if (!last) log('(No run on main to compare with: budgets only.)');
else if (!sameMachine)
  log(
    `(The last run on main ran on ${last.machine?.cpu ?? 'a processor it did not record'}, this one on ${out.machine.cpu}: budgets only.)`,
  );
process.exitCode = gate.some((g) => g.overBudget || g.regressed) || problems.length ? 1 : 0;
