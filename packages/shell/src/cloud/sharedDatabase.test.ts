// Phase 9: databases on a page shared by link. The host reads the database and its views by the
// link's route, and rows by the view alone: a query sends the view's id, paging and the title
// search, never a filter, sort or group (whatever the view's spec holds). A view grouped as it is
// stored pages by the server's groups; a chart's or a board block's own grouping gathers the
// rows and groups them here. Nothing is written, nobody is named, row pages do not open, related
// titles come from the answer; the routes carry the token in a header and never a cookie.
import { describe, expect, it, vi } from 'vitest';
import type { RowSnapshot } from '@cgw/database';
import type { QuerySpec } from '@cgw/workspace';
import {
  GATHER_LIMIT,
  SharedDatabaseHost,
  SharedReadError,
  sharedDatabaseApi,
  type SharedDatabaseAnswer,
  type SharedDatabaseApi,
  type SharedQuery,
  type SharedQueryAnswer,
} from './sharedDatabase';

const DB = '01936f6e-0000-7000-8000-00000000d001';
const TABLE = '01936f6e-0000-7000-8000-00000000d002';
const BOARD = '01936f6e-0000-7000-8000-00000000d003';
const OTHER_DB = '01936f6e-0000-7000-8000-00000000d0ff';
const STATUS = 'status';
const AREA = 'area';

const properties = [
  { id: 'title', name: 'Name', type: 'title' },
  {
    id: STATUS,
    name: 'Status',
    type: 'select',
    options: [
      { id: 'todo', name: 'To do', color: 'gray' },
      { id: 'done', name: 'Done', color: 'green' },
    ],
  },
  {
    id: AREA,
    name: 'Area',
    type: 'select',
    options: [
      { id: 'north', name: 'North', color: 'blue' },
      { id: 'south', name: 'South', color: 'red' },
    ],
  },
];

const config = (group: unknown = null) => ({
  filter: { kind: 'group', op: 'and', children: [] },
  sorts: [],
  group,
  properties: { order: [], hidden: [], widths: {} },
});

const answer: SharedDatabaseAnswer = {
  database: { id: DB, title: 'Tasks', icon: '✅', properties, workspaceId: 'ws' },
  views: [
    {
      id: BOARD,
      name: 'Board',
      type: 'board',
      orderKey: 'a1',
      config: config({ propertyId: STATUS }),
    },
    { id: TABLE, name: 'Table', type: 'table', orderKey: 'a0', config: config() },
  ],
};

const row = (n: number, status: string, area: string) => ({
  id: `01936f6e-0000-7000-8000-${String(n).padStart(12, '0')}`,
  databaseId: DB,
  title: `Task ${n}`,
  orderKey: `a${n}`,
  values: { [STATUS]: status, [AREA]: area },
  computed: {},
});

/** A fake of the link's routes: 7 rows, paged, grouped by status on the board view. */
function fakeApi(total = 7) {
  const rows = Array.from({ length: total }, (_, i) =>
    row(i + 1, i % 2 ? 'done' : 'todo', i < 3 ? 'north' : 'south'),
  );
  const queries: SharedQuery[] = [];
  const api: SharedDatabaseApi = {
    database: vi.fn(async (id: string) => {
      if (id !== DB) throw new SharedReadError(404, 'not.found');
      return answer;
    }),
    query: vi.fn(async (_id: string, query: SharedQuery): Promise<SharedQueryAnswer> => {
      queries.push(query);
      const board = query.viewId === BOARD;
      let list = rows.filter((r) => !query.search || r.title.includes(query.search));
      if (query.groupKey !== undefined)
        list = list.filter((r) => r.values[STATUS] === query.groupKey);
      const start = query.after ? Number(query.after) : 0;
      const limit = query.limit ?? 100;
      const page = list.slice(start, start + limit);
      const end = start + page.length;
      return {
        rows: page,
        groups: board
          ? ['todo', 'done', ''].map((key) => ({
              key,
              count: rows.filter((r) => (r.values[STATUS] ?? '') === key).length,
            }))
          : null,
        total: list.length,
        next: end < list.length ? String(end) : null,
        titles: { [OTHER_DB]: 'A related row' },
      };
    }),
  };
  return { api, queries };
}

const hostOf = (api: SharedDatabaseApi) =>
  new SharedDatabaseHost(api, {
    pageTitle: (id) => (id === DB ? 'Tasks' : undefined),
    openPage: vi.fn(),
  });

async function until(check: () => boolean, what = 'the condition') {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

async function settled(
  source: { snapshot(): RowSnapshot },
  check: (s: RowSnapshot) => boolean = () => true,
) {
  await until(() => !source.snapshot().loading && check(source.snapshot()), 'a settled snapshot');
  return source.snapshot();
}

describe('a database read by a share link', () => {
  it('reads the database and its views in their order, read only and naming no one', async () => {
    const { api } = fakeApi();
    const host = hostOf(api);
    expect(host.database(DB)).toBeNull();
    await until(() => !!host.database(DB), 'the database');
    expect(host.database(DB)!.properties.map((p) => p.id)).toEqual(['title', STATUS, AREA]);
    expect(host.views(DB).map((v) => v.name)).toEqual(['Table', 'Board']);
    expect(host.page(DB)).toMatchObject({ kind: 'database', title: 'Tasks', icon: '✅' });
    expect(host.canEdit()).toBe(false);
    expect(host.me()).toBeNull();
    expect(host.people()).toEqual([]);
    expect(host.rowTemplates()).toEqual([]);
    expect(host.databases()).toEqual([]);
    await expect(host.apply()).rejects.toThrow('access.denied');
    // Row pages stay closed.
    host.openRow();
    // The database answers only once.
    host.database(DB);
    expect(api.database).toHaveBeenCalledTimes(1);
  });

  it('sends the view, paging and search, never a filter, sort or group', async () => {
    const { api, queries } = fakeApi(150);
    const host = hostOf(api);
    await until(() => !!host.database(DB), 'the database');
    const spec: QuerySpec = {
      filter: {
        kind: 'group',
        op: 'and',
        children: [{ kind: 'condition', propertyId: STATUS, op: 'is', value: 'done' } as never],
      },
      sorts: [{ propertyId: AREA, direction: 'desc' }],
      group: null,
      search: 'Task 1',
    };
    const source = host.rows(DB, { viewId: TABLE, spec, pageSize: 50 });
    const first = await settled(source);
    const context = {
      today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      offsetMinutes: expect.any(Number),
    };
    expect(queries[0]).toEqual({ viewId: TABLE, limit: 50, search: 'Task 1', context });
    expect(Object.keys(queries[0]).sort()).toEqual(['context', 'limit', 'search', 'viewId']);
    expect(first.rows.every((r) => r.title.includes('Task 1'))).toBe(true);
    expect(first.complete).toBe(false);
    source.loadMore();
    const second = await settled(source, (s) => s.rows.length > first.rows.length);
    expect(queries[1]).toEqual({
      viewId: TABLE,
      after: '50',
      limit: 50,
      search: 'Task 1',
      context,
    });
    expect(second.total).toBe(first.total);
    // Related rows' titles come from the answer; rows read come with nobody named.
    expect(host.pageTitle(OTHER_DB)).toBe('A related row');
    expect(host.page(second.rows[0].id)).toMatchObject({
      kind: 'row',
      createdBy: null,
      updatedBy: null,
    });
    source.close();
  });

  it('sends a calendar’s or a timeline’s window, and asks its undated rows by the flag', async () => {
    const { api, queries } = fakeApi(10);
    const host = hostOf(api);
    await until(() => !!host.database(DB), 'the database');
    const window = { propertyId: AREA, from: '2026-12-01', to: '2026-12-31' };
    const dated = host.rows(DB, {
      viewId: TABLE,
      spec: { filter: null, sorts: [], group: null, window },
    });
    await settled(dated);
    expect(queries[0]).toMatchObject({ viewId: TABLE, window });
    expect(queries[0]).not.toHaveProperty('undated');
    dated.close();
    // The no-date list's own filter is never sent: the flag names it, and the server applies the
    // view's date property itself.
    const undated = host.rows(DB, {
      viewId: TABLE,
      spec: {
        filter: {
          kind: 'group',
          op: 'and',
          children: [{ kind: 'condition', propertyId: AREA, operator: 'isEmpty' }],
        },
        sorts: [],
        group: null,
      },
      undated: AREA,
    });
    await settled(undated);
    expect(queries[1]).toMatchObject({ viewId: TABLE, undated: true });
    expect(queries[1]).not.toHaveProperty('filter');
    expect(queries[1]).not.toHaveProperty('window');
    undated.close();
  });

  it('pages a view grouped as it is stored by the server’s groups', async () => {
    const { api, queries } = fakeApi();
    const host = hostOf(api);
    await until(() => !!host.database(DB), 'the database');
    const source = host.rows(DB, {
      viewId: BOARD,
      spec: { filter: null, sorts: [], group: { propertyId: STATUS, hidden: [''] } },
      pageSize: 2,
    });
    const first = await settled(source);
    // The server's counts, not this page's; its hidden group left out.
    expect(first.groups!.map((g) => [g.key, g.count])).toEqual([
      ['todo', 4],
      ['done', 3],
    ]);
    expect(first.total).toBe(7);
    source.loadMore('done');
    await settled(source, () => queries.length > 1);
    expect(queries[1]).toMatchObject({ viewId: BOARD, groupKey: 'done', limit: 2 });
    expect(Object.keys(queries[1]).sort()).toEqual(['context', 'groupKey', 'limit', 'viewId']);
    source.close();
  });

  it('gathers the rows of a block that groups another way, and groups them here', async () => {
    const { api, queries } = fakeApi(1200);
    const host = hostOf(api);
    await until(() => !!host.database(DB), 'the database');
    const source = host.rows(DB, {
      viewId: TABLE,
      spec: { filter: null, sorts: [], group: { propertyId: AREA } },
      pageSize: 1,
    });
    const snapshot = await settled(source, (s) => s.complete);
    // Every page asked for, at the server's most rows a page, the view's id and nothing else.
    expect(queries.map((q) => q.after ?? null)).toEqual([null, '500', '1000']);
    expect(queries.every((q) => q.viewId === TABLE && q.limit === 500 && !('groupKey' in q))).toBe(
      true,
    );
    const counts = Object.fromEntries(snapshot.groups!.map((g) => [g.key, g.count]));
    expect(counts).toMatchObject({ north: 3, south: 1197 });
    expect(snapshot.total).toBe(1200);
    // More rows than are gathered: stops at the limit.
    expect(GATHER_LIMIT).toBeGreaterThanOrEqual(1000);
    source.close();
  });

  it('says a database the link cannot read is missing', async () => {
    const { api } = fakeApi();
    const host = hostOf(api);
    const source = host.rows(OTHER_DB, {
      viewId: null,
      spec: { filter: null, sorts: [], group: null },
    });
    const snapshot = await settled(source);
    expect(snapshot.error).toBe('access.denied');
    expect(host.database(OTHER_DB)).toBeNull();
  });
});

describe('the link’s database routes', () => {
  it('carry the token in a header, and never a cookie', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      if (String(url).endsWith('/query'))
        return new Response(JSON.stringify({ rows: [], groups: null, total: 0, next: null }));
      return new Response(JSON.stringify({ code: 'not.found' }), { status: 404 });
    });
    const api = sharedDatabaseApi('http://api.test', 'TOKEN', fetcher as never);
    await api.query(DB, { viewId: TABLE, limit: 10 });
    expect(calls[0].url).toBe(`http://api.test/api/v1/shared/databases/${DB}/query`);
    expect(calls[0].init).toMatchObject({ method: 'POST', credentials: 'omit' });
    expect((calls[0].init.headers as Record<string, string>)['X-Share-Token']).toBe('TOKEN');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ viewId: TABLE, limit: 10 });
    await expect(api.database(DB)).rejects.toMatchObject({ status: 404, code: 'not.found' });
    expect(calls[1]).toMatchObject({ init: { method: 'GET', credentials: 'omit' } });
  });
});
