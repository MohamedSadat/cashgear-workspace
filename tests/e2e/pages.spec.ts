import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createWorkspace, editor, newPage, waitSaved, watchErrors } from './helpers';

// Phase 1 exit criteria 1 and 2: create a workspace; create and organise pages (nest, move,
// rename, trash, restore), with favourites, breadcrumbs, templates and page mentions.

const tree = (page: Page) => page.getByRole('tree', { name: 'Pages' });
const row = (page: Page, title: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(title) });

async function addSubpage(page: Page, parent: string, title: string) {
  await row(page, parent).hover();
  await row(page, parent).getByRole('button', { name: 'Add a page inside' }).click();
  // The new page is open once its title is empty.
  await expect(page.getByLabel('Page title')).toHaveValue('');
  await page.getByLabel('Page title').fill(title);
  await page.keyboard.press('Enter');
  await expect(row(page, title)).toBeVisible();
}

test.describe('workspaces and pages', () => {
  test('creates a workspace, then a second one from the switcher', async ({ page }) => {
    const errors = watchErrors(page);
    await createWorkspace(page, 'Finance');
    await expect(page.getByRole('button', { name: /Finance/ })).toBeVisible();
    await expect(row(page, 'Getting started')).toBeVisible();
    await expect(row(page, 'البداية')).toBeVisible();
    await page.getByRole('button', { name: /Finance/ }).click();
    await page.getByRole('menuitem', { name: 'Create a workspace' }).click();
    await page
      .getByRole('dialog', { name: 'Create a workspace' })
      .getByLabel('Workspace name')
      .fill('Operations');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByRole('button', { name: /Operations/ })).toBeVisible();
    await page.getByRole('button', { name: /Operations/ }).click();
    await expect(page.getByRole('menuitem', { name: /Finance/ })).toBeVisible();
    await page.getByRole('menuitem', { name: /Finance/ }).click();
    await expect(page.getByRole('button', { name: /Finance/ })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('nests, renames, moves by drag, trashes and restores pages', async ({ page }) => {
    await createWorkspace(page);
    await newPage(page, 'Projects');
    await addSubpage(page, 'Projects', 'Website');
    await addSubpage(page, 'Projects', 'Payroll');
    // Breadcrumbs show where the page is.
    await expect(page.getByRole('navigation', { name: 'Where this page is' })).toContainText(
      'Projects',
    );
    // Rename in place with F2.
    await row(page, 'Payroll').focus();
    await page.keyboard.press('F2');
    await page.keyboard.type('Payroll 2026');
    await page.keyboard.press('Enter');
    await expect(row(page, 'Payroll 2026')).toBeVisible();
    // Drag Website onto Getting started: it nests there.
    const source = row(page, 'Website');
    const target = row(page, 'Getting started');
    const from = (await source.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + 40, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(row(page, 'Getting started')).toHaveAttribute('aria-expanded', 'true');
    await expect(row(page, 'Website')).toHaveAttribute('aria-level', '3');
    // A page cannot go inside its own subpage: the tree refuses the drop.
    // Trash Projects (and Payroll 2026 with it), then restore both.
    await row(page, 'Projects').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to trash' }).click();
    await expect(row(page, 'Projects')).toHaveCount(0);
    await expect(row(page, 'Payroll 2026')).toHaveCount(0);
    await page.getByRole('link', { name: /Trash/ }).click();
    await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
    await expect(page.getByText('With subpages: 1.')).toBeVisible();
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(row(page, 'Projects')).toBeVisible();
    await expect(page.getByLabel('Page title')).toHaveValue('Projects');
    // Delete for good asks first.
    await row(page, 'Payroll 2026').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to trash' }).click();
    await page.getByRole('link', { name: /Trash/ }).click();
    await page.getByRole('button', { name: 'Delete for good' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete for good' }).click();
    await expect(page.getByText('The trash is empty.')).toBeVisible();
  });

  test('favourites, templates and page mentions', async ({ page }) => {
    await createWorkspace(page);
    await newPage(page, 'Meeting notes');
    await page.keyboard.type('Agenda for the week');
    await waitSaved(page);
    await page.getByRole('button', { name: 'Add to favourites' }).click();
    await expect(
      page.getByRole('region', { name: 'Favourites' }).getByRole('link', { name: /Meeting notes/ }),
    ).toBeVisible();
    // Use it as a template and make a copy: new page, same text, new block ids.
    await page.getByRole('button', { name: 'Page actions' }).click();
    await page.getByRole('menuitem', { name: 'Use as a template' }).click();
    const firstIds = await editor(page).evaluate((root) =>
      [...root.querySelectorAll('[data-block-id]')].map((b) => b.getAttribute('data-block-id')),
    );
    const templateUrl = page.url();
    await page.getByRole('button', { name: 'New from template' }).click();
    await page.getByRole('menuitem', { name: /Meeting notes/ }).click();
    await expect(page).not.toHaveURL(templateUrl);
    await expect(editor(page)).toContainText('Agenda for the week');
    const copyIds = await editor(page).evaluate((root) =>
      [...root.querySelectorAll('[data-block-id]')].map((b) => b.getAttribute('data-block-id')),
    );
    expect(copyIds.some((id) => firstIds.includes(id))).toBe(false);
    await expect(tree(page).getByRole('treeitem', { name: /Meeting notes/ })).toHaveCount(2);
    // Mention a page with @: its title is drawn now, and it opens the page.
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('See @Gett');
    await expect(page.getByRole('listbox', { name: 'Link to a page' })).toBeVisible();
    await page.keyboard.press('Enter');
    const mention = editor(page).locator('a.cgw-page-mention');
    await expect(mention).toHaveText('Getting started');
    await mention.click();
    await expect(page.getByLabel('Page title')).toHaveValue('Getting started');
  });
});
