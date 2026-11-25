// The local completion model's package (Phase 18, M18.1; decisions, 2026-11-25): the spike's model
// from its own published weights (Hugging Face, at the revision below), built to ONNX Runtime GenAI's
// int4 format for the processor by GenAI's own builder in a throwaway Python environment under
// target/, and zipped for the host:
//
//   node scripts/completion-model.mjs [--weights <folder>] [--python <python>]
//
// Writes target/completion-model/package/ (genai_config.json, model.onnx and model.onnx.data, the
// tokenizer's files, the licence, a notice and cgw-model.json) and
// target/deploy/cgw-completion-model-<model>-<revision>.zip (stored, not compressed: the int4 weights
// do not shrink, and the zip holds a file past 2 GB), and prints each file's SHA-256: the server loads
// a package in Production only when they are the ones pinned in
// server/src/Cgw.Core/Ai/CompletionModelOptions.cs. Downloads (about 8 GB of weights, and PyTorch for
// the processor, Transformers, ONNX and ONNX Runtime GenAI into the environment) go under target/
// only. No code of the model's repository runs: the builder reads its weights and configuration with
// Transformers' own model of its architecture (`trust_remote_code` off). Nothing here is part of the
// app or the deploy package; install.ps1 -CompletionModel places the zip.
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const MODEL = 'qwen3-4b-instruct-2507';
const REPO = 'Qwen/Qwen3-4B-Instruct-2507';
const REVISION = 'cdbee75f17c01a7cc42f958dc650907174af0554';
/** How the server writes the model's prompt (LocalCompletionProvider.Prompt). */
const FAMILY = 'qwen';
const LICENSE = 'Apache-2.0';
const PACKAGES = [
  'transformers==5.24.1',
  'onnx==1.23.2',
  'onnx-ir==1.1.0',
  'onnxscript==0.7.2',
  'onnxruntime==1.31.1',
  'onnxruntime-genai==0.19.0',
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
const work = join(root, 'target', 'completion-model');
const venv = join(work, 'venv');
const python =
  process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');
const weights = resolve(option('--weights') ?? join(work, 'weights'));
const built = join(work, 'built');
const out = join(work, 'package');
mkdirSync(work, { recursive: true });

const run = (exe, list, env = {}) =>
  execFileSync(exe, list, { stdio: 'inherit', env: { ...process.env, ...env } });
/** A file's SHA-256, read in pieces (the weights are past 2 GB). */
const sha256 = (path) => {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(16 * 1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (let read; (read = readSync(fd, chunk, 0, chunk.length, null)) > 0;)
      hash.update(chunk.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
};

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
  run(python, ['-m', 'pip', 'install', '--quiet', ...PACKAGES]);
}

if (!existsSync(join(weights, 'config.json'))) {
  run(python, [
    '-I',
    '-c',
    `from huggingface_hub import snapshot_download\nsnapshot_download(${JSON.stringify(REPO)}, revision=${JSON.stringify(REVISION)}, local_dir=${JSON.stringify(weights)}, allow_patterns=['*.json','*.txt','*.jinja','*.safetensors','LICENSE*'])`,
  ]);
}

rmSync(built, { recursive: true, force: true });
run(python, [
  '-I',
  join(root, 'scripts', 'completion-model', 'build.py'),
  weights,
  built,
  join(work, 'cache'),
]);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const files = {};
for (const name of readdirSync(built).sort()) {
  const from = join(built, name);
  if (!statSync(from).isFile()) continue;
  copyFileSync(from, join(out, name));
  files[name] = sha256(join(out, name));
}
copyFileSync(join(weights, 'LICENSE'), join(out, 'LICENSE.txt'));
writeFileSync(
  join(out, 'NOTICE.txt'),
  `${REPO} at ${REVISION} (${LICENSE}), built to ONNX Runtime GenAI's int4 format for the processor ` +
    'by scripts/completion-model.mjs (onnxruntime-genai 0.19.0, accuracy level 4). Its weights are ' +
    "quantised; nothing else of the model's is changed.\n",
);
writeFileSync(
  join(out, 'cgw-model.json'),
  JSON.stringify(
    { model: MODEL, source: `${REPO}@${REVISION}`, family: FAMILY, license: LICENSE, files },
    null,
    2,
  ) + '\n',
);

const deploy = join(root, 'target', 'deploy');
mkdirSync(deploy, { recursive: true });
const zip = join(deploy, `cgw-completion-model-${MODEL}-${REVISION.slice(0, 7)}.zip`);
rmSync(zip, { force: true });
if (process.platform === 'win32')
  run('powershell', [
    '-NoProfile',
    '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${out}', '${zip}', [IO.Compression.CompressionLevel]::NoCompression, $false)`,
  ]);
else run('zip', ['-j', '-q', '-0', zip, ...readdirSync(out).map((f) => join(out, f))]);

console.log(`\nPackage: ${zip} (${(statSync(zip).size / 1048576).toFixed(1)} MB)`);
console.log('Pin these in server/src/Cgw.Core/Ai/CompletionModelOptions.cs:');
for (const [name, hash] of Object.entries(files)) console.log(`  ["${name}"] = "${hash}",`);
