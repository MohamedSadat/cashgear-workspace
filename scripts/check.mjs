// Runs every standing check in the order CI runs them, and stops at the first failure.
//   pnpm check            all of them
//   pnpm check --no-rust  only the TypeScript and npm checks
import { pnpmCommand, run } from './lib.mjs';

const skipRust = process.argv.includes('--no-rust');
const pnpm = (...args) => pnpmCommand(args);
const checks = [
  ['format', pnpm('format:check')],
  ['lint', pnpm('lint')],
  ['typecheck', pnpm('typecheck')],
  ['unit tests', pnpm('test')],
  ...(skipRust
    ? []
    : [
        ['rust fmt', pnpm('rust:fmt')],
        ['rust clippy', pnpm('rust:clippy')],
        ['rust tests', pnpm('rust:test')],
        ['cargo-deny', pnpm('deny')],
      ]),
  ['npm licences', pnpm('licenses:check')],
  ['licence self-test', pnpm('licenses:selftest')],
];

for (const [name, [command, args]] of checks) {
  console.log(`\n=== ${name} ===`);
  const started = Date.now();
  await run(command, args);
  console.log(`=== ${name}: passed in ${((Date.now() - started) / 1000).toFixed(1)} s ===`);
}
console.log(`\nAll ${checks.length} standing checks passed.`);
