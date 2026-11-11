import { expect, test, type Page } from '@playwright/test';

// The scaffold's smoke test: the page renders a CashGear control in light, dark, English and
// Arabic, and nothing on it is cross-origin isolated (Workspace sends no COEP).

/** The colour of the checked radio's mark, which the CashGear theme tokens decide. */
const controlColour = (page: Page) =>
  page
    .getByRole('radio', { checked: true })
    .first()
    .evaluate(
      (input) =>
        getComputedStyle(input).accentColor + ' ' + getComputedStyle(document.body).backgroundColor,
    );

test('renders a CashGear control in both themes and both languages', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Cash Gear Workspace');
  await expect(page.getByTestId('host-info')).toHaveText(/^Web \d+\.\d+\.\d+$/);
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-cg-theme', 'light');
  await expect(html).toHaveAttribute('dir', 'ltr');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);

  const theme = page.getByRole('group', { name: 'Theme' });
  await expect(theme).toBeVisible();
  const light = await controlColour(page);

  await theme.getByRole('radio', { name: 'Dark' }).check();
  await expect(html).toHaveAttribute('data-cg-theme', 'dark');
  const dark = await controlColour(page);
  expect(dark).not.toBe(light);

  await page
    .getByRole('group', { name: 'Language' })
    .getByRole('radio', { name: 'العربية' })
    .check();
  await expect(html).toHaveAttribute('dir', 'rtl');
  await expect(html).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('مساحة عمل كاش جير');
  await expect(page.getByRole('group', { name: 'المظهر' })).toBeVisible();
  // In Arabic the theme group starts at the right edge of the page.
  const box = await page.getByRole('group', { name: 'المظهر' }).boundingBox();
  const width = page.viewportSize()!.width;
  expect(box && box.x + box.width > width / 2).toBe(true);

  await page.getByRole('group', { name: 'المظهر' }).getByRole('radio', { name: 'فاتح' }).check();
  await expect(html).toHaveAttribute('data-cg-theme', 'light');
  expect(errors).toEqual([]);
});
