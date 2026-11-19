// Phase 11's budgets (IMPLEMENTATION_PLAN.md, Phase 11, Performance benchmarks), measured and gated:
//   pnpm bench:phase11                   the server's budgets (Phase11Bench); there is no client part,
//                                        so it takes no part flags (`--server` is accepted and means
//                                        the same, for CI's habit of passing it)
// It runs server/tests/Cgw.Tests/Phase11Bench.cs (`dotnet test -c Release`, PHASE11_BENCH=1) in
// process on SQL Server, Azurite and the mock OpenID Connect provider the test fixture starts; on
// LocalDB unless CGW_TEST_SQL names a server (CI's has full-text: CGW_TEST_FULLTEXT=required). Needs
// .NET 10 and cargo (cgw-ydoc's library is built when target/ffi lacks it).
//
// The figures:
//   - at 10,000 pages (a tree up to 8 deep, 1 % restricted) for a member in 20 of 50 groups, with 500
//     group rows, 300 people's and 100 the workspace's: search p95 (Phase 2's palette queries, English
//     and Arabic), budget 300 ms; the change feed of 1,000 changes made through the operations route
//     under pages holding the member's groups' rows, budget 500 ms; the tree (its access read is
//     AllLevelsAsync), tracked; search and the tree for a member in no group, tracked beside them;
//   - a sign-in by passkey, the API's own time (the options and the answer's POST; the software
//     authenticator apart), budget 200 ms;
//   - a sign-in through single sign-on, the API's own time (the sign-on POST and the callback, less
//     the time the API waits on the provider), budget 200 ms; the provider's time and a first sign-in
//     (the account made, the membership joined) tracked.
// PHASE11_PAGES, PHASE11_GROUPS, PHASE11_MEMBER_GROUPS, PHASE11_GROUP_ROWS, PHASE11_SEARCH_ROUNDS,
// PHASE11_TREES, PHASE11_FEEDS, PHASE11_SIGNIN_WARMUP, PHASE11_SIGNIN_RUNS and PHASE11_SSO_FIRSTS
// shape the runs (Phase11Bench.cs has the defaults).
// Each figure is checked against its budget and, when bench/previous/phase11.json holds the last run
// on main on the same processor (CI downloads it), against that: worse by half again and by more
// than a small margin fails. Writes bench/results/phase11.json.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const previousFile = join(root, 'bench/previous/phase11.json');
const results = join(root, 'bench/results');
const log = (line) => console.log(line);
const unknown = process.argv.slice(2).filter((a) => a !== '--server');
if (unknown.length > 0) {
  console.error(
    `bench/phase11.mjs takes no options but --server (it has no client part): ${unknown.join(' ')}`,
  );
  process.exit(2);
}

/** Budgets, with the margin a regression must also exceed to fail (runners are noisy). */
const BUDGETS = {
  groupsSearchP95Ms: { max: 300, unit: 'ms', slack: 30 },
  groupsFeed1000P95Ms: { max: 500, unit: 'ms', slack: 50 },
  passkeySignInP95Ms: { max: 200, unit: 'ms', slack: 20 },
  ssoSignInP95Ms: { max: 200, unit: 'ms', slack: 20 },
  // Tracked, not budgeted.
  groupsTreeP95Ms: { max: Infinity, unit: 'ms', slack: 100 },
  noGroupSearchP95Ms: { max: Infinity, unit: 'ms', slack: 30 },
  noGroupTreeP95Ms: { max: Infinity, unit: 'ms', slack: 100 },
  ssoFirstSignInP95Ms: { max: Infinity, unit: 'ms', slack: 30 },
  ssoProviderP95Ms: { max: Infinity, unit: 'ms', slack: 20 },
};

function server() {
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
  const file = join(results, 'phase11-server.json');
  rmSync(file, { force: true });
  log('Running the server benchmark (dotnet test -c Release, Phase11Bench)');
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
      '*Phase11Bench*',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        PHASE11_BENCH: '1',
        CGW_TEST_LOG: process.env.CGW_TEST_LOG ?? 'Error',
      },
    },
  );
  if (!existsSync(file))
    throw new Error('The server benchmark wrote nothing (phase11-server.json)');
  return {
    ...JSON.parse(readFileSync(file, 'utf8')),
    testsPassed: ran.status === 0,
    minutes: Math.round((Date.now() - started) / 6000) / 10,
  };
}

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
out.server = server();

const s = out.server;
const figures = {
  groupsSearchP95Ms: s.groups?.search?.member?.p95,
  groupsFeed1000P95Ms: s.groups?.feed1000?.member?.p95,
  passkeySignInP95Ms: s.passkey?.signIn?.p95,
  ssoSignInP95Ms: s.sso?.signIn?.p95,
  groupsTreeP95Ms: s.groups?.tree?.member?.p95,
  noGroupSearchP95Ms: s.groups?.search?.noGroup?.p95,
  noGroupTreeP95Ms: s.groups?.tree?.noGroup?.p95,
  ssoFirstSignInP95Ms: s.sso?.firstSignIn?.p95,
  ssoProviderP95Ms: s.sso?.signIn?.provider?.p95,
};
const last = existsSync(previousFile) ? JSON.parse(readFileSync(previousFile, 'utf8')) : null;
const sameMachine = !!last && last.machine?.cpu === out.machine.cpu;
const previous = sameMachine ? (last.figures ?? null) : null;
const gate = [];
const missing = [];
for (const [name, value] of Object.entries(figures)) {
  const budget = BUDGETS[name];
  if (value === undefined || value === null) {
    // A budgeted figure the run did not write fails: its test did not get that far.
    if (Number.isFinite(budget.max)) missing.push(name);
    continue;
  }
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
out.missing = missing;
writeFileSync(join(results, 'phase11.json'), JSON.stringify(out, null, 2) + '\n');
log('\nBudget                            value      budget   last main');
for (const g of gate)
  log(
    `${g.overBudget || g.regressed ? 'FAIL' : 'ok  '} ${g.name.padEnd(31)} ${String(g.value).padStart(7)} ${g.unit.padEnd(5)} ${String(g.budget ?? 'none').padStart(7)}   ${g.previous ?? '-'}${g.regressed ? '  (regressed)' : ''}`,
  );
for (const name of missing) log(`FAIL ${name.padEnd(31)} not measured`);
if (!last) log('(No run on main to compare with: budgets only.)');
else if (!sameMachine)
  log(
    `(The last run on main ran on ${last.machine?.cpu ?? 'a processor it did not record'}, this one on ${out.machine.cpu}: budgets only.)`,
  );
if (!s.testsPassed) log('The server benchmark test failed (see its output above).');
process.exitCode =
  gate.some((g) => g.overBudget || g.regressed) || missing.length > 0 || !s.testsPassed ? 1 : 0;
