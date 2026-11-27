import { existsSync } from 'node:fs';
import { webkit, type Locator, type Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { createWorkspace, editor, watchErrors } from './helpers';

// The frame's layout with a sidebar taller than the window, and a list typed on a phone (bugs
// reported by hand on 2026-11-26).

const narrowLayout = (page: Page) =>
  page.locator('.cgw-frame').evaluate((frame) => frame.getAttribute('data-layout') === 'narrow');
const toggle = (page: Page) =>
  page.getByRole('button', { name: /Show the sidebar|Hide the sidebar/ });
const drawer = (page: Page) => page.locator('#cgw-drawer');
const settingsButton = (page: Page) =>
  page.locator('.cgw-sidebar-footer').getByRole('button', { name: 'Settings', exact: true });
const settingsTitle = (page: Page) => page.getByRole('heading', { name: 'Settings', level: 1 });

/** Pages added to the first section until the sidebar's tree is taller than any window here. */
async function tallTree(page: Page, count = 40) {
  for (let i = 1; i <= count; i++) {
    const before = page.url();
    await page
      .getByRole('button', { name: /^Add a page in/ })
      .first()
      .click();
    await expect.poll(() => page.url()).not.toBe(before);
  }
  await expect(page.getByLabel('Page title')).toHaveValue('');
}

/**
 * Where an element is: "shown" when the whole of it is inside the window and inside every
 * ancestor that clips, and it is what a press at its centre reaches. A clipped box can still be
 * in the DOM and even report a box, so this reads the clipping ancestors, not only the element.
 */
function place(locator: Locator) {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return 'no box';
    const name = (e: Element) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`;
    for (let a = element.parentElement; a; a = a.parentElement) {
      const style = getComputedStyle(a);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const clip = a.getBoundingClientRect();
      if (
        box.top < clip.top - 1 ||
        box.bottom > clip.bottom + 1 ||
        box.left < clip.left - 1 ||
        box.right > clip.right + 1
      )
        return `clipped by ${name(a)}`;
    }
    if (box.top < 0 || box.left < 0 || box.bottom > innerHeight || box.right > innerWidth)
      return 'outside the window';
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit && element.contains(hit) ? 'shown' : `under ${hit ? name(hit) : 'nothing'}`;
  });
}

/** Scroll offsets of every box that clips, outside the page area: none should have moved. */
function framesScrolled(page: Page) {
  return page.evaluate(() => {
    const moved: string[] = [];
    const area = document.querySelector('.cgw-page-area');
    for (const element of document.querySelectorAll('*')) {
      if (element === area || area?.contains(element)) continue;
      if (element.scrollTop || element.scrollLeft)
        moved.push(`${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`);
    }
    return moved;
  });
}

/** A window size, once the frame has taken the layout it calls for (Frame.tsx: a drawer below 768). */
async function resize(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await expect.poll(() => narrowLayout(page)).toBe(size.width < 768);
}

/** Opens the drawer on a narrow screen; the sidebar is always there on a wide one. */
async function showSidebar(page: Page) {
  if (!(await narrowLayout(page))) return;
  if ((await drawer(page).getAttribute('aria-hidden')) === 'true') await toggle(page).click();
  await expect(drawer(page)).toHaveAttribute('aria-hidden', 'false');
}

/** Presses an element at its centre as a mouse does: no scrolling it into view first. */
async function press(page: Page, locator: Locator) {
  const box = (await locator.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const WIDE = [
  { width: 1280, height: 800 },
  { width: 1280, height: 560 },
  { width: 1024, height: 420 },
  { width: 900, height: 340 },
  { width: 800, height: 300 },
];
const NARROW = [
  { width: 375, height: 812 },
  { width: 375, height: 560 },
  { width: 700, height: 360 },
];

test.describe('layout with a tall sidebar', () => {
  test('Settings stays on screen and reachable at the sidebar foot at every size', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await createWorkspace(page);
    await tallTree(page);
    const tree = page.getByRole('tree', { name: 'Pages' });
    for (const size of [...WIDE, ...NARROW]) {
      await test.step(`${size.width}x${size.height}`, async () => {
        await resize(page, size);
        await showSidebar(page);
        // The tree has more pages than room: it scrolls (its rows drawn as it does), the foot stays.
        await expect(tree).toBeVisible();
        await expect
          .poll(() => tree.evaluate((list) => list.scrollHeight > list.clientHeight))
          .toBe(true);
        await expect.poll(() => place(settingsButton(page))).toBe('shown');
        await expect
          .poll(() => place(page.getByRole('button', { name: /Test workspace/ })))
          .toBe('shown');
        expect(await framesScrolled(page)).toEqual([]);
        await press(page, settingsButton(page));
        await expect(settingsTitle(page)).toBeVisible();
        await page.goBack();
        await expect(page.getByLabel('Page title')).toBeVisible();
      });
    }
    expect(errors).toEqual([]);
  });

  for (const size of [WIDE[0], WIDE[2], NARROW[0], NARROW[1]]) {
    test(`Settings shows whole and scrolls to its end at ${size.width}x${size.height}`, async ({
      page,
    }) => {
      const errors = watchErrors(page);
      await createWorkspace(page);
      await tallTree(page);
      await resize(page, size);
      await showSidebar(page);
      // As a person reaches it: a press, the keyboard's focus or a tap scrolls it into view.
      await settingsButton(page).click();
      await expect(settingsTitle(page)).toBeVisible();
      if (await narrowLayout(page))
        await expect(drawer(page)).toHaveAttribute('aria-hidden', 'true');
      // Its start is on screen, under the top bar, and nothing around the page has moved.
      await expect.poll(() => place(settingsTitle(page))).toBe('shown');
      await expect.poll(() => place(page.locator('.cgw-topbar'))).toBe('shown');
      expect(await framesScrolled(page)).toEqual([]);
      // A wheel, as a finger: a script's scroll would move even a clipped box.
      const about = page.getByRole('heading', { name: 'About', level: 2 });
      await expect(about).toBeAttached();
      const area = (await page.locator('.cgw-page-area').boundingBox())!;
      await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
      for (let i = 0; i < 20 && (await place(about)) !== 'shown'; i++)
        await page.mouse.wheel(0, 600);
      await expect.poll(() => place(about)).toBe('shown');
      // Its last line too: the end of the page is reached, not cut off.
      const end = page.locator('.cgw-settings-panel > :last-child');
      await expect.poll(() => place(end)).toBe('shown');
      expect(errors).toEqual([]);
    });
  }
});

const PHONES = [
  { width: 375, height: 812 },
  { width: 320, height: 640 },
];

/** The top bar's words in each language the spec walks. */
const TOP_BAR = {
  en: {
    name: 'English',
    toggle: /^(Show|Hide) the sidebar$/,
    actions: 'Page actions',
    favourite: 'Add to favourites',
  },
  ar: {
    name: 'Arabic',
    toggle: /^(إظهار|إخفاء) الشريط الجانبي$/,
    actions: 'إجراءات الصفحة',
    favourite: 'إضافة إلى المفضلة',
  },
} as const;

/** How far the drawer's application area (CgDrawer's `main`, which scrolls) runs past its width. */
const sideways = (page: Page) =>
  page.locator('.cgw-frame > main').evaluate((main) => main.scrollWidth - main.clientWidth);

/**
 * What runs out of its place in the top bar: an item whose content is wider than its box (the
 * breadcrumbs' last crumb, drawn over the save status), or one drawn over the next. None when the
 * bar fits.
 */
function topBarSpills(page: Page) {
  return page.locator('.cgw-topbar').evaluate((bar) => {
    const name = (e: Element) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`;
    const items = [...bar.children, ...bar.querySelector('.cgw-topbar-content')!.children]
      .filter((e) => !e.classList.contains('cgw-topbar-content'))
      .map((e) => ({ e, box: e.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0)
      .sort((a, b) => a.box.left - b.box.left);
    const spills: string[] = [];
    for (const { e } of items)
      if (e.scrollWidth > e.clientWidth + 1)
        spills.push(`${name(e)} is ${e.scrollWidth - e.clientWidth}px wider than its box`);
    for (let i = 1; i < items.length; i++)
      if (items[i].box.left < items[i - 1].box.right - 1)
        spills.push(`${name(items[i - 1].e)} is drawn over ${name(items[i].e)}`);
    return spills;
  });
}

// Until 2026-11-27 the top bar on a phone (its breadcrumbs, save and sync status, star and "Page
// actions") was wider than the window: the drawer's application area scrolled sideways, and
// "Page actions" and the touch toolbar's end were cut off at the window's edge. From 375 pixels
// down, a long title's crumb also ran out of the breadcrumbs over the status labels.
test.describe('the top bar on a phone', () => {
  test.use({ hasTouch: true });

  for (const language of ['en', 'ar'] as const)
    for (const size of PHONES)
      test(`fits the window at ${size.width}x${size.height} in ${TOP_BAR[language].name}`, async ({
        page,
      }) => {
        const errors = watchErrors(page);
        const words = TOP_BAR[language];
        await page.setViewportSize(size);
        await createWorkspace(page);
        await toggle(page).click();
        await drawer(page)
          .getByRole('button', { name: /^Add a page in/ })
          .first()
          .click();
        await expect(drawer(page)).toHaveAttribute('aria-hidden', 'true');
        await expect(page.getByLabel('Page title')).toBeFocused();
        // A title longer than the window: the breadcrumbs must give way, not the frame.
        await page.getByLabel('Page title').fill('A page whose title is far longer than a phone');
        await page.keyboard.press('Enter');
        await expect(editor(page)).toBeFocused();
        await page.keyboard.type('Typed on a phone');
        await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
        if (language === 'ar') {
          await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
          await page.reload();
          await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
          await expect(editor(page)).toContainText('Typed on a phone');
        }

        const bar = page.locator('.cgw-topbar');
        const sidebar = bar.getByRole('button', { name: words.toggle });
        const actions = bar.getByRole('button', { name: words.actions, exact: true });
        await expect(bar.getByTestId('sync-status')).toHaveAttribute('data-state', 'localOnly');
        await expect.poll(() => sideways(page)).toBe(0);
        await expect.poll(() => topBarSpills(page)).toEqual([]);
        await expect.poll(() => place(sidebar)).toBe('shown');
        await expect.poll(() => place(actions)).toBe('shown');
        await expect
          .poll(() => place(bar.getByRole('button', { name: words.favourite, exact: true })))
          .toBe('shown');
        await expect.poll(() => place(bar.getByRole('navigation'))).toBe('shown');

        // The touch toolbar spans the window, not more: it scrolls along its own line.
        await editor(page).click();
        const tools = page.locator('.cgw-touchbar');
        await expect(tools).toBeVisible();
        await expect.poll(() => place(tools)).toBe('shown');
        await expect.poll(() => sideways(page)).toBe(0);

        // Both buttons take a press where they are drawn.
        await press(page, actions);
        const menu = page.getByRole('menu', { name: words.actions });
        await expect(menu).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await press(page, sidebar);
        await expect(drawer(page)).toHaveAttribute('aria-hidden', 'false');
        await page.keyboard.press('Escape');
        await expect(drawer(page)).toHaveAttribute('aria-hidden', 'true');
        expect(await framesScrolled(page)).toEqual([]);
        expect(errors).toEqual([]);
      });
});

/**
 * Each top-level block's text, and whether it is drawn: a press at its body's centre reaches the
 * body. A block whose contents `content-visibility` skips keeps its height but draws nothing and
 * takes no press (WebKit's `checkVisibility` does not say so).
 */
function drawnBlocks(page: Page) {
  return editor(page)
    .locator(':scope > .cgw-block > .cgw-body')
    .evaluateAll((bodies) =>
      bodies.map((body) => {
        const box = body.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return `${body.textContent}: ${hit && body.contains(hit) ? 'drawn' : 'blank'}`;
      }),
    );
}

/**
 * The page from the report, typed on a phone: two lines, then a numbered list of four items, one
 * by one. After each item every block typed so far must be drawn, not only the newest: it holds the
 * caret, which every browser draws.
 */
async function typeTheList(page: Page) {
  await createWorkspace(page);
  await toggle(page).click();
  await drawer(page)
    .getByRole('button', { name: /^Add a page in/ })
    .first()
    .click();
  await expect(drawer(page)).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByLabel('Page title')).toBeFocused();
  await page.getByLabel('Page title').fill('Workspace');
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('when add item to task');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Navbar slider if long');
  await page.keyboard.press('Enter');
  await page.keyboard.type('1. ');

  const items = editor(page).locator('.cgw-numberedItem');
  const words = ['Forget pass', 'Reset pass', 'User management', 'Groups'];
  const typed = ['when add item to task', 'Navbar slider if long'];
  for (const [i, word] of words.entries()) {
    if (i > 0) await page.keyboard.press('Enter');
    await page.keyboard.type(word);
    typed.push(word);
    await expect(items).toHaveCount(i + 1);
    await expect(items.nth(i)).toHaveText(word);
    await expect(items.nth(i)).toHaveAttribute('data-number', `${i + 1}.`);
    await expect.poll(() => drawnBlocks(page)).toEqual(typed.map((text) => `${text}: drawn`));
  }
}

test.describe('a list typed on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test('every numbered item shows as soon as it is typed', async ({ page }) => {
    const errors = watchErrors(page);
    await typeTheList(page);
    expect(errors).toEqual([]);
  });

  // The report came from an iPhone: WebKit (Safari, iOS and the Mac app's WKWebView) left every
  // block made by Enter blank until the screen scrolled, which Chromium never did. Playwright's
  // WebKit runs it where it is installed (`npx playwright install webkit`, or a build named by
  // CGW_E2E_WEBKIT); the configured browsers only start it, Chrome's project alone. CI installs it
  // in the chrome shard that runs this file (ci.yml), so there a missing WebKit fails, never skips.
  test('every numbered item shows as soon as it is typed, in WebKit', async ({ baseURL }) => {
    test.skip(desktop, 'the desktop target has no WebKit');
    test.skip(test.info().project.name !== 'chrome', 'WebKit runs once, from the chrome project');
    const executablePath = process.env.CGW_E2E_WEBKIT || webkit.executablePath();
    const found = existsSync(executablePath);
    expect(found || !process.env.CI, `no WebKit at ${executablePath} on CI`).toBe(true);
    test.skip(!found, `no WebKit at ${executablePath}`);
    const browser = await webkit.launch({ executablePath });
    try {
      const context = await browser.newContext({
        baseURL,
        viewport: { width: 375, height: 812 },
        hasTouch: true,
      });
      const page = await context.newPage();
      const errors = watchErrors(page);
      await typeTheList(page);
      // WebKit names the viewport's `interactive-widget` (Android's, index.html) as unknown.
      expect(errors.filter((error) => !error.includes('"interactive-widget"'))).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
