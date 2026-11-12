// A page shared with someone who may only view it opens read-only in the editor (the banner,
// nothing editable, no menu entry that changes it), shows the owner's typing as it comes, and
// becomes editable at once when edit is given. Against the server stack, in Chrome and Edge.
import { test, expect, desktop } from './fixtures';
import { createWorkspace, editor, newPage, waitSaved, watchErrors } from './helpers';
import { newAccount, signIn, signedIn, syncStatus, mailTo, link } from './cloud';

test.skip(desktop, 'The browser signs in with a cookie; the guest is a second browser profile');

test('a page shared to view opens read-only and switches when edit is given', async ({
  page,
  browser,
}) => {
  const owner = await newAccount('Owner');
  await page.goto('/');
  await signIn(page, owner);
  await signedIn(page, owner);
  await createWorkspace(page, 'View space');
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  await newPage(page, 'Read me');
  await page.keyboard.type('Shared text');
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 20000 });
  const sharedUrl = page.url();
  const guest = await newAccount('Guest');
  await page.goto('/#/settings');
  await page.getByLabel('Email address').fill(guest.email);
  await page.getByLabel('Role').selectOption('guest');
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const invite = link(
    await mailTo(guest.email, 'invite'),
    /http:\/\/127\.0\.0\.1:4273\/#\/invite\/[A-Za-z0-9_-]+/,
  );
  const ctx = await browser.newContext();
  const second = await ctx.newPage();
  const errors = watchErrors(second);
  await second.goto('/');
  await signIn(second, guest, invite);
  await second.goto(invite);
  await second.getByRole('button', { name: 'Accept the invitation' }).click();
  await expect(second.getByText('You joined View space.')).toBeVisible({ timeout: 20000 });
  await second.goto('/');
  await expect(syncStatus(second)).toHaveText('Synced', { timeout: 30000 });

  await page.goto(sharedUrl);
  await page.locator('.cgw-topbar-button[aria-label="Page actions"]').click();
  await page.getByRole('menuitem', { name: 'Share…' }).click();
  const dialog = page.getByRole('dialog', { name: /Share/ });
  await dialog.getByLabel('Person').selectOption({ label: `Guest (${guest.email})` });
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Sharing saved.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await second.getByRole('treeitem', { name: /Read me/ }).click({ timeout: 20000 });
  await expect(editor(second)).toContainText('Shared text', { timeout: 20000 });
  await expect(second.getByTestId('page-read-only')).toHaveText(
    'You can view this page, not edit it.',
  );
  await expect(second.locator('.cgw-page [contenteditable="true"]')).toHaveCount(0);
  await expect(second.getByLabel('Page title')).toHaveAttribute('readonly', '');
  await second.locator('.cgw-topbar-button[aria-label="Page actions"]').click();
  await expect(second.getByRole('menuitem', { name: 'Move to trash' })).toHaveCount(0);
  await expect(second.getByRole('menuitem', { name: 'Use as a template' })).toHaveCount(0);
  await second.keyboard.press('Escape');
  await second.getByRole('treeitem', { name: /Read me/ }).click({ button: 'right' });
  await expect(second.getByRole('menuitem', { name: 'Rename' })).toHaveCount(0);
  await second.keyboard.press('Escape');

  // The owner types more: the reader sees it.
  await editor(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' and more');
  await waitSaved(page);
  await expect(editor(second)).toContainText('and more', { timeout: 20000 });

  // Edit given: the open page becomes editable.
  await page.locator('.cgw-topbar-button[aria-label="Page actions"]').click();
  await page.getByRole('menuitem', { name: 'Share…' }).click();
  await dialog.getByLabel('Access of Guest').selectOption('edit');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Sharing saved.')).toBeVisible();
  await expect(second.getByTestId('page-read-only')).toHaveCount(0, { timeout: 30000 });
  await expect(second.locator('.cgw-page [contenteditable="true"]')).toHaveCount(1);
  expect(errors).toEqual([]);
  await ctx.close();
});
