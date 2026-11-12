// The macOS half of a release's files (.github/workflows/release.yml), beside the Windows half
// that scripts/release-assets.mjs gathers:
//   node scripts/macos-release-assets.mjs <folder>
//     From target/macos/build.json (scripts/macos-build.mjs, with the updater's key):
//       Cash-Gear-Workspace_<version>_universal.dmg
//       Cash-Gear-Workspace_<version>_universal.app.tar.gz and its .sig   the update
//       latest.darwin.json   the feed's macOS entries: darwin-aarch64 and darwin-x86_64, both the
//                            universal update (the updater looks for {os}-{arch})
//   node scripts/macos-release-assets.mjs --merge <folder> [notes file]
//     Folds the folder's latest.darwin.json into its latest.json (the Windows half's), with the
//     release notes, so that one feed serves both; latest.darwin.json goes.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

const args = process.argv.slice(2);
const merge = args[0] === '--merge';
const out = merge ? args[1] : args[0];
if (!out)
  throw new Error(
    'Usage: node scripts/macos-release-assets.mjs <folder> | --merge <folder> [notes file]',
  );
const repository = process.env.GITHUB_REPOSITORY ?? 'MohamedSadat/cashgear-workspace';

if (merge) {
  const feed = join(out, 'latest.json');
  const darwin = join(out, 'latest.darwin.json');
  for (const file of [feed, darwin]) if (!existsSync(file)) throw new Error(`${file} is missing.`);
  const latest = JSON.parse(readFileSync(feed, 'utf8'));
  const mac = JSON.parse(readFileSync(darwin, 'utf8'));
  if (mac.version !== latest.version)
    throw new Error(`The macOS build is ${mac.version}, the Windows build ${latest.version}.`);
  latest.platforms = { ...latest.platforms, ...mac.platforms };
  if (args[2]) latest.notes = readFileSync(args[2], 'utf8').trim();
  writeFileSync(feed, JSON.stringify(latest, null, 2));
  rmSync(darwin);
  console.log(`latest.json serves ${Object.keys(latest.platforms).join(', ')}`);
} else {
  const build = JSON.parse(readFileSync(join(root, 'target/macos/build.json'), 'utf8'));
  if (build.target !== 'universal-apple-darwin')
    throw new Error('The release is the universal build.');
  if (!build.update)
    throw new Error(
      "The build made no update: build with the updater's key (TAURI_SIGNING_PRIVATE_KEY).",
    );
  mkdirSync(out, { recursive: true });
  // GitHub swaps spaces in asset names for dots: the release names its files plainly.
  const base = `Cash-Gear-Workspace_${build.version}_universal`;
  copyFileSync(build.dmg, join(out, `${base}.dmg`));
  copyFileSync(build.update.tarball, join(out, `${base}.app.tar.gz`));
  copyFileSync(build.update.tarball + '.sig', join(out, `${base}.app.tar.gz.sig`));
  const url = `https://github.com/${repository}/releases/download/v${build.version}/${base}.app.tar.gz`;
  const entry = { signature: build.update.signature, url };
  writeFileSync(
    join(out, 'latest.darwin.json'),
    JSON.stringify(
      {
        version: build.version,
        signing: build.signing,
        platforms: { 'darwin-aarch64': entry, 'darwin-x86_64': entry },
      },
      null,
      2,
    ),
  );
  console.log(`macOS release ${build.version} files (${build.signing}) are in ${out}`);
}
