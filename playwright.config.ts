import { defineConfig } from '@playwright/test';

/** The local server stack for the Phase 2 specs; it builds the server first, hence the time. */
export const serverStack = {
  command: 'node scripts/server-stack.mjs --e2e',
  url: 'http://127.0.0.1:5280/health/live',
  reuseExistingServer: !process.env.CI,
  timeout: 300000,
  stdout: 'pipe' as const,
  stderr: 'pipe' as const,
};

/**
 * Phase 5's mocks (tests/mocks): Cash Gear Sheet on 4283 (the embed and the launch route a
 * local-API build frames and opens) and Cash Gear ERP's API on 4282 with its client on 4284. Kept
 * running between local runs, fresh on CI. The specs reset what they use (`/__mock/reset`); the
 * real-system runs (tests/e2e/README.md) skip the parts that need the mocks' controls.
 */
export const mocks = [
  {
    command: 'node tests/mocks/sheet/server.mjs',
    url: 'http://127.0.0.1:4283/__mock/state',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  {
    command: 'node tests/mocks/erp/server.mjs --workspace-url http://127.0.0.1:4273',
    url: 'http://127.0.0.1:4282/__mock/state',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
];

// Chrome and Edge are the first-class browsers, as in Sheet. E2E_BASE_URL points the specs at a
// server that is already running, such as `pnpm dev:web`.
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4273';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [
        ['github'],
        ['html', { open: 'never' }],
        ['json', { outputFile: 'bench/results/browser-tests.json' }],
      ]
    : [['list'], ['json', { outputFile: 'bench/results/browser-tests.json' }]],
  use: {
    baseURL,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chrome', use: { channel: 'chrome' } },
    { name: 'edge', use: { channel: 'msedge' } },
  ],
  webServer: [
    ...(process.env.E2E_BASE_URL
      ? []
      : [
          {
            command: 'pnpm preview',
            url: baseURL,
            reuseExistingServer: !process.env.CI,
            timeout: 30000,
          },
        ]),
    // Phase 2: the API, the worker, a fresh database and Azurite (scripts/server-stack.mjs).
    ...(process.env.E2E_API_URL ? [] : [serverStack]),
    // Phase 5: the mock Sheet and the mock ERP.
    ...mocks,
  ],
});
