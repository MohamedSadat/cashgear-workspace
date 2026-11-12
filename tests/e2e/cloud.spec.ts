// Phase 2's acceptance criteria in the browser, against the local server stack (API, worker,
// SQL Server, Azurite): sign-up to a second device seeing an edit within 5 seconds, a local
// workspace uploaded intact, an invited member, and a page shared with a guest and by a view
// link.
import { test, expect, desktop } from './fixtures';
import { createWorkspace, editor, newPage, waitSaved, watchErrors } from './helpers';
import { newAccount, signIn, signedIn, syncStatus, mailTo, link } from './cloud';

test.skip(desktop, 'The desktop signs in through the system browser: desktop-cloud.spec.ts');

test('signs up, keeps a workspace in the account, and a second device sees an edit within 5 seconds', async ({
  page,
  browser,
}) => {
  const errors = watchErrors(page);
  const account = await newAccount('Ada');
  await page.goto('/');
  await signIn(page, account);
  await signedIn(page, account);
  await createWorkspace(page, 'Cloud workspace');
  // Made while signed in: the workspace goes to the account at once.
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  await newPage(page, 'Shared notes');
  await page.keyboard.type('Hello from the first device');
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 20000 });

  const other = await browser.newContext();
  const second = await other.newPage();
  const secondErrors = watchErrors(second);
  await second.goto('/');
  await signIn(second, account);
  await signedIn(second, account);
  await second.getByRole('treeitem', { name: /Shared notes/ }).click({ timeout: 30000 });
  await expect(editor(second)).toContainText('Hello from the first device', { timeout: 20000 });

  // An edit on the first device reaches the open page on the second.
  await editor(page).click();
  await page.keyboard.press('End');
  const typed = Date.now();
  await page.keyboard.type(' and one more line');
  await expect(editor(second)).toContainText('and one more line', { timeout: 5000 });
  const elapsed = Date.now() - typed;
  test
    .info()
    .annotations.push({ type: 'second device', description: `${elapsed} ms from the last key` });
  expect(elapsed).toBeLessThan(5000);
  // A title changed on the second device reaches the first.
  await second.getByLabel('Page title').fill('Shared notes, renamed');
  await expect(page.getByLabel('Page title')).toHaveValue('Shared notes, renamed', {
    timeout: 10000,
  });
  expect(errors).toEqual([]);
  expect(secondErrors).toEqual([]);
  await other.close();
});

test('a workspace made before signing in uploads intact: tree, documents and ids', async ({
  page,
  browser,
}) => {
  await createWorkspace(page, 'Made offline');
  await newPage(page, 'Parent page');
  await page.keyboard.type('Written before any account');
  await waitSaved(page);
  const parentUrl = page.url();
  const account = await newAccount('Grace');
  await signIn(page, account, parentUrl);
  await signedIn(page, account);
  await expect(syncStatus(page)).toHaveText('On this device only');
  await page.getByRole('button', { name: 'Upload to my account' }).click();
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });

  const other = await browser.newContext();
  const second = await other.newPage();
  await second.goto('/');
  await signIn(second, account);
  await signedIn(second, account);
  await second.getByRole('treeitem', { name: /Parent page/ }).click({ timeout: 30000 });
  // The same page id: the address is the same page on both devices.
  expect(new URL(second.url()).hash).toBe(new URL(parentUrl).hash);
  await expect(editor(second)).toContainText('Written before any account', { timeout: 20000 });
  await expect(second.getByRole('treeitem', { name: /Getting started/ })).toBeVisible();
  await other.close();
});

test('an invited member sees the workspace; signing out keeps the pages on the device', async ({
  page,
  browser,
}) => {
  const owner = await newAccount('Owner');
  await page.goto('/');
  await signIn(page, owner);
  await signedIn(page, owner);
  await createWorkspace(page, 'Team space');
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  const member = await newAccount('Member');
  await page.goto('/#/settings');
  await page.getByLabel('Email address').fill(member.email);
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(page.getByText(`Invitation sent to ${member.email}.`)).toBeVisible();
  const invite = link(
    await mailTo(member.email, 'invite'),
    /http:\/\/127\.0\.0\.1:4273\/#\/invite\/[A-Za-z0-9_-]+/,
  );

  const other = await browser.newContext();
  const second = await other.newPage();
  await second.goto('/');
  await signIn(second, member, invite);
  await second.goto(invite);
  await second.getByRole('button', { name: 'Accept the invitation' }).click();
  await expect(second.getByText('You joined Team space.')).toBeVisible({ timeout: 20000 });
  await second.goto('/');
  await expect(second.getByRole('treeitem', { name: /Getting started/ })).toBeVisible({
    timeout: 30000,
  });

  // Signing out: this device keeps what it has; the status says so.
  await second.goto('/#/settings');
  await second.getByRole('button', { name: 'Sign out' }).click();
  await expect(
    second
      .getByRole('navigation', { name: 'Sidebar' })
      .getByRole('button', { name: 'Sign in to sync' }),
  ).toBeVisible();
  await second.goto('/');
  await expect(second.getByRole('treeitem', { name: /Getting started/ })).toBeVisible();
  await other.close();
});

test('a guest sees only the page shared with them; a view link opens it read-only until withdrawn', async ({
  page,
  browser,
}) => {
  const errors = watchErrors(page);
  const owner = await newAccount('Owner');
  await page.goto('/');
  await signIn(page, owner);
  await signedIn(page, owner);
  await createWorkspace(page, 'Client space');
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  await newPage(page, 'Private plan');
  await page.keyboard.type('Not for guests');
  await waitSaved(page);
  await newPage(page, 'For the guest');
  await page.keyboard.type('Shared text');
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 20000 });
  const sharedUrl = page.url();

  // A guest joins: nothing is shared with them yet.
  const guest = await newAccount('Guest');
  await page.goto('/#/settings');
  await page.getByLabel('Email address').fill(guest.email);
  await page.getByLabel('Role').selectOption('guest');
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(page.getByText(`Invitation sent to ${guest.email}.`)).toBeVisible();
  const invite = link(
    await mailTo(guest.email, 'invite'),
    /http:\/\/127\.0\.0\.1:4273\/#\/invite\/[A-Za-z0-9_-]+/,
  );
  const guestContext = await browser.newContext();
  const second = await guestContext.newPage();
  const guestErrors = watchErrors(second);
  await second.goto('/');
  await signIn(second, guest, invite);
  await second.goto(invite);
  await second.getByRole('button', { name: 'Accept the invitation' }).click();
  await expect(second.getByText('You joined Client space.')).toBeVisible({ timeout: 20000 });
  await second.goto('/');
  await expect(syncStatus(second)).toHaveText('Synced', { timeout: 30000 });
  await expect(second.getByRole('treeitem')).toHaveCount(0);

  // The owner shares one page with the guest by name.
  await page.goto(sharedUrl);
  await page.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: 'Share…' }).click();
  const dialog = page.getByRole('dialog', { name: /Share/ });
  await dialog.getByLabel('Person').selectOption({ label: `Guest (${guest.email})` });
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Sharing saved.')).toBeVisible();

  await expect(second.getByRole('treeitem', { name: /For the guest/ })).toBeVisible({
    timeout: 20000,
  });
  await second.getByRole('treeitem', { name: /For the guest/ }).click();
  await expect(editor(second)).toContainText('Shared text', { timeout: 20000 });
  await expect(second.getByRole('treeitem', { name: /Private plan/ })).toHaveCount(0);
  await expect(second.getByRole('treeitem', { name: /Getting started/ })).toHaveCount(0);

  // A view link: anyone holding it reads the page, signed out, and cannot change it.
  await dialog.getByRole('button', { name: 'Create a view link' }).click();
  const shareLink = (await dialog.getByTestId('share-link').textContent())!.trim();
  expect(shareLink).toMatch(/^http:\/\/127\.0\.0\.1:4273\/#\/s\/[A-Za-z0-9_-]{43}$/);
  const anonymousContext = await browser.newContext();
  const anonymous = await anonymousContext.newPage();
  const anonymousErrors = watchErrors(anonymous);
  await anonymous.goto(shareLink);
  await expect(anonymous.getByText('Shared text')).toBeVisible({ timeout: 20000 });
  await expect(
    anonymous.getByText('You are viewing a page shared with a link. It cannot be edited here.'),
  ).toBeVisible();
  await expect(anonymous.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(anonymous.getByText('Not for guests')).toHaveCount(0);

  // Withdrawn, the link opens nothing.
  await dialog.getByRole('button', { name: 'Withdraw' }).first().click();
  await expect(dialog.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
  await anonymous.reload();
  await expect(anonymous.getByText('This link is not valid any more.')).toBeVisible({
    timeout: 20000,
  });
  await expect(anonymous.getByText('Shared text')).toHaveCount(0);

  expect(errors).toEqual([]);
  expect(guestErrors).toEqual([]);
  // The withdrawn link's own refusal is the one error the anonymous page may log.
  expect(anonymousErrors.filter((e) => !/40[134]|410/.test(e))).toEqual([]);
  await guestContext.close();
  await anonymousContext.close();
});
