// Phase 2 on the desktop app (pnpm test:e2e:desktop): sign-in through the "system browser" (here
// a Chrome page the test drives to the URL the app wrote, as CGW_AUTH_URL_FILE asks), back to
// the app's loopback listener; the workspace goes to the account and a browser sees its pages.
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { createWorkspace, editor, newPage, waitSaved } from './helpers';
import { newAccount, signIn, signedIn, syncStatus } from './cloud';

test.skip(!desktop, 'The browser signs in with a cookie: cloud.spec.ts');

test('signs in through the browser, syncs a workspace, and a browser sees its pages', async ({
  page,
  authUrlFile,
}) => {
  const account = await newAccount('Desktop user');
  await createWorkspace(page, 'From the desktop');
  await newPage(page, 'Desktop notes');
  await page.keyboard.type('Typed in the desktop app');
  await waitSaved(page);

  await page.getByRole('button', { name: 'Sign in to sync' }).click();
  await expect.poll(() => existsSync(authUrlFile!), { timeout: 15000 }).toBe(true);
  const authorize = readFileSync(authUrlFile!, 'utf8').trim();
  expect(authorize).toMatch(/^http:\/\/127\.0\.0\.1:5280\/connect\/authorize\?/);
  expect(authorize).toContain('code_challenge_method=S256');

  // The system browser: signs in on the API's page, confirms the desktop's sign-in, and is sent
  // to the app's loopback listener.
  const browser = await chromium.launch({ channel: 'chrome' });
  const tab = await browser.newPage();
  await tab.goto(authorize);
  await tab.getByLabel('Email').fill(account.email);
  await tab.getByLabel('Password').fill(account.password);
  await tab.getByRole('button', { name: 'Sign in' }).click();
  await expect(tab.getByText(`as ${account.email}?`)).toBeVisible();
  await tab.getByRole('button', { name: 'Continue' }).click();
  await tab.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/callback/);
  await expect(tab.locator('body')).toContainText(/close/i);

  await signedIn(page, account);
  await page.getByRole('button', { name: 'Upload to my account' }).click();
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });

  // A browser, signed in with a cookie, sees the desktop's pages.
  const web = await browser.newPage({ baseURL: 'http://127.0.0.1:4273' });
  await web.goto('http://127.0.0.1:4273/');
  await signIn(web, account, 'http://127.0.0.1:4273/');
  await web.getByRole('treeitem', { name: /Desktop notes/ }).click({ timeout: 30000 });
  await expect(editor(web)).toContainText('Typed in the desktop app', { timeout: 20000 });
  await browser.close();

  // Signing out revokes the device's tokens; the pages stay in the app.
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(
    page
      .getByRole('navigation', { name: 'Sidebar' })
      .getByRole('button', { name: 'Sign in to sync' }),
  ).toBeVisible();
});
