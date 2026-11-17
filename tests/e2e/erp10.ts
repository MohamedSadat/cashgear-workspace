// Phase 10's ERP screens for the accessibility and Arabic specs: a workspace kept on an account,
// linked to the mock ERP, and a page holding an ERP view of Items on hand connected as faris (the
// Items unit's Edit). Made in English; each spec then sets its language and theme, loads the app
// again and walks the screens through `erp10Screens`: a shared field's editor with its note, every
// row of the item changed, the review listing each row, and a conflict that needs no choice.
import type { Browser, Locator, Page } from '@playwright/test';
import { expect } from './fixtures';
import { newPage, waitSaved } from './helpers';
import { newAccount, syncStatus } from './cloud';
import { signedInWorkspace } from './database';
import {
  ERP_API,
  chooseConnector,
  connectErp,
  erpBlock,
  insertErpBlock,
  linkWorkspace,
  mockErp,
  sessionOf,
  workspaceIdOf,
  type Api,
} from './ecosystem';
import { ar as erpAr, en as erpEn } from '../../packages/erp/src/i18n/catalogues';

export interface Erp10Scene {
  api: Api;
  workspaceId: string;
  names: string[];
}

/** The scene, made in English; the page left open. */
export async function erp10Scene(
  page: Page,
  name: string,
  signer: () => Promise<Browser>,
): Promise<Erp10Scene> {
  await mockErp.reset();
  const account = await newAccount(name);
  const space = `${name} space`;
  await signedInWorkspace(page, account, space, null, signer);
  const api = await sessionOf(account);
  const workspaceId = await workspaceIdOf(api, space);
  await linkWorkspace(api, workspaceId, space);
  await newPage(page, `${name} page`);
  await page.keyboard.type('Stock names to tidy.');
  await page.keyboard.press('Enter');
  await insertErpBlock(page);
  const block = erpBlock(page);
  await connectErp(page, block, 'faris');
  await chooseConnector(block, 'Items on hand');
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  return {
    api,
    workspaceId,
    names: [account.name, account.email, space, 'Kit Trading', 'فارس منير'],
  };
}

/** What the ERP block shows as its own data: for the Arabic walk, theirs. */
export const ERP10_THEIRS = [
  '.cgw-erp-table tbody',
  '.cgw-erp-review-table tbody',
  '.cgw-erp-conflict legend > span[dir="auto"]',
  '.cgw-erp-conflict tbody td',
];

/** The item's rows in the block's table. */
const itemRows = (block: Locator) =>
  block.getByTestId('erp-table').locator('tr[data-key="ITM-0001"]');

/** The scene's Phase 10 ERP screens in the app's language now, each handed to `check` once drawn. */
export async function erp10Screens(
  page: Page,
  language: 'en' | 'ar',
  check: (screen: string) => Promise<void>,
) {
  const erp = (language === 'ar' ? erpAr : erpEn).erp;
  const block = erpBlock(page);
  await connectErp(page, block, 'faris');
  await expect(block.getByTestId('erp-table')).toBeVisible({ timeout: 30000 });
  await block.getByRole('button', { name: erp.editData, exact: true }).click();
  const rows = itemRows(block);
  const cell = rows.nth(1).locator('td[data-field="itemName"]');
  await cell.getByRole('button').click();
  await expect(cell.locator('.cgw-erp-shared')).toBeVisible();
  await check('Items on hand, a shared field’s editor');
  const input = cell.getByRole('textbox');
  await input.fill('Qorvath olive oil, one litre');
  await input.press('Enter');
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    await expect(rows.nth(i).locator('td[data-field="itemName"]')).toHaveAttribute(
      'data-changed',
      'person',
    );
  }
  await check('Items on hand, every row of the item changed');
  await block.getByRole('button', { name: erp.reviewChanges, exact: true }).click();
  const review = block.getByTestId('erp-review');
  await expect(review).toHaveAttribute('data-phase', 'reviewed', { timeout: 30000 });
  await check('Items on hand, the review of each row');
  // A posting moves one row's stock meanwhile (by one more each walk): a conflict that needs no
  // choice.
  const state = await mockErp.state();
  const moved = state.records.itemsOnHand!.filter(
    (r) => r.company === 'Kit' && r.key === 'ITM-0001',
  )[1]!;
  const edited = await fetch(`${ERP_API}/__mock/edit-record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      connector: 'itemsOnHand',
      company: 'Kit',
      id: moved.id,
      values: { onHandQty: (Number(moved.values.onHandQty) + 1).toFixed(3) },
    }),
  });
  expect(edited.status).toBeLessThan(300);
  await review
    .getByRole('button', { name: erp.commitChanges.replace('{{count}}', String(count)) })
    .click();
  const conflicts = block.getByTestId('erp-conflicts');
  await expect(conflicts.getByTestId('erp-conflict-other')).toBeVisible({ timeout: 30000 });
  await check('Items on hand, a conflict with no field to choose');
  await conflicts.getByRole('button', { name: erp.takeAllTheirs, exact: true }).click();
  await expect(block.getByTestId('erp-change-count')).toHaveText(erp.noChanges);
}
