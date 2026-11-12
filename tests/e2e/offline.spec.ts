// Phase 3's first acceptance criterion against the server stack, in Chrome and Edge and on the
// built desktop app: "with the network off: the app starts, pinned pages open, edits are saved, a
// new page is created; with the network back, everything syncs with no action from the user".
// Also a recovered page end to end (edited offline here, deleted for good on another device), the
// sidebar's "not available offline" marks on pages this device holds, and Axe on the offline
// screens in both languages and themes.
//
// The network: in a browser, Playwright's offline mode for the whole context (the app then starts
// from its service worker, after one visit online); on the desktop, the API's address blocked in
// the window through CDP and the window started again (a reload: the store stays in the app's
// process), and when it comes back, the `online` event the system would fire (CDP's blocking
// fires none). The other device is a second browser profile signed in as the same person.
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { createWorkspace, editor, newPage, waitSaved } from './helpers';
import { newAccount, signIn, signedIn, signInDesktop, syncStatus, type TestAccount } from './cloud';

const APP = 'http://127.0.0.1:4273';
const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:5280';
const tree = (page: Page) => page.getByRole('tree', { name: 'Pages' });
const row = (page: Page, title: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(title) });
const pageActions = (page: Page) => page.locator('.cgw-topbar-button[aria-label="Page actions"]');
const NOT_HERE = 'This page isn’t on this device yet. It opens when you’re online.';

async function addSubpage(page: Page, parent: string, title: string) {
  await row(page, parent).hover();
  await row(page, parent).getByRole('button', { name: 'Add a page inside' }).click();
  await expect(page.getByLabel('Page title')).toHaveValue('');
  await page.getByLabel('Page title').fill(title);
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeFocused();
}

/** Signed in with a synced workspace, made as each target makes one. */
async function signedInWorkspace(
  page: Page,
  account: TestAccount,
  name: string,
  authUrlFile: string | null,
  signer: () => Promise<Browser>,
) {
  if (desktop) {
    await createWorkspace(page, name);
    await signInDesktop(page, await signer(), authUrlFile!, account);
    await page.getByRole('button', { name: 'Upload to my account' }).click();
  } else {
    await page.goto('/');
    await signIn(page, account);
    await signedIn(page, account);
    // Made on the page signing in landed on, not after loading the app again: a workspace made
    // before a fresh start's account check has answered stays on this device only.
    await page.getByLabel('Workspace name').fill(name);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(editor(page)).toBeVisible();
  }
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
}

/** Turns this device's network off and on. */
async function network(page: Page, context: BrowserContext) {
  if (!desktop) return { off: () => context.setOffline(true), on: () => context.setOffline(false) };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  return {
    off: () =>
      cdp.send('Network.setBlockedURLs', { urls: [`${API.replace(/^https?:\/\//, '*')}/*`] }),
    on: async () => {
      await cdp.send('Network.setBlockedURLs', { urls: [] });
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
    },
  };
}

/** Another device of the same person: a browser profile of its own, signed in. */
async function otherDevice(browser: Browser, account: TestAccount) {
  const context = await browser.newContext({ baseURL: APP });
  const page = await context.newPage();
  await page.goto(`${APP}/`);
  await signIn(page, account, `${APP}/`);
  await signedIn(page, account);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  return { context, page };
}

let launched: Browser | null = null;
const signer = async () => (launched ??= await chromium.launch({ channel: 'chrome' }));
test.afterEach(async ({ page }) => {
  await launched?.close();
  launched = null;
  // The desktop keeps its sign-in in the keychain (one test name for every test): signed out.
  if (desktop && !page.isClosed()) {
    await page.goto('/#/settings').catch(() => {});
    await page
      .getByRole('button', { name: 'Sign out' })
      .click({ timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(1000);
  }
});

test('offline: the app starts, pinned pages open, edits and a new page are saved, and all syncs on its own', async ({
  page,
  authUrlFile,
}) => {
  const context = page.context();
  test.setTimeout(240000);
  const account = await newAccount('Offline');
  await signedInWorkspace(page, account, 'Offline space', authUrlFile, signer);
  await newPage(page, 'Kept offline');
  await page.keyboard.type('Pinned text');
  await waitSaved(page);
  await addSubpage(page, 'Kept offline', 'Inside it');
  await page.keyboard.type('Subpage text');
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });

  // Another device makes a page this one never opens.
  const other = await otherDevice(desktop ? await signer() : context.browser()!, account);
  await newPage(other.page, 'Made elsewhere');
  await other.page.keyboard.type('Not on the first device');
  await waitSaved(other.page);
  await expect(syncStatus(other.page)).toHaveText('Synced', { timeout: 30000 });
  await expect(row(page, 'Made elsewhere')).toBeVisible({ timeout: 20000 });

  // The parent kept offline with the pages inside it, from the page's menu.
  await row(page, 'Kept offline').click();
  await pageActions(page).click();
  await page
    .getByRole('menuitem', { name: 'Make available offline, with the pages inside' })
    .click();
  await page.goto('/#/settings');
  await expect(page.getByTestId('offline-progress')).toHaveText(
    'All 2 pages kept offline are on this device.',
    { timeout: 30000 },
  );
  await expect(page.getByTestId('offline-pins')).toContainText('Kept offline');
  if (!desktop)
    // One visit online: the service worker holds the app's files and controls the page.
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {
      timeout: 30000,
    });

  // The network off, and the app started again.
  const net = await network(page, context);
  await net.off();
  await page.goto('/#/settings');
  await page.reload();
  await signedIn(page, account);
  await expect(syncStatus(page)).toHaveText(/^Offline/, { timeout: 20000 });

  // The pinned page and the page inside it open.
  await row(page, 'Kept offline').click();
  await expect(editor(page)).toContainText('Pinned text');
  const parent = row(page, 'Kept offline');
  if ((await parent.getAttribute('aria-expanded')) === 'false') {
    await parent.focus();
    await page.keyboard.press('ArrowRight');
  }
  await row(page, 'Inside it').click();
  await expect(editor(page)).toContainText('Subpage text');

  // Edits are saved, and a new page is made.
  await row(page, 'Kept offline').click();
  await editor(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' and edited offline');
  await waitSaved(page);
  await newPage(page, 'Written offline');
  await page.keyboard.type('Made with no network');
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText(/^Offline, \d+ changes waiting$/);

  // A page this device never held says so, and waits.
  await row(page, 'Made elsewhere').click();
  await expect(page.getByTestId('not-on-device')).toContainText(NOT_HERE);
  await expect(row(page, 'Made elsewhere')).toHaveAttribute('title', 'Not available offline');

  // The network back: nothing to do. Everything reaches the other device within 10 s.
  const back = Date.now();
  await net.on();
  await expect(editor(page)).toContainText('Not on the first device', { timeout: 20000 });
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  const synced = Date.now() - back;
  await expect(row(other.page, 'Written offline')).toBeVisible({
    timeout: Math.max(1000, 10000 - (Date.now() - back)),
  });
  await row(other.page, 'Kept offline').click();
  await expect(editor(other.page)).toContainText('Pinned text and edited offline', {
    timeout: Math.max(1000, 10000 - (Date.now() - back)),
  });
  const seen = Date.now() - back;
  test.info().annotations.push({
    type: 'reconnect',
    description: `Synced ${synced} ms after the network came back; the other device had it all ${seen} ms after`,
  });
  expect(seen).toBeLessThan(10000);
  await row(other.page, 'Written offline').click();
  await expect(editor(other.page)).toContainText('Made with no network');
  await other.context.close();
});

test('a page edited offline and deleted for good elsewhere comes back as a recovered page', async ({
  page,
  authUrlFile,
}) => {
  const context = page.context();
  test.setTimeout(240000);
  const account = await newAccount('Recovering');
  await signedInWorkspace(page, account, 'Recovery space', authUrlFile, signer);
  await newPage(page, 'Doomed');
  await page.keyboard.type('Before going offline');
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  const other = await otherDevice(desktop ? await signer() : context.browser()!, account);
  await expect(row(other.page, 'Doomed')).toBeVisible({ timeout: 20000 });

  // Edited here with no network.
  const net = await network(page, context);
  await net.off();
  await editor(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' and typed while offline');
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText(/^Offline/, { timeout: 20000 });

  // Deleted for good on the other device meanwhile.
  await row(other.page, 'Doomed').click();
  await pageActions(other.page).click();
  await other.page.getByRole('menuitem', { name: 'Move to trash' }).click();
  await other.page.goto(`${APP}/#/trash`);
  await other.page.getByRole('button', { name: 'Delete for good' }).first().click();
  await other.page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete for good' })
    .click();
  await expect(syncStatus(other.page)).toHaveText('Synced', { timeout: 30000 });

  // Back online: the edits come back as a recovered page, and the notice links to it.
  await net.on();
  const notice = page.getByRole('alert').filter({ hasText: /“Doomed” was deleted/ });
  await expect(notice).toBeVisible({ timeout: 30000 });
  await notice.getByRole('link', { name: 'Open the recovered page' }).click();
  await expect(page.getByLabel('Page title')).toHaveValue('Recovered: Doomed');
  await expect(editor(page)).toContainText('Before going offline and typed while offline');
  await expect(row(page, '^Doomed')).toHaveCount(0);
  await page.goto('/#/recovered');
  const entry = page.getByTestId('recovered').locator('li');
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('From “Doomed”');
  await expect(entry.getByRole('link', { name: 'Open the recovered page' })).toBeVisible();
  // The recovered page is an ordinary page of the account: the other device gets it too.
  await expect(row(other.page, 'Recovered: Doomed')).toBeVisible({ timeout: 30000 });
  await other.context.close();
});

test('pages made on this device are not marked "not available offline" when the network goes', async ({
  page,
  authUrlFile,
}) => {
  test.setTimeout(120000);
  const account = await newAccount('Marks');
  await signedInWorkspace(page, account, 'Marks space', authUrlFile, signer);
  await newPage(page, 'Made here');
  await page.keyboard.type('Held on this device');
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  const net = await network(page, page.context());
  await net.off();
  await expect(syncStatus(page)).toHaveText(/^Offline/, { timeout: 20000 });
  // Every page here was made here and is held: none is marked, and each opens.
  await expect(tree(page).locator('[role="treeitem"].is-unavailable')).toHaveCount(0);
  await row(page, 'Getting started').first().click();
  await expect(editor(page)).toBeVisible();
  await expect(page.getByTestId('not-on-device')).toHaveCount(0);
  await net.on();
});

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
async function axe(page: Page, screen: string) {
  // Off whatever the last click left under the pointer: a hovered row is not what is judged.
  await page.mouse.move(5, 795);
  const result = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  return result.violations.map(
    (v) =>
      `${screen}: ${v.id} (${v.impact}) ${v.help}\n` +
      v.nodes
        .slice(0, 5)
        .map((n) => `    ${n.target.join(' ')}: ${n.failureSummary?.split('\n')[1] ?? ''}`)
        .join('\n'),
  );
}

test('Axe finds nothing on the offline screens, in both languages and themes', async ({ page }) => {
  test.skip(desktop, 'Axe runs in the browsers (a11y.spec.ts)');
  test.setTimeout(240000);
  const context = page.context();
  const account = await newAccount('Axe offline');
  await signedInWorkspace(page, account, 'Axe space', null, signer);
  await newPage(page, 'Kept offline');
  await page.keyboard.type('Pinned text');
  await waitSaved(page);
  await pageActions(page).click();
  await page.getByRole('menuitem', { name: 'Make available offline', exact: true }).click();
  const other = await otherDevice(context.browser()!, account);
  await newPage(other.page, 'Made elsewhere');
  await other.page.keyboard.type('Elsewhere');
  await waitSaved(other.page);
  await expect(syncStatus(other.page)).toHaveText('Synced', { timeout: 30000 });
  await other.context.close();
  await expect(row(page, 'Made elsewhere')).toBeVisible({ timeout: 20000 });
  await page.goto('/#/settings');
  await expect(page.getByTestId('offline-progress')).toHaveText(/^All 1 pages kept offline/, {
    timeout: 30000,
  });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
  // A set-aside entry, as the store keeps one: made into a recovered page at the next start.
  const workspaceId = await page.evaluate(() => localStorage.getItem('cgw-workspace'));
  await page.evaluate(
    (record) =>
      new Promise<void>((done, fail) => {
        const open = indexedDB.open('cgw-workspace');
        open.onerror = () => fail(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('quarantine', 'readwrite');
          tx.objectStore('quarantine').put(record);
          tx.oncomplete = () => (db.close(), done());
          tx.onerror = () => fail(tx.error);
        };
      }),
    {
      id: '019a7c3e-1111-7000-8000-000000000001',
      workspaceId,
      pageId: '019a7c3e-2222-7000-8000-000000000002',
      title: 'Lost notes',
      reason: 'page.gone',
      at: new Date().toISOString(),
      parts: [],
      status: 'pending',
      recoveredPageId: null,
    },
  );
  await context.setOffline(true);

  const problems: string[] = [];
  for (const theme of ['light', 'dark'])
    for (const language of ['en', 'ar']) {
      const label = `${theme}, ${language}`;
      await page.evaluate(
        ([t, l]) => {
          localStorage.setItem('cgw-theme', t);
          localStorage.setItem('cgw-language', l);
        },
        [theme, language],
      );
      await page.goto('/#/settings');
      await page.reload();
      await expect(page.locator('#cgw-offline-title')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('storage-usage')).toBeVisible();
      problems.push(...(await axe(page, `settings, offline (${label})`)));
      // The sidebar marks pages not on this device; one of them, opened.
      await page.locator('[role="treeitem"].is-unavailable').first().click({ timeout: 20000 });
      await expect(page.getByTestId('not-on-device')).toBeVisible();
      problems.push(...(await axe(page, `a page not on this device (${label})`)));
      await page.goto('/#/recovered');
      await expect(page.getByTestId('recovered').locator('li')).toHaveCount(1, { timeout: 20000 });
      problems.push(...(await axe(page, `recovered (${label})`)));
    }
  expect(problems, problems.join('\n')).toEqual([]);
});
