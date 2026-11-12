// Writes the third-party notices the app and the installers ship: every Rust crate built into the
// desktop app on Windows and on macOS, every npm package in the web bundle, and what @cashgear/ui
// vendors, each with its licence, followed by the licence texts their packages carry. Adapted
// from cashgear-sheet.
//   node scripts/third-party-notices.mjs [output]   (default apps/web/dist/third-party-notices.txt)
// pnpm build runs it after the web build.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pnpmCommand, root } from './lib.mjs';

const output = process.argv[2] ?? join(root, 'apps/web/dist/third-party-notices.txt');
const licenceFile = /^(licen[cs]e|copying|notice|copyright|ofl|third-party-notices)([-._].*)?$/i;

function licenceTexts(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => licenceFile.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8').trim() }));
}

// Rust: the normal dependencies of what ships, for the platform it ships on.
function crates(roots, platform) {
  const result = spawnSync(
    'cargo',
    ['metadata', '--format-version', '1', '--locked', '--filter-platform', platform],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error('cargo metadata failed: ' + result.stderr);
  const metadata = JSON.parse(result.stdout);
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const seen = new Set();
  const queue = metadata.packages.filter((pkg) => roots.includes(pkg.name)).map((pkg) => pkg.id);
  while (queue.length) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((kind) => kind.kind === null)) queue.push(dep.pkg);
    }
  }
  return [...seen]
    .map((id) => packages.get(id))
    .filter((pkg) => pkg.source)
    .map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      licence: pkg.license ?? pkg.license_file ?? 'see its files',
      home: pkg.repository ?? pkg.homepage ?? '',
      texts: licenceTexts(dirname(pkg.manifest_path)),
    }));
}

// The same notices ship with every build: Windows' crates, and the macOS universal app's, which
// holds both Apple targets.
const rust = new Map();
for (const platform of ['x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-apple-darwin']) {
  for (const pkg of crates(['cgw-desktop'], platform)) rust.set(`${pkg.name} ${pkg.version}`, pkg);
}

// npm: what the web bundle ships.
const [command, args] = pnpmCommand(['-r', '--prod', 'licenses', 'list', '--json']);
const listed = spawnSync(command, args, {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
if (listed.status !== 0) throw new Error('pnpm licenses list failed: ' + listed.stderr);
const npm = Object.values(JSON.parse(listed.stdout))
  .flat()
  .filter((pkg) => !pkg.name.startsWith('@cgw/') && pkg.name !== '@cashgear/ui')
  .map((pkg) => ({
    name: pkg.name,
    version: pkg.versions.join(', '),
    licence: pkg.license,
    home: pkg.homepage ?? '',
    texts: licenceTexts(pkg.paths[0]),
  }));

// @cashgear/ui is first party, but carries others' work in its vendor folder.
const library = realpathSync(join(root, 'apps/web/node_modules/@cashgear/ui'));
const vendorDir = join(library, 'src/vendor');
const vendored = (existsSync(vendorDir) ? readdirSync(vendorDir) : []).map((dir) => {
  const path = join(vendorDir, dir);
  const read = (name) =>
    existsSync(join(path, name)) ? JSON.parse(readFileSync(join(path, name), 'utf8')) : {};
  const pkg = read('package.json');
  const integrity = read('integrity-manifest.json');
  const texts = licenceTexts(path);
  const firstLine = texts.find((text) => /^licen/i.test(text.name))?.text.split('\n')[0] ?? '';
  return {
    name: pkg.name ?? integrity.package ?? dir,
    version: pkg.version ?? integrity.version ?? '',
    licence:
      pkg.license ??
      (/^MIT/.test(firstLine) ? 'MIT' : texts.length ? 'see below' : 'see its files'),
    home: pkg.homepage ?? integrity.licenseSource ?? '',
    texts,
  };
});

const line = (pkg) =>
  `  ${[pkg.name, pkg.version].filter(Boolean).join(' ')}: ${pkg.licence}${pkg.home ? `  <${pkg.home}>` : ''}`;
const sorted = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name));
const sections = [
  'Cash Gear Workspace: third-party notices',
  '',
  'Cash Gear Workspace is built with the open-source software below. Each is listed with its',
  'licence; the licence texts and notices its authors ship follow.',
  '',
  `Rust crates (${rust.size}):`,
  ...sorted(rust.values()).map(line),
  '',
  `JavaScript packages (${npm.length}):`,
  ...sorted(npm).map(line),
  '',
  `Inside the CashGear UI library (${vendored.length}):`,
  ...sorted(vendored).map(line),
  '',
  '',
  'Licence texts and notices',
  '=========================',
];
// Many packages ship the same text: each text appears once, headed by every package that ships it.
const texts = new Map();
for (const pkg of [...sorted(rust.values()), ...sorted(npm), ...sorted(vendored)]) {
  for (const text of pkg.texts) {
    const label = `${[pkg.name, pkg.version].filter(Boolean).join(' ')} (${text.name})`;
    texts.set(text.text, [...(texts.get(text.text) ?? []), label]);
  }
}
for (const [text, labels] of texts) sections.push('', `--- ${labels.join(', ')} ---`, '', text);
writeFileSync(output, sections.join('\n') + '\n');
console.log(
  `Third-party notices: ${rust.size} crates, ${npm.length} npm packages, ${vendored.length} ` +
    `vendored, ${texts.size} licence texts -> ${output}`,
);
