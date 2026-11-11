// Proves the license gates work: each must reject the GPL-3.0 fixture in
// tests/license-gate. Passing here means "adding a GPL dependency fails CI".
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { root } from './lib.mjs';

function expectRejection(label, command, args, mustMention) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const missing = mustMention.filter((text) => !output.includes(text));
  if (result.status === 0 || missing.length) {
    console.error(output);
    throw new Error(
      label +
        ' did not reject the GPL fixture' +
        (result.status === 0 ? ' (it passed)' : ' (output lacks ' + missing.join(', ') + ')'),
    );
  }
  console.log(label + ' rejected the GPL-3.0 fixture as expected.');
}

expectRejection(
  'cargo-deny',
  'cargo',
  [
    'deny',
    '--manifest-path',
    join(root, 'tests/license-gate/cargo/Cargo.toml'),
    '--config',
    join(root, 'deny.toml'),
    'check',
    'licenses',
  ],
  ['GPL-3.0-only', 'gpl-dep'],
);
expectRejection(
  'npm license check',
  process.execPath,
  [
    join(root, 'scripts/check-licenses.mjs'),
    '--listing',
    join(root, 'tests/license-gate/npm/gpl.json'),
  ],
  ['gpl-fixture@1.0.0', 'GPL-3.0-only'],
);
