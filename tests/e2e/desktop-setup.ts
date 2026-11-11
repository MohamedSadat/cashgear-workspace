// Before the desktop e2e run: the release build must be there, and on GitHub's hosted runners,
// which run elevated, WebView2 takes the debugging port from its documented policy rather than
// the environment, scoped to our executable (as scripts/desktop-smoke.mjs does). The policy is
// removed afterwards.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DESKTOP_PORT } from './fixtures';

const root = resolve(import.meta.dirname, '../..');
const policyKey = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';
const reg = (args: string[]) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });

export default function setup() {
  if (!existsSync(join(root, 'target/release/cgw-desktop.exe')))
    throw new Error('The desktop build is missing: run pnpm desktop:build first.');
  const hosted =
    process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
  if (!hosted) return;
  const added = reg([
    'add',
    policyKey,
    '/v',
    'cgw-desktop.exe',
    '/t',
    'REG_SZ',
    '/d',
    `--remote-debugging-port=${DESKTOP_PORT} --remote-debugging-address=127.0.0.1`,
    '/f',
    '/reg:64',
  ]);
  if (added.status !== 0)
    throw new Error('Could not set the WebView2 test policy: ' + added.stderr);
  return () => {
    reg(['delete', policyKey, '/v', 'cgw-desktop.exe', '/f', '/reg:64']);
  };
}
