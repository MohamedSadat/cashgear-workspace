// The server as a local stack, for development and the end-to-end tests: Azurite for Blob
// Storage, the API on http://127.0.0.1:5280, the worker, and (Phase 9) the Sites process on
// http://localhost:5290 (CGW_SITES_PORT; `localhost`, not 127.0.0.1: cookies are per host, so the
// published sites' host must differ from the API's and the web app's), and (Phase 10) its second
// host, the plugins origin, on http://localhost:5291 (CGW_PLUGINS_PORT), against a SQL Server database
// (LocalDB unless CGW_DEV_SQL names a server). Migrations run at the API's start, which only
// development does; a real deployment runs the migration bundle (docs/OPERATIONS.md).
//   pnpm dev:server                 the development stack: database cgw_dev, data in .cgw-dev
//   node scripts/server-stack.mjs --e2e   a fresh database cgw_e2e, data and mail in .cgw-dev/e2e
// (outside Playwright's test-results, which it empties when a run starts, a reused stack too)
// Mail is written to a pickup folder, never sent. Ctrl+C stops all three.
// With --e2e only, a control port on 127.0.0.1:5289 (CGW_STACK_CONTROL_PORT) lets the Phase 6
// specs and bench/phase6.mjs recycle the API process while the worker keeps running
// (scripts/stack-control.mjs): GET /api (its pid), POST /api/restart (killed, started again,
// answered once its health answers). The development stack has no such port.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import { basename, join } from 'node:path';
import { root } from './lib.mjs';

const e2e = process.argv.includes('--e2e');
const port = Number(process.env.CGW_API_PORT ?? 5280);
const blobPort = Number(process.env.CGW_BLOB_PORT ?? 10000);
const sitesPort = Number(process.env.CGW_SITES_PORT ?? 5290);
const sitesUrl = `http://localhost:${sitesPort}`;
// Phase 10: third-party plugins' files, on an origin of their own (the Sites process's second host).
const pluginsPort = Number(process.env.CGW_PLUGINS_PORT ?? 5291);
const pluginsUrl = `http://localhost:${pluginsPort}`;
// Phase 10: embeddings go to the mock provider too (its `/v1/embeddings`), unless
// CGW_VOYAGE_BASE_URL names another (`https://api.voyageai.com` to try a real key).
const voyageUrl =
  process.env.CGW_VOYAGE_BASE_URL ?? `http://127.0.0.1:${process.env.CGW_MOCK_AI_PORT ?? 4286}`;
const data = join(root, e2e ? '.cgw-dev/e2e' : '.cgw-dev');
const mail = join(data, 'mail');
const database = e2e ? 'cgw_e2e' : 'cgw_dev';
const server =
  process.env.CGW_DEV_SQL ??
  'Server=(localdb)\\MSSQLLocalDB;Integrated Security=true;TrustServerCertificate=true';
const sql = `${server.replace(/;?$/, ';')}Database=${database}`;
const azuriteKey =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
const blob = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${azuriteKey};BlobEndpoint=http://127.0.0.1:${blobPort}/devstoreaccount1;`;
const web = e2e ? 'http://127.0.0.1:4273' : 'http://127.0.0.1:5273';
const origins = [
  'http://127.0.0.1:4273',
  'http://127.0.0.1:5273',
  'http://localhost:4273',
  'http://localhost:5273',
  // Phase 11: the app built against the API on `localhost`, for the passkey specs
  // (scripts/web-localhost.mjs): WebAuthn takes no IP address as its relying party.
  'http://localhost:4268',
  'http://tauri.localhost',
  'tauri://localhost',
  // The old web builds that tests/e2e/old-build.spec.ts serves (scripts/old-build.mjs): v0.2.0,
  // v0.3.0, v0.4.0, v0.5.0, v0.6.0, v0.7.0, v0.8.0, v0.9.0 and v0.10.0.
  'http://127.0.0.1:4279',
  'http://127.0.0.1:4278',
  'http://127.0.0.1:4277',
  'http://127.0.0.1:4276',
  'http://127.0.0.1:4275',
  'http://127.0.0.1:4274',
  'http://127.0.0.1:4272',
  'http://127.0.0.1:4271',
  'http://127.0.0.1:4270',
];

const children = [];
function stop() {
  for (const child of children) {
    if (child.exitCode === null) {
      if (process.platform === 'win32')
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else child.kill('SIGTERM');
    }
  }
}
process.on('SIGINT', () => {
  stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stop();
  process.exit(0);
});
process.on('exit', stop);

const open = (p) =>
  new Promise((resolve) => {
    const socket = net.connect(p, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

async function waitFor(check, what, seconds = 120) {
  for (let i = 0; i < seconds * 4; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} did not start`);
}

function start(name, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `[${name}] ${line}`)
      .join('\n') + '\n';
  child.stdout.on('data', (chunk) => process.stdout.write(prefix(chunk)));
  child.stderr.on('data', (chunk) => process.stderr.write(prefix(chunk)));
  child.on('exit', (code) => {
    if (code) console.error(`[${name}] exited with ${code}`);
  });
  children.push(child);
  return child;
}

if (e2e) {
  rmSync(data, { recursive: true, force: true });
  rmSync(mail, { recursive: true, force: true });
  // A fresh database each run: drop the last one.
  const drop = `IF DB_ID('${database}') IS NOT NULL BEGIN ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]; END`;
  const sqlcmd = process.env.CGW_DEV_SQL
    ? null
    : spawnSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-E', '-C', '-Q', drop], {
        encoding: 'utf8',
      });
  if (sqlcmd && sqlcmd.status !== 0)
    console.warn('Could not drop the last e2e database:', sqlcmd.stderr);
}
mkdirSync(join(data, 'azurite'), { recursive: true });
mkdirSync(mail, { recursive: true });

if (!(await open(blobPort))) {
  start('azurite', process.execPath, [
    join(root, 'node_modules/azurite/dist/src/blob/main.js'),
    '--blobHost',
    '127.0.0.1',
    '--blobPort',
    String(blobPort),
    '--location',
    join(data, 'azurite'),
    '--silent',
    '--skipApiVersionCheck',
    '--loose',
    '--disableTelemetry',
  ]);
  await waitFor(() => open(blobPort), 'Azurite');
}

const ffi = join(
  root,
  'target/ffi',
  process.platform === 'win32' ? 'cgw_ydoc.dll' : 'libcgw_ydoc.so',
);
if (!existsSync(ffi)) {
  const built = spawnSync('cargo', ['build', '-p', 'cgw-ydoc', '--profile', 'ffi'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (built.status !== 0) process.exit(1);
}
const build = spawnSync('dotnet', ['build', 'server/Cgw.Server.slnx', '-nologo', '-v', 'q'], {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(1);

// The stack runs from a copy of the build output, so a build while it runs (another session, a
// test run) is not blocked by the DLLs it holds open.
const run = join(data, 'run');
rmSync(run, { recursive: true, force: true });
for (const project of ['Cgw.Api', 'Cgw.Worker', 'Cgw.Sites'])
  cpSync(join(root, `server/src/${project}/bin/Debug/net10.0`), join(run, project), {
    recursive: true,
  });
const ydoc = join(run, basename(ffi));
cpSync(ffi, ydoc);

const env = {
  ASPNETCORE_ENVIRONMENT: 'Development',
  DOTNET_ENVIRONMENT: 'Development',
  ConnectionStrings__Sql: sql,
  Blob__ConnectionString: blob,
  Smtp__PickupDirectory: mail,
  Api__PublicUrl: `http://127.0.0.1:${port}`,
  // Phase 9: where the sites are, for the addresses the API gives out (SiteDto.url).
  Sites__PublicUrl: sitesUrl,
  // Phase 10: where plugin frames are, for the addresses the API gives out (the frames route).
  Plugins__PublicUrl: pluginsUrl,
  // Plain http on 127.0.0.1: OpenIddict answers it, and the cookies are Secure on https only.
  Api__AllowHttp: 'true',
  Web__AppUrl: web,
  Ydoc__Library: ydoc,
  Logging__LogLevel__Default: 'Warning',
  Logging__LogLevel__Microsoft: 'Warning',
  // Phase 7: AI goes to the mock provider (tests/mocks/ai, started by Playwright or by hand), never
  // to Anthropic, unless CGW_AI_BASE_URL names another (`https://api.anthropic.com` to try a real key).
  Ai__AnthropicBaseUrl:
    process.env.CGW_AI_BASE_URL ?? `http://127.0.0.1:${process.env.CGW_MOCK_AI_PORT ?? 4286}`,
  Ai__VoyageBaseUrl: voyageUrl,
  // Phase 11: a domain's TXT record is read from the mock provider's DNS stand-in (tests/mocks/oidc,
  // started by Playwright or by hand), never from real DNS, unless CGW_SSO_DNS_BASE_URL names another.
  Sso__DnsBaseUrl:
    process.env.CGW_SSO_DNS_BASE_URL ?? `http://127.0.0.1:${process.env.OIDC_MOCK_PORT ?? 4287}`,
  ...Object.fromEntries(origins.map((origin, i) => [`Web__Origins__${i}`, origin])),
  ...(e2e
    ? {
        // Tests sign up, sign in and push far faster than people do.
        RateLimits__signin: '10000',
        RateLimits__anonymous: '10000',
        RateLimits__user: '100000',
        RateLimits__push: '100000',
        // Phase 4: the specs and bench/phase4.mjs seed databases through the import route.
        RateLimits__import: '10000',
        // Phase 5: the specs open workbooks in the mock Sheet many times a minute.
        RateLimits__ticket: '10000',
        RateLimits__sheet: '100000',
        // Phase 6: every page open and reconnect takes a hub ticket.
        RateLimits__realtime: '10000',
        // Phase 7: the AI specs and bench/phase7.mjs complete many times a minute.
        RateLimits__ai: '10000',
        // Phase 8: mentions and replies are mailed once unread for 5 s, not 15 minutes, and a
        // person at most every 5 s (tests/e2e/mail.spec.ts reads them from the pickup folder).
        Mail__NotificationDelaySeconds: '5',
        // Phase 6: the hub's relay times for bench/phase6.mjs (GET /api/v1/realtime/metrics;
        // never mapped in Production).
        Realtime__Metrics: 'true',
        // Phase 10: pages are embedded once still for a second, not 30 (tests/e2e/meaning.spec.ts),
        // and the specs search by meaning and open plugin frames many times a minute.
        Ai__EmbeddingsSettleSeconds: '1',
        RateLimits__meaning: '10000',
        RateLimits__frames: '10000',
        // Phase 12: the specs and benches pin databases of thousands of rows, one batch pull of up to
        // 100 documents at a time, many a minute from one address.
        RateLimits__pull: '10000',
        // Phase 13: Cash Gear's subscription against the mock providers, its keys made here at start
        // and kept in memory only (each a fresh stand-in the mock records as a hash; never a real key),
        // with an allowance a month for every workspace; and the local model's stand-in package
        // (tests/fixtures/local-model, a test package the API refuses in Production).
        Ai__Subscription__AnthropicKey: `sk-mock-subscription-${randomUUID()}`,
        Ai__Subscription__VoyageKey: `pa-mock-subscription-${randomUUID()}`,
        Ai__Subscription__MonthlyTokens: '1000000',
        Ai__Subscription__EmbeddingsMonthlyTokens: '1000000',
        Ai__LocalModel__Path: join(root, 'tests', 'fixtures', 'local-model'),
        Ai__LocalModel__Threads: '1',
      }
    : {}),
};
const bin = (project) => join(run, project, `${project}.dll`);
const healthy = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health/live`)).ok;
  } catch {
    return false;
  }
};
let api = null;
let apiStarted = null;
function startApi() {
  api = start('api', 'dotnet', [bin('Cgw.Api'), '--urls', `http://127.0.0.1:${port}`], {
    ...env,
    Database__MigrateOnStart: 'true',
  });
  apiStarted = new Date().toISOString();
}
startApi();
await waitFor(healthy, 'The API', 180);
start('worker', 'dotnet', [bin('Cgw.Worker')], env);
// Phase 9: the Sites process, with the database and storage settings only (it has no sign-in,
// mail or session of the API's to be given). Phase 10: on two hosts, the sites' and the plugins'
// (frame tickets are found by their hash in the database; the Web origins are the frames' allowed
// ancestors).
start('sites', 'dotnet', [bin('Cgw.Sites'), '--urls', `${sitesUrl};${pluginsUrl}`], {
  ASPNETCORE_ENVIRONMENT: env.ASPNETCORE_ENVIRONMENT,
  DOTNET_ENVIRONMENT: env.DOTNET_ENVIRONMENT,
  ConnectionStrings__Sql: sql,
  Blob__ConnectionString: blob,
  Plugins__PublicUrl: pluginsUrl,
  ...Object.fromEntries(origins.map((origin, i) => [`Web__Origins__${i}`, origin])),
  Logging__LogLevel__Default: 'Warning',
  Logging__LogLevel__Microsoft: 'Warning',
});
await waitFor(
  async () => {
    try {
      return (await fetch(`${sitesUrl}/health/live`)).ok;
    } catch {
      return false;
    }
  },
  'The Sites process',
  120,
);

if (e2e) {
  // The control port (see the header): the API recycled as an app pool's worker process is, here
  // at once (the process ended, not drained), which is the harder case for the clients.
  const controlPort = Number(process.env.CGW_STACK_CONTROL_PORT ?? 5289);
  let restarting = null;
  async function restartApi() {
    const old = api;
    children.splice(children.indexOf(old), 1);
    const stoppedAt = Date.now();
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/pid', String(old.pid), '/T', '/F'], { windowsHide: true });
    else old.kill('SIGKILL');
    // The port is free once the old process is gone.
    for (let i = 0; i < 200 && (await open(port)); i++) await new Promise((r) => setTimeout(r, 50));
    const startedAt = Date.now();
    startApi();
    await waitFor(healthy, 'The API', 180);
    return { pid: api.pid, stoppedAt, startedAt, readyAt: Date.now() };
  }
  createServer(async (request, response) => {
    const answer = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method === 'GET' && request.url === '/api')
        return answer(200, { pid: api.pid, startedAt: apiStarted });
      if (request.method === 'POST' && request.url === '/api/restart') {
        restarting ??= restartApi().finally(() => (restarting = null));
        return answer(200, await restarting);
      }
      answer(404, { error: 'not found' });
    } catch (error) {
      answer(500, { error: String(error) });
    }
  }).listen(controlPort, '127.0.0.1');
  console.log(`Stack control on http://127.0.0.1:${controlPort} (e2e only)`);
}
console.log(
  `Server stack ready: API http://127.0.0.1:${port}, sites ${sitesUrl}, plugins ${pluginsUrl}, Blob ${blobPort}, mail in ${mail}`,
);
