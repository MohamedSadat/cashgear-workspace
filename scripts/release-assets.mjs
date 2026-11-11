// Gathers a release's files into a folder, after pnpm desktop:installer built the installer with
// the updater's key (the release workflow), as Sheet does:
//   Cash-Gear-Workspace_<version>_x64-setup.exe and its .sig
//   latest.json              the update feed the desktop app reads (tauri.conf.json)
//   third-party-notices.txt
//   node scripts/release-assets.mjs <folder> [notes file]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

const out = process.argv[2];
if (!out) throw new Error('Usage: node scripts/release-assets.mjs <folder> [notes file]');
const notes = process.argv[3] ? readFileSync(process.argv[3], 'utf8').trim() : '';
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const repository = process.env.GITHUB_REPOSITORY ?? 'MohamedSadat/cashgear-workspace';
mkdirSync(out, { recursive: true });

// GitHub swaps spaces in asset names for dots: the release names its files plainly.
const built = join(
  root,
  'target/release/bundle/nsis',
  `Cash Gear Workspace_${version}_x64-setup.exe`,
);
const setup = `Cash-Gear-Workspace_${version}_x64-setup.exe`;
if (!existsSync(built + '.sig')) {
  throw new Error(
    `${built}.sig is missing: build with the updater's key (TAURI_SIGNING_PRIVATE_KEY).`,
  );
}
copyFileSync(built, join(out, setup));
copyFileSync(built + '.sig', join(out, setup + '.sig'));
const signature = readFileSync(built + '.sig', 'utf8');
const url = `https://github.com/${repository}/releases/download/v${version}/${setup}`;
writeFileSync(
  join(out, 'latest.json'),
  JSON.stringify(
    {
      version,
      notes,
      pub_date: new Date().toISOString(),
      platforms: {
        'windows-x86_64': { signature, url },
        'windows-x86_64-nsis': { signature, url },
      },
    },
    null,
    2,
  ),
);
copyFileSync(
  join(root, 'apps/web/dist/third-party-notices.txt'),
  join(out, 'third-party-notices.txt'),
);
console.log(`Release ${version} files are in ${out}`);
