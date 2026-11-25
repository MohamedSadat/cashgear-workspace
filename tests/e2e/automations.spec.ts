// Phase 15 (M15.3): automations as people use them. A rule made in the database's own editor runs
// on a change from another device and its step shows in the open tab; changes made offline run
// their rules in the order they reach the server; a button runs its rule once a press and says so
// when offline, never queuing the press; Settings → Automations adds a webhook whose secret is shown
// once, and the receiver gets each call signed so it can check it (tests/mocks/net, 4288); the
// screens under Axe and in Arabic.
import AxeBuilder from '@axe-core/playwright';
import { createHmac } from 'node:crypto';
import type { Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { newAccount, signIn, signedIn, syncStatus, type TestAccount } from './cloud';
import { expectInRow, fullPage, grid, openRow, otherDevice, rowValue } from './database';
import { englishIn } from './erp12';
import { apiSession } from '../../scripts/cloud-account.mjs';
import {
  P,
  STATUS,
  addRow,
  opOf,
  push,
  rowsByTitle,
  runsOf,
  saveRule,
  seedTasks,
} from '../../bench/phase15-seed.mjs';

test.skip(desktop, 'Seeded and read through browser profiles; the desktop runs the same views');
test.describe.configure({ mode: 'serial' });

type Api = Awaited<ReturnType<typeof apiSession>>;
type Seeded = Awaited<ReturnType<typeof seedTasks>>;

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const NET = 'http://127.0.0.1:4288';

let account: TestAccount;
let api: Api;
let seeded: Seeded;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  account = await newAccount('Automator');
  api = await apiSession(account);
  seeded = await seedTasks(api, { rows: 4, name: 'Automations', timeZone: 'Asia/Riyadh' });
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

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Automations' });
const rowOf = (page: Page, title: string) =>
  grid(fullPage(page)).getByRole('row').filter({ hasText: title });

test('a rule made in the editor runs on a change from another device, shown in the open tab', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await openDatabase(page);
  await page.getByRole('button', { name: 'Automations of this database' }).click();
  const box = dialog(page);
  await expect(box).toContainText('No automations yet');
  await expect(box).toContainText('Asia/Riyadh');
  expect(
    (await new AxeBuilder({ page }).include('[role="dialog"]').withTags(WCAG).analyze()).violations,
  ).toEqual([]);

  await box.getByRole('button', { name: 'New automation' }).click();
  await box.getByLabel('Name').fill('Close it');
  await box.getByLabel('When', { exact: true }).selectOption('propertyChanged');
  await box.getByLabel('Property', { exact: true }).selectOption(P.status);
  await box.getByLabel('To', { exact: true }).selectOption(STATUS.done);
  await box.getByLabel('Add a property').selectOption(P.notes);
  await box.getByLabel('Value', { exact: true }).fill('closed by the rule');
  await box.getByLabel('Value', { exact: true }).press('Tab');
  expect(
    (await new AxeBuilder({ page }).include('[role="dialog"]').withTags(WCAG).analyze()).violations,
  ).toEqual([]);
  await box.getByRole('button', { name: 'Save' }).click();
  await expect(box.getByRole('status')).toHaveText('Close it is saved.');
  await expect(box.getByRole('button', { name: 'Edit Close it' })).toBeVisible();

  // Another device of the same person marks Task 0 done; this tab shows the rule's step.
  const other = await otherDevice(browser, account);
  try {
    const rows = await rowsByTitle(api, seeded.databaseId);
    await push(api, seeded.workspaceId, [
      opOf(seeded.workspaceId, 'row.update', rows.get('Task 0').id, {
        values: { [P.status]: STATUS.done },
      }),
    ]);
  } finally {
    await other.context.close();
  }
  await box
    .getByRole('button', { name: 'Close' })
    .first()
    .click()
    .catch(() => undefined);
  await page.keyboard.press('Escape');
  await expectInRow(fullPage(page), rowOf(page, 'Task 0'), 'closed by the rule');

  // Its run log says how it went, for which row.
  await page.getByRole('button', { name: 'Automations of this database' }).click();
  await dialog(page).getByRole('button', { name: 'Runs of Close it' }).click();
  await expect(dialog(page)).toContainText('Task 0');
  await expect(dialog(page)).toContainText('Done');
  expect(
    (await new AxeBuilder({ page }).include('[role="dialog"]').withTags(WCAG).analyze()).violations,
  ).toEqual([]);
});

test('changes made offline run their rules in order once they reach the server', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const rule = await saveRule(api, seeded, {
    name: 'Points seen',
    trigger: { kind: 'propertyChanged', propertyId: P.points },
    steps: [{ kind: 'set', values: { [P.notes]: 'points seen' } }],
  });
  const device = await otherDevice(browser, account);
  try {
    await device.page.goto(`/#/p/${seeded.databaseId}`);
    const table = grid(fullPage(device.page));
    await expect(rowOf(device.page, 'Task 3')).toBeVisible({ timeout: 30_000 });
    await expect(syncStatus(device.page)).toHaveText('Synced', { timeout: 30_000 });
    await device.context.setOffline(true);
    await device.page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(syncStatus(device.page)).toHaveText(/^Offline/);
    // Two edits while offline, in the order they are typed: Task 2's Points, then Task 1's, in
    // the table by its keys (the header row, down to the row, across to Points).
    for (const [index, points] of [
      [2, '20'],
      [1, '10'],
    ] as const) {
      await table.focus();
      await device.page.keyboard.press('Control+Home');
      for (let i = 0; i <= index; i++) await device.page.keyboard.press('ArrowDown');
      for (let i = 0; i < 3; i++) await device.page.keyboard.press('ArrowRight');
      await device.page.keyboard.press('Enter');
      const input = table.locator('.cgw-inline-editor');
      await expect(input).toBeFocused();
      await input.fill(points);
      await input.press('Enter');
      await expect(input).toHaveCount(0);
      await expectInRow(fullPage(device.page), rowOf(device.page, `Task ${index}`), points);
    }
    expect(await runsOf(api, seeded, rule.id)).toEqual([]);
    await device.context.setOffline(false);
    await device.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(syncStatus(device.page)).toHaveText('Synced', { timeout: 60_000 });
  } finally {
    await device.context.close();
  }
  await expect
    .poll(async () => (await runsOf(api, seeded, rule.id)).length, { timeout: 30_000 })
    .toBe(2);
  // Newest first: Task 1's after Task 2's.
  const runs = await runsOf(api, seeded, rule.id);
  expect(runs.map((r: { rowTitle: string }) => r.rowTitle)).toEqual(['Task 1', 'Task 2']);
  expect(runs.every((r: { status: string }) => r.status === 'done')).toBe(true);
});

test('a button runs its rule once a press, and offline says so and queues nothing', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const rule = await saveRule(api, seeded, {
    name: 'Approve',
    trigger: { kind: 'button', propertyId: P.approve },
    steps: [{ kind: 'set', values: { [P.status]: STATUS.done, [P.owner]: { dynamic: 'actor' } } }],
  });
  await openDatabase(page);
  const row = rowOf(page, 'Task 3');
  await expectInRow(fullPage(page), row, 'Approve');
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('.cgw-notice')).toContainText('“Approve” is running.');
  await expectInRow(fullPage(page), row, 'Done');
  expect(await runsOf(api, seeded, rule.id)).toHaveLength(1);
  // Offline: said so, and nothing is sent when the network comes back.
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  // The table draws the columns in its window only: across to the button again.
  await expectInRow(fullPage(page), row, 'Approve');
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('.cgw-notice')).toContainText('press it again once you are online');
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 60_000 });
  await page.waitForTimeout(2000);
  expect(await runsOf(api, seeded, rule.id)).toHaveLength(1);
});

test('a webhook added in Settings is called signed, and its receiver checks it', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await fetch(`${NET}/__mock/reset`, { method: 'POST' });
  await openDatabase(page);
  await page.goto('/#/settings');
  const section = page.locator('.cgw-automations-settings');
  await expect(section.getByRole('heading', { name: 'Automations' })).toBeVisible({
    timeout: 30_000,
  });
  await section.getByLabel('Name').fill('The shop');
  await section.getByLabel('Address').fill(`${NET}/hook`);
  await section.getByRole('button', { name: 'Add the webhook' }).click();
  const secret = await section.getByLabel('Signing secret').inputValue();
  expect(secret).toMatch(/^cgwh_[0-9a-f]{64}$/);
  await expect(section).toContainText('Close it');
  expect(
    (await new AxeBuilder({ page }).include('.cgw-automations-settings').withTags(WCAG).analyze())
      .violations,
  ).toEqual([]);

  const hooks = await api.get(`/api/v1/workspaces/${seeded.workspaceId}/webhooks`);
  await saveRule(api, seeded, {
    name: 'Tell the shop',
    trigger: { kind: 'rowAdded' },
    steps: [{ kind: 'webhook', webhookId: hooks[0].id, properties: ['title', P.status] }],
  });
  await addRow(api, seeded, 'Order 7', { [P.status]: STATUS.doing });
  await expect
    .poll(
      async () =>
        (
          (await (await fetch(`${NET}/__mock/requests`)).json()).requests as { path: string }[]
        ).filter((r) => r.path === '/hook').length,
      {
        timeout: 60_000,
      },
    )
    .toBe(1);
  const call = (
    (await (await fetch(`${NET}/__mock/requests`)).json()).requests as {
      method: string;
      body: string;
      headers: Record<string, string>;
    }[]
  ).find((r) => r.method === 'POST')!;
  const expected =
    'v1=' +
    createHmac('sha256', secret)
      .update(`${call.headers['x-cgw-timestamp']}.${call.body}`)
      .digest('hex');
  expect(call.headers['x-cgw-signature']).toBe(expected);
  const body = JSON.parse(call.body);
  expect(body.row.title).toBe('Order 7');
  expect(body.properties[P.status].value).toBe('Doing');
  expect(call.body).not.toContain(account.email);
});

test('the automations in Arabic', async ({ page }) => {
  test.setTimeout(120_000);
  await openDatabase(page);
  await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
  await page.reload();
  await expect(grid(fullPage(page))).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'أتمتة قاعدة البيانات هذه' }).click();
  const box = page.getByRole('dialog', { name: 'الأتمتة' });
  await expect(box.getByRole('button', { name: 'تعديل Close it' })).toBeVisible();
  // The person's own words: the rules', the database's, its properties' and options', the rows',
  // the webhook's, the account's name and the zone. Everything else is the app's, in Arabic.
  const names = [
    'Close it',
    'Points seen',
    'Approve',
    'Tell the shop',
    'The shop',
    'Asia/Riyadh',
    'Tasks',
    'Task 0',
    'Task 1',
    'Task 2',
    'Task 3',
    'Order 7',
    'Status',
    'Notes',
    'Points',
    'When',
    'Owner',
    'Name',
    'To do',
    'Doing',
    'Done',
    'closed by the rule',
    'points seen',
    'Automator',
  ];
  expect(await englishIn(box, 'automations', { within: ['input'], names })).toEqual([]);
  await box.getByRole('button', { name: 'تعديل Close it' }).click();
  expect(await englishIn(box, 'the editor', { within: ['input'], names })).toEqual([]);
  expect(
    (await new AxeBuilder({ page }).include('[role="dialog"]').withTags(WCAG).analyze()).violations,
  ).toEqual([]);
});

// Found by Phase 17's specs (Axe's nested-interactive, WCAG 4.1.2): on a row's page a button
// property's value was a control around the button. The button is the line's one control, the
// next stop after the property's name, pressed once by its key; the row's properties under Axe in
// English and Arabic. Last, so the Arabic walk above need not name its rule. Scanned before the
// press: the earlier test's "Approve" rule sets the row's Owner, and a person's value is named
// apart from its avatar's initials (Axe's label-content-name-mismatch, a defect of its own).
test("a row's page: a button property's button is its one control, under Axe in both languages", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const rule = await saveRule(api, seeded, {
    name: 'Approved on its page',
    trigger: { kind: 'button', propertyId: P.approve },
    steps: [{ kind: 'set', values: { [P.notes]: 'approved on its page' } }],
  });
  await openDatabase(page);
  await openRow(page, 'Task 2');
  const props = page.locator('.cgw-row-props');
  const value = rowValue(page, 'Approve');
  const approve = value.locator('.cgw-db-button-cell');
  const line = props.locator('.cgw-row-prop').filter({ has: page.locator('.cgw-db-button-cell') });

  // The row's properties with their runs opened (read when opened), under Axe.
  const scan = async () => {
    await expect(approve).toBeEnabled({ timeout: 30_000 });
    // "Remind me" is drawn as the same disclosure, before the runs.
    const runLog = props.locator('details.cgw-db-auto-row-runs').last();
    await runLog.locator('summary').click();
    await expect(runLog.locator('.cgw-db-auto-log')).toBeVisible();
    await expect(runLog.locator('[role="status"], [role="alert"]')).toHaveCount(0, {
      timeout: 30_000,
    });
    return (await new AxeBuilder({ page }).include('.cgw-row-props').withTags(WCAG).analyze())
      .violations;
  };
  expect(await value.getAttribute('role')).toBeNull();
  expect(await value.getAttribute('tabindex')).toBeNull();
  expect(await scan()).toEqual([]);
  await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  expect(await scan()).toEqual([]);
  await page.evaluate(() => localStorage.setItem('cgw-language', 'en'));
  await page.reload();

  // By the keys: the next stop after the property's name is the button, and Enter presses once.
  await expect(approve).toBeEnabled({ timeout: 30_000 });
  await line.locator('.cgw-row-prop-name').focus();
  await page.keyboard.press('Tab');
  await expect(approve).toBeFocused();
  await page.keyboard.press('Enter');
  // The notice names the rules that run (the earlier test's "Approve" too, when run with it).
  await expect(page.locator('.cgw-notice')).toContainText('“Approved on its page”');
  await expect
    .poll(async () => (await runsOf(api, seeded, rule.id)).length, { timeout: 30_000 })
    .toBe(1);
  await page.waitForTimeout(2000);
  const runs = await runsOf(api, seeded, rule.id);
  expect(runs.map((r: { rowTitle: string }) => r.rowTitle)).toEqual(['Task 2']);
});
