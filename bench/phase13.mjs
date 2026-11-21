// Phase 13's budgets (IMPLEMENTATION_PLAN.md, Phase 13, Performance benchmarks), measured and gated:
//   pnpm bench:phase13                   typing between ten networked plugin frames in Chrome, and the
//                                        server's retrieval by meaning over 1,000,000 chunks
//   pnpm bench:phase13 -- --server       the server's retrieval only (Phase13Bench)
//   pnpm bench:phase13 -- --no-server    without it
//   pnpm bench:phase13 -- --local-model  the local model only (Phase13LocalModelBench): needs the real
//                                        package, CGW_LOCAL_MODEL or target/local-model/package
//                                        (node scripts/local-model.mjs makes it)
// The client part needs `pnpm build`; the web app under vite preview on 127.0.0.1:4273, the server
// stack on 127.0.0.1:5280 with the Sites process's plugins host on localhost:5291
// (scripts/server-stack.mjs --e2e) and the mock host the plugin reaches (tests/mocks/net/server.mjs,
// 4288) are reused when they answer, else started here and stopped at the end.
//
// The figures:
//   - a page with 10 networked plugin frames (bench/phase10-plugins.mjs --network): typing in the
//     paragraph between the fifth and sixth frames, the editor's work per key and the key to the next
//     frame, Phase 10's budget (Phase 1's keystroke budget);
//   - retrieval by meaning over 1,000,000 chunks in one workspace (server/tests/Cgw.Tests/Phase13Bench.cs,
//     `dotnet test -c Release`): the route's p95 warm and after a change of five pages, less the
//     provider's time to embed the question, budget 300 ms; the approximate index's recall of the
//     exact search's first ten pages, at least 0.95; the first load and the copy's memory tracked.
//     On LocalDB unless CGW_TEST_SQL names a server; PHASE13_CHUNKS makes it smaller for a quick run;
//   - the local model (server/tests/Cgw.Tests/Phase13LocalModelBench.cs): a 2,000-character chunk in
//     English and in Arabic, and a question, p95, with the threads the server gives it; the budgets the
//     spike set (DECISIONS.md, Phase 13), on the host's processor; its load tracked. Not in CI: the
//     package is 572 MB and made from the model's weights.
// Each figure is checked against its budget and, when bench/previous/phase13.json holds the last
// run on main on the same processor (CI downloads it), against that: worse by half again and by
// more than a small margin fails. Writes bench/results/phase13.json.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, APP, answers, waitFor } from '../scripts/cloud-account.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const previousFile = join(root, 'bench/previous/phase13.json');
const results = join(root, 'bench/results');
const log = (line) => console.log(line);
const args = process.argv.slice(2);
const localOnly = args.includes('--local-model');
const serverOnly = args.includes('--server');
const withServer = !localOnly && !args.includes('--no-server');
const withWeb = !localOnly && !serverOnly;
const NET = 'http://127.0.0.1:4288';

// The keystroke budget on CI's hosted runner is a frame (bench/phase5.mjs's note, Phase 6), as
// bench/phase10-plugins.mjs gates it.
const KEY_WORK_MAX = process.env.CI ? 16 : 8;
/**
 * Budgets, with the margin a regression must also exceed to fail (runners are noisy). `min` is a
 * floor (recall), never compared with the last run.
 */
const BUDGETS = {
  key10NetworkedPluginsWorkP95: { max: KEY_WORK_MAX, unit: 'ms', slack: 2 },
  key10NetworkedPluginsFrameP95: { max: 33, unit: 'ms', slack: 5 },
  meaningMillionWarmP95Ms: { max: 300, unit: 'ms', slack: 40 },
  meaningMillionAfterChangeP95Ms: { max: 300, unit: 'ms', slack: 40 },
  meaningMillionRecall: { min: 0.95, unit: '' },
  localChunkP95Ms: { max: 1500, unit: 'ms', slack: 150 },
  localQuestionP95Ms: { max: 100, unit: 'ms', slack: 15 },
  // Tracked, not budgeted.
  meaningMillionFirstLoadMs: { max: Infinity, unit: 'ms', slack: 5000 },
  meaningMillionCopyMb: { max: Infinity, unit: 'MB', slack: 100 },
  meaningMillionProviderP95Ms: { max: Infinity, unit: 'ms', slack: 50 },
  localLoadMs: { max: Infinity, unit: 'ms', slack: 2000 },
};

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

/** Runs a piece in its own process and reads the file it writes. */
function piece(script, pieceArgs, file) {
  const path = join(results, file);
  rmSync(path, { force: true });
  log(`\nRunning ${script} ${pieceArgs.join(' ')}`);
  const ran = spawnSync(process.execPath, [join(root, script), ...pieceArgs], {
    cwd: root,
    stdio: 'inherit',
  });
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

function localModel() {
  const folder =
    process.env.CGW_LOCAL_MODEL ??
    (existsSync(join(root, 'target/local-model/package/cgw-model.json'))
      ? join(root, 'target/local-model/package')
      : null);
  if (!folder)
    throw new Error(
      'The local model bench needs the real package: set CGW_LOCAL_MODEL, or run node scripts/local-model.mjs.',
    );
  return dotnetBench('Phase13LocalModelBench', 'phase13-local-model.json', {
    PHASE13_LOCAL_BENCH: '1',
    CGW_LOCAL_MODEL: folder,
  });
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
    await startIfMissing(`${NET}/__mock/state`, 'the mock host (4288)', process.execPath, [
      join(root, 'tests/mocks/net/server.mjs'),
    ]);
    await startIfMissing(
      `${API}/health/live`,
      'the server stack (scripts/server-stack.mjs --e2e)',
      process.execPath,
      [join(root, 'scripts/server-stack.mjs'), '--e2e'],
      { waitMs: 600000 },
    );
    await startIfMissing(
      APP,
      `vite preview on ${APP}`,
      process.execPath,
      [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview'],
      { cwd: join(root, 'apps/web') },
    );
    out.plugins = piece('bench/phase10-plugins.mjs', ['--network'], 'phase13-plugins.json');
  }
  if (withServer)
    out.server = dotnetBench('Phase13Bench', 'phase13-server.json', { PHASE13_BENCH: '1' });
  if (localOnly) out.local = localModel();
} finally {
  for (const child of started.reverse()) stopTree(child);
}

const figures = {
  ...(out.plugins?.figures ?? {}),
  meaningMillionWarmP95Ms: out.server?.warm?.p95,
  meaningMillionAfterChangeP95Ms: out.server?.afterChange?.p95,
  meaningMillionRecall: out.server?.recall?.mean,
  meaningMillionFirstLoadMs: out.server?.firstLoad?.ms,
  meaningMillionCopyMb: out.server?.copyMb,
  meaningMillionProviderP95Ms: out.server?.providerMs?.p95,
  localChunkP95Ms: out.local?.chunkP95,
  localQuestionP95Ms: out.local?.questionP95,
  localLoadMs: out.local?.load?.ms,
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
  const floor = budget.min !== undefined;
  const overBudget = floor ? value < budget.min : value > budget.max;
  const regressed =
    !floor && typeof before === 'number' && value > before * 1.5 && value - before > budget.slack;
  gate.push({
    name,
    value,
    budget: floor ? budget.min : Number.isFinite(budget.max) ? budget.max : null,
    unit: budget.unit,
    previous: before ?? null,
    overBudget,
    regressed,
  });
}
out.figures = figures;
out.gate = gate;
writeFileSync(join(results, 'phase13.json'), JSON.stringify(out, null, 2) + '\n');
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
const testsFailed =
  (out.server && !out.server.testsPassed) || (out.local && !out.local.testsPassed);
if (testsFailed) log('A server benchmark test failed (see its output above).');
process.exitCode = gate.some((g) => g.overBudget || g.regressed) || testsFailed ? 1 : 0;
