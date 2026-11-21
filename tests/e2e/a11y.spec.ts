import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { caretSettled, createWorkspace, editor, newPage, waitSaved } from './helpers';
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
import { commentScene, select } from './collab';
import { pluginScene, pluginScreens } from './plugins';
import { phase7Scene, phase7Screens } from './phase7';
import { erp10Scene, erp10Screens } from './erp10';
import { meaningScene, meaningScreens } from './meaning';
import { groupsScene, groupsScreens } from './groups';
import { ssoScene, ssoScreens } from './sso';
import { chartScene, chartScreens } from './chart';
import { gridScene, gridScreens } from './grid';
import { erp12Scene, erp12Screens } from './erp12';
import { planScene, planScreens } from './plan';
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
        // The editor reads the click's caret a moment later on a busy runner (Phase 6, 1414cd0).
        await caretSettled(page);
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
        // The ring is the element's own, or (a tree's row, the library's tree view) its row's.
        const ring = (node: Element | null) => {
          if (!node) return false;
          const style = getComputedStyle(node);
          return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
        };
        return {
          role: el.getAttribute('role'),
          visible:
            ring(el) || (el.getAttribute('role') === 'treeitem' && ring(el.firstElementChild)),
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
    // open, and how many there are. Each row is named by its title alone (the library's tree
    // view: a section's buttons are not part of its name); a section with pages is open, one
    // without (Private, at first) has nothing to open.
    const row = page.getByRole('treeitem', { name: /Getting started/ });
    await expect(row).toHaveAttribute('aria-level', '2');
    await expect(row).toHaveAttribute('aria-setsize', '2');
    await expect(row).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('tree', { name: 'Pages' })).toMatchAriaSnapshot(`
      - tree "Pages":
        - treeitem "Workspace" [expanded] [level=1]
        - treeitem "Getting started" [level=2] [selected]
        - treeitem "البداية" [level=2]
        - treeitem "Private" [level=1]
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
          await caretSettled(page);
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

// Phase 7: Axe on a chart block, an ERP block editing a vendor and its review, the AI panel with a
// proposal and Settings' AI section, in both themes and both languages, against the server stack,
// the mock ERP and the mock provider (phase7.ts's scene, made in English, then loaded again in
// each language and theme).
test.describe('accessibility of Phase 7', () => {
  const cloud = signers();
  test.afterEach(() => cloud.close());
  test('Axe finds nothing on the chart, ERP editing and review, the AI panel and its settings (light and dark, English and Arabic)', async ({
    page,
  }) => {
    test.skip(desktop || REAL_ERP, 'A browser against the mocks');
    test.setTimeout(480000);
    const scene = await phase7Scene(page, 'Axe seven', cloud.signer);
    const pageUrl = page.url();
    const problems: string[] = [];
    try {
      for (const theme of ['light', 'dark'] as const) {
        for (const language of ['en', 'ar'] as const) {
          await page.goto(pageUrl);
          await setTheme(page, theme);
          await page.evaluate((value) => localStorage.setItem('cgw-language', value), language);
          await page.reload();
          await expect(editor(page)).toBeVisible({ timeout: 30000 });
          await phase7Screens(page, language, async (screen) => {
            problems.push(...(await axe(page, `${screen} (${theme}, ${language})`)));
          });
        }
      }
      expect(problems, problems.join('\n')).toEqual([]);
    } finally {
      await scene.api.dispose();
    }
  });
});

// Phase 10: Axe on an ERP block editing Items on hand (a shared field's editor and note, every row
// of the item changed, the review of each row, a conflict that needs no choice), and on search by
// meaning (the palette's "Related by meaning", Settings' part of it), in both themes and both
// languages, against the server stack and the mocks (erp10.ts's and meaning.ts's scenes, made in
// English, then loaded again in each language and theme).
test.describe('accessibility of Phase 10’s ERP editing and search by meaning', () => {
  const cloud = signers();
  test.afterEach(() => cloud.close());
  test('Axe finds nothing on Items on hand editing, its review and conflict (light and dark, English and Arabic)', async ({
    page,
  }) => {
    test.skip(desktop || REAL_ERP, 'A browser against the mocks');
    test.setTimeout(480000);
    const scene = await erp10Scene(page, 'Axe ten', cloud.signer);
    const pageUrl = page.url();
    const problems: string[] = [];
    try {
      for (const theme of ['light', 'dark'] as const) {
        for (const language of ['en', 'ar'] as const) {
          await page.goto(pageUrl);
          await setTheme(page, theme);
          await page.evaluate((value) => localStorage.setItem('cgw-language', value), language);
          await page.reload();
          await expect(editor(page)).toBeVisible({ timeout: 30000 });
          await erp10Screens(page, language, async (screen) => {
            problems.push(...(await axe(page, `${screen} (${theme}, ${language})`)));
          });
        }
      }
      expect(problems, problems.join('\n')).toEqual([]);
    } finally {
      await scene.api.dispose();
    }
  });

  test('Axe finds nothing on the palette’s related by meaning and its settings (light and dark, English and Arabic)', async ({
    page,
  }) => {
    test.skip(desktop, 'A browser against the mock providers');
    test.setTimeout(480000);
    const scene = await meaningScene(page, 'Axe meaning', cloud.signer);
    const pageUrl = page.url();
    const problems: string[] = [];
    try {
      for (const theme of ['light', 'dark'] as const) {
        for (const language of ['en', 'ar'] as const) {
          await page.goto(pageUrl);
          await setTheme(page, theme);
          await page.evaluate((value) => localStorage.setItem('cgw-language', value), language);
          await page.reload();
          await expect(editor(page)).toBeVisible({ timeout: 30000 });
          await meaningScreens(page, language, async (screen) => {
            problems.push(...(await axe(page, `${screen} (${theme}, ${language})`)));
          });
        }
      }
      expect(problems, problems.join('\n')).toEqual([]);
    } finally {
      await scene.api.dispose();
    }
  });
});

// Phase 6: Axe on the comments panel (open threads, a reply, a draft, a resolved thread shown),
// the inbox and the presence bar, in both themes and both languages, against the server stack:
// two people on a page (collab.ts's scene, made in English), then the language and theme set and
// the app loaded again for each.
test.describe('accessibility of comments, the inbox and presence', () => {
  let scene: Awaited<ReturnType<typeof commentScene>> | null = null;
  test.afterEach(async () => {
    await scene?.t.close();
    scene = null;
  });
  test('Axe finds nothing on the comments panel, the inbox and the presence bar (light and dark, English and Arabic)', async ({
    page,
  }) => {
    test.skip(desktop, 'Two people in browser profiles of their own');
    test.setTimeout(360000);
    scene = await commentScene(page);
    const { ids } = scene;
    const problems: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      for (const language of ['en', 'ar'] as const) {
        const screen = `${theme}, ${language}`;
        await page.goto(`/#/p/${scene.pageId}`);
        await setTheme(page, theme);
        await page.evaluate((value) => localStorage.setItem('cgw-language', value), language);
        await page.reload();
        await expect(editor(page)).toContainText('A second paragraph to resolve.', {
          timeout: 30000,
        });
        await expect(page.getByTestId('presence-bar')).toBeVisible({ timeout: 20000 });
        // The panel (by its shortcut, the same in both languages), the resolved ones shown, and a
        // draft on a selection.
        await editor(page).locator('[data-block] > .cgw-body').first().click();
        await page.keyboard.press('Control+Alt+Shift+KeyM');
        const comments = page.getByTestId('comments-panel');
        await expect(comments.locator('[data-thread-id][data-state="saved"]')).toHaveCount(1, {
          timeout: 20000,
        });
        await comments.locator('.cgw-comments-header button[aria-pressed]').click();
        await expect(comments.locator('[data-thread-id]')).toHaveCount(2);
        await select(page, ids[1], 2, 6);
        await page.keyboard.press('Control+Alt+KeyM');
        await expect(comments.getByTestId('comment-draft')).toBeVisible();
        await page.keyboard.type('A draft');
        problems.push(...(await axe(page, `comments panel, presence bar (${screen})`)));
        await page.keyboard.press('Escape');
        await page.goto('/#/inbox');
        await expect(page.getByTestId('inbox-list').locator('li')).toHaveCount(2, {
          timeout: 20000,
        });
        // An entry under the pointer: its secondary text on the hover colour too.
        await page.getByTestId('inbox-list').getByRole('link').first().hover();
        problems.push(...(await axe(page, `inbox (${screen})`)));
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

// Phase 10: Axe on a third-party plugin block's bar and Settings → Plugins (the list and the Add
// review dialog), in both themes and both languages, against the server stack (plugins.ts's scene,
// made in English, then loaded again in each language and theme). The plugin's frame is a sandbox
// of another origin, excluded: its contents are the author's.
test.describe('accessibility of Phase 10’s plugins', () => {
  test('Axe finds nothing on a plugin block and Settings → Plugins (light and dark, English and Arabic)', async ({
    page,
  }) => {
    test.skip(desktop, 'The plugins origin is framed by the web build; run in a browser');
    test.setTimeout(480000);
    const scene = await pluginScene(page, 'Axe plugins');
    const pageUrl = page.url();
    const problems: string[] = [];
    const axeOut = async (screen: string) => {
      const result = await new AxeBuilder({ page })
        .withTags(WCAG)
        .exclude('[data-body="pluginBlock"] iframe')
        .analyze();
      for (const v of result.violations)
        problems.push(`${screen}: ${v.id} (${v.impact}) ${v.help}`);
    };
    try {
      for (const theme of ['light', 'dark'] as const) {
        for (const language of ['en', 'ar'] as const) {
          await page.goto(pageUrl);
          await setTheme(page, theme);
          await page.evaluate((value) => localStorage.setItem('cgw-language', value), language);
          await page.reload();
          await expect(editor(page)).toBeVisible({ timeout: 30000 });
          await pluginScreens(page, language, (screen) =>
            axeOut(`${screen} (${theme}, ${language})`),
          );
        }
      }
      expect(problems, problems.join('\n')).toEqual([]);
    } finally {
      await scene.api.dispose();
    }
  });
});

// Phase 11: Axe on the groups' screens (Settings → Members → Groups with a group being changed and
// its delete asked, the share dialog with a group's row and its one picker's list open, a
// workbook's access with a group), in both themes and both languages, against the server stack
// (groups.ts's scene, made in English, then loaded again in each language and theme). The picker's
// list is drawn over the page, outside the dialog's box, and is checked with it.
test.describe('accessibility of Phase 11’s groups', () => {
  const cloud = signers();
  test.afterEach(() => cloud.close());
  test('Axe finds nothing on Settings’ groups, the share dialog’s picker and a workbook’s access (light and dark, English and Arabic)', async ({
    page,
  }) => {
    test.skip(desktop, 'Members invited by mail; the screens are the web build’s');
    test.setTimeout(480000);
    const scene = await groupsScene(page, 'Axe groups', cloud.signer);
    const pageUrl = page.url();
    const problems: string[] = [];
    try {
      for (const theme of ['light', 'dark'] as const) {
        for (const language of ['en', 'ar'] as const) {
          await page.goto(pageUrl);
          await setTheme(page, theme);
          await page.evaluate((value) => localStorage.setItem('cgw-language', value), language);
          await page.reload();
          await expect(editor(page)).toBeVisible({ timeout: 30000 });
          await groupsScreens(page, scene, language, async (screen) => {
            problems.push(...(await axe(page, `${screen} (${theme}, ${language})`)));
          });
        }
      }
      expect(problems, problems.join('\n')).toEqual([]);
    } finally {
      await scene.dispose();
    }
  });
});

// Phase 11: Axe on Settings → Single sign-on (the provider set and not tested yet, a domain proven
// and one not, a refusal said, then each question it asks: removing the provider, requiring
// sign-on, removing a domain), in both themes and both languages, against the server stack and
// the mock provider (sso.ts's scene, made in English, then loaded again in each language and theme).
test.describe('accessibility of Phase 11’s single sign-on', () => {
  const cloud = signers();
  test.afterEach(() => cloud.close());
  test('Axe finds nothing on Settings’ single sign-on and its questions (light and dark, English and Arabic)', async ({
    page,
  }) => {
    test.skip(desktop, 'The mock provider is reached by the web build; the screens are the same');
    test.setTimeout(480000);
    const scene = await ssoScene(page, 'Axe sign-on', cloud.signer);
    const pageUrl = page.url();
    const problems: string[] = [];
    try {
      for (const theme of ['light', 'dark'] as const) {
        for (const language of ['en', 'ar'] as const) {
          await page.goto(pageUrl);
          await setTheme(page, theme);
          await page.evaluate((value) => localStorage.setItem('cgw-language', value), language);
          await page.reload();
          await expect(editor(page)).toBeVisible({ timeout: 30000 });
          await ssoScreens(page, scene, language, async (screen) => {
            problems.push(...(await axe(page, `${screen} (${theme}, ${language})`)));
          });
        }
      }
      expect(problems, problems.join('\n')).toEqual([]);
    } finally {
      await scene.dispose();
    }
  });
});

// Phase 12: Axe on the chart view (bars, its Layout settings, a pie, a chart with no group), in both
// themes and both languages, on this device (chart.ts's scene: a Projects database, made in
// English, then loaded again in each language and theme).
test.describe('accessibility of Phase 12’s chart view', () => {
  test('Axe finds nothing on the chart view and its settings (light and dark, English and Arabic)', async ({
    page,
  }) => {
    test.setTimeout(240000);
    const scene = await chartScene(page, 'en');
    const problems: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      for (const language of ['en', 'ar'] as const) {
        await page.goto(scene.url);
        await setTheme(page, theme);
        await page.evaluate((value) => localStorage.setItem('cgw-language', value), language);
        await page.reload();
        await chartScreens(page, scene.language, language, async (screen) => {
          problems.push(...(await axe(page, `${screen} (${theme}, ${language})`)));
        });
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

// Phase 12 (M12.3): Axe on the database grid as a screen reader gets it: the table with a row's
// cell active, a title being edited and cancelled (said in the live region), the grouped table
// as a tree grid with a group's header active and collapsed, and a "New" line reached; in both
// themes and both languages, on this device (grid.ts's scene: the Tasks template and a fifth view
// grouped by Priority, made in English, then loaded again in each language and theme).
test.describe('accessibility of Phase 12’s grid', () => {
  test('Axe finds nothing on the grid and the tree grid, moving and editing (light and dark, English and Arabic)', async ({
    page,
  }) => {
    test.setTimeout(240000);
    const scene = await gridScene(page, 'en');
    const problems: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      for (const language of ['en', 'ar'] as const) {
        await page.goto(scene.url);
        await setTheme(page, theme);
        await page.evaluate((value) => localStorage.setItem('cgw-language', value), language);
        await page.reload();
        await gridScreens(page, language, async (screen) => {
          problems.push(...(await axe(page, `${screen} (${theme}, ${language})`)));
        });
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

// Phase 12 (M12.6): Axe on ERP report blocks: AP aging with its parameters (a date, two choices, a
// lookup) and its totals row, its date's calendar open, stock balance with its switch on, and the
// trial balance; in both themes and both languages, against the server stack and the mock ERP
// (erp12.ts's scene, made in English, then loaded again in each language and theme).
test.describe('accessibility of Phase 12’s ERP reports', () => {
  const cloud = signers();
  test.afterEach(() => cloud.close());
  test('Axe finds nothing on report blocks, their parameters, calendar and totals (light and dark, English and Arabic)', async ({
    page,
  }) => {
    test.skip(desktop || REAL_ERP, 'A browser against the mocks');
    test.setTimeout(480000);
    const scene = await erp12Scene(page, 'Axe twelve', cloud.signer);
    const pageUrl = page.url();
    const problems: string[] = [];
    try {
      for (const theme of ['light', 'dark'] as const) {
        for (const language of ['en', 'ar'] as const) {
          await page.goto(pageUrl);
          await setTheme(page, theme);
          await page.evaluate((value) => localStorage.setItem('cgw-language', value), language);
          await page.reload();
          await expect(editor(page)).toBeVisible({ timeout: 30000 });
          await erp12Screens(page, language, async (screen) => {
            problems.push(...(await axe(page, `${screen} (${theme}, ${language})`)));
          });
        }
      }
      expect(problems, problems.join('\n')).toEqual([]);
    } finally {
      await scene.api.dispose();
    }
  });
});

// Phase 13: Axe on Settings with AI on Cash Gear's subscription, search by meaning on this server and
// a plugin's hosts (one waiting), a plugin update's review naming a new host, and the dialog that
// allows a plugin's hosts, in both themes and both languages (plan.ts's scene, made in English).
test.describe('accessibility of Phase 13’s AI and plugins', () => {
  const cloud = signers();
  test.afterAll(async () => cloud.close());

  test('Axe finds nothing on the subscription, this server’s model and a plugin’s hosts (light and dark, English and Arabic)', async ({
    page,
  }) => {
    test.skip(desktop, 'A browser against the e2e stack');
    test.setTimeout(480000);
    await planScene(page, 'Axe plan', cloud.signer);
    const problems: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      for (const language of ['en', 'ar'] as const) {
        await page.goto('/#/settings');
        await setTheme(page, theme);
        await page.evaluate((value) => localStorage.setItem('cgw-language', value), language);
        await page.reload();
        await planScreens(page, language, async (screen) => {
          problems.push(...(await axe(page, `${screen} (${theme}, ${language})`)));
        });
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
