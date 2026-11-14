import { defineConfig } from '@playwright/test';
import { mocks, serverStack } from './playwright.config';

// The Phase 1 exit criteria on the built desktop app (pnpm test:e2e:desktop, after
// pnpm desktop:build): the same specs, each test on target/release/cgw-desktop.exe started with
// data of its own and driven over CDP (tests/e2e/fixtures.ts). Narrow screens and Axe are browser
// concerns and run in Chrome and Edge only; the desktop window is at least 800 px wide.
process.env.CGW_E2E_TARGET = 'desktop';
export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: ['**/narrow.spec.ts', '**/a11y.spec.ts'],
  timeout: 90000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  globalSetup: './tests/e2e/desktop-setup.ts',
  reporter: process.env.CI
    ? [
        ['github'],
        ['html', { open: 'never', outputFolder: 'playwright-report-desktop' }],
        ['json', { outputFile: 'bench/results/desktop-tests.json' }],
      ]
    : [['list'], ['json', { outputFile: 'bench/results/desktop-tests.json' }]],
  outputDir: 'test-results-desktop',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'desktop' }],
  // The Phase 2 specs need the server stack; the desktop app is built with its address.
  // (and the web preview, which desktop-cloud.spec.ts opens in a browser beside the app). Phase 5:
  // the mock Sheet and the mock ERP, which the desktop build frames and calls as the web's does.
  webServer: process.env.E2E_API_URL
    ? [...mocks]
    : [
        {
          command: 'pnpm preview',
          url: 'http://127.0.0.1:4273',
          reuseExistingServer: !process.env.CI,
          timeout: 30000,
        },
        serverStack,
        ...mocks,
      ],
});
