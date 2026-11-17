// Phase 9 (M9.2): "a timeline view of a 50,000-row database shows the rows in its window and moves
// and resizes bars by pointer and keyboard, in both directions". One database of 50,000 rows made
// through the import route as bench/phase4.mjs seeds its own (bench/phase9-timeline.mjs's
// `seedTimelineDatabase`: starts over eight years from 2022, each 0 to 8 days long, one row in 50
// with no date), its first view a timeline by Start. Over `LOCAL_ROW_LIMIT`, so the server answers
// the timeline's queries by their date window.
//
// The timeline is the library's `CgTimeline` (Track U18): its bars are `[data-cg-timeline-item]`,
// their end edges `[data-cg-timeline-edge="end"]`, its lanes' buttons `[data-cg-timeline-lane]`, its
// scroller `[data-cg-timeline-scroller]` under a header of 56 px, the drop mark
// `[data-cg-timeline-drop]` (`data-shown` while marked); a day is 20 px at the default scale (the
// library's `dayWidths`, which the view leaves as they are).
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { watchErrors } from './helpers';
import { newAccount, signIn, syncStatus, type TestAccount } from './cloud';
import { fullPage } from './database';
import { apiSession } from '../../scripts/cloud-account.mjs';
import { STAGES, TIMELINE_P, seedTimelineDatabase } from '../../bench/phase9-timeline.mjs';

test.skip(
  desktop,
  'Seeded and signed in through a browser profile; the desktop runs the same views',
);
test.describe.configure({ mode: 'serial' });

type Api = Awaited<ReturnType<typeof apiSession>>;
type Seeded = Awaited<ReturnType<typeof seedTimelineDatabase>>;
type DateValue = { start: string; end?: string | null };
interface QueryBody {
  window?: { propertyId: string; endPropertyId?: string | null; from: string; to: string };
}

let account: TestAccount;
let api: Api;
let seeded: Seeded;

test.beforeAll(async () => {
  test.setTimeout(600_000);
  account = await newAccount('Timeline');
  api = await apiSession(account);
  seeded = await seedTimelineDatabase(api);
});
test.afterAll(async () => {
  await api?.dispose();
});

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** The person's own calendar date in the page (the app's today). */
const todayIn = (page: Page) =>
  page.evaluate(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
const plus = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** A row's Start as the server holds it, found by its title. */
async function startOf(title: string): Promise<DateValue | undefined> {
  const answer = await api.post(`/api/v1/databases/${seeded.databaseId}/query`, {
    filter: null,
    sorts: [],
    group: null,
    search: title,
    context: { today: '2026-11-17', offsetMinutes: 0, me: null },
    limit: 5,
  });
  const row = (answer.rows as { title: string; values: Record<string, DateValue> }[]).find(
    (r) => r.title === title,
  );
  return row?.values[TIMELINE_P.start];
}

/** The timeline on the database's own page, signed in; the language and theme first. */
async function openTimeline(page: Page, language: 'en' | 'ar' = 'en', theme?: 'light' | 'dark') {
  await page.goto('/');
  await page.evaluate(
    ({ language, theme }) => {
      localStorage.setItem('cgw-language', language);
      if (theme) localStorage.setItem('cgw-theme', theme);
    },
    { language, theme },
  );
  await signIn(page, account, `/#/p/${seeded.databaseId}`);
  const db = fullPage(page);
  const timeline = db.locator('.cgw-db-tl');
  await expect(timeline.locator('[data-cg-timeline-item]').first()).toBeVisible({
    timeout: 60_000,
  });
  // Every page of the window is in: the status line is empty.
  await expect(timeline.locator('.cgw-db-tl-status')).toHaveText('', { timeout: 60_000 });
  return { db, timeline };
}

/** A day's width in pixels at the default scale (weeks), and the header above the lines. */
const DAY = 20;
const HEADER = 56;

/**
 * The `index`-th bar found wholly in view, its row's title and its box. Lines are the rows the
 * days shown hold in the view's order (earliest start first), so the first lines are rows already
 * under way, cut at the inline-start edge: like a person, it scrolls the lines down until whole
 * bars come into view, counting each row once.
 */
async function barAt(timeline: Locator, index: number, middle = false) {
  const scroller = timeline.locator('[data-cg-timeline-scroller]');
  const counted = new Set<string>();
  for (let step = 0; step < 80; step++) {
    const view = (await scroller.boundingBox())!;
    const bars = timeline.locator('[data-cg-timeline-item]');
    const count = await bars.count();
    for (let i = 0; i < count; i++) {
      const box = await bars.nth(i).boundingBox();
      if (
        !box ||
        box.x < view.x + 4 ||
        box.x + box.width > view.x + view.width - 4 ||
        // Below the header.
        box.y < view.y + HEADER + 4 ||
        box.y + box.height > view.y + view.height - 4 ||
        // Away from the top and bottom, where a drag scrolls the lines.
        (middle && (box.y < view.y + HEADER + 96 || box.y + box.height > view.y + view.height - 96))
      )
        continue;
      const title = (await bars.nth(i).textContent())!.trim();
      if (counted.has(title)) continue;
      if (counted.size === index) {
        // By its title, not its place: the virtualised lines are drawn again as they scroll.
        const bar = bars.filter({ hasText: title }).first();
        return { bar, title, box };
      }
      counted.add(title);
    }
    const moved = await scroller.evaluate((el, header) => {
      const before = el.scrollTop;
      el.scrollTop += Math.max(100, el.clientHeight - header - 72);
      return el.scrollTop !== before;
    }, HEADER);
    if (!moved) break;
    await expect.poll(async () => bars.count(), { timeout: 5000 }).toBeGreaterThan(0);
    await timeline.page().waitForTimeout(150);
  }
  throw new Error(`No bar ${index} wholly in view (${counted.size} were)`);
}

/** A pointer drag, in steps, as a hand drags (pointer events from page.mouse). */
async function drag(page: Page, from: { x: number; y: number }, dx: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(from.x + (dx * i) / 12, from.y);
  await page.mouse.up();
}

test('shows the rows of its window, asked of the server by their dates, a line per row', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const windows: NonNullable<QueryBody['window']>[] = [];
  const answers: { rows: { values: Record<string, DateValue> }[]; total: number }[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !/\/databases\/[^/]+\/query$/.test(request.url())) return;
    const body = request.postDataJSON() as QueryBody;
    if (body.window) windows.push(body.window);
  });
  page.on('response', async (response) => {
    if (!/\/databases\/[^/]+\/query$/.test(response.url()) || !response.ok()) return;
    const body = response.request().postDataJSON() as QueryBody;
    if (body.window) answers.push(await response.json());
  });
  const { timeline } = await openTimeline(page);
  const today = await todayIn(page);
  expect(windows.length).toBeGreaterThan(0);
  const window = windows.at(-1)!;
  expect(window.propertyId).toBe(TIMELINE_P.start);
  expect(window.from <= today && today <= window.to).toBe(true);
  // Every row the server answered meets the window.
  expect(answers.length).toBeGreaterThan(0);
  for (const answer of answers)
    for (const row of answer.rows) {
      const value = row.values[TIMELINE_P.start];
      expect(value.start <= window.to && (value.end ?? value.start) >= window.from).toBe(true);
    }
  const total = answers.at(-1)!.total;
  expect(total).toBeGreaterThan(500);
  expect(total).toBeLessThan(seeded.rows / 4);
  // A line per row the days shown hold (fewer than the window fetched around them); only the
  // lines in view are drawn, and the bars in view are whole.
  const rows = Number(await timeline.getByRole('grid').getAttribute('aria-rowcount'));
  expect(rows).toBeGreaterThan(20);
  expect(rows).toBeLessThan(total);
  expect(await timeline.getByRole('row').count()).toBeLessThan(80);
  await barAt(timeline, 5);
  // The rows with no date, beside it.
  await expect(timeline.locator('.cgw-cal-undated-item').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('moves and resizes a bar by keyboard and by pointer, each written to the server', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const { timeline } = await openTimeline(page);
  const { bar, title } = await barAt(timeline, 3);
  const before = (await startOf(title))!;
  // Alt and the arrow: a day later.
  await bar.focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect
    .poll(async () => (await startOf(title))?.start, { timeout: 30_000 })
    .toBe(plus(before.start, 1));
  // With Shift: its end a day later.
  const end = before.end ?? before.start;
  await timeline.locator(`[data-cg-timeline-item]`).filter({ hasText: title }).first().focus();
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect
    .poll(async () => (await startOf(title))?.end, { timeout: 30_000 })
    .toBe(plus(end, 2));
  // Ctrl and Shift (Cmd and Shift on a Mac) with the arrow: its start a day earlier, back.
  await page.keyboard.press('ControlOrMeta+Shift+ArrowLeft');
  await expect
    .poll(async () => (await startOf(title))?.start, { timeout: 30_000 })
    .toBe(before.start);
  // By pointer: three days on by its body, whole days.
  const moved = timeline.locator('[data-cg-timeline-item]').filter({ hasText: title }).first();
  const box = (await moved.boundingBox())!;
  await drag(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 3 * DAY + 2);
  await expect
    .poll(async () => (await startOf(title))?.start, { timeout: 30_000 })
    .toBe(plus(before.start, 3));
  // Its end edge: two days more.
  const edge = (await moved.locator('[data-cg-timeline-edge="end"]').boundingBox())!;
  await drag(page, { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 }, 2 * DAY + 2);
  await expect
    .poll(async () => (await startOf(title))?.end, { timeout: 30_000 })
    .toBe(plus(end, 2 + 3 + 2));
  await expect(syncStatus(page)).toHaveAttribute('data-state', 'synced', { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test('drops a row with no date on the day under the pointer, and lays the rows in lanes', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const { db, timeline } = await openTimeline(page);
  const item = timeline.locator('.cgw-cal-undated [data-cal-drag]').first();
  const title = (await item.locator('.cgw-cal-undated-open').textContent())!.trim();
  expect(await startOf(title)).toBeUndefined();
  // Dropped four days after a bar in view starts (its box's inline start is its first day's).
  const known = await barAt(timeline, 2, true);
  const knownStart = (await startOf(known.title))!.start;
  const to = { x: known.box.x + 4 * DAY + DAY / 2, y: known.box.y + known.box.height / 2 };
  const from = (await item.boundingBox())!;
  // The drag starts inside the list, then the pointer goes to the day in one move: passing through
  // the timeline's edge would scroll its days (and so its lines) under the pointer, as it should.
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(to.x, to.y);
  await page.mouse.move(to.x + 1, to.y);
  await expect(timeline.locator('[data-cg-timeline-drop]')).toHaveAttribute('data-shown', '');
  await page.mouse.up();
  await expect
    .poll(async () => (await startOf(title))?.start, { timeout: 30_000 })
    .toBe(plus(knownStart, 4));

  // Lanes by Stage, in its options' order: collapsed one after the other, each comes up.
  await db.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.getByRole('dialog', { name: 'Layout' }).getByLabel('Lanes by').selectOption({
    label: 'Stage',
  });
  await page.keyboard.press('Escape');
  const toggles = timeline.locator('[data-cg-timeline-lane]');
  await expect(toggles.first()).toHaveText(new RegExp(STAGES[0]));
  for (let i = 0; i < STAGES.length; i++) {
    await expect(toggles.nth(i)).toHaveText(new RegExp(STAGES[i]));
    await toggles.nth(i).click();
    await expect(toggles.nth(i)).toHaveAttribute('aria-expanded', 'false');
  }
  for (let i = STAGES.length - 1; i >= 0; i--) await toggles.nth(i).click();
  await db.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.getByRole('dialog', { name: 'Layout' }).getByLabel('Lanes by').selectOption({
    label: 'No lanes',
  });
  await page.keyboard.press('Escape');
  await expect(toggles).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('runs from right to left in Arabic: later is to the left, and the keys and the pointer follow', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const { timeline } = await openTimeline(page, 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(timeline.getByRole('button', { name: 'اليوم', exact: true })).toBeVisible();
  // Earliest first down the lines; a later start is drawn further left.
  const a = await barAt(timeline, 0);
  const b = await barAt(timeline, 12);
  const [startA, startB] = [(await startOf(a.title))!.start, (await startOf(b.title))!.start];
  if (startA < startB) expect(b.box.x + b.box.width).toBeLessThan(a.box.x + a.box.width);
  // Alt and the arrow to the left: a day later.
  const { bar, title } = await barAt(timeline, 5);
  const before = (await startOf(title))!;
  await bar.focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect
    .poll(async () => (await startOf(title))?.start, { timeout: 30_000 })
    .toBe(plus(before.start, 1));
  // Dragged two days to the left: two days later.
  const moved = timeline.locator('[data-cg-timeline-item]').filter({ hasText: title }).first();
  const box = (await moved.boundingBox())!;
  await drag(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, -(2 * DAY + 2));
  await expect
    .poll(async () => (await startOf(title))?.start, { timeout: 30_000 })
    .toBe(plus(before.start, 3));
  expect(errors).toEqual([]);
});

/** Text of the timeline's own in Arabic that has an English word (key names allowed). */
async function english(timeline: Locator) {
  return timeline.evaluate((root) => {
    const keys = /\b(Alt|Shift|Page Up|Page Down|Ctrl)\b/g;
    const found: string[] = [];
    // What the person wrote: rows' titles, the options lanes are named by, the database's title.
    const theirs =
      '[data-cg-timeline-item], .cgw-cal-undated-open, [data-cg-timeline-lane] [dir="auto"]';
    const check = (text: string | null, where: string) => {
      if (text && /[A-Za-z]{2,}/.test(text.replace(keys, ''))) found.push(`${where}: ${text}`);
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement!;
      if (parent.closest(theirs) || parent.closest('[hidden]')) continue;
      check(node.textContent, parent.className);
    }
    for (const el of root.querySelectorAll('[aria-label], [title]')) {
      if (el.matches('[data-cg-timeline-item], [data-cg-timeline-lane], [role="grid"]')) continue;
      check(el.getAttribute('aria-label'), `${el.tagName} label`);
      check(el.getAttribute('title'), `${el.tagName} title`);
    }
    return found;
  });
}

test('Axe finds nothing on the timeline, and in Arabic it has no English of its own', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const problems: string[] = [];
  for (const theme of ['light', 'dark'] as const)
    for (const language of ['en', 'ar'] as const) {
      const { db, timeline } = await openTimeline(page, language, theme);
      // With lanes, so their headers are checked too.
      await db
        .locator('.cgw-db-toolbar')
        .getByRole('button')
        .filter({ hasText: /Layout|التخطيط/ })
        .click();
      const layout = page.getByRole('dialog').last();
      await layout.locator('select').nth(2).selectOption({ index: 1 });
      await page.keyboard.press('Escape');
      await expect(timeline.locator('[data-cg-timeline-lane]').first()).toBeVisible();
      const result = await new AxeBuilder({ page })
        .include('.cgw-database-page')
        .withTags(WCAG)
        .analyze();
      problems.push(
        ...result.violations.map(
          (v) =>
            `${theme} ${language}: ${v.id} (${v.impact}) ${v.help}\n` +
            v.nodes
              .slice(0, 5)
              .map((n) => `    ${n.target.join(' ')}: ${n.failureSummary?.split('\n')[1] ?? ''}`)
              .join('\n'),
        ),
      );
      if (language === 'ar') problems.push(...(await english(timeline)));
      await db
        .locator('.cgw-db-toolbar')
        .getByRole('button')
        .filter({ hasText: /Layout|التخطيط/ })
        .click();
      await page.getByRole('dialog').last().locator('select').nth(2).selectOption({ index: 0 });
      await page.keyboard.press('Escape');
    }
  expect(problems, problems.join('\n')).toEqual([]);
});
