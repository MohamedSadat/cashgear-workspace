// Phase 12 (M12.1): "a chart view draws from its database's rows in the app, on a share link and
// on a site". A database seeded through the API as a client makes it (bench/phase12-chart.mjs's
// `seedChartDatabase`: a Stage select of five options, an Amount number and Created by, row `i`
// in stage `i % 5` with an amount of `5 + (i % 7) * 10`): its first views are charts (a count of
// rows by Stage; a sum of Amount whose config hides Amount, which only a hand-made view does; a
// count by Created by, a person), then a table; and a Secret property added after them, with values.
// In the app a chart view is made from the toolbar's ＋ and drawn as bars, a line and a pie, by a
// count, a sum and an average, and drawn again as a row changes on the server; the server keeps it
// a chart. A share link draws the charts read only (a chart shows exactly its title, its group's and
// its measure's properties, whatever its config hides: the sum is drawn) and says, once, that the
// one grouped by a person is not shown by the link (the server's `chart.hidden`); a site draws the
// chart as SVG with its numbers as a table, and its placeholder for the one grouped by a person.
// The Secret property's values reach neither through a chart; a table of the same link shows them.
//
// `CgChart` draws each point as an element `[data-cg-chart-point]` whose `data-cg-argument` is its
// group and `data-cg-value` its value as the chart formats it.
import type { Browser, Page } from '@playwright/test';
import { desktop, expect, test } from './fixtures';
import { watchErrors } from './helpers';
import { newAccount, signIn, signedIn, syncStatus, type TestAccount } from './cloud';
import { addView, fullPage, showView } from './database';
import { watchAppErrors } from './ecosystem';
import { chartOf, openLayout, pointValues, pointsOf } from './chart';
import { apiSession } from '../../scripts/cloud-account.mjs';
import {
  CHART_P,
  STAGES,
  STAGE_IDS,
  chartRow,
  seedChartDatabase,
  uuidv7,
} from '../../bench/phase12-chart.mjs';

test.skip(desktop, 'Seeded and read through browser profiles; the desktop runs the same views');
test.describe.configure({ mode: 'serial' });

type Api = Awaited<ReturnType<typeof apiSession>>;
type Seeded = Awaited<ReturnType<typeof seedChartDatabase>>;

/** The Sites process in development and e2e: another host than the app's and the API's. */
const SITES = process.env.E2E_SITES_URL ?? 'http://localhost:5290';
const APP = 'http://127.0.0.1:4273';
const ROWS = 30;
/** A hand-made chart: a sum of Amount, its config showing only the title and Stage. */
const SUM = {
  name: 'Amount by stage',
  measure: { kind: 'sum', propertyId: CHART_P.amount },
  shown: ['title', CHART_P.stage],
};
/** A chart grouped by a person (Created by), whose values no link or site shows. */
const PEOPLE = { name: 'By creator', group: CHART_P.creator };
/** A property added after the charts were made: in none of their configs' `hidden`. */
const SECRET = 'Secret01';
const SECRET_ROWS = 5;

let account: TestAccount;
let api: Api;
let seeded: Seeded;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  account = await newAccount('Charts');
  api = await apiSession(account);
  seeded = await seedChartDatabase(api, {
    rows: ROWS,
    name: 'Chart space',
    title: 'Expenses',
    charts: [{ name: 'By stage' }, SUM, PEOPLE],
  });
  // The Secret property, then its values on the first rows.
  const op = (type: string, entityId: string, payload: unknown) => ({
    opId: uuidv7(),
    type,
    workspaceId: seeded.workspaceId,
    entityId,
    baseVersion: null,
    payload,
    createdAt: new Date().toISOString(),
  });
  const ops = (list: unknown[]) =>
    api.post(`/api/v1/workspaces/${seeded.workspaceId}/ops`, { ops: list });
  await ops([
    op('db.update', seeded.databaseId, {
      properties: [{ id: SECRET, name: 'Secret', type: 'text' }],
    }),
  ]);
  const first = await api.post(`/api/v1/databases/${seeded.databaseId}/query`, {
    filter: null,
    sorts: [],
    group: null,
    context: { today: '2026-11-19', offsetMinutes: 0, me: null },
    limit: SECRET_ROWS,
  });
  await ops(
    (first.rows as { id: string }[]).map((row, i) =>
      op('row.update', row.id, { values: { [SECRET]: `Secret value ${i}` } }),
    ),
  );
});
test.afterAll(async () => {
  await api?.dispose();
});

/** What each stage's point should say, from the rows' rule: a count, a sum or an average. */
function expected(
  measure: 'count' | 'sum' | 'average',
  rows = ROWS,
  moved = new Map<number, number>(),
) {
  const count = STAGES.map(() => 0);
  const sum = STAGES.map(() => 0);
  for (let i = 0; i < rows; i++) {
    const row = chartRow(i);
    const stage = moved.get(i) ?? row.stage;
    count[stage]++;
    sum[stage] += row.amount;
  }
  return STAGES.map((name, i): [string, number] => [
    name,
    hundredths(
      measure === 'count'
        ? count[i]
        : measure === 'sum'
          ? sum[i]
          : count[i]
            ? sum[i] / count[i]
            : 0,
    ),
  ]);
}
const hundredths = (n: number) => Math.round(n * 100) / 100;

/**
 * The chart's points as numbers (as the chart formats them: "1,200", "41.67"), without "No Stage"
 * (the group of rows with no stage, which has none).
 */
const stagePoints = async (scope: Parameters<typeof pointValues>[0]) =>
  (await pointValues(scope))
    .filter(([label]) => label !== 'No Stage')
    .map(([label, value]): [string, number] => [
      label,
      hundredths(Number(value.replace(/,/g, ''))),
    ]);

/** A view as the server holds it (its tree). */
type ServerView = { id: string; name: string; type: string; config: Record<string, unknown> };
async function serverView(name: string): Promise<ServerView | undefined> {
  const tree = await api.get(`/api/v1/workspaces/${seeded.workspaceId}/tree`);
  return (tree.views as ServerView[]).find((v) => v.name === name);
}

/** The database's own page, signed in. */
async function openDatabase(page: Page) {
  await page.goto('/');
  await signIn(page, account, `/#/p/${seeded.databaseId}`);
  await signedIn(page, account);
  const db = fullPage(page);
  await expect(chartOf(db)).toBeVisible({ timeout: 60_000 });
  return db;
}

test('a chart view made in the app draws the rows as bars, a line and a pie, and follows them', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  const db = await openDatabase(page);
  // The seeded first view: a count by Stage, every row in it.
  await expect.poll(() => stagePoints(db), { timeout: 30_000 }).toEqual(expected('count'));

  // A chart made here, from the toolbar's ＋: grouped by the first select (Stage), counted.
  await addView(db, page, 'Chart');
  const chart = chartOf(db);
  await expect(chart).toHaveAttribute('data-chart', 'bar');
  await expect(chart).toHaveAttribute('aria-label', 'Chart of Count by Stage');
  await expect(db.getByRole('button', { name: 'Group: Stage' })).toBeVisible();
  // It has no Properties: it shows what it draws.
  await expect(db.getByRole('button', { name: 'Properties', exact: true })).toHaveCount(0);
  await expect.poll(() => stagePoints(db)).toEqual(expected('count'));

  // From Layout: a line of the sum of Amount, then its average, then a pie.
  let layout = await openLayout(page, db);
  await layout.getByLabel('Chart', { exact: true }).selectOption('line');
  await expect(chart).toHaveAttribute('data-chart', 'line');
  await layout.getByLabel('Measure', { exact: true }).selectOption('sum');
  await expect(layout.getByLabel('Of', { exact: true })).toHaveValue(CHART_P.amount);
  await expect(chart).toHaveAttribute('aria-label', 'Chart of Sum of Amount by Stage');
  await expect.poll(() => stagePoints(db)).toEqual(expected('sum'));
  await layout.getByLabel('Measure', { exact: true }).selectOption('average');
  await expect.poll(() => stagePoints(db)).toEqual(expected('average'));
  await layout.getByLabel('Chart', { exact: true }).selectOption('pie');
  await page.keyboard.press('Escape');
  await expect(layout).toHaveCount(0);
  await expect(chart).toHaveAttribute('data-chart', 'pie');
  await expect.poll(() => stagePoints(db)).toEqual(expected('average'));

  // Back to bars of a count, titled.
  layout = await openLayout(page, db);
  await layout.getByLabel('Chart', { exact: true }).selectOption('bar');
  await layout.getByLabel('Measure', { exact: true }).selectOption('count');
  await layout.getByLabel('Title', { exact: true }).fill('Rows by stage');
  await layout.getByLabel('Title', { exact: true }).press('Enter');
  await page.keyboard.press('Escape');
  await expect(chart).toHaveAttribute('aria-label', 'Chart of Rows by stage');
  await expect(syncStatus(page)).toHaveAttribute('data-state', 'synced', { timeout: 30_000 });

  // The server holds it as a chart, its properties those it draws.
  await expect
    .poll(async () => (await serverView('Chart'))?.config.chart, { timeout: 30_000 })
    .toEqual({ kind: 'bar', measure: { kind: 'count' }, title: 'Rows by stage' });
  const held = (await serverView('Chart'))!;
  expect(held.type).toBe('chart');
  expect(held.config.group).toEqual({ propertyId: CHART_P.stage });
  expect((held.config.properties as { order: string[] }).order).toEqual(['title', CHART_P.stage]);

  // A row moved to another stage on the server: the chart draws it there.
  const answer = await api.post(`/api/v1/databases/${seeded.databaseId}/query`, {
    filter: null,
    sorts: [],
    group: null,
    search: chartRow(0).title,
    context: { today: '2026-11-19', offsetMinutes: 0, me: null },
    limit: 5,
  });
  const row = (answer.rows as { id: string; title: string }[]).find(
    (r) => r.title === chartRow(0).title,
  )!;
  const now = new Date().toISOString();
  await api.post(`/api/v1/workspaces/${seeded.workspaceId}/ops`, {
    ops: [
      {
        opId: uuidv7(),
        type: 'row.update',
        workspaceId: seeded.workspaceId,
        entityId: row.id,
        baseVersion: null,
        payload: { values: { [CHART_P.stage]: STAGE_IDS[4] } },
        createdAt: now,
      },
    ],
  });
  await expect
    .poll(() => stagePoints(db), { timeout: 30_000 })
    .toEqual(expected('count', ROWS, new Map([[0, 4]])));
  // And back, for the specs after this one.
  await api.post(`/api/v1/workspaces/${seeded.workspaceId}/ops`, {
    ops: [
      {
        opId: uuidv7(),
        type: 'row.update',
        workspaceId: seeded.workspaceId,
        entityId: row.id,
        baseVersion: null,
        payload: { values: { [CHART_P.stage]: STAGE_IDS[0] } },
        createdAt: new Date().toISOString(),
      },
    ],
  });
  await expect.poll(() => stagePoints(db), { timeout: 30_000 }).toEqual(expected('count'));
  expect(errors).toEqual([]);
});

/** A browser profile with no account. */
async function anonymous(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test('a share link draws the charts read only, by what they draw, and not one grouped by people', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const link = (await api.post(`/api/v1/pages/${seeded.databaseId}/share-links`, {
    expiresInDays: 7,
  })) as { token: string };
  const reader = await anonymous(browser);
  // The server refuses the people chart's query: the one 4xx the browser logs.
  const errors = watchAppErrors(reader.page, [/status of 403/]);
  try {
    const reads: { url: string; token: string | null; body: Record<string, unknown> | null }[] = [];
    const answers: string[] = [];
    reader.page.on('request', (r) => {
      if (r.url().includes('/api/v1/shared/databases/'))
        reads.push({
          url: r.url(),
          token: r.headers()['x-share-token'] ?? null,
          body: r.postDataJSON() as Record<string, unknown> | null,
        });
    });
    reader.page.on('response', async (r) => {
      if (r.url().includes('/api/v1/shared/databases/') && r.url().endsWith('/query'))
        answers.push(await r.text().catch(() => ''));
    });
    await reader.page.goto(`${APP}/#/s/${link.token}`);
    const db = reader.page.getByTestId('shared-database');
    // Its first view, the count by Stage, as the app draws it.
    await expect(chartOf(db)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => stagePoints(db), { timeout: 30_000 }).toEqual(expected('count'));
    await expect(chartOf(db)).toHaveAttribute('aria-label', 'Chart of Count by Stage');
    // Read only: nothing new, and its Layout changes nothing.
    await expect(db.getByRole('button', { name: 'New', exact: true })).toHaveCount(0);
    const layout = await openLayout(reader.page, db);
    await expect(layout.getByLabel('Chart', { exact: true })).toBeDisabled();
    await reader.page.keyboard.press('Escape');

    // A sum of Amount, though its config hides Amount: a chart shows what it draws.
    await showView(db, SUM.name);
    await expect(chartOf(db)).toHaveAttribute('aria-label', 'Chart of Sum of Amount by Stage');
    await expect.poll(() => stagePoints(db), { timeout: 30_000 }).toEqual(expected('sum'));

    // Grouped by a person: refused, and said once, in the chart.
    await showView(db, PEOPLE.name);
    await expect(chartOf(db).getByRole('alert')).toHaveText(
      'This chart isn’t shown by this link: it’s grouped or measured by people, or by values a link doesn’t share.',
      { timeout: 30_000 },
    );
    await expect(db.getByRole('alert')).toHaveCount(1);
    await expect(pointsOf(db)).toHaveCount(0);

    // The link's queries name the view and its pages, never a filter, sort or group; the token in
    // a header.
    const queries = reads.filter((r) => r.url.endsWith('/query'));
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(query.token).toBe(link.token);
      for (const key of Object.keys(query.body ?? {}))
        expect(['viewId', 'limit', 'context', 'groupKey', 'after', 'search']).toContain(key);
    }
    // Through the charts: never the notes, nor the property added after them.
    const charts = answers.join('');
    expect(charts).toContain(chartRow(0).title);
    expect(charts).not.toContain('Note number');
    expect(charts).not.toContain('Secret value');
    // A table of the same link shows them (the values are there to be shown).
    const before = answers.length;
    await showView(db, 'Table');
    await expect
      .poll(() => answers.slice(before).join(''), { timeout: 30_000 })
      .toContain('Secret value');
    expect(errors.filter((e) => !/status of 403/.test(e))).toEqual([]);
  } finally {
    await reader.context.close();
  }
});

/** Publishes a page as a site of its own (the API's route, as the share dialog sends it). */
async function publish(pageId: string, slug: string) {
  const site = (await api.put(`/api/v1/pages/${pageId}/site`, {
    slug,
    indexing: false,
    language: 'en',
  })) as { url: string };
  return site.url;
}

test('a site draws the chart as a figure with its numbers, and its placeholder for one grouped by people', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const slug = `chart-${Date.now().toString(36)}`;
  const address = await publish(seeded.databaseId, slug);
  expect(address).toBe(`${SITES}/${slug}`);
  // A reader with no account and no script.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const site = await context.newPage();
  try {
    const answer = (await site.goto(address))!;
    expect(answer.status()).toBe(200);
    // The database's page: its first view, the count by Stage.
    const figure = site.locator('figure.chart');
    await expect(figure.locator('figcaption')).toHaveText('Count by Stage');
    await expect(figure.locator('svg')).toHaveCount(1);
    const rows = await figure
      .locator('tbody tr')
      .evaluateAll((trs) =>
        trs.map((tr) => [
          tr.querySelector('th')!.textContent!.trim(),
          tr.querySelector('td')!.textContent!.trim(),
        ]),
      );
    // The site names the group of rows with no stage "No value" (its own words), with none in it.
    expect(rows.find(([label]) => label === 'No value')?.[1]).toBe('0');
    expect(
      rows
        .filter(([label]) => label !== 'No value')
        .map(([label, value]) => [label, hundredths(Number(value.replace(/,/g, '')))]),
    ).toEqual(expected('count'));
    // Nothing the chart does not draw: no row's title or note, nor the property added after it.
    const html = await site.content();
    expect(html).not.toContain(chartRow(1).title);
    expect(html).not.toContain('Note number');
    expect(html).not.toContain('Secret value');

    // A database whose first view is grouped by a person: its placeholder, no number of it.
    const hidden = await seedChartDatabase(api, {
      rows: 10,
      name: 'People chart space',
      title: 'People',
      charts: [PEOPLE],
    });
    const other = await publish(hidden.databaseId, `${slug}-h`);
    await site.goto(other);
    await expect(site.locator('body')).toContainText('This chart is not published');
    await expect(site.locator('figure.chart')).toHaveCount(0);
    expect(await site.content()).not.toContain(account.name);
  } finally {
    await context.close();
    await api.del(`/api/v1/pages/${seeded.databaseId}/site`).catch(() => undefined);
  }
});
