// Phase 11, M11.1's acceptance in Chrome and Edge, against the server stack (its hub and feed): an
// owner makes a group of two members in Settings → Members → Groups and restricts a page to it at
// view through the share dialog's one picker; the group's people read the page and cannot edit it
// (their open page turns read-only), a member outside it loses it; a person's own row still
// decides over their group's (edit of her own, then no access of her own though her group may
// view); and someone taken out of the group loses the page in their open tab, with no reload, and
// on their live connection.
import { test, expect, desktop } from './fixtures';
import { editor } from './helpers';
import { treeRow } from './database';
import { sharedPage, team, type Team } from './collab';
import { changeGroupPeople, makeGroup, openShare, pickPrincipal, serverAccess } from './groups';

test.skip(desktop, 'Four people in browser profiles of their own');

let current: Team | null = null;
test.afterEach(async () => {
  await current?.close();
  current = null;
});

const TITLE = 'Design notes';
const TEXT = 'Only for the designers.';
const READ_ONLY = 'You can view this page, not edit it.';
/** What a person's app may log while it loses a page: the browser's line for each refused request. */
const LOST = /status of 40[34] /;

test('a page restricted to a group is its people’s at its level, a person’s own row decides, and leaving the group takes it away at once', async ({
  page,
}) => {
  test.setTimeout(480000);
  const t = (current = await team(page, page.context().browser()!, ['Ada', 'Ben', 'Cy', 'Dee'], {
    workspace: 'Group space',
  }));
  const ada = t.owner;
  const [ben, cy, dee] = t.members;
  const { pageId } = await sharedPage(t, TITLE, [TEXT]);
  for (const m of t.members) await expect(m.page.getByTestId('page-read-only')).toHaveCount(0);

  // Ada makes the group in Settings: Ben and Cy.
  const groupId = await makeGroup(ada.page, 'Designers', ['Ben', 'Cy']);
  await expect(
    ada.page.getByTestId('groups-settings').locator(`[data-group-id="${groupId}"]`),
  ).toContainText('Ben and Cy');

  // She restricts the page to the group, at view, through the one picker.
  await ada.page.goto(`/#/p/${pageId}`);
  await expect(editor(ada.page)).toContainText(TEXT, { timeout: 30000 });
  let dialog = await openShare(ada.page);
  await dialog.getByLabel('Only the people below can open this page').check();
  await pickPrincipal(ada.page, dialog, 'Desig', /^Designers/);
  const row = dialog.locator(`[data-principal="group"][data-principal-id="${groupId}"]`);
  await expect(row).toContainText('Group · People: 2');
  await expect(row.getByLabel('Access of Designers')).toHaveValue('view');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Sharing saved.')).toBeVisible();
  await ada.page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const held = await serverAccess(ada.api, pageId);
  expect(held.restricted).toBe(true);
  expect(held.entries).toContainEqual(
    expect.objectContaining({
      principalType: 'group',
      principalId: groupId,
      level: 'view',
      displayName: 'Designers',
      peopleCount: 2,
    }),
  );

  // Ben and Cy read it and cannot edit it: their open page turns read-only.
  for (const m of [ben, cy]) {
    await expect(m.page.getByTestId('page-read-only')).toHaveText(READ_ONLY, { timeout: 60000 });
    await expect(m.page.locator('.cgw-page [contenteditable="true"]')).toHaveCount(0);
    await expect(editor(m.page)).toContainText(TEXT);
    expect(
      ((await m.api.get(`/api/v1/pages/${pageId}/permissions`)) as { yourLevel: string }).yourLevel,
    ).toBe('view');
  }
  // Dee, outside the group, does not see it: it leaves her sidebar and her screen.
  await expect(treeRow(dee.page, TITLE)).toHaveCount(0, { timeout: 60000 });
  await expect(editor(dee.page)).toHaveCount(0, { timeout: 30000 });
  expect((await dee.api.raw(`/api/v1/pages/${pageId}/permissions`)).status).not.toBe(200);

  // A person's own row decides over her group's: Cy given edit of her own edits the page...
  dialog = await openShare(ada.page);
  await pickPrincipal(ada.page, dialog, 'Cy', /^Cy/);
  await dialog.getByLabel('Access of Cy').selectOption('edit');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Sharing saved.')).toBeVisible();
  await expect(cy.page.getByTestId('page-read-only')).toHaveCount(0, { timeout: 60000 });
  await expect(cy.page.locator('.cgw-page [contenteditable="true"]')).toHaveCount(1);
  await expect(ben.page.getByTestId('page-read-only')).toHaveText(READ_ONLY);
  // ...and given no access of her own, she loses it, though her group may view it.
  await dialog.getByLabel('Access of Cy').selectOption('none');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Sharing saved.')).toBeVisible();
  await ada.page.keyboard.press('Escape');
  await expect(treeRow(cy.page, TITLE)).toHaveCount(0, { timeout: 60000 });
  await expect(treeRow(ben.page, TITLE)).toBeVisible();

  // Ben taken out of the group in Settings: his open tab loses the page, with no reload, and his
  // live connection is told.
  await ben.page.evaluate(() => ((window as unknown as { __kept: boolean }).__kept = true));
  const framesBefore = ben.hub.frames.length;
  await changeGroupPeople(ada.page, 'Designers', { remove: ['Ben'] });
  await expect(
    ada.page.getByTestId('groups-settings').locator(`[data-group-id="${groupId}"]`),
  ).toContainText('People: 1');
  await expect(treeRow(ben.page, TITLE)).toHaveCount(0, { timeout: 60000 });
  await expect(editor(ben.page)).toHaveCount(0, { timeout: 30000 });
  await expect
    .poll(() => ben.hub.frames.slice(framesBefore).some((f) => f.target === 'AccessRevoked'), {
      timeout: 60000,
    })
    .toBe(true);
  expect(await ben.page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(
    true,
  );
  expect((await ben.api.raw(`/api/v1/pages/${pageId}/permissions`)).status).not.toBe(200);
  // The server's list: the group's row as saved, Cy's own row at none.
  const after = await serverAccess(ada.api, pageId);
  expect(after.entries).toContainEqual(
    expect.objectContaining({ principalType: 'group', principalId: groupId, peopleCount: 1 }),
  );
  expect(after.entries).toContainEqual(
    expect.objectContaining({ principalType: 'user', principalId: cy.id, level: 'none' }),
  );

  expect(ada.errors).toEqual([]);
  for (const m of t.members) expect(m.errors.filter((e) => !LOST.test(e))).toEqual([]);
});
