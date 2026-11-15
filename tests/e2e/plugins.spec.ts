// Plugin blocks (Phase 7, M7.2; INTEGRATIONS.md, Plugin blocks) in the app: a chart and a kanban
// board inserted from the slash menu, each pointed at a database through the linked-view picker,
// drawn from its rows; the chart's settings written to the block and kept after a reload; a card
// moved on the board writing that row's status, seen in the database itself; both read in Arabic
// and in the dark theme; and a plugin type this build does not know kept as it was, with a
// placeholder naming it.
import { test, expect } from './fixtures';
import { createWorkspace, editor, newPage, waitSaved, watchErrors } from './helpers';
import { fullPage, newDatabase, treeRow } from './database';

const pluginBlocks = (page: import('@playwright/test').Page) =>
  editor(page).locator('[data-body="pluginBlock"]');

async function insert(page: import('@playwright/test').Page, name: string) {
  await editor(page).locator('[data-block] .cgw-body').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(`/${name}`);
  await expect(page.getByRole('option', { name, exact: true })).toBeVisible();
  // By keys: a click at a long page's foot can miss while the menu moves (Phase 5 gotcha).
  await page.keyboard.press('Enter');
}

async function chooseTasks(
  page: import('@playwright/test').Page,
  block: import('@playwright/test').Locator,
) {
  await block.getByRole('button', { name: 'Choose a database' }).click();
  const pick = page.getByRole('dialog', { name: 'Choose a database' });
  await pick.getByRole('option', { name: /Tasks/ }).first().click();
  await expect(pick).toHaveCount(0);
}

test('a chart and a kanban board over a database: drawn from its rows, set, and a card moved', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await createWorkspace(page);
  await newDatabase(page, 'Tasks', { title: 'Tasks' });
  await newPage(page, 'Dashboard');
  await page.keyboard.type('This week');

  // The chart: "No database chosen", then the database, then grouped by its status.
  await insert(page, 'Chart');
  const chart = pluginBlocks(page).nth(0);
  await expect(chart).toContainText('No database chosen.');
  await chooseTasks(page, chart);
  await expect(chart).toContainText('Choose a property to group by in the settings.');
  await chart.getByRole('button', { name: 'Settings' }).click();
  await chart.getByLabel('Group by').selectOption({ label: 'Status' });
  await expect(chart.locator('[data-testid="chart-canvas"]')).toBeVisible();
  await expect(chart.getByRole('region', { name: 'Chart of Count by Status' })).toBeVisible();
  await chart.getByLabel('Chart', { exact: true }).selectOption({ label: 'Pie' });
  // The settings' "Done" (the chart's legend has a "Done" entry too: the status option).
  await chart.getByRole('button', { name: 'Done', expanded: true }).click();
  await expect(chart.locator('section[data-chart="pie"]')).toBeVisible();

  // The board: its columns are the status's options.
  await insert(page, 'Kanban board');
  const board = pluginBlocks(page).nth(1);
  await chooseTasks(page, board);
  const columns = board.locator('.cgw-board-column');
  await expect(columns.first()).toBeVisible();
  const todo = board.locator('.cgw-board-column[data-group]').nth(1);
  const card = todo.locator('[data-row-id]').first();
  const title = (await card.locator('.cgw-card-title').textContent())?.trim() ?? '';
  expect(title).not.toBe('');
  // Picked up, moved one column on, put down: the board's own keys.
  await card.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(
    board
      .locator('.cgw-board-column[data-group]')
      .nth(2)
      .locator('.cgw-card-title', { hasText: title }),
  ).toBeVisible();
  await waitSaved(page);

  // Kept after a reload: the chart's settings, the card in its new column, in the database too.
  await page.reload();
  await expect(pluginBlocks(page)).toHaveCount(2);
  await expect(pluginBlocks(page).nth(0).locator('section[data-chart="pie"]')).toBeVisible();
  await expect(
    pluginBlocks(page)
      .nth(1)
      .locator('.cgw-board-column[data-group]')
      .nth(2)
      .locator('.cgw-card-title', { hasText: title }),
  ).toBeVisible();
  // The database's own row holds the new status.
  await treeRow(page, 'Tasks').click();
  await expect(
    fullPage(page)
      .locator('.cgw-board-column[data-group]')
      .nth(2)
      .locator('.cgw-card-title', { hasText: title }),
  ).toBeVisible({ timeout: 30000 });
  expect(errors).toEqual([]);
});

test('plugin blocks read in Arabic and in the dark theme', async ({ page }) => {
  const errors = watchErrors(page);
  await createWorkspace(page);
  await newDatabase(page, 'Tasks', { title: 'Tasks' });
  await newPage(page, 'Dashboard');
  await insert(page, 'Chart');
  await chooseTasks(page, pluginBlocks(page).nth(0));
  await waitSaved(page);
  // Arabic and dark, as the app keeps them, then the app loaded again.
  await page.evaluate(() => {
    localStorage.setItem('cgw-theme', 'dark');
    localStorage.setItem('cgw-language', 'ar');
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('data-cg-theme', 'dark');
  const chart = pluginBlocks(page).nth(0);
  await expect(chart.locator('.cgw-plugin-root')).toHaveAttribute('dir', 'rtl');
  await expect(chart).toContainText('اختر من الإعدادات خاصية للتجميع حسبها.');
  await expect(chart.getByRole('button', { name: 'الإعدادات' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a plugin type this build does not know is kept as it was, with a placeholder naming it', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await createWorkspace(page);
  await newPage(page, 'From a newer build');
  await page.keyboard.type('Before');
  // A block from a later build, as the clipboard brings it.
  await editor(page).evaluate((root) => {
    const data = new DataTransfer();
    data.setData(
      'text/html',
      '<div data-block=""><div data-body="pluginBlock" data-type="vendor.timeline" data-version="3" data-props=\'{"span":"Q3","later":[1,2]}\'></div></div><p>After</p>',
    );
    root.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  const block = pluginBlocks(page);
  await expect(block).toHaveCount(1);
  await expect(block).toContainText(
    'This block needs a newer version of Cash Gear Workspace (vendor.timeline).',
  );
  // Typing around it changes nothing of it.
  await editor(page).getByText('After').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' and more');
  await waitSaved(page);
  await page.reload();
  await expect(block).toContainText('(vendor.timeline)');
  expect(errors).toEqual([]);
});
