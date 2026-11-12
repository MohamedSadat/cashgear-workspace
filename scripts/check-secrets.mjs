// Fails when a file in the repository holds a credential (ARCHITECTURE.md, Security: "A CI
// check fails on a committed secret"). Scans every tracked file and every untracked file git
// does not ignore, so a secret is caught before it is committed, not only after.
//   node scripts/check-secrets.mjs             scan the repository
//   node scripts/check-secrets.mjs --selftest  prove each rule catches its kind of secret
// The self-test's samples are put together at run time, so the repository never holds one.
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Azurite's account key: Microsoft's published development key, the same on every machine
 * (https://learn.microsoft.com/azure/storage/common/storage-use-azurite). Not a secret.
 */
const AZURITE_KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

/** Put together from parts: written out, this file would match itself. */
function signingKeyPattern() {
  const plain = ['rsign', 'encrypted', 'secret', 'key'].join(' ');
  const encoded = Buffer.from(`untrusted comment: ${plain}`).toString('base64').replace(/=+$/, '');
  return new RegExp(`${plain}|${encoded}`);
}

/** What a credential looks like in text. `allow` drops a match that is known not to be one. */
const RULES = [
  { name: 'private key', pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
  {
    name: 'Azure storage key',
    pattern: /(?:AccountKey|SharedAccessKey)=([A-Za-z0-9+/]{40,}={0,2})/,
    allow: (m) => m[1] === AZURITE_KEY,
  },
  {
    // An account key on its own: 64 bytes in base64. Lockfiles' sha512 integrity hashes are the
    // same length and are not secrets.
    name: 'Azure storage key',
    pattern: /(^|[^A-Za-z0-9+/-])([A-Za-z0-9+/]{86}==)/,
    allow: (m, line) => m[2] === AZURITE_KEY || line.includes(`sha512-${m[2]}`),
  },
  { name: 'SAS signature', pattern: /[?&]sig=[A-Za-z0-9%+/=]{30,}/ },
  {
    name: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b/,
  },
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: 'JSON web token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  // The updater's signing key (minisign, as `tauri signer` writes it), plain or in base64.
  {
    name: 'updater signing key',
    pattern: signingKeyPattern(),
  },
  {
    // A connection string's password. Placeholders (<...>, ${...}, $env:...) and empty values
    // are not credentials.
    name: 'connection string password',
    pattern: /\b(?:Password|Pwd)=(<[^>]*>|\$\{\{[^}]*\}\}|[^;"'`\s]+)/i,
    allow: (m) => /^(?:<.*>|\$\{.*\}|\$env:.*|\{.*\}|\*+|\.\.\.)$/.test(m[1]),
  },
];

/** Files that are credentials whatever they hold. */
const FILE_RULES = [
  { name: 'certificate with its key', pattern: /\.(?:pfx|p12|snk)$/i },
  { name: 'private key file', pattern: /(?:^id_(?:rsa|ecdsa|ed25519)$|\.key$)/ },
  {
    name: 'environment file',
    pattern: /^\.env(?:\..+)?$/,
    allow: (name) => /\.example$/.test(name),
  },
];

/** Every rule's findings in one text. */
export function scanText(text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      const flags = rule.pattern.flags.includes('g')
        ? rule.pattern.flags
        : `${rule.pattern.flags}g`;
      for (const m of line.matchAll(new RegExp(rule.pattern.source, flags))) {
        if (rule.allow?.(m, line)) continue;
        found.push({ line: i + 1, rule: rule.name });
      }
    }
  });
  return found;
}

export function scanName(path) {
  const name = basename(path);
  return FILE_RULES.filter((r) => r.pattern.test(name) && !r.allow?.(name)).map((r) => r.name);
}

function repositoryFiles() {
  const list = (args) => {
    const result = spawnSync('git', ['ls-files', '-z', ...args], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
    return result.stdout.split('\0').filter(Boolean);
  };
  return [...new Set([...list([]), ...list(['--others', '--exclude-standard'])])];
}

function scanRepository() {
  const problems = [];
  let scanned = 0;
  for (const file of repositoryFiles()) {
    for (const rule of scanName(file)) problems.push(`${file}: ${rule}`);
    let bytes;
    try {
      if (statSync(join(root, file)).size > 20 * 1024 * 1024) continue;
      bytes = readFileSync(join(root, file));
    } catch {
      continue; // Deleted in the working tree.
    }
    if (bytes.subarray(0, 8000).includes(0)) continue; // Binary.
    scanned++;
    for (const { line, rule } of scanText(bytes.toString('utf8')))
      problems.push(`${file}:${line}: ${rule}`);
  }
  return { problems, scanned };
}

function selftest() {
  // Each sample is assembled here, so no file in the repository holds one.
  const b64 = (n, seed) =>
    Array.from(
      { length: n },
      (_, i) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789+/'[(i * 7 + seed) % 44],
    ).join('');
  const must = [
    ['private key', `-----BEGIN ${'RSA PRIVATE'} KEY-----`],
    ['private key', `-----BEGIN ${'OPENSSH PRIVATE'} KEY-----`],
    [
      'Azure storage key',
      `DefaultEndpointsProtocol=https;AccountName=x;Account${'Key'}=${b64(86, 3)}==`,
    ],
    ['Azure storage key', `"key": "${b64(86, 5)}=="`],
    ['SAS signature', `https://x.blob.core.windows.net/c/b?sv=2024&s${'ig'}=${b64(40, 1)}`],
    ['GitHub token', `gh${'p'}_${b64(36, 2).replace(/[+/]/g, 'a')}`],
    ['AWS access key', `AKI${'A'}${'ABCDEFGHIJKLMNOP'}`],
    ['Slack token', `xox${'b'}-1234567890-abcdefghij`],
    ['Google API key', `AI${'za'}${'Sy'}${b64(33, 4).replace(/[+/]/g, '_')}`],
    [
      'JSON web token',
      `ey${'J'}hbGciOiJIUzI1NiJ9.ey${'J'}zdWIiOiIxMjM0NTY3ODkwIn0.${b64(43, 6).replace(/[+/]/g, '-')}`,
    ],
    ['updater signing key', `untrusted comment: rsign ${'encrypted secret'} key`],
    ['connection string password', `Server=db;User Id=sa;Pass${'word'}=Hunter2-real;`],
  ];
  const mustNot = [
    `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${AZURITE_KEY};`,
    `"integrity": "sha512-${b64(86, 9)}=="`,
    'Server=db;Password=<the password>;',
    'Server=db;Password=${password};',
    'Server=db;Password=$env:CGW_SQL_PASSWORD;',
    'Server=db;Password=${{ env.MSSQL_SA_PASSWORD }};',
    'const accountKey = `AccountKey=${key}`;',
  ];
  const failures = [];
  for (const [rule, text] of must)
    if (!scanText(text).some((f) => f.rule === rule)) failures.push(`missed: ${rule} in ${text}`);
  for (const text of mustNot)
    if (scanText(text).length) failures.push(`flagged: ${text} (${scanText(text)[0].rule})`);
  for (const [name, flagged] of [
    ['signing.pfx', true],
    ['id_rsa', true],
    ['.env', true],
    ['.env.production', true],
    ['.env.example', false],
    ['tauri.conf.json', false],
  ])
    if (scanName(name).length > 0 !== flagged) failures.push(`file name: ${name}`);
  if (failures.length) {
    console.error(`Secret scanner self-test failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log(
    `Secret scanner self-test: ${must.length} samples caught, ${mustNot.length} left alone.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--selftest')) selftest();
  else {
    const { problems, scanned } = scanRepository();
    if (problems.length) {
      console.error(
        `Found what looks like a credential. Remove it (and rotate it if it was ever pushed):\n  ${problems.join('\n  ')}`,
      );
      process.exit(1);
    }
    console.log(`No credentials in ${scanned} files.`);
  }
}
