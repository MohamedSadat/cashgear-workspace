// Runs every standing check in the order CI runs them, and stops at the first failure.
//   pnpm check            all of them
//   pnpm check --no-rust  only the TypeScript and npm checks (and no server, which needs cgw-ydoc)
//   pnpm check --no-server  everything but the .NET server's build and tests
import { pnpmCommand, run } from './lib.mjs';

const skipRust = process.argv.includes('--no-rust');
const skipServer = skipRust || process.argv.includes('--no-server');
const pnpm = (...args) => pnpmCommand(args);
const checks = [
  ['format', pnpm('format:check')],
  ['lint', pnpm('lint')],
  ['typecheck', pnpm('typecheck')],
  // The SQLite store's conformance suite runs through this binary; without Rust it is skipped.
  ...(skipRust
    ? []
    : [['store cli', ['cargo', ['build', '-p', 'cgw-store', '--bin', 'cgw-store-cli']]]]),
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
  ['nuget licences', pnpm('licenses:nuget')],
  ['licence self-test', pnpm('licenses:selftest')],
  ...(skipServer
    ? []
    : [
        // The build writes server/openapi/v1.json; @cgw/api's types must match it.
        ['server build', pnpm('server:build')],
        ['api types', pnpm('api:check')],
        // The worker's Yjs library, which the server tests call.
        ['cgw-ydoc ffi', ['cargo', ['build', '-p', 'cgw-ydoc', '--profile', 'ffi']]],
        ['server tests', pnpm('server:test')],
      ]),
];

for (const [name, [command, args]] of checks) {
  console.log(`\n=== ${name} ===`);
  const started = Date.now();
  await run(command, args);
  console.log(`=== ${name}: passed in ${((Date.now() - started) / 1000).toFixed(1)} s ===`);
}
console.log(`\nAll ${checks.length} standing checks passed.`);
