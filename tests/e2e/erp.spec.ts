// Phase 5's Cash Gear ERP criteria (IMPLEMENTATION_PLAN.md, Phase 5) against the server stack and
// the mock ERP (tests/mocks/erp: its API on 4282, its client on 4284; UnifiedAPI and the real
// client with CGW_E2E_REAL_ERP, README.md), in Chrome and Edge, and on the built desktop app for
// the "nothing stored" test (its SQLite store):
//   - a workspace linked from the ERP client's page, the link ticket never in the address or the
//     history;
//   - an ERP block connected through the client's pop-up: vendors for a user with the privilege,
//     the specific refusal for one without, two users seeing different customers; paging, a sort,
//     a filter and Refresh;
//   - a revoked link and an expired session each with their message and no data; offline, that
//     ERP data needs a connection;
//   - after viewing ERP data (several connectors, pages, sorts, a refresh), none of it in any
//     store: every IndexedDB store, localStorage, sessionStorage, Cache Storage (the desktop: the
//     SQLite file and its WAL as bytes, its tables and its FTS index), the server's document, its
//     updates and versions, and search, while the block showed it.
import { dirname, join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { editor, newPage, waitSaved } from './helpers';
import { newAccount, signIn, signedIn, syncStatus } from './cloud';
import { pageId, signedInWorkspace, signers, signOutDesktop } from './database';
import {
  APP_ORIGIN,
  ERP_CLIENT,
  REAL_ERP,
  chooseConnector,
  connectErp,
  connectErpDesktop,
  deviceDump,
  erpBlock,
  erpMarkers,
  erpRange,
  found,
  foundInBytes,
  insertErpBlock,
  linkWorkspace,
  mockErp,
  searchHits,
  serverPage,
  sessionOf,
  sqliteDump,
  watchAppErrors,
  workspaceIdOf,
} from './ecosystem';

const cloud = signers();
test.afterEach(async ({ page }) => {
  await cloud.close();
  await signOutDesktop(page);
});
test.beforeEach(async () => {
  if (!REAL_ERP) await mockErp.reset();
});

/** The browser's lines for the ERP's refusals a test asks for (browsers log every 4xx). */
const refusal = (status: number, path: string) =>
  new RegExp(`status of ${status} .*/api/connect/${path}$`);

const table = (block: Locator) => block.getByTestId('erp-table');
const rows = (block: Locator) => table(block).locator('tbody tr');

/** A page with an ERP block in a linked workspace, signed in; the link and the ids. */
async function erpPage(page: Page, name: string, authUrlFile: string | null = null) {
  const account = await newAccount(name);
  await signedInWorkspace(page, account, `${name} space`, authUrlFile, cloud.signer);
  const api = await sessionOf(account);
  const workspaceId = await workspaceIdOf(api, `${name} space`);
  const link = await linkWorkspace(api, workspaceId, `${name} space`);
  await newPage(page, `${name} page`);
  await page.keyboard.type('Before the ERP data.');
  await page.keyboard.press('Enter');
  await insertErpBlock(page);
  return { account, api, workspaceId, link, block: erpBlock(page) };
}

/** Kit's records of a connector in the mock, in the ERP's order (id order). */
async function kitRecords(connector: string) {
  const state = await mockErp.state();
  return state.records[connector].filter((r) => r.company === 'Kit');
}

/** The table's text for a column, row by row. */
const column = (block: Locator, field: string) =>
  block.evaluate((el, field) => {
    const head = [...el.querySelectorAll('[data-testid="erp-table"] thead th')];
    const at = head.findIndex((th) => th.getAttribute('data-field') === field);
    return [...el.querySelectorAll('[data-testid="erp-table"] tbody tr')].map(
      (tr) => tr.children[at]?.textContent ?? '',
    );
  }, field);

test('a workspace is linked from the ERP client, and the link ticket is never in the address or the history', async ({
  page,
}) => {
  test.skip(desktop, 'The ERP client opens Workspace in a browser');
  test.skip(REAL_ERP, "The real client's link page is behind its own sign-in");
  test.setTimeout(180000);
  // The mock client's pages have no icon.
  const errors = watchAppErrors(page, [/status of 404 .*:4284\/favicon\.ico$/]);
  const account = await newAccount('Linker');
  await signedInWorkspace(page, account, 'Linked space', null, cloud.signer);
  const api = await sessionOf(account);
  try {
    // The ERP admin's page in the ERP client: it makes a link ticket and opens Workspace with it.
    await page.goto(`${ERP_CLIENT}/link?workspace=${encodeURIComponent(APP_ORIGIN)}`);
    await page.locator('#admin').selectOption('dan');
    // The ticket the ERP made, read on its way to the page (which then leaves for Workspace).
    let url = '';
    await page.route('**/api/system/WorkspaceLink/CreateTicket', async (route) => {
      const response = await route.fetch();
      url = ((await response.json()) as { url: string }).url;
      await route.fulfill({ response });
    });
    await page.locator('#link').click();
    await expect.poll(() => url).toMatch(/\/erp-link\/[A-Za-z0-9_-]{43}$/);
    const ticket = /\/erp-link\/([A-Za-z0-9_-]{43})$/.exec(url)![1];
    await page.waitForURL((u) => u.origin === APP_ORIGIN);
    const screen = page.getByTestId('erp-link-screen');
    await expect(screen).toBeVisible({ timeout: 30000 });
    expect(page.url()).toBe(`${APP_ORIGIN}/#/erp-link`);
    expect(await page.evaluate(() => location.href)).not.toContain(ticket);

    await screen.getByRole('radio', { name: 'Linked space' }).check();
    await screen.getByRole('button', { name: 'Link this workspace' }).click();
    await expect(page.getByTestId('erp-link-done')).toHaveText(
      'Kit Trading is now linked to Linked space.',
    );
    expect(page.url()).not.toContain(ticket);

    // The history: back is the ERP client's page, forward the screen, and neither holds the
    // ticket (it was sent once and is forgotten: the screen says there is none).
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`^${ERP_CLIENT}/link`));
    expect(page.url()).not.toContain(ticket);
    await page.goForward();
    await expect(page).toHaveURL(`${APP_ORIGIN}/#/erp-link`);
    await expect(page.getByTestId('erp-link-no-ticket')).toBeVisible({ timeout: 30000 });

    // Both sides hold the link; settings show it.
    const workspaceId = await workspaceIdOf(api, 'Linked space');
    const { links } = (await api.get(`/api/v1/workspaces/${workspaceId}/erp-links`)) as {
      links: { company: string; companyName: string; erpLinkId: string }[];
    };
    expect(links).toEqual([
      expect.objectContaining({ company: 'Kit', companyName: 'Kit Trading' }),
    ]);
    const erp = (await mockErp.state()).links;
    expect(erp).toEqual([
      expect.objectContaining({ linkId: links[0].erpLinkId, workspaceId, revokedAt: null }),
    ]);
    await page.goto('/#/settings');
    const settings = page.getByTestId('erp-settings');
    await expect(settings.getByTestId('erp-links')).toContainText('Kit Trading');
    await expect(settings).toContainText(`Linked by ${account.name}`);
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test('an ERP block shows vendors to a user with the privilege, refuses one without, and two users see different customers', async ({
  page,
}) => {
  test.skip(
    desktop,
    'The desktop connects through the system browser: see the "nothing stored" test',
  );
  const browser = page.context().browser()!;
  test.setTimeout(300000);
  const errors = watchAppErrors(page);
  const { account, api, block } = await erpPage(page, 'Buyer');
  try {
    await expect(block.getByTestId('erp-not-connected')).toBeVisible({ timeout: 30000 });
    await connectErp(page, block, 'alice');
    await chooseConnector(block, 'Vendors');
    await expect(block.getByTestId('erp-title')).toHaveText('Vendors');
    if (!REAL_ERP) await expect(block).toContainText('Kit Trading: Alice Haddad');
    const vendors = REAL_ERP ? [] : await kitRecords('vendors');
    if (!REAL_ERP) {
      await expect(erpRange(block)).toHaveText('Records 1–50 of 150');
      await expect(rows(block)).toHaveCount(50);
      expect(await column(block, 'vendorName')).toEqual(
        vendors.slice(0, 50).map((v) => String(v.values.vendorName)),
      );
      // Only this company's records: Dot's share the ERP's database.
      await expect(table(block)).not.toContainText('Ferrowyn');
    } else await expect(erpRange(block)).toHaveText(/^Records 1–\d+ of \d+$/);
    await waitSaved(page);

    // Paging, there and back.
    if (!REAL_ERP) {
      await block.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(erpRange(block)).toHaveText('Records 51–100 of 150');
      expect((await column(block, 'vendorName'))[0]).toBe(String(vendors[50].values.vendorName));
      await block.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(erpRange(block)).toHaveText('Records 1–50 of 150');
    }

    // A sort: by name, descending, as the ERP sorts.
    await block.getByRole('button', { name: 'Sort', exact: true }).click();
    await block.getByRole('button', { name: 'Add a sort' }).click();
    await block.getByLabel('Sort 1 by').selectOption({ label: 'Name' });
    await block.getByLabel('Direction of sort 1').selectOption('desc');
    await expect(table(block).locator('th[data-field="vendorName"]')).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    if (!REAL_ERP) {
      const last = [...vendors]
        .map((v) => String(v.values.vendorName))
        .sort((a, b) => b.localeCompare(a, 'en', { sensitivity: 'base' }))[0];
      await expect.poll(async () => (await column(block, 'vendorName'))[0]).toBe(last);
    }
    await block.getByRole('button', { name: 'Close', exact: true }).click();

    // A filter: the ERP's own search over its list.
    await block.getByRole('button', { name: 'Filter', exact: true }).click();
    const search = block.getByRole('searchbox', { name: 'Search' });
    await search.fill(REAL_ERP ? 'a' : 'qorvath');
    await search.press('Enter');
    await expect(block.getByRole('button', { name: 'Filters: 1' })).toBeVisible();
    if (!REAL_ERP) {
      const hits = vendors.filter((v) =>
        ['vendorAccount', 'vendorName', 'vendorGroup', 'mobile'].some((f) =>
          String(v.values[f] ?? '')
            .toLowerCase()
            .includes('qorvath'),
        ),
      );
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.length).toBeLessThan(50);
      await expect(erpRange(block)).toHaveText(`Records 1–${hits.length} of ${hits.length}`);
      for (const name of await column(block, 'vendorName')) expect(name).toMatch(/Qorvath/);
    }
    await block.getByRole('button', { name: 'Close', exact: true }).click();

    // Refresh asks the ERP again.
    const asked = page.waitForRequest((r) => /\/Connectors\/vendors\/Query$/.test(r.url()));
    await block.getByRole('button', { name: 'Refresh', exact: true }).click();
    await asked;
    await expect(block.getByTestId('erp-loaded-at')).toHaveText(/^Loaded /);
    await expect(table(block)).toBeVisible();
    await waitSaved(page);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    const id = pageId(page);

    // Another tab of the same person, connected as an ERP user with no privilege for Vendors:
    // the specific refusal, and no record.
    const second = await browser.newContext();
    const there = await second.newPage();
    const thereErrors = watchAppErrors(there, [refusal(403, 'Connectors/vendors/Schema')]);
    await there.goto('/');
    await signIn(there, account);
    await signedIn(there, account);
    await there.goto(`/#/p/${id}`);
    await expect(editor(there)).toContainText('Before the ERP data.', { timeout: 30000 });
    const refused = erpBlock(there);
    await connectErp(there, refused, 'carol');
    await expect(refused.getByTestId('erp-schema-error')).toContainText(
      'Your Cash Gear ERP account has no access to this data.',
      { timeout: 30000 },
    );
    await expect(table(refused)).toHaveCount(0);
    await second.close();
    expect(thereErrors).toEqual([]);

    // Customers: alice and bob (who sees only his own salesperson's) see different rows.
    await block
      .getByRole('group', { name: 'View settings' })
      .getByLabel('Data')
      .selectOption({ label: 'Customers' });
    await expect(block.getByTestId('erp-title')).toHaveText('Customers', { timeout: 30000 });
    await expect(table(block)).toBeVisible({ timeout: 30000 });
    const customers = REAL_ERP ? [] : await kitRecords('customers');
    if (!REAL_ERP) await expect(erpRange(block)).toHaveText('Records 1–50 of 240');
    const aliceTotal = Number((await erpRange(block).innerText()).match(/of (\d+)/)![1]);
    const aliceNames = await column(block, 'customerName');
    await expect(table(block).locator('th[data-field="creditLimit"]')).toHaveCount(1);
    await waitSaved(page);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    const third = await browser.newContext();
    const bobs = await third.newPage();
    const bobErrors = watchAppErrors(bobs);
    await bobs.goto('/');
    await signIn(bobs, account);
    await signedIn(bobs, account);
    await bobs.goto(`/#/p/${id}`);
    const bobBlock = erpBlock(bobs);
    await connectErp(bobs, bobBlock, 'bob');
    await expect(bobBlock.getByTestId('erp-title')).toHaveText('Customers', { timeout: 30000 });
    await expect(table(bobBlock)).toBeVisible({ timeout: 30000 });
    const bobTotal = Number((await erpRange(bobBlock).innerText()).match(/of (\d+)/)![1]);
    expect(bobTotal).toBeLessThan(aliceTotal);
    const bobNames = await column(bobBlock, 'customerName');
    expect(bobNames).not.toEqual(aliceNames.slice(0, bobNames.length));
    await expect(table(bobBlock).locator('th[data-field="creditLimit"]')).toHaveCount(0);
    if (!REAL_ERP) {
      const his = customers.filter((c) => c.values.salesperson === 'S-BOB');
      expect(bobTotal).toBe(his.length);
      expect(bobNames).toEqual(his.slice(0, 50).map((c) => String(c.values.customerName)));
      // What alice sees that bob does not: another salesperson's customer.
      const others = aliceNames.filter((n) => !his.some((c) => c.values.customerName === n));
      expect(others.length).toBeGreaterThan(0);
    }
    await third.close();
    expect(bobErrors).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test('offline the block says ERP data needs a connection; an expired session and a revoked link each say so and show no data', async ({
  page,
}) => {
  test.skip(
    desktop,
    'The desktop connects through the system browser: see the "nothing stored" test',
  );
  test.setTimeout(240000);
  const errors = watchAppErrors(page, [
    refusal(401, 'Connectors/vendors/Query'),
    refusal(401, 'Session/Renew'),
    refusal(403, 'Connectors/vendors/Query'),
    /ERR_INTERNET_DISCONNECTED/,
  ]);
  const { api, block, link } = await erpPage(page, 'Field');
  try {
    await connectErp(page, block, 'alice');
    await chooseConnector(block, 'Vendors');
    await waitSaved(page);

    // Offline: no data, and why.
    await page.context().setOffline(true);
    await expect(block.getByTestId('erp-offline')).toHaveText('ERP data needs a connection.');
    await expect(table(block)).toHaveCount(0);
    await page.context().setOffline(false);
    await expect(table(block)).toBeVisible({ timeout: 30000 });

    test.skip(REAL_ERP, "The rest moves the mock ERP's clock and revokes its link");
    // The session's 30 idle minutes pass at the ERP: the next read finds it ended.
    await mockErp.clock(31 * 60_000);
    await block.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(block.getByTestId('erp-expired')).toContainText(
      'Your Cash Gear ERP session ended.',
      { timeout: 30000 },
    );
    await expect(table(block)).toHaveCount(0);
    await connectErp(page, block, 'alice');
    await expect(table(block)).toBeVisible({ timeout: 30000 });

    // The ERP ends the link: nothing from it, and no way to connect from the block.
    await mockErp.revokeLink(link.erpLinkId);
    await block.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(block.getByTestId('erp-revoked')).toContainText(
      'Cash Gear ERP ended this workspace’s link to Kit Trading. Nothing from it is shown.',
      { timeout: 30000 },
    );
    await expect(table(block)).toHaveCount(0);
    await expect(block.getByRole('button', { name: /^Connect/ })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test('nothing stored: after viewing ERP data, none of it is in any store, the document, its history or search', async ({
  page,
  authUrlFile,
  savedFolder,
}) => {
  test.setTimeout(420000);
  const errors = watchAppErrors(page);
  const { api, block, workspaceId } = await erpPage(page, 'Ledger', authUrlFile);
  const markers = await erpMarkers();
  if (!REAL_ERP) expect(markers.length).toBeGreaterThan(10);
  try {
    // Viewed: three connectors, pages, a sort, a filter, refreshes. Everything shown is kept here
    // to prove the block showed what the stores must not hold.
    const shown: string[] = [];
    const keep = async () => shown.push(await table(block).innerText());
    if (desktop) await connectErpDesktop(page, block, 'alice');
    else await connectErp(page, block, 'alice');
    await chooseConnector(block, 'Vendors');
    await keep();
    await block.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(erpRange(block)).toHaveText(/^Records 51–/);
    await keep();
    await block.getByRole('button', { name: 'Sort', exact: true }).click();
    await block.getByRole('button', { name: 'Add a sort' }).click();
    await block.getByLabel('Sort 1 by').selectOption({ label: 'Name' });
    await block.getByLabel('Direction of sort 1').selectOption('desc');
    await expect(table(block).locator('th[data-field="vendorName"]')).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    await keep();
    await block.getByRole('button', { name: 'Close', exact: true }).click();
    // The filter is the editor's own words (kept in the block), not a value of the ERP's.
    await block.getByRole('button', { name: 'Filter', exact: true }).click();
    await block.getByRole('searchbox', { name: 'Search' }).fill('Supplies');
    await block.getByRole('searchbox', { name: 'Search' }).press('Enter');
    await expect(block.getByRole('button', { name: 'Filters: 1' })).toBeVisible();
    await expect(table(block)).toBeVisible({ timeout: 30000 });
    await keep();
    await block.getByRole('button', { name: 'Close', exact: true }).click();
    await block.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(table(block)).toBeVisible({ timeout: 30000 });
    await keep();
    const data = block.getByRole('group', { name: 'View settings' }).getByLabel('Data');
    await data.selectOption({ label: 'Customers' });
    await expect(block.getByTestId('erp-title')).toHaveText('Customers', { timeout: 30000 });
    await expect(table(block)).toBeVisible({ timeout: 30000 });
    await keep();
    await block.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(erpRange(block)).toHaveText(/^Records 51–/);
    await keep();
    await data.selectOption({ label: 'Items on hand' });
    await expect(block.getByTestId('erp-title')).toHaveText('Items on hand', { timeout: 30000 });
    await expect(table(block)).toBeVisible({ timeout: 30000 });
    await keep();
    await block.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(table(block)).toBeVisible({ timeout: 30000 });
    await keep();
    const seen = found(shown.join('\n'), markers);
    if (!REAL_ERP) expect(seen.length, 'the ERP values the block showed').toBeGreaterThan(5);
    await waitSaved(page);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    const id = pageId(page);

    // This device: everything its origin keeps (in the desktop's window too).
    const device = await deviceDump(page);
    // What the page wrote is here (its title, and the block's settings in the document's bytes;
    // typed text is kept a keystroke at a time, so not as one string), and nothing of the ERP's.
    // The desktop's window keeps only its preferences: its store is SQLite, below.
    if (!desktop) {
      expect(device.text, 'the page is on this device').toContain('Ledger page');
      expect(device.text, "the block's settings are on this device").toContain('itemsOnHand');
    }
    expect(found(device.text, markers), device.summary.join('; ')).toEqual([]);
    if (desktop) {
      // The desktop's SQLite store: its file and WAL as bytes, the assets beside them, every
      // table's rows and the FTS index's terms.
      const store = await sqliteDump(join(dirname(savedFolder!), 'data'));
      for (const written of ['Ledger page', 'itemsOnHand'])
        expect(foundInBytes(store.files, [written]), written).not.toEqual([]);
      expect(store.terms).toContain('ledger');
      expect(store.tables).toContain('search');
      expect(foundInBytes(store.files, markers)).toEqual([]);
      expect(found(store.rows, markers)).toEqual([]);
      expect(found(store.terms.join('\n'), markers)).toEqual([]);
    }

    // The server: the document the worker derived (holding the block's settings, which name the
    // connector and the filter's words), its updates, a version made now, and search.
    const server = await serverPage(api, id, 'itemsOnHand');
    expect(server.json).toContain('erpView');
    expect(server.json).toContain('Before the ERP data.');
    expect(found(server.json, markers)).toEqual([]);
    expect(found(server.updates, markers)).toEqual([]);
    expect(server.versions.length).toBeGreaterThan(0);
    expect(server.versions.join('\n')).toContain('itemsOnHand');
    expect(found(server.versions.join('\n'), markers)).toEqual([]);
    await expect
      .poll(
        async () => (await searchHits(api, workspaceId, 'Before the ERP')).map((h) => h.pageId),
        {
          timeout: 60000,
        },
      )
      .toContain(id);
    for (const marker of markers)
      expect(await searchHits(api, workspaceId, marker), `search for ${marker}`).toEqual([]);

    // The app's own search (this device's index and the server's) finds none either.
    await page.keyboard.press('Control+KeyK');
    const palette = page.getByRole('dialog');
    const field = palette.getByRole('combobox');
    await field.fill('Before the ERP');
    await expect(palette.getByRole('option', { name: /Ledger page/ })).toBeVisible({
      timeout: 30000,
    });
    for (const marker of markers.slice(0, 4)) {
      const before = await page.evaluate(() => performance.getEntriesByName('cgw-search').length);
      await field.fill(marker);
      await page.waitForFunction(
        (n) => performance.getEntriesByName('cgw-search').length > n,
        before,
        { timeout: 30000 },
      );
      await page.waitForTimeout(500);
      await expect(palette.getByRole('option', { name: /Ledger page/ })).toHaveCount(0);
    }
    await page.keyboard.press('Escape');
    // And the block still shows the ERP's data, from memory and the ERP.
    expect(found(await table(block).innerText(), markers).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
  }
});
