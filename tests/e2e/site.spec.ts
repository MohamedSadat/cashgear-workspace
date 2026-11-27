// Phase 9, M9.1: a page tree published from the share dialog (what will be published listed
// first) and read on the site's own origin (`localhost:5290`, never the app's or the API's
// `127.0.0.1`) with no account and with script off, in English and Arabic, light and dark; a
// restricted page under it, its comments, its history and its Yjs updates never reachable (their
// addresses tried on both origins); a workbook and an ERP view as placeholders; a database's rows;
// unpublish, then every address 404 within a minute; the workspace's switch off taking every site
// down; nothing on the site's origin able to read the app's or the API's session; Axe.
//
// Against the e2e server stack, which starts the Sites process (scripts/server-stack.mjs --e2e).
// Browsers only: a reader without an account is a browser profile of its own.
import AxeBuilder from '@axe-core/playwright';
import type { Browser, Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { blocks, editor, newPage, waitSaved } from './helpers';
import { API, newAccount, syncStatus, type TestAccount } from './cloud';
import { newRow, pageId, signedInWorkspace, signers, tree } from './database';
import {
  budgetBook,
  insertErpBlock,
  insertExistingWorkbook,
  newWorkbook,
  sessionOf,
  workspaceIdOf,
  watchAppErrors,
  type Api,
} from './ecosystem';

test.skip(desktop, 'A site is read in a browser with no account: the browsers run this');

/** The Sites process in development and e2e: another host than the app's and the API's. */
const SITES = process.env.E2E_SITES_URL ?? 'http://localhost:5290';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const cloud = signers();
test.afterEach(async () => {
  await cloud.close();
});

function uuidv7() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(ms / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A slug no other run has taken (slugs are unique across every workspace of the stack). */
const slugFor = (base: string) => `${base}-${Date.now().toString(36)}`;

/** Waits until the worker has derived the page's document with this text (sites render from it). */
async function derived(api: Api, id: string, text: string) {
  await expect
    .poll(
      async () => JSON.stringify(await api.get(`/api/v1/pages/${id}/doc/json`).catch(() => null)),
      { timeout: 60000 },
    )
    .toContain(text);
}

/** A subpage from the tree's row, opened with its title and the caret in its body. */
async function subpage(page: Page, parent: string, title: string) {
  const row = tree(page)
    .getByRole('treeitem', { name: new RegExp(parent) })
    .first();
  await row.hover();
  await row.getByRole('button', { name: 'Add a page inside' }).click();
  await expect(page.getByLabel('Page title')).toHaveValue('');
  await page.getByLabel('Page title').fill(title);
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeFocused();
  return pageId(page);
}

/** The share dialog of the page on screen, on its "Publish to the web" view. */
async function publishView(page: Page) {
  await page.locator('.cgw-topbar-button[aria-label="Page actions"]').click();
  await page.getByRole('menuitem', { name: 'Share…' }).click();
  const dialog = page.getByRole('dialog', { name: /Share/ });
  await dialog.getByRole('button', { name: 'Publish to the web' }).click();
  await expect(dialog.getByTestId('publish-section')).toBeVisible();
  return dialog;
}

/** Closes the share dialog by its own button (focus may have left it as the view changed). */
async function close(dialog: ReturnType<Page['getByRole']>) {
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

/** Publishes the page on screen under this slug from the dialog; the site's address. */
async function publish(page: Page, slug: string) {
  const dialog = await publishView(page);
  await dialog.getByLabel('Address').fill(slug);
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  const url = dialog.getByTestId('site-url');
  await expect(url).toBeVisible({ timeout: 20000 });
  const address = (await url.getAttribute('href'))!;
  expect(address).toBe(`${SITES}/${slug}`);
  return { dialog, address };
}

/** Status of an address fetched with no cookie at all. */
const statusOf = async (url: string) =>
  (await fetch(url, { redirect: 'manual', credentials: 'omit' })).status;

/** Every address answers 404 within a minute (the Sites process caches a site at most 30 s). */
async function allGone(urls: string[]) {
  for (const url of urls)
    await expect.poll(() => statusOf(url), { timeout: 60000, intervals: [1000] }).toBe(404);
}

async function axe(reader: Page, where: string) {
  const result = await new AxeBuilder({ page: reader }).withTags(WCAG).analyze();
  return result.violations.map(
    (v) =>
      `${where}: ${v.id} (${v.impact}) ${v.help}\n` +
      v.nodes
        .slice(0, 5)
        .map((n) => `    ${n.target.join(' ')}`)
        .join('\n'),
  );
}

/** A reader with no account: its own profile, script off unless asked. */
async function reader(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}) {
  const context = await browser.newContext({ javaScriptEnabled: false, ...options });
  return { context, page: await context.newPage() };
}

interface Scene {
  owner: TestAccount;
  api: Api;
  workspaceId: string;
  ids: Record<'root' | 'leave' | 'payroll' | 'vendors' | 'board' | 'minutes', string>;
}

/**
 * A handbook with subpages: Leave (a database of two rows), Payroll (a workbook), Vendors (an ERP
 * view), Board minutes (restricted to the owner) and, under it, Minutes 2026. A comment on the
 * handbook's first block.
 */
async function handbook(page: Page): Promise<Scene> {
  const owner = await newAccount('Publisher');
  await signedInWorkspace(page, owner, 'Site space', null, cloud.signer);
  const api = await sessionOf(owner);
  const workspaceId = await workspaceIdOf(api, 'Site space');
  const me = ((await api.get('/api/v1/account/session')) as { account: { id: string } }).account.id;

  await newPage(page, 'Staff handbook');
  await page.keyboard.type('Welcome to the handbook.');
  await waitSaved(page);
  const root = pageId(page);

  const leave = await subpage(page, 'Staff handbook', 'Leave');
  await page.keyboard.type('Annual leave is 25 days.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/database');
  await page.getByRole('option', { name: /^Database/ }).click();
  await page
    .getByRole('dialog', { name: 'New database' })
    .getByRole('button', { name: 'Create' })
    .click();
  const block = editor(page).locator('.cgw-db');
  await expect(block).toBeVisible();
  await newRow(page, 'Draft the rota', block);
  await newRow(page, 'Book the room', block);
  await waitSaved(page);

  await newWorkbook(api, workspaceId, 'Payroll 2026', budgetBook());
  const payroll = await subpage(page, 'Staff handbook', 'Payroll');
  await page.keyboard.type('The payroll workbook:');
  await page.keyboard.press('Enter');
  await insertExistingWorkbook(page, 'Payroll 2026');
  await waitSaved(page);

  const vendors = await subpage(page, 'Staff handbook', 'Vendors');
  await page.keyboard.type('Our vendors:');
  await page.keyboard.press('Enter');
  await insertErpBlock(page);
  await waitSaved(page);

  const board = await subpage(page, 'Staff handbook', 'Board minutes');
  await page.keyboard.type('Not for the public.');
  await waitSaved(page);
  const minutes = await subpage(page, 'Board minutes', 'Minutes 2026');
  await page.keyboard.type('Salaries were discussed.');
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  await api.put(`/api/v1/pages/${board}/permissions`, {
    restricted: true,
    entries: [{ principalType: 'user', principalId: me, level: 'full' }],
  });

  // A comment on the handbook's first block: never on the site.
  await tree(page)
    .getByRole('treeitem', { name: /Staff handbook/ })
    .first()
    .click();
  await expect(editor(page)).toContainText('Welcome to the handbook.');
  const [first] = await blocks(page);
  await api.post(`/api/v1/pages/${root}/comments/threads`, {
    id: uuidv7(),
    blockId: first.id,
    anchor: { start: null, end: null },
    quote: '',
    comment: { id: uuidv7(), body: [{ type: 'text', text: 'A private remark' }] },
  });

  for (const [id, text] of [
    [root, 'Welcome to the handbook.'],
    [leave, 'databaseView'],
    [payroll, 'sheetEmbed'],
    [vendors, 'erpView'],
  ] as const)
    await derived(api, id, text);
  return { owner, api, workspaceId, ids: { root, leave, payroll, vendors, board, minutes } };
}

test('a page tree is published from the dialog and read with no account, then comes down', async ({
  page,
  browser,
}) => {
  test.setTimeout(420000);
  // A workbook block asks for a picture its view has none of yet: the one error allowed.
  const errors = watchAppErrors(page);
  const scene = await handbook(page);
  const { ids } = scene;
  try {
    // What will be published, listed before publishing: never the restricted page or what is
    // under it, only how many those are.
    const dialog = await publishView(page);
    const listed = dialog.getByTestId('publish-pages').getByRole('listitem');
    // Leave's inline database is a page under it (made with no name, so "Untitled"): published.
    await expect(listed).toHaveText(['Staff handbook', 'Leave', 'Untitled', 'Payroll', 'Vendors']);
    await expect(dialog.getByTestId('publish-left-out')).toContainText('2');
    // The slug proposed from the title; a refused one is said before anything is sent.
    await expect(dialog.getByLabel('Address')).toHaveValue('staff-handbook');
    await dialog.getByLabel('Address').fill('ab');
    await expect(dialog.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('alert')).toContainText('3 to 63');
    await expect(dialog.getByLabel('Let search engines list this site')).not.toBeChecked();
    expect(await axe(page, 'the publish dialog')).toEqual([]);
    await close(dialog);

    const slug = slugFor('handbook');
    const { address, dialog: published } = await publish(page, slug);
    await close(published);

    // ---- Read with no account and no script ---------------------------------------------------
    const anonymous = await reader(browser);
    const site = anonymous.page;
    const answer = (await site.goto(address))!;
    expect(answer.status()).toBe(200);
    const headers = answer.headers();
    expect(headers['set-cookie']).toBeUndefined();
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).not.toContain('script-src');
    expect(headers['x-robots-tag']).toBe('noindex');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['cache-control']).toBe('no-cache');
    expect(headers['etag']).toMatch(/^"/);
    await expect(site.locator('html')).toHaveAttribute('lang', 'en');
    await expect(site.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(site.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await expect(site.locator('script')).toHaveCount(0);
    await expect(site.locator('body')).toContainText('Welcome to the handbook.');
    const nav = site.getByRole('navigation');
    await expect(nav.getByRole('link', { name: 'Leave' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Payroll' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Vendors' })).toBeVisible();
    await expect(nav.locator('[aria-current="page"]')).toHaveText(/Staff handbook/);
    const html = await site.content();
    for (const hidden of [
      'Board minutes',
      'Minutes 2026',
      'Not for the public.',
      'A private remark',
    ])
      expect(html, hidden).not.toContain(hidden);
    expect(html).not.toContain('Publisher');
    // The same page again: 304 by its entity tag.
    const again = await fetch(address, { headers: { 'If-None-Match': headers['etag'] } });
    expect(again.status).toBe(304);

    // A database's rows, through the block's view.
    await nav.getByRole('link', { name: 'Leave' }).click();
    await expect(site.locator('body')).toContainText('Annual leave is 25 days.');
    await expect(site.locator('body')).toContainText('Draft the rota');
    await expect(site.locator('body')).toContainText('Book the room');
    await expect(site.locator('[aria-current="page"]')).toHaveText(/Leave/);
    expect(site.url()).toBe(`${address}/${ids.leave}`);

    // A workbook is never published, and an ERP view always a placeholder.
    await site.goto(`${address}/${ids.payroll}`);
    await expect(site.locator('body')).toContainText('This workbook is not published');
    expect(await site.content()).not.toContain('Payroll 2026');
    await site.goto(`${address}/${ids.vendors}`);
    await expect(site.locator('body')).toContainText('Our vendors:');
    await expect(site.locator('body')).toContainText(/ERP/);

    // ---- Never reachable: the restricted page, what is under it, comments, history, updates ----
    for (const id of [ids.board, ids.minutes])
      expect(await statusOf(`${address}/${id}`), id).toBe(404);
    for (const path of [
      `/${slug}/${ids.root}/comments`,
      `/${slug}/${ids.root}/history`,
      `/${slug}/${ids.root}/doc`,
      `/api/v1/pages/${ids.root}/comments/threads`,
      `/api/v1/pages/${ids.root}/versions`,
      `/api/v1/pages/${ids.root}/doc?after=0`,
      `/api/v1/pages/${ids.board}/doc/json`,
      `/api/v1/shared`,
    ])
      expect(await statusOf(`${SITES}${path}`), `the site's ${path}`).toBe(404);
    for (const id of [ids.root, ids.board])
      for (const path of [`/comments/threads`, `/versions`, `/doc?after=0`, `/doc/json`])
        expect(await statusOf(`${API}/api/v1/pages/${id}${path}`), `the API's ${path}`).toBe(401);

    // ---- In Arabic: the site's own words and direction --------------------------------------
    const settings = await publishView(page);
    await settings.getByLabel('The site’s language').selectOption('ar');
    await settings.getByRole('button', { name: 'Save changes' }).click();
    await expect(settings.getByTestId('publish-message')).toHaveText(
      'The site’s settings are saved.',
    );
    await close(settings);
    await expect
      .poll(
        async () => {
          await site.goto(address);
          return site.locator('html').getAttribute('lang');
        },
        { timeout: 60000 },
      )
      .toBe('ar');
    await expect(site.locator('html')).toHaveAttribute('dir', 'rtl');
    // Each block keeps its own direction: the English text is still there, as written.
    await expect(site.locator('body')).toContainText('Welcome to the handbook.');

    // ---- Light and dark from the reader's system; Axe in both ----------------------------------
    const backgrounds: string[] = [];
    for (const colorScheme of ['light', 'dark'] as const) {
      // Script on for Axe and the computed style; the site's CSP is bypassed only to run Axe.
      const look = await reader(browser, { javaScriptEnabled: true, bypassCSP: true, colorScheme });
      await look.page.goto(address);
      backgrounds.push(
        // The page's colours are on the root element (the canvas), not the body.
        await look.page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
      );
      expect(await axe(look.page, `the site (${colorScheme}, Arabic)`)).toEqual([]);
      await look.page.goto(`${address}/${ids.leave}`);
      expect(await axe(look.page, `a database on the site (${colorScheme})`)).toEqual([]);
      await look.context.close();
    }
    expect(backgrounds[0]).not.toBe(backgrounds[1]);

    // ---- Unpublished: every address 404 within a minute -----------------------------------------
    const live = await publishView(page);
    await live.getByRole('button', { name: 'Unpublish', exact: true }).click();
    await live.getByRole('button', { name: 'Unpublish now' }).click();
    await expect(live.getByTestId('publish-message')).toContainText('Unpublished');
    await expect(live.getByRole('button', { name: 'Publish', exact: true })).toBeVisible();
    await close(live);
    await allGone([
      address,
      `${address}/${ids.leave}`,
      `${address}/${ids.payroll}`,
      `${address}/${ids.vendors}`,
    ]);
    await site.goto(address);
    await expect(site.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await anonymous.context.close();
    expect(errors).toEqual([]);
  } finally {
    await scene.api.dispose();
  }
});

test('nothing on the site’s origin can read the app’s or the API’s session', async ({ page }) => {
  test.setTimeout(240000);
  const owner = await newAccount('Session holder');
  await signedInWorkspace(page, owner, 'Session space', null, cloud.signer);
  await newPage(page, 'Public notes');
  await page.keyboard.type('Read by anyone.');
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  const api = await sessionOf(owner);
  try {
    await derived(api, pageId(page), 'Read by anyone.');
  } finally {
    await api.dispose();
  }
  const { address, dialog } = await publish(page, slugFor('notes'));
  await close(dialog);

  // Signed in to the app in this very browser: the API's session cookie is held for 127.0.0.1.
  const context = page.context();
  expect((await context.cookies(API)).length).toBeGreaterThan(0);
  const site = await context.newPage();
  const answer = (await site.goto(address))!;
  expect(answer.headers()['set-cookie']).toBeUndefined();
  await expect(site.locator('body')).toContainText('Read by anyone.');
  // The site's origin holds no cookie, sees none, and cannot use the API's.
  expect(await context.cookies(SITES)).toEqual([]);
  expect(await site.evaluate(() => document.cookie)).toBe('');
  const credentialed = await site.evaluate(async (api) => {
    try {
      const response = await fetch(`${api}/api/v1/account/session`, { credentials: 'include' });
      return `answered ${response.status}`;
    } catch {
      return 'failed';
    }
  }, API);
  expect(credentialed).toBe('failed');
  // The same answer whether the API's cookie is sent to the site or not: it reads no cookie.
  const cookie = (await context.cookies(API)).map((c) => `${c.name}=${c.value}`).join('; ');
  const withCookie = await fetch(address, { headers: { Cookie: cookie } });
  const without = await fetch(address);
  expect(withCookie.status).toBe(200);
  expect(withCookie.headers.get('set-cookie')).toBeNull();
  expect(await withCookie.text()).toBe(await without.text());
  await site.close();
});

test('turning publishing off takes every site of the workspace down, and refuses publishing', async ({
  page,
}) => {
  test.setTimeout(240000);
  const owner = await newAccount('Admin of sites');
  await signedInWorkspace(page, owner, 'Switch space', null, cloud.signer);
  await newPage(page, 'First site');
  await page.keyboard.type('One.');
  await waitSaved(page);
  const first = pageId(page);
  await newPage(page, 'Second site');
  await page.keyboard.type('Two.');
  await waitSaved(page);
  const second = pageId(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  const api = await sessionOf(owner);
  try {
    await derived(api, first, 'One.');
    await derived(api, second, 'Two.');
  } finally {
    await api.dispose();
  }
  const two = await publish(page, slugFor('second'));
  await close(two.dialog);
  await tree(page)
    .getByRole('treeitem', { name: /First site/ })
    .first()
    .click();
  await expect(editor(page)).toContainText('One.');
  const one = await publish(page, slugFor('first'));
  await close(one.dialog);
  for (const address of [one.address, two.address]) expect(await statusOf(address)).toBe(200);

  // Settings: the live sites, then the switch off, after asking.
  await page.goto('/#/settings/publishing');
  const section = page.getByTestId('publishing-settings');
  await expect(section.getByTestId('publishing-sites').getByRole('row')).toHaveCount(3);
  await section.getByLabel('Allow publishing pages to the web').click();
  await expect(section.getByRole('alertdialog')).toContainText('sites: 2');
  await section.getByRole('button', { name: 'Turn publishing off' }).click();
  await expect(section.getByTestId('publishing-message')).toContainText('Publishing is off');
  await expect(section.getByLabel('Allow publishing pages to the web')).not.toBeChecked();
  await allGone([one.address, two.address]);

  // While it is off, a page cannot be published; on again, no site comes back.
  await tree(page)
    .getByRole('treeitem', { name: /First site/ })
    .first()
    .click();
  const dialog = await publishView(page);
  await expect(dialog.getByTestId('publish-reason')).toContainText('turned off');
  await close(dialog);
  await page.goto('/#/settings/publishing');
  await section.getByLabel('Allow publishing pages to the web').click();
  await expect(section.getByLabel('Allow publishing pages to the web')).toBeChecked();
  await expect(section.getByTestId('publishing-none')).toBeVisible();
  expect(await statusOf(one.address)).toBe(404);
});
