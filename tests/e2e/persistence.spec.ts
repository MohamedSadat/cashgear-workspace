import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { desktop, expect, test } from './fixtures';
import { blocks, createWorkspace, editor, newPage, waitSaved } from './helpers';

// Phase 1 exit criteria 8 and 9: autosave and opening saved documents again; with export,
// import and local page history (M1.7). The kill test is scripts/kill-test.mjs.

test.describe('local persistence', () => {
  test('a page and its tree are there after the app starts again', async ({ page, restart }) => {
    await createWorkspace(page, 'Kept');
    await newPage(page, 'Survives');
    await page.keyboard.type('Written before closing');
    await page.keyboard.press('Enter');
    await page.keyboard.type('مكتوب قبل الإغلاق');
    await waitSaved(page);
    const before = await blocks(page);
    // A new tab on the same profile, or the desktop app started again: everything comes from
    // the local store.
    const again = await restart();
    await again.goto('/');
    await expect(again.getByRole('button', { name: /Kept/ })).toBeVisible();
    await again.getByRole('treeitem', { name: /Survives/ }).click();
    await expect(editor(again)).toContainText('Written before closing');
    const after = await blocks(again);
    expect(after.map((b) => [b.id, b.text])).toEqual(before.map((b) => [b.id, b.text]));
  });

  test('exports a workspace and imports it as a new one', async ({
    page,
    savedFolder,
  }, testInfo) => {
    await createWorkspace(page, 'Source');
    await newPage(page, 'Report');
    await page.keyboard.type('Quarterly figures');
    await waitSaved(page);
    await page.goto('/#/settings');
    let path = testInfo.outputPath('export.zip');
    if (desktop) {
      // The desktop saves through its own command; in tests it writes to CGW_SAVE_DIR instead of
      // asking where in the system's dialog.
      const folder = savedFolder!;
      await page.getByRole('button', { name: 'Export workspace' }).click();
      await expect
        .poll(() => (existsSync(folder) ? readdirSync(folder) : []).length, { timeout: 30000 })
        .toBe(1);
      const [name] = readdirSync(folder);
      expect(name).toMatch(/^Source \d{4}-\d{2}-\d{2}\.zip$/);
      path = join(folder, name);
    } else {
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export workspace' }).click();
      const file = await download;
      expect(file.suggestedFilename()).toMatch(/^Source \d{4}-\d{2}-\d{2}\.zip$/);
      await file.saveAs(path);
    }
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    await page.getByLabel('Import an export').setInputFiles(path);
    await expect(page.getByRole('button', { name: /Source \(imported\)/ })).toBeVisible();
    await page.getByRole('treeitem', { name: /Report/ }).click();
    await expect(editor(page)).toContainText('Quarterly figures');
    await expect(page.getByRole('treeitem', { name: /Getting started/ })).toBeVisible();
  });

  test('keeps a version and restores it, and the restore can be undone', async ({ page }) => {
    await createWorkspace(page);
    await newPage(page, 'Versions');
    await page.keyboard.type('First draft');
    await waitSaved(page);
    await page.getByRole('button', { name: 'Page actions' }).click();
    await page.getByRole('menuitem', { name: 'Page history' }).click();
    const dialog = page.getByRole('dialog', { name: 'Page history' });
    await dialog.getByRole('button', { name: 'Keep a version now' }).click();
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' and a second thought');
    await waitSaved(page);
    await page.getByRole('button', { name: 'Page actions' }).click();
    await page.getByRole('menuitem', { name: 'Page history' }).click();
    await dialog.getByRole('option').first().click();
    await expect(dialog.locator('.cgw-editor')).toHaveText('First draft');
    await dialog.getByRole('button', { name: 'Restore this version' }).click();
    await expect(editor(page)).toHaveText('First draft');
    await editor(page).click();
    await page.keyboard.press('Control+z');
    await expect(editor(page)).toContainText('second thought');
  });
});
