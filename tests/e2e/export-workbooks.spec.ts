// Phase 9, M9.3: workbooks travel in the workspace's export (format version 3). A synced
// workspace's export holds each workbook its exporter may read (its newest version as
// `workbooks/<name>.xlsx`); imported while signed in, it becomes a new synced workspace whose
// workbooks are made again in the account, every sheet block pointed at its new workbook;
// imported signed out, it stays on the device and says it skipped them. Against the e2e server
// stack and the mock Sheet, in Chrome and Edge.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, desktop } from './fixtures';
import { editor, newPage, waitSaved } from './helpers';
import { newAccount, syncStatus } from './cloud';
import { signedInWorkspace, signers, tree } from './database';
import {
  REAL_SHEET,
  blockAttrs,
  expectLive,
  insertExistingWorkbook,
  mockSheet,
  newWorkbook,
  sessionOf,
  sheetBlock,
  watchAppErrors,
  workbookOf,
  workspaceIdOf,
  type Api,
} from './ecosystem';

test.skip(desktop, 'The browser downloads and picks the file: the browsers run this');

const cloud = signers();
test.afterEach(async () => {
  await cloud.close();
});
test.beforeEach(async () => {
  if (!REAL_SHEET) await mockSheet.reset();
});

interface Listed {
  id: string;
  name: string;
  versionId: string | null;
}

const workbooksOf = async (api: Api, workspaceId: string) =>
  ((await api.get(`/api/v1/workspaces/${workspaceId}/workbooks`)) as { workbooks: Listed[] })
    .workbooks;

/** Settings → Your data → Export workspace, saved where the test can read it. */
async function exportWorkspace(page: Page, path: string) {
  await page.goto('/#/settings');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export workspace' }).click();
  await (await download).saveAs(path);
  return readFileSync(path);
}

/** Settings → Your data → Import an export, of this file. */
async function importExport(page: Page, path: string) {
  await page.goto('/#/settings');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import an export' }).click();
  await (await chooser).setFiles(path);
}

test('a workspace exported with its workbooks imports into a new synced workspace with them', async ({
  page,
}, testInfo) => {
  test.setTimeout(300000);
  const errors = watchAppErrors(page);
  const owner = await newAccount('Exporter');
  await signedInWorkspace(page, owner, 'Export space', null, cloud.signer);
  const api = await sessionOf(owner);
  try {
    const workspaceId = await workspaceIdOf(api, 'Export space');
    const original = await newWorkbook(
      api,
      workspaceId,
      'Budget',
      workbookOf([
        ['Item', 'Q1'],
        ['Rent', 1200],
      ]),
    );
    await newPage(page, 'Figures');
    await page.keyboard.type('The budget:');
    await page.keyboard.press('Enter');
    await insertExistingWorkbook(page, 'Budget');
    await expectLive(sheetBlock(page), '1200');
    await waitSaved(page);
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });

    // The export holds the workbook's newest version beside the pages, and says so.
    const path = testInfo.outputPath('with-workbooks.zip');
    const zip = await exportWorkspace(page, path);
    await expect(page.getByTestId('data-message')).toHaveText(
      'Exported. Workbooks in the export: 1.',
    );
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    // A zip's names are stored as written: the workbook's file and the manifest are in it.
    expect(zip.includes(Buffer.from('workbooks/Budget.xlsx'))).toBe(true);
    expect(zip.includes(Buffer.from('cgw-export.json'))).toBe(true);

    // Imported while signed in: a new workspace in the account, its workbook made again there.
    await importExport(page, path);
    await expect(page.getByTestId('data-message')).toContainText(
      'Imported as a new workspace in your account.',
      { timeout: 60000 },
    );
    await expect(page.getByTestId('data-message')).toContainText('Workbooks made again: 1.');
    await expect(page.getByRole('button', { name: /Export space \(imported\)/ })).toBeVisible();
    await expect(syncStatus(page)).toHaveText('Synced', { timeout: 60000 });
    const imported = await workspaceIdOf(api, 'Export space (imported)');
    const made = await workbooksOf(api, imported);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ name: 'Budget' });
    expect(made[0].id).not.toBe(original);
    expect(made[0].versionId).not.toBeNull();

    // The imported page's block shows the new workbook, live.
    await tree(page)
      .getByRole('treeitem', { name: /Figures/ })
      .first()
      .click();
    await expect(editor(page)).toContainText('The budget:');
    expect(await blockAttrs(page, 'sheetEmbed')).toEqual([
      expect.objectContaining({ workbookId: made[0].id }),
    ]);
    await expectLive(sheetBlock(page), '1200');
    // The original is untouched in its own workspace.
    expect((await workbooksOf(api, workspaceId)).map((w) => w.id)).toEqual([original]);

    // Imported signed out: on this device, its blocks as they were, the workbook skipped.
    await page.goto('/#/settings');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in to sync' }).first()).toBeVisible();
    await importExport(page, path);
    await expect(page.getByTestId('data-message')).toContainText('Imported as a new workspace.', {
      timeout: 60000,
    });
    await expect(page.getByTestId('data-message')).toContainText(
      'Workbooks not imported, since they live in an account: 1.',
    );
    await tree(page)
      .getByRole('treeitem', { name: /Figures/ })
      .first()
      .click();
    await expect(editor(page)).toContainText('The budget:');
    expect(await blockAttrs(page, 'sheetEmbed')).toEqual([
      expect.objectContaining({ workbookId: original }),
    ]);
    expect(errors).toEqual([]);
  } finally {
    await api.dispose();
  }
});
