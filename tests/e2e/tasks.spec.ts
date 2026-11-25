// Phase 17 (M17.2 to M17.5): tasks as people use them. A unique id added from the table's header,
// its prefix set in its menu, every row numbered by the server, a row made offline showing a dash
// until it reaches the server and then its number; sub-items switched on in the Properties menu,
// the table nesting them as a tree grid a screen reader reads, a parent hiding its own; the table
// under Axe and in Arabic.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { newAccount, signIn, signedIn, syncStatus, type TestAccount } from './cloud';
import { addProperty, expectInRow, fullPage, grid, newRow, propertyMenu, rowOf } from './database';
import { apiSession } from '../../scripts/cloud-account.mjs';
import { opOf, push, rowsByTitle, seedTasks } from '../../bench/phase15-seed.mjs';

test.skip(desktop, 'Seeded and read through browser profiles; the desktop runs the same views');
test.describe.configure({ mode: 'serial' });

type Api = Awaited<ReturnType<typeof apiSession>>;
type Seeded = Awaited<ReturnType<typeof seedTasks>>;

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

let account: TestAccount;
let api: Api;
let seeded: Seeded;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  account = await newAccount('Planner');
  api = await apiSession(account);
  seeded = await seedTasks(api, { rows: 3, name: 'Tasks', timeZone: 'Asia/Riyadh' });
});
test.afterAll(async () => {
  await api?.dispose();
});

async function openDatabase(page: Page) {
  await page.goto('/');
  await signIn(page, account, `/#/p/${seeded.databaseId}`);
  await signedIn(page, account);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30_000 });
  await expect(grid(fullPage(page))).toBeVisible({ timeout: 30_000 });
}

test('a unique id numbers every row, a row made offline once it reaches the server', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDatabase(page);
  await addProperty(page, 'ID', 'Ticket');
  const menu = await propertyMenu(page, 'Ticket', 'ID');
  await menu.getByRole('menuitem', { name: 'Prefix' }).click();
  await menu.getByLabel('Prefix').fill('TASK');
  await menu.getByLabel('Prefix').press('Enter');
  await page.keyboard.press('Escape');
  // The seeded rows were numbered when the server stored them, in the order they were made.
  for (const [title, n] of [
    ['Task 0', 1],
    ['Task 1', 2],
    ['Task 2', 3],
  ] as const)
    await expectInRow(fullPage(page), rowOf(fullPage(page), title), `TASK-${n}`);
  // Offline, a new row has no number yet: a dash, then its number once it reaches the server.
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(syncStatus(page)).toHaveText(/^Offline/);
  await newRow(page, 'Made offline');
  await expectInRow(fullPage(page), rowOf(fullPage(page), 'Made offline'), '—');
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 60_000 });
  await expectInRow(fullPage(page), rowOf(fullPage(page), 'Made offline'), 'TASK-4');
  expect(
    (await new AxeBuilder({ page }).include('.cgw-database-page').withTags(WCAG).analyze())
      .violations,
  ).toEqual([]);

  // In Arabic the type reads in Arabic; the number and its prefix are the person's own.
  await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
  await page.reload();
  await expect(grid(fullPage(page))).toBeVisible({ timeout: 30_000 });
  await expect(
    fullPage(page).getByRole('columnheader', { name: 'Ticket', exact: true }),
  ).toHaveAccessibleDescription('المعرّف');
  await expectInRow(fullPage(page), rowOf(fullPage(page), 'Made offline'), 'TASK-4');
  await page.evaluate(() => localStorage.setItem('cgw-language', 'en'));
});

test('sub-items switched on nest under their parents, read as a tree grid', async ({ page }) => {
  test.setTimeout(180_000);
  await openDatabase(page);
  const db = fullPage(page);
  await db.getByRole('button', { name: 'Properties', exact: true }).click();
  await page.getByLabel('Sub-items', { exact: true }).selectOption('new');
  await page.keyboard.press('Escape');
  await expect(db.getByRole('columnheader', { name: 'Parent', exact: true })).toBeVisible();
  // Task 1 and Task 2 under Task 0, by another device, once the server holds the switch.
  const parentOf = async (): Promise<string | undefined> => {
    const tree = await api.get(`/api/v1/workspaces/${seeded.workspaceId}/tree`);
    return tree.databases
      .find((d: { id: string }) => d.id === seeded.databaseId)
      ?.properties.find((p: { name: string }) => p.name === 'Parent')?.id;
  };
  await expect.poll(parentOf, { timeout: 30_000 }).toBeTruthy();
  const parent = (await parentOf())!;
  const rows = await rowsByTitle(api, seeded.databaseId);
  await push(
    api,
    seeded.workspaceId,
    ['Task 1', 'Task 2'].map((title) =>
      opOf(seeded.workspaceId, 'row.update', rows.get(title).id, {
        values: { [parent]: [rows.get('Task 0').id] },
      }),
    ),
  );
  const table = db.getByRole('treegrid');
  // A row by its header (its title): a parent's and its sub-items' cells name each other.
  const line = (title: string) =>
    table
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: title, exact: true }) });
  await expect(line('Task 1')).toHaveAttribute('aria-level', '2', { timeout: 30_000 });
  await expect(line('Task 0')).toHaveAttribute('aria-level', '1');
  await expect(line('Task 0')).toHaveAttribute('aria-expanded', 'true');
  await expect(line('Task 2')).toHaveAttribute('aria-posinset', '2');
  await expect(line('Task 2')).toHaveAttribute('aria-setsize', '2');
  expect(
    (await new AxeBuilder({ page }).include('.cgw-database-page').withTags(WCAG).analyze())
      .violations,
  ).toEqual([]);
  // Its toggle hides its sub-items, and shows them again.
  await line('Task 0').getByRole('button', { name: 'Hide the sub-items of Task 0' }).click();
  await expect(line('Task 0')).toHaveAttribute('aria-expanded', 'false');
  await expect(line('Task 1')).toHaveCount(0);
  await line('Task 0').getByRole('button', { name: 'Show the sub-items of Task 0' }).click();
  await expect(line('Task 1')).toBeVisible();
});
