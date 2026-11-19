// Phase 12's chart view for the specs (chart-view.spec.ts, the accessibility and Arabic walks):
// where `CgChart` draws its points, the chart's words in each language, and a scene with every new
// screen on it: a database made from the Projects template (whose "Progress by status" is a chart
// view: the average progress of each status, as bars), a second chart made from the toolbar's ＋
// and set from Layout to a pie, its Layout settings open, and a chart with no group.
import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures';
import { editor } from './helpers';
import { fullPage, newDatabase, showView } from './database';
import { ar as dbAr, en as dbEn } from '../../packages/database/src/i18n/catalogues';
import { chartAr } from '../../packages/database/src/i18n/chart-ar';
import { chartEn } from '../../packages/database/src/i18n/chart-en';

/** The chart view on screen in a database's views (its section, `data-chart` its kind). */
export const chartOf = (scope: Page | Locator) => scope.locator('section.cgw-db-chart');
/** `CgChart`'s points: one per group, each with its argument and value as data attributes. */
export const pointsOf = (scope: Page | Locator) => scope.locator('[data-cg-chart-point]');

/** Each point's group and value as `CgChart` says them (`data-cg-argument`, `data-cg-value`). */
export async function pointValues(scope: Page | Locator): Promise<[string, string][]> {
  return pointsOf(scope).evaluateAll((points) =>
    points.map((p) => [
      (p as HTMLElement).dataset.cgArgument ?? '',
      (p as HTMLElement).dataset.cgValue ?? '',
    ]),
  );
}

/** The interface's words the chart's helpers use, in each language. */
export function chartWords(language: 'en' | 'ar') {
  const db = (language === 'ar' ? dbAr : dbEn).database;
  const chart = language === 'ar' ? chartAr : chartEn;
  return { db, chart, viewName: db.viewType.chart, template: db.templates.projects };
}

/** The view's Layout flyout (its chart settings), opened from the toolbar. */
export async function openLayout(page: Page, db: Locator, language: 'en' | 'ar' = 'en') {
  const { db: words } = chartWords(language);
  await db.getByRole('button', { name: words.layout.button, exact: true }).click();
  const layout = page.getByRole('dialog', { name: words.layout.title });
  await expect(layout).toBeVisible();
  return layout;
}

/**
 * A workspace on this device in `language` with a Projects database (its words in that language):
 * its chart view "Progress by status" and a second chart from the toolbar's ＋, set to a pie.
 */
export async function chartScene(page: Page, language: 'en' | 'ar' = 'en') {
  const words = chartWords(language);
  await page.goto('/');
  await page.evaluate((value) => localStorage.setItem('cgw-language', value), language);
  await page.reload();
  await page
    .locator('#cgw-workspace-name, input')
    .first()
    .fill(language === 'ar' ? 'المخططات' : 'Charts');
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeVisible();
  await newDatabase(page, words.template.name, { language });
  const db = fullPage(page);
  await showView(db, words.template.viewChart);
  await expect(pointsOf(chartOf(db)).first()).toBeVisible({ timeout: 30000 });
  // A chart from the toolbar's ＋ (`addView` in database.ts says its words in English only).
  await db.getByRole('button', { name: words.db.views.add }).click();
  await page.getByRole('menuitem', { name: words.viewName, exact: true }).click();
  await expect(db.getByRole('tab', { selected: true })).toContainText(words.viewName);
  await expect(pointsOf(chartOf(db)).first()).toBeVisible({ timeout: 30000 });
  const layout = await openLayout(page, db, language);
  await layout.getByLabel(words.chart.kind, { exact: true }).selectOption('pie');
  await page.keyboard.press('Escape');
  await expect(chartOf(db)).toHaveAttribute('data-chart', 'pie');
  return { url: page.url(), language };
}

/**
 * The scene's chart screens in the app's language now (made in `made`'s), each handed to `check`
 * once drawn: the template's bar chart, its Layout settings, the pie, and a chart with no group
 * (its group put back after).
 */
export async function chartScreens(
  page: Page,
  made: 'en' | 'ar',
  language: 'en' | 'ar',
  check: (screen: string) => Promise<void>,
) {
  const names = chartWords(made);
  const words = chartWords(language);
  const db = fullPage(page);
  await showView(db, names.template.viewChart);
  await expect(chartOf(db)).toHaveAttribute('data-chart', 'bar', { timeout: 30000 });
  await expect(pointsOf(chartOf(db)).first()).toBeVisible({ timeout: 30000 });
  await check('chart view (bars)');
  const layout = await openLayout(page, db, language);
  await expect(layout.getByLabel(words.chart.measure, { exact: true })).toHaveValue('average');
  await check('chart view’s layout');
  await page.keyboard.press('Escape');
  await expect(layout).toHaveCount(0);

  await showView(db, names.viewName);
  await expect(chartOf(db)).toHaveAttribute('data-chart', 'pie', { timeout: 30000 });
  await expect(pointsOf(chartOf(db)).first()).toBeVisible({ timeout: 30000 });
  await check('chart view (pie)');
  // No group: the chart says to choose one; then its group again.
  const status = names.template.status;
  await db
    .getByRole('button', { name: words.db.toolbar.groupBy.replace('{{name}}', status) })
    .click();
  const group = page.getByRole('dialog', { name: words.db.group.title });
  await group.getByLabel(words.db.group.by, { exact: true }).selectOption('');
  await page.keyboard.press('Escape');
  await expect(chartOf(db)).toContainText(words.chart.view.chooseGroup);
  await check('chart view with no group');
  await db.getByRole('button', { name: words.db.toolbar.group, exact: true }).click();
  await group.getByLabel(words.db.group.by, { exact: true }).selectOption({ label: status });
  await page.keyboard.press('Escape');
  await expect(pointsOf(chartOf(db)).first()).toBeVisible({ timeout: 30000 });
}
