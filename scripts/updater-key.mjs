// Makes the updater's key pair (Phase 1, done once): the private key and a random password go
// straight from the Tauri CLI into the repository's secrets, TAURI_SIGNING_PRIVATE_KEY and
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD, through `gh secret set`'s standard input. Neither is
// written to disk or printed. The public key goes into tauri.conf.json, where installed apps
// read it to check each update.
//
// Replacing the key strands every installed copy (they trust only the old key), so the script
// refuses when the secret exists, unless --replace is given.
//   node scripts/updater-key.mjs [--replace]
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

const repository = process.env.GITHUB_REPOSITORY ?? 'MohamedSadat/cashgear-workspace';
const gh = (args, input) =>
  execFileSync('gh', [...args, '--repo', repository], {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });

const existing = JSON.parse(gh(['secret', 'list', '--json', 'name'])).map((s) => s.name);
if (existing.includes('TAURI_SIGNING_PRIVATE_KEY') && !process.argv.includes('--replace')) {
  throw new Error(
    'TAURI_SIGNING_PRIVATE_KEY is already set. Replacing it strands installed apps: pass --replace if that is meant.',
  );
}

const password = randomBytes(24).toString('hex');
const cli = join(root, 'apps/desktop/node_modules/@tauri-apps/cli/tauri.js');
let printed;
try {
  printed = execFileSync(
    process.execPath,
    [cli, 'signer', 'generate', '--ci', `--password=${password}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (error) {
  // The error's message holds the command line, and so the password: report only what failed.
  // eslint-disable-next-line preserve-caught-error -- the cause would print the password
  throw new Error(`tauri signer generate failed (${error.status}): ${error.stderr}`);
}
// Both keys are base64 of a minisign text, which says which half it is.
const keys = (printed.match(/[A-Za-z0-9+/=]{80,}/g) ?? []).map((key) => ({
  key,
  text: Buffer.from(key, 'base64').toString('utf8'),
}));
const secret = keys.find((k) => /secret key/.test(k.text))?.key;
const pub = keys.find((k) => /public key/.test(k.text))?.key;
if (!secret || !pub) throw new Error('The Tauri CLI did not print a key pair it could read.');

gh(['secret', 'set', 'TAURI_SIGNING_PRIVATE_KEY'], secret);
gh(['secret', 'set', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'], password);
const now = JSON.parse(gh(['secret', 'list', '--json', 'name'])).map((s) => s.name);
for (const name of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']) {
  if (!now.includes(name)) throw new Error(`${name} is not in the repository's secrets.`);
}

const configPath = join(root, 'apps/desktop/src-tauri/tauri.conf.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
config.plugins = config.plugins ?? {};
config.plugins.updater = { ...config.plugins.updater, pubkey: pub };
writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
console.log(
  `The updater's private key and its password are in ${repository}'s secrets; the public key is in tauri.conf.json.`,
);
