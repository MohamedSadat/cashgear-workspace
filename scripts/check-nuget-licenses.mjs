// NuGet half of the licence gate, beside the npm and cargo halves: every package the server
// restores (shipped by src projects, or used by tests) is checked against license-policy.json.
// Shipped packages must be on the allow-list (or a named exception); no package may be under a
// denied licence.
//   node scripts/check-nuget-licenses.mjs                      check the server solution
//   node scripts/check-nuget-licenses.mjs --listing <file>     check a saved listing (self-test)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { satisfiable } from './license-policy.mjs';
import { root } from './lib.mjs';

const policy = JSON.parse(readFileSync(join(root, 'license-policy.json'), 'utf8'));
const exceptions = new Map((policy.nugetExceptions ?? []).map((e) => [e.package.toLowerCase(), e]));
const cache = process.env.NUGET_PACKAGES ?? join(homedir(), '.nuget', 'packages');

/** [{ id, version, license, shipped }] from `dotnet list package`. */
function restore() {
  const result = spawnSync(
    'dotnet',
    [
      'list',
      join(root, 'server', 'Cgw.Server.slnx'),
      'package',
      '--include-transitive',
      '--format',
      'json',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error('dotnet list package failed: ' + result.stderr + result.stdout);
  const listing = JSON.parse(result.stdout);
  const packages = new Map();
  for (const project of listing.projects ?? []) {
    const shipped = !/[\\/]tests[\\/]/.test(project.path);
    for (const framework of project.frameworks ?? [])
      for (const p of [
        ...(framework.topLevelPackages ?? []),
        ...(framework.transitivePackages ?? []),
      ]) {
        const key = `${p.id}@${p.resolvedVersion}`;
        const known = packages.get(key);
        packages.set(key, {
          id: p.id,
          version: p.resolvedVersion,
          shipped: shipped || !!known?.shipped,
        });
      }
  }
  return [...packages.values()].map((p) => ({ ...p, license: licenseOf(p.id, p.version) }));
}

function licenseOf(id, version) {
  const file = join(cache, id.toLowerCase(), version.toLowerCase(), `${id.toLowerCase()}.nuspec`);
  if (!existsSync(file)) return 'UNKNOWN (not restored)';
  const nuspec = readFileSync(file, 'utf8');
  const expression = nuspec.match(/<license\s+type="expression"\s*>([^<]+)<\/license>/)?.[1];
  if (expression) return expression.trim();
  const fileLicense = nuspec.match(/<license\s+type="file"\s*>([^<]+)<\/license>/)?.[1];
  return fileLicense ? `FILE ${fileLicense.trim()}` : 'UNKNOWN';
}

const listingArg = process.argv.indexOf('--listing');
const packages =
  listingArg > 0 ? JSON.parse(readFileSync(process.argv[listingArg + 1], 'utf8')) : restore();

const denied = (license) =>
  policy.deny.some((prefix) => license.toUpperCase().includes(prefix.toUpperCase()));
const allowed = (license) => {
  try {
    return satisfiable(license, (name) => policy.allow.includes(name));
  } catch {
    return false;
  }
};

const violations = [];
for (const p of packages) {
  const name = `${p.id}@${p.version}`;
  const exception = exceptions.get(p.id.toLowerCase());
  if (denied(p.license)) violations.push(`${name}: ${p.license} is denied`);
  else if (exception) continue;
  else if (p.shipped && !allowed(p.license))
    violations.push(`${name}: ${p.license} is not on the allow-list`);
}
if (violations.length) {
  console.error('NuGet licence check failed:\n  ' + violations.join('\n  '));
  process.exit(1);
}
console.log(`NuGet licence check passed for ${packages.length} packages.`);
