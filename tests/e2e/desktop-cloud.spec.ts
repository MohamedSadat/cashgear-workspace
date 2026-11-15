// Phase 2 on the desktop app (pnpm test:e2e:desktop): sign-in through the "system browser" (here
// a Chrome page the test drives to the URL the app wrote, as CGW_AUTH_URL_FILE asks), back to
// the app's loopback listener; the workspace goes to the account and a browser sees its pages.
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { apiSession } from '../../scripts/cloud-account.mjs';
import { test, expect, desktop } from './fixtures';
import { createWorkspace, editor, newPage, waitSaved } from './helpers';
import { newAccount, signIn, signedIn, signInDesktop, syncStatus } from './cloud';
import { signOutDesktop } from './database';
import { workspaceIdOf } from './ecosystem';
import {
  blockBody,
  caretIn,
  delays,
  hubFrames,
  keysOf,
  member,
  openPage,
  seenOf,
  seesOnPage,
  watchBlock,
  type Person,
} from './collab';

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

// Phase 6 on the desktop app: it joins the hub through its own path (a ticket asked for with its
// bearer token, no cookie), shows a browser person's edits live (each key timed from the typist's
// key to the desktop's DOM change: p95 within 300 ms) and their presence, and they see the
// desktop's person.
test('joins the hub with its bearer token and shows a browser person typing live, and their presence', async ({
  page,
  authUrlFile,
}, testInfo) => {
  test.setTimeout(300000);
  const signer = await chromium.launch({ channel: 'chrome' });
  const tickets: { authorization?: string; cookie?: string }[] = [];
  page.on('request', (request) => {
    if (/\/api\/v1\/realtime\/tickets$/.test(request.url())) tickets.push(request.headers());
  });
  const frames = hubFrames(page);
  let ben: Person | null = null;
  try {
    const ada = await newAccount('Ada');
    await createWorkspace(page, 'Desktop team');
    await signInDesktop(page, signer, authUrlFile!, ada);
    await page.getByRole('button', { name: 'Upload to my account' }).click();
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    const adaApi = await apiSession(ada);
    try {
      const workspaceId = await workspaceIdOf(adaApi, 'Desktop team');
      ben = await member(signer, adaApi, workspaceId, 'Ben');
      await newPage(page, 'Live from the browser');
      await page.keyboard.type('123 456');
      await waitSaved(page);
      await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
      const block = (await editor(page)
        .locator('[data-block]')
        .first()
        .getAttribute('data-block-id'))!;
      await openPage(ben.page, 'Live from the browser', '123 456');
      // Each sees the other on the page, through the hub.
      await seesOnPage(page, ['Ben']);
      await seesOnPage(ben.page, ['Ada']);
      expect(frames.sockets).toBeGreaterThan(0);
      expect(tickets.length).toBeGreaterThan(0);
      for (const headers of tickets) {
        expect(headers.authorization).toMatch(/^Bearer /);
        expect(headers.cookie).toBeUndefined();
      }
      // Ben types: every key reaches the desktop's page.
      await watchBlock(page, block);
      await caretIn(ben.page, block, 'end');
      await caretIn(page, block, 'start');
      await expect(
        editor(ben.page).locator(`[data-block-id="${block}"] .cgw-presence-caret[data-name="Ada"]`),
      ).toHaveCount(1, { timeout: 10000 });
      await keysOf(ben.page);
      const typed = 'FROMTHEBROWSERTOTHEDESKTOPLIVEKEYS';
      await ben.page.keyboard.type(typed, { delay: 120 });
      await expect(blockBody(page, block)).toHaveText(`123 456${typed}`, { timeout: 15000 });
      const d = delays(await keysOf(ben.page), await seenOf(page), /[A-Z]/);
      testInfo.annotations.push({
        type: 'browser to desktop',
        description: `${d.count} keys: p50 ${d.p50} ms, p95 ${d.p95} ms, max ${d.max} ms, over 300 ms: ${d.over300}`,
      });
      console.log(
        `Browser to desktop: ${d.count} keys: p50 ${d.p50} ms, p95 ${d.p95} ms, max ${d.max} ms, over 300 ms: ${d.over300}, never seen: ${d.missing}`,
      );
      expect(d.missing).toBe(0);
      // 300 ms on the reference machine; on CI's shared runner, live in under a second
      // (realtime.spec.ts's KEY_LIMIT, DECISIONS.md 2026-11-15).
      expect(d.p95).toBeLessThanOrEqual(process.env.CI ? 1000 : 300);
      // Ben's cursor is drawn on the desktop, named.
      await expect(
        editor(page).locator(`[data-block-id="${block}"] .cgw-presence-caret[data-name="Ben"]`),
      ).toHaveCount(1, { timeout: 10000 });
      expect(frames.frames.some((f) => f.target === 'Updates')).toBe(true);
      expect(ben.errors).toEqual([]);
    } finally {
      await adaApi.dispose();
      await ben?.api.dispose();
      await ben?.context.close();
    }
  } finally {
    await signOutDesktop(page);
    await signer.close();
  }
});

// Phase 7 on the desktop: AI through the desktop's bearer token (the mock provider behind the
// e2e stack's API), a summary proposed beside the page, entering it only on Accept, one edit
// Undo takes back.
test('asks AI for a summary with its bearer token and puts it in only on Accept', async ({
  page,
  authUrlFile,
}) => {
  test.setTimeout(180000);
  const signer = await chromium.launch({ channel: 'chrome' });
  const completions: { authorization?: string; cookie?: string }[] = [];
  page.on('request', (request) => {
    if (/\/api\/v1\/ai\/complete$/.test(request.url())) completions.push(request.headers());
  });
  try {
    const ada = await newAccount('Ada');
    await createWorkspace(page, 'Desktop AI');
    await signInDesktop(page, signer, authUrlFile!, ada);
    await page.getByRole('button', { name: 'Upload to my account' }).click();
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    const api = await apiSession(ada);
    try {
      const workspaceId = await workspaceIdOf(api, 'Desktop AI');
      await api.put(`/api/v1/workspaces/${workspaceId}/ai-settings`, {
        apiKey: 'sk-mock-phase7-desktop-key-0001',
      });
      await api.put(`/api/v1/workspaces/${workspaceId}/ai-settings`, { enabled: true });
      await page.reload();
      await newPage(page, 'Desktop notes');
      await page.keyboard.type('The desktop keeps its sign-in in the keychain.');
      await waitSaved(page);
      await page
        .getByRole('region', { name: 'Page' })
        .getByRole('button', { name: 'Page actions' })
        .click();
      await page.getByRole('menuitem', { name: 'AI…' }).click();
      const panel = page.getByTestId('ai-panel');
      await panel.getByRole('radio', { name: 'Summarise this page' }).check();
      await panel.getByRole('button', { name: 'Ask', exact: true }).click();
      await expect(panel.getByRole('button', { name: 'Insert at the top' })).toBeVisible({
        timeout: 30000,
      });
      await expect(editor(page)).not.toContainText('Summary:');
      await panel.getByRole('button', { name: 'Insert at the top' }).click();
      await expect(editor(page)).toContainText('Summary:');
      expect(completions.length).toBeGreaterThan(0);
      for (const headers of completions) {
        expect(headers.authorization).toMatch(/^Bearer /);
        expect(headers.cookie).toBeUndefined();
      }
      // Focus, not a click: in CI's smaller window the AI panel lies over the editor.
      await editor(page).focus();
      await page.keyboard.press('Control+KeyZ');
      await expect(editor(page)).not.toContainText('Summary:');
      await waitSaved(page);
    } finally {
      await api.dispose();
    }
  } finally {
    await signOutDesktop(page);
    await signer.close();
  }
});
