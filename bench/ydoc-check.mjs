// Spike S3's harness, kept: Yjs 13 writes a corpus, cgw-ydoc processes it from .NET by
// P/Invoke, and Yjs 13 checks every output.
//   pnpm bench:s3          (S3_DOCS, S3_BIG_BYTES size the corpus)
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../scripts/lib.mjs';

const step = (name, command, args, env = {}) => {
  console.log(`\n=== ${name} ===`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, S3: '1', ...env },
  });
  if (result.status !== 0) throw new Error(`${name} failed (${result.status})`);
};

rmSync(join(root, 'bench/results/s3'), { recursive: true, force: true });
step('Yjs 13 writes the corpus', 'pnpm', [
  'exec',
  'vitest',
  'run',
  'bench/editor/src/s3-corpus.test.ts',
]);
step('cgw-ydoc as a C library', 'cargo', ['build', '-p', 'cgw-ydoc', '--profile', 'ffi']);
step('.NET calls it by P/Invoke', 'dotnet', [
  'run',
  '-c',
  'Release',
  '--project',
  'bench/ydoc-dotnet/S3Harness.csproj',
  '--',
  join(root, 'target/ffi/cgw_ydoc.dll'),
  join(root, 'bench/results/s3'),
]);
step('Yjs 13 checks the results', 'pnpm', [
  'exec',
  'vitest',
  'run',
  'bench/editor/src/s3-verify.test.ts',
]);
