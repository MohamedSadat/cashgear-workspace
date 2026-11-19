// Phase 12 (M12.3): the database grid as a screen reader gets it, read from Chromium's own
// accessibility tree in Chrome and Edge (grid.ts): CDP's tree for roles, names, descriptions,
// levels and expanded states and the grid's active descendant; Chromium's internal tree (on
// chrome://accessibility, edge://accessibility) for what CDP does not hold, as Chromium computed
// it for a screen reader: the row count, each row's index, a tree grid row's place and size.
//
// A local database of 300 rows: the count is the header and the 300; the title is each row's
// header (named by it alone), the headers are named by the property (the type their description);
// a row's index after moving down and after a jump is its place of the 300 (its title's number
// and one); the "New" line is no row and is said; editing is said when it starts, is saved and is
// cancelled. A database the server answers (above LOCAL_ROW_LIMIT): the count is the server's
// total, and a row's index after a jump past the rows loaded is its place of it. A grouped table:
// a tree grid, each group a row at level 1 with its state, its place among the groups and its
// count, its rows at level 2 with their place in it; Left and Right collapse and expand it.
//
// The browser's own pages (chrome://accessibility) are the browsers': the desktop target (WebView2)
// is skipped. The grid's Axe walk is a11y.spec.ts's, its Arabic walk arabic.spec.ts's.
import type { Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { createWorkspace, watchErrors } from './helpers';
import { newAccount, syncStatus } from './cloud';
import {
  addProperty,
  fullPage,
  grid,
  newDatabase,
  rowCount,
  signedInWorkspace,
  signers,
  signOutDesktop,
} from './database';
import {
  AxTree,
  FORCE_ACCESSIBILITY,
  LOCAL_ROW_LIMIT,
  groupedTasks,
  importInto,
  internalGrid,
  localDatabase,
  tableSaid,
} from './grid';

test.use({ launchOptions: FORCE_ACCESSIBILITY });
test.skip(desktop, 'chrome://accessibility is the browsers’ own; the desktop app is WebView2');

const TABLE = '.cgw-database-page .cgw-grid';
const activeId = (page: Page) => page.locator(TABLE).getAttribute('aria-activedescendant');
/** A row of the CSV's rows is titled "Item 0042": its place of the total is its number. */
const placeOf = (title: string) => Number(/^Item (\d+)$/.exec(title)?.[1] ?? NaN);

test('a local table: its true total, a row’s place as one moves and jumps, the title as its header, editing said', async ({
  page,
}) => {
  test.setTimeout(180000);
  const errors = watchErrors(page);
  await createWorkspace(page);
  const db = await localDatabase(page, 300, 'Ledger');
  const said = tableSaid(db);
  const ax = await AxTree.of(page);
  try {
    // The grid, named, described by the true total.
    expect(await ax.node(TABLE)).toMatchObject({
      role: 'grid',
      name: 'Ledger: table',
      description: 'Rows: 300',
    });
    // The headers by the property's name, its type the description.
    const headers = (await ax.all()).filter((n) => n.role === 'columnheader');
    expect(headers.map((h) => [h.name, h.description])).toEqual([
      ['Name', 'Title'],
      ['Size', 'Number'],
    ]);
    // Chromium's count: the header and the 300 rows, though only the window is drawn.
    let chromium = await internalGrid(page, 'Ledger: table');
    expect(chromium.rowCount).toBe(301);
    expect(await grid(db).locator('.cgw-tbody [role="row"]').count()).toBeLessThan(80);

    // The first row's title: its header, named by the title alone, at place 1 (index 2).
    await grid(db).focus();
    let active = await ax.active(TABLE);
    expect(active?.cell).toMatchObject({ role: 'rowheader', name: 'Item 0001' });
    expect(chromium.rowIndexOf((await activeId(page))!)).toBe(2);

    // Down: the next row's place; Right: its Size, a grid cell, the row still named by its title.
    await page.keyboard.press('ArrowDown');
    active = await ax.active(TABLE);
    expect(active?.cell).toMatchObject({ role: 'rowheader', name: 'Item 0002' });
    chromium = await internalGrid(page, 'Ledger: table');
    expect(chromium.rowIndexOf((await activeId(page))!)).toBe(3);
    await page.keyboard.press('ArrowRight');
    active = await ax.active(TABLE);
    expect(active?.cell).toMatchObject({ role: 'gridcell', name: '2' });

    // A jump by a page, then to the end: each row's index is its title's place of the 300 plus one.
    await page.keyboard.press('PageDown');
    await page.keyboard.press('ArrowLeft');
    active = await ax.active(TABLE);
    const paged = placeOf(active!.cell.name);
    expect(paged).toBeGreaterThan(5);
    chromium = await internalGrid(page, 'Ledger: table');
    expect(chromium.rowIndexOf((await activeId(page))!)).toBe(paged + 1);
    // Ctrl+Down: the New line, which is no row (nothing active for a screen reader), and is said.
    await page.keyboard.press('Control+ArrowDown');
    await expect(grid(db)).not.toHaveAttribute('aria-activedescendant', /.+/);
    await expect(said).toHaveText('New row: press Enter to add one.');
    await page.keyboard.press('ArrowUp');
    active = await ax.active(TABLE);
    expect(active?.cell).toMatchObject({ role: 'rowheader', name: 'Item 0300' });
    chromium = await internalGrid(page, 'Ledger: table');
    expect(chromium.rowIndexOf((await activeId(page))!)).toBe(301);
    expect(chromium.rowCount).toBe(301);

    // Editing, said: started, cancelled, then saved, by the property and the row's title.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(grid(db).locator('.cgw-inline-editor')).toBeFocused();
    await expect(said).toHaveText('Editing: Size, Item 0300.');
    await page.keyboard.press('Escape');
    await expect(said).toHaveText('Edit cancelled: Size, Item 0300.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('3000');
    await page.keyboard.press('Enter');
    await expect(said).toHaveText('Saved: Size, Item 0300.');
    await expect(grid(db).locator('.cgw-inline-editor')).toHaveCount(0);
    // The title: saved as it was written.
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+KeyA');
    await page.keyboard.type('Item 0300, checked');
    await page.keyboard.press('Enter');
    await expect(said).toHaveText('Saved: Name, Item 0300, checked.');
    // The New line's Enter: a row, its title being edited, said; the count follows it.
    await page.keyboard.press('ArrowDown');
    await expect(said).toHaveText('New row: press Enter to add one.');
    await page.keyboard.press('Enter');
    await expect(said).toHaveText('Editing: Name, Untitled.');
    await page.keyboard.press('Escape');
    await expect(grid(db)).toHaveAttribute('aria-rowcount', '302');
    chromium = await internalGrid(page, 'Ledger: table');
    expect(chromium.rowCount).toBe(302);
  } finally {
    await ax.dispose();
  }
  expect(errors).toEqual([]);
});

const cloud = signers();
test.describe('a table the server answers', () => {
  test.afterEach(async ({ page }) => {
    await cloud.close();
    await signOutDesktop(page);
  });

  test('its count is the server’s total, and a row’s index past the rows loaded is its place of it', async ({
    page,
    authUrlFile,
  }) => {
    test.setTimeout(300000);
    const errors = watchErrors(page);
    const account = await newAccount('Grid total');
    await signedInWorkspace(page, account, 'Grid space', authUrlFile, cloud.signer);
    await newDatabase(page, 'Empty database', { title: 'Stock' });
    const db = fullPage(page);
    await addProperty(page, 'Number', 'Size');
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
    // More rows than a device queries itself: the server imports them and answers the table.
    const total = LOCAL_ROW_LIMIT + 200;
    await importInto(page, db, total, 'Stock');
    const query = page.waitForResponse((r) => /\/databases\/[^/]+\/query$/.test(r.url()), {
      timeout: 60000,
    });
    await page.reload();
    await expect(db).toBeVisible();
    expect((await query).status()).toBe(200);
    await expect(rowCount(db)).toHaveText(new RegExp(`^Rows: \\d+ of ${total}$`), {
      timeout: 60000,
    });
    const ax = await AxTree.of(page);
    try {
      const loaded = (await rowCount(db).innerText()).match(/^Rows: (\d+) of/)![1];
      expect(await ax.node(TABLE)).toMatchObject({
        role: 'grid',
        name: 'Stock: table',
        description: `Rows: ${loaded} of ${total}`,
      });
      let chromium = await internalGrid(page, 'Stock: table');
      expect(chromium.rowCount).toBe(total + 1);
      await grid(db).focus();
      expect(chromium.rowIndexOf((await activeId(page))!)).toBe(2);
      // A jump past the rows loaded: the next page comes, and the row there is read at its place
      // of the server's total.
      await page.keyboard.press('Control+ArrowDown');
      await expect
        .poll(async () => (await ax.active(TABLE))?.cell.role, { timeout: 30000 })
        .toBe('rowheader');
      let active = await ax.active(TABLE);
      const place = placeOf(active!.cell.name);
      expect(place).toBeGreaterThan(Number(loaded));
      chromium = await internalGrid(page, 'Stock: table');
      expect(chromium.rowIndexOf((await activeId(page))!)).toBe(place + 1);
      expect(chromium.rowCount).toBe(total + 1);
      // Down from there: the next place.
      await page.keyboard.press('ArrowDown');
      active = await ax.active(TABLE);
      if (active?.cell.role === 'rowheader') {
        chromium = await internalGrid(page, 'Stock: table');
        expect(chromium.rowIndexOf((await activeId(page))!)).toBe(placeOf(active.cell.name) + 1);
      }
    } finally {
      await ax.dispose();
    }
    expect(errors).toEqual([]);
  });
});

test('a grouped table is a tree grid: groups at level 1 with their state, place and count, rows at level 2 in them', async ({
  page,
}) => {
  test.setTimeout(180000);
  const errors = watchErrors(page);
  await createWorkspace(page);
  const db = await groupedTasks(page, 'Priority');
  const tree = db.locator('[role="treegrid"].cgw-grid');
  const ax = await AxTree.of(page);
  try {
    expect((await ax.node(TABLE))?.role).toBe('treegrid');
    // CDP: each group's header a row at level 1, expanded, named by its group and count.
    const nodes = await ax.all();
    const groups = nodes.filter((n) => n.role === 'row' && n.props.level === 1);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (const group of groups) {
      expect(group.props.expanded).toBe(true);
      expect(group.name).toMatch(/Rows: \d+$/);
    }
    const counts = groups.map((g) => Number(/(\d+)$/.exec(g.name)![1]));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(4);
    const rows = nodes.filter((n) => n.role === 'row' && n.props.level === 2);
    expect(rows).toHaveLength(4);

    // Chromium: the count of every line (the header, each group, each group's rows), each group's
    // place among the groups, each row's place in its group of its count.
    const chromium = await internalGrid(page, /: table$/);
    expect(chromium.role).toBe('treeGrid');
    expect(chromium.rowCount).toBe(1 + groups.length + 4);
    const lines = await tree.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>('.cgw-tbody [role="row"]')].map((r) => ({
        id: r.id,
        group: r.classList.contains('cgw-trow-group'),
      })),
    );
    let groupNo = 0;
    let inGroup = 0;
    let last = 1;
    for (const line of lines) {
      const index = chromium.rowIndexOf(line.id)!;
      expect(index).toBe(last + 1);
      last = index;
      const place = chromium.treeOf(line.id)!;
      if (line.group) {
        expect(place).toEqual({ level: 1, posInSet: ++groupNo, setSize: groups.length });
        inGroup = 0;
      } else expect(place).toEqual({ level: 2, posInSet: ++inGroup, setSize: counts[groupNo - 1] });
    }
    expect(groupNo).toBe(groups.length);

    // The keys: the first group's header is what is active; Left collapses it, Right expands it.
    await tree.focus();
    let active = await ax.active(TABLE);
    expect(active?.cell).toMatchObject({ role: 'row', props: { level: 1, expanded: true } });
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await ax.active(TABLE))?.cell.props.expanded).toBe(false);
    expect((await internalGrid(page, /: table$/)).rowCount).toBe(1 + groups.length + 4 - counts[0]);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await ax.active(TABLE))?.cell.props.expanded).toBe(true);
    // Into its rows (past an empty group's New line): a row's header at level 2.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('ArrowDown');
      active = await ax.active(TABLE);
      if (active?.cell.role === 'rowheader') break;
    }
    expect(active?.row?.props.level).toBe(2);
  } finally {
    await ax.dispose();
  }
  expect(errors).toEqual([]);
});
