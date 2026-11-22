// Phase 14's budgets (IMPLEMENTATION_PLAN.md, Phase 14, Performance benchmarks), measured and gated:
//   pnpm bench:phase14                  a published page at its own host name, and the server's file check
//   pnpm bench:phase14 -- --server      the server's file check only (Phase14Bench)
//   pnpm bench:phase14 -- --no-server   without it
// The site part needs the server stack on 127.0.0.1:5280 with the Sites process on localhost:5290
// (scripts/server-stack.mjs --e2e), the mock ACME server its worker gets certificates from
// (tests/mocks/acme/server.mjs, 4289, fetching challenges from 5290) and the mock provider's DNS
// stand-in (tests/mocks/oidc/server.mjs, 4287); each is reused when it answers, else started here and
// stopped at the end. No browser: the site is read over HTTP with no account.
//
// The figures:
//   - a published page of 2,000 blocks at its own host name (bench/phase14-site.mjs): first byte p95
//     from the Sites process's cache, the rate limiter and the host's lookup included, budget 200 ms
//     (Phase 9's); its first, fresh, answer tracked;
//   - a site's or share link's check of a file in a database of 50,000 rows holding 100,000 files
//     (server/tests/Cgw.Tests/Phase14Bench.cs, `dotnet test -c Release`), by the index of rows'
//     files, p95, budget 20 ms; a file no row holds, and 0.13.0's scan of the rows' values, tracked.
//     On LocalDB unless CGW_TEST_SQL names a server; PHASE14_ROWS makes it smaller for a quick run.
// Each figure is checked against its budget and, when bench/previous/phase14.json holds the last
// run on main on the same processor (CI downloads it), against that: worse by half again and by
// more than a small margin fails. Writes bench/results/phase14.json.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, answers, waitFor } from '../scripts/cloud-account.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const previousFile = join(root, 'bench/previous/phase14.json');
const results = join(root, 'bench/results');
const log = (line) => console.log(line);
const args = process.argv.slice(2);
const serverOnly = args.includes('--server');
const withServer = !args.includes('--no-server');
const withSite = !serverOnly;
const ACME = 'http://127.0.0.1:4289';
const DNS = 'http://127.0.0.1:4287';

/** Budgets, with the margin a regression must also exceed to fail (runners are noisy). */
const BUDGETS = {
  domainCachedFirstByteP95Ms: { max: 200, unit: 'ms', slack: 30 },
  fileCheckP95Ms: { max: 20, unit: 'ms', slack: 5 },
  // Tracked, not budgeted.
  domainFreshFirstByteP95Ms: { max: Infinity, unit: 'ms', slack: 200 },
  fileCheckMissP95Ms: { max: Infinity, unit: 'ms', slack: 5 },
  fileScanP95Ms: { max: Infinity, unit: 'ms', slack: 100 },
};

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

/** Runs a piece in its own process and reads the file it writes. */
function piece(script, file) {
  const path = join(results, file);
  rmSync(path, { force: true });
  log(`\nRunning ${script}`);
  const ran = spawnSync(process.execPath, [join(root, script)], { cwd: root, stdio: 'inherit' });
  if (!existsSync(path)) throw new Error(`${script} wrote nothing (${file}), exit ${ran.status}`);
  return { ...JSON.parse(readFileSync(path, 'utf8')), exitCode: ran.status };
}

/** One server test class in Release, with its switch on; reads the file it writes. */
function dotnetBench(cls, file, env) {
  const ffi = join(
    root,
    'target/ffi',
    process.platform === 'win32' ? 'cgw_ydoc.dll' : 'libcgw_ydoc.so',
  );
  if (!existsSync(ffi)) {
    log('Building cgw-ydoc for the worker');
    const built = spawnSync('cargo', ['build', '-p', 'cgw-ydoc', '--profile', 'ffi'], {
      cwd: root,
      stdio: 'inherit',
    });
    if (built.status !== 0) throw new Error('cargo build -p cgw-ydoc --profile ffi failed');
  }
  const path = join(results, file);
  rmSync(path, { force: true });
  log(`Running ${cls} (dotnet test -c Release)`);
  const started = Date.now();
  const ran = spawnSync(
    'dotnet',
    [
      'test',
      '--solution',
      'server/Cgw.Server.slnx',
      '-c',
      'Release',
      '--',
      '--filter-class',
      `*${cls}`,
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CGW_TEST_LOG: process.env.CGW_TEST_LOG ?? 'Error', ...env },
    },
  );
  if (!existsSync(path)) throw new Error(`${cls} wrote nothing (${file})`);
  return {
    ...JSON.parse(readFileSync(path, 'utf8')),
    testsPassed: ran.status === 0,
    minutes: Math.round((Date.now() - started) / 6000) / 10,
  };
}

// ------------------------------------------------------------------ main
mkdirSync(results, { recursive: true });
const out = {
  at: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? null,
  machine: {
    cpu: cpus()[0]?.model?.trim() ?? null,
    threads: cpus().length,
    memoryGB: Math.round(totalmem() / 1073741824),
    os: `${process.platform} ${process.arch}`,
  },
};
const started = [];
const startIfMissing = async (url, what, command, commandArgs, options = {}) => {
  if (await answers(url)) return log(`Reusing ${what}`);
  log(`Starting ${what}`);
  started.push(spawn(command, commandArgs, { cwd: root, stdio: 'ignore', ...options }));
  await waitFor(url, options.waitMs ?? 60000);
};
try {
  if (withSite) {
    await startIfMissing(`${ACME}/__mock/state`, 'the mock ACME server (4289)', process.execPath, [
      join(root, 'tests/mocks/acme/server.mjs'),
      '--challenge-port',
      '5290',
    ]);
    await startIfMissing(
      `${DNS}/__mock/state`,
      'the mock provider and its DNS stand-in (4287)',
      process.execPath,
      [join(root, 'tests/mocks/oidc/server.mjs')],
    );
    await startIfMissing(
      `${API}/health/live`,
      'the server stack (scripts/server-stack.mjs --e2e)',
      process.execPath,
      [join(root, 'scripts/server-stack.mjs'), '--e2e'],
      { waitMs: 600000 },
    );
    out.site = piece('bench/phase14-site.mjs', 'phase14-site.json');
  }
  if (withServer)
    out.server = dotnetBench('Phase14Bench', 'phase14-server.json', { PHASE14_BENCH: '1' });
} finally {
  for (const child of started.reverse()) stopTree(child);
}

const figures = {
  domainCachedFirstByteP95Ms: out.site?.figures?.domainCachedFirstByteP95Ms,
  domainFreshFirstByteP95Ms: out.site?.figures?.domainFreshFirstByteP95Ms,
  fileCheckP95Ms: out.server?.fileCheck?.p95,
  fileCheckMissP95Ms: out.server?.fileCheckMiss?.p95,
  fileScanP95Ms: out.server?.scan?.p95,
};
const last = existsSync(previousFile) ? JSON.parse(readFileSync(previousFile, 'utf8')) : null;
const sameMachine = !!last && last.machine?.cpu === out.machine.cpu;
const previous = sameMachine ? (last.figures ?? null) : null;
const gate = [];
for (const [name, value] of Object.entries(figures)) {
  if (value === undefined || value === null) continue;
  const budget = BUDGETS[name];
  const before = previous?.[name];
  const overBudget = value > budget.max;
  const regressed =
    typeof before === 'number' && value > before * 1.5 && value - before > budget.slack;
  gate.push({
    name,
    value,
    budget: Number.isFinite(budget.max) ? budget.max : null,
    unit: budget.unit,
    previous: before ?? null,
    overBudget,
    regressed,
  });
}
out.figures = figures;
out.gate = gate;
writeFileSync(join(results, 'phase14.json'), JSON.stringify(out, null, 2) + '\n');
log('\nBudget                              value      budget   last main');
for (const g of gate)
  log(
    `${g.overBudget || g.regressed ? 'FAIL' : 'ok  '} ${g.name.padEnd(33)} ${String(g.value).padStart(7)} ${g.unit.padEnd(3)} ${String(g.budget ?? 'none').padStart(7)}   ${g.previous ?? '-'}${g.regressed ? '  (regressed)' : ''}`,
  );
if (!last) log('(No run on main to compare with: budgets only.)');
else if (!sameMachine)
  log(
    `(The last run on main ran on ${last.machine?.cpu ?? 'a processor it did not record'}, this one on ${out.machine.cpu}: budgets only.)`,
  );
const failed = (out.server && !out.server.testsPassed) || (out.site && out.site.exitCode !== 0);
if (failed) log('A part of the benchmark failed (see its output above).');
process.exitCode = gate.some((g) => g.overBudget || g.regressed) || failed ? 1 : 0;
