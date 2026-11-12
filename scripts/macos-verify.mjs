// Checks the macOS release build that scripts/macos-build.mjs made (target/macos/build.json),
// on GitHub's macOS runner (.github/workflows/macos.yml and release.yml):
//   - the bundle's settings: identifier, version, minimum macOS, category, and the
//     cashgear-workspace:// scheme registered (CFBundleURLTypes); the third-party notices inside;
//   - both architectures in the program (a universal build), and each one starts and opens its
//     store (Intel under Rosetta 2, when the runner has it);
//   - no trace of the test-only bridge in the program (apps/desktop/src-tauri/src/bridge.rs);
//   - the signature (codesign --verify), and what Gatekeeper makes of it (spctl --assess): passing
//     is required once notarised; an ad-hoc or un-notarised build is refused, which is recorded,
//     not failed. A notarised build's tickets are stapled (xcrun stapler validate);
//   - the update archive, when there is one.
//   node scripts/macos-verify.mjs
// Results go to bench/results/macos-release.json.
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from './lib.mjs';
import { BRIDGE_MARKERS } from './macos-bridge.mjs';

if (process.platform !== 'darwin') throw new Error('The macOS checks run on a Mac.');
const build = JSON.parse(readFileSync(join(root, 'target/macos/build.json'), 'utf8'));
const conf = JSON.parse(readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
const macConf = JSON.parse(
  readFileSync(join(root, 'apps/desktop/src-tauri/tauri.macos.conf.json'), 'utf8'),
);

const results = {
  version: build.version,
  target: build.target,
  signing: build.signing,
  checks: {},
};
const failures = [];
const check = (name, ok, detail) => {
  results.checks[name] = { ok, ...(detail === undefined ? {} : { detail }) };
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`,
  );
  if (!ok) failures.push(name);
};
const record = (name, detail) => {
  results.checks[name] = { recorded: detail };
  console.log(`--   ${name}: ${JSON.stringify(detail)}`);
};
const sh = (command, args) => {
  const ran = spawnSync(command, args, { encoding: 'utf8' });
  return { status: ran.status, out: `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim() };
};

const app = build.app;
const plist = JSON.parse(
  spawnSync('plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')], {
    encoding: 'utf8',
  }).stdout,
);
const exe = join(app, 'Contents/MacOS', plist.CFBundleExecutable);

// The bundle's settings.
check('identifier', plist.CFBundleIdentifier === conf.identifier, plist.CFBundleIdentifier);
check(
  'version',
  plist.CFBundleShortVersionString === build.version,
  plist.CFBundleShortVersionString,
);
check(
  'minimum macOS',
  plist.LSMinimumSystemVersion === macConf.bundle.macOS.minimumSystemVersion,
  plist.LSMinimumSystemVersion,
);
check(
  'category',
  plist.LSApplicationCategoryType === 'public.app-category.productivity',
  plist.LSApplicationCategoryType,
);
const schemes = (plist.CFBundleURLTypes ?? []).flatMap((type) => type.CFBundleURLSchemes ?? []);
check('link scheme registered', schemes.includes('cashgear-workspace'), schemes);
const notices = join(app, 'Contents/Resources/licences/THIRD-PARTY-NOTICES.txt');
check(
  'third-party notices',
  existsSync(notices) && readFileSync(notices, 'utf8').includes('Rust crates ('),
);

// Architectures, and no bridge.
const archs = sh('lipo', ['-archs', exe]).out.split(/\s+/).filter(Boolean);
if (build.target === 'universal-apple-darwin')
  check('universal', archs.includes('arm64') && archs.includes('x86_64'), archs);
else record('architectures', archs);
const program = readFileSync(exe);
const found = BRIDGE_MARKERS.filter((marker) => program.includes(Buffer.from(marker)));
check('no test-only bridge', found.length === 0, found.length ? found : undefined);
results.programBytes = program.length;

// The signature and Gatekeeper.
const verify = sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
check('codesign --verify', verify.status === 0, verify.out);
const details = sh('codesign', ['-dv', '--verbose=4', app]).out;
const signature = {
  adhoc: /Signature=adhoc/.test(details),
  authority: details.match(/^Authority=(.+)$/m)?.[1] ?? null,
  team: details.match(/^TeamIdentifier=(.+)$/m)?.[1] ?? null,
  hardenedRuntime: /flags=0x[0-9a-f]*\([^)]*runtime/.test(details),
};
results.signature = signature;
if (build.signing === 'ad-hoc') check('ad-hoc signature', signature.adhoc, signature);
else
  check(
    'Developer ID signature with the hardened runtime',
    !signature.adhoc &&
      /^Developer ID Application/.test(signature.authority ?? '') &&
      signature.hardenedRuntime,
    signature,
  );
const gatekeeper = sh('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
const notarised = build.signing === 'notarised';
if (notarised) check('Gatekeeper accepts the app', gatekeeper.status === 0, gatekeeper.out);
else record('Gatekeeper (expected to refuse a build that is not notarised)', gatekeeper);
if (notarised) {
  const stapled = sh('xcrun', ['stapler', 'validate', app]);
  check('the app has its notarisation ticket', stapled.status === 0, stapled.out);
} else record('stapler validate', 'skipped: not notarised');

if (build.dmg) {
  const image = sh('hdiutil', ['verify', build.dmg]);
  check('DMG checksum', image.status === 0);
  results.dmgBytes = build.dmgBytes;
  if (build.signing !== 'ad-hoc') {
    const signed = sh('codesign', ['--verify', '--verbose=2', build.dmg]);
    check('DMG signature', signed.status === 0, signed.out);
  }
  const opened = sh('spctl', [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    '--verbose=4',
    build.dmg,
  ]);
  if (notarised) {
    check('Gatekeeper accepts the DMG', opened.status === 0, opened.out);
    const stapled = sh('xcrun', ['stapler', 'validate', build.dmg]);
    check('the DMG has its notarisation ticket', stapled.status === 0, stapled.out);
  } else record('Gatekeeper on the DMG', opened);
}

if (build.update) {
  const listed = sh('tar', ['-tzf', build.update.tarball]).out.split('\n');
  check(
    'update archive holds the app',
    listed.some((line) => line.endsWith('.app/Contents/Info.plist')),
  );
  check('update signature', build.update.signature.length > 0);
} else record('update', 'not made: no updater key in this build');

// Each architecture starts and opens its store.
async function starts(arch) {
  const data = mkdtempSync(join(tmpdir(), `cgw-verify-${arch}-`));
  const child = spawn('arch', [`-${arch}`, exe], {
    env: {
      ...process.env,
      CGW_DATA_DIR: join(data, 'data'),
      CGW_KEYCHAIN_SERVICE: 'com.cashgear.workspace.verify',
    },
    stdio: 'ignore',
  });
  const started = Date.now();
  let exited = null;
  child.on('exit', (code, signal) => (exited = signal ?? code));
  try {
    while (!existsSync(join(data, 'data/workspace.db'))) {
      if (exited !== null) return { ok: false, detail: `exited (${exited})` };
      if (Date.now() - started > 60_000) return { ok: false, detail: 'no store after 60 s' };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const seconds = (Date.now() - started) / 1000;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return exited === null
      ? { ok: true, detail: { storeAfterSeconds: seconds } }
      : { ok: false, detail: `exited (${exited}) after opening its store` };
  } finally {
    child.kill('SIGKILL');
    rmSync(data, { recursive: true, force: true });
  }
}
for (const arch of archs) {
  if (
    arch === 'x86_64' &&
    process.arch === 'arm64' &&
    sh('arch', ['-x86_64', '/usr/bin/true']).status !== 0
  ) {
    record('starts (x86_64)', 'skipped: Rosetta 2 is not installed on this runner');
    continue;
  }
  const started = await starts(arch);
  check(`starts (${arch})`, started.ok, started.detail);
}

mkdirSync(join(root, 'bench/results'), { recursive: true });
writeFileSync(
  join(root, 'bench/results/macos-release.json'),
  JSON.stringify(results, null, 2) + '\n',
);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      `### macOS release build ${build.version} (${build.signing}): ${failures.length ? 'failed' : 'passed'}`,
      '',
      ...Object.entries(results.checks).map(([name, item]) =>
        'recorded' in item
          ? `- recorded: ${name}: ${JSON.stringify(item.recorded).slice(0, 300)}`
          : `- ${item.ok ? 'ok' : '**failed**'}: ${name}`,
      ),
      '',
    ].join('\n'),
  );
if (failures.length) {
  console.error('The macOS release build failed: ' + failures.join(', '));
  process.exit(1);
}
console.log(`The macOS release build passed (${build.signing}).`);
