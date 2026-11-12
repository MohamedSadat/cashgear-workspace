// The v0.2.0 web app, for tests/e2e/old-build.spec.ts (Phase 3's "an old build against a migrated
// document"). It is the web build of the tag: the same document code (@cgw/doc at schema version
// 1, its gate and its sync engine) as the v0.2.0 desktop app, which embeds this very build.
//   node scripts/old-build.mjs           the tag's tree into target/old-build, installed from its
//                                        own lockfile, and its web app built (apps/web/dist)
//   node scripts/old-build.mjs --serve   that build on http://127.0.0.1:4279 (the tag's own
//                                        `vite preview`, so under its own Content Security Policy)
// The API it talks to is fixed at build time: VITE_CGW_API, 127.0.0.1:5280 (the e2e stack, which
// allows the origin http://127.0.0.1:4279) unless set.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './lib.mjs';

export const OLD_TAG = 'v0.2.0';
export const OLD_PORT = 4279;
export const OLD_ORIGIN = `http://127.0.0.1:${OLD_PORT}`;
export const oldTree = join(root, 'target/old-build');
const marker = join(oldTree, 'old-build.json');

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const sh = (command, args, options = {}) => {
  const ran = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32' && command === pnpm,
    ...options,
  });
  if (ran.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${ran.status})`);
};

/** What the last build made, or null when there is none for the tag. */
export function oldBuild() {
  if (!existsSync(marker) || !existsSync(join(oldTree, 'apps/web/dist/index.html'))) return null;
  const made = JSON.parse(readFileSync(marker, 'utf8'));
  return made.tag === OLD_TAG ? made : null;
}

function build() {
  const commit = spawnSync('git', ['rev-parse', `${OLD_TAG}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim();
  if (!commit) throw new Error(`No tag ${OLD_TAG} in this clone (fetch the tags).`);
  rmSync(oldTree, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  mkdirSync(oldTree, { recursive: true });
  // Unpacked from inside the folder, by relative names: GNU tar reads "D:" as a host name.
  sh('git', ['archive', '--format=tar', '-o', join(oldTree, 'tree.tar'), OLD_TAG], { cwd: root });
  sh('tar', ['-xf', 'tree.tar'], { cwd: oldTree });
  rmSync(join(oldTree, 'tree.tar'));
  // The web app and what it is built from, from the tag's own lockfile.
  sh(pnpm, ['install', '--frozen-lockfile', '--filter', '@cgw/web...'], {
    cwd: oldTree,
    env: { ...process.env, CI: 'true' },
  });
  sh(pnpm, ['--filter', '@cgw/web', 'build'], {
    cwd: oldTree,
    env: { ...process.env, VITE_CGW_API: process.env.VITE_CGW_API ?? 'http://127.0.0.1:5280' },
  });
  const schema = readFileSync(join(oldTree, 'packages/doc/src/schema.ts'), 'utf8').match(
    /SCHEMA_VERSION\s*=\s*(\d+)/,
  );
  const made = {
    tag: OLD_TAG,
    commit,
    schemaVersion: schema ? Number(schema[1]) : null,
    api: process.env.VITE_CGW_API ?? 'http://127.0.0.1:5280',
    builtAt: new Date().toISOString(),
  };
  writeFileSync(marker, JSON.stringify(made, null, 2) + '\n');
  console.log(`The ${OLD_TAG} web app is built in ${join(oldTree, 'apps/web/dist')}`, made);
}

/** Starts the old build's preview server; resolves once it answers. */
export async function serveOldBuild() {
  if (!oldBuild()) throw new Error('No old build: run node scripts/old-build.mjs first.');
  try {
    if ((await fetch(OLD_ORIGIN, { signal: AbortSignal.timeout(1000) })).ok) return null;
  } catch {
    // Not running: start it.
  }
  const web = join(oldTree, 'apps/web');
  const child = spawn(
    process.execPath,
    [
      join(web, 'node_modules/vite/bin/vite.js'),
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(OLD_PORT),
      '--strictPort',
    ],
    { cwd: web, stdio: 'ignore' },
  );
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(OLD_ORIGIN, { signal: AbortSignal.timeout(1000) })).ok) return child;
    } catch {
      // Not yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`The old build did not answer on ${OLD_ORIGIN}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--serve')) {
    const child = await serveOldBuild();
    console.log(`The ${OLD_TAG} web app on ${OLD_ORIGIN}${child ? '' : ' (already running)'}`);
    if (child) process.on('SIGINT', () => process.exit(0));
  } else build();
}
