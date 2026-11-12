// The convergence simulator in CI (sim.ts): three clients, real Yjs documents, random tree
// operations and database edits, partitions, loss, duplication and reordering; everyone
// converges on the server's tree, documents, database, views and rows, and nothing the server
// acknowledged is lost.
//
// A small size by default (a few seconds); larger with SIM_STEPS (rounds per seed), SIM_SEEDS
// (how many seeds) and SIM_SEED (the first seed), for example
//   SIM_STEPS=400 SIM_SEEDS=20 pnpm exec vitest run packages/doc/src/sync-sim
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { random, simulate, type SimReport } from './sim';

const STEPS = Number(process.env.SIM_STEPS ?? 40);
const SEEDS = Number(process.env.SIM_SEEDS ?? 4);
const FIRST = Number(process.env.SIM_SEED ?? 1);

/** Ids from a seed: uuidv7's random bits and its clock, so a seed replays exactly. */
function deterministic(seed: number, base: number) {
  const r = random(seed ^ 0x5eed);
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
    <T extends ArrayBufferView | null>(array: T): T => {
      if (array) {
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        for (let i = 0; i < bytes.length; i++) bytes[i] = r.int(0, 255);
      }
      return array;
    },
  );
  let ticks = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => base + Math.floor(ticks++ / 8));
}

let base = Date.UTC(2027, 0, 1);

async function run(seed: number, steps: number): Promise<SimReport> {
  // Each run's clock starts past the last one's, so uuidv7's own state never repeats an id.
  base += 1e10;
  deterministic(seed, base);
  try {
    return await simulate({ seed, steps });
  } finally {
    vi.restoreAllMocks();
  }
}

describe('convergence simulator', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  for (let seed = FIRST; seed < FIRST + SEEDS; seed++)
    it(`seed ${seed}: three clients converge on the server's tree and documents`, async () => {
      const started = performance.now();
      const report = await run(seed, STEPS);
      const ms = Math.round(performance.now() - started);
      console.info(
        `sim seed=${seed} steps=${STEPS} pages=${report.pages} updates=${report.updates} ops=${report.ops} ` +
          `acked=${report.acked} edits=${report.edits} treeOps=${report.treeOps} ` +
          `dbOps=${report.dbOps} rows=${report.rows} ` +
          `lostRequests=${report.faults.lostRequests} lostAnswers=${report.faults.lostAnswers} ` +
          `duplicates=${report.faults.duplicates} partitioned=${report.faults.partitioned} ` +
          `settle=${report.settleRounds} ${ms}ms`,
      );
      expect(report.problems).toEqual([]);
      // The faults happened and the work was real.
      expect(report.acked).toBeGreaterThan(0);
      expect(report.faults.lostAnswers + report.faults.lostRequests).toBeGreaterThan(0);
      expect(report.faults.duplicates).toBeGreaterThan(0);
      expect(report.faults.partitioned).toBeGreaterThan(0);
    }, 120_000);

  it('replays a seed exactly', async () => {
    const one = await run(FIRST, 12);
    const two = await run(FIRST, 12);
    expect(two.digest).toBe(one.digest);
    expect(two.faults).toEqual(one.faults);
    expect({ ...two, digest: '' }).toEqual({ ...one, digest: '' });
  }, 60_000);
});
