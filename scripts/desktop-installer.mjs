// Builds the Windows installer (pnpm desktop:installer, after pnpm build), as Sheet does:
// target/release/bundle/nsis/Cash Gear Workspace_<version>_x64-setup.exe, installing per user,
// with the third-party notices beside the app and the cashgear-workspace:// scheme registered.
// Every file it builds is signed through scripts/sign-windows.mjs.
//
// Settings, from the environment:
//   CGW_VERSION        build this version instead of tauri.conf.json's (tests)
//   CGW_TEST_PRODUCT, CGW_TEST_IDENTIFIER, CGW_TEST_SCHEME: build as another product with another
//                      link scheme (the installer test). These and the publisher, which takes the
//                      product's name, decide the install's registry keys, shortcuts and data
//                      folders, so that it shares none with the real app.
//   TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD): the updater's private key. With it the build also
//                      signs the update (the installer's .sig) for latest.json.
//   CGW_UPDATER_PUBKEY the updater's public key, when it is not the config's (tests)
//   CGW_UPDATER_URL    the update feed, when it is not the config's (tests: http)
//   CGW_SIGN_*         code signing: see scripts/sign-windows.mjs
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pnpmCommand, root, run } from './lib.mjs';

const notices = join(root, 'apps/web/dist/third-party-notices.txt');
if (!existsSync(join(root, 'apps/web/dist/index.html')) || !existsSync(notices)) {
  throw new Error('The web build is missing: run pnpm build first.');
}

// What goes beside the app.
const staging = join(root, 'target/installer');
rmSync(staging, { recursive: true, force: true });
const licences = join(staging, 'licences');
mkdirSync(licences, { recursive: true });
copyFileSync(notices, join(licences, 'THIRD-PARTY-NOTICES.txt'));

// The bundle's settings on top of tauri.conf.json.
const env = process.env;
const forward = (path) => path.replace(/\\/g, '/');
const config = {
  ...(env.CGW_VERSION ? { version: env.CGW_VERSION } : {}),
  ...(env.CGW_TEST_PRODUCT
    ? { productName: env.CGW_TEST_PRODUCT, identifier: env.CGW_TEST_IDENTIFIER }
    : {}),
  bundle: {
    ...(env.CGW_TEST_PRODUCT ? { publisher: env.CGW_TEST_PRODUCT } : {}),
    resources: { [forward(join(licences, '*'))]: 'licences/' },
    createUpdaterArtifacts: !!env.TAURI_SIGNING_PRIVATE_KEY,
    windows: {
      // Tauri splits the command at spaces, runs it in src-tauri, and passes the file as one
      // argument.
      signCommand: 'node ../../../scripts/sign-windows.mjs %1',
    },
  },
  plugins: {
    ...(env.CGW_TEST_SCHEME
      ? { 'deep-link': { desktop: { schemes: [env.CGW_TEST_SCHEME] } } }
      : {}),
    updater: {
      ...(env.CGW_UPDATER_PUBKEY ? { pubkey: env.CGW_UPDATER_PUBKEY } : {}),
      ...(env.CGW_UPDATER_URL
        ? {
            endpoints: [env.CGW_UPDATER_URL],
            dangerousInsecureTransportProtocol: env.CGW_UPDATER_URL.startsWith('http:'),
          }
        : {}),
    },
  },
};
// Only this build's installer is left in the bundle folder (an earlier test build there would
// end up in the release's files).
const out = join(root, 'target/release/bundle/nsis');
rmSync(out, { recursive: true, force: true });
const configFile = join(staging, 'tauri.installer.json');
writeFileSync(configFile, JSON.stringify(config, null, 2));
await run(...pnpmCommand(['--filter', '@cgw/desktop', 'tauri', 'build', '--config', configFile]));
for (const name of readdirSync(out)) console.log('Built ' + join(out, name));
