// Phase 12: a chart view on a page shared by link, drawn as the app draws it, read only, over the
// link's database routes: its query names the view and nothing else (the server groups it by the
// view's own group and counts each group), its bars are those counts; a sum reads the view's rows
// group by group; and the server's refusal of a chart grouped or measured by what a link never
// shares (`chart.hidden`: a person's, a formula of one, a rollup out of the link's scope) is said
// once, in the chart, as the chart block says it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
// The views and the chart's drawing load lazily in the app: loaded first here.
await import('@cgw/database');
await import('../../../database/src/views/chart/ChartCanvas');
const { createI18n } = await import('../i18n');
const { SharedView } = await import('./SharedView');

const DB = '01936f6e-0000-7000-8000-00000000ac01';
const VIEW = '01936f6e-0000-7000-8000-00000000ac02';
const TOKEN = 'share-token';

const roots: { unmount(): void }[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function until(check: () => boolean, what = 'the condition') {
  for (let i = 0; i < 400 && !check(); i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const PROPERTIES = [
  { id: 'title', name: 'Name', type: 'title' },
  {
    id: 'status',
    name: 'Status',
    type: 'status',
    options: [
      { id: 'todo', name: 'To do', colour: 'gray', group: 'todo' },
      { id: 'done', name: 'Done', colour: 'green', group: 'complete' },
    ],
  },
  { id: 'amount', name: 'Amount', type: 'number' },
];

function chartView(chart: unknown) {
  return {
    id: VIEW,
    name: 'By status',
    type: 'chart',
    orderKey: 'a0',
    config: {
      filter: null,
      sorts: [],
      group: { propertyId: 'status' },
      properties: { order: ['title', 'status', 'amount'], hidden: [], widths: {} },
      chart,
    },
  };
}

/** The link's routes over a database page whose first view is `view`; queries answered by `query`. */
function serve(view: unknown, query: (body: Record<string, unknown>) => Response) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
      calls.push({ url, body });
      const path = new URL(url).pathname;
      if (path === '/api/v1/shared')
        return json({
          page: { id: DB, title: 'Tasks', icon: null },
          pages: [{ id: DB, title: 'Tasks', icon: null, parentPageId: null, kind: 'database' }],
        });
      if (path === `/api/v1/shared/databases/${DB}`)
        return json({
          database: { id: DB, title: 'Tasks', icon: null, properties: PROPERTIES },
          views: [view],
        });
      if (path === `/api/v1/shared/databases/${DB}/query`) return query(body!);
      return new Response('{}', { status: 404 });
    }),
  );
  return calls;
}

async function render() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      h(
        I18nextProvider,
        { i18n: createI18n('en') },
        h(SharedView, { apiBase: 'http://api.test', token: TOKEN, pageId: null }),
      ),
    ),
  );
  return container;
}

const row = (n: number, status: string, amount: number) => ({
  id: `${DB.slice(0, -2)}${String(n).padStart(2, '0')}`,
  databaseId: DB,
  title: `Task ${n}`,
  values: { status, amount },
});
const points = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-cg-chart-point]')].map((p) => [
    p.dataset.cgArgument,
    p.dataset.cgValue,
  ]);

describe('a chart view shared by link', () => {
  it('draws the server’s group counts, its query naming only the view', async () => {
    const calls = serve(chartView({ kind: 'bar', measure: { kind: 'count' } }), () =>
      json({
        rows: [row(1, 'todo', 5)],
        groups: [
          { key: '', count: 0 },
          { key: 'todo', count: 1200 },
          { key: 'done', count: 34 },
        ],
        total: 1234,
        next: 'cursor-1',
      }),
    );
    const container = await render();
    await until(() => points(container).length === 3, 'the bars');
    expect(points(container)).toEqual([
      ['No Status', '0'],
      ['To do', '1,200'],
      ['Done', '34'],
    ]);
    expect(container.querySelector('section.cgw-db-chart')!.getAttribute('aria-label')).toBe(
      'Chart of Count by Status',
    );
    const queries = calls.filter((c) => c.url.endsWith('/query'));
    expect(queries).toHaveLength(1);
    expect(queries[0].body).toEqual({
      viewId: VIEW,
      limit: 100,
      context: { today: expect.any(String), offsetMinutes: expect.any(Number) },
    });
    // Read only: no Properties (a chart has none), nothing new.
    const names = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(names).not.toContain('Properties');
    expect(names).not.toContain('New');
  });

  it('sums the rows group by group, by the view’s own pages', async () => {
    const byGroup: Record<string, ReturnType<typeof row>[]> = {
      todo: [row(1, 'todo', 5), row(2, 'todo', 7.5)],
      done: [row(3, 'done', 10)],
    };
    const calls = serve(
      chartView({ kind: 'line', measure: { kind: 'sum', propertyId: 'amount' } }),
      (body) => {
        const groups = [
          { key: 'todo', count: 2 },
          { key: 'done', count: 1 },
        ];
        if (typeof body.groupKey === 'string')
          return json({ rows: byGroup[body.groupKey], groups: null, total: 3, next: null });
        return json({ rows: [row(1, 'todo', 5)], groups, total: 3, next: 'more' });
      },
    );
    const container = await render();
    await until(() => points(container).length === 2, 'the line');
    await until(() => points(container)[0][1] === '12.5', 'the sums');
    expect(points(container)).toEqual([
      ['To do', '12.5'],
      ['Done', '10'],
    ]);
    // 500 rows a page, group by group (the server allows 500).
    const grouped = calls.filter((c) => c.url.endsWith('/query') && c.body!.groupKey !== undefined);
    expect(grouped.map((c) => [c.body!.groupKey, c.body!.limit])).toEqual([
      ['todo', 500],
      ['done', 500],
    ]);
  });

  it('says once, in the chart, that the link does not show a chart grouped by people', async () => {
    serve(chartView({ kind: 'bar', measure: { kind: 'count' } }), () =>
      json({ code: 'chart.hidden', title: 'Forbidden', status: 403 }, 403),
    );
    const container = await render();
    await until(
      () => !!container.querySelector('section.cgw-db-chart [role="alert"]'),
      'the refusal',
    );
    expect(container.querySelector('section.cgw-db-chart [role="alert"]')!.textContent).toBe(
      'This chart isn’t shown by this link: it’s grouped or measured by people, or by values a link doesn’t share.',
    );
    expect(container.querySelector('[data-cg-chart-point]')).toBeNull();
    // Not said again above the tabs.
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
});
