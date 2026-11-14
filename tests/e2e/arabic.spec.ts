import type { Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { editor, newPage, waitSaved, watchErrors } from './helpers';
import { newAccount } from './cloud';
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
  newWorkbook,
  sessionOf,
  sheetBlock,
  watchAppErrors,
  workbookOf,
  workspaceIdOf,
} from './ecosystem';

// Phase 1 exit criterion 12: in Arabic the app is right to left and no string of its own is left
// in English. Each main screen is walked: every visible text node, label, placeholder and tooltip
// outside what the person wrote (page titles, page content, the workspace name) must have no
// English word. Key names are allowed: shortcuts are shown as the keys are labelled; and so is the
// CSV format's name (Phase 4: "Import a CSV file…"), which Arabic writes as it is, and from Phase 5
// the Cash Gear products' names («فتح في Cash Gear Sheet», «بيانات ERP»), which are not translated.

const KEYS =
  /\b(Ctrl|Shift|Alt|Enter|Esc|Tab|Backspace|Delete|Del|Space|Cmd|Option|F\d+|CSV|Cash Gear (?:Sheet|ERP|Workspace)|ERP)\b/g;

/**
 * What the person wrote or another system holds, beyond the main screens' own (Phase 5): names
 * of people, workspaces, workbooks and companies, and the ERP's records.
 */
interface Theirs {
  /** Elements whose text is theirs. */
  within?: string[];
  /** Words that are theirs wherever they appear (a name inside an Arabic sentence). */
  names?: string[];
}

async function english(page: Page, screen: string, theirs: Theirs = {}): Promise<string[]> {
  return page.evaluate(
    ({ screen, keys, theirs }) => {
      const keyNames = new RegExp(keys, 'g');
      // What the person wrote: page titles (the sidebar, breadcrumbs, the title, search
      // results), the page itself, and the workspace's name.
      const own = [
        '.cgw-editor',
        '.cgw-title',
        '.cgw-tree-title',
        '.cgw-breadcrumbs',
        '.cgw-palette-label',
        '.cgw-palette-detail',
        '.cgw-workspace-switcher',
        'kbd',
        '[lang="en"]',
        ...(theirs.within ?? []),
      ].join(', ');
      const titles = [
        ...[...document.querySelectorAll('.cgw-tree-title')].map((el) => el.textContent!),
        ...(theirs.names ?? []),
      ];
      const strip = (text: string) => {
        let out = text;
        for (const title of titles) out = out.split(title).join(' ');
        return out.replace(keyNames, ' ');
      };
      const visible = (el: Element) => {
        const box = (el as HTMLElement).getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      const found: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || parent.closest(own) || parent.closest('[aria-hidden="true"]')) continue;
        if (!visible(parent)) continue;
        const text = strip(node.textContent ?? '');
        if (/[A-Za-z]{2,}/.test(text)) found.push(`${screen}: text "${node.textContent!.trim()}"`);
      }
      for (const el of document.querySelectorAll('[aria-label], [placeholder], [title]')) {
        if (el.closest('.cgw-editor') || !visible(el)) continue;
        for (const name of ['aria-label', 'placeholder', 'title']) {
          const value = el.getAttribute(name);
          if (value && /[A-Za-z]{2,}/.test(strip(value)))
            found.push(`${screen}: ${name} "${value}" on <${el.tagName.toLowerCase()}>`);
        }
      }
      return found;
    },
    { screen, keys: KEYS.source, theirs },
  );
}

test('the Arabic interface is right to left, with no English of its own', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const found: string[] = [];
  found.push(...(await english(page, 'first run')));

  await page.getByLabel('اسم مساحة العمل').fill('مساحتي');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('عنوان الصفحة')).toHaveValue('البداية');
  await waitSaved(page);
  found.push(...(await english(page, 'page')));

  // The page header's own buttons, shown on hover.
  await page.locator('.cgw-page-header').hover();
  found.push(...(await english(page, 'page header')));

  await page.keyboard.press('Control+KeyK');
  const palette = page.getByRole('dialog');
  await expect(palette).toBeVisible();
  found.push(...(await english(page, 'palette')));
  await palette.getByRole('combobox').fill('ب');
  found.push(...(await english(page, 'palette with a query')));
  await page.keyboard.press('Escape');

  await editor(page).locator('[data-block] .cgw-body').first().click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press('Control+Slash');
  await expect(page.getByRole('menu')).toBeVisible();
  found.push(...(await english(page, 'block menu')));
  await page.keyboard.press('Escape');

  await editor(page).locator('[data-block] .cgw-body').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await expect(page.getByRole('listbox')).toBeVisible();
  found.push(...(await english(page, 'slash menu')));
  await page.keyboard.press('Escape');

  await page.getByRole('treeitem', { name: /البداية/ }).click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  found.push(...(await english(page, 'row menu')));
  await page.keyboard.press('Escape');

  await page.goto('/#/settings');
  await expect(page.locator('#cgw-settings-title')).toBeVisible();
  found.push(...(await english(page, 'settings')));

  await page.goto('/#/trash');
  await expect(page.locator('.cgw-page-area')).toBeVisible();
  found.push(...(await english(page, 'trash')));

  // Narrow screens are a browser's (the desktop window is at least 800 px wide).
  if (!desktop) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/settings');
    await page.getByRole('button', { name: 'إظهار الشريط الجانبي' }).click();
    await expect(page.locator('#cgw-drawer')).toHaveAttribute('aria-hidden', 'false');
    found.push(...(await english(page, 'drawer')));
  }

  expect(found, found.join('\n')).toEqual([]);
  expect(errors).toEqual([]);
});

// Phase 5's screens in Arabic: the workbook block and the ERP block on a page (before and after
// connecting), the block's view picker, the workbook list, the ERP settings section and the link
// screen; against the server stack and the mocks.
test('the Arabic workbook and ERP screens have no English of their own', async ({ page }) => {
  test.skip(desktop || REAL_SHEET || REAL_ERP, 'A browser against the mocks');
  test.setTimeout(240000);
  const cloud = signers();
  const errors = watchAppErrors(page);
  const account = await newAccount('Rana');
  await signedInWorkspace(page, account, 'Rana space', null, cloud.signer);
  const api = await sessionOf(account);
  try {
    const workspaceId = await workspaceIdOf(api, 'Rana space');
    await newWorkbook(api, workspaceId, 'Budget', workbookOf([['Item'], ['Rent']]));
    await linkWorkspace(api, workspaceId, 'Rana space');
    await newPage(page, 'Plans');
    await page.keyboard.type('Before.');
    await page.keyboard.press('Enter');
    await insertErpBlock(page);
    await insertExistingWorkbook(page, 'Budget');
    await expectLive(sheetBlock(page), 'Rent');
    await waitSaved(page);
    await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    // Names that are the person's or another system's: the workspace's and its sections' (made
    // in English), the workbook's, the ERP's company and users, the account's email, and this
    // account's devices (named by the server from their browsers: "Chrome on Windows", and
    // "Browser" for the tests' own API client), longest first.
    const theirs = {
      within: ['.cgw-sheet-name', '.cgw-erp-table tbody', '.cgw-workbooks td[dir="auto"]'],
      names: [
        account.name,
        account.email,
        'Rana space',
        'Workspace',
        'Private',
        'Budget',
        'Kit Trading',
        'Alice Haddad',
        'Dan Fawzy',
        'Chrome on Windows',
        'Edge on Windows',
        'Browser',
      ].sort((a, b) => b.length - a.length),
    };
    const found: string[] = [];
    const block = sheetBlock(page);
    await expect(block).toHaveAttribute('data-state', 'loaded', { timeout: 30000 });
    const erp = erpBlock(page);
    await expect(erp.getByTestId('erp-not-connected')).toBeVisible({ timeout: 30000 });
    found.push(...(await english(page, 'workbook and ERP blocks', theirs)));

    await block.locator('.cgw-sheet-icon').click();
    await expect(page.getByRole('menu')).toBeVisible();
    found.push(...(await english(page, 'workbook menu', theirs)));
    await page.getByRole('menuitem').nth(2).click();
    await expect(block.locator('form.cgw-sheet-picker')).toBeVisible();
    found.push(...(await english(page, 'view picker', theirs)));
    await block.locator('form.cgw-sheet-picker button[type="button"]').click();

    await connectErp(page, erp, 'alice');
    await erp.locator('[data-connector="vendors"]').click();
    await expect(erp.getByTestId('erp-table')).toBeVisible({ timeout: 30000 });
    await erp.locator('.cgw-erp-toolbar button').nth(2).click();
    found.push(...(await english(page, 'ERP table and filter', theirs)));

    await page.goto('/#/workbooks');
    await expect(page.getByTestId('workbooks-table')).toBeVisible({ timeout: 30000 });
    found.push(...(await english(page, 'workbook list', theirs)));
    await page.goto('/#/settings');
    await expect(page.getByTestId('erp-settings').getByTestId('erp-links')).toBeVisible({
      timeout: 30000,
    });
    found.push(...(await english(page, 'settings with ERP', theirs)));
    const { ticket } = await mockErp.linkTicket('dan');
    await page.goto(`/#/erp-link/${ticket}`);
    await expect(page.getByTestId('erp-link-screen').locator('form')).toBeVisible({
      timeout: 30000,
    });
    found.push(...(await english(page, 'ERP link screen', theirs)));
    expect(found, found.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
    await cloud.close();
  }
});
