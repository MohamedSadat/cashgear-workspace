// Phase 19: a page holding every block, made in the app for the specs of Word, PDF and print
// (print.spec.ts) and the phase's budgets: the writer's own fixture (packages/doc/src/out/
// fixtures.ts) pasted as the editor's slice, a Tasks database of the template's four rows shown by
// its board in a database block, and a real picture pasted as a file. A block a build cannot make
// (one of a later version) is left out; a sheet, an ERP view, a child page and a mention that point
// at nothing here are kept, and are written as the device has them.
import { expect, type Page } from '@playwright/test';
import type { DocJSON } from '../../packages/doc/src/binding';
import { FIXTURE_WORDS, everyBlockContent } from '../../packages/doc/src/out/fixtures';
import { PNG, newDatabase } from './database';
import { createWorkspace, editor, newPage } from './helpers';

export const OUT_WORDS = FIXTURE_WORDS;

/** The fixture's content as this app can hold it, its database block pointed at `databaseId`. */
export function pastedContent(language: 'en' | 'ar', databaseId: string): DocJSON[] {
  const content = everyBlockContent(language).content ?? [];
  return content
    .filter((block) => block.content?.[0]?.type !== 'futureBlock')
    .filter((block) => !(block.content?.[0]?.type === 'image' && block.content[0].attrs?.width))
    .map((block) =>
      block.content?.[0]?.type === 'databaseView'
        ? { ...block, content: [{ type: 'databaseView', attrs: { databaseId, viewId: null } }] }
        : block,
    );
}

/** Pastes blocks into the open page's editor, as the editor's own clipboard carries them. */
export async function pasteBlocks(page: Page, blocks: DocJSON[]) {
  await editor(page).evaluate((root, slice) => {
    const data = new DataTransfer();
    data.setData(
      'application/x-cgw-slice+json',
      JSON.stringify({ format: 'cgw-slice', slice: { content: slice, openStart: 0, openEnd: 0 } }),
    );
    root.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, blocks);
}

/** Pastes a picture into the open page, as a file from the clipboard. */
export async function pastePicture(page: Page, name = 'squares.png') {
  await editor(page).evaluate(
    (root, { bytes, name }) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
      root.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    { bytes: [...PNG], name },
  );
}

/**
 * A local workspace with a Tasks database and a page holding every block, open, in the given
 * language (the interface's too). Returns the page's title.
 */
export async function everyBlockPage(page: Page, language: 'en' | 'ar' = 'en'): Promise<string> {
  if (language === 'ar') {
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
    await page.goto('/');
    await page.getByLabel('اسم مساحة العمل').fill('مساحتي');
    await page.getByRole('button', { name: 'إنشاء مساحة العمل' }).click();
    await expect(page.locator('.cgw-editor')).toBeVisible();
  } else await createWorkspace(page);
  const words = OUT_WORDS[language];
  const databaseId = await newDatabase(page, language === 'ar' ? 'المهام' : 'Tasks', { language });
  if (language === 'ar') {
    await page
      .getByRole('button', { name: /^إضافة صفحة في/ })
      .first()
      .click();
    await expect(page.getByLabel('عنوان الصفحة')).toHaveValue('');
    await page.getByLabel('عنوان الصفحة').fill(words.title);
    await page.keyboard.press('Enter');
    await expect(editor(page)).toBeFocused();
  } else await newPage(page, words.title);
  await pasteBlocks(page, pastedContent(language, databaseId));
  await expect(editor(page)).toContainText(words.lastLine);
  await page.keyboard.press('Control+End');
  await pastePicture(page);
  await expect(
    editor(page).locator('img:not(.ProseMirror-separator):not([hidden])').last(),
  ).toBeVisible();
  return words.title;
}

/** Opens the page menu and picks an item by its name. */
export async function pageMenu(page: Page, item: string, language: 'en' | 'ar' = 'en') {
  await page
    .locator('.cgw-topbar')
    .getByRole('button', { name: language === 'ar' ? 'إجراءات الصفحة' : 'Page actions' })
    .click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}
