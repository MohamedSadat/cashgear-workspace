import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createWorkspace, editor, newPage, waitSaved, watchErrors } from './helpers';

// Phase 1 exit criterion 10: search finds pages by title and by text, in English and Arabic,
// with the same normalisation on both sides (no tashkeel, ة and ه alike, Arabic digits), and
// Ctrl+K opens a result or runs a command.

const palette = (page: Page) => page.getByRole('dialog', { name: 'Search and commands' });
const input = (page: Page) => palette(page).getByRole('combobox');
const results = (page: Page) =>
  palette(page).getByRole('group', { name: 'Pages' }).getByRole('option');

async function search(page: Page, query: string) {
  if (!(await palette(page).isVisible())) await page.keyboard.press('Control+KeyK');
  await expect(palette(page)).toBeVisible();
  await input(page).fill(query);
}

/**
 * Writes a page, then waits until its text is in the index (a moment after it saves): `probe` is
 * a word of the text that is not in the title.
 */
async function writePage(page: Page, title: string, text: string, probe: string) {
  await newPage(page, title);
  await page.keyboard.type(text);
  await waitSaved(page);
  await expect
    .poll(
      async () => {
        await search(page, probe);
        const found = (await results(page).allTextContents()).join('\n');
        await page.keyboard.press('Escape');
        await expect(palette(page)).toBeHidden();
        return found;
      },
      { timeout: 15_000 },
    )
    .toContain(title);
}

test.describe('search', () => {
  test('finds text in English and Arabic, normalised alike', async ({ page }) => {
    const errors = watchErrors(page);
    await createWorkspace(page);
    await writePage(
      page,
      'Budget review',
      'Spending on the school library rose in 2026.',
      'library',
    );
    await writePage(
      page,
      'خطة المدرسة',
      'مَدْرَسَةُ الحَيِّ تفتح في عام ٢٠٢٦ بعد الترميم',
      'الترميم',
    );

    // English: words in any order, prefixes, case does not matter.
    await search(page, 'LIBR spend');
    await expect(results(page)).toHaveCount(1);
    await expect(results(page).first()).toContainText('Budget review');
    await expect(results(page).first()).toContainText('school library');

    // Arabic without tashkeel finds text written with it; ه finds ة.
    await search(page, 'مدرسه الحي');
    await expect(results(page)).toHaveCount(1);
    await expect(results(page).first()).toContainText('خطة المدرسة');

    // Western digits find Arabic-Indic digits, and the other way round.
    await search(page, '2026');
    await expect(results(page)).toHaveCount(2);
    await search(page, '٢٠٢٦ spending');
    await expect(results(page)).toHaveCount(1);
    await expect(results(page).first()).toContainText('Budget review');

    // Titles rank first.
    await search(page, 'budget');
    await expect(results(page).first()).toContainText('Budget review');

    // Enter opens the chosen result.
    await search(page, 'مدرسه');
    await expect(results(page).first()).toContainText('خطة المدرسة');
    await page.keyboard.press('Enter');
    await expect(palette(page)).toBeHidden();
    await expect(page.getByLabel('Page title')).toHaveValue('خطة المدرسة');
    expect(errors).toEqual([]);
  });

  test('keeps the index after a reload and drops pages in the trash', async ({ page }) => {
    await createWorkspace(page);
    await writePage(
      page,
      'Quarterly plan',
      'Hire two accountants before the audit.',
      'accountants',
    );
    await page.reload();
    await expect(editor(page)).toBeVisible();

    // The worker rebuilt the index from IndexedDB.
    await search(page, 'accountants');
    await expect(results(page).first()).toContainText('Quarterly plan');
    await page.keyboard.press('Escape');

    // In the trash, the page is not found.
    await page.getByRole('button', { name: 'Page actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to trash' }).click();
    await search(page, 'accountants');
    await expect(palette(page).getByText('Nothing found')).toBeVisible();
  });

  test('runs a command from the palette', async ({ page }) => {
    await createWorkspace(page);
    await search(page, 'dark theme');
    await expect(palette(page).getByRole('option', { name: 'Use the dark theme' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(palette(page)).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('data-cg-theme', 'dark');

    // Arabic labels search too, after switching the language from the palette.
    await search(page, 'arabic');
    await palette(page).getByRole('option', { name: 'Switch to Arabic' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await page.keyboard.press('Control+KeyK');
    const dialog = page.getByRole('dialog', { name: 'البحث والأوامر' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox').fill('الانجليزيه');
    await expect(dialog.getByRole('option', { name: /الإنجليزية/ })).toBeVisible();
  });
});
