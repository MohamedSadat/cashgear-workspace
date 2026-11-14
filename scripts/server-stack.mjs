// The server as a local stack, for development and the end-to-end tests: Azurite for Blob
// Storage, the API on http://127.0.0.1:5280 and the worker, against a SQL Server database
// (LocalDB unless CGW_DEV_SQL names a server). Migrations run at the API's start, which only
// development does; a real deployment runs the migration bundle (docs/OPERATIONS.md).
//   pnpm dev:server                 the development stack: database cgw_dev, data in .cgw-dev
//   node scripts/server-stack.mjs --e2e   a fresh database cgw_e2e, data and mail in .cgw-dev/e2e
// (outside Playwright's test-results, which it empties when a run starts, a reused stack too)
// Mail is written to a pickup folder, never sent. Ctrl+C stops all three.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { basename, join } from 'node:path';
import { root } from './lib.mjs';

const e2e = process.argv.includes('--e2e');
const port = Number(process.env.CGW_API_PORT ?? 5280);
const blobPort = Number(process.env.CGW_BLOB_PORT ?? 10000);
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
  'http://tauri.localhost',
  'tauri://localhost',
  // The old web builds that tests/e2e/old-build.spec.ts serves (scripts/old-build.mjs): v0.2.0,
  // v0.3.0, v0.4.0 and v0.5.0.
  'http://127.0.0.1:4279',
  'http://127.0.0.1:4278',
  'http://127.0.0.1:4277',
  'http://127.0.0.1:4276',
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
for (const project of ['Cgw.Api', 'Cgw.Worker'])
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
  // Plain http on 127.0.0.1: OpenIddict answers it, and the cookies are Secure on https only.
  Api__AllowHttp: 'true',
  Web__AppUrl: web,
  Ydoc__Library: ydoc,
  Logging__LogLevel__Default: 'Warning',
  Logging__LogLevel__Microsoft: 'Warning',
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
      }
    : {}),
};
const bin = (project) => join(run, project, `${project}.dll`);
start('api', 'dotnet', [bin('Cgw.Api'), '--urls', `http://127.0.0.1:${port}`], {
  ...env,
  Database__MigrateOnStart: 'true',
});
await waitFor(
  async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health/live`)).ok;
    } catch {
      return false;
    }
  },
  'The API',
  180,
);
start('worker', 'dotnet', [bin('Cgw.Worker')], env);
console.log(`Server stack ready: API http://127.0.0.1:${port}, Blob ${blobPort}, mail in ${mail}`);
