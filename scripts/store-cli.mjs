// The desktop's SQLite store from Node, through cgw-store-cli (the frames the app sends over
// Tauri's `invoke('store')`; packages/store-desktop/src/frame.ts): for the kill tests, which read a
// killed app's store before it starts again. `cargo build -p cgw-store --bin cgw-store-cli` first.
//   const store = await openStoreCli(dataDir); const { ok, blobs } = await store.call({ op: 'loadDoc', pageId });
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

export const storeCliPath = join(
  root,
  'target/debug',
  process.platform === 'win32' ? 'cgw-store-cli.exe' : 'cgw-store-cli',
);

export function encodeFrame(header, blobs = []) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const parts = [u32(json.length), json, u32(blobs.length)];
  for (const blob of blobs) parts.push(u32(blob.length), Buffer.from(blob));
  return Buffer.concat(parts);
}

export function decodeFrame(bytes) {
  let at = 0;
  const read = () => {
    const value = bytes.readUInt32LE(at);
    at += 4;
    return value;
  };
  const headerLength = read();
  const header = JSON.parse(bytes.subarray(at, at + headerLength).toString('utf8'));
  at += headerLength;
  const blobs = [];
  for (let count = read(), i = 0; i < count; i++) {
    const length = read();
    blobs.push(bytes.subarray(at, at + length));
    at += length;
  }
  return { header, blobs };
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

/** Opens the store in `dir` (migrating it, as the app would). Rejects with what the CLI said. */
export async function openStoreCli(dir) {
  if (!existsSync(storeCliPath))
    throw new Error('cgw-store-cli is missing: cargo build -p cgw-store --bin cgw-store-cli');
  const child = spawn(storeCliPath, [dir], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = Buffer.alloc(0);
  let stderr = '';
  const waiting = [];
  let exited = null;
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const frame = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      waiting.shift()?.resolve(decodeFrame(Buffer.from(frame)));
    }
  });
  child.on('exit', (code) => {
    exited = code;
    for (const w of waiting.splice(0))
      w.reject(new Error(`cgw-store-cli exited (${code}): ${stderr.trim()}`));
  });
  const call = (header, blobs = []) =>
    new Promise((resolve, reject) => {
      if (exited !== null)
        return reject(new Error(`cgw-store-cli exited (${exited}): ${stderr.trim()}`));
      waiting.push({ resolve, reject });
      const frame = encodeFrame(header, blobs);
      child.stdin.write(Buffer.concat([u32(frame.length), frame]));
    }).then(({ header: answer, blobs: out }) => {
      if (answer.error !== undefined) throw new Error(`${header.op}: ${answer.error}`);
      return { ok: answer.ok, blobs: out };
    });
  // The store opens (and migrates) before the first answer: a refusal shows here.
  await call({ op: 'schemaVersion' });
  return {
    call,
    close: () =>
      new Promise((resolve) => {
        if (exited !== null) return resolve();
        child.once('exit', () => resolve());
        child.stdin.end();
      }),
  };
}
