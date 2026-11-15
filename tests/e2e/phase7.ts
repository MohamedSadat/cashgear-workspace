// Phase 7's screens for the accessibility and Arabic specs: a workspace kept on an account, linked
// to the mock ERP and with AI on (the mock provider's key), a database, and a page holding a
// chart over it and an ERP view of Vendors. Made in English; each spec then sets its language and
// theme, loads the app again and walks the screens through `phase7Screens`.
import type { Browser, Locator, Page } from '@playwright/test';
import { expect } from './fixtures';
import { editor, newPage, waitSaved } from './helpers';
import { newAccount, syncStatus } from './cloud';
import { newDatabase, signedInWorkspace } from './database';
import {
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
import { aiAr, aiEn } from '../../packages/shell/src/ai/i18n';

const MOCK_AI = process.env.CGW_MOCK_AI_URL ?? 'http://127.0.0.1:4286';
export const mockAi = {
  reset: async () => void (await fetch(`${MOCK_AI}/__mock/reset`, { method: 'POST' })),
};
const KEY = 'sk-mock-phase7-screens-key-0001';

export const pluginBlocks = (page: Page) => editor(page).locator('[data-body="pluginBlock"]');

export interface Phase7Scene {
  api: Api;
  workspaceId: string;
  names: string[];
}

/** The scene, made in English; the page left open. */
export async function phase7Scene(
  page: Page,
  name: string,
  signer: () => Promise<Browser>,
): Promise<Phase7Scene> {
  await mockErp.reset();
  await mockAi.reset();
  const account = await newAccount(name);
  const space = `${name} space`;
  await signedInWorkspace(page, account, space, null, signer);
  const api = await sessionOf(account);
  const workspaceId = await workspaceIdOf(api, space);
  await linkWorkspace(api, workspaceId, space);
  await api.put(`/api/v1/workspaces/${workspaceId}/ai-settings`, { apiKey: KEY });
  await api.put(`/api/v1/workspaces/${workspaceId}/ai-settings`, { enabled: true });
  await newDatabase(page, 'Tasks', { title: 'Tasks' });
  await newPage(page, `${name} page`);
  await page.keyboard.type('The quarterly review covers suppliers and costs.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/Chart');
  await expect(page.getByRole('option', { name: 'Chart', exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  const chart = pluginBlocks(page).first();
  await chart.getByRole('button', { name: 'Choose a database' }).click();
  const pick = page.getByRole('dialog', { name: 'Choose a database' });
  await pick.getByRole('option', { name: /Tasks/ }).first().click();
  await expect(pick).toHaveCount(0);
  await chart.getByRole('button', { name: 'Settings' }).click();
  await chart.getByLabel('Group by').selectOption({ label: 'Status' });
  await chart.getByRole('button', { name: 'Done', expanded: true }).click();
  await expect(chart.locator('[data-testid="chart-canvas"]')).toBeVisible();
  await editor(page).getByText('The quarterly review covers suppliers and costs.').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await insertErpBlock(page);
  // Vendors chosen once: the block keeps it, and each load only connects again.
  const block = erpBlock(page);
  await connectErp(page, block, 'gina');
  await block.locator('[data-connector="vendors"]').click();
  await expect(block.getByTestId('erp-table')).toBeVisible({ timeout: 30000 });
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  return {
    api,
    workspaceId,
    names: [account.name, account.email, space, 'Tasks', 'Kit Trading', 'Gina Wahba'],
  };
}

/**
 * The scene's Phase 7 screens in the app's language now, each handed to `check` once drawn: the
 * chart; the ERP block editing a vendor, then its review; the AI panel with a proposal; Settings'
 * AI section.
 */
export async function phase7Screens(
  page: Page,
  language: 'en' | 'ar',
  check: (screen: string) => Promise<void>,
) {
  const erp = (language === 'ar' ? erpAr : erpEn).erp;
  const ai = language === 'ar' ? aiAr.ai : aiEn.ai;
  const chart = pluginBlocks(page).first();
  await expect(chart.locator('[data-testid="chart-canvas"]')).toBeVisible({ timeout: 30000 });
  await check('chart block');

  const block: Locator = erpBlock(page);
  await connectErp(page, block, 'gina');
  await expect(block.getByTestId('erp-table')).toBeVisible({ timeout: 30000 });
  await block.getByRole('button', { name: erp.editData, exact: true }).click();
  const cell = block
    .getByTestId('erp-table')
    .locator('tr[data-key="V-1001"] td[data-field="address"]');
  await cell.getByRole('button').click();
  const input = cell.getByRole('textbox');
  await input.fill('14 Corniche Rd');
  await input.press('Enter');
  await expect(cell).toHaveAttribute('data-changed', 'person');
  await check('ERP block editing');
  await block.getByRole('button', { name: erp.reviewChanges, exact: true }).click();
  await expect(block.getByTestId('erp-review')).toHaveAttribute('data-phase', 'reviewed', {
    timeout: 30000,
  });
  await check('ERP review');
  await block.getByRole('button', { name: erp.backToEditing, exact: true }).click();
  await block.getByRole('button', { name: erp.discardChanges, exact: true }).click();
  await expect(block.getByTestId('erp-change-count')).toHaveText(erp.noChanges);

  await page
    .getByRole('region', { name: language === 'ar' ? 'الصفحة' : 'Page' })
    .getByRole('button', { name: language === 'ar' ? 'إجراءات الصفحة' : 'Page actions' })
    .click();
  await page.getByRole('menuitem', { name: ai.open }).click();
  const panel = page.getByTestId('ai-panel');
  await panel.getByRole('radio', { name: ai.summarise }).check();
  await panel.getByRole('button', { name: ai.run, exact: true }).click();
  await expect(panel.getByRole('button', { name: ai.insertTop })).toBeVisible({ timeout: 30000 });
  await check('AI panel with a proposal');
  await panel.getByRole('button', { name: ai.discard, exact: true }).click();

  await page.goto('/#/settings');
  await expect(page.getByTestId('ai-settings').getByTestId('ai-key-state')).toBeVisible({
    timeout: 30000,
  });
  await check('AI settings');
}
