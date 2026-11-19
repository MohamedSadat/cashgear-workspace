// Phase 8's server CPU per push over real processes (M8.1; IMPLEMENTATION_PLAN.md, Phase 8,
// acceptance: "the server's CPU per push, the API's and the worker's, at most half of 0.7.0's on
// the reference machine"). Two builds of the server, each run as its own stack (Azurite, the API
// and the worker as processes, a database of its own, ports of its own: never the e2e stack's),
// one after the other, alternately:
//   before: 0.7.0, `git archive v0.7.0` unpacked under target/phase8-v070 (its own cgw-ydoc,
//           `cargo build -p cgw-ydoc --profile ffi` there, and `dotnet build -c Release` of its API
//           and worker);
//   after:  this checkout (`dotnet build server/Cgw.Server.slnx -c Release`, target/ffi/cgw_ydoc.dll).
// The load, as the app makes it: one person types into a page of 100 blocks with a history (about
// 33 KB, server/tests/Cgw.Tests/fixtures/make-typing.mjs), a key every 35 ms, one update a push
// through the hub (@microsoft/signalr, the app's own client), their selection as presence at most
// every 50 ms while typing; a second member has the page open (frames applied) and sends presence
// every 10 s, as does the typist when not typing. After a warm-up long enough for the JIT to settle
// (60 s), each process's CPU time is read over a typing window and over an idle window of the same
// length (the clients connected, presence every 10 s), in turns (`--cycles`); CPU per push =
// (typing - idle) / pushes, and the typing windows' CPU alone / pushes beside it.
// Writes bench/results/phase8-server-stack.json.
//   node bench/phase8-server.mjs [--runs 3] [--warmup 60] [--seconds 30] [--cycles 3] [--before DIR]
//     [--after DIR] [--only before|after] [--no-presence] [--no-reader] [--out NAME]
//     [--typist owner|member] [--groups N]
// Phase 11 (IMPLEMENTATION_PLAN.md, Phase 11: "the server's CPU per push within 10 % of 0.10.0's,
// the push's fast path deciding for a person in 20 groups"): `--before target/phase11-v0100` (0.10.0,
// `git archive v0.10.0 server global.json`, this checkout's target/ffi copied, built in Release),
// `--typist member` (the member types and the owner reads: an owner's push never reads the page's
// rows), and `--groups 20` (on a build with groups: the typist in 20 groups, and the page shared
// with 20 others at view, so the fast path weighs each group row and still decides the push).
// A build without groups' routes gets the same page with no rows.
// Ports: CGW_BENCH_API_PORT (5380), CGW_BENCH_BLOB_PORT (10100); database cgw_phase8_bench
// (dropped and made again each run); data under .cgw-dev/phase8.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { root } from '../scripts/lib.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const RUNS = Number(arg('--runs', 3));
// To see where a build's time goes: one build only, and the load without presence or the reader.
const ONLY = arg('--only', null);
const PRESENCE = !args.includes('--no-presence');
const READER = !args.includes('--no-reader');
const TYPIST = arg('--typist', 'owner');
const GROUPS = Number(arg('--groups', 0));
const WARMUP_S = Number(arg('--warmup', 60));
const SECONDS = Number(arg('--seconds', 30));
const CYCLES = Number(arg('--cycles', 3));
const KEY_MS = 35;
const BEFORE = resolve(root, arg('--before', 'target/phase8-v070'));
const AFTER = resolve(root, arg('--after', '.'));
const PORT = Number(process.env.CGW_BENCH_API_PORT ?? 5380);
const BLOB_PORT = Number(process.env.CGW_BENCH_BLOB_PORT ?? 10100);
const API = `http://127.0.0.1:${PORT}`;
const DATABASE = 'cgw_phase8_bench';
const DATA = join(root, '.cgw-dev/phase8');
const MAIL = join(DATA, 'mail');
// The e2e helpers' session reads the API from here (scripts/cloud-account.mjs).
process.env.E2E_API_URL = API;
const { apiSession } = await import('../scripts/cloud-account.mjs');
const signalR = createRequire(join(root, 'packages/shell/package.json'))('@microsoft/signalr');
const Y = createRequire(join(root, 'packages/doc/package.json'))('yjs');

const log = (line) => console.log(line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 2) => (n === null || n === undefined ? n : Math.round(n * 10 ** d) / 10 ** d);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};

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

// ------------------------------------------------------------------ the stack
function build(tree) {
  const out = {
    api: join(tree, 'server/src/Cgw.Api/bin/Release/net10.0'),
    worker: join(tree, 'server/src/Cgw.Worker/bin/Release/net10.0'),
    ffi: join(tree, 'target/ffi/cgw_ydoc.dll'),
  };
  for (const [part, path] of Object.entries(out))
    if (!existsSync(path))
      throw new Error(`No ${part} at ${path}: build it first (see the header)`);
  return out;
}

function stopTree(child) {
  if (child && child.exitCode === null)
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
}

async function answers(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function waitFor(check, what, seconds) {
  const until = Date.now() + seconds * 1000;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(300);
  }
}

/** Azurite, a fresh database, the API (which migrates it) and the worker, from one build. */
async function startStack(label, parts) {
  const run = join(DATA, 'run', label);
  rmSync(run, { recursive: true, force: true });
  rmSync(MAIL, { recursive: true, force: true });
  mkdirSync(MAIL, { recursive: true });
  cpSync(parts.api, join(run, 'api'), { recursive: true });
  cpSync(parts.worker, join(run, 'worker'), { recursive: true });
  cpSync(parts.ffi, join(run, 'cgw_ydoc.dll'));
  const drop = `IF DB_ID('${DATABASE}') IS NOT NULL BEGIN ALTER DATABASE [${DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DATABASE}]; END`;
  spawnSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-E', '-C', '-Q', drop], {
    encoding: 'utf8',
  });
  const children = [];
  const azurite = spawn(
    process.execPath,
    [
      join(root, 'node_modules/azurite/dist/src/blob/main.js'),
      '--blobHost',
      '127.0.0.1',
      '--blobPort',
      String(BLOB_PORT),
      '--inMemoryPersistence',
      '--silent',
      '--skipApiVersionCheck',
      '--loose',
      '--disableTelemetry',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  children.push(azurite);
  const key =
    'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
  const env = {
    ...process.env,
    ASPNETCORE_ENVIRONMENT: 'Development',
    DOTNET_ENVIRONMENT: 'Development',
    ConnectionStrings__Sql: `Server=(localdb)\\MSSQLLocalDB;Integrated Security=true;TrustServerCertificate=true;Database=${DATABASE}`,
    Blob__ConnectionString: `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${key};BlobEndpoint=http://127.0.0.1:${BLOB_PORT}/devstoreaccount1;`,
    Smtp__PickupDirectory: MAIL,
    Api__PublicUrl: API,
    Api__AllowHttp: 'true',
    Web__AppUrl: 'http://127.0.0.1:4273',
    Web__Origins__0: 'http://127.0.0.1:4273',
    Ydoc__Library: join(run, 'cgw_ydoc.dll'),
    Logging__LogLevel__Default: 'Warning',
    Logging__LogLevel__Microsoft: 'Warning',
    RateLimits__signin: '10000',
    RateLimits__anonymous: '10000',
    RateLimits__user: '100000',
    RateLimits__push: '100000',
    RateLimits__realtime: '10000',
  };
  await waitFor(
    async () => {
      try {
        await fetch(`http://127.0.0.1:${BLOB_PORT}/`);
        return true;
      } catch {
        return false;
      }
    },
    'Azurite',
    60,
  );
  const api = spawn('dotnet', [join(run, 'api/Cgw.Api.dll'), '--urls', API], {
    env: { ...env, Database__MigrateOnStart: 'true' },
    stdio: 'ignore',
    windowsHide: true,
  });
  children.push(api);
  await waitFor(() => answers(`${API}/health/live`), 'the API', 240);
  const worker = spawn('dotnet', [join(run, 'worker/Cgw.Worker.dll')], {
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  children.push(worker);
  return {
    apiPid: api.pid,
    workerPid: worker.pid,
    stop: () => children.reverse().forEach(stopTree),
  };
}

/** The CPU time each process has used so far (ms), read at once. */
function cpuOf(pids) {
  const out = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      pids.map((pid) => `(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`).join('; '),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  const values = out.stdout.trim().split(/\s+/).map(Number);
  if (values.length !== pids.length || values.some((v) => !Number.isFinite(v)))
    throw new Error('No CPU time: ' + out.stdout + out.stderr);
  return { at: Date.now(), values };
}

// ------------------------------------------------------------------ people
async function mailTo(address, containing) {
  for (let i = 0; i < 300; i++) {
    let files = [];
    try {
      files = readdirSync(MAIL)
        .filter((f) => f.endsWith('.eml'))
        .sort()
        .reverse();
    } catch {
      // The folder appears with the first mail.
    }
    for (const file of files) {
      let text;
      try {
        text = readFileSync(join(MAIL, file), 'utf8')
          .replace(/=\r?\n/g, '')
          .replace(/=3D/g, '=');
      } catch {
        continue;
      }
      if (
        text.toLowerCase().includes(address.toLowerCase()) &&
        (!containing || text.includes(containing))
      )
        return text;
    }
    await sleep(100);
  }
  throw new Error(`No mail to ${address}`);
}

async function newAccount(name) {
  const email = `p8-${Date.now()}-${randomBytes(4).toString('hex')}@example.test`;
  const password = `a long bench password ${randomBytes(6).toString('hex')}`;
  const register = await fetch(`${API}/api/v1/account/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName: name, locale: 'en' }),
  });
  if (register.status !== 202) throw new Error(`Sign-up answered ${register.status}`);
  const link = (await mailTo(email, '/account/confirm')).match(/\/account\/confirm[^\s"<>]+/);
  const url = new URL(link[0].replace(/&amp;/g, '&'), API);
  const confirmed = await fetch(`${API}/api/v1/account/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: url.searchParams.get('userId'),
      code: url.searchParams.get('code'),
    }),
  });
  if (confirmed.status !== 204) throw new Error(`Confirming answered ${confirmed.status}`);
  return { email, password, name };
}

/** The page every run types into: make-typing.mjs's base (100 blocks, a 400-edit history). */
function basePage() {
  const file = join(DATA, 'typing.json');
  if (!existsSync(file)) {
    mkdirSync(DATA, { recursive: true });
    const made = spawnSync(
      process.execPath,
      [join(root, 'server/tests/Cgw.Tests/fixtures/make-typing.mjs'), file, '100', '1'],
      { encoding: 'utf8' },
    );
    if (made.status !== 0) throw new Error(made.stderr);
  }
  const corpus = JSON.parse(readFileSync(file, 'utf8'));
  return { base: Buffer.from(corpus.base, 'base64'), clients: corpus.clients };
}

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

async function call(connection, method, ...callArgs) {
  const answer = await connection.invoke(method, ...callArgs);
  if (!answer?.ok) throw new Error(`${method}: ${answer?.status} ${answer?.code} ${answer?.title}`);
  return answer.value;
}

const relative = (type, index) =>
  Buffer.from(
    Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(type, index)),
  ).toString('base64');

/** The team, the page and its base, and the two hub connections. */
async function scene() {
  const owner = await newAccount('Olive Typist');
  const member = await newAccount('Mo Reader');
  const ownerApi = await apiSession(owner);
  const workspaceId = uuidv7();
  await ownerApi.post('/api/v1/workspaces', { id: workspaceId, name: 'Bench' });
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
  const sectionId = uuidv7();
  const pageId = uuidv7();
  await ownerApi.post(`/api/v1/workspaces/${workspaceId}/ops`, {
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
      op('page.create', pageId, {
        id: pageId,
        workspaceId,
        sectionId,
        parentPageId: null,
        orderKey: 'a0',
        kind: 'page',
        title: 'Typed into',
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
    ],
  });
  await ownerApi.post(`/api/v1/workspaces/${workspaceId}/invites`, {
    email: member.email,
    role: 'member',
  });
  const token = /\/#\/invite\/([A-Za-z0-9_-]+)/.exec(await mailTo(member.email, '/#/invite/'))[1];
  const memberApi = await apiSession(member);
  await memberApi.post('/api/v1/invites/accept', { token });
  const typistApi = TYPIST === 'member' ? memberApi : ownerApi;
  const readerApi = TYPIST === 'member' ? ownerApi : memberApi;
  const groups =
    GROUPS > 0
      ? await groupsOn(ownerApi, workspaceId, pageId, TYPIST === 'member' ? member : owner)
      : 0;

  const { base, clients } = basePage();
  const typistClient = 1_000_000 + Math.floor(Math.random() * 2_000_000_000);
  // The base's clients are the owner's (who pushes the base); the typist's is the typist's own.
  const registered = await ownerApi.post(`/api/v1/workspaces/${workspaceId}/yjs-clients`, {
    issue: null,
    register: clients,
  });
  const own = await typistApi.post(`/api/v1/workspaces/${workspaceId}/yjs-clients`, {
    issue: null,
    register: [typistClient],
  });
  if (registered.registered.length !== clients.length || own.registered.length !== 1)
    throw new Error('Clients not registered: ' + JSON.stringify({ registered, own }));
  await ownerApi.post(`/api/v1/pages/${pageId}/doc/updates`, {
    epoch: 0,
    clientSchemaVersion: 1,
    updates: [{ updateId: uuidv7(), data: base.toString('base64') }],
  });
  await waitFor(
    async () => (await ownerApi.get(`/api/v1/pages/${pageId}/doc?after=0`)).headSeq >= 1,
    'the base page validated',
    60,
  );

  const doc = new Y.Doc();
  Y.applyUpdate(doc, base, 'remote');
  doc.clientID = typistClient;
  const received = new Map();
  const reader = await openHub(readerApi, {
    Updates: (frame) => {
      const at = Date.now();
      for (const update of frame.updates) received.set(update.updateId, at);
    },
  });
  const typist = await openHub(typistApi);
  for (const connection of READER ? [typist, reader] : [typist]) {
    await call(connection, 'JoinWorkspaces', [workspaceId]);
    await call(connection, 'JoinPage', pageId);
  }
  const readerDoc = new Y.Doc();
  return {
    ownerApi,
    memberApi,
    pageId,
    doc,
    typist,
    reader,
    received,
    readerClient: 4_000_000 + Math.floor(Math.random() * 1_000_000),
    readerDoc,
    groups,
  };
}

/**
 * Phase 11: `count` groups with the typist in each, and `count` others with the page shared with
 * them at view (rows the push's fast path weighs, none of them the typist's). 0 on a build with no
 * groups' routes (0.10.0), whose page then holds no row.
 */
async function groupsOn(ownerApi, workspaceId, pageId, typist) {
  const probe = await ownerApi.raw(`/api/v1/workspaces/${workspaceId}/groups`);
  if (probe.status === 404) return 0;
  const listed = await ownerApi.get(`/api/v1/workspaces/${workspaceId}/members`);
  const members = Array.isArray(listed) ? listed : listed.members;
  const typistId = members.find((m) => m.email === typist.email).userId;
  const shared = [];
  for (let i = 0; i < GROUPS * 2; i++) {
    const mine = i < GROUPS;
    const group = await ownerApi.post(`/api/v1/workspaces/${workspaceId}/groups`, {
      name: `${mine ? 'Typist' : 'Other'} ${i}`,
      people: mine ? [typistId] : [],
    });
    if (!mine) shared.push(group.id);
  }
  await ownerApi.put(`/api/v1/pages/${pageId}/permissions`, {
    restricted: false,
    principals: ['group'],
    entries: shared.map((id) => ({ principalType: 'group', principalId: id, level: 'view' })),
  });
  return GROUPS;
}

/** Types (`typing`) or idles, for `ms`; presence as the app sends it. Returns the pushes made. */
async function load(s, ms, typing, state) {
  const content = s.doc.getXmlFragment('content');
  const until = Date.now() + ms;
  let pushes = 0;
  const pushed = state.pushed;
  // Paced by the clock, not by sleeps added up: a key every 35 ms however long a push took.
  let next = Date.now();
  while (Date.now() < until) {
    if (typing) {
      let update = null;
      const capture = (u, origin) => origin !== 'remote' && (update = u);
      s.doc.on('update', capture);
      s.doc.transact(() => {
        if (!state.text) {
          const block = new Y.XmlElement('block');
          block.setAttribute('id', 'TypistBlock1');
          const body = new Y.XmlElement('textBody');
          body.setAttribute('kind', 'paragraph');
          state.text = new Y.XmlText('t');
          body.insert(0, [state.text]);
          block.insert(0, [body]);
          content.push([block]);
        } else state.text.insert(state.text.length, 'the quick brown fox '[state.keys % 20]);
      });
      s.doc.off('update', capture);
      state.keys++;
      const updateId = uuidv7();
      pushed.set(updateId, Date.now());
      try {
        await call(s.typist, 'PushUpdates', s.pageId, {
          epoch: 0,
          clientSchemaVersion: 6,
          updates: [{ updateId, data: Buffer.from(update).toString('base64') }],
        });
        pushes++;
      } catch (error) {
        state.refused.push(String(error.message));
      }
      // The selection on every change, at most every 50 ms.
      if (PRESENCE && Date.now() - state.typistPresence >= 50) {
        state.typistPresence = Date.now();
        const at = relative(state.text, state.text.length);
        s.typist
          .invoke('Awareness', s.pageId, {
            clientId: s.doc.clientID,
            cursor: { anchor: at, head: at },
          })
          .catch(() => {});
      }
    } else if (PRESENCE && Date.now() - state.typistPresence >= 10_000) {
      state.typistPresence = Date.now();
      s.typist
        .invoke('Awareness', s.pageId, { clientId: s.doc.clientID, cursor: null })
        .catch(() => {});
    }
    // The reader, on the page: every 10 s.
    if (PRESENCE && READER && Date.now() - state.readerPresence >= 10_000) {
      state.readerPresence = Date.now();
      s.reader
        .invoke('Awareness', s.pageId, { clientId: s.readerClient, cursor: null })
        .catch(() => {});
    }
    next += KEY_MS;
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
    else next = Date.now();
  }
  return pushes;
}

async function measureRun(label, parts) {
  log(`${label}: starting the stack`);
  const stack = await startStack(label, parts);
  try {
    const s = await scene();
    const state = {
      keys: 0,
      text: null,
      refused: [],
      pushed: new Map(),
      typistPresence: 0,
      readerPresence: 0,
    };
    log(`${label}: warming up ${WARMUP_S} s`);
    await load(s, WARMUP_S * 1000, true, state);
    await sleep(1000);
    const pids = [stack.apiPid, stack.workerPid];
    // Typing and idle windows taken in turn (CYCLES of each, SECONDS of each in all), so a drift
    // of the machine's load meets both alike.
    const typing = [0, 0];
    const idle = [0, 0];
    let typingMs = 0;
    let idleMs = 0;
    let pushes = 0;
    const delays = [];
    for (let c = 0; c < CYCLES; c++) {
      const t0 = cpuOf(pids);
      const firstKey = state.pushed.size;
      pushes += await load(s, (SECONDS * 1000) / CYCLES, true, state);
      const t1 = cpuOf(pids);
      // The relay: each key from its push to the reader's frame, in the window.
      await sleep(500);
      delays.push(
        ...[...state.pushed.entries()]
          .slice(firstKey)
          .map(([id, at]) => (s.received.has(id) ? s.received.get(id) - at : null))
          .filter((d) => d !== null),
      );
      const i0 = cpuOf(pids);
      await load(s, (SECONDS * 1000) / CYCLES, false, state);
      const i1 = cpuOf(pids);
      for (const k of [0, 1]) {
        typing[k] += t1.values[k] - t0.values[k];
        idle[k] += i1.values[k] - i0.values[k];
      }
      typingMs += t1.at - t0.at;
      idleMs += i1.at - i0.at;
    }
    const per = (k) => (typing[k] - (idle[k] * typingMs) / idleMs) / pushes;
    const result = {
      label,
      // Phase 11: the groups the typist was put in (0 on a build without groups).
      groups: s.groups,
      pushes,
      refused: state.refused.length,
      apiCpuMsPerPush: round(per(0)),
      workerCpuMsPerPush: round(per(1)),
      // Without the idle taken off: everything the process did while typing, a push.
      apiTypingCpuMsPerPush: round(typing[0] / pushes),
      workerTypingCpuMsPerPush: round(typing[1] / pushes),
      apiTypingCpuMs: round(typing[0], 0),
      workerTypingCpuMs: round(typing[1], 0),
      apiIdleCpuMs: round(idle[0], 0),
      workerIdleCpuMs: round(idle[1], 0),
      typingSeconds: round(typingMs / 1000, 1),
      idleSeconds: round(idleMs / 1000, 1),
      pushToFrameP50Ms: round(percentile(delays, 0.5), 1),
      pushToFrameP95Ms: round(percentile(delays, 0.95), 1),
      framesMissing: pushes - delays.length,
    };
    log(`  ${JSON.stringify(result)}`);
    await s.typist.stop();
    await s.reader.stop();
    await s.ownerApi.dispose();
    await s.memberApi.dispose();
    return result;
  } finally {
    stack.stop();
    await sleep(2000);
  }
}

const builds = { before: build(BEFORE), after: build(AFTER) };
const runs = [];
for (let i = 1; i <= RUNS; i++)
  for (const label of ['before', 'after'].filter((l) => !ONLY || l === ONLY))
    runs.push(await measureRun(`${label}-${i}`, builds[label]));
const summary = {};
for (const label of ['before', 'after']) {
  const mine = runs.filter((r) => r.label.startsWith(label));
  if (!mine.length) continue;
  summary[label] = {
    apiCpuMsPerPush: round(median(mine.map((r) => r.apiCpuMsPerPush))),
    workerCpuMsPerPush: round(median(mine.map((r) => r.workerCpuMsPerPush))),
    apiTypingCpuMsPerPush: round(median(mine.map((r) => r.apiTypingCpuMsPerPush))),
    workerTypingCpuMsPerPush: round(median(mine.map((r) => r.workerTypingCpuMsPerPush))),
    pushToFrameP95Ms: round(median(mine.map((r) => r.pushToFrameP95Ms)), 1),
    // The spread over the runs: lowest and highest.
    apiCpuMsPerPushRange: [
      round(Math.min(...mine.map((r) => r.apiCpuMsPerPush))),
      round(Math.max(...mine.map((r) => r.apiCpuMsPerPush))),
    ],
    workerCpuMsPerPushRange: [
      round(Math.min(...mine.map((r) => r.workerCpuMsPerPush))),
      round(Math.max(...mine.map((r) => r.workerCpuMsPerPush))),
    ],
  };
}
// Each alternation's pair (before-i, then after-i, one after the other): its own ratio.
const pairs = [];
for (let i = 1; i <= RUNS; i++) {
  const before = runs.find((r) => r.label === `before-${i}`);
  const after = runs.find((r) => r.label === `after-${i}`);
  if (!before || !after) continue;
  pairs.push({
    run: i,
    api: [before.apiCpuMsPerPush, after.apiCpuMsPerPush],
    worker: [before.workerCpuMsPerPush, after.workerCpuMsPerPush],
    apiRatio: round(after.apiCpuMsPerPush / before.apiCpuMsPerPush, 3),
    workerRatio: round(after.workerCpuMsPerPush / before.workerCpuMsPerPush, 3),
  });
}
if (pairs.length)
  summary.pairs = {
    each: pairs,
    apiRatioMedian: round(median(pairs.map((p) => p.apiRatio)), 3),
    apiRatioRange: [
      Math.min(...pairs.map((p) => p.apiRatio)),
      Math.max(...pairs.map((p) => p.apiRatio)),
    ],
    workerRatioMedian: round(median(pairs.map((p) => p.workerRatio)), 3),
    workerRatioRange: [
      Math.min(...pairs.map((p) => p.workerRatio)),
      Math.max(...pairs.map((p) => p.workerRatio)),
    ],
  };
if (summary.before && summary.after)
  summary.ratio = {
    api: round(summary.after.apiCpuMsPerPush / summary.before.apiCpuMsPerPush, 3),
    worker: round(summary.after.workerCpuMsPerPush / summary.before.workerCpuMsPerPush, 3),
    apiTyping: round(summary.after.apiTypingCpuMsPerPush / summary.before.apiTypingCpuMsPerPush, 3),
    workerTyping: round(
      summary.after.workerTypingCpuMsPerPush / summary.before.workerTypingCpuMsPerPush,
      3,
    ),
  };
const out = {
  at: new Date().toISOString(),
  machine: { cores: cpus().length, cpu: cpus()[0]?.model },
  settings: {
    runs: RUNS,
    warmupSeconds: WARMUP_S,
    seconds: SECONDS,
    cycles: CYCLES,
    keyMs: KEY_MS,
    before: BEFORE,
    after: AFTER,
    typist: TYPIST,
    groups: GROUPS,
  },
  summary,
  runs,
};
mkdirSync(join(root, 'bench/results'), { recursive: true });
writeFileSync(
  join(root, `bench/results/${arg('--out', 'phase8-server-stack')}.json`),
  JSON.stringify(out, null, 2) + '\n',
);
log(JSON.stringify(summary, null, 2));
process.exit(0);
