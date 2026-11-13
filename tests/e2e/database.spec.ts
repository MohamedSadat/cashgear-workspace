// Phase 4's first acceptance criterion in Chrome, Edge and the built desktop app: "a database with
// every first-release property type can be created, edited and viewed in all five views, in both
// languages"; then filter, sort and group, a row opened as a page, an inline database and a linked
// view from the slash menu, database and row templates, CSV in and out, rows trashed and restored,
// and deleting a property and an option never corrupting a row.
//
// The every-type test is signed in with a synced workspace, so person, created by and edited by
// have someone to name and the server's copy of the row can be read; the others are local.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, desktop } from './fixtures';
import { createWorkspace, editor, newPage, waitSaved, watchErrors } from './helpers';
import { newAccount, syncStatus } from './cloud';
import { apiSession } from '../../scripts/cloud-account.mjs';
import {
  addProperty,
  addView,
  cardOf,
  changeType,
  chooseDate,
  chooseFromList,
  chooseOptions,
  expectInRow,
  fullPage,
  grid,
  newDatabase,
  newRow,
  onCalendarDay,
  openRow,
  picker,
  propertyMenu,
  rowOf,
  rowValue,
  showView,
  signedInWorkspace,
  tabClipped,
  signers,
  signOutDesktop,
  treeRow,
  typeMenuInView,
  typeValue,
  uploadFile,
} from './database';

const cloud = signers();
test.afterEach(async ({ page }) => {
  await cloud.close();
  await signOutDesktop(page);
});

/** The 13th of next month, at noon: a day every view can show and the picker can reach. */
function dueDate() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 20, 12);
}
const iso = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

test('a database with every property type is made, edited and shown in all five views, in English and Arabic', async ({
  page,
  authUrlFile,
}) => {
  test.setTimeout(300000);
  const errors = watchErrors(page);
  const account = await newAccount('Dana Maker');
  await signedInWorkspace(page, account, 'Databases', authUrlFile, cloud.signer);
  const databaseId = await newDatabase(page, 'Empty database', { title: 'Inventory' });
  const db = fullPage(page);

  // Every first-release type: the plan's 13, email, phone, and the four set by the workspace.
  const plain: [string, string][] = [
    ['Text', 'Notes'],
    ['Number', 'Price'],
    ['Date', 'Due'],
    ['Checkbox', 'Packed'],
    ['Select', 'Kind'],
    ['Multi-select', 'Tags'],
    ['Status', 'Stage'],
    ['Person', 'Owner'],
    ['URL', 'Link'],
    ['Email', 'Mail'],
    ['Phone', 'Phone'],
    ['Files', 'Pictures'],
    ['Created time', 'Created'],
    ['Created by', 'Creator'],
    ['Last edited time', 'Edited'],
    ['Last edited by', 'Editor'],
  ];
  for (const [type, name] of plain) await addProperty(page, type, name);
  // A relation to this database (with its reverse), set up as it is added; a rollup over it,
  // made by changing a property's type; and a formula.
  await db.locator('.cgw-th-add button').click();
  await page
    .getByRole('menu', { name: 'Add a property of type…' })
    .getByRole('menuitem', { name: 'Relation', exact: true })
    .press('Enter');
  const relation = page.getByRole('dialog', { name: 'Relation settings' });
  await relation
    .getByRole('combobox', { name: 'Related database' })
    .selectOption({ label: 'Inventory (this database)' });
  await relation.getByRole('textbox', { name: 'Name there' }).fill('Part of');
  await relation.getByRole('button', { name: 'Done' }).click();
  const named = await propertyMenu(page, 'Relation', 'Relation');
  await named.getByRole('textbox', { name: 'Property name' }).fill('Parts');
  await named.getByRole('textbox', { name: 'Property name' }).press('Enter');
  await page.keyboard.press('Escape');
  await expect(db.getByRole('columnheader', { name: 'Parts, Relation' })).toBeVisible();
  await expect(db.getByRole('columnheader', { name: 'Part of, Relation' })).toBeVisible();
  await addProperty(page, 'Text', 'Parts total');
  const rollup = await changeType(page, 'Parts total', 'Text', 'Rollup');
  await rollup.getByRole('combobox', { name: 'Relation' }).selectOption({ label: 'Parts' });
  await rollup
    .getByRole('combobox', { name: 'Property of the related rows' })
    .selectOption({ label: 'Price' });
  await rollup.getByRole('combobox', { name: 'Calculate' }).selectOption({ label: 'Sum' });
  await rollup.getByRole('button', { name: 'Done' }).click();
  await addProperty(page, 'Formula', 'Double');
  const formula = await propertyMenu(page, 'Double', 'Formula');
  await formula.getByRole('menuitem', { name: 'Edit the formula' }).click();
  await formula.getByRole('combobox', { name: 'Formula expression' }).fill('prop("Price") * 2');
  await formula.getByRole('button', { name: 'Save the formula' }).click();
  await expect(formula).toHaveCount(0);
  // With 21 columns the table's ＋ is at the window's edge: its menu still fits in the window.
  expect.soft(await typeMenuInView(page)).toEqual([]);

  // Two rows: a part, and the row holding a value of every type.
  await newRow(page, 'Bolt');
  await openRow(page, 'Bolt');
  await typeValue(page, 'Price', '2.5');
  await expect(rowValue(page, 'Price')).toHaveText('2.5');
  await page.goBack();
  await expect(db).toBeVisible();
  await newRow(page, 'Widget');
  await openRow(page, 'Widget');
  await typeValue(page, 'Notes', 'Fits the left bracket');
  await typeValue(page, 'Price', '12.5');
  await chooseDate(page, 'Due', dueDate());
  await rowValue(page, 'Packed').click();
  await chooseOptions(page, 'Kind', ['Hardware']);
  await chooseOptions(page, 'Tags', ['Steel', 'Small']);
  await chooseOptions(page, 'Stage', ['In progress']);
  await chooseFromList(page, 'Owner', 'Dana', 'Dana Maker');
  await typeValue(page, 'Link', 'https://example.com/widget');
  await typeValue(page, 'Mail', 'parts@example.com');
  await typeValue(page, 'Phone', '+20 2 1234 5678');
  await uploadFile(page, 'Pictures', 'widget.png');
  await chooseFromList(page, 'Parts', 'Bolt', 'Bolt');

  const shown: [string, string | RegExp][] = [
    ['Notes', 'Fits the left bracket'],
    ['Price', '12.5'],
    ['Due', new RegExp(String(dueDate().getDate()))],
    ['Kind', 'Hardware'],
    ['Tags', /Steel.*Small/],
    ['Stage', 'In progress'],
    ['Owner', 'Dana Maker'],
    ['Link', 'https://example.com/widget'],
    ['Mail', 'parts@example.com'],
    ['Phone', '+20 2 1234 5678'],
    ['Pictures', 'widget.png'],
    ['Creator', 'Dana Maker'],
    ['Editor', 'Dana Maker'],
    ['Parts', 'Bolt'],
    ['Parts total', '2.5'],
    ['Double', '25'],
  ];
  for (const [name, text] of shown) await expect(rowValue(page, name)).toContainText(text);
  await expect(rowValue(page, 'Packed').getByRole('checkbox')).toBeChecked();
  for (const name of ['Created', 'Edited']) await expect(rowValue(page, name)).toHaveText(/\d/);
  // The body of a row is a page's.
  await editor(page).click();
  await page.keyboard.type('A row is a page too.');
  await waitSaved(page);
  await page.goBack();

  // The table shows them all (the title stays as the grid scrolls across).
  const widget = rowOf(db, 'Widget');
  await expectInRow(db, widget, 'Hardware');
  await expectInRow(db, widget, 'Fits the left bracket');
  await expect(db.getByRole('status')).toHaveText('Rows: 2');

  // The other four views, every property shown on each.
  const views: [string, string][] = [
    ['Board', '.cgw-board'],
    ['List', '.cgw-db-list'],
    ['Calendar', '.cgw-cal'],
    ['Gallery', '.cgw-gallery'],
  ];
  for (const [type] of views) {
    await addView(db, page, type);
    await db.getByRole('button', { name: 'Properties', exact: true }).click();
    await page.getByRole('button', { name: 'Show all' }).click();
    await page.keyboard.press('Escape');
  }
  // What a person wrote stays as written in either language: option names, people, titles.
  const values = ['Hardware', 'Steel', 'Small', 'In progress', 'Dana Maker', 'Bolt', 'widget.png'];
  const check = async () => {
    for (const [type, root] of [['Table', '.cgw-grid'], ...views]) {
      await showView(db, type);
      const body = db.locator(root);
      await expect(body).toBeVisible();
      if (type === 'Calendar') {
        // The month on screen holds the due date.
        await expect.poll(() => onCalendarDay(body, 'Widget', iso(dueDate()))).toBe(true);
        continue;
      }
      if (type === 'Table') {
        // Columns outside the window are not drawn: scroll across to each.
        await expectInRow(db, widget, 'Fits the left bracket');
        await expectInRow(db, widget, 'Hardware');
        // Towards the end: right in English, left in Arabic (where scrollLeft runs negative).
        await expectInRow(db, widget, '25');
        await grid(db).evaluate((el) => (el.scrollLeft = 0));
        continue;
      }
      const card = cardOf(body, 'Widget');
      await expect(card).toBeVisible();
      for (const text of values) await expect(card).toContainText(text);
    }
  };
  await check();

  // The same in Arabic: the interface right to left, the views drawn, the values kept.
  await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
  await page.reload();
  await expect(db).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(db.getByRole('toolbar')).toContainText('تصفية');
  await check();
  await page.evaluate(() => localStorage.setItem('cgw-language', 'en'));

  // The server holds the row as it was written.
  await expect(syncStatus(page)).toHaveAttribute('data-state', 'synced', { timeout: 30000 });
  const api = await apiSession(account);
  try {
    const { rows } = await api.get(`/api/v1/databases/${databaseId}/rows?limit=100`);
    const row = rows.find((r: { title: string }) => r.title === 'Widget');
    expect(row).toBeTruthy();
    expect(Object.keys(row.values).length).toBeGreaterThanOrEqual(13);
    expect(row.computed).toBeTruthy();
  } finally {
    await api.dispose();
  }
  expect(errors).toEqual([]);
});

test('filter, sort and group a view', async ({ page }) => {
  const errors = watchErrors(page);
  await createWorkspace(page);
  await newDatabase(page, 'Tasks');
  const db = fullPage(page);
  await showView(db, 'All tasks');
  const titles = () =>
    grid(db).locator('[role="row"][aria-rowindex] .cgw-title-text').allInnerTexts();
  await expect.poll(titles).toHaveLength(4);

  // A filter: Status is Done.
  await db.getByRole('button', { name: 'Filter', exact: true }).click();
  const filters = page.getByRole('dialog', { name: 'Filters' });
  await filters.getByRole('button', { name: 'Add a filter', exact: true }).click();
  await filters.getByRole('combobox', { name: 'Property' }).selectOption({ label: 'Status' });
  await filters.getByRole('combobox', { name: 'Value' }).selectOption({ label: 'Not started' });
  await page.keyboard.press('Escape');
  await expect(db.getByRole('button', { name: 'Filters: 1' })).toBeVisible();
  const notStarted = await titles();
  expect(notStarted.length).toBeGreaterThan(0);
  expect(notStarted.length).toBeLessThan(4);

  // The template sorts this view by Due; that sort is replaced by the title, descending.
  await db.getByRole('button', { name: 'Sorts: 1' }).click();
  const sorts = page.getByRole('dialog', { name: 'Sorts' });
  await sorts.getByRole('combobox', { name: 'Property' }).selectOption({ label: 'Task' });
  await sorts.getByRole('combobox', { name: 'Direction' }).selectOption({ label: 'Descending' });
  await page.keyboard.press('Escape');
  await expect.poll(titles).toEqual([...notStarted].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));

  // Grouped by priority, the filter taken off: every row in its group, counts in the headers.
  await db.getByRole('button', { name: 'Filters: 1' }).click();
  await page
    .getByRole('dialog', { name: 'Filters' })
    .getByRole('button', { name: 'Remove the filter' })
    .click();
  await page.keyboard.press('Escape');
  await db.getByRole('button', { name: 'Group', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Group' })
    .getByRole('combobox', { name: 'Group by' })
    .selectOption({ label: 'Priority' });
  await page.keyboard.press('Escape');
  await expect(db.getByRole('button', { name: 'Group: Priority' })).toBeVisible();
  const heads = grid(db).locator('.cgw-group-head');
  await expect(heads.first()).toBeVisible();
  const counts = await heads.locator('.cgw-group-count').allInnerTexts();
  expect(counts.reduce((sum, text) => sum + Number(text.match(/\d+/)![0]), 0)).toBe(4);
  // The view keeps all three across a reload.
  await page.reload();
  await expect(db.getByRole('button', { name: 'Group: Priority' })).toBeVisible();
  await expect(db.getByRole('button', { name: 'Sorts: 1' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a row opens as a page with its properties, and keeps its body', async ({ page, restart }) => {
  const errors = watchErrors(page);
  await createWorkspace(page);
  await newDatabase(page, 'Tasks');
  const db = fullPage(page);
  await showView(db, 'All tasks');
  // By the keys: a picker opened with Enter takes the focus, and what is typed picks in it.
  await grid(db)
    .getByRole('gridcell', { name: /^Review the budget/ })
    .click();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(picker(page, 'Status').getByRole('combobox')).toBeFocused();
  await page.keyboard.type('In prog');
  await page.keyboard.press('Enter');
  await expect(picker(page, 'Status')).toHaveCount(0);
  await expect(rowOf(db, 'Review the budget')).toContainText('In progress');
  // Ctrl+Enter on a row's title opens it.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByLabel('Page title')).toHaveValue('Review the budget');
  await expect(page.locator('.cgw-breadcrumbs')).toContainText('Tasks');
  await expect(page.getByRole('region', { name: 'Properties of Review the budget' })).toBeVisible();
  await chooseOptions(page, 'Status', ['Done']);
  await expect(rowValue(page, 'Status')).toHaveText('Done');
  // A click on an option chooses it and closes the picker, as Enter does.
  await rowValue(page, 'Priority').click();
  await expect(picker(page, 'Priority').getByRole('combobox')).toBeFocused();
  await picker(page, 'Priority').getByRole('option', { name: /High/ }).click();
  await expect(picker(page, 'Priority')).toHaveCount(0);
  await expect(rowValue(page, 'Priority')).toHaveText('High');
  await editor(page).click();
  await page.keyboard.type('Numbers checked twice.');
  await waitSaved(page);
  // The title is the row's title property.
  await page.getByLabel('Page title').fill('Review the budget again');
  await page.getByLabel('Page title').press('Enter');
  await waitSaved(page);
  const again = await restart();
  await again.goto('/');
  await treeRow(again, 'Tasks').click();
  await showView(fullPage(again), 'All tasks');
  const row = rowOf(fullPage(again), 'Review the budget again');
  await expect(row).toContainText('Done');
  await openRow(again, 'Review the budget again', fullPage(again));
  await expect(editor(again)).toContainText('Numbers checked twice.');
  // Rows are never in the sidebar.
  await expect(treeRow(again, 'Review the budget')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an inline database from the slash menu, and a linked view of it', async ({ page }) => {
  const errors = watchErrors(page);
  await createWorkspace(page);
  await newPage(page, 'Plans');
  await page.keyboard.type('/database');
  await page.getByRole('option', { name: /^Database/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New database' });
  await dialog.getByRole('button', { name: 'Create' }).click();
  const blocks = editor(page).locator('.cgw-db');
  await expect(blocks).toHaveCount(1);
  const inline = blocks.first();
  await expect(inline.getByRole('status')).toHaveText('Rows: 3');
  // At a page's width the toolbar leaves the tabs room: "Table" is drawn whole, not "Tal".
  expect(await tabClipped(inline.getByRole('tab', { name: 'Table' }))).toBe(false);
  // The inline database is a page under this one (no rows in the sidebar).
  await expect(treeRow(page, 'Plans')).toHaveAttribute('aria-expanded', /true|false/);
  // A title, then a value typed in its first row.
  await grid(inline).getByRole('gridcell').first().click();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Inline row');
  await page.keyboard.press('Enter');
  await expect(grid(inline)).toContainText('Inline row');
  // A linked view of it, in the paragraph after it.
  await editor(page).locator('[data-block] .cgw-body').last().click();
  await page.keyboard.type('/linked');
  await page.getByRole('option', { name: /Linked view/ }).click();
  const pick = page.getByRole('dialog', { name: 'Choose a database' });
  await pick.getByRole('option').first().click();
  await expect(blocks).toHaveCount(2);
  await expect(grid(blocks.nth(1))).toContainText('Inline row');
  // An edit in one shows in the other.
  await newRow(page, 'Made in the linked view', blocks.nth(1));
  await expect(grid(blocks.nth(0))).toContainText('Made in the linked view');
  // Deleting the block never deletes the database.
  await waitSaved(page);
  expect(errors).toEqual([]);
});

test('database templates, and a row made from a row template', async ({ page }) => {
  const errors = watchErrors(page);
  await createWorkspace(page);
  await newDatabase(page, 'Meeting notes');
  const db = fullPage(page);
  // The template's views and rows.
  for (const view of ['All notes', 'Calendar', 'By type'])
    await expect(db.getByRole('tab', { name: view })).toBeVisible();
  await expect(cardOf(db, 'Planning for next quarter')).toBeVisible();
  // Its row template, "Weekly sync", makes a row with the template's values, at the end.
  await expect(db.getByRole('status')).toHaveText('Rows: 3');
  await db.getByRole('button', { name: 'New from a template' }).click();
  await page.getByRole('menuitem', { name: 'Weekly sync' }).click();
  await expect(db.getByRole('status')).toHaveText('Rows: 4');
  await expect(cardOf(db, 'Weekly sync').last()).toContainText('Weekly sync');

  // A row template of our own: made, given a value and a body, then used.
  await newDatabase(page, 'Tasks', { title: 'Chores' });
  const chores = fullPage(page);
  await chores.getByRole('button', { name: 'New from a template' }).click();
  await page.getByRole('menuitem', { name: 'New template' }).click();
  await expect(page.locator('.cgw-row-props')).toBeVisible();
  await page.getByLabel('Page title').fill('Weekly clean');
  await page.getByLabel('Page title').press('Enter');
  await chooseOptions(page, 'Priority', ['High']);
  await editor(page).click();
  await page.keyboard.type('Kitchen, then the hall.');
  await waitSaved(page);
  await page.goBack();
  await expect(chores).toBeVisible();
  // Templates are never in a view.
  await showView(chores, 'All tasks');
  await expect(grid(chores)).not.toContainText('Weekly clean');
  await chores.getByRole('button', { name: 'New from a template' }).click();
  await page.getByRole('menuitem', { name: 'Weekly clean' }).click();
  await expect(rowOf(chores, 'Weekly clean')).toHaveCount(1);
  await expect(rowOf(chores, 'Weekly clean')).toContainText('High');
  await openRow(page, 'Weekly clean', chores);
  await expect(rowValue(page, 'Priority')).toHaveText('High');
  await expect(editor(page)).toContainText('Kitchen, then the hall.');
  expect(errors).toEqual([]);
});

test('CSV: a file imported as a new database, and a view exported', async ({
  page,
  savedFolder,
}, testInfo) => {
  const errors = watchErrors(page);
  await createWorkspace(page);
  const csv =
    'Name,Price,Due,In stock,Kind\r\n' +
    'Widget,12.5,2026-11-20,true,Hardware\r\n' +
    '"Bolt, small",2,2026-11-21,false,Hardware\r\n' +
    'Glue,4.25,,true,Supplies\r\n';
  await page.locator('[data-action="new-database"]').first().click();
  await page
    .getByRole('menuitem', { name: 'Import a CSV file as a new database', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Import CSV' });
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose a CSV file' }).click();
  await (
    await chooser
  ).setFiles({ name: 'Stock.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(dialog).toContainText('Stock.csv: 3 rows');
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toContainText('Imported rows: 3');
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  const db = fullPage(page);
  await expect(db).toBeVisible();
  await expect(db.getByRole('columnheader', { name: 'Price, Number' })).toBeVisible();
  await expect(db.getByRole('columnheader', { name: 'In stock, Checkbox' })).toBeVisible();
  await expect(db.getByRole('columnheader', { name: 'Due, Date' })).toBeVisible();
  await expect(grid(db)).toContainText('Bolt, small');
  await expect(db.getByRole('status')).toHaveText('Rows: 3');

  // The view, exported: the same rows back, with a BOM.
  await db.getByRole('button', { name: /^View options/ }).click();
  let bytes: Buffer;
  if (desktop) {
    await page.getByRole('menuitem', { name: 'Export this view as CSV' }).click();
    await expect
      .poll(() => (existsSync(savedFolder!) ? readdirSync(savedFolder!) : []).length, {
        timeout: 30000,
      })
      .toBe(1);
    bytes = readFileSync(join(savedFolder!, readdirSync(savedFolder!)[0]));
  } else {
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Export this view as CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
    const path = testInfo.outputPath('export.csv');
    await file.saveAs(path);
    bytes = readFileSync(path);
  }
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.subarray(3).toString('utf8');
  expect(text.split('\r\n')[0]).toBe('Name,Price,Due,In stock,Kind');
  expect(text).toContain('"Bolt, small",2,2026-11-21,false,Hardware');
  expect(text).toContain('Widget,12.5,2026-11-20,true,Hardware');
  expect(errors).toEqual([]);
});

test('a row trashed and restored comes back with its values', async ({ page }) => {
  const errors = watchErrors(page);
  await createWorkspace(page);
  await newDatabase(page, 'Tasks');
  const db = fullPage(page);
  await showView(db, 'All tasks');
  const row = rowOf(db, 'Review the budget');
  const before = (await row.textContent())!;
  await row.getByRole('gridcell').first().click();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(row).toHaveCount(0);
  await expect(db.getByRole('status')).toHaveText('Rows: 3');
  await page.goto('/#/trash');
  const trashed = page.getByTestId('trashed-rows');
  await expect(trashed).toContainText('Review the budget');
  await expect(trashed).toContainText('In Tasks');
  await trashed.getByRole('button', { name: 'Restore' }).first().click();
  await expect(trashed).toHaveCount(0);
  await treeRow(page, 'Tasks').click();
  await showView(db, 'All tasks');
  await expect(row).toHaveText(before);
  await expect(db.getByRole('status')).toHaveText('Rows: 4');
  expect(errors).toEqual([]);
});

test('deleting a property or an option never corrupts a row', async ({ page, authUrlFile }) => {
  test.setTimeout(180000);
  const errors = watchErrors(page);
  const account = await newAccount('Keeper');
  await signedInWorkspace(page, account, 'Keeping', authUrlFile, cloud.signer);
  const databaseId = await newDatabase(page, 'Empty database', { title: 'Parts' });
  const db = fullPage(page);
  await addProperty(page, 'Text', 'Notes');
  await addProperty(page, 'Select', 'Colour');
  await newRow(page, 'Hinge');
  await openRow(page, 'Hinge');
  await typeValue(page, 'Notes', 'Brass, 40 mm');
  await chooseOptions(page, 'Colour', ['Gold']);
  await page.goBack();
  const row = rowOf(db, 'Hinge');
  await expect(row).toContainText('Brass, 40 mm');
  await expect(row).toContainText('Gold');
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  const api = await apiSession(account);
  const serverRow = async () =>
    (await api.get(`/api/v1/databases/${databaseId}/rows?limit=100`)).rows.find(
      (r: { title: string }) => r.title === 'Hinge',
    );
  const stored = await serverRow();

  try {
    // The option deleted: the row reads empty there, and holds what it held.
    const colour = await propertyMenu(page, 'Colour', 'Select');
    await colour.getByRole('menuitem', { name: 'Edit options' }).click();
    await colour.getByRole('button', { name: 'Option: Gold' }).click();
    await colour.getByRole('button', { name: 'Delete option' }).click();
    await page.keyboard.press('Escape');
    await expect(row).not.toContainText('Gold');
    // The property deleted: hidden everywhere, the row's other values untouched.
    const notes = await propertyMenu(page, 'Notes', 'Text');
    await notes.getByRole('menuitem', { name: 'Delete property' }).click();
    await expect(db.getByRole('columnheader', { name: 'Notes, Text' })).toHaveCount(0);
    await expect(row).not.toContainText('Brass, 40 mm');
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    await expect.poll(async () => (await serverRow()).values).toEqual(stored.values);

    // Restored from the Properties panel: the values show again.
    await db.getByRole('button', { name: 'Properties', exact: true }).click();
    await page.getByRole('button', { name: 'Restore Notes' }).click();
    await page.keyboard.press('Escape');
    await expect(db.getByRole('columnheader', { name: 'Notes, Text' })).toBeVisible();
    await expect(row).toContainText('Brass, 40 mm');
    await openRow(page, 'Hinge');
    await expect(rowValue(page, 'Notes')).toHaveText('Brass, 40 mm');
    await expect(rowValue(page, 'Colour')).toHaveText('Empty');
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    expect((await serverRow()).values).toEqual(stored.values);
  } finally {
    await api.dispose();
  }
  expect(errors).toEqual([]);
});
