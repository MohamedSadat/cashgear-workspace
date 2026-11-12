// Builds the macOS app with Tauri's bundler (Phase 3, M3.6): the .app and its DMG, and with the
// updater's key the update (the .app.tar.gz and its .sig) for latest.json. Runs on a Mac (GitHub's
// macOS runner), after pnpm build.
//
//   node scripts/macos-build.mjs [--host]
//     The release's universal app, for Apple silicon and Intel (--host: this Mac's architecture
//     only). Signed with a Developer ID when APPLE_CERTIFICATE (the .p12, in base64),
//     APPLE_CERTIFICATE_PASSWORD and APPLE_SIGNING_IDENTITY are all set, and notarised when the App
//     Store Connect API key is set too: APPLE_API_ISSUER, APPLE_API_KEY (the key's id, as Tauri's
//     bundler names it) and APPLE_API_KEY_P8 (the .p8 file's text, written to a file of the
//     runner's for the bundler while it runs, then removed). Without them it is ad-hoc signed,
//     which Gatekeeper warns about. With TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD) it also makes
//     the update. Writes target/macos/build.json (what scripts/macos-verify.mjs and
//     scripts/macos-release-assets.mjs read) and, under GitHub Actions, `signing` (notarised,
//     signed or ad-hoc) to GITHUB_OUTPUT.
//
// As a module, buildMac() makes the acceptance run's test builds (scripts/macos-acceptance.mjs):
// this Mac's architecture, ad-hoc signed, with the test-only bridge (cargo feature e2e-bridge),
// and without link-time optimisation, which saves minutes and changes nothing the run checks.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pnpmCommand, root, run } from './lib.mjs';

export const PRODUCT = 'Cash Gear Workspace';
const conf = JSON.parse(readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));

/** pnpm, from a script pnpm started or from the PATH (the workflows run node directly). */
const pnpm = (args) => (process.env.npm_execpath ? pnpmCommand(args) : ['pnpm', args]);

/** The CSP with more origins in connect-src (a test build against a deployed API). */
export function cspWith(origins) {
  const csp = conf.app.security.csp;
  return csp
    .split(';')
    .map((directive) => {
      const trimmed = directive.trim();
      if (!trimmed.startsWith('connect-src ')) return trimmed;
      const sources = trimmed.split(/\s+/);
      for (const origin of origins) if (!sources.includes(origin)) sources.push(origin);
      return sources.join(' ');
    })
    .join('; ');
}

/** How a build is signed, from what the environment holds. */
export function signingFrom(env) {
  const has = (name) => typeof env[name] === 'string' && env[name].trim() !== '';
  if (!['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY'].every(has))
    return 'ad-hoc';
  return ['APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_P8'].every(has)
    ? 'notarised'
    : 'signed';
}

const APPLE = [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_API_ISSUER',
  'APPLE_API_KEY',
  'APPLE_API_KEY_PATH',
  'APPLE_API_KEY_P8',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
];

const only = (dir, test) => {
  if (!existsSync(dir)) return null;
  const found = readdirSync(dir).filter(test);
  if (found.length > 1) throw new Error(`More than one build output in ${dir}: ${found}`);
  return found.length ? join(dir, found[0]) : null;
};

/**
 * Builds the app. Options:
 *   universal      both architectures (--target universal-apple-darwin), else this Mac's
 *   bridge         the test-only bridge (always ad-hoc signed)
 *   quick          no link-time optimisation (test builds)
 *   version        another version than tauri.conf.json's
 *   bundles        Tauri's bundle types, default app and dmg
 *   updaterUrl, updaterPubkey   another update feed and key (tests)
 *   apiBases       the API bases the native side may sign in to (CGW_API_BASES)
 *   connect        more origins for the CSP's connect-src
 *   env            the environment to build in
 * Returns { app, dmg, update, signing, version, target, seconds }.
 */
export async function buildMac(options = {}) {
  const {
    universal = false,
    bridge = false,
    quick = false,
    version = conf.version,
    bundles = ['app', 'dmg'],
    updaterUrl,
    updaterPubkey,
    apiBases,
    connect = [],
    env = process.env,
  } = options;
  if (process.platform !== 'darwin') throw new Error('The macOS build runs on a Mac.');
  const notices = join(root, 'apps/web/dist/third-party-notices.txt');
  if (!existsSync(join(root, 'apps/web/dist/index.html')) || !existsSync(notices))
    throw new Error('The web build is missing: run pnpm build first.');
  const started = Date.now();
  const work = join(root, 'target/macos');
  const licences = join(work, 'licences');
  rmSync(licences, { recursive: true, force: true });
  mkdirSync(licences, { recursive: true });
  copyFileSync(notices, join(licences, 'THIRD-PARTY-NOTICES.txt'));

  const signing = bridge ? 'ad-hoc' : signingFrom(env);
  const child = { ...env };
  for (const name of APPLE) delete child[name];
  if (signing !== 'ad-hoc') for (const name of APPLE.slice(0, 3)) child[name] = env[name];
  // A workflow passes an unset secret as an empty string: no updater key, then.
  if (!child.TAURI_SIGNING_PRIVATE_KEY) {
    delete child.TAURI_SIGNING_PRIVATE_KEY;
    delete child.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  }
  if (quick) {
    child.CARGO_PROFILE_RELEASE_LTO = 'false';
    child.CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '16';
    child.CARGO_PROFILE_RELEASE_INCREMENTAL = 'true';
  }
  if (apiBases) child.CGW_API_BASES = apiBases.join(',');
  let keyDir = null;
  if (signing === 'notarised') {
    // Tauri's bundler takes the key as a file only. It lives in the runner's temp folder for the
    // build and goes after it.
    keyDir = mkdtempSync(join(env.RUNNER_TEMP ?? tmpdir(), 'cgw-notary-'));
    child.APPLE_API_ISSUER = env.APPLE_API_ISSUER.trim();
    child.APPLE_API_KEY = env.APPLE_API_KEY.trim();
    child.APPLE_API_KEY_PATH = join(keyDir, `AuthKey_${child.APPLE_API_KEY}.p8`);
    writeFileSync(child.APPLE_API_KEY_PATH, readKey(env), { mode: 0o600 });
  }

  const config = {
    version,
    bundle: {
      resources: { [join(licences, '*')]: 'licences/' },
      createUpdaterArtifacts: !!child.TAURI_SIGNING_PRIVATE_KEY && bundles.includes('app'),
      // Ad-hoc ("-"), or the Developer ID that APPLE_SIGNING_IDENTITY names.
      macOS: { signingIdentity: signing === 'ad-hoc' ? '-' : null },
    },
    ...(connect.length ? { app: { security: { csp: cspWith(connect) } } } : {}),
    plugins: {
      updater: {
        ...(updaterPubkey ? { pubkey: updaterPubkey } : {}),
        ...(updaterUrl
          ? {
              endpoints: [updaterUrl],
              dangerousInsecureTransportProtocol: updaterUrl.startsWith('http:'),
            }
          : {}),
      },
    },
  };
  mkdirSync(work, { recursive: true });
  const configFile = join(work, 'tauri.macos-build.json');
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  const target = universal ? 'universal-apple-darwin' : null;
  const bundle = join(root, 'target', ...(target ? [target] : []), 'release/bundle');
  for (const kind of ['macos', 'dmg']) rmSync(join(bundle, kind), { recursive: true, force: true });

  const args = ['--filter', '@cgw/desktop', 'tauri', 'build', '--config', configFile];
  args.push('--bundles', bundles.join(','));
  if (target) args.push('--target', target);
  if (bridge) args.push('--features', 'e2e-bridge');
  console.log(
    `Building ${PRODUCT} ${version} for ${universal ? 'Apple silicon and Intel' : 'this Mac'}` +
      `${bridge ? ' with the test-only bridge' : ''}, ${signing}`,
  );
  try {
    await run(...pnpm(args), { env: child });
  } finally {
    if (keyDir) rmSync(keyDir, { recursive: true, force: true });
  }

  const app = only(join(bundle, 'macos'), (name) => name.endsWith('.app'));
  if (!app) throw new Error(`The build left no .app in ${join(bundle, 'macos')}.`);
  const dmg = only(join(bundle, 'dmg'), (name) => name.endsWith('.dmg'));
  if (bundles.includes('dmg') && !dmg) throw new Error('The build left no DMG.');
  const tarball = only(join(bundle, 'macos'), (name) => name.endsWith('.app.tar.gz'));
  const update =
    tarball && existsSync(tarball + '.sig')
      ? { tarball, signature: readFileSync(tarball + '.sig', 'utf8').trim() }
      : null;
  if (config.bundle.createUpdaterArtifacts && !update)
    throw new Error('The build made no update (.app.tar.gz and .sig).');

  if (signing === 'notarised' && dmg) {
    // The bundler notarises and staples the app; the DMG it comes in gets the same, so that
    // Gatekeeper passes the download itself too.
    keyDir = mkdtempSync(join(env.RUNNER_TEMP ?? tmpdir(), 'cgw-notary-'));
    const key = join(keyDir, `AuthKey_${child.APPLE_API_KEY}.p8`);
    writeFileSync(key, readKey(env), { mode: 0o600 });
    try {
      const submitted = spawnSync(
        'xcrun',
        [
          'notarytool',
          'submit',
          dmg,
          '--key',
          key,
          '--key-id',
          child.APPLE_API_KEY,
          '--issuer',
          child.APPLE_API_ISSUER,
          '--wait',
          '--timeout',
          '30m',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
      );
      console.log(submitted.stdout);
      if (submitted.status !== 0 || !/status:\s*Accepted/i.test(submitted.stdout))
        throw new Error('Notarising the DMG failed.');
    } finally {
      rmSync(keyDir, { recursive: true, force: true });
    }
    await run('xcrun', ['stapler', 'staple', dmg]);
  }

  const result = {
    product: PRODUCT,
    version,
    target: target ?? 'host',
    bridge,
    signing,
    app,
    dmg,
    dmgBytes: dmg ? statSync(dmg).size : null,
    update,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  console.log(`Built ${app}${dmg ? ` and ${dmg}` : ''} in ${result.seconds} s (${signing})`);
  return result;
}

/** The .p8's text, whether the secret kept its line breaks or holds them as `\n`. */
function readKey(env) {
  const text = env.APPLE_API_KEY_P8;
  return (text.includes('\n') ? text : text.replace(/\\n/g, '\n')).trim() + '\n';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = await buildMac({ universal: !process.argv.includes('--host') });
  writeFileSync(join(root, 'target/macos/build.json'), JSON.stringify(result, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `signing=${result.signing}\n`);
}
