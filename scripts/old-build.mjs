// The released web apps that tests/e2e/old-build.spec.ts runs beside this build: v0.2.0 (Phase 3's
// "an old build against a migrated document") and v0.3.0 (Phase 4's: a schema-3 page and a
// database met by the release before them). Each is the web build of its tag: the same document
// code (@cgw/doc at that release's schema version, its gate and its sync engine) as that release's
// desktop app, which embeds this very build.
//   node scripts/old-build.mjs                 every tag's tree into target/old-build/<tag>,
//                                              installed from its own lockfile, and its web app
//                                              built (apps/web/dist)
//   node scripts/old-build.mjs --tag v0.3.0    one of them
//   node scripts/old-build.mjs --serve [--tag v0.3.0]
//                                              that build (v0.2.0 unless named) on its port
//                                              (the tag's own `vite preview`, so under its own
//                                              Content Security Policy): v0.2.0 on 4279, v0.3.0
//                                              on 4278
// The API a build talks to is fixed at build time: VITE_CGW_API, 127.0.0.1:5280 (the e2e stack,
// which allows both origins) unless set.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './lib.mjs';

/** The releases, oldest first, and the port each is served on. */
export const OLD_BUILDS = {
  'v0.2.0': { port: 4279 },
  'v0.3.0': { port: 4278 },
};
export const OLD_TAG = 'v0.2.0';
export const originOf = (tag = OLD_TAG) => `http://127.0.0.1:${OLD_BUILDS[tag].port}`;
export const OLD_PORT = OLD_BUILDS[OLD_TAG].port;
export const OLD_ORIGIN = originOf(OLD_TAG);
export const treeOf = (tag = OLD_TAG) => join(root, 'target/old-build', tag);
const markerOf = (tag) => join(treeOf(tag), 'old-build.json');

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const sh = (command, args, options = {}) => {
  const ran = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32' && command === pnpm,
    ...options,
  });
  if (ran.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${ran.status})`);
};

/** What the last build of a tag made, or null when there is none. */
export function oldBuild(tag = OLD_TAG) {
  const marker = markerOf(tag);
  if (!existsSync(marker) || !existsSync(join(treeOf(tag), 'apps/web/dist/index.html')))
    return null;
  const made = JSON.parse(readFileSync(marker, 'utf8'));
  return made.tag === tag ? made : null;
}

function build(tag) {
  const tree = treeOf(tag);
  const commit = spawnSync('git', ['rev-parse', `${tag}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim();
  if (!commit) throw new Error(`No tag ${tag} in this clone (fetch the tags).`);
  rmSync(tree, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  mkdirSync(tree, { recursive: true });
  // Unpacked from inside the folder, by relative names: GNU tar reads "D:" as a host name.
  sh('git', ['archive', '--format=tar', '-o', join(tree, 'tree.tar'), tag], { cwd: root });
  sh('tar', ['-xf', 'tree.tar'], { cwd: tree });
  rmSync(join(tree, 'tree.tar'));
  // The web app and what it is built from, from the tag's own lockfile.
  sh(pnpm, ['install', '--frozen-lockfile', '--filter', '@cgw/web...'], {
    cwd: tree,
    env: { ...process.env, CI: 'true' },
  });
  sh(pnpm, ['--filter', '@cgw/web', 'build'], {
    cwd: tree,
    env: { ...process.env, VITE_CGW_API: process.env.VITE_CGW_API ?? 'http://127.0.0.1:5280' },
  });
  const schema = readFileSync(join(tree, 'packages/doc/src/schema.ts'), 'utf8').match(
    /SCHEMA_VERSION\s*=\s*(\d+)/,
  );
  const made = {
    tag,
    commit,
    schemaVersion: schema ? Number(schema[1]) : null,
    api: process.env.VITE_CGW_API ?? 'http://127.0.0.1:5280',
    builtAt: new Date().toISOString(),
  };
  writeFileSync(markerOf(tag), JSON.stringify(made, null, 2) + '\n');
  console.log(`The ${tag} web app is built in ${join(tree, 'apps/web/dist')}`, made);
}

/** Starts a tag's preview server; resolves once it answers (null when one already answers). */
export async function serveOldBuild(tag = OLD_TAG) {
  if (!oldBuild(tag)) throw new Error(`No ${tag} build: run node scripts/old-build.mjs first.`);
  const origin = originOf(tag);
  try {
    if ((await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok) return null;
  } catch {
    // Not running: start it.
  }
  const web = join(treeOf(tag), 'apps/web');
  const child = spawn(
    process.execPath,
    [
      join(web, 'node_modules/vite/bin/vite.js'),
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(OLD_BUILDS[tag].port),
      '--strictPort',
    ],
    { cwd: web, stdio: 'ignore' },
  );
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok) return child;
    } catch {
      // Not yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`The ${tag} build did not answer on ${origin}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--tag');
  const named = at > 0 ? process.argv[at + 1] : null;
  if (named && !OLD_BUILDS[named])
    throw new Error(`Unknown tag ${named}: ${Object.keys(OLD_BUILDS).join(', ')}`);
  if (process.argv.includes('--serve')) {
    const tag = named ?? OLD_TAG;
    const child = await serveOldBuild(tag);
    console.log(`The ${tag} web app on ${originOf(tag)}${child ? '' : ' (already running)'}`);
    if (child) process.on('SIGINT', () => process.exit(0));
  } else for (const tag of named ? [named] : Object.keys(OLD_BUILDS)) build(tag);
}
