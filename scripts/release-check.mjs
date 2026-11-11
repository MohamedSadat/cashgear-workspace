// Checks a release before it is built (pnpm release:check; the release workflow runs it on a
// version tag), as Sheet does:
//   - one version everywhere: the package.json files, the Cargo workspace, tauri.conf.json, the
//     tag (GITHUB_REF_NAME, when set), and a CHANGELOG.md section for it;
//   - which release settings are present. Without the updater's key the workflow builds and
//     tests the release but does not draft it. Without Azure Artifact Signing it signs with a
//     throwaway certificate and says so in the notes.
// Prints the version, and writes `version`, `notes` (the changelog section, as a file),
// `complete` and `signed` to GITHUB_OUTPUT when it is set.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

const problems = [];
const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const version = json('package.json').version;
const versions = { 'package.json': version };
for (const group of ['apps', 'packages', 'bench']) {
  for (const name of readdirSync(join(root, group))) {
    const path = `${group}/${name}/package.json`;
    if (existsSync(join(root, path))) versions[path] = json(path).version;
  }
}
versions['apps/desktop/src-tauri/tauri.conf.json'] = json(
  'apps/desktop/src-tauri/tauri.conf.json',
).version;
versions['Cargo.toml'] = readFileSync(join(root, 'Cargo.toml'), 'utf8').match(
  /\[workspace\.package\][^[]*?version\s*=\s*"([^"]+)"/,
)?.[1];
for (const [path, found] of Object.entries(versions)) {
  if (found !== version) problems.push(`${path} is version ${found}, not ${version}.`);
}
// A run on a branch (workflow_dispatch) has no tag to check.
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null;
if (tag && tag !== `v${version}`) problems.push(`The tag ${tag} is not v${version}.`);

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const section = changelog.match(
  new RegExp(
    `^## \\[?${version.replace(/\./g, '\\.')}\\]?[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
    'm',
  ),
)?.[1];
if (!section?.trim()) problems.push(`CHANGELOG.md has no section for ${version}.`);

const env = process.env;
const updater = !!env.TAURI_SIGNING_PRIVATE_KEY;
const signed = !!(env.CGW_SIGN_ENDPOINT && env.CGW_SIGN_ACCOUNT && env.CGW_SIGN_PROFILE);

if (problems.length) {
  console.error('The release is not ready:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`Release ${version}: versions agree, and the changelog has its notes.`);
console.log(
  updater
    ? "The updater's key is set: the release is drafted, with latest.json."
    : "The updater's key (TAURI_SIGNING_PRIVATE_KEY) is missing: the release is built and tested, not drafted.",
);
console.log(
  signed
    ? 'Azure Artifact Signing is set up.'
    : 'Azure Artifact Signing (CGW_SIGN_ENDPOINT, CGW_SIGN_ACCOUNT, CGW_SIGN_PROFILE) is not set up: a throwaway certificate signs it.',
);
if (env.GITHUB_OUTPUT) {
  mkdirSync(join(root, 'target'), { recursive: true });
  const notes = join(root, 'target/release-notes.md');
  const signing = signed
    ? ''
    : '> This build is signed with a throwaway test certificate, so Windows SmartScreen warns ' +
      'before it installs. Installed copies update themselves from here.\n\n';
  writeFileSync(notes, signing + section.trim() + '\n');
  appendFileSync(
    env.GITHUB_OUTPUT,
    `version=${version}\nnotes=${notes}\ncomplete=${updater}\nsigned=${signed}\n`,
  );
}
