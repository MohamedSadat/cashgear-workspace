import { existsSync } from 'node:fs';
import { webkit, type Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { caretSettled, createWorkspace, editor, watchErrors } from './helpers';

// The touch toolbar and the frame over an on-screen keyboard that Safari on iOS draws over the page
// (reported from an iPhone on 2026-11-26: editing a numbered list with the keyboard open, iOS's own
// form bar showed above the keyboard and the touch toolbar did not, "can't exit edit mode", and the
// page's top bar had left the screen).
//
// Safari ignores index.html's `interactive-widget=resizes-content`, which Chrome on Android follows:
// the layout viewport keeps its height under the keyboard, the visual viewport shrinks, and moves
// down the layout viewport (`offsetTop`) when Safari shows the caret or the page scrolls the window;
// `innerHeight` is no measure of the layout viewport then (WebKit bug 191204). No desktop browser
// draws such a keyboard, so `keyboard()` makes the visual viewport say so. The window (the layout
// viewport) keeps its height, `innerHeight` reads the visual viewport's, Safari moves the visual
// viewport down to a caret the keyboard would cover as it opens, and the page's own window scroll
// (`scrollBy`, `scrollTo`) moves it too, as far as the layout viewport's foot. The app fits its
// frame to the visual viewport then (apps/web/src/keyboardFit.ts). Where a real iPhone may differ:
// docs/DECISIONS.md, "The touch toolbar over iOS's keyboard" and "The frame fitted above iOS's
// keyboard".

const PHONE = { width: 375, height: 812 };
/** What a 375 by 812 iPhone's keyboard, with its suggestions, leaves of the window. */
const ABOVE_THE_KEYBOARD = 420;
/** The room Safari leaves under a caret it moves the visual viewport to show (a guess). */
const SAFARI_ROOM = 40;

const toggle = (page: Page) =>
  page.getByRole('button', { name: /Show the sidebar|Hide the sidebar/ });
const drawer = (page: Page) => page.locator('#cgw-drawer');
const tools = (page: Page) => page.getByRole('toolbar', { name: 'Block tools' });

/**
 * Safari's keyboard over the window, `height` of it left above, or closed (`null`); see the file's
 * comment. Each call puts back what the last one changed first.
 */
async function keyboard(page: Page, height: number | null) {
  await page.evaluate(
    ({ height, room }) => {
      const page = window as Window & { cgwKeyboardDown?: () => void };
      const viewport = window.visualViewport!;
      page.cgwKeyboardDown?.();
      delete page.cgwKeyboardDown;
      if (height === null) {
        // The visual viewport is the layout viewport again, at its top.
        viewport.dispatchEvent(new Event('resize'));
        viewport.dispatchEvent(new Event('scroll'));
        return;
      }
      const layout = document.documentElement.clientHeight;
      const kept: [object, string, PropertyDescriptor | undefined][] = [];
      const define = (target: object, name: string, value: PropertyDescriptor) => {
        kept.push([target, name, Object.getOwnPropertyDescriptor(target, name)]);
        Object.defineProperty(target, name, { configurable: true, ...value });
      };
      page.cgwKeyboardDown = () => {
        for (const [target, name, was] of kept.reverse()) {
          if (was) Object.defineProperty(target, name, was);
          else delete (target as Record<string, unknown>)[name];
        }
      };
      let offsetTop = 0;
      const within = (to: number) => Math.max(0, Math.min(layout - height, to));
      define(viewport, 'height', { get: () => height });
      define(viewport, 'offsetTop', { get: () => offsetTop });
      define(viewport, 'pageTop', { get: () => offsetTop });
      define(window, 'innerHeight', { get: () => height });
      const pan = (to: number) => {
        const next = within(to);
        if (next === offsetTop) return;
        offsetTop = next;
        viewport.dispatchEvent(new Event('scroll'));
      };
      const by = (x?: number | ScrollToOptions, y?: number) =>
        typeof x === 'object' ? (x.top ?? 0) : (y ?? 0);
      define(window, 'scrollBy', {
        writable: true,
        value: (x?: number | ScrollToOptions, y?: number) => pan(offsetTop + by(x, y)),
      });
      define(window, 'scrollTo', {
        writable: true,
        value: (x?: number | ScrollToOptions, y?: number) => pan(by(x, y)),
      });
      // As it opens, Safari moves the visual viewport down to a caret the keyboard would cover.
      const selection = getSelection();
      if (selection?.rangeCount) {
        let caret: DOMRect | undefined = selection.getRangeAt(0).getBoundingClientRect();
        const node = selection.focusNode;
        if (!caret.top && !caret.bottom)
          caret = (
            node?.nodeType === 1 ? (node as Element) : node?.parentElement
          )?.getBoundingClientRect();
        if (caret && caret.bottom + room > height) offsetTop = within(caret.bottom + room - height);
      }
      viewport.dispatchEvent(new Event('resize'));
      if (offsetTop) viewport.dispatchEvent(new Event('scroll'));
    },
    { height, room: SAFARI_ROOM },
  );
}

/**
 * Where the touch toolbar, the caret and the top bar are against what the person sees: the visual
 * viewport, `offsetTop` to `offsetTop + height` in the layout viewport's coordinates (the client
 * rectangles').
 */
const place = (page: Page) =>
  page.evaluate(() => {
    const viewport = window.visualViewport!;
    const seenTop = viewport.offsetTop;
    const seenFoot = viewport.offsetTop + viewport.height;
    const bar = document.querySelector('.cgw-touchbar')?.getBoundingClientRect();
    const done = document.querySelector('.cgw-touchbar-done')?.getBoundingClientRect();
    const top = document.querySelector('.cgw-topbar')?.getBoundingClientRect();
    const selection = getSelection()!;
    let caret: DOMRect | undefined = selection.getRangeAt(0).getBoundingClientRect();
    // An empty box (an empty line, WebKit): the caret's element.
    const node = selection.focusNode;
    if (!caret.top && !caret.bottom)
      caret = (
        node?.nodeType === 1 ? (node as Element) : node?.parentElement
      )?.getBoundingClientRect();
    return {
      // The toolbar's foot is the visible area's, above the keyboard.
      toolbarAtTheFoot: !!bar && Math.abs(bar.bottom - seenFoot) <= 1 && bar.top >= seenTop,
      // "Done editing" is inside the window's width, however many tools scroll along the bar.
      doneShown: !!done && done.left >= 0 && done.right <= document.documentElement.clientWidth,
      // The caret is seen, and above the toolbar.
      caretAbove: !!bar && !!caret && caret.top >= seenTop && caret.bottom <= bar.top,
      // The page's top bar is seen too, however far the visual viewport has moved.
      topBarSeen: !!top && top.top >= seenTop - 1 && top.bottom <= seenFoot,
    };
  });

const shown = { toolbarAtTheFoot: true, doneShown: true, caretAbove: true, topBarSeen: true };

/** Whether the app has fitted its frame (#root) to the visual viewport. */
const fitted = (page: Page) =>
  page.evaluate(() => document.getElementById('root')!.style.position === 'fixed');

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

/** A numbered list of `items` and a last line, typed from the caret. */
async function typeList(page: Page, items: number) {
  await page.keyboard.type('1. ');
  for (let i = 1; i <= items; i++) {
    await page.keyboard.type(`Item ${i}`);
    await page.keyboard.press('Enter');
  }
  await page.keyboard.type('The last item');
  await expect(editor(page)).toContainText('The last item');
}

/** Where to tap the list's line nearest `y` in the window, below the keyboard's top. */
const lineNear = (page: Page, y: number) =>
  page.evaluate((y) => {
    const lines = [...document.querySelectorAll('.cgw-page .cgw-editor *')]
      .filter((el) => !el.children.length && /^Item \d+$/.test(el.textContent ?? ''))
      .map((el) => el.getBoundingClientRect())
      .filter((rect) => rect.top > 480 && rect.bottom < 700);
    lines.sort((a, b) => Math.abs(a.top - y) - Math.abs(b.top - y));
    const line = lines[0];
    return line
      ? { x: line.left + Math.min(20, line.width / 2), y: (line.top + line.bottom) / 2 }
      : null;
  }, y);

/**
 * A list typed down past the keyboard, "Done editing", the keyboard closed, then a line in the lower
 * half of the screen tapped and the keyboard opened over it.
 */
async function typeOverTheKeyboard(page: Page) {
  await phonePage(page, 'Typed over the keyboard');
  // No keyboard: the frame is the window's.
  expect(await fitted(page)).toBe(false);
  await keyboard(page, ABOVE_THE_KEYBOARD);
  // As soon as the keyboard is up, before anything scrolls; the fit loads with the first keyboard.
  await expect.poll(() => fitted(page)).toBe(true);
  await expect.poll(() => place(page)).toEqual(shown);
  await typeList(page, 24);
  // Typed down to the keyboard, the page area has scrolled the caret above the toolbar, and the
  // frame and the toolbar have followed the visual viewport wherever that went.
  await expect.poll(() => place(page)).toEqual(shown);

  // "Done editing" leaves the editor: no focus, no selection (iOS closes its keyboard), no toolbar.
  await tools(page).getByRole('button', { name: 'Done editing' }).click();
  await expect(editor(page)).not.toBeFocused();
  await expect(tools(page)).toBeHidden();
  expect(await page.evaluate(() => getSelection()?.rangeCount ?? 0)).toBe(0);
  // The keyboard closed, the frame is the window's again.
  await keyboard(page, null);
  await expect.poll(() => fitted(page)).toBe(false);
  expect(
    await page.evaluate(() => document.querySelector('.cgw-topbar')!.getBoundingClientRect().top),
  ).toBe(0);

  // A tap on the page edits it again: a line in the lower half of the screen, which the keyboard
  // then covers. Safari moves the visual viewport down to it, the frame follows the visual viewport,
  // and the line is scrolled back up into it, above the toolbar, with the top bar seen. The page is
  // scrolled back to its start first, so its list runs down past the screen's middle.
  await page.evaluate(() => document.querySelector('.cgw-page-area')!.scrollTo(0, 0));
  const line = await lineNear(page, 620);
  expect(line, 'a line of the list in the lower half of the screen').not.toBeNull();
  await page.mouse.click(line!.x, line!.y);
  await expect(editor(page)).toBeFocused();
  await expect(tools(page)).toBeVisible();
  await caretSettled(page);
  await keyboard(page, ABOVE_THE_KEYBOARD);
  expect(await page.evaluate(() => window.visualViewport!.offsetTop)).toBeGreaterThan(0);
  await expect.poll(() => place(page)).toEqual(shown);
  expect(await fitted(page)).toBe(true);
}

test.describe('the touch toolbar and the frame over iOS’s keyboard', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test('stay above the keyboard with the caret and the top bar seen, and Done editing leaves the editor', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await typeOverTheKeyboard(page);
    expect(errors).toEqual([]);
  });

  // Chrome on Android follows `resizes-content`: the window itself shrinks above the keyboard, the
  // two viewports stay one, and the app fits nothing.
  test('where the window itself shrinks above the keyboard, nothing is fitted', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await phonePage(page, 'Typed on Android');
    await page.setViewportSize({ width: PHONE.width, height: ABOVE_THE_KEYBOARD });
    await typeList(page, 16);
    await expect.poll(() => place(page)).toEqual(shown);
    expect(await fitted(page)).toBe(false);
    expect(errors).toEqual([]);
  });

  // The same in Playwright's WebKit, the engine of Safari on iOS (its layout of the fixed frame and
  // of the fixed, sticky and transformed toolbar), where it is installed (`npx playwright install
  // webkit`, or a build named by CGW_E2E_WEBKIT), from Chrome's project alone. CI installs it in the
  // chrome shard that runs this file (ci.yml), so there a missing WebKit fails, never skips.
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
