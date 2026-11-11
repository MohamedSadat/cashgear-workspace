import { expect, test, type Page } from '@playwright/test';

// The shell's smoke test: the frame renders with CashGear controls in light, dark, English and
// Arabic; the sidebar collapses and comes back; the page is not cross-origin isolated (Workspace
// sends no COEP); nothing logs an error.

const background = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('renders the frame in both themes and both languages', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/#/settings');

  const html = page.locator('html');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.getByTestId('host-info')).toHaveText(/^Web Version \d+\.\d+\.\d+$/);
  await expect(html).toHaveAttribute('data-cg-theme', 'light');
  await expect(html).toHaveAttribute('dir', 'ltr');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();

  const light = await background(page);
  await page.getByRole('group', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).check();
  await expect(html).toHaveAttribute('data-cg-theme', 'dark');
  expect(await background(page)).not.toBe(light);

  await page
    .getByRole('group', { name: 'Language' })
    .getByRole('radio', { name: 'العربية' })
    .check();
  await expect(html).toHaveAttribute('dir', 'rtl');
  await expect(html).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('heading', { level: 1, name: 'الإعدادات' })).toBeVisible();
  // In Arabic the sidebar is on the right.
  const sidebar = await page.getByRole('navigation', { name: 'الشريط الجانبي' }).boundingBox();
  expect(sidebar && sidebar.x > page.viewportSize()!.width / 2).toBe(true);

  // Ctrl+\ hides the sidebar and shows it again; the shortcut goes by key position.
  await page.keyboard.press('Control+Backslash');
  await expect(page.getByRole('button', { name: 'إظهار الشريط الجانبي' })).toBeVisible();
  await page.getByRole('button', { name: 'إظهار الشريط الجانبي' }).click();
  await expect(page.getByRole('navigation', { name: 'الشريط الجانبي' })).toBeVisible();

  await page.getByRole('group', { name: 'المظهر' }).getByRole('radio', { name: 'فاتح' }).check();
  await expect(html).toHaveAttribute('data-cg-theme', 'light');
  await page.getByRole('group', { name: 'اللغة' }).getByRole('radio', { name: 'English' }).check();
  await expect(html).toHaveAttribute('dir', 'ltr');
  expect(errors).toEqual([]);
});
