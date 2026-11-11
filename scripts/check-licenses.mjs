// npm half of the license gate (cargo-deny covers Rust). Fails when a shipped
// package is not under an allowed license or any package is under a denied one.
//   pnpm licenses:check                  check this workspace
//   node scripts/check-licenses.mjs --listing <file>   check a saved listing (self-test)
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkListings } from './license-policy.mjs';
import { pnpmCommand, root } from './lib.mjs';

const policy = JSON.parse(await readFile(join(root, 'license-policy.json'), 'utf8'));

function list(args) {
  const [command, commandArgs] = pnpmCommand(['-r', ...args, 'licenses', 'list', '--json']);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('pnpm licenses list failed: ' + result.stderr);
  return JSON.parse(result.stdout);
}

const listingArg = process.argv.indexOf('--listing');
let listings;
if (listingArg > 0) {
  const listing = JSON.parse(await readFile(process.argv[listingArg + 1], 'utf8'));
  listings = { shipped: listing, all: listing };
} else {
  listings = { shipped: list(['--prod']), all: list([]) };
}
const violations = checkListings(listings, policy);
const count = Object.values(listings.all).reduce((sum, packages) => sum + packages.length, 0);
if (violations.length) {
  console.error('npm license check failed:\n  ' + violations.join('\n  '));
  process.exit(1);
}
console.log('npm license check passed for ' + count + ' packages.');
