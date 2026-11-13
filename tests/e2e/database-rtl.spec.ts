// Phase 4: "e2e per view; RTL for board and calendar". In the Arabic interface, a Tasks database
// made from its template: the board's columns run right to left, and a card dragged by the mouse
// (`page.mouse`, as the block handle: pointer events, never HTML5 drag and drop) to another column
// takes that column's status; the calendar starts its week on Saturday on the right, and a row
// dragged to another day takes that date, kept across a reload.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { editor, watchErrors } from './helpers';
import { epochDay, fullPage, newDatabase, onCalendarDay, showView } from './database';

async function arabicWorkspace(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('cgw-language', 'ar'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByLabel('اسم مساحة العمل').fill('مساحتي');
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeVisible();
}

/** Presses on `from`, moves in steps to `to` (as a hand does), and lets go. */
async function drag(page: Page, from: Locator, to: { x: number; y: number }) {
  const box = (await from.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + Math.min(12, box.height / 2) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const steps = 24;
  for (let i = 1; i <= steps; i++)
    await page.mouse.move(
      start.x + ((to.x - start.x) * i) / steps,
      start.y + ((to.y - start.y) * i) / steps,
    );
  await page.mouse.up();
}

const column = (db: Locator, name: string) =>
  db.locator('[data-group]').filter({ has: db.page().getByText(name, { exact: true }) });
const card = (scope: Locator, title: string) =>
  scope.locator('[role="article"]').filter({ hasText: title });

test('RTL board: the columns run right to left, and a card dragged to another column takes its status', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await arabicWorkspace(page);
  await newDatabase(page, 'المهام', { language: 'ar' });
  const db = fullPage(page);
  await showView(db, 'لوحة');
  const todo = column(db, 'لم تبدأ');
  const done = column(db, 'منجزة');
  await expect(todo).toBeVisible();
  await expect(done).toBeVisible();
  // Right to left: the first column is on the right.
  const [a, b] = [(await todo.boundingBox())!, (await done.boundingBox())!];
  expect(a.x).toBeGreaterThan(b.x);

  const moved = card(todo, 'راجع الميزانية');
  await expect(moved).toBeVisible();
  const before = await done.locator('[role="article"]').count();
  const target = (await done.boundingBox())!;
  await drag(page, moved, { x: target.x + target.width / 2, y: target.y + 80 });
  await expect(card(done, 'راجع الميزانية')).toBeVisible();
  await expect(card(todo, 'راجع الميزانية')).toHaveCount(0);
  await expect(done.locator('[role="article"]')).toHaveCount(before + 1);
  // Kept: the row's status is the column's.
  await page.reload();
  await expect(card(column(fullPage(page), 'منجزة'), 'راجع الميزانية')).toBeVisible();
  expect(errors).toEqual([]);
});

test('RTL calendar: the week starts on Saturday on the right, and a row dragged to another day takes that date', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await arabicWorkspace(page);
  await newDatabase(page, 'المهام', { language: 'ar' });
  const db = fullPage(page);
  await showView(db, 'تقويم');
  const calendar = db.locator('.cgw-cal');
  await expect(calendar).toBeVisible();
  // Saturday first, on the right.
  const weekdays = calendar.locator('[role="columnheader"]');
  await expect(weekdays.first()).toHaveAttribute('aria-label', 'السبت');
  const [first, second] = [
    (await weekdays.nth(0).boundingBox())!,
    (await weekdays.nth(1).boundingBox())!,
  ];
  expect(first.x).toBeGreaterThan(second.x);

  // The template's rows are due from yesterday to a week on; one is moved two days later.
  const item = calendar.locator('[data-cal-item]').first();
  await expect(item).toBeVisible();
  const title = (await item.locator('.cgw-cal-title').innerText()).trim();
  const fromDay = await item.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const middle = box.left + box.width / 2;
    for (const cell of document.querySelectorAll<HTMLElement>('[data-day]')) {
      const r = cell.getBoundingClientRect();
      if (middle > r.left && middle < r.right && box.top > r.top && box.top < r.bottom)
        return Number(cell.dataset.day);
    }
    return null;
  });
  expect(fromDay).not.toBeNull();
  const toDay = fromDay! + 2;
  const iso = new Date(toDay * 86_400_000).toISOString().slice(0, 10);
  const cell = calendar.locator(`[data-day="${toDay}"]`);
  await expect(cell).toBeVisible();
  const target = (await cell.boundingBox())!;
  await drag(page, item, { x: target.x + target.width / 2, y: target.y + target.height / 2 });
  await expect.poll(() => onCalendarDay(calendar, title, iso)).toBe(true);
  expect(epochDay(iso)).toBe(toDay);
  // Kept across a reload.
  await page.reload();
  await showView(fullPage(page), 'تقويم');
  await expect.poll(() => onCalendarDay(fullPage(page).locator('.cgw-cal'), title, iso)).toBe(true);
  expect(errors).toEqual([]);
});
