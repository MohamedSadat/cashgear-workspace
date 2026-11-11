import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function run(command, args = [], options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0 ? resolveRun() : reject(new Error(command + ' failed (' + (signal ?? code) + ')')),
    );
  });
}

/** How to run pnpm again from a script that pnpm started. */
export function pnpmCommand(args) {
  if (!process.env.npm_execpath) throw new Error('Run this command through pnpm.');
  return /\.[cm]?js$/.test(process.env.npm_execpath)
    ? [process.execPath, [process.env.npm_execpath, ...args]]
    : [process.env.npm_execpath, args];
}

/**
 * Runs a Windows PowerShell 5.1 script and returns what it printed. A shell started from
 * PowerShell 7 passes on a PSModulePath that 5.1 then cannot load its own modules from
 * (certificates, signatures, processes), so it gets its own path here, and it stops on the first
 * error. The script goes as -Command, since running .ps1 files may be blocked. From Sheet.
 */
export function windowsPowerShell(script) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'psmodulepath') delete env[name];
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; " + script],
    { encoding: 'utf8', env },
  ).trim();
}
