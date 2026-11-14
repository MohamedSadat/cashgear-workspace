import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createWorkspace, editor, newPage, waitSaved } from './helpers';
import { newAccount, syncStatus } from './cloud';
import { signedInWorkspace, signers } from './database';
import {
  REAL_ERP,
  REAL_SHEET,
  connectErp,
  erpBlock,
  expectLive,
  insertErpBlock,
  insertExistingWorkbook,
  linkWorkspace,
  mockErp,
  mockSheet,
  newWorkbook,
  pictureSent,
  sessionOf,
  sheetBlock,
  workbookOf,
  workspaceIdOf,
} from './ecosystem';
import { ar as dbAr, en as dbEn } from '../../packages/database/src/i18n/catalogues';

/** The shell's "New database" in the sidebar's ▦ menu. */
const NEW_DATABASE = { en: 'New database', ar: 'قاعدة بيانات جديدة' };

// M1.9: Axe on the main screens, in both themes and both languages; a keyboard-only pass over the
// main tasks; and the accessibility tree a screen reader reads, checked for names and roles.

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function axe(page: Page, screen: string) {
  const result = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const found = result.violations.map(
    (v) =>
      `${screen}: ${v.id} (${v.impact}) ${v.help}\n` +
      v.nodes
        .slice(0, 5)
        .map((n) => `    ${n.target.join(' ')}: ${n.failureSummary?.split('\n')[1] ?? ''}`)
        .join('\n'),
  );
  return found;
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((value) => localStorage.setItem('cgw-theme', value), theme);
}

test.describe('accessibility', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const language of ['en', 'ar'] as const) {
      test(`Axe finds nothing on the main screens (${theme}, ${language})`, async ({ page }) => {
        await page.goto('/');
        await setTheme(page, theme);
        await page.evaluate((value) => localStorage.setItem('cgw-language', value), language);
        await page.reload();
        const problems: string[] = [];
        problems.push(...(await axe(page, 'first run')));

        await page.locator('#cgw-workspace-name, input').first().fill('Axe');
        await page.keyboard.press('Enter');
        await expect(editor(page)).toBeVisible();
        await waitSaved(page);
        // The Getting started page holds every kind of block.
        problems.push(...(await axe(page, 'page with every block')));

        await page.keyboard.press('Control+KeyK');
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.getByRole('dialog').getByRole('combobox').fill('a');
        problems.push(...(await axe(page, 'search palette')));
        await page.keyboard.press('Escape');

        await editor(page).locator('[data-block] .cgw-body').first().click();
        await expect(editor(page)).toBeFocused();
        await page.keyboard.press('Control+Slash');
        await expect(page.getByRole('menu')).toBeVisible();
        problems.push(...(await axe(page, 'block menu')));
        await page.keyboard.press('Escape');

        await page.goto('/#/settings');
        await expect(page.locator('#cgw-settings-title')).toBeVisible();
        problems.push(...(await axe(page, 'settings')));

        await page.goto('/#/trash');
        await expect(page.locator('.cgw-trash, .cgw-empty').first()).toBeVisible();
        problems.push(...(await axe(page, 'trash')));

        expect(problems, problems.join('\n')).toEqual([]);
      });
    }
  }

  test('Axe finds nothing on a narrow screen with the drawer open', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await createWorkspace(page);
    await page.getByRole('button', { name: 'Show the sidebar' }).click();
    await expect(page.locator('#cgw-drawer')).toHaveAttribute('aria-hidden', 'false');
    // Colours half-way through the drawer's slide are not what it shows.
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState !== 'running'),
    );
    const problems = await axe(page, 'drawer');
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('the main tasks can be done with the keyboard alone', async ({ page }) => {
    await page.goto('/');
    // The name field has focus on the first screen.
    await expect(page.getByLabel('Workspace name')).toBeFocused();
    await page.keyboard.type('Keys only');
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Page title')).toHaveValue('Getting started');

    // Tab reaches the page tree; each stop shows where focus is.
    let inTree = false;
    for (let i = 0; i < 40 && !inTree; i++) {
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return {
          role: el.getAttribute('role'),
          visible: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
          what: el.outerHTML.slice(0, 80),
        };
      });
      expect(focus, 'focus is on an element').not.toBeNull();
      expect(focus!.visible, `focus shows on ${focus!.what}`).toBe(true);
      inTree = focus!.role === 'treeitem';
    }
    expect(inTree, 'Tab reaches the page tree').toBe(true);

    // In the tree: the row menu adds a page inside the focused one.
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    while (
      !(await menu
        .getByRole('menuitem', { name: 'Add a page inside' })
        .evaluate((el) => el === document.activeElement))
    )
      await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Page title')).toBeFocused();
    await page.keyboard.type('Made with keys');
    await page.keyboard.press('Enter');
    await expect(editor(page)).toBeFocused();

    // Write, use the slash menu, and move a block from the block menu.
    await page.keyboard.type('First');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/todo');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second');
    await page.keyboard.press('Control+Slash');
    const blockMenu = page.getByRole('menu', { name: 'Block menu' });
    await expect(blockMenu).toBeVisible();
    while (
      !(await blockMenu
        .getByRole('menuitem', { name: 'Move up' })
        .evaluate((el) => el === document.activeElement))
    )
      await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(editor(page)).toBeFocused();
    await expect(editor(page).locator('[data-block] .cgw-body').first()).toHaveText('Second');
    await waitSaved(page);

    // Search opens a page; Ctrl+, opens settings; the theme changes with the arrow keys.
    await page.keyboard.press('Control+KeyK');
    await page.keyboard.type('getting');
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Page title')).toHaveValue('Getting started');
    await page.keyboard.press('Control+Comma');
    await expect(page.locator('#cgw-settings-title')).toBeVisible();
    await page.getByRole('radio', { name: 'Dark' }).focus();
    await page.keyboard.press('Space');
    await expect(page.locator('html')).toHaveAttribute('data-cg-theme', 'dark');
  });

  test('a screen reader finds named landmarks, a named tree and a named editor', async ({
    page,
  }) => {
    await createWorkspace(page);
    await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
    await expect(page.getByRole('main', { name: 'Page' })).toBeVisible();
    await expect(page.getByRole('tree', { name: 'Pages' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Page title' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Page content' })).toBeVisible();
    // Every button and link has a name a screen reader can say.
    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll('button, a[href], [role="button"], [role="treeitem"]')]
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .filter((el) => !el.closest('[aria-hidden="true"]'))
        .filter((el) => !(el.getAttribute('aria-label') || el.textContent?.trim()))
        .map((el) => el.outerHTML.slice(0, 100)),
    );
    expect(unnamed).toEqual([]);
    // The tree says what each row is: sections at level 1, their pages at level 2, which one is
    // open, and how many there are.
    const row = page.getByRole('treeitem', { name: /Getting started/ });
    await expect(row).toHaveAttribute('aria-level', '2');
    await expect(row).toHaveAttribute('aria-setsize', '2');
    await expect(row).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('tree', { name: 'Pages' })).toMatchAriaSnapshot(`
      - tree "Pages":
        - treeitem "Workspace Add a database in Workspace Add a page in Workspace" [level=1]
        - treeitem "Getting started" [level=2] [selected]
        - treeitem "البداية" [level=2]
        - treeitem "Private Add a database in Private Add a page in Private" [level=1]
    `);
  });
});

// Phase 4: Axe on the database screens, in both themes and both languages: a Tasks database's
// table, board, list, calendar and gallery, the filter panel, a property's menu and a row's page.
test.describe('accessibility of databases', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const language of ['en', 'ar'] as const) {
      test(`Axe finds nothing on the database screens (${theme}, ${language})`, async ({
        page,
      }) => {
        test.setTimeout(120000);
        const t = (language === 'ar' ? dbAr : dbEn).database;
        await page.goto('/');
        await setTheme(page, theme);
        await page.evaluate((value) => localStorage.setItem('cgw-language', value), language);
        await page.reload();
        await page.locator('#cgw-workspace-name, input').first().fill('Axe');
        await page.keyboard.press('Enter');
        await expect(editor(page)).toBeVisible();
        await page.locator('[data-action="new-database"]').first().click();
        await page.getByRole('menuitem', { name: NEW_DATABASE[language], exact: true }).click();
        const picker = page.getByRole('dialog', { name: t.templates.title });
        await picker.getByRole('radio', { name: new RegExp(`^${t.templates.tasks.name}`) }).check();
        await picker.getByRole('button', { name: t.templates.create, exact: true }).click();
        const db = page.locator('.cgw-database-page .cgw-db');
        await expect(db).toBeVisible();
        await db.getByRole('button', { name: t.views.add }).click();
        await page.getByRole('menuitem', { name: t.viewType.gallery, exact: true }).click();
        const problems: string[] = [];
        const tabs = db.getByRole('tab');
        await expect(tabs).toHaveCount(5);
        for (let i = 0; i < 5; i++) {
          await tabs.nth(i).click();
          await expect(tabs.nth(i)).toHaveAttribute('aria-selected', 'true');
          await expect(
            db.locator('.cgw-grid, .cgw-board, .cgw-cal, .cgw-db-list, .cgw-gallery').first(),
          ).toBeVisible();
          // Drawn rows and cards, not a loading line.
          await page.waitForTimeout(300);
          problems.push(...(await axe(page, `database view ${await tabs.nth(i).innerText()}`)));
        }
        // The table: its filter panel, a property's menu, then a row's page.
        await tabs.nth(1).click();
        await expect(db.locator('.cgw-grid')).toBeVisible();
        await db.getByRole('button', { name: t.toolbar.filter, exact: true }).click();
        const filters = page.getByRole('dialog', { name: t.filter.title });
        await filters.getByRole('button', { name: t.filter.add, exact: true }).click();
        problems.push(...(await axe(page, 'filter panel')));
        await page.keyboard.press('Escape');
        await expect(filters).toHaveCount(0);
        await db.getByRole('columnheader').nth(1).click();
        await expect(page.getByRole('dialog', { name: /:/ })).toBeVisible();
        problems.push(...(await axe(page, 'property menu')));
        await page.keyboard.press('Escape');
        const first = db.locator('[role="row"][aria-rowindex="2"]');
        await first.hover();
        await first.locator('.cgw-open-row').click();
        await expect(page.locator('.cgw-row-props')).toBeVisible();
        problems.push(...(await axe(page, 'row page')));
        expect(problems, problems.join('\n')).toEqual([]);
      });
    }
  }
});

// Phase 5: Axe on the Sheet and ERP screens, in both themes and both languages, against the server
// stack and the mocks: the workbook block live and as its picture, the workbook picker and list,
// the ERP block (connect, its table, a refusal), the ERP settings section and the link screen.
// Everything is made in English, then the language and theme are set and the app loaded again.
test.describe('accessibility of workbooks and ERP data', () => {
  const cloud = signers();
  test.afterEach(() => cloud.close());
  for (const theme of ['light', 'dark'] as const) {
    for (const language of ['en', 'ar'] as const) {
      test(`Axe finds nothing on the Sheet and ERP screens (${theme}, ${language})`, async ({
        page,
      }) => {
        test.skip(REAL_SHEET || REAL_ERP, "The mocks' faults draw the error states");
        test.setTimeout(240000);
        await mockSheet.reset();
        await mockErp.reset();
        const account = await newAccount('Axe');
        await signedInWorkspace(page, account, 'Axe space', null, cloud.signer);
        const api = await sessionOf(account);
        try {
          const workspaceId = await workspaceIdOf(api, 'Axe space');
          const workbookId = await newWorkbook(
            api,
            workspaceId,
            'Axe book',
            workbookOf([
              ['Item', 'Amount'],
              ['Rent', 1200],
            ]),
          );
          await linkWorkspace(api, workspaceId, 'Axe space');
          await newPage(page, 'Axe page');
          await page.keyboard.type('Checked by Axe.');
          await page.keyboard.press('Enter');
          await insertErpBlock(page);
          const picture = pictureSent(page, workbookId);
          await insertExistingWorkbook(page, 'Axe book');
          await expectLive(sheetBlock(page), 'Rent');
          await picture;
          await page.waitForTimeout(1000);
          await waitSaved(page);
          await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });

          await setTheme(page, theme);
          await page.evaluate((value) => localStorage.setItem('cgw-language', value), language);
          await page.reload();
          const problems: string[] = [];
          const block = sheetBlock(page);
          await expect(block).toHaveAttribute('data-state', 'loaded', { timeout: 30000 });
          const erp = erpBlock(page);
          await expect(erp.getByTestId('erp-not-connected')).toBeVisible({ timeout: 30000 });
          problems.push(...(await axe(page, 'workbook live, ERP connect')));

          // The workbook as its picture: the embed fails, the kept picture stays with the note.
          await mockSheet.fault({ code: 'source.unavailable', times: 3, on: 'init' });
          await page.reload();
          await expect(block).toHaveAttribute('data-state', 'error:source.unavailable', {
            timeout: 30000,
          });
          // The faults the block did not use would fail the next spec's live views.
          await mockSheet.reset();
          await expect(block.locator('.cgw-sheet-picture img')).toBeVisible();
          problems.push(...(await axe(page, 'workbook picture')));

          // The workbook picker, from the slash menu.
          await editor(page).getByText('Checked by Axe.').click();
          await page.keyboard.press('End');
          await page.keyboard.press('Enter');
          await page.keyboard.type(language === 'ar' ? '/مصنف موجود' : '/existing');
          await page.getByRole('option', { name: /^(Existing workbook|مصنف موجود)/ }).click();
          const pick = page.getByRole('dialog');
          await expect(pick.getByRole('option')).toHaveCount(1, { timeout: 30000 });
          problems.push(...(await axe(page, 'workbook picker')));
          await page.keyboard.press('Escape');
          await expect(pick).toHaveCount(0);

          // The ERP block connected: its table; then a refusal of the ERP's.
          await connectErp(page, erp, 'alice');
          await erp.locator('[data-connector="vendors"]').click();
          await expect(erp.getByTestId('erp-table')).toBeVisible({ timeout: 30000 });
          problems.push(...(await axe(page, 'ERP table')));
          await mockErp.fault({
            match: 'Connectors/vendors/Query',
            status: 403,
            code: 'privilege.denied',
            times: 1,
          });
          await erp.locator('.cgw-erp-head-end button').click();
          await expect(erp.getByTestId('erp-query-error')).toBeVisible({ timeout: 30000 });
          problems.push(...(await axe(page, 'ERP refusal')));

          // The workbook list, the ERP settings section and the link screen.
          await page.goto('/#/workbooks');
          await expect(page.getByTestId('workbooks-table')).toBeVisible({ timeout: 30000 });
          problems.push(...(await axe(page, 'workbook list')));
          await page.goto('/#/settings');
          await expect(page.getByTestId('erp-settings').getByTestId('erp-links')).toBeVisible({
            timeout: 30000,
          });
          problems.push(...(await axe(page, 'ERP settings')));
          const { ticket } = await mockErp.linkTicket('dan');
          await page.goto(`/#/erp-link/${ticket}`);
          await expect(page.getByTestId('erp-link-screen').locator('form')).toBeVisible({
            timeout: 30000,
          });
          problems.push(...(await axe(page, 'ERP link screen')));
          expect(problems, problems.join('\n')).toEqual([]);
        } finally {
          await api.dispose();
        }
      });
    }
  }
});
