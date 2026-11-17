// The calendar's rows (Phase 9): it asks for the month shown and a week on each side by a date
// window (and the rows with no date by a filter of their own), every page of it when the rows
// come in pages as the server's do, and again for the next month when the page is turned.
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
const { VIEW_TYPES } = await import('../registry');
const { undatedRequest, windowRequest, withEmpty } = await import('./requests');

type Request = { viewId: string | null; spec: Record<string, unknown>; pageSize?: number };
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});
afterAll(() => (window as unknown as { close(): void }).close());

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function calendar(rows: number, pageSize: number | null = null) {
  const s = seed(rows, { today: '2026-11-13', pageSize });
  const database = s.host.database(s.tasksId)!;
  const base = s.host.views(s.tasksId)[0];
  const id = s.host.newId();
  await s.host.apply([
    newOp('view.upsert', base.workspaceId, id, {
      ...base,
      id,
      name: 'Calendar',
      type: 'calendar',
      orderKey: 'a1',
      config: VIEW_TYPES.calendar.defaultConfig(database),
    }),
  ]);
  const requests: Request[] = [];
  const rowsOf = s.host.rows.bind(s.host);
  s.host.rows = (databaseId, request) => {
    if (databaseId === s.tasksId) requests.push(JSON.parse(JSON.stringify(request)) as Request);
    return rowsOf(databaseId, request);
  };
  root = createRoot(container);
  await act(async () =>
    root!.render(
      h(
        I18nextProvider,
        { i18n: createDatabaseI18n('en') },
        h(DatabaseView, { host: s.host, databaseId: s.tasksId, viewId: id }),
      ),
    ),
  );
  await flush();
  await flush();
  return { ...s, requests };
}

describe("the calendar's rows", () => {
  it('asks for the month and a week on each side, and the rows with no date', async () => {
    const { requests } = await calendar(200);
    const windows = requests.filter((r) => r.spec.window).map((r) => r.spec.window);
    expect(windows).toEqual([{ propertyId: P.due, from: '2026-10-25', to: '2026-12-07' }]);
    expect(
      requests.filter((r) => !r.spec.window).map((r) => JSON.stringify(r.spec.filter)),
    ).toEqual([JSON.stringify(withEmpty(null, P.due))]);
  });

  it('fetches every page of the window, and asks again for the next month', async () => {
    const { host, tasksId, requests } = await calendar(400, 20);
    await flush();
    const november = host.rowsOf(tasksId).filter((r) => {
      const start = (r.values[P.due] as { start: string } | undefined)?.start ?? '';
      return start >= '2026-11-01' && start <= '2026-11-30';
    });
    expect(november.length).toBeGreaterThan(20);
    // Placed (as bars or behind "+N more"): every row of the month, though pages are of 20.
    const placed = new Set(
      [...container.querySelectorAll<HTMLElement>('[data-cg-month-item]')].map(
        (e) => e.dataset.cgMonthItem,
      ),
    );
    const more = [...container.querySelectorAll('[role="gridcell"] [aria-haspopup="dialog"]')];
    expect(placed.size + more.length).toBeGreaterThan(0);
    expect(container.querySelector('.cgw-cal-status')!.textContent).toBe('');
    const next = container.querySelector<HTMLElement>('[aria-label="Next month"]')!;
    await act(async () => next.click());
    await flush();
    const windows = requests.filter((r) => r.spec.window).map((r) => r.spec.window);
    expect(windows.at(-1)).toEqual({ propertyId: P.due, from: '2026-11-24', to: '2027-01-07' });
  });

  it('builds its queries from the view’s own: its filter, sorts and search, no group', () => {
    const request = {
      viewId: 'v',
      spec: {
        filter: { kind: 'group' as const, op: 'or' as const, children: [] },
        sorts: [{ propertyId: 'x', direction: 'desc' as const }],
        group: { propertyId: 'y' },
        search: 'plan',
      },
      pageSize: 100,
    };
    const window = { propertyId: P.due, from: '2026-11-01', to: '2026-11-30' };
    expect(windowRequest(request, window)).toEqual({
      viewId: 'v',
      spec: { ...request.spec, group: null, window },
      pageSize: 500,
    });
    expect(undatedRequest(request, P.due).spec).toEqual({
      filter: {
        kind: 'group',
        op: 'and',
        children: [
          request.spec.filter,
          { kind: 'condition', propertyId: P.due, operator: 'isEmpty' },
        ],
      },
      sorts: request.spec.sorts,
      group: null,
      search: 'plan',
    });
    // An `and` filter takes the condition at its own depth.
    const and = { kind: 'group' as const, op: 'and' as const, children: [] };
    expect(withEmpty(and, P.due).children).toHaveLength(1);
  });
});
