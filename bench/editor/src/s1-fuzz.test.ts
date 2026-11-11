// Spike S1's fuzz: two and three clients, random operations, random delivery, offline spells.
//   S1_OPS (default 1500 per configuration in CI; the spike's recorded runs used 10,000)
//   S1_SEEDS (default 1), S1_CLIENTS (default "2,3"), S1_OUT (results file)
//   S1_CONFIGS: only these, as "binding/content/bodies", comma-separated
//   S1_COMPARE=1: also the configurations S1 rejected, for their numbers
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { installDom } from './dom';

installDom();
const { runFuzz } = await import('./fuzz');

const OPS = Number(process.env.S1_OPS ?? 1500);
const SEEDS = Number(process.env.S1_SEEDS ?? 1);
const results: unknown[] = [];

// The schema and binding Phase 0 recommends (DECISIONS.md, S1), and the comparisons S1 measured,
// which are expected to fail.
const recommended = [
  { binding: 'tiptap-ids', content: 'mixed', bodies: 'kind' },
  { binding: 'tiptap-ids', content: 'ordered', bodies: 'kind' },
] as const;
const comparisons = [
  { binding: 'tiptap', content: 'ordered', bodies: 'types' },
  { binding: 'tiptap-ids', content: 'ordered', bodies: 'types' },
  { binding: 'tiptap-ids', content: 'mixed', bodies: 'types' },
  { binding: 'upstream', content: 'ordered', bodies: 'types' },
] as const;
const configurations = [...recommended, ...(process.env.S1_COMPARE ? comparisons : [])];
const only = process.env.S1_CONFIGS?.split(',');
const clientCounts = (process.env.S1_CLIENTS ?? '2,3').split(',').map(Number);

describe('S1 fuzz', () => {
  for (const config of configurations) {
    if (only && !only.includes(`${config.binding}/${config.content}/${config.bodies}`)) continue;
    const isRecommended = recommended.some((r) => r === config);
    for (const clients of clientCounts) {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const name = `${config.binding}, ${config.content}, ${config.bodies}, ${clients} clients, seed ${seed}`;
        it(
          name,
          () => {
            const options = {
              seed: seed * 7919 + clients,
              clients,
              ops: OPS,
              binding: config.binding,
              schema: { content: config.content, bodies: config.bodies },
            };
            let result;
            try {
              result = runFuzz(options);
            } catch (error) {
              // Upstream y-prosemirror can throw from its remote-change handler (S1).
              if (isRecommended) throw error;
              result = { options, failures: [`threw: ${String(error).slice(0, 200)}`] };
            }
            results.push(result);
            mkdirSync('bench/results', { recursive: true });
            writeFileSync(
              process.env.S1_OUT ?? 'bench/results/s1-fuzz.json',
              JSON.stringify(results, null, 2) + '\n',
            );
            // The pass criteria: convergence, a valid schema, no duplicate ids, ids kept on move.
            if (isRecommended) expect(result.failures).toEqual([]);
          },
          600_000,
        );
      }
    }
  }
});
