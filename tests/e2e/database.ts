// Phase 4's helpers for the database specs: a database made from the sidebar, its views and
// properties driven as a person drives them (the tabs by the keys, as CgTabs takes them), values
// set on a row's page, and the cloud set-up the synced specs share (a signed-in workspace on each
// target, the network off and on, another device of the same person).
import {
  chromium,
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { desktop } from './fixtures';
import { createWorkspace, editor } from './helpers';
import { signIn, signedIn, signInDesktop, syncStatus, type TestAccount } from './cloud';

export const APP = 'http://127.0.0.1:4273';
export const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:5280';

/** A 2x2 PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDJAB4kNAEYTAgf7kJrYAAAAAElFTkSuQmCC',
  'base64',
);

/** The interface's words the helpers use, in each language. */
export const WORDS = {
  en: {
    newDatabase: 'New database',
    importCsv: 'Import a CSV file as a new database',
    create: 'Create',
  },
  ar: {
    newDatabase: 'قاعدة بيانات جديدة',
    importCsv: 'استيراد ملف CSV كقاعدة بيانات جديدة',
    create: 'أنشئ',
  },
} as const;

/** The database on its own page. */
export const fullPage = (page: Page) => page.locator('.cgw-database-page .cgw-db');
export const grid = (scope: Page | Locator) => scope.locator('[role="grid"].cgw-grid');
export const pageId = (page: Page) => new URL(page.url()).hash.match(/#\/p\/([0-9a-f-]{36})/)![1];

/**
 * A database from the first section's ▦, from a template (the radio's name: "Empty database",
 * "Tasks", …), opened on its page; with `title`, renamed.
 */
export async function newDatabase(
  page: Page,
  template: string,
  { title, language = 'en' }: { title?: string; language?: 'en' | 'ar' } = {},
) {
  const words = WORDS[language];
  const before = new URL(page.url()).hash;
  await page.locator('[data-action="new-database"]').first().click();
  await page.getByRole('menuitem', { name: words.newDatabase, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: words.newDatabase });
  await dialog.getByRole('radio', { name: new RegExp(`^${template}`) }).check();
  await dialog.getByRole('button', { name: words.create, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.waitForFunction((hash) => location.hash !== hash, before);
  await expect(fullPage(page)).toBeVisible();
  if (title) {
    await page.getByLabel(language === 'ar' ? 'عنوان الصفحة' : 'Page title').fill(title);
    await page.getByLabel(language === 'ar' ? 'عنوان الصفحة' : 'Page title').press('Enter');
  }
  return pageId(page);
}

/** Shows a view by its tab, as the keys do (a mouse click on a reorderable tab is the library's). */
export async function showView(scope: Page | Locator, name: string | RegExp) {
  const tab = scope.getByRole('tab', { name, exact: typeof name === 'string' });
  await tab.focus();
  await tab.press('Enter');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** Whether a tab is cut off by the scrolling strip that holds it. */
export const tabClipped = (tab: Locator) =>
  tab.evaluate((el) => {
    const box = el.getBoundingClientRect();
    for (let up = el.parentElement; up; up = up.parentElement) {
      if (getComputedStyle(up).overflowX === 'visible') continue;
      const strip = up.getBoundingClientRect();
      return box.left < strip.left - 1 || box.right > strip.right + 1;
    }
    return false;
  });

/** A new view of a type, from the toolbar's ＋; it is shown once made. */
export async function addView(scope: Page | Locator, page: Page, type: string) {
  await scope.getByRole('button', { name: 'Add a view' }).click();
  await page.getByRole('menuitem', { name: type, exact: true }).click();
  await expect(scope.getByRole('tab', { selected: true })).toHaveText(new RegExp(type));
}

/** A property of a type from the table header's ＋, named. */
export async function addProperty(page: Page, type: string, name: string, scope?: Locator) {
  const where = scope ?? fullPage(page);
  await where.locator('.cgw-th-add button').click();
  const menu = page.getByRole('menu', { name: 'Add a property of type…' });
  // By the keys: a menu cut off by the window's edge is checked on its own (typeMenuInView).
  await menu.getByRole('menuitem', { name: type, exact: true }).press('Enter');
  const input = page.getByRole('textbox', { name: 'Property name' });
  await input.fill(name);
  await input.press('Enter');
  await page.keyboard.press('Escape');
  await expect(where.getByRole('columnheader', { name: `${name}, ${type}` })).toBeVisible();
}

/** Whether every item of the table's "Add a property" menu can be reached in the window. */
export async function typeMenuInView(page: Page, scope?: Locator) {
  await (scope ?? fullPage(page)).locator('.cgw-th-add button').click();
  const items = page.getByRole('menu', { name: 'Add a property of type…' }).getByRole('menuitem');
  const size =
    page.viewportSize() ??
    (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  const outside: string[] = [];
  for (const item of await items.all()) {
    await item.scrollIntoViewIfNeeded();
    const box = (await item.boundingBox())!;
    if (
      box.x < 0 ||
      box.y < 0 ||
      box.x + box.width > size.width ||
      box.y + box.height > size.height
    )
      outside.push(`${await item.innerText()} at ${Math.round(box.x)},${Math.round(box.y)}`);
  }
  await page.keyboard.press('Escape');
  return outside;
}

/** Opens a property's menu from its column header. */
export async function propertyMenu(page: Page, name: string, type: string, scope?: Locator) {
  await (scope ?? fullPage(page)).getByRole('columnheader', { name: `${name}, ${type}` }).click();
  const menu = page.getByRole('dialog', { name: `Property: ${name}` });
  await expect(menu).toBeVisible();
  return menu;
}

/** Changes a property's type through its menu (a relation and a rollup are set up there). */
export async function changeType(page: Page, name: string, from: string, to: string) {
  const menu = await propertyMenu(page, name, from);
  await menu.getByRole('menuitem', { name: /^Change type/ }).click();
  await menu.getByRole('menuitemradio', { name: to, exact: true }).click();
  return menu;
}

/** A row from the table's "New" at its end, titled. */
export async function newRow(page: Page, title: string, scope?: Locator) {
  const where = scope ?? fullPage(page);
  await where.locator('.cgw-new-row').last().click();
  const input = where.locator('.cgw-inline-editor');
  await expect(input).toBeFocused();
  await input.fill(title);
  await input.press('Enter');
  await expect(rowOf(where, title)).toBeVisible();
}

/** A row of a table by its title. */
export const rowOf = (scope: Page | Locator, title: string) => {
  const page = 'keyboard' in scope ? scope : scope.page();
  return grid(scope)
    .locator('[role="row"][aria-rowindex]')
    .filter({ has: page.locator('.cgw-title-text', { hasText: new RegExp(`^${title}`) }) });
};

/** A row as any view other than the table draws it (a card, a line), by its title. */
export const cardOf = (scope: Locator, title: string) =>
  scope.locator('[data-row-id], [data-focus="row"]').filter({
    has: scope.page().locator('.cgw-card-title, .cgw-db-list-title', {
      hasText: new RegExp(`^\\s*${title}\\s*$`),
    }),
  });

/** A calendar's day cell is keyed by days since 1970-01-01 (UTC). */
export const epochDay = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** Whether a calendar draws the row titled `title` on the day `iso` (YYYY-MM-DD). */
export async function onCalendarDay(scope: Locator, title: string, iso: string) {
  const day = await scope.locator(`[data-day="${epochDay(iso)}"]`).boundingBox();
  const item = await scope
    .locator('[data-cal-item]')
    .filter({ hasText: new RegExp(`^\\s*${title}\\s*$`) })
    .first()
    .boundingBox();
  if (!day || !item) return false;
  const middle = item.x + item.width / 2;
  return (
    middle > day.x && middle < day.x + day.width && item.y > day.y && item.y < day.y + day.height
  );
}

/** Opens a row as a page from its title cell's "Open" button. */
export async function openRow(page: Page, title: string, scope?: Locator) {
  const where = scope ?? fullPage(page);
  // The button shows on the row under the pointer and on the active row.
  await rowOf(where, title).hover();
  await where.getByRole('button', { name: `Open ${title}`, exact: true }).click();
  await expect(page.locator('.cgw-row-props')).toBeVisible();
  await expect(page.getByLabel('Page title')).toHaveValue(title);
}

/** A property's value on the row's page (the button that edits it). */
export const rowValue = (page: Page, name: string) =>
  page
    .locator('.cgw-row-props .cgw-row-prop')
    .filter({
      has: page.locator('.cgw-row-prop-name [dir="auto"]', {
        hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      }),
    })
    .locator('.cgw-row-prop-value');

/** Types into a property that is edited in place (text, number, URL, email, phone). */
export async function typeValue(page: Page, name: string, text: string) {
  await rowValue(page, name).click();
  const input = page.locator('.cgw-row-props .cgw-inline-editor');
  await expect(input).toBeFocused();
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveCount(0);
}

/** The flyout a picker cell edits in. */
export const picker = (page: Page, name: string) =>
  page.getByRole('dialog', { name: `Edit ${name}`, exact: true });

/** Picks or makes options (select, status: one; multi-select: several), as a person types them. */
export async function chooseOptions(page: Page, name: string, options: string[]) {
  await rowValue(page, name).click();
  const flyout = picker(page, name);
  const search = flyout.getByRole('combobox');
  for (const option of options) {
    await search.fill(option);
    await search.press('Enter');
  }
  if (options.length > 1 || (await flyout.count())) await page.keyboard.press('Escape');
  await expect(flyout).toHaveCount(0);
}

/** Picks one entry of a list picker (person, relation) by what is typed, then closes it. */
export async function chooseFromList(page: Page, name: string, query: string, entry: string) {
  await rowValue(page, name).click();
  const flyout = picker(page, name);
  await flyout.getByRole('combobox').fill(query);
  await flyout.getByRole('option', { name: entry }).click();
  await page.keyboard.press('Escape');
  await expect(flyout).toHaveCount(0);
}

/** A day of the shown month in the date picker, by its full English name. */
export function dayName(date: Date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export async function chooseDate(page: Page, name: string, date: Date) {
  await rowValue(page, name).click();
  const flyout = picker(page, name);
  await flyout.getByRole('button', { name: new RegExp(`^${dayName(date)}`) }).click();
  await expect(flyout).toHaveCount(0);
}

export async function uploadFile(page: Page, name: string, file: string) {
  await rowValue(page, name).click();
  const flyout = picker(page, name);
  const chooser = page.waitForEvent('filechooser');
  await flyout.getByRole('button', { name: 'Upload files' }).click();
  await (await chooser).setFiles({ name: file, mimeType: 'image/png', buffer: PNG });
  await expect(flyout.getByRole('button', { name: `Open ${file}` })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(flyout).toHaveCount(0);
}

// ------------------------------------------------------------------------------- the cloud
/** Signed in with a synced workspace, made as each target makes one (as offline.spec.ts). */
export async function signedInWorkspace(
  page: Page,
  account: TestAccount,
  name: string,
  authUrlFile: string | null,
  signer: () => Promise<Browser>,
) {
  if (desktop) {
    await createWorkspace(page, name);
    await signInDesktop(page, await signer(), authUrlFile!, account);
    await page.getByRole('button', { name: 'Upload to my account' }).click();
  } else {
    await page.goto('/');
    await signIn(page, account);
    await signedIn(page, account);
    await page.getByLabel('Workspace name').fill(name);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(editor(page)).toBeVisible();
  }
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
}

/** Turns this device's network off and on (as offline.spec.ts). */
export async function network(page: Page, context: BrowserContext) {
  if (!desktop || context !== page.context())
    return { off: () => context.setOffline(true), on: () => context.setOffline(false) };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  return {
    off: () =>
      cdp.send('Network.setBlockedURLs', { urls: [`${API.replace(/^https?:\/\//, '*')}/*`] }),
    on: async () => {
      await cdp.send('Network.setBlockedURLs', { urls: [] });
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
    },
  };
}

/** Another device of the same person: a browser profile of its own, signed in. */
export async function otherDevice(browser: Browser, account: TestAccount) {
  const context = await browser.newContext({
    baseURL: APP,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.goto(`${APP}/`);
  await signIn(page, account, `${APP}/`);
  await signedIn(page, account);
  await expect(syncStatus(page)).toHaveText('Synced', { timeout: 30000 });
  return { context, page };
}

/** A browser for the desktop's sign-in and second devices, closed after each test. */
export function signers() {
  let launched: Browser | null = null;
  return {
    signer: async () => (launched ??= await chromium.launch({ channel: 'chrome' })),
    close: async () => {
      await launched?.close();
      launched = null;
    },
  };
}

/** The desktop keeps its sign-in in the keychain (one test name for every test): signed out. */
export async function signOutDesktop(page: Page) {
  if (!desktop || page.isClosed()) return;
  await page.goto('/#/settings').catch(() => {});
  await page
    .getByRole('button', { name: 'Sign out' })
    .click({ timeout: 15000 })
    .catch(() => {});
  // Signed out for good: the next test's app starts with the same keychain name.
  await expect(page.getByRole('button', { name: 'Sign in to sync' }).first())
    .toBeVisible({ timeout: 15000 })
    .catch(() => {});
  await page.waitForTimeout(500);
}

export const tree = (page: Page) => page.getByRole('tree', { name: 'Pages' });
export const treeRow = (page: Page, title: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(title) });
