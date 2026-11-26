import { existsSync } from 'node:fs';
import { webkit, type Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { createWorkspace, editor, watchErrors } from './helpers';

// The touch toolbar over an on-screen keyboard that Safari on iOS draws over the page (reported from
// an iPhone on 2026-11-26: editing a numbered list with the keyboard open, iOS's own form bar showed
// above the keyboard and the touch toolbar did not, and "can't exit edit mode").
//
// Safari ignores index.html's `interactive-widget=resizes-content`, which Chrome on Android follows:
// the layout viewport keeps its height under the keyboard, the visual viewport shrinks, and moves
// down the layout viewport (`offsetTop`) when the page scrolls the caret into view; `innerHeight`
// is no measure of the layout viewport then (WebKit bug 191204). No desktop browser draws such a
// keyboard, so `keyboard()` makes the visual viewport say so. The window (the layout viewport)
// keeps its height, `innerHeight` reads the visual viewport's, and the page's own window scroll
// (ProseMirror's `scrollBy`) moves the visual viewport, as far as the layout viewport's foot. Where
// a real iPhone may differ: docs/DECISIONS.md, "The touch toolbar over iOS's keyboard".

const PHONE = { width: 375, height: 812 };
/** What a 375 by 812 iPhone's keyboard, with its suggestions, leaves of the window. */
const ABOVE_THE_KEYBOARD = 420;

const toggle = (page: Page) =>
  page.getByRole('button', { name: /Show the sidebar|Hide the sidebar/ });
const drawer = (page: Page) => page.locator('#cgw-drawer');
const tools = (page: Page) => page.getByRole('toolbar', { name: 'Block tools' });

/** Safari's keyboard over the window, `height` of it left above (see the file's comment). */
async function keyboard(page: Page, height: number) {
  await page.evaluate((height) => {
    const viewport = window.visualViewport!;
    const layout = document.documentElement.clientHeight;
    let offsetTop = 0;
    const define = (target: object, name: string, get: () => number) =>
      Object.defineProperty(target, name, { configurable: true, get });
    define(viewport, 'height', () => height);
    define(viewport, 'offsetTop', () => offsetTop);
    define(viewport, 'pageTop', () => offsetTop);
    define(window, 'innerHeight', () => height);
    const pan = (to: number) => {
      const next = Math.max(0, Math.min(layout - height, to));
      if (next === offsetTop) return;
      offsetTop = next;
      viewport.dispatchEvent(new Event('scroll'));
    };
    const by = (x?: number | ScrollToOptions, y?: number) =>
      typeof x === 'object' ? (x.top ?? 0) : (y ?? 0);
    window.scrollBy = ((x?: number | ScrollToOptions, y?: number) =>
      pan(offsetTop + by(x, y))) as typeof window.scrollBy;
    window.scrollTo = ((x?: number | ScrollToOptions, y?: number) =>
      pan(by(x, y))) as typeof window.scrollTo;
    viewport.dispatchEvent(new Event('resize'));
  }, height);
}

/**
 * Where the touch toolbar and the caret are against what the person sees: the visual viewport,
 * `offsetTop` to `offsetTop + height` in the layout viewport's coordinates (the client rectangles').
 */
const place = (page: Page) =>
  page.evaluate(() => {
    const viewport = window.visualViewport!;
    const seenTop = viewport.offsetTop;
    const seenFoot = viewport.offsetTop + viewport.height;
    const bar = document.querySelector('.cgw-touchbar')?.getBoundingClientRect();
    const done = document.querySelector('.cgw-touchbar-done')?.getBoundingClientRect();
    const caret = getSelection()!.getRangeAt(0).getBoundingClientRect();
    return {
      // The toolbar's foot is the visible area's, above the keyboard.
      toolbarAtTheFoot: !!bar && Math.abs(bar.bottom - seenFoot) <= 1 && bar.top >= seenTop,
      // "Done editing" is inside the window's width, however many tools scroll along the bar.
      doneShown: !!done && done.left >= 0 && done.right <= document.documentElement.clientWidth,
      // The caret is seen, and above the toolbar.
      caretAbove: !!bar && caret.top >= seenTop && caret.bottom <= bar.top,
    };
  });

const shown = { toolbarAtTheFoot: true, doneShown: true, caretAbove: true };

/** A new page from the drawer, its title typed, the caret in its body. */
async function phonePage(page: Page, title: string) {
  await createWorkspace(page);
  await toggle(page).click();
  await drawer(page)
    .getByRole('button', { name: /^Add a page in/ })
    .first()
    .click();
  await expect(drawer(page)).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByLabel('Page title')).toBeFocused();
  await page.getByLabel('Page title').fill(title);
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeFocused();
  await expect(tools(page)).toBeVisible();
}

/** A list typed down past the keyboard, then "Done editing". */
async function typeOverTheKeyboard(page: Page) {
  await phonePage(page, 'Typed over the keyboard');
  await keyboard(page, ABOVE_THE_KEYBOARD);
  // As soon as the keyboard is up, before anything scrolls.
  await expect.poll(() => place(page)).toEqual(shown);
  await page.keyboard.type('1. ');
  for (let i = 1; i <= 16; i++) {
    await page.keyboard.type(`Item ${i}`);
    await page.keyboard.press('Enter');
  }
  await page.keyboard.type('The last item');
  await expect(editor(page)).toContainText('The last item');
  // Typed down to the keyboard, the page has scrolled the caret above the toolbar, and the
  // toolbar has followed the visual viewport wherever that went.
  await expect.poll(() => place(page)).toEqual(shown);

  // "Done editing" leaves the editor: no focus, no selection (iOS closes its keyboard), no toolbar.
  await tools(page).getByRole('button', { name: 'Done editing' }).click();
  await expect(editor(page)).not.toBeFocused();
  await expect(tools(page)).toBeHidden();
  expect(await page.evaluate(() => getSelection()?.rangeCount ?? 0)).toBe(0);
  // A tap on the page edits it again.
  await editor(page).getByText('Item 3', { exact: true }).click();
  await expect(editor(page)).toBeFocused();
  await expect(tools(page)).toBeVisible();
}

test.describe('the touch toolbar over iOS’s keyboard', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test('stays above the keyboard with the caret above it, and Done editing leaves the editor', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await typeOverTheKeyboard(page);
    expect(errors).toEqual([]);
  });

  // The same in Playwright's WebKit, the engine of Safari on iOS (its layout of the fixed, sticky
  // and transformed toolbar), where it is installed (`npx playwright install webkit`, or a build
  // named by CGW_E2E_WEBKIT), from Chrome's project alone. CI installs it in the chrome shard that
  // runs this file (ci.yml), so there a missing WebKit fails, never skips.
  test('the same in WebKit', async ({ baseURL }) => {
    test.skip(desktop, 'the desktop target has no WebKit');
    test.skip(test.info().project.name !== 'chrome', 'WebKit runs once, from the chrome project');
    const executablePath = process.env.CGW_E2E_WEBKIT || webkit.executablePath();
    const found = existsSync(executablePath);
    expect(found || !process.env.CI, `no WebKit at ${executablePath} on CI`).toBe(true);
    test.skip(!found, `no WebKit at ${executablePath}`);
    const browser = await webkit.launch({ executablePath });
    try {
      const context = await browser.newContext({ baseURL, viewport: PHONE, hasTouch: true });
      const page = await context.newPage();
      const errors = watchErrors(page);
      await typeOverTheKeyboard(page);
      // WebKit names the viewport's `interactive-widget` (Android's, index.html) as unknown.
      expect(errors.filter((error) => !error.includes('"interactive-widget"'))).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
