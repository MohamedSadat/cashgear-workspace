// A shared scene for the Phase 10 plugin screens in the Axe and Arabic specs: a synced workspace
// with the reference plugin installed, a database, and a page holding a plugin block granted that
// database's view. Made in English; each spec then sets its language and theme and walks the
// screens through `pluginScreens`. The preview must be a web build made with
// VITE_CGW_PLUGINS=http://localhost:5291 (tests/e2e/README.md), as plugins-frame.spec.ts needs.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Page } from '@playwright/test';
import { expect } from './fixtures';
import { editor, newPage, waitSaved } from './helpers';
import { newAccount, signIn, signedIn, syncStatus } from './cloud';
import { apiSession } from '../../scripts/cloud-account.mjs';
import { newDatabase } from './database';
import { writePluginBundles } from '../fixtures/plugins/make.mjs';

const BUNDLE = writePluginBundles(mkdtempSync(`${tmpdir()}/cgw-scene-plugins-`)).reference;

export interface PluginScene {
  api: Awaited<ReturnType<typeof apiSession>>;
  workspaceId: string;
  /** Names that are the person's or the plugin author's (allowed in the Arabic check). */
  names: string[];
}

const pluginBlock = (page: Page) => editor(page).locator('[data-body="pluginBlock"]');

/** Installs the reference plugin, makes a database and a page with a plugin block showing it. */
export async function pluginScene(page: Page, name: string): Promise<PluginScene> {
  const account = await newAccount(name);
  const space = `${name} space`;
  await page.goto('/');
  await signIn(page, account);
  await signedIn(page, account);
  await page.getByLabel('Workspace name').fill(space);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(editor(page)).toBeVisible();
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  const api = await apiSession(account);
  const workspaceId = (
    (await api.get('/api/v1/workspaces')) as { id: string; name: string }[]
  ).find((w) => w.name === space)!.id;

  await page.goto('/#/settings/integrations');
  const section = page.getByTestId('plugins-settings');
  await expect(section).toBeVisible({ timeout: 30000 });
  const chooser = page.waitForEvent('filechooser');
  await section.getByTestId('plugins-add').click();
  await (await chooser).setFiles(BUNDLE);
  await expect(page.getByTestId('plugins-review')).toBeVisible({ timeout: 30000 });
  await page.getByTestId('plugins-confirm').click();
  await expect(section.getByTestId('plugins-list')).toContainText('Notes', { timeout: 30000 });

  await newDatabase(page, 'Tasks', { title: 'Tasks' });
  await newPage(page, `${name} page`);
  await page.keyboard.type('A page for the plugin.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/Notes');
  await expect(page.getByRole('option', { name: 'Notes', exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(pluginBlock(page)).toHaveCount(1);
  await pluginBlock(page).getByRole('button', { name: 'Choose a database' }).click();
  const pick = page.getByRole('dialog', { name: 'Choose a database' });
  await pick.getByRole('option', { name: /Tasks/ }).first().click();
  await expect(pick).toHaveCount(0);
  await expect(page.frameLocator('[data-body="pluginBlock"] iframe').locator('#status')).toHaveText(
    'Ready',
    { timeout: 30000 },
  );
  await waitSaved(page);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  return { api, workspaceId, names: [account.name, account.email, space, 'Tasks', 'Notes'] };
}

const BAR = { en: 'Rows from Tasks', ar: 'الصفوف من Tasks' };

/**
 * The scene's Phase 10 screens in the app's language now, each handed to `check` once drawn: the
 * plugin block's bar on the page, and Settings → Plugins (the list, and the review dialog of an
 * Add). The plugin's frame is a sandbox of another origin: its own contents are the author's, not
 * walked here.
 */
export async function pluginScreens(
  page: Page,
  language: 'en' | 'ar',
  check: (screen: string) => Promise<void>,
) {
  await expect(pluginBlock(page).locator('.cgw-plugin-frame-bar')).toContainText(BAR[language], {
    timeout: 30000,
  });
  await check('plugin block');
  await page.goto('/#/settings/integrations');
  const section = page.getByTestId('plugins-settings');
  await expect(section.getByTestId('plugins-list')).toBeVisible({ timeout: 30000 });
  await check('plugins settings');
  const chooser = page.waitForEvent('filechooser');
  await section.getByTestId('plugins-add').click();
  await (await chooser).setFiles(BUNDLE);
  await expect(page.getByTestId('plugins-review')).toBeVisible({ timeout: 30000 });
  await check('plugins review');
  // Close the dialog by its Close button (a view that swaps its focused button leaves focus on
  // body, so Escape would not reach it: Phase 9's gotcha).
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: language === 'ar' ? 'إلغاء' : 'Cancel' }).click();
  await expect(page.getByTestId('plugins-review')).toHaveCount(0);
}
