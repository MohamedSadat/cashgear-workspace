// The server's deploy package (M2.8; docs/OPERATIONS.md): the API for IIS, the worker as a
// Windows service with its Yjs library, the database migrations as a bundle and as an idempotent
// SQL script, the install scripts, and a manifest; zipped as target/deploy/cgw-server-<version>.zip.
// Nothing in it holds a secret: configuration comes from the host's environment.
//   node scripts/server-publish.mjs [--out <folder>] [--runtime win-x64]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const runtime = arg('--runtime', 'win-x64');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const out = arg('--out', join(root, 'target', 'deploy', `cgw-server-${version}`));

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

run('cargo', ['build', '-p', 'cgw-ydoc', '--profile', 'ffi']);
const library = runtime.startsWith('win') ? 'cgw_ydoc.dll' : 'libcgw_ydoc.so';
for (const [project, folder] of [
  ['Cgw.Api', 'api'],
  ['Cgw.Worker', 'worker'],
]) {
  run('dotnet', [
    'publish',
    `server/src/${project}/${project}.csproj`,
    '-c',
    'Release',
    '-r',
    runtime,
    '--self-contained',
    'false',
    '-o',
    join(out, folder),
    '-nologo',
    '-v',
    'q',
  ]);
}
cpSync(join(root, 'target', 'ffi', library), join(out, 'worker', library));
// The API process loads no Yjs library (D14): its folder must not hold one.
if (existsSync(join(out, 'api', library)) || existsSync(join(out, 'api', 'Cgw.Ydoc.dll')))
  throw new Error('The API package holds the Yjs library');

mkdirSync(join(out, 'migrate'), { recursive: true });
run('dotnet', ['tool', 'restore']);
const ef = ['ef', '--project', 'server/src/Cgw.Core', '--startup-project', 'server/src/Cgw.Core'];
run('dotnet', [
  ...ef.slice(0, 1),
  'migrations',
  'bundle',
  ...ef.slice(1),
  '-r',
  runtime,
  '--self-contained',
  '-o',
  join(out, 'migrate', runtime.startsWith('win') ? 'efbundle.exe' : 'efbundle'),
  '--force',
]);
run('dotnet', [
  ...ef.slice(0, 1),
  'migrations',
  'script',
  ...ef.slice(1),
  '--idempotent',
  '-o',
  join(out, 'migrate', 'migrations.sql'),
]);

cpSync(join(root, 'deploy'), join(out, 'deploy'), { recursive: true });
const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).stdout.trim();
writeFileSync(
  join(out, 'manifest.json'),
  JSON.stringify(
    {
      product: 'Cash Gear Workspace server',
      version,
      commit,
      runtime,
      built: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
);

const zip = `${out}.zip`;
rmSync(zip, { force: true });
if (process.platform === 'win32')
  run('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${out}\\*' -DestinationPath '${zip}'`,
  ]);
else run('zip', ['-qr', zip, '.'], { cwd: out });
console.log(`Deploy package: ${zip}`);
