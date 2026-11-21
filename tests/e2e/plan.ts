// A shared scene for Phase 13's screens in the Axe and Arabic specs: a synced workspace whose AI is
// on Cash Gear's subscription and whose search by meaning is made on this server (the e2e stack has
// both: scripts/server-stack.mjs), and a plugin with a network: added with its host allowed, then
// updated to a version naming a second host, which waits. Made in English; each spec then sets its
// language and theme and walks the screens through `planScreens`.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Browser, Page } from '@playwright/test';
import { expect } from './fixtures';
import { newAccount } from './cloud';
import { signedInWorkspace } from './database';
import { writePluginBundles } from '../fixtures/plugins/make.mjs';

const BUNDLES = writePluginBundles(mkdtempSync(`${tmpdir()}/cgw-scene-plan-`));

export interface PlanScene {
  /** Names that are the person's or the plugin author's (allowed in the Arabic check). */
  names: string[];
}

const settings = (page: Page) => page.getByTestId('plugins-settings');

/** Settings → Plugins: a bundle up to its review dialog (an add, or a row's update). */
async function review(page: Page, path: string, updateOf?: RegExp) {
  await expect(settings(page)).toBeVisible({ timeout: 30000 });
  const chooser = page.waitForEvent('filechooser');
  if (updateOf) await settings(page).getByRole('button', { name: updateOf }).click();
  else await settings(page).getByTestId('plugins-add').click();
  await (await chooser).setFiles(path);
  await expect(page.getByTestId('plugins-review')).toBeVisible({ timeout: 30000 });
}

export async function planScene(
  page: Page,
  name: string,
  signer: () => Promise<Browser>,
): Promise<PlanScene> {
  const account = await newAccount(name);
  const space = `${name} space`;
  await signedInWorkspace(page, account, space, null, signer);
  await page.goto('/#/settings');
  const ai = page.getByTestId('ai-settings');
  await ai
    .getByTestId('ai-key-source')
    .getByRole('radio', { name: 'Cash Gear’s subscription', exact: true })
    .check();
  await expect(ai.getByTestId('ai-allowance')).toBeVisible({ timeout: 30000 });
  await ai.getByRole('checkbox', { name: 'Turn AI on for this workspace' }).check();
  await expect(ai.getByRole('checkbox', { name: 'Turn AI on for this workspace' })).toBeChecked();
  const embeddings = page.getByTestId('embeddings-settings');
  await embeddings.getByRole('radio', { name: 'On this server (voyage-4-nano)' }).check();
  await expect(embeddings.getByTestId('embeddings-local')).toBeVisible({ timeout: 30000 });
  const on = embeddings.getByRole('checkbox', {
    name: 'Turn search by meaning on for this workspace',
  });
  await on.check();
  await expect(on).toBeChecked({ timeout: 30000 });

  await review(page, BUNDLES.network);
  await page.getByTestId('plugins-confirm').click();
  await expect(settings(page).getByTestId('plugins-list')).toContainText('Ping', {
    timeout: 30000,
  });
  await review(page, BUNDLES.networkV2, /^Update Ping/);
  await page.getByTestId('plugins-confirm').click();
  await expect(settings(page).locator('[data-hosts="waiting"]')).toBeVisible({ timeout: 30000 });
  return {
    names: [
      account.name,
      account.email,
      space,
      'Ping',
      'تنبيه',
      'vendor.ping',
      'localhost:4288',
      '127.0.0.1:4288',
    ],
  };
}

/**
 * The scene's Phase 13 screens in the app's language now, each handed to `check` once drawn:
 * Settings (AI on the subscription with its month's use, search by meaning on this server, a
 * plugin's hosts, one waiting), a plugin update's review naming a new host, and the dialog that
 * allows a plugin's hosts.
 */
export async function planScreens(
  page: Page,
  language: 'en' | 'ar',
  check: (screen: string) => Promise<void>,
) {
  const cancel = language === 'ar' ? 'إلغاء' : 'Cancel';
  await page.goto('/#/settings');
  await expect(page.getByTestId('ai-allowance')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('embeddings-local')).toBeVisible({ timeout: 30000 });
  await expect(settings(page).locator('[data-hosts="waiting"]')).toBeVisible({ timeout: 30000 });
  await check('settings: the subscription, this server’s model, a plugin’s hosts');

  // The plugin's own name in the app's language (its manifest names it in both).
  await review(page, BUNDLES.networkV2, language === 'ar' ? /^تحديث تنبيه/ : /^Update Ping/);
  await check('a plugin update naming a new host');
  await page
    .getByTestId('plugins-review')
    .locator('..')
    .getByRole('button', { name: cancel })
    .click();
  await expect(page.getByTestId('plugins-review')).toHaveCount(0);

  await settings(page).getByTestId('plugin-allow').click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await check('allowing a plugin’s hosts');
  await page.getByRole('alertdialog').getByRole('button', { name: cancel }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
}
