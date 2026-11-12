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
  ],
});
