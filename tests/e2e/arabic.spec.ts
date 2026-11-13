import type { Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { editor, waitSaved, watchErrors } from './helpers';

// Phase 1 exit criterion 12: in Arabic the app is right to left and no string of its own is left
// in English. Each main screen is walked: every visible text node, label, placeholder and tooltip
// outside what the person wrote (page titles, page content, the workspace name) must have no
// English word. Key names are allowed: shortcuts are shown as the keys are labelled; and so is the
// CSV format's name (Phase 4: "Import a CSV file…"), which Arabic writes as it is.

const KEYS = /\b(Ctrl|Shift|Alt|Enter|Esc|Tab|Backspace|Delete|Del|Space|Cmd|Option|F\d+|CSV)\b/g;

async function english(page: Page, screen: string): Promise<string[]> {
  return page.evaluate(
    ({ screen, keys }) => {
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
      ].join(', ');
      const titles = [...document.querySelectorAll('.cgw-tree-title')].map((el) => el.textContent!);
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
    { screen, keys: KEYS.source },
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
