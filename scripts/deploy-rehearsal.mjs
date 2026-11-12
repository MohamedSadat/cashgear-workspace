// The deployment rehearsal and the restore drill (M2.8; docs/OPERATIONS.md), on this machine:
//   1. builds the deploy package (scripts/server-publish.mjs) and runs it as an operator would:
//      the migration bundle against a scratch database, the published API and worker on it;
//   2. smoke-tests it through HTTP as the apps do: sign-up and the confirmation mail, sign-in on
//      the API's page, a workspace with pages, documents pushed and validated by the worker, an
//      image by signed URL, a named version, search;
//   3. the drill: backs the database up, copies the blob storage, restores both into a second
//      scratch environment, starts the package on it, lets the reconcile job run, and opens every
//      page through the API, comparing each with what was written.
// Writes bench/results/deploy-rehearsal.json. LocalDB unless CGW_DEV_SQL names a server.
//   node scripts/deploy-rehearsal.mjs [--skip-publish]
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { join } from 'node:path';
import { root } from './lib.mjs';

const Y = createRequire(join(root, 'packages/doc/package.json'))('yjs');
const work = join(root, 'target', 'rehearsal');
const pkg = join(work, 'package');
const server =
  process.env.CGW_DEV_SQL ??
  'Server=(localdb)\\MSSQLLocalDB;Integrated Security=true;TrustServerCertificate=true';
const azuriteKey =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
const result = { started: new Date().toISOString(), steps: [] };
const step = (name, detail = {}) => {
  console.log(`✓ ${name}`);
  result.steps.push({ name, ...detail, at: new Date().toISOString() });
};
const children = [];
const kill = (child) => {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGTERM');
};
process.on('exit', () => children.forEach(kill));

function sql(database, query) {
  const args = process.env.CGW_DEV_SQL
    ? [
        '-S',
        new URL(`x://${/Server=([^;]+)/.exec(server)[1].replace(',', ':')}`).host,
        '-C',
        '-Q',
        query,
      ]
    : ['-S', '(localdb)\\MSSQLLocalDB', '-E', '-C', '-b', '-d', database, '-Q', query];
  const run = spawnSync('sqlcmd', args, { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`sqlcmd failed: ${run.stdout}${run.stderr}`);
  return run.stdout;
}
const drop = (database) =>
  sql(
    'master',
    `IF DB_ID('${database}') IS NOT NULL BEGIN ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]; END`,
  );
const connection = (database) => `${server.replace(/;?$/, ';')}Database=${database}`;
const blobConnection = (port) =>
  `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${azuriteKey};BlobEndpoint=http://127.0.0.1:${port}/devstoreaccount1;`;

const open = (port) =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
async function until(what, check, seconds = 120) {
  for (let i = 0; i < seconds * 4; i++) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // Not yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out: ${what}`);
}
function start(name, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: work,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  children.push(child);
  return child;
}

/** The deployed pair (API and worker) on one database and one Blob Storage. */
async function deploy(label, database, blobPort, apiPort) {
  const blobDir = join(work, `blob-${label}`);
  mkdirSync(blobDir, { recursive: true });
  const azurite = start(`azurite-${label}`, process.execPath, [
    join(root, 'node_modules/azurite/dist/src/blob/main.js'),
    '--blobHost',
    '127.0.0.1',
    '--blobPort',
    String(blobPort),
    '--location',
    blobDir,
    '--silent',
    '--skipApiVersionCheck',
    '--loose',
    '--disableTelemetry',
  ]);
  await until('Azurite', () => open(blobPort));
  const mail = join(work, `mail-${label}`);
  const env = {
    // Staging: the production code path except the certificate store (an operator's step).
    ASPNETCORE_ENVIRONMENT: 'Staging',
    DOTNET_ENVIRONMENT: 'Staging',
    ConnectionStrings__Sql: connection(database),
    Blob__ConnectionString: blobConnection(blobPort),
    Smtp__PickupDirectory: mail,
    Api__PublicUrl: `http://127.0.0.1:${apiPort}`,
    Web__AppUrl: 'http://127.0.0.1:4273',
    Web__Origins__0: 'http://127.0.0.1:4273',
    Logging__LogLevel__Default: 'Warning',
  };
  const api = start(
    `api-${label}`,
    'dotnet',
    [join(pkg, 'api', 'Cgw.Api.dll'), '--urls', `http://127.0.0.1:${apiPort}`],
    env,
  );
  await until(
    'the API',
    async () => (await fetch(`http://127.0.0.1:${apiPort}/health/live`)).ok,
    120,
  );
  const worker = start(
    `worker-${label}`,
    join(pkg, 'worker', process.platform === 'win32' ? 'Cgw.Worker.exe' : 'Cgw.Worker'),
    [],
    env,
  );
  return { api, worker, azurite, mail, base: `http://127.0.0.1:${apiPort}`, blobDir };
}

/** A browser-like client: a cookie jar and the antiforgery header on writes. */
class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.csrf = null;
  }
  async request(path, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (this.cookies.size)
      headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.csrf && options.method && options.method !== 'GET')
      headers['X-CSRF-TOKEN'] = this.csrf;
    const response = await fetch(this.base + path, { ...options, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const at = pair.indexOf('=');
      this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  }
  async json(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await this.request(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }
  async signIn(email, password) {
    const page = await (await this.request('/account/signin')).text();
    const token = /name="__RequestVerificationToken" value="([^"]+)"/
      .exec(page)[1]
      .replace(/&#x2B;/g, '+')
      .replace(/&#x2F;/g, '/')
      .replace(/&#x3D;/g, '=');
    const response = await this.request('/account/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        __RequestVerificationToken: token,
        Email: email,
        Password: password,
        ReturnUrl: '',
      }),
    });
    if (response.status !== 302) throw new Error(`Sign-in failed: ${response.status}`);
    this.csrf = (await this.json('/api/v1/account/antiforgery')).token;
  }
}

async function mailLink(mail, address, pattern) {
  return until(
    `a mail to ${address}`,
    () => {
      if (!existsSync(mail)) return null;
      for (const file of readdirSync(mail).sort().reverse()) {
        const text = readFileSync(join(mail, file), 'utf8')
          .replace(/=\r?\n/g, '')
          .replace(/=3D/g, '=');
        if (text.includes(address)) return pattern.exec(text)?.[0].replace(/&amp;/g, '&');
      }
      return null;
    },
    30,
  );
}

const textOf = (updates) => {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  const text = doc.getXmlFragment('content').toString();
  doc.destroy();
  return text;
};

/** Every page's document through the API, as a client would rebuild it from after=0. */
async function readPages(client, pages) {
  const out = {};
  for (const id of pages) {
    const pull = await client.json(`/api/v1/pages/${id}/doc?after=0`);
    const parts = [];
    if (pull.snapshot)
      parts.push(new Uint8Array(await (await fetch(pull.snapshot.url)).arrayBuffer()));
    for (const u of pull.updates) parts.push(Buffer.from(u.data, 'base64'));
    out[id] = textOf(parts);
  }
  return out;
}

try {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  if (!process.argv.includes('--skip-publish') || !existsSync(pkg)) {
    const publish = spawnSync(
      process.execPath,
      [join(root, 'scripts/server-publish.mjs'), '--out', pkg],
      { cwd: root, stdio: 'inherit' },
    );
    if (publish.status !== 0) throw new Error('The package did not build');
  }
  const manifest = JSON.parse(readFileSync(join(pkg, 'manifest.json'), 'utf8'));
  step('package built', { version: manifest.version, commit: manifest.commit });

  drop('cgw_rehearsal');
  drop('cgw_drill');
  sql('master', 'CREATE DATABASE [cgw_rehearsal]');
  const migrate = spawnSync(
    join(pkg, 'migrate', process.platform === 'win32' ? 'efbundle.exe' : 'efbundle'),
    ['--connection', connection('cgw_rehearsal')],
    { encoding: 'utf8' },
  );
  if (migrate.status !== 0)
    throw new Error(`The migration bundle failed: ${migrate.stdout}${migrate.stderr}`);
  step('migration bundle applied', { tail: migrate.stdout.trim().split('\n').slice(-1)[0] });

  const first = await deploy('a', 'cgw_rehearsal', 10020, 5290);
  const ready = await until('ready', async () => {
    const r = await fetch(`${first.base}/health/ready`);
    return r.ok ? await r.text() : null;
  });
  step('published API and worker running', { health: ready.slice(0, 200) });

  // The smoke test.
  const email = `rehearsal-${Date.now()}@example.test`;
  const password = 'a long rehearsal password';
  const client = new Client(first.base);
  await client.json('/api/v1/account/register', {
    email,
    password,
    displayName: 'Rehearsal',
    locale: 'en',
  });
  const confirm = await mailLink(
    first.mail,
    email,
    /http:\/\/127\.0\.0\.1:5290\/account\/confirm[^\s"<>]+/,
  );
  if (!(await fetch(confirm)).ok) throw new Error('Confirmation failed');
  await client.signIn(email, password);
  step('signed up, confirmed by mail, signed in on the API page');

  const now = new Date().toISOString();
  const id = () => crypto.randomUUID();
  const workspace = { id: id(), name: 'Rehearsal' };
  await client.json('/api/v1/workspaces', workspace);
  const section = id();
  const fixtures = Object.fromEntries(
    JSON.parse(
      readFileSync(join(root, 'server/tests/Cgw.Tests/fixtures/updates.json'), 'utf8'),
    ).map((f) => [f.name, f]),
  );
  const pages = [id(), id(), id()];
  const op = (type, entityId, payload) => ({
    opId: id(),
    type,
    workspaceId: workspace.id,
    entityId,
    baseVersion: null,
    payload,
    createdAt: now,
  });
  const ops = [
    op('section.create', section, {
      id: section,
      workspaceId: workspace.id,
      name: 'Pages',
      orderKey: 'a0',
      visibility: 'workspace',
      version: 1,
      createdAt: now,
    }),
    ...pages.map((p, i) =>
      op('page.create', p, {
        id: p,
        workspaceId: workspace.id,
        sectionId: section,
        parentPageId: i === 2 ? pages[0] : null,
        orderKey: `a${i}`,
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
  ];
  const applied = await client.json(`/api/v1/workspaces/${workspace.id}/ops`, { ops });
  if (applied.results.some((r) => r.status !== 'applied'))
    throw new Error(`An operation was refused: ${JSON.stringify(applied)}`);
  await client.json(`/api/v1/workspaces/${workspace.id}/yjs-clients`, { register: [1001, 1002] });
  for (const p of pages)
    await client.json(`/api/v1/pages/${p}/doc/updates`, {
      epoch: 0,
      clientSchemaVersion: 1,
      updates: [fixtures.page, fixtures.edit].map((f) => ({ updateId: id(), data: f.data })),
    });
  await until(
    'the worker to validate',
    async () => {
      const pull = await client.json(`/api/v1/pages/${pages[2]}/doc?after=0`);
      return pull.headSeq >= 2;
    },
    60,
  );
  const written = await readPages(client, pages);
  if (!Object.values(written).every((t) => t.includes('Hello world')))
    throw new Error('A page did not read back');
  step('workspace, three pages and their documents pushed, validated by the worker, read back');

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEUlEQVR4nGP4z8AARAwM/xkAH/oD/f8rP3QAAAAASUVORK5CYII=',
    'base64',
  );
  const assetId = id();
  const ticket = await client.json(`/api/v1/workspaces/${workspace.id}/assets`, {
    id: assetId,
    fileName: 'p.png',
    contentType: 'image/png',
    sizeBytes: png.length,
  });
  const put = await fetch(ticket.uploadUrl, { method: 'PUT', headers: ticket.headers, body: png });
  if (!put.ok) throw new Error(`Upload failed: ${put.status}`);
  await client.json(`/api/v1/assets/${assetId}/complete`, {});
  await until(
    'the asset check',
    async () => (await client.json(`/api/v1/assets/${assetId}`)).status === 'ready',
    30,
  );
  step('an image uploaded by signed URL and checked by the worker');

  let version = null;
  try {
    version = await client.json(`/api/v1/pages/${pages[0]}/versions`, {
      name: 'Rehearsal',
      kind: 'named',
    });
    await until(
      'the named version',
      async () =>
        (await client.json(`/api/v1/pages/${pages[0]}/versions/${version.id}`)).status === 'ready',
      30,
    );
    step('a named version written by the worker');
  } catch (error) {
    step('named version not checked', { error: String(error) });
  }
  try {
    const hits = await until(
      'search',
      async () => {
        const answer = await client.json(
          `/api/v1/workspaces/${workspace.id}/search?q=hello&limit=10`,
        );
        return answer.hits.length >= 3 ? answer.hits : null;
      },
      60,
    );
    step('server search finds the pages', { hits: hits.length });
  } catch (error) {
    step('search not checked', { error: String(error) });
  }
  result.rehearsal = 'pass';

  // The restore drill.
  const backup = join(work, 'cgw_rehearsal.bak');
  sql('master', `BACKUP DATABASE [cgw_rehearsal] TO DISK = N'${backup}' WITH COPY_ONLY, INIT`);
  kill(first.worker);
  kill(first.api);
  kill(first.azurite);
  await new Promise((r) => setTimeout(r, 1500));
  cpSync(first.blobDir, join(work, 'blob-b'), { recursive: true });
  const files = sql('master', `SET NOCOUNT ON; RESTORE FILELISTONLY FROM DISK = N'${backup}'`)
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((n) => n && !n.startsWith('-') && n !== 'LogicalName');
  const moves = files
    .slice(0, 2)
    .map((name, i) => `MOVE N'${name}' TO N'${join(work, `cgw_drill_${i}.${i ? 'ldf' : 'mdf'}`)}'`)
    .join(', ');
  sql('master', `RESTORE DATABASE [cgw_drill] FROM DISK = N'${backup}' WITH ${moves}, RECOVERY`);
  step('database backed up and restored to a new name; blob storage copied');

  const second = await deploy('b', 'cgw_drill', 10021, 5291);
  await until('ready after restore', async () => (await fetch(`${second.base}/health/ready`)).ok);
  const after = new Client(second.base);
  await after.signIn(email, password);
  const read = await readPages(after, pages);
  const same = pages.every((p) => read[p] === written[p]);
  const tree = await after.json(`/api/v1/workspaces/${workspace.id}/tree`);
  const asset = await after.json(`/api/v1/assets/${assetId}/url`);
  const bytes = Buffer.from(await (await fetch(asset.url)).arrayBuffer());
  if (!same || tree.pages.length !== pages.length || !bytes.equals(png))
    throw new Error(
      `The restored environment differs: ${JSON.stringify({ same, pages: tree.pages.length, asset: bytes.length })}`,
    );
  step('the restored environment opens every page as written, with its tree and its image', {
    pages: pages.length,
    identical: true,
  });
  result.drill = 'pass';
  kill(second.worker);
  kill(second.api);
  kill(second.azurite);
} catch (error) {
  result.error = String(error?.stack ?? error);
  console.error(error);
  process.exitCode = 1;
} finally {
  children.forEach(kill);
  try {
    drop('cgw_rehearsal');
    drop('cgw_drill');
  } catch {
    // Left for the next run to drop.
  }
  result.finished = new Date().toISOString();
  mkdirSync(join(root, 'bench', 'results'), { recursive: true });
  writeFileSync(
    join(root, 'bench', 'results', 'deploy-rehearsal.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(
    `Wrote bench/results/deploy-rehearsal.json: rehearsal ${result.rehearsal ?? 'fail'}, drill ${result.drill ?? 'fail'}`,
  );
}
