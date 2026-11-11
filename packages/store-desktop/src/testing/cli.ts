// A transport to crates/cgw-store through the cgw-store-cli process: the same frames the desktop
// app sends over Tauri, length-prefixed on stdin and stdout. For tests and benchmarks in Node.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Transport } from '../store';

export function cliPath(): string | null {
  const root = resolve(import.meta.dirname, '../../../..');
  const exe = process.platform === 'win32' ? '.exe' : '';
  for (const candidate of [
    process.env.CGW_STORE_CLI,
    join(root, `target/debug/cgw-store-cli${exe}`),
    join(root, `target/release/cgw-store-cli${exe}`),
  ])
    if (candidate && existsSync(candidate)) return candidate;
  return null;
}

/** Starts the store in a fresh directory (or `dir`) and returns its transport. */
export function cliTransport(dir = mkdtempSync(join(tmpdir(), 'cgw-store-'))): {
  transport: Transport;
  close: () => Promise<void>;
  dir: string;
} {
  const path = cliPath();
  if (!path)
    throw new Error('cgw-store-cli is not built: cargo build -p cgw-store --bin cgw-store-cli');
  const child = spawn(path, [dir], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting: ((frame: Uint8Array) => void)[] = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const frame = new Uint8Array(buffer.subarray(4, 4 + length));
      buffer = buffer.subarray(4 + length);
      waiting.shift()?.(frame);
    }
  });
  const transport: Transport = (frame) =>
    new Promise((resolveFrame, reject) => {
      if (child.exitCode !== null)
        return reject(new Error(`cgw-store-cli exited (${child.exitCode})`));
      waiting.push(resolveFrame);
      const length = Buffer.alloc(4);
      length.writeUInt32LE(frame.byteLength, 0);
      child.stdin.write(length);
      child.stdin.write(frame);
    });
  const close = () =>
    new Promise<void>((done) => {
      if (child.exitCode !== null) return done();
      child.once('exit', () => done());
      child.stdin.end();
    });
  return { transport, close, dir };
}
