// Signs one Windows file for the installer build (Tauri's bundle.windows.signCommand, set by
// scripts/desktop-installer.mjs). From Sheet. With
//   CGW_SIGN_METADATA and CGW_SIGN_DLIB: Azure Artifact Signing. METADATA is its metadata.json
//     (endpoint, account, certificate profile), DLIB the Azure.CodeSigning.Dlib.dll of
//     Microsoft.ArtifactSigning.Client; it signs in as AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and
//     AZURE_TENANT_ID.
//   CGW_SIGN_PFX (and CGW_SIGN_PASSWORD): a certificate file, such as the throwaway one
//     scripts/test-certificate.mjs makes.
//   neither: the file stays unsigned, unless CGW_SIGN_REQUIRED=1.
// Signatures are SHA-256 and timestamped, unless CGW_SIGN_TIMESTAMP=0 (offline tests).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './lib.mjs';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/sign-windows.mjs <file>');

function signtool() {
  if (process.env.SIGNTOOL) return process.env.SIGNTOOL;
  const kits = join(
    process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)',
    'Windows Kits/10/bin',
  );
  const versions = existsSync(kits)
    ? readdirSync(kits)
        .filter((name) => /^10\./.test(name) && existsSync(join(kits, name, 'x64/signtool.exe')))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    : [];
  if (!versions.length)
    throw new Error('signtool.exe was not found: install the Windows SDK or set SIGNTOOL.');
  return join(kits, versions.at(-1), 'x64/signtool.exe');
}

const env = process.env;
const timestamp = env.CGW_SIGN_TIMESTAMP !== '0';
let args;
if (env.CGW_SIGN_METADATA && env.CGW_SIGN_DLIB) {
  args = ['/dlib', env.CGW_SIGN_DLIB, '/dmdf', env.CGW_SIGN_METADATA];
  if (timestamp) args.push('/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256');
} else if (env.CGW_SIGN_PFX) {
  args = ['/f', env.CGW_SIGN_PFX];
  if (env.CGW_SIGN_PASSWORD) args.push('/p', env.CGW_SIGN_PASSWORD);
  if (timestamp) args.push('/tr', 'http://timestamp.digicert.com', '/td', 'SHA256');
} else if (env.CGW_SIGN_REQUIRED === '1') {
  throw new Error(`No signing is set up, and CGW_SIGN_REQUIRED=1: ${file}`);
} else {
  console.log(`Not signing ${file}: no certificate is set up.`);
  process.exit(0);
}
await run(signtool(), ['sign', '/fd', 'SHA256', ...args, file], {
  stdio: ['ignore', 'ignore', 'inherit'],
});
console.log(`Signed ${file}`);
