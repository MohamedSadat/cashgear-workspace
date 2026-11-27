// Settings in tabs (after 0.19.0): each tab at its own address, `#/settings/{tab}`.
import { expect, type Page } from '@playwright/test';

export type SettingsTab =
  'general' | 'account' | 'members' | 'ai' | 'publishing' | 'integrations' | 'data';

/** Settings' tab list (the library's tabs name it). */
export const settingsTabs = (page: Page) => page.getByRole('tab');

/**
 * Every tab Settings lists now, opened one by one by a click, each handed to `check` once its
 * panel shows: what a walk of the whole screen (Axe, the Arabic check) covers.
 */
export async function everySettingsTab(page: Page, check: (tab: string) => Promise<void>) {
  await page.goto('/#/settings');
  await expect(page.locator('#cgw-settings-title')).toBeVisible();
  await expect(settingsTabs(page).first()).toBeVisible();
  const names = await settingsTabs(page).allTextContents();
  expect(names.length).toBeGreaterThan(1);
  for (const name of names) {
    const tab = settingsTabs(page).filter({ hasText: name });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toBeVisible();
    await check(name);
  }
}
