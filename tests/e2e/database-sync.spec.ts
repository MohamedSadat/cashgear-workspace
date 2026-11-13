// Phase 4 against the server stack (scripts/server-stack.mjs --e2e), in Chrome and Edge and on the
// built desktop app: a database reaching a second device; two devices editing one row offline,
// different properties and the same one, then online (the per-property rule: both different
// edits stand, the same property is the last to reach the server's); a database over 5,000 rows
// imported through the server's route, shown through the server's query, and offline showing the
// rows on the device with its notice; the view exported through the server's route; a search hit
// of a row not on the device; and a shared link drawing the database block's note.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, desktop } from './fixtures';
import { editor, newPage, waitSaved, watchErrors } from './helpers';
import { newAccount, syncStatus } from './cloud';
import { apiSession } from '../../scripts/cloud-account.mjs';
import {
  addProperty,
  chooseOptions,
  fullPage,
  grid,
  network,
  newDatabase,
  openRow,
  otherDevice,
  rowOf,
  rowValue,
  showView,
  signedInWorkspace,
  signers,
  signOutDesktop,
  treeRow,
  typeValue,
} from './database';

const cloud = signers();
test.afterEach(async ({ page }) => {
  await cloud.close();
  await signOutDesktop(page);
});

const LOCAL_ONLY = 'Showing rows on this device. More may appear when you are back online.';
/** Requests refused while the network is off are the browser's own errors, not the app's. */
const appErrors = (errors: string[]) =>
  errors.filter(
    (e) => !/ERR_INTERNET_DISCONNECTED|ERR_BLOCKED_BY_CLIENT|ERR_NETWORK_CHANGED/.test(e),
  );

test('a database reaches a second device, and offline edits on two devices follow the per-property rule', async ({
  page,
  authUrlFile,
}) => {
  test.setTimeout(300000);
  const errors = watchErrors(page);
  const account = await newAccount('Two devices');
  await signedInWorkspace(page, account, 'Rule space', authUrlFile, cloud.signer);
  const databaseId = await newDatabase(page, 'Tasks');
  const db = fullPage(page);
  await showView(db, 'All tasks');
  await addProperty(page, 'Text', 'Notes');
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });

  // The other device: the database, its views and its rows.
  const other = await otherDevice(
    desktop ? await cloud.signer() : page.context().browser()!,
    account,
  );
  await treeRow(other.page, 'Tasks').click({ timeout: 30000 });
  const there = fullPage(other.page);
  for (const view of ['Board', 'All tasks', 'Calendar', 'My tasks'])
    await expect(there.getByRole('tab', { name: view })).toBeVisible();
  await showView(there, 'All tasks');
  await expect(there.getByRole('status')).toHaveText('Rows: 4', { timeout: 30000 });
  await expect(there.getByRole('columnheader', { name: 'Notes, Text' })).toBeVisible();

  // Both offline: one row edited on each, a property of its own each and one property on both.
  const here = await network(page, page.context());
  const away = await network(other.page, other.context);
  await here.off();
  await away.off();
  await expect(syncStatus(page)).toHaveText(/^Offline/, { timeout: 20000 });
  await expect(syncStatus(other.page)).toHaveText(/^Offline/, { timeout: 20000 });
  await openRow(page, 'Review the budget');
  await chooseOptions(page, 'Status', ['Done']);
  await chooseOptions(page, 'Priority', ['High']);
  await openRow(other.page, 'Review the budget', there);
  await typeValue(other.page, 'Notes', 'Checked on the second device');
  await chooseOptions(other.page, 'Priority', ['Low']);

  // This device reaches the server first, the other second: its Priority is the last.
  await here.on();
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  await away.on();
  await expect(syncStatus(other.page)).toHaveText('Synced', { timeout: 30000 });
  const expected: [string, string][] = [
    ['Status', 'Done'],
    ['Notes', 'Checked on the second device'],
    ['Priority', 'Low'],
  ];
  for (const [name, text] of expected) {
    await expect(rowValue(other.page, name)).toHaveText(text, { timeout: 30000 });
    await expect(rowValue(page, name)).toHaveText(text, { timeout: 30000 });
  }
  // The server holds the same, and Priority's version rose with each write.
  const api = await apiSession(account);
  try {
    const { rows } = await api.get(`/api/v1/databases/${databaseId}/rows?limit=100`);
    const row = rows.find((r: { title: string }) => r.title === 'Review the budget');
    const database = (await api.get(`/api/v1/workspaces/${row.workspaceId}/tree`)).databases.find(
      (d: { id: string }) => d.id === databaseId,
    );
    const id = (name: string) =>
      database.properties.find((p: { name: string }) => p.name === name).id;
    const option = (name: string, label: string) =>
      database.properties
        .find((p: { name: string }) => p.name === name)
        .options.find((o: { name: string }) => o.name === label).id;
    expect(row.values[id('Status')]).toBe(option('Status', 'Done'));
    expect(row.values[id('Priority')]).toBe(option('Priority', 'Low'));
    expect(row.values[id('Notes')]).toBe('Checked on the second device');
    expect(row.versions[id('Priority')]).toBeGreaterThanOrEqual(2);
  } finally {
    await api.dispose();
  }
  await other.context.close();
  expect(appErrors(errors)).toEqual([]);
});

test('over 5,000 rows: imported through the server, shown by its query, offline from the device, exported by the server', async ({
  page,
  authUrlFile,
  savedFolder,
}, testInfo) => {
  test.setTimeout(300000);
  const errors = watchErrors(page);
  const account = await newAccount('Big data');
  await signedInWorkspace(page, account, 'Big space', authUrlFile, cloud.signer);
  const databaseId = await newDatabase(page, 'Empty database', { title: 'Stock' });
  const db = fullPage(page);
  await addProperty(page, 'Number', 'Size');
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });

  // 6,000 rows from a file: more than a device queries itself, so the server imports them.
  const lines = ['Name,Size'];
  for (let i = 1; i <= 6000; i++) lines.push(`Item ${String(i).padStart(4, '0')},${i}`);
  await db.getByRole('button', { name: /^View options/ }).click();
  await page.getByRole('menuitem', { name: 'Import CSV…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import CSV' });
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose a CSV file' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'Stock.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(lines.join('\r\n') + '\r\n'),
  });
  await expect(dialog).toContainText('Stock.csv: 6000 rows');
  await expect(dialog).toContainText('the server imports it');
  const imported = page.waitForResponse((r) => /\/databases\/[^/]+\/import$/.test(r.url()));
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  expect((await imported).status()).toBe(200);
  await expect(dialog).toContainText('Imported rows: 6000', { timeout: 120000 });
  await dialog.getByRole('button', { name: 'Close' }).first().click();

  // The table pages through the server's query.
  const query = page.waitForResponse((r) => /\/databases\/[^/]+\/query$/.test(r.url()), {
    timeout: 60000,
  });
  await page.reload();
  await expect(db).toBeVisible();
  expect((await query).status()).toBe(200);
  await expect(db.getByRole('status')).toHaveText(/^Rows: \d+ of 6000$/, { timeout: 60000 });
  await expect(rowOf(db, 'Item 0001')).toBeVisible();
  // The table scrolls inside the page and draws only the rows in its window (it grew to its rows'
  // height before, the page scrolled, and every row loaded was drawn).
  await grid(db).evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(db.getByRole('status')).toHaveText(/^Rows: 200 of 6000$/, { timeout: 30000 });
  const drawn = await grid(db).evaluate((el) => ({
    rows: el.querySelectorAll('[role="row"][aria-rowindex]').length,
    scrolls: el.scrollHeight > el.clientHeight,
    inWindow: el.getBoundingClientRect().bottom <= innerHeight + 1,
  }));
  expect(drawn).toMatchObject({ scrolls: true, inWindow: true });
  expect(drawn.rows).toBeLessThan(60);
  await grid(db).evaluate((el) => (el.scrollTop = 0));
  // A sort the server does: Size, descending.
  await db.getByRole('button', { name: 'Sort', exact: true }).click();
  const sorts = page.getByRole('dialog', { name: 'Sorts' });
  await sorts.getByRole('button', { name: 'Add a sort', exact: true }).click();
  await sorts.getByRole('combobox', { name: 'Property' }).selectOption({ label: 'Size' });
  await sorts.getByRole('combobox', { name: 'Direction' }).selectOption({ label: 'Descending' });
  await page.keyboard.press('Escape');
  await expect(rowOf(db, 'Item 6000')).toBeVisible({ timeout: 30000 });
  const first = grid(db).locator('[role="row"][aria-rowindex="2"] .cgw-title-text');
  await expect(first).toHaveText('Item 6000');
  // Search through the server.
  await db.getByRole('searchbox', { name: 'Search rows by title' }).fill('Item 4321');
  await expect(db.getByRole('status')).toHaveText('Rows: 1', { timeout: 30000 });
  await expect(rowOf(db, 'Item 4321')).toBeVisible();
  await db.getByRole('searchbox', { name: 'Search rows by title' }).fill('');
  await expect(db.getByRole('status')).toHaveText(/of 6000$/, { timeout: 30000 });

  // Offline: the rows on this device, and the notice saying so.
  const net = await network(page, page.context());
  await net.off();
  await expect(syncStatus(page)).toHaveText(/^Offline/, { timeout: 20000 });
  await page.reload();
  await expect(db).toBeVisible({ timeout: 30000 });
  await expect(db.getByRole('status').filter({ hasText: LOCAL_ONLY })).toBeVisible({
    timeout: 30000,
  });
  await expect(rowOf(db, 'Item 6000')).toBeVisible();
  await net.on();
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  await expect(db.getByRole('status').filter({ hasText: LOCAL_ONLY })).toHaveCount(0, {
    timeout: 30000,
  });

  // The view exported: not all its rows are here, so the server writes the file.
  const exported = page.waitForResponse((r) => /\/databases\/[^/]+\/export/.test(r.url()));
  await db.getByRole('button', { name: /^View options/ }).click();
  let bytes: Buffer;
  if (desktop) {
    await page.getByRole('menuitem', { name: 'Export this view as CSV' }).click();
    expect((await exported).status()).toBe(200);
    await expect
      .poll(() => (existsSync(savedFolder!) ? readdirSync(savedFolder!) : []).length, {
        timeout: 60000,
      })
      .toBe(1);
    bytes = readFileSync(join(savedFolder!, readdirSync(savedFolder!)[0]));
  } else {
    const download = page.waitForEvent('download', { timeout: 60000 });
    await page.getByRole('menuitem', { name: 'Export this view as CSV' }).click();
    expect((await exported).status()).toBe(200);
    const file = await download;
    const path = testInfo.outputPath('stock.csv');
    await file.saveAs(path);
    bytes = readFileSync(path);
  }
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const out = bytes.subarray(3).toString('utf8').trimEnd().split('\r\n');
  expect(out[0]).toBe('Name,Size');
  expect(out).toHaveLength(6001);
  // In the view's order: Size, descending.
  expect(out[1]).toBe('Item 6000,6000');
  expect(out[6000]).toBe('Item 0001,1');

  // The server's own count.
  const api = await apiSession(account);
  try {
    const answer = await api.post(`/api/v1/databases/${databaseId}/query`, {
      context: { today: '2026-11-13', offsetMinutes: 0, me: null },
      limit: 1,
    });
    expect(answer.total).toBe(6000);
  } finally {
    await api.dispose();
  }
  expect(appErrors(errors)).toEqual([]);
});

test('the same filter and sort give the same rows here and on the server', async ({
  page,
  authUrlFile,
}) => {
  test.setTimeout(240000);
  const errors = watchErrors(page);
  const account = await newAccount('Same rows');
  await signedInWorkspace(page, account, 'Query space', authUrlFile, cloud.signer);
  const databaseId = await newDatabase(page, 'Empty database', { title: 'Parts list' });
  const db = fullPage(page);
  await addProperty(page, 'Number', 'Size');
  await addProperty(page, 'Select', 'Kind');
  // 200 rows from a file, imported on this device (under the local limit): kinds repeat, some
  // are empty (empties sort last), sizes repeat across kinds.
  const kinds = ['Gamma', 'Alpha', '', 'Beta'];
  const lines = ['Name,Size,Kind'];
  for (let i = 1; i <= 200; i++) lines.push(`Part ${i},${(i * 7) % 50},${kinds[i % 4]}`);
  await db.getByRole('button', { name: /^View options/ }).click();
  await page.getByRole('menuitem', { name: 'Import CSV…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import CSV' });
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose a CSV file' }).click();
  await (
    await chooser
  ).setFiles({ name: 'Parts.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n')) });
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toContainText('Imported rows: 200', { timeout: 60000 });
  await dialog.getByRole('button', { name: 'Close' }).first().click();

  // One filter and two sorts, made in the view: Size ≥ 48 (eight rows, all in the table's
  // window); Kind ascending, then Size descending.
  await db.getByRole('button', { name: 'Filter', exact: true }).click();
  const filters = page.getByRole('dialog', { name: 'Filters' });
  await filters.getByRole('button', { name: 'Add a filter', exact: true }).click();
  await filters.getByRole('combobox', { name: 'Property' }).selectOption({ label: 'Size' });
  await filters.getByRole('combobox', { name: 'Condition' }).selectOption({ label: '≥' });
  await filters.getByRole('textbox', { name: 'Value' }).fill('48');
  await filters.getByRole('textbox', { name: 'Value' }).press('Enter');
  await page.keyboard.press('Escape');
  await db.getByRole('button', { name: 'Sort', exact: true }).click();
  const sorts = page.getByRole('dialog', { name: 'Sorts' });
  await sorts.getByRole('button', { name: 'Add a sort', exact: true }).click();
  await sorts.getByRole('combobox', { name: 'Property' }).selectOption({ label: 'Kind' });
  await sorts.getByRole('button', { name: 'Add a sort', exact: true }).click();
  await sorts.getByRole('combobox', { name: 'Property' }).nth(1).selectOption({ label: 'Size' });
  await sorts
    .getByRole('combobox', { name: 'Direction' })
    .nth(1)
    .selectOption({ label: 'Descending' });
  await page.keyboard.press('Escape');
  await expect(db.getByRole('button', { name: 'Sorts: 2' })).toBeVisible();
  const here = async () =>
    grid(db).locator('[role="row"][aria-rowindex] .cgw-title-text').allInnerTexts();
  await expect.poll(async () => (await here()).length).toBeGreaterThan(5);
  const shown = await here();
  expect(await db.getByRole('status').innerText()).toBe(`Rows: ${shown.length}`);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });

  // The server's query of the same view.
  const api = await apiSession(account);
  try {
    const tree = await api.get(
      `/api/v1/workspaces/${(await api.get('/api/v1/workspaces'))[0].id}/tree`,
    );
    const view = tree.views.find((v: { databaseId: string }) => v.databaseId === databaseId);
    await expect
      .poll(
        async () =>
          (
            await api.post(`/api/v1/databases/${databaseId}/query`, {
              viewId: view.id,
              context: { today: '2026-11-13', offsetMinutes: 0, me: null },
              limit: 100,
            })
          ).rows.map((r: { title: string }) => r.title),
        { timeout: 30000 },
      )
      .toEqual(shown);
  } finally {
    await api.dispose();
  }
  expect(errors).toEqual([]);
});

test('a search finds a row this device does not hold, and opens it', async ({
  page,
  authUrlFile,
}) => {
  test.setTimeout(240000);
  const errors = watchErrors(page);
  const account = await newAccount('Finder');
  await signedInWorkspace(page, account, 'Search space', authUrlFile, cloud.signer);
  // Another device makes a database; this one never opens it.
  const other = await otherDevice(
    desktop ? await cloud.signer() : page.context().browser()!,
    account,
  );
  await newDatabase(other.page, 'Tasks', { title: 'Elsewhere' });
  await showView(fullPage(other.page), 'All tasks');
  await openRow(other.page, 'Book the kickoff meeting', fullPage(other.page));
  await editor(other.page).click();
  await other.page.keyboard.type('Agenda in the shared folder.');
  await waitSaved(other.page);
  await expect(syncStatus(other.page)).toHaveText('Synced', { timeout: 30000 });
  await other.context.close();
  await expect(treeRow(page, 'Elsewhere')).toBeVisible({ timeout: 30000 });

  await page.keyboard.press('Control+KeyK');
  const palette = page.getByRole('dialog');
  await palette.getByRole('combobox').fill('kickoff');
  const hit = palette.getByRole('option', { name: /Book the kickoff meeting/ });
  await expect(hit).toBeVisible({ timeout: 30000 });
  // Its detail: the text the server matched, or (none yet indexed) the database it is in.
  await expect(hit).toContainText(/In Elsewhere|Agenda in the shared folder\./);
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Page title')).toHaveValue('Book the kickoff meeting', {
    timeout: 30000,
  });
  await expect(page.locator('.cgw-row-props')).toBeVisible();
  await expect(rowValue(page, 'Status')).toHaveText(/^(Not started|In progress|Done)$/);
  await expect(editor(page)).toContainText('Agenda in the shared folder.', { timeout: 30000 });
  expect(errors).toEqual([]);
});

test("a shared link draws a database block's note, not its rows", async ({ page }) => {
  // The page's own browser opens the link (a desktop run has none of Playwright's: skipped).
  test.skip(desktop, 'A shared link opens in a browser');
  const browser = page.context().browser()!;
  test.setTimeout(180000);
  const errors = watchErrors(page);
  const account = await newAccount('Sharer');
  await signedInWorkspace(page, account, 'Share space', null, cloud.signer);
  await newPage(page, 'Plans');
  await page.keyboard.type('Before the database.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/database');
  await page.getByRole('option', { name: /^Database/ }).click();
  await page
    .getByRole('dialog', { name: 'New database' })
    .getByRole('button', { name: 'Create' })
    .click();
  await expect(editor(page).locator('.cgw-db')).toBeVisible();
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  // A link shows the server's derived document: wait until the worker holds the database block.
  const pageId = new URL(page.url()).hash.match(/#\/p\/([0-9a-f-]{36})/)![1];
  const api = await apiSession(account);
  try {
    const derived = async () =>
      JSON.stringify(await api.get(`/api/v1/pages/${pageId}/doc/json`).catch(() => null));
    await expect.poll(derived, { timeout: 60000 }).toContain('databaseView');
    expect(await derived()).toContain('Before the database.');
  } finally {
    await api.dispose();
  }
  await page.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: 'Share…' }).click();
  const dialog = page.getByRole('dialog', { name: /Share/ });
  await dialog.getByRole('button', { name: 'Create a view link' }).click();
  const shareLink = (await dialog.getByTestId('share-link').textContent())!.trim();
  const anonymousContext = await browser.newContext();
  const anonymous = await anonymousContext.newPage();
  const anonymousErrors = watchErrors(anonymous);
  await anonymous.goto(shareLink);
  await expect(anonymous.getByText('Before the database.')).toBeVisible({ timeout: 20000 });
  await expect(
    anonymous.getByText('Databases are shown in the app, not on a shared page.'),
  ).toBeVisible();
  await expect(anonymous.locator('[role="grid"]')).toHaveCount(0);
  await anonymousContext.close();
  expect(errors).toEqual([]);
  expect(anonymousErrors).toEqual([]);
});
