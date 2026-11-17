// Phase 9, M9.3: a workbook's history. Its kept versions, newest first, with when and by whom;
// one opened read-only in the embed by its own signed URL; an older one restored as a new newest
// version by an editor (the bytes the same, saved by the restorer now, no version lost); a reader
// sees the history and is offered no restore, and the server refuses theirs. Against the e2e
// server stack and the mock Sheet (its embed draws the version's cells), in Chrome and Edge and,
// for the editor's part, on the desktop app.
import { test, expect, desktop } from './fixtures';
import { newAccount, signIn, signedIn } from './cloud';
import { signedInWorkspace, signers, signOutDesktop } from './database';
import {
  REAL_SHEET,
  invite,
  mockSheet,
  newWorkbook,
  saveVersion,
  sessionOf,
  watchAppErrors,
  workbookOf,
  workspaceIdOf,
  type Api,
} from './ecosystem';

const cloud = signers();
test.afterEach(async ({ page }) => {
  await cloud.close();
  await signOutDesktop(page);
});
test.beforeEach(async () => {
  if (!REAL_SHEET) await mockSheet.reset();
});

interface Version {
  id: string;
  sha256: string;
  savedBy: { id: string; name: string } | null;
  current: boolean;
}

const versionsOf = async (api: Api, workbookId: string) =>
  ((await api.get(`/api/v1/workbooks/${workbookId}/versions`)) as { versions: Version[] }).versions;

/** A workbook saved three times: rent 1200, then 1300, then 1400. */
async function budget(api: Api, workspaceId: string) {
  const id = await newWorkbook(
    api,
    workspaceId,
    'Budget',
    workbookOf([
      ['Item', 'Q1'],
      ['Rent', 1200],
    ]),
  );
  for (const rent of [1300, 1400])
    await saveVersion(
      api,
      id,
      workbookOf([
        ['Item', 'Q1'],
        ['Rent', rent],
      ]),
    );
  return id;
}

test('an editor sees a workbook’s versions, opens one read-only and restores it as the newest', async ({
  page,
  authUrlFile,
}) => {
  test.setTimeout(240000);
  const errors = watchAppErrors(page);
  const owner = await newAccount('Keeper');
  await signedInWorkspace(page, owner, 'History space', authUrlFile, cloud.signer);
  const api = await sessionOf(owner);
  try {
    const workspaceId = await workspaceIdOf(api, 'History space');
    const workbookId = await budget(api, workspaceId);
    const before = await versionsOf(api, workbookId);
    expect(before).toHaveLength(3);
    const oldest = before[2];

    await page.goto('/#/workbooks');
    await page.getByRole('button', { name: 'Version history: Budget' }).click();
    const dialog = page.getByRole('dialog', { name: 'Versions of Budget' });
    const rows = dialog.locator('[data-version]');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('Current');
    await expect(rows.first()).toContainText('Keeper');
    await expect(rows.nth(2)).not.toContainText('Current');
    // The current version is not offered for a restore; the older ones are.
    await expect(rows.first().getByRole('button', { name: /^Restore/ })).toHaveCount(0);
    await expect(rows.nth(2).getByRole('button', { name: /^Restore/ })).toHaveCount(1);

    // The oldest, read-only in the embed: its own cells, by its own signed URL.
    const content = page.waitForResponse((r) =>
      r.url().endsWith(`/workbooks/${workbookId}/versions/${oldest.id}/content`),
    );
    await rows.nth(2).getByRole('button', { name: 'Show' }).click();
    expect((await content).status()).toBe(200);
    const frame = dialog.frameLocator('.cgw-workbook-frame iframe');
    await expect(frame.locator('body')).toContainText('1200', { timeout: 30000 });
    await expect(frame.locator('body')).not.toContainText('1400');
    await expect(dialog.locator('.cgw-workbook-frame')).toHaveAttribute('data-shown', /.*/);

    // Restored, after asking: a new newest version with the oldest's bytes, saved by the editor.
    await rows
      .nth(2)
      .getByRole('button', { name: /^Restore the version of/ })
      .click();
    await dialog.getByRole('button', { name: 'Restore it' }).click();
    await expect(dialog.getByTestId('workbook-history-message')).toContainText(
      'is the newest version now',
    );
    await expect(rows).toHaveCount(4);
    const after = await versionsOf(api, workbookId);
    expect(after).toHaveLength(4);
    expect(after[0]).toMatchObject({ current: true, sha256: oldest.sha256 });
    expect(after[0].savedBy?.name).toBe('Keeper');
    // No version was lost.
    expect(after.slice(1).map((v) => v.id)).toEqual(before.map((v) => v.id));
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test('a reader sees the history but is offered no restore, and the server refuses theirs', async ({
  page,
}) => {
  test.skip(desktop, 'A second person is a browser profile of its own');
  const browser = page.context().browser()!;
  test.setTimeout(240000);
  const owner = await newAccount('Owner of books');
  await signedInWorkspace(page, owner, 'Readers space', null, cloud.signer);
  const api = await sessionOf(owner);
  const reader = await newAccount('Book reader');
  let readerApi: Api | null = null;
  try {
    const workspaceId = await workspaceIdOf(api, 'Readers space');
    const workbookId = await budget(api, workspaceId);
    readerApi = await invite(api, workspaceId, reader);
    const readerId = (
      (await readerApi.get('/api/v1/account/session')) as { account: { id: string } }
    ).account.id;
    await api.put(`/api/v1/workbooks/${workbookId}/permissions`, {
      restricted: true,
      entries: [{ principalType: 'user', principalId: readerId, level: 'view' }],
    });

    const other = await browser.newContext();
    const there = await other.newPage();
    const errors = watchAppErrors(there);
    await there.goto('/');
    await signIn(there, reader);
    await signedIn(there, reader);
    await there.goto('/#/workbooks');
    const row = there.locator(`[data-workbook="${workbookId}"]`);
    await expect(row).toContainText('Can view', { timeout: 30000 });
    await row.getByRole('button', { name: 'Version history: Budget' }).click();
    const dialog = there.getByRole('dialog', { name: 'Versions of Budget' });
    await expect(dialog.locator('[data-version]')).toHaveCount(3);
    await expect(dialog.getByRole('button', { name: /^Restore/ })).toHaveCount(0);
    await expect(dialog.getByTestId('workbook-history-reader')).toHaveText(
      'Only people who can edit the workbook can restore a version.',
    );
    // A reader may still look at an older version.
    await dialog.locator('[data-version]').nth(1).getByRole('button', { name: 'Show' }).click();
    await expect(dialog.frameLocator('.cgw-workbook-frame iframe').locator('body')).toContainText(
      '1300',
      { timeout: 30000 },
    );
    await other.close();
    expect(errors).toEqual([]);

    // The server refuses a reader's restore, whatever the page offers.
    const [, older] = await versionsOf(readerApi, workbookId);
    await expect(
      readerApi.post(`/api/v1/workbooks/${workbookId}/versions/${older.id}/restore`),
    ).rejects.toThrow(/403/);
    expect(await versionsOf(api, workbookId)).toHaveLength(3);
  } finally {
    await readerApi?.dispose();
    await api.dispose();
  }
});
