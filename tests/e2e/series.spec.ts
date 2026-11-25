// Phase 17 (M17.2): repeating rows and reminders, as people use them. A template repeated from the
// New menu, by the last row done: its first row made at once, and the next once that one is
// complete, shown in the open tab; the series' editor under Axe and in Arabic. A person's own
// reminder of a row's date set on the row's page reaches their inbox at its time. The days a
// series by its days falls on, a worker's restart and a reminder's moment moving are the server's
// tests (`SeriesTests`, `ReminderTests`): this stack runs on the real clock.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { newAccount, signIn, signedIn, syncStatus, type TestAccount } from './cloud';
import { fullPage, grid, openRow, rowOf } from './database';
import { apiSession } from '../../scripts/cloud-account.mjs';
import {
  P,
  STATUS,
  addRow,
  opOf,
  push,
  rowsByTitle,
  seedTasks,
  uuidv7,
} from '../../bench/phase15-seed.mjs';

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
  account = await newAccount('Gardener');
  api = await apiSession(account);
  seeded = await seedTasks(api, { rows: 1, name: 'Chores', timeZone: 'Asia/Riyadh' });
  // A template of the database, made by another device.
  const id = uuidv7();
  const now = new Date().toISOString();
  await push(api, seeded.workspaceId, [
    opOf(seeded.workspaceId, 'page.create', id, {
      id,
      workspaceId: seeded.workspaceId,
      sectionId: seeded.sectionId,
      parentPageId: seeded.databaseId,
      orderKey: 'a5',
      kind: 'row',
      title: 'Water the plants',
      icon: null,
      coverAssetId: null,
      isTemplate: true,
      templateOfPageId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      trashRootId: null,
      row: { values: { [P.status]: STATUS.todo, [P.notes]: 'Every pot' } },
    }),
  ]);
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

/** The rows the series made, as the server holds them (templates are never rows of a view). */
async function made(): Promise<{ id: string; values: Record<string, unknown> }[]> {
  const page = await api.get(`/api/v1/databases/${seeded.databaseId}/rows?limit=100`);
  return page.rows.filter(
    (r: { title: string; isTemplate: boolean }) => r.title === 'Water the plants' && !r.isTemplate,
  );
}

test('a template repeated by the last done: its next row made once the last is complete', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openDatabase(page);
  const db = fullPage(page);
  await db.getByRole('button', { name: 'New from a template' }).click();
  await page.getByRole('menuitem', { name: 'Repeat a template' }).click();
  // The Repeat submenu's own item (the New list above names the template too).
  await page.getByRole('menuitem', { name: 'Water the plants' }).last().click();
  const box = page.getByRole('dialog', { name: 'Automations' });
  await expect(box.getByLabel('Name')).toHaveValue('Repeat Water the plants');
  await expect(box.getByLabel('Template')).toHaveValue(/.+/);
  await expect(box.getByRole('group', { name: 'Repeats' })).toBeVisible();
  await box.getByLabel('A new row').selectOption('done');
  await expect(box.getByLabel('Done when')).toHaveValue(P.status);
  expect(
    (await new AxeBuilder({ page }).include('.cgw-db-auto-editor').withTags(WCAG).analyze())
      .violations,
  ).toEqual([]);
  await box.getByRole('button', { name: 'Save' }).click();
  await expect(box).toContainText('A row from “Water the plants” once the last is done');

  // The first at once, from the template, shown in the open tab.
  await box.getByRole('button', { name: 'Close' }).click();
  await expect(rowOf(db, 'Water the plants')).toHaveCount(1, { timeout: 30_000 });
  await expect(rowOf(db, 'Water the plants')).toContainText('Every pot');
  const [first] = await made();
  expect(first.values[P.when]).toBeTruthy();

  // Complete, by another device: the next one comes, a week on.
  await push(api, seeded.workspaceId, [
    opOf(seeded.workspaceId, 'row.update', first.id, { values: { [P.status]: STATUS.done } }),
  ]);
  await expect(rowOf(db, 'Water the plants')).toHaveCount(2, { timeout: 30_000 });
  const rows = await made();
  const next = rows.find((r) => r.id !== first.id)!;
  const day = (r: { values: Record<string, unknown> }) =>
    new Date((r.values[P.when] as { start: string }).start).getTime();
  expect(day(next) - day(first)).toBe(7 * 86_400_000);

  // The editor in Arabic: the series' words and the library's fields in the app's words.
  await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
  await page.reload();
  await expect(grid(fullPage(page))).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'أتمتة قاعدة البيانات هذه' }).click();
  const ar = page.getByRole('dialog', { name: 'الأتمتة' });
  await expect(ar).toContainText('صف من «Water the plants» عند إنجاز السابق');
  await ar
    .getByRole('button', { name: /^تعديل/ })
    .first()
    .click();
  await expect(ar.getByRole('group', { name: 'التكرار' })).toBeVisible();
  await expect(ar.getByLabel('صف جديد')).toHaveValue('done');
  expect(
    (await new AxeBuilder({ page }).include('.cgw-db-auto-editor').withTags(WCAG).analyze())
      .violations,
  ).toEqual([]);
  await page.evaluate(() => localStorage.setItem('cgw-language', 'en'));
});

test("a person's own reminder of a row's date reaches their inbox at its time", async ({
  page,
}) => {
  test.setTimeout(240_000);
  // When, 45 seconds from now (to the second, as a date-time holds it).
  const at = new Date(Math.ceil((Date.now() + 45_000) / 1000) * 1000);
  await addRow(api, seeded, 'Call the bank', {
    [P.when]: { start: at.toISOString().replace(/\.\d{3}Z$/, 'Z') },
  });
  await openDatabase(page);
  await expect(rowOf(fullPage(page), 'Call the bank')).toHaveCount(1, { timeout: 30_000 });
  await openRow(page, 'Call the bank');
  const remind = page.locator('details', { hasText: 'Remind me' });
  await remind.locator('summary').click();
  const when = remind.getByLabel('Remind me of When');
  await expect(when).toBeEnabled({ timeout: 15_000 });
  await when.selectOption({ label: 'At the time' });
  // Saved on the server: the reminder is there when the panel is read again.
  const row = (await rowsByTitle(api, seeded.databaseId)).get('Call the bank');
  await expect
    .poll(
      async () =>
        (await api.get(`/api/v1/databases/${seeded.databaseId}/rows/${row.id}/reminders`)).reminders
          .length,
      { timeout: 15_000 },
    )
    .toBe(1);
  // The row's properties with the panel among them (its Approve button among the values).
  expect(
    (await new AxeBuilder({ page }).include('.cgw-row-props').withTags(WCAG).analyze()).violations,
  ).toEqual([]);

  // Its time comes: in the inbox within a minute.
  await page.goto('/#/inbox');
  const item = page
    .getByTestId('inbox-list')
    .getByRole('listitem')
    .filter({ hasText: 'A reminder of Call the bank' });
  await expect(async () => {
    await page.reload();
    await expect(item).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 120_000 });
  await expect(item).toContainText('When:');
  expect(Date.now()).toBeGreaterThanOrEqual(at.getTime());
});
