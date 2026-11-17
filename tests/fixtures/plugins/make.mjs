// Zips the plugin fixtures (tests/fixtures/plugins/<name>/) into bundles, for the specs, the bench
// and a try by hand in Settings → Plugins:
//   node tests/fixtures/plugins/make.mjs [folder]      (default target/plugin-fixtures)
// Writes reference.zip (the folder as it is, version 1) and reference-v2.zip (the same files,
// its manifest's version 2: an update). Nothing here is downloaded.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// fflate is the shell's dependency, not hoisted: loaded from there.
const { zipSync } = createRequire(join(here, '../../../packages/shell/package.json'))('fflate');

/** Every file under a folder, as a path relative to it with forward slashes. */
function filesUnder(root, folder = root) {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory()
      ? filesUnder(root, path)
      : [relative(root, path).split(sep).join('/')];
  });
}

/** A fixture's files as a bundle; `manifest` changes its manifest's fields. */
export function bundleOf(name, manifest = {}) {
  const root = join(here, name);
  const files = {};
  for (const path of filesUnder(root)) {
    let bytes = readFileSync(join(root, path));
    if (path === 'manifest.json' && Object.keys(manifest).length)
      bytes = Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString('utf8')), ...manifest }));
    files[path] = new Uint8Array(bytes);
  }
  return zipSync(files, { level: 6 });
}

/** The bundles the specs use, written to `folder`; their paths by name. */
export function writePluginBundles(folder = resolve('target/plugin-fixtures')) {
  mkdirSync(folder, { recursive: true });
  const made = {
    reference: join(folder, 'reference.zip'),
    referenceV2: join(folder, 'reference-v2.zip'),
    hostile: join(folder, 'hostile.zip'),
  };
  writeFileSync(made.reference, bundleOf('reference'));
  writeFileSync(made.referenceV2, bundleOf('reference', { version: 2 }));
  writeFileSync(made.hostile, bundleOf('hostile'));
  return made;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const made = writePluginBundles(resolve(process.argv[2] ?? 'target/plugin-fixtures'));
  for (const path of Object.values(made))
    console.log(`${path} (${statSync(path).size.toLocaleString()} bytes)`);
}
