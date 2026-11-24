// Phase 17 (M17.1): rules that wait and decide, as people use them. A rule waits until its row
// matches and goes on when another device makes it so, shown in the open tab; an approval asked in
// the person's inbox is answered there with a comment and the rule takes its path, the comment in
// the row; the editor builds a branch and an approval with steps inside them; the screens under
// Axe and in Arabic. Waits of a day, deadlines and a worker's restart are the server's tests
// (`WorkflowTests`): this stack runs on the real clock.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { newAccount, signIn, signedIn, syncStatus, type TestAccount } from './cloud';
import { expectInRow, fullPage, grid } from './database';
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

let account: TestAccount;
let api: Api;
let seeded: Seeded;
let me: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  account = await newAccount('Approver');
  api = await apiSession(account);
  seeded = await seedTasks(api, { rows: 2, name: 'Workflows', timeZone: 'Asia/Riyadh' });
  me = (await api.get('/api/v1/account/me')).id;
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

const rowOf = (page: Page, title: string) =>
  grid(fullPage(page)).getByRole('row').filter({ hasText: title });

const done = {
  kind: 'group',
  op: 'and',
  children: [{ kind: 'condition', propertyId: P.status, operator: 'is', value: STATUS.done }],
};

test('a rule waits until its row matches, then goes on, shown in the open tab', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const rule = await saveRule(api, seeded, {
    name: 'After it is done',
    trigger: { kind: 'rowAdded' },
    steps: [
      { kind: 'wait', until: { kind: 'match', conditions: done, minutes: 10080 } },
      { kind: 'set', values: { [P.notes]: 'done, then noted' } },
    ],
  });
  await openDatabase(page);
  await addRow(api, seeded, 'Waiting row');
  await expect(rowOf(page, 'Waiting row')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => (await runsOf(api, seeded, rule.id)).map((r: { status: string }) => r.status),
      {
        timeout: 30_000,
      },
    )
    .toEqual(['waiting']);
  // Another device marks it done: the wait ends and the next step shows here.
  const rows = await rowsByTitle(api, seeded.databaseId);
  await push(api, seeded.workspaceId, [
    opOf(seeded.workspaceId, 'row.update', rows.get('Waiting row').id, {
      values: { [P.status]: STATUS.done },
    }),
  ]);
  await expectInRow(fullPage(page), rowOf(page, 'Waiting row'), 'done, then noted');
  const [run] = await runsOf(api, seeded, rule.id);
  expect(run.status).toBe('done');
  expect(run.steps.map((s: { status: string }) => s.status)).toEqual(['done', 'done']);
  // Its run log says how it went.
  await page.getByRole('button', { name: 'Automations of this database' }).click();
  const box = page.getByRole('dialog', { name: 'Automations' });
  await box.getByRole('button', { name: 'Runs of After it is done' }).click();
  await expect(box).toContainText('Waiting row');
  await expect(box).toContainText('Wait: done');
});

test('an approval asked in the inbox is answered there, and the rule takes its path', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const rule = await saveRule(api, seeded, {
    name: 'Ask first',
    trigger: { kind: 'propertyChanged', propertyId: P.points },
    steps: [
      {
        kind: 'approval',
        people: [me],
        groups: [],
        personProperties: [],
        mode: 'any',
        message: 'May this order go out?',
        deadlineMinutes: 4320,
        approved: [{ kind: 'set', values: { [P.notes]: { dynamic: 'comment' } } }],
        rejected: [{ kind: 'set', values: { [P.notes]: 'rejected' } }],
        noAnswer: [],
      },
    ],
  });
  const rows = await rowsByTitle(api, seeded.databaseId);
  await push(api, seeded.workspaceId, [
    opOf(seeded.workspaceId, 'row.update', rows.get('Task 1').id, { values: { [P.points]: 30 } }),
  ]);
  await expect
    .poll(
      async () => (await runsOf(api, seeded, rule.id)).map((r: { status: string }) => r.status),
      {
        timeout: 30_000,
      },
    )
    .toEqual(['waiting']);
  await openDatabase(page);
  await page.goto(`/#/inbox`);
  const item = page
    .getByTestId('inbox-list')
    .getByRole('listitem')
    .filter({ hasText: 'asks for your approval' });
  await expect(item).toContainText('Task 1', { timeout: 30_000 });
  await expect(item).toContainText('May this order go out?');
  expect(
    (await new AxeBuilder({ page }).include('.cgw-inbox').withTags(WCAG).analyze()).violations,
  ).toEqual([]);
  await item.getByLabel('Comment (optional)').fill('Within the budget');
  await item.getByRole('button', { name: 'Approve' }).click();
  await expect(item).toContainText('You approved it.');
  await page.goto(`/#/p/${seeded.databaseId}`);
  await expectInRow(fullPage(page), rowOf(page, 'Task 1'), 'Within the budget');
  const [run] = await runsOf(api, seeded, rule.id);
  expect([run.status, run.steps[0].status]).toEqual(['done', 'approved']);
  // Answered once: the item says what came of it.
  await page.goto(`/#/inbox`);
  await expect(item).toContainText('Approved.', { timeout: 30_000 });
});

test('the editor builds a branch and an approval with steps inside them, in Arabic', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDatabase(page);
  await page.getByRole('button', { name: 'Automations of this database' }).click();
  const box = page.getByRole('dialog', { name: 'Automations' });
  await box.getByRole('button', { name: 'New automation' }).click();
  await box.getByLabel('Name').fill('Sort it');
  await box.getByLabel('Add a step', { exact: true }).selectOption('branch');
  await box.getByLabel('Add a step (Steps of If)').selectOption('approval');
  await box.getByLabel('Add a step', { exact: true }).selectOption('wait');
  // The first step sets the notes; the approval asks this person.
  await box.getByLabel('Add a property').first().selectOption(P.notes);
  await box.getByLabel('Value', { exact: true }).first().fill('sorted');
  await box.getByLabel('Value', { exact: true }).first().press('Tab');
  await box.getByRole('group', { name: 'People' }).nth(0).getByRole('checkbox').first().check();
  expect(
    (await new AxeBuilder({ page }).include('[role="dialog"]').withTags(WCAG).analyze()).violations,
  ).toEqual([]);
  await box.getByRole('button', { name: 'Save' }).click();
  await expect(box.getByRole('status')).toHaveText('Sort it is saved.');

  // In Arabic, every word of the editor's is Arabic.
  await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
  await page.reload();
  await expect(grid(fullPage(page))).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'أتمتة قاعدة البيانات هذه' }).click();
  const ar = page.getByRole('dialog', { name: 'الأتمتة' });
  await ar.getByRole('button', { name: 'تعديل Sort it' }).click();
  const names = [
    'Sort it',
    'After it is done',
    'Ask first',
    'Asia/Riyadh',
    'Tasks',
    'Task 0',
    'Task 1',
    'Waiting row',
    'Status',
    'Notes',
    'Points',
    'When',
    'Owner',
    'Approve',
    'Name',
    'To do',
    'Doing',
    'Done',
    'sorted',
    'Approver',
    'Workflows',
  ];
  expect(await englishIn(ar, 'the editor', { within: ['input', 'textarea'], names })).toEqual([]);
  expect(
    (await new AxeBuilder({ page }).include('[role="dialog"]').withTags(WCAG).analyze()).violations,
  ).toEqual([]);
  await page.keyboard.press('Escape');
  await page.goto(`/#/inbox`);
  const inbox = page.locator('.cgw-inbox');
  await expect(inbox.getByTestId('inbox-list')).toBeVisible({ timeout: 30_000 });
  expect(
    await englishIn(inbox, 'the inbox', {
      within: ['textarea'],
      names: [...names, 'May this order go out?', 'Within the budget'],
    }),
  ).toEqual([]);
});
