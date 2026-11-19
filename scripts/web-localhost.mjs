// The web app built against the API on `localhost` instead of `127.0.0.1`, for the passkey specs
// (Phase 11): WebAuthn takes no IP address as its relying party, and the app and the API are on
// 127.0.0.1 everywhere else in development for their cookies (Phase 2). The API answers on both
// names (the e2e stack's one process); a session made on `localhost` is a session of its own.
//   node scripts/web-localhost.mjs --build    target/web-localhost (VITE_CGW_API=http://localhost:5280)
//   node scripts/web-localhost.mjs --serve    that build on http://localhost:4268, under its own CSP
// The e2e stack allows the origin (scripts/server-stack.mjs); Playwright starts --serve.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

export const LOCALHOST_PORT = 4268;
export const LOCALHOST_ORIGIN = `http://localhost:${LOCALHOST_PORT}`;
export const LOCALHOST_API = 'http://localhost:5280';
const out = join(root, 'target/web-localhost');
const web = join(root, 'apps/web');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const env = { ...process.env, VITE_CGW_API: LOCALHOST_API };

if (process.argv.includes('--build')) {
  const ran = spawnSync(pnpm, ['exec', 'vite', 'build', '--outDir', out, '--emptyOutDir'], {
    cwd: web,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (ran.status !== 0) process.exit(ran.status ?? 1);
  console.log(`The localhost build is in ${out}`);
}
if (process.argv.includes('--serve')) {
  if (!existsSync(join(out, 'index.html'))) {
    console.error(`No build in ${out}: run node scripts/web-localhost.mjs --build first.`);
    process.exit(1);
  }
  const args = ['exec', 'vite', 'preview', '--outDir', out, '--host', 'localhost'];
  args.push('--port', String(LOCALHOST_PORT), '--strictPort');
  const child = spawn(pnpm, args, {
    cwd: web,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const stop = () => child.kill();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
}
