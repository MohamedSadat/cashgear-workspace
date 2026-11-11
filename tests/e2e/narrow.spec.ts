import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { blocks, createWorkspace, editor, waitSaved, watchErrors } from './helpers';

// M1.9, narrow screens: the sidebar is a drawer over the page, and a touch toolbar above the
// keyboard inserts blocks, formats, and moves blocks up, down, in and out.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const toggle = (page: Page) =>
  page.getByRole('button', { name: /Show the sidebar|Hide the sidebar/ });
// CgDrawer's panel: off screen and hidden from the accessibility tree when closed.
const drawer = (page: Page) => page.locator('#cgw-drawer');
const closed = (page: Page) => expect(drawer(page)).toHaveAttribute('aria-hidden', 'true');
const opened = (page: Page) => expect(drawer(page)).toHaveAttribute('aria-hidden', 'false');
const tools = (page: Page) => page.getByRole('toolbar', { name: 'Block tools' });

test.describe('narrow screens', () => {
  test('the sidebar is a drawer that closes when a page opens', async ({ page }) => {
    const errors = watchErrors(page);
    await createWorkspace(page);
    await closed(page);
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');

    await toggle(page).click();
    await opened(page);
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    // Focus moved into the drawer; the page behind it is inert.
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest('#cgw-drawer')))
      .toBe(true);
    await expect(page.locator('main:has(.cgw-main)')).toHaveAttribute('inert', '');

    // Choosing a page closes the drawer.
    await drawer(page)
      .getByRole('treeitem', { name: /البداية/ })
      .click();
    await closed(page);
    await expect(page.getByLabel('Page title')).toHaveValue('البداية');

    // Escape closes it too, and focus goes back to its button.
    await toggle(page).click();
    await opened(page);
    await page.keyboard.press('Escape');
    await closed(page);
    await expect(toggle(page)).toBeFocused();

    // A tap on the shaded page closes it.
    await toggle(page).click();
    await page.mouse.click(380, 400);
    await closed(page);
    expect(errors).toEqual([]);
  });

  test('the touch toolbar moves, indents and inserts blocks', async ({ page }) => {
    await createWorkspace(page);
    await toggle(page).click();
    await drawer(page)
      .getByRole('button', { name: /^Add a page in/ })
      .first()
      .click();
    await closed(page);
    await page.getByLabel('Page title').fill('Phone');
    await page.keyboard.press('Enter');
    await expect(editor(page)).toBeFocused();
    await expect(tools(page)).toBeVisible();

    await page.keyboard.type('one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    await page.keyboard.press('Enter');
    await page.keyboard.type('three');
    const before = await blocks(page);
    expect(before.map((b) => b.text)).toEqual(['one', 'two', 'three']);

    // Move up, twice: "three" goes to the top. Ids go with their blocks.
    await tools(page).getByRole('button', { name: 'Move up' }).click();
    await tools(page).getByRole('button', { name: 'Move up' }).click();
    let now = await blocks(page);
    expect(now.map((b) => b.text)).toEqual(['three', 'one', 'two']);
    expect(now.find((b) => b.text === 'three')!.id).toBe(before[2].id);
    await expect(editor(page)).toBeFocused();

    // Down again, then indent under "one", then out.
    await tools(page).getByRole('button', { name: 'Move down' }).click();
    now = await blocks(page);
    expect(now.map((b) => b.text)).toEqual(['one', 'three', 'two']);
    await tools(page).getByRole('button', { name: 'Indent' }).click();
    await expect(editor(page).locator('[data-block] [data-block]')).toHaveText(['three']);
    await tools(page).getByRole('button', { name: 'Outdent' }).click();
    await expect(editor(page).locator('[data-block] [data-block]')).toHaveCount(0);

    // Bold applies to what is typed next.
    await page.keyboard.press('End');
    await tools(page).getByRole('button', { name: 'Bold' }).click();
    await page.keyboard.type(' loud');
    await expect(editor(page).locator('strong')).toHaveText(' loud');

    // Insert opens the slash menu at the caret.
    await page.keyboard.press('Enter');
    await tools(page).getByRole('button', { name: 'Insert a block' }).click();
    await expect(page.getByRole('listbox', { name: 'Commands' })).toBeVisible();
    await page.keyboard.type('quote');
    await page.keyboard.press('Enter');
    await expect(editor(page).locator('[data-kind="quote"]')).toHaveCount(1);
    await waitSaved(page);

    // The toolbar goes when the editor loses focus.
    await page.getByLabel('Page title').click();
    await expect(tools(page)).toBeHidden();
  });
});
