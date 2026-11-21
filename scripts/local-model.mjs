// The local embedding model's package (Phase 13, M13.4; decisions, 2026-11-21): voyage-4-nano from
// Voyage's own weights (MongoDB/voyage-4-nano on Hugging Face, Apache-2.0, at the revision below),
// exported to ONNX by scripts/local-model/export.py in a throwaway Python environment under target/,
// checked against the model as its card runs it, and zipped for the host:
//
//   node scripts/local-model.mjs [--weights <folder>] [--python <python>]
//
// Writes target/local-model/package/ (model.onnx, vocab.json, merges.txt, LICENSE.txt, NOTICE.txt,
// cgw-model.json) and target/deploy/cgw-local-model-voyage-4-nano-<revision>.zip, and prints each
// file's SHA-256: the server loads a package in Production only when they are the ones pinned in
// server/src/Cgw.Core/Ai/LocalModelOptions.cs. Downloads (about 700 MB of weights, and PyTorch for the
// processor, Transformers, ONNX and ONNX Runtime into the environment) go under target/ only. The
// model's own code (modeling_qwen3_bidirectional.py) runs in the export: its hash is checked first.
// Nothing here is part of the app or the deploy package; install.ps1 -LocalModel places the zip.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = 'MongoDB/voyage-4-nano';
const REVISION = '587d8d6dcaec029a9779c2098d6af020e4a07c01';
/** The model's own code as read on 2026-11-21 (Qwen3 with a bidirectional mask and a linear head). */
const MODEL_CODE_SHA256 = '425304da2571d17bf04add3b70fab46d4b7d4466abbe118ef553ccb6fe8fadfe';
const PACKAGES = [
  'torch==2.15.0',
  'transformers==5.24.0',
  'onnx==1.23.2',
  'onnxruntime==1.32.0',
  'tokenizers==0.23.3',
  'huggingface_hub',
  'safetensors',
  'numpy',
];

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const root = resolve(import.meta.dirname, '..');
const work = join(root, 'target', 'local-model');
const venv = join(work, 'venv');
const python =
  process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');
const weights = resolve(option('--weights') ?? join(work, 'weights'));
const out = join(work, 'package');
mkdirSync(work, { recursive: true });

const run = (exe, list, env = {}) =>
  execFileSync(exe, list, { stdio: 'inherit', env: { ...process.env, ...env } });
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

if (!existsSync(python)) {
  run(option('--python') ?? 'python', ['-m', 'venv', venv]);
  run(python, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']);
  run(python, [
    '-m',
    'pip',
    'install',
    '--quiet',
    'torch==2.15.0',
    '--index-url',
    'https://download.pytorch.org/whl/cpu',
  ]);
  run(python, [
    '-m',
    'pip',
    'install',
    '--quiet',
    ...PACKAGES.filter((p) => !p.startsWith('torch')),
  ]);
}

if (!existsSync(join(weights, 'model.safetensors'))) {
  run(python, [
    '-I',
    '-c',
    `from huggingface_hub import snapshot_download\nsnapshot_download(${JSON.stringify(REPO)}, revision=${JSON.stringify(REVISION)}, local_dir=${JSON.stringify(weights)}, allow_patterns=['*.json','*.py','*.txt','model.safetensors','1_Pooling/*'])`,
  ]);
}
const code = sha256(join(weights, 'modeling_qwen3_bidirectional.py'));
if (code !== MODEL_CODE_SHA256) {
  console.error(
    `The model's own code is not the code read before (${code}): read it again before running it.`,
  );
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
run(python, ['-I', join(root, 'scripts', 'local-model', 'export.py'), weights, out], {
  CGW_MODEL_REVISION: REVISION,
});

const manifest = JSON.parse(readFileSync(join(out, 'cgw-model.json'), 'utf8'));
for (const [name, hash] of Object.entries(manifest.files))
  if (sha256(join(out, name)) !== hash) throw new Error(`${name} changed after it was described`);

const deploy = join(root, 'target', 'deploy');
mkdirSync(deploy, { recursive: true });
const zip = join(deploy, `cgw-local-model-voyage-4-nano-${REVISION.slice(0, 7)}.zip`);
rmSync(zip, { force: true });
if (process.platform === 'win32')
  run('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${out}\\*' -DestinationPath '${zip}'`,
  ]);
else
  run('zip', [
    '-j',
    '-q',
    zip,
    ...Object.keys(manifest.files)
      .concat(['cgw-model.json', 'LICENSE.txt', 'NOTICE.txt'])
      .map((f) => join(out, f)),
  ]);

console.log(`\nThe model's code: ${code}`);
console.log(
  `Package: ${zip} (${(statSync(zip).size / 1048576).toFixed(1)} MB, sha256 ${sha256(zip)})`,
);
console.log('Pin these in server/src/Cgw.Core/Ai/LocalModelOptions.cs:');
for (const [name, hash] of Object.entries(manifest.files)) console.log(`  ${name}: ${hash}`);
