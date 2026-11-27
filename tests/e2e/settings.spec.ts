import { expect, test } from './fixtures';
import { createWorkspace, newPage, waitSaved, watchErrors } from './helpers';
import { settingsTabs } from './settings';

// After 0.19.0 (DECISIONS.md, 2026-11-27): Settings in tabs, each at its own address, and the
// sidebar's Recent pages shown or hidden on this device.

test.describe('Settings in tabs', () => {
  test('each tab has its own address, Back returns to the last, an unknown one opens General', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await createWorkspace(page);
    await page.goto('/#/settings');
    // A workspace on this device only, signed out: General, Account (its sign-in) and Data.
    await expect(settingsTabs(page)).toHaveText(['General', 'Account', 'Data']);
    await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      page.getByRole('tabpanel').getByRole('heading', { name: 'Appearance' }),
    ).toBeVisible();

    await page.getByRole('tab', { name: 'Data' }).click();
    await expect(page).toHaveURL(/#\/settings\/data$/);
    await expect(
      page.getByRole('tabpanel').getByRole('heading', { name: 'Your data' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Appearance' })).toHaveCount(0);

    await page.goBack();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // An address opens its tab at once; one Settings does not have, or does not list here, opens
    // General.
    await page.goto('/#/settings/data');
    await expect(page.getByRole('tab', { name: 'Data' })).toHaveAttribute('aria-selected', 'true');
    for (const hash of ['#/settings/nothing', '#/settings/members']) {
      await page.goto(`/${hash}`);
      await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    }
    expect(errors).toEqual([]);
  });

  test('the tab list is on the start side, on the right in Arabic, and across the top on a phone', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await createWorkspace(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    const side = async () => {
      const list = (await page.getByRole('tab', { name: /General|عام/ }).boundingBox())!;
      const panel = (await page.getByRole('tabpanel').boundingBox())!;
      if (list.y + list.height <= panel.y + 1) return 'top';
      return list.x < panel.x ? 'left' : 'right';
    };
    await page.goto('/#/settings');
    await expect(page.getByRole('tabpanel')).toBeVisible();
    expect(await side()).toBe('left');
    await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
    await page.reload();
    await expect(page.getByRole('tabpanel')).toBeVisible();
    expect(await side()).toBe('right');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(side).toBe('top');
    expect(errors).toEqual([]);
  });
});

test.describe('Recent pages in the sidebar', () => {
  test('hidden and shown again from Settings, kept on this device', async ({ page }) => {
    const errors = watchErrors(page);
    await createWorkspace(page);
    await newPage(page, 'Visited page');
    await waitSaved(page);
    const recent = page.getByRole('region', { name: 'Recent' });
    await expect(recent.getByRole('link', { name: /Visited page/ })).toBeVisible();

    await page.goto('/#/settings');
    const choice = page.getByRole('switch', { name: 'Show recent pages in the sidebar' });
    await expect(choice).toBeChecked();
    await choice.click();
    await expect(choice).not.toBeChecked();
    await expect(recent).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole('switch', { name: 'Show recent pages in the sidebar' }),
    ).not.toBeChecked();
    await expect(page.getByRole('treeitem', { name: /Visited page/ })).toBeVisible();
    await expect(recent).toHaveCount(0);
    // Visits are still recorded: the palette lists the page as recent.
    await page.keyboard.press('Control+KeyK');
    await expect(
      page.getByRole('dialog').getByRole('option', { name: /Visited page/ }),
    ).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('switch', { name: 'Show recent pages in the sidebar' }).click();
    await expect(recent.getByRole('link', { name: /Visited page/ })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('the palette shows and hides it', async ({ page }) => {
    const errors = watchErrors(page);
    await createWorkspace(page);
    await newPage(page, 'Visited page');
    await waitSaved(page);
    const recent = page.getByRole('region', { name: 'Recent' });
    await expect(recent).toBeVisible();
    const run = async (name: string) => {
      await page.keyboard.press('Control+KeyK');
      const palette = page.getByRole('dialog');
      await palette.getByRole('combobox').fill(name);
      await palette.getByRole('option', { name }).click();
    };
    await run('Hide recent pages in the sidebar');
    await expect(recent).toHaveCount(0);
    await run('Show recent pages in the sidebar');
    await expect(recent).toBeVisible();
    expect(errors).toEqual([]);
  });
});
