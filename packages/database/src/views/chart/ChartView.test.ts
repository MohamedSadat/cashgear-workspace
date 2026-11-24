// The chart view drawn in jsdom over the in-memory host (Phase 12): the seventh view type, a new
// chart's settings (grouped by status, a count, only the title and the group shown), a bar per
// group with the query's counts, sums and averages read by a query of their own (500 a page), the
// drawing changing as rows change, a pie leaving out empty groups, its layout settings writing one
// `view.upsert` each with the properties kept to what it draws, the toolbar's Group keeping them
// too, no group, no rows, a share link's refusal, a reader (the chart, no change) and Arabic.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDom } from '../../testing/dom';

installDom();
const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { newOp } = await import('@cgw/workspace');
const { DatabaseView } = await import('../../DatabaseView');
const { createDatabaseI18n } = await import('../../i18n');
const { seed, P } = await import('../../testing/fixtures');
const { VIEW_TYPES, VIEW_ORDER } = await import('../registry');
// The drawing loads on its own in the app: loaded first here, so Suspense resolves at once.
await import('./ChartCanvas');
type ViewConfig = import('@cgw/workspace').ViewConfig;
type RowSource = import('../../host').RowSource;
type RowSnapshot = import('../../host').RowSnapshot;

type Root = ReturnType<typeof createRoot>;
type Request = { viewId: string | null; spec: Record<string, unknown>; pageSize?: number };
let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  document.documentElement.dir = 'ltr';
});
afterAll(() => (window as unknown as { close(): void }).close());

const flush = (times = 3) =>
  act(async () => {
    for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount(node: ReturnType<typeof h>, language: 'en' | 'ar' = 'en') {
  const i18n = createDatabaseI18n(language);
  document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  container.setAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
  root = createRoot(container);
  await act(async () => root!.render(h(I18nextProvider, { i18n }, node)));
  await settle();
}
/** Until the drawing is in (no "Drawing the chart…" left) and the host's answers are drawn. */
async function settle() {
  for (let i = 0; i < 40; i++) {
    await flush();
    if (!container.querySelector('.cgw-db-chart-drawing, .cgw-db-chart-message[aria-busy]')) break;
  }
  await flush();
}
async function click(target: Element) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
  await settle();
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
const button = (text: string, root: ParentNode = document) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text);
/** A select by its label's text, wherever it is drawn (a flyout is outside the container). */
const select = (label: string) => {
  const found = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
  return document.getElementById(found!.htmlFor) as HTMLSelectElement;
};

/** A seeded Tasks database (today 13 November 2026) shown as a chart. */
async function chartView(
  rows: number,
  config: Partial<ViewConfig> = {},
  options: { canEdit?: boolean; pageSize?: number | null } = {},
) {
  const s = seed(rows, {
    today: '2026-11-13',
    canEdit: options.canEdit,
    pageSize: options.pageSize,
  });
  const database = s.host.database(s.tasksId)!;
  const base = s.host.views(s.tasksId)[0];
  const id = s.host.newId();
  await s.host.apply([
    newOp('view.upsert', base.workspaceId, id, {
      ...base,
      id,
      name: 'Chart',
      type: 'chart',
      orderKey: 'a1',
      config: { ...VIEW_TYPES.chart.defaultConfig(database), ...config },
    }),
  ]);
  s.host.applied.length = 0;
  const requests: Request[] = [];
  const rowsOf = s.host.rows.bind(s.host);
  s.host.rows = (databaseId, request) => {
    if (databaseId === s.tasksId) requests.push(JSON.parse(JSON.stringify(request)) as Request);
    return rowsOf(databaseId, request);
  };
  return {
    ...s,
    id,
    requests,
    viewOf: () => s.host.views(s.tasksId).find((v) => v.id === id)!,
    view: h(DatabaseView, { host: s.host, databaseId: s.tasksId, viewId: id }),
  };
}
const upserts = (host: { applied: { type: string; payload: unknown }[] }) =>
  host.applied.filter((op) => op.type === 'view.upsert').map((op) => op.payload as never) as {
    config: ViewConfig;
  }[];
/** The chart's points as `CgChart` draws them: each one's argument and value. */
const points = () =>
  [...container.querySelectorAll<HTMLElement>('[data-cg-chart-point]')].map((p) => [
    p.dataset.cgArgument,
    p.dataset.cgValue,
  ]);
const statusCounts = (
  host: { rowsOf(id: string): { values: Record<string, unknown> }[] },
  id: string,
) => {
  const counts = new Map<string, number>();
  for (const row of host.rowsOf(id)) {
    const status = row.values[P.status] as string;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return counts;
};

describe('the chart view', () => {
  it('is the seventh view type: grouped by the toolbar, its own layout, no Properties', () => {
    // The seventh; Phase 16's form is after it.
    expect(VIEW_ORDER[6]).toBe('chart');
    const chart = VIEW_TYPES.chart;
    expect(chart.supports).toEqual({ group: true, wrap: false, properties: false });
    expect(chart.settings).toBeTypeOf('function');
    expect(chart.ownRows).toBeFalsy();
    const s = seed(3);
    const config = chart.defaultConfig(s.host.database(s.tasksId)!);
    expect(config.group).toEqual({ propertyId: P.status });
    expect(config.chart).toEqual({ kind: 'bar', measure: { kind: 'count' }, title: null });
    // Only what the chart draws is shown: the title and the group.
    expect(config.properties.order).toEqual(['title', P.status]);
    expect(config.properties.hidden).toContain(P.amount);
    expect(config.properties.hidden).not.toContain(P.status);
    expect(config.properties.hidden).not.toContain('title');
  });

  it('draws a bar per status, counted by the query, in its group order', async () => {
    const s = await chartView(40);
    await mount(s.view);
    const section = container.querySelector<HTMLElement>('section.cgw-db-chart')!;
    expect(section.dataset.chart).toBe('bar');
    expect(section.getAttribute('aria-label')).toBe('Chart of Count by Status');
    expect(section.textContent).toContain('Count by Status');
    const counts = statusCounts(s.host, s.tasksId);
    expect(points()).toEqual([
      ['No Status', '0'],
      ['Not started', String(counts.get('stTodo01') ?? 0)],
      ['In progress', String(counts.get('stDoing1') ?? 0)],
      ['Done', String(counts.get('stDone01') ?? 0)],
    ]);
    // A count reads only the view's own query: nothing of its own.
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0].spec.group).toEqual({ propertyId: P.status });
  });

  it('changes as the rows change', async () => {
    const s = await chartView(12);
    await mount(s.view);
    const before = statusCounts(s.host, s.tasksId);
    const row = s.host.rowsOf(s.tasksId).find((r) => r.values[P.status] !== 'stDone01')!;
    await act(async () => {
      await s.host.apply([
        newOp('row.update', row.workspaceId, row.id, { values: { [P.status]: 'stDone01' } }),
      ]);
    });
    await settle();
    const done = points().find(([label]) => label === 'Done')!;
    expect(done[1]).toBe(String((before.get('stDone01') ?? 0) + 1));
  });

  it('sums and averages a number by a query of its own, 500 rows a page', async () => {
    const s = await chartView(30, {
      chart: { kind: 'line', measure: { kind: 'sum', propertyId: P.amount }, title: null },
    });
    await mount(s.view);
    const own = s.requests.filter((r) => r.pageSize === 500);
    expect(own).toHaveLength(1);
    expect(own[0].spec.group).toEqual({ propertyId: P.status });
    const sums = new Map<string, number>();
    for (const row of s.host.rowsOf(s.tasksId)) {
      const status = row.values[P.status] as string;
      sums.set(status, (sums.get(status) ?? 0) + ((row.values[P.amount] as number) ?? 0));
    }
    const drawn = new Map(points().map(([label, value]) => [label, value]));
    expect(container.querySelector<HTMLElement>('section.cgw-db-chart')!.dataset.chart).toBe(
      'line',
    );
    expect(container.textContent).toContain('Sum of Amount by Status');
    const todo = Number(drawn.get('Not started')!.replace(/,/g, ''));
    expect(todo).toBeCloseTo(sums.get('stTodo01') ?? 0, 2);
  });

  it('reads every group’s rows page by page for a sum, up to the cap', async () => {
    const s = await chartView(
      60,
      { chart: { kind: 'bar', measure: { kind: 'average', propertyId: P.amount }, title: null } },
      { pageSize: 10 },
    );
    await mount(s.view);
    await settle();
    const own = s.requests.filter((r) => r.pageSize === 500);
    expect(own).toHaveLength(1);
    // Every group complete: no "Based on the first …" note.
    expect(container.textContent).not.toContain('Based on the first');
    const averages = new Map<string, number[]>();
    for (const row of s.host.rowsOf(s.tasksId)) {
      const status = row.values[P.status] as string;
      averages.set(status, [...(averages.get(status) ?? []), row.values[P.amount] as number]);
    }
    const doing = averages.get('stDoing1')!;
    const drawn = new Map(points().map(([label, value]) => [label, value]));
    expect(Number(drawn.get('In progress')!.replace(/,/g, ''))).toBeCloseTo(
      doing.reduce((a, b) => a + b, 0) / doing.length,
      1,
    );
  });

  it('leaves the empty groups out of a pie', async () => {
    const s = await chartView(20, {
      chart: { kind: 'pie', measure: { kind: 'count' }, title: 'Tasks by status' },
    });
    await mount(s.view);
    const section = container.querySelector<HTMLElement>('section.cgw-db-chart')!;
    expect(section.dataset.chart).toBe('pie');
    expect(section.getAttribute('aria-label')).toBe('Chart of Tasks by status');
    expect(points().map(([label]) => label)).not.toContain('No Status');
  });

  it('writes its kind, measure and title from Layout, one view.upsert each, its properties kept', async () => {
    const s = await chartView(10);
    await mount(s.view);
    expect(button('Properties', container)).toBeUndefined();
    await click(button('Layout', container)!);
    await choose(select('Chart'), 'pie');
    expect(upserts(s.host)).toHaveLength(1);
    expect(s.viewOf().config.chart).toMatchObject({ kind: 'pie' });
    await choose(select('Measure'), 'sum');
    const measured = s.viewOf().config;
    expect(measured.chart!.measure).toEqual({ kind: 'sum', propertyId: P.amount });
    // The measure's property is shown with the title and the group; every other hidden.
    expect(measured.properties.order).toEqual(['title', P.status, P.amount]);
    expect(measured.properties.hidden).not.toContain(P.amount);
    expect(measured.properties.hidden).toContain(P.notes);
    await choose(select('Of'), P.double);
    expect(s.viewOf().config.chart!.measure).toEqual({ kind: 'sum', propertyId: P.double });
    expect(s.viewOf().config.properties.hidden).toContain(P.amount);
    const title = document.getElementById(
      [...document.querySelectorAll('label')].find((l) => l.textContent === 'Title')!.htmlFor,
    ) as HTMLInputElement;
    await act(async () => {
      title.value = 'Money by status';
      title.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      title.dispatchEvent(new FocusEvent('blur'));
    });
    await settle();
    expect(s.viewOf().config.chart!.title).toBe('Money by status');
    expect(upserts(s.host)).toHaveLength(4);
    // Back to a count: the measure's property is hidden again.
    await choose(select('Measure'), 'count');
    expect(s.viewOf().config.properties.order).toEqual(['title', P.status]);
    expect(s.viewOf().config.properties.hidden).toContain(P.double);
  });

  it('keeps its properties when the toolbar’s Group changes its group', async () => {
    const s = await chartView(10);
    await mount(s.view);
    await click(button('Group: Status', container)!);
    await choose(select('Group by'), P.priority);
    const config = s.viewOf().config;
    expect(config.group).toEqual({ propertyId: P.priority });
    expect(config.properties.order).toEqual(['title', P.priority]);
    expect(config.properties.hidden).toContain(P.status);
    expect(upserts(s.host)).toHaveLength(1);
  });

  it('asks for a group when it has none, and says no rows when none match', async () => {
    const s = await chartView(6, { group: null });
    await mount(s.view);
    expect(container.textContent).toContain(
      'A chart draws its rows by a group: choose a property in Group, in the toolbar.',
    );
    await act(async () => root?.unmount());
    root = null;
    const empty = await chartView(6, {
      filter: {
        kind: 'group',
        op: 'and',
        children: [{ kind: 'condition', propertyId: 'title', operator: 'is', value: 'nothing' }],
      },
    });
    await mount(empty.view);
    // Every status still has its group (of no rows): nothing to draw.
    expect(container.querySelector('[data-cg-chart-point]')).toBeNull();
    const section = container.querySelector('section.cgw-db-chart')!;
    expect(section.textContent).toContain('Count by Status');
    expect(section.textContent).toContain('No rows to chart.');
  });

  it('says its failures itself, once: a share link’s refusal in its words, else Try again', async () => {
    const s = await chartView(6);
    let error = 'chart.hidden';
    let retried = 0;
    const failed = (): RowSnapshot => ({
      rows: [],
      groups: null,
      total: 0,
      complete: true,
      localOnly: false,
      loading: false,
      error,
    });
    s.host.rows = (): RowSource => {
      const snapshot = failed();
      return {
        snapshot: () => snapshot,
        subscribe: () => () => undefined,
        loadMore: () => undefined,
        retry: () => void retried++,
        close: () => undefined,
      };
    };
    await mount(s.view);
    // A chart grouped or measured by what a link never shares: said in the chart, with no retry,
    // and not again above the tabs.
    const alerts = () => [...container.querySelectorAll('[role="alert"]')];
    expect(alerts().map((a) => a.textContent)).toEqual([
      'This chart isn’t shown by this link: it’s grouped or measured by people, or by values a link doesn’t share.',
    ]);
    expect(alerts()[0].closest('section.cgw-db-chart')).not.toBeNull();
    expect(alerts()[0].querySelector('button')).toBeNull();
    expect(container.querySelector('.cgw-db-notice.cgw-db-error')).toBeNull();
    expect(container.querySelector('[data-cg-chart-point]')).toBeNull();
    // Any other failure: Rows could not be loaded, and Try again asks the view's query again.
    await act(async () => root?.unmount());
    error = 'offline';
    root = null;
    await mount(s.view);
    expect(alerts().map((a) => a.textContent)).toEqual(['Rows could not be loaded.Try again']);
    await click(button('Try again', container)!);
    expect(retried).toBe(1);
  });

  it('is drawn for a reader, whose layout settings change nothing', async () => {
    const s = await chartView(8, {}, { canEdit: false });
    await mount(s.view);
    expect(points().length).toBeGreaterThan(0);
    expect(button('Properties', container)).toBeUndefined();
    await click(button('Layout', container)!);
    expect(select('Chart').disabled).toBe(true);
    expect(select('Measure').disabled).toBe(true);
    expect(s.host.applied).toEqual([]);
    await act(async () => root?.unmount());
    root = null;
    const none = await chartView(4, { group: null }, { canEdit: false });
    await mount(none.view);
    expect(container.textContent).toContain('This chart has no property to group by yet.');
  });

  it('is drawn in Arabic', async () => {
    const s = await chartView(10);
    await mount(s.view, 'ar');
    const section = container.querySelector('section.cgw-db-chart')!;
    expect(section.textContent).toContain('العدد حسب');
    expect(points().length).toBe(4);
    expect(button('التخطيط', container)).toBeDefined();
    expect(container.textContent).not.toContain('Count by');
  });
});
