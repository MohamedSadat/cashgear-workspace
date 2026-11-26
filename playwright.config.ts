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
  // Phase 7: the mock AI provider (Anthropic's streamed Messages API) the e2e stack's API calls.
  {
    command: 'node tests/mocks/ai/server.mjs',
    url: 'http://127.0.0.1:4286/__mock/state',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  // Phase 11: the mock OpenID Connect provider (single sign-on) and the DNS stand-in the API asks.
  {
    command: 'node tests/mocks/oidc/server.mjs',
    url: 'http://127.0.0.1:4287/__mock/state',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  // Phase 13: a host a plugin may reach once approved (localhost:4288; 127.0.0.1:4288 another host).
  {
    command: 'node tests/mocks/net/server.mjs',
    url: 'http://127.0.0.1:4288/__mock/state',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  // Phase 14: the mock ACME server the e2e stack's worker gets a site's certificates from; it
  // fetches the HTTP-01 challenge from the Sites process on 5290, whatever the name.
  {
    command: 'node tests/mocks/acme/server.mjs --challenge-port 5290',
    url: 'http://127.0.0.1:4289/__mock/state',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  // Phase 18: the mock Paddle (its API, the checkout's stand-in for Paddle.js, the portal), its
  // webhooks to the e2e stack's API.
  {
    command:
      'node tests/mocks/paddle/server.mjs --webhook http://127.0.0.1:5280/api/v1/billing/paddle',
    url: 'http://127.0.0.1:4291/__mock/state',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
];

// Chrome and Edge are the first-class browsers, as in Sheet. E2E_BASE_URL points the specs at a
// server that is already running, such as `pnpm dev:web`.
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4273';
export default defineConfig({
  testDir: './tests/e2e',
  // CI's shards (.github/workflows/ci.yml) run without the old builds, which a job of their own
  // makes and runs: old-build.spec.ts skips a build it cannot find, so a shard leaves it out.
  testIgnore: process.env.CGW_E2E_WITHOUT_OLD_BUILDS ? ['**/old-build.spec.ts'] : [],
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
    // Phase 11: the app built against the API on `localhost`, for the passkey specs (WebAuthn takes
    // no IP address as its relying party): `node scripts/web-localhost.mjs --build` makes it.
    ...(process.env.E2E_BASE_URL
      ? []
      : [
          {
            command: 'node scripts/web-localhost.mjs --serve',
            url: 'http://localhost:4268',
            reuseExistingServer: !process.env.CI,
            timeout: 30000,
          },
        ]),
  ],
});
