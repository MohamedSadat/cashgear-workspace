// Phase 18's budgets (IMPLEMENTATION_PLAN.md, Phase 18, Performance benchmarks), measured and gated:
//   pnpm bench:phase18                   a paid checkout's webhooks to the workspace's allowance, against
//                                        the e2e stack and the mock Paddle
//   pnpm bench:phase18 -- --local-model  the local completion model only (Phase18LocalModelBench):
//                                        needs the real package, CGW_COMPLETION_MODEL or
//                                        target/completion-model/package (node scripts/completion-model.mjs)
// The webhook part needs the server stack on 127.0.0.1:5280 (scripts/server-stack.mjs --e2e, which
// gives the API Paddle's mock and two plans) and the mock Paddle on 4291 sending its webhooks to the
// stack's API (tests/mocks/paddle/server.mjs --webhook …); each is reused when it answers, else
// started here and stopped at the end.
//
// The figures:
//   - a webhook to the allowance shown (budget 60 s): an owner's checkout of a plan, paid at the mock
//     (which sends Paddle's events, signed, to the API), until the workspace's billing names the plan
//     and its AI settings the plan's allowance, the slowest of five; Settings reads it every 5 s while
//     a checkout waits, so what a person sees is at most 5 s more;
//   - the local model (server/tests/Cgw.Tests/Phase18LocalModelBench.cs): a rewrite of 2,000
//     characters in English and in Arabic, the time to its first text and to its end, the slowest of
//     three each, with the threads the server gives it; the budgets the spike set (DECISIONS.md,
//     Phase 18), on the host's processor; its load tracked. Not in CI: the package is 2.6 GB and made
//     from the model's weights.
// Each figure is checked against its budget and, when bench/previous/phase18.json holds the last
// run on main on the same processor (CI downloads it), against that: worse by half again and by
// more than a small margin fails. Writes bench/results/phase18.json.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, answers, apiSession, newAccount, waitFor } from '../scripts/cloud-account.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const previousFile = join(root, 'bench/previous/phase18.json');
const results = join(root, 'bench/results');
const log = (line) => console.log(line);
const args = process.argv.slice(2);
const localOnly = args.includes('--local-model');
const PADDLE = process.env.CGW_MOCK_PADDLE_URL ?? 'http://127.0.0.1:4291';
const RUNS = Number(process.env.PHASE18_WEBHOOK_RUNS ?? 5);

const BUDGETS = {
  webhookToAllowanceMaxMs: { max: 60_000, unit: 'ms', slack: 2_000 },
  localRewriteEnFirstTextMaxMs: { max: 15_000, unit: 'ms', slack: 2_000 },
  localRewriteArFirstTextMaxMs: { max: 15_000, unit: 'ms', slack: 2_000 },
  localRewriteEnWholeMaxMs: { max: 90_000, unit: 'ms', slack: 10_000 },
  localRewriteArWholeMaxMs: { max: 90_000, unit: 'ms', slack: 10_000 },
  // Tracked, not budgeted.
  webhookToAllowanceMedianMs: { max: Infinity, unit: 'ms', slack: 2_000 },
  localLoadMs: { max: Infinity, unit: 'ms', slack: 5_000 },
};

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

/** One server test class in Release, with its switch on; reads the file it writes. */
function dotnetBench(cls, file, env) {
  const path = join(results, file);
  rmSync(path, { force: true });
  log(`Running ${cls} (dotnet test -c Release)`);
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
  return { ...JSON.parse(readFileSync(path, 'utf8')), testsPassed: ran.status === 0 };
}

function localModel() {
  const folder =
    process.env.CGW_COMPLETION_MODEL ??
    (existsSync(join(root, 'target/completion-model/package/cgw-model.json'))
      ? join(root, 'target/completion-model/package')
      : null);
  if (!folder)
    throw new Error(
      'The local model bench needs the real package: set CGW_COMPLETION_MODEL, or run node scripts/completion-model.mjs.',
    );
  return dotnetBench('Phase18LocalModelBench', 'phase18-local-model.json', {
    PHASE18_LOCAL_BENCH: '1',
    CGW_COMPLETION_MODEL: folder,
  });
}

const control = async (name, body = {}) =>
  (await fetch(`${PADDLE}/__mock/${name}`, { method: 'POST', body: JSON.stringify(body) })).json();

/** A checkout paid at the mock, until the API names the plan and its allowance. */
async function webhookToAllowance() {
  const account = await newAccount('Billing bench');
  const api = await apiSession(account);
  const times = [];
  try {
    for (let run = 0; run < RUNS; run++) {
      const workspace = await api.post('/api/v1/workspaces', {
        id: randomUUID(),
        name: `Billing bench ${run}`,
        icon: null,
      });
      const id = workspace.id;
      const { url } = await api.post(`/api/v1/workspaces/${id}/billing/checkout`, {
        planId: 'team',
        language: 'en',
      });
      const transaction = new URL(url).searchParams.get('_ptxn');
      const paidAt = Date.now();
      const paid = await control('pay', { transactionId: transaction });
      if (!paid.subscription) throw new Error(`The mock did not pay ${transaction}`);
      for (;;) {
        const [billing, ai] = await Promise.all([
          api.get(`/api/v1/workspaces/${id}/billing`),
          api.get(`/api/v1/workspaces/${id}/ai-settings`),
        ]);
        if (billing.planId === 'team' && Number(ai.subscription?.allowance) === 10_000_000) break;
        if (Date.now() - paidAt > 120_000) throw new Error('The plan never reached the allowance');
        await new Promise((done) => setTimeout(done, 100));
      }
      times.push(Date.now() - paidAt);
    }
  } finally {
    await api.dispose();
  }
  const sorted = [...times].sort((a, b) => a - b);
  return { times, median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
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
  if (!localOnly) {
    await startIfMissing(`${PADDLE}/__mock/state`, 'the mock Paddle (4291)', process.execPath, [
      join(root, 'tests/mocks/paddle/server.mjs'),
      '--webhook',
      `${API}/api/v1/billing/paddle`,
    ]);
    await startIfMissing(
      `${API}/health/live`,
      'the server stack (scripts/server-stack.mjs --e2e)',
      process.execPath,
      [join(root, 'scripts/server-stack.mjs'), '--e2e'],
      { waitMs: 600000 },
    );
    out.webhook = await webhookToAllowance();
  } else out.local = localModel();
} finally {
  for (const child of started.reverse()) stopTree(child);
}

const figures = {
  webhookToAllowanceMaxMs: out.webhook?.max,
  webhookToAllowanceMedianMs: out.webhook?.median,
  localRewriteEnFirstTextMaxMs: out.local?.en?.firstTextMaxMs,
  localRewriteArFirstTextMaxMs: out.local?.ar?.firstTextMaxMs,
  localRewriteEnWholeMaxMs: out.local?.en?.wholeMaxMs,
  localRewriteArWholeMaxMs: out.local?.ar?.wholeMaxMs,
  localLoadMs: out.local?.loadMs,
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
writeFileSync(join(results, 'phase18.json'), JSON.stringify(out, null, 2) + '\n');
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
const testsFailed = out.local && !out.local.testsPassed;
if (testsFailed) log('A server benchmark test failed (see its output above).');
process.exitCode = gate.some((g) => g.overBudget || g.regressed) || testsFailed ? 1 : 0;
