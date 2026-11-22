// Phase 14, M14.4: a published site at a host name its workspace proved. An owner adds the name in
// Settings → Publishing, is shown the DNS record that proves it (set in the mock provider's DNS
// stand-in here) and verifies it; the page's share dialog gives the site the name; the worker gets
// its certificate from the mock ACME server (HTTP-01 answered by the Sites process); the site then
// reads at the name with no account and with script off, its slug's address leads there, and the
// dialog and Settings show it without a reload (the feed's `publishing` change); unpublished, the
// name answers 404 within a minute. Axe on the new screens and the site at its name.
//
// A `*.localhost` name: Chrome and Edge send it to the loopback address, so no DNS is needed; the
// Sites process of the e2e stack answers it on 5290 as it would a real name on 443.
import AxeBuilder from '@axe-core/playwright';
import { request as httpRequest } from 'node:http';
import type { Browser, Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { editor, newPage, waitSaved } from './helpers';
import { newAccount, syncStatus } from './cloud';
import { pageId, signedInWorkspace, signers } from './database';
import { sessionOf, workspaceIdOf, type Api } from './ecosystem';

test.skip(desktop, 'A site is read in a browser with no account: the browsers run this');

const SITES = process.env.E2E_SITES_URL ?? 'http://localhost:5290';
const DNS = process.env.E2E_DNS_URL ?? 'http://127.0.0.1:4287';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const cloud = signers();
test.afterEach(async () => {
  await cloud.close();
});

/** A status and a Location of the Sites process at a host name, asked from Node (which may not resolve `*.localhost`). */
function at(host: string, path: string): Promise<{ status: number; location: string | null }> {
  const sites = new URL(SITES);
  return new Promise((resolve, reject) => {
    const asked = httpRequest(
      {
        host: '127.0.0.1',
        port: Number(sites.port || 80),
        path,
        headers: { Host: `${host}:${sites.port}` },
      },
      (answer) => {
        answer.resume();
        resolve({ status: answer.statusCode ?? 0, location: answer.headers.location ?? null });
      },
    );
    asked.on('error', reject);
    asked.end();
  });
}

async function axe(page: Page, where: string, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(WCAG);
  if (include) builder = builder.include(include);
  const result = await builder.analyze();
  return result.violations.map(
    (v) =>
      `${where}: ${v.id} (${v.impact}) ${v.help} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}

/** Waits until the worker has derived the page's document with this text (sites render from it). */
async function derived(api: Api, id: string, text: string) {
  await expect
    .poll(
      async () => JSON.stringify(await api.get(`/api/v1/pages/${id}/doc/json`).catch(() => null)),
      { timeout: 60000 },
    )
    .toContain(text);
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

async function reader(browser: Browser) {
  const context = await browser.newContext({ javaScriptEnabled: false });
  return { context, page: await context.newPage() };
}

test('a site at a host name its workspace proved, by a certificate from ACME, its slug leading there', async ({
  page,
  browser,
}) => {
  test.setTimeout(240000);
  const owner = await newAccount('Domains');
  await signedInWorkspace(page, owner, 'Domain space', null, cloud.signer);
  const api = await sessionOf(owner);
  const workspaceId = await workspaceIdOf(api, 'Domain space');
  await newPage(page, 'Field guide');
  await page.keyboard.type('Read me at our own name.');
  await waitSaved(page);
  await expect(editor(page)).toContainText('Read me at our own name.');
  const root = pageId(page);
  await expect(syncStatus(page)).toHaveAttribute('data-state', 'synced', { timeout: 30000 });
  await derived(api, root, 'Read me at our own name.');

  // Published at its slug first.
  const slug = `field-guide-${Date.now().toString(36)}`;
  let dialog = await publishView(page);
  await dialog.getByLabel('Address').fill(slug);
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(dialog.getByTestId('site-url')).toHaveAttribute('href', `${SITES}/${slug}`, {
    timeout: 20000,
  });
  await expect(dialog.getByTestId('site-address')).toContainText(
    'No host name of the workspace is proven yet.',
  );
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  // Settings → Publishing: the name added, its record shown, set at "DNS", verified.
  const host = `guide-${Date.now().toString(36)}.localhost`;
  await page.goto('/#/settings');
  const domains = page.getByTestId('site-domains');
  await expect(domains).toBeVisible({ timeout: 30000 });
  await domains.getByLabel('Host name').fill(host);
  await domains.getByRole('button', { name: 'Add', exact: true }).click();
  const row = domains.locator(`[data-host="${host}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(`_cashgear-workspace.${host}`);
  const found: string[] = [
    ...(await axe(page, 'Settings, a name to prove', '[data-testid="site-domains"]')),
  ];
  const value = (await row.getByTestId('domain-record-value').textContent())!;
  const set = await fetch(`${DNS}/__mock/dns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `_cashgear-workspace.${host}`, txt: value }),
  });
  expect(set.status).toBe(204);
  await row.getByRole('button', { name: `Verify ${host}` }).click();
  await expect(row.getByTestId('domain-state')).toHaveText('Proven, not given to a site');

  // The site given the name in its share dialog; its certificate made by the worker meanwhile.
  await page.goto(`/#/p/${root}`);
  await expect(editor(page)).toContainText('Read me at our own name.');
  dialog = await publishView(page);
  await dialog.getByLabel('Host name').selectOption(host);
  await dialog.getByRole('button', { name: 'Use this address' }).click();
  await expect(dialog.getByTestId('site-address-message')).toContainText(host);
  // Live: the dialog reads the site again on the feed's change, and its address is the name.
  await expect(dialog.getByTestId('site-url')).toHaveAttribute('href', `http://${host}:5290`, {
    timeout: 90000,
  });
  await expect(dialog.getByTestId('site-address-state')).toContainText('Certificate until');
  found.push(...(await axe(page, 'the share dialog with a name', '[role="dialog"]')));
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  // Read at the name, with no account and script off; the slug's addresses lead there.
  const visitor = await reader(browser);
  await visitor.page.goto(`http://${host}:5290/`);
  await expect(visitor.page.locator('main')).toContainText('Read me at our own name.');
  await expect(visitor.page.locator('header a')).toHaveAttribute('href', '/');
  // Axe runs as script in the page: a reader with script on, for it alone.
  const checked = await browser.newContext();
  const checking = await checked.newPage();
  await checking.goto(`http://${host}:5290/`);
  found.push(...(await axe(checking, 'the site at its name')));
  await checked.close();
  const moved = await fetch(`${SITES}/${slug}`, { redirect: 'manual' });
  expect(moved.status).toBe(302);
  expect(moved.headers.get('location')).toBe(`http://${host}:5290/`);
  expect((await at(host, '/robots.txt')).status).toBe(200);
  expect((await at(`nobody-${Date.now().toString(36)}.localhost`, '/')).status).toBe(404);

  // Settings shows it without a reload: serving the page, its certificate live.
  await page.goto('/#/settings');
  await expect(domains.locator(`[data-host="${host}"]`).getByTestId('domain-state')).toHaveText(
    'Serves “Field guide”',
    { timeout: 30000 },
  );
  await expect(
    domains.locator(`[data-host="${host}"]`).getByTestId('domain-certificate'),
  ).toContainText('Certificate until');
  found.push(
    ...(await axe(page, 'Settings, a name serving a site', '[data-testid="site-domains"]')),
  );

  // Unpublished: the name answers 404 within a minute (the Sites process holds a site 30 s at most).
  await page.goto(`/#/p/${root}`);
  dialog = await publishView(page);
  await dialog.getByRole('button', { name: 'Unpublish', exact: true }).click();
  await dialog.getByRole('button', { name: 'Unpublish now' }).click();
  await expect(dialog.getByTestId('publish-message')).toBeVisible();
  await expect
    .poll(async () => (await at(host, '/')).status, { timeout: 60000, intervals: [1000] })
    .toBe(404);
  await visitor.context.close();
  expect(found).toEqual([]);
  expect(workspaceId).toBeTruthy();
});
