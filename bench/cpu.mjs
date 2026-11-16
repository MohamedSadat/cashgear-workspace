// What the machine spent while a bench typed (Phase 8: why CI's work per key doubled from Phase 5
// to Phase 6): the processor time each part of the stack used, read before and after, so a run
// says whether the page's thread shared its processors with the server's work for each push.
// Used by bench/phase5.mjs and bench/phase6.mjs; Windows only (CIM's process times), null
// elsewhere or if the query fails.
import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';

const round = (n) => Math.round(n * 10) / 10;

/** Which part of the stack a process is, by its name and command line; null for none. */
function partOf(name, command) {
  switch (name) {
    case 'dotnet.exe':
      return /Cgw\.Api/.test(command) ? 'api' : /Cgw\.Worker/.test(command) ? 'worker' : null;
    case 'sqlservr.exe':
      return 'sql';
    case 'node.exe':
      // The mocks (Sheet, ERP, AI), and the bench itself (Phase 6's editors run in it).
      return /tests[\\/]mocks/.test(command)
        ? 'mocks'
        : /bench[\\/]phase/.test(command)
          ? 'bench'
          : null;
    case 'cgw-desktop.exe':
      return 'browser';
    default:
      // chrome.exe and msedgewebview2.exe of a bench's own profile (its processes name it), not
      // any other browser on the machine.
      return /playwright_chromium|cgw-phase\d-desktop/.test(command) ? 'browser' : null;
  }
}

/** Every part's processor time so far (ms), and the machine's busy and total time. */
export function stackCpu() {
  if (process.platform !== 'win32') return null;
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|msedgewebview2|cgw-desktop|dotnet|sqlservr|node)\\.exe$' } | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.Name, ($_.UserModeTime + $_.KernelModeTime), $_.CommandLine }",
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  if (ps.status !== 0) return null;
  const parts = {};
  for (const line of ps.stdout.split(/\r?\n/)) {
    const [pid, name, ticks, ...rest] = line.split('|');
    if (!pid || !ticks) continue;
    const part = partOf(name, rest.join('|'));
    // CIM gives 100 ns ticks.
    if (part) parts[`${part}:${pid}`] = Number(ticks) / 10000;
  }
  const machine = cpus().reduce(
    (sum, c) => ({
      busy: sum.busy + c.times.user + c.times.sys + c.times.irq + c.times.nice,
      all: sum.all + c.times.user + c.times.sys + c.times.irq + c.times.nice + c.times.idle,
    }),
    { busy: 0, all: 0 },
  );
  return { at: performance.now(), parts, machine };
}

/**
 * Each part's processor time between two `stackCpu` reads, as a percentage of one processor (a
 * part over 100 kept more than one busy), and how busy the whole machine was.
 */
export function cpuBetween(before, after) {
  if (!before || !after) return null;
  const seconds = (after.at - before.at) / 1000;
  const used = {};
  for (const [key, ms] of Object.entries(after.parts)) {
    const part = key.split(':')[0];
    used[part] = (used[part] ?? 0) + (ms - (before.parts[key] ?? 0));
  }
  return {
    seconds: round(seconds),
    ofOneProcessor: Object.fromEntries(
      Object.entries(used).map(([part, ms]) => [part, round((ms / 1000 / seconds) * 100)]),
    ),
    machineBusyPct: round(
      ((after.machine.busy - before.machine.busy) / (after.machine.all - before.machine.all)) * 100,
    ),
    processors: cpus().length,
  };
}

/** One line for a bench's log. */
export function cpuLine(cpu) {
  if (!cpu) return 'not measured';
  const parts = Object.entries(cpu.ofOneProcessor)
    .map(([part, pct]) => `${part} ${pct} %`)
    .join(', ');
  return `${parts} of a processor (the machine ${cpu.machineBusyPct} % busy, ${cpu.processors} processors)`;
}

/**
 * Local experiments only (a hex mask such as 0xF): a bench's browser or app, the API, the worker
 * and SQL Server on those processors, as on CI's four; `ALL_PROCESSORS` puts them back. Processes
 * of the benches only (by command line), and SQL Server's.
 */
export function pin(mask) {
  if (process.platform !== 'win32' || !mask) return;
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -match 'playwright_chromium|cgw-phase5-desktop|cgw-phase6-desktop|Cgw\\.Api|Cgw\\.Worker') -or $_.Name -eq 'sqlservr.exe' } | ForEach-Object { try { (Get-Process -Id $_.ProcessId -ErrorAction Stop).ProcessorAffinity = [IntPtr]${mask} } catch {} }`,
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
}

export const ALL_PROCESSORS = `0x${((1n << BigInt(cpus().length)) - 1n).toString(16)}`;
