import { expect, type Locator, type Page } from '@playwright/test';

/** Fails a test on any page error or console error, unless the test expects it. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

/** A new workspace on a fresh profile; returns on the first Getting started page. */
export async function createWorkspace(page: Page, name = 'Test workspace') {
  await page.goto('/');
  await page.getByLabel('Workspace name').fill(name);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.locator('.cgw-editor')).toBeVisible();
  await expect(page.getByLabel('Page title')).toHaveValue('Getting started');
}

/** A new empty page in the first section, opened, with the caret in its body. */
export async function newPage(page: Page, title = 'Scratch') {
  await page
    .getByRole('button', { name: /^Add a page in/ })
    .first()
    .click();
  await expect(page.getByLabel('Page title')).toHaveValue('');
  await page.getByLabel('Page title').fill(title);
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeFocused();
}

export const editor = (page: Page): Locator => page.locator('.cgw-page .cgw-editor');

/** Each top-level block's id and text, in order. */
export async function blocks(
  page: Page,
): Promise<{ id: string; text: string; kind: string | null }[]> {
  return editor(page).evaluate((root) =>
    [...root.querySelectorAll(':scope [data-block]')].map((block) => ({
      id: block.getAttribute('data-block-id') ?? '',
      text: block.querySelector(':scope > .cgw-body')?.textContent ?? '',
      kind: block.querySelector(':scope > .cgw-body')?.getAttribute('data-kind') ?? null,
    })),
  );
}

export async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText(/Saved|تم الحفظ/);
}
