// Phase 10's budgets (IMPLEMENTATION_PLAN.md, Phase 10, Performance benchmarks), measured and gated:
//   pnpm bench:phase10                   the review of 500 changed customers and ten plugin frames
//                                        in Chrome, and the server's retrieval by meaning
//   pnpm bench:phase10 -- --server       the server's retrieval only (Phase10Bench)
//   pnpm bench:phase10 -- --no-server    without it
// The client part needs `pnpm build`; the web app under vite preview on 127.0.0.1:4273, the server
// stack on 127.0.0.1:5280 with the Sites process's plugins host on localhost:5291
// (scripts/server-stack.mjs --e2e), the mock ERP and the mock AI provider are reused when they
// answer, else started here and stopped at the end.
//
// The figures:
//   - the review of 500 changed customers, less the ERP's dry run (bench/phase10-erp.mjs): p95, budget
//     2 s, the ERP's own time and the total tracked;
//   - a page with 10 plugin frames (bench/phase10-plugins.mjs): typing in the paragraph between the
//     fifth and sixth frames, the editor's work per key and the key to the next frame, Phase 1's
//     keystroke budget;
//   - retrieval by meaning over 100,000 chunks in one workspace (server/tests/Cgw.Tests/Phase10Bench.cs,
//     `dotnet test -c Release`): the route's p95 warm and after a change of a few pages, less the
//     provider's time to embed the question, budget 300 ms; the first search's load of the copy
//     tracked. On LocalDB unless CGW_TEST_SQL names a server.
// Each figure is checked against its budget and, when bench/previous/phase10.json holds the last
// run on main on the same processor (CI downloads it), against that: worse by half again and by
// more than a small margin fails. Writes bench/results/phase10.json.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, APP, answers, waitFor } from '../scripts/cloud-account.mjs';
import { ERP_API, ERP_BUDGETS, MOCK_AI } from './phase10-erp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const previousFile = join(root, 'bench/previous/phase10.json');
const results = join(root, 'bench/results');
const log = (line) => console.log(line);
const args = process.argv.slice(2);
const serverOnly = args.includes('--server');
const withServer = !args.includes('--no-server');
const withWeb = !serverOnly;

// The keystroke budget on CI's hosted runner is a frame (bench/phase5.mjs's note, Phase 6), as
// bench/phase10-plugins.mjs gates it.
const KEY_WORK_MAX = process.env.CI ? 16 : 8;
/** Budgets, with the margin a regression must also exceed to fail (runners are noisy). */
const BUDGETS = {
  ...ERP_BUDGETS,
  key10PluginsWorkP95: { max: KEY_WORK_MAX, unit: 'ms', slack: 2 },
  key10PluginsFrameP95: { max: 33, unit: 'ms', slack: 5 },
  meaningWarmP95Ms: { max: 300, unit: 'ms', slack: 40 },
  meaningAfterChangeP95Ms: { max: 300, unit: 'ms', slack: 40 },
  // Tracked, not budgeted.
  meaningFirstLoadMs: { max: Infinity, unit: 'ms', slack: 2000 },
  meaningProviderP95Ms: { max: Infinity, unit: 'ms', slack: 50 },
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

// ------------------------------------------------------------------ the server part
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
  const file = join(results, 'phase10-server.json');
  rmSync(file, { force: true });
  log('Running the server benchmark (dotnet test -c Release, Phase10Bench)');
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
      '*Phase10Bench*',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        PHASE10_BENCH: '1',
        CGW_TEST_LOG: process.env.CGW_TEST_LOG ?? 'Error',
      },
    },
  );
  if (!existsSync(file))
    throw new Error('The server benchmark wrote nothing (phase10-server.json)');
  return {
    ...JSON.parse(readFileSync(file, 'utf8')),
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
  if (withWeb) {
    if (!existsSync(join(root, 'apps/web/dist/index.html')))
      throw new Error('Run pnpm build first.');
    await startIfMissing(`${MOCK_AI}/__mock/state`, 'the mock AI provider', process.execPath, [
      join(root, 'tests/mocks/ai/server.mjs'),
    ]);
    await startIfMissing(
      `${API}/health/live`,
      'the server stack (scripts/server-stack.mjs --e2e)',
      process.execPath,
      [join(root, 'scripts/server-stack.mjs'), '--e2e'],
      { waitMs: 600000 },
    );
    // The stack binds the plugins host (localhost:5291) with the Sites process; the plugin piece fails on
    // its first frame if it is missing.
    await startIfMissing(
      APP,
      `vite preview on ${APP}`,
      process.execPath,
      [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview'],
      { cwd: join(root, 'apps/web') },
    );
    await startIfMissing(`${ERP_API}/__mock/state`, 'the mock ERP', process.execPath, [
      join(root, 'tests/mocks/erp/server.mjs'),
      '--workspace-url',
      'http://127.0.0.1:4273',
    ]);
    out.erp = piece('bench/phase10-erp.mjs', 'phase10-erp.json');
    out.plugins = piece('bench/phase10-plugins.mjs', 'phase10-plugins.json');
  }
  if (withServer) out.server = server();
} finally {
  for (const child of started.reverse()) stopTree(child);
}

const figures = {
  ...(out.erp?.figures ?? {}),
  ...(out.plugins?.figures ?? {}),
  meaningWarmP95Ms: out.server?.warm?.p95,
  meaningAfterChangeP95Ms: out.server?.afterChange?.p95,
  meaningFirstLoadMs: out.server?.firstLoad?.ms,
  meaningProviderP95Ms: out.server?.providerMs?.p95,
};
const last = existsSync(previousFile) ? JSON.parse(readFileSync(previousFile, 'utf8')) : null;
const sameMachine = !!last && last.machine?.cpu === out.machine.cpu;
const previous = sameMachine ? (last.figures ?? null) : null;
const gate = [];
for (const [name, value] of Object.entries(figures)) {
  if (value === undefined || value === null) continue;
  const budget = BUDGETS[name];
  if (!budget) continue;
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
writeFileSync(join(results, 'phase10.json'), JSON.stringify(out, null, 2) + '\n');
log('\nBudget                            value      budget   last main');
for (const g of gate)
  log(
    `${g.overBudget || g.regressed ? 'FAIL' : 'ok  '} ${g.name.padEnd(31)} ${String(g.value).padStart(7)} ${g.unit.padEnd(5)} ${String(g.budget ?? 'none').padStart(7)}   ${g.previous ?? '-'}${g.regressed ? '  (regressed)' : ''}`,
  );
if (!last) log('(No run on main to compare with: budgets only.)');
else if (!sameMachine)
  log(
    `(The last run on main ran on ${last.machine?.cpu ?? 'a processor it did not record'}, this one on ${out.machine.cpu}: budgets only.)`,
  );
const testsFailed = out.server && !out.server.testsPassed;
if (testsFailed) log('The server benchmark test failed (see its output above).');
process.exitCode = gate.some((g) => g.overBudget || g.regressed) || testsFailed ? 1 : 0;
