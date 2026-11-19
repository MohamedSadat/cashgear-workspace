// The SyncApi over HTTP against a scripted fetch: `Retry-After` on 429 and 503, and the two
// Phase 3 routes (the state hash and the repair) with their shapes.
import { createApi } from '@cgw/api';
import { describe, expect, it } from 'vitest';
import { SyncHttpError } from './api';
import { fromBase64, httpSyncApi, retryAfterMs, toBase64 } from './http';

const PAGE = '0193a1b2-c3d4-7e5f-8a9b-000000000001';

function server(answer: (request: Request) => Promise<Response> | Response) {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const api = createApi({
    baseUrl: 'https://api.test',
    auth: { kind: 'bearer', token: async () => 'token' },
    fetch: (async (input: Request) => {
      const text = input.method === 'GET' ? '' : await input.clone().text();
      seen.push({ method: input.method, url: input.url, body: text ? JSON.parse(text) : null });
      return answer(input);
    }) as typeof fetch,
  });
  return { sync: httpSyncApi(api), seen };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const pull = {
  epoch: 2,
  schemaVersion: 1,
  headSeq: '9',
  cursor: 9,
  more: false,
  snapshot: null,
  updates: [{ seq: 9, updateId: PAGE, data: toBase64(new Uint8Array([1, 2, 3])) }],
  rejected: [],
};

describe('http sync api', () => {
  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('120')).toBe(120_000);
    expect(retryAfterMs(' 0 ')).toBe(0);
    const at = Date.UTC(2026, 10, 12, 10, 0, 0);
    expect(retryAfterMs(new Date(at + 30_000).toUTCString(), at)).toBe(30_000);
    expect(retryAfterMs(new Date(at - 30_000).toUTCString(), at)).toBe(0);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs('soon')).toBeUndefined();
  });

  it('gives a 429 and a 503 their Retry-After, and nothing else one', async () => {
    let status = 429;
    const { sync } = server(() =>
      json(
        status,
        { code: status === 429 ? 'limit.rate' : 'server.unavailable' },
        {
          'Retry-After': '7',
        },
      ),
    );
    const caught = async () => {
      try {
        await sync.pullDoc(PAGE, 0);
      } catch (error) {
        return error as SyncHttpError;
      }
      throw new Error('no error');
    };
    expect(await caught()).toMatchObject({ status: 429, code: 'limit.rate', retryAfterMs: 7000 });
    status = 503;
    expect(await caught()).toMatchObject({ status: 503, retryAfterMs: 7000 });
    status = 500;
    const plain = await caught();
    expect(plain).toBeInstanceOf(SyncHttpError);
    expect(plain.retryAfterMs).toBeUndefined();
  });

  it('asks for the state hash', async () => {
    const { sync, seen } = server(() => json(200, { epoch: 2, upToSeq: '9', hash: 'ab' }));
    expect(await sync.docStateHash(PAGE)).toEqual({ epoch: 2, upToSeq: 9, hash: 'ab' });
    expect(seen[0]).toMatchObject({
      method: 'GET',
      url: `https://api.test/api/v1/pages/${PAGE}/doc/state-hash`,
    });
  });

  it('sends a repair with the full state, or none, and reads the pull from the start', async () => {
    const { sync, seen } = server(() => json(200, { ack: { updateId: PAGE, seq: '10' }, pull }));
    const answer = await sync.repairDoc(PAGE, {
      epoch: 2,
      clientSchemaVersion: 1,
      update: { updateId: PAGE, data: new Uint8Array([9, 8]) },
    });
    expect(answer.ack).toEqual({ updateId: PAGE, seq: 10 });
    expect(answer.pull).toMatchObject({ epoch: 2, headSeq: 9, cursor: 9, more: false });
    expect([...answer.pull.updates[0].data]).toEqual([1, 2, 3]);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: `https://api.test/api/v1/pages/${PAGE}/doc/repair`,
    });
    const body = seen[0].body as { update: { data: string } };
    expect([...fromBase64(body.update.data)]).toEqual([9, 8]);
    await sync.repairDoc(PAGE, { epoch: 2, clientSchemaVersion: 1, update: null });
    expect(seen[1].body).toEqual({ epoch: 2, clientSchemaVersion: 1, update: null });
  });

  // Phase 4 (contract section 4): JSON fields come as objects; 64-bit numbers may come as text.
  const DB = '0193a1b2-c3d4-7e5f-8a9b-0000000000db';
  const WS = '0193a1b2-c3d4-7e5f-8a9b-0000000000a0';
  const page = {
    id: PAGE,
    workspaceId: WS,
    sectionId: WS,
    parentPageId: DB,
    orderKey: 'a0',
    kind: 'row',
    title: 'One',
    icon: null,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: '3',
    createdAt: '2026-11-12T10:00:00Z',
    updatedAt: '2026-11-12T10:00:00Z',
    trashedAt: null,
    trashRootId: null,
    access: 'edit',
    restricted: false,
    docHeadSeq: '2',
    docEpoch: 0,
    docSchemaVersion: 3,
  };
  const row = {
    ...page,
    databaseId: DB,
    values: { Count001: 4, Tags0001: ['a', 'b'] },
    versions: { Count001: '2' },
    computed: { Form0001: { error: 'formula.cycle' } },
    computedVersion: '5',
    createdBy: null,
    updatedBy: WS,
  };
  const database = {
    id: DB,
    workspaceId: WS,
    properties: [{ id: 'title', name: 'Name', type: 'title' }],
    version: '7',
    rowCount: '1',
    createdAt: '2026-11-12T10:00:00Z',
  };

  it("reads a database's rows by id, and the rows as records", async () => {
    const { sync, seen } = server(() => json(200, { rows: [row], next: PAGE, total: '1200' }));
    const answer = await sync.rows(DB, null, 1000);
    expect(answer).toEqual({
      rows: [
        {
          ...page,
          kind: 'row',
          version: 3,
          docHeadSeq: 2,
          databaseId: DB,
          values: row.values,
          versions: { Count001: 2 },
          computed: row.computed,
          computedVersion: 5,
          createdBy: null,
          updatedBy: WS,
        },
      ],
      next: PAGE,
      total: 1200,
    });
    expect(seen[0]).toMatchObject({
      method: 'GET',
      url: `https://api.test/api/v1/databases/${DB}/rows?limit=1000`,
    });
    await sync.rows(DB, PAGE, 10);
    expect(seen[1].url).toBe(`https://api.test/api/v1/databases/${DB}/rows?after=${PAGE}&limit=10`);
  });

  it("sends a database's query, and reads its rows, groups and cursor", async () => {
    const { sync, seen } = server(() =>
      json(200, { rows: [row], groups: [{ key: '', count: '3' }], total: 3, next: 'opaque' }),
    );
    const request = {
      viewId: PAGE,
      search: 'one',
      context: { today: '2026-11-12', offsetMinutes: 60, me: null },
      after: null,
      limit: 50,
    };
    const answer = await sync.query(DB, request);
    expect(answer).toMatchObject({ groups: [{ key: '', count: 3 }], total: 3, next: 'opaque' });
    expect(answer.rows[0]).toMatchObject({ kind: 'row', databaseId: DB, computedVersion: 5 });
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: `https://api.test/api/v1/databases/${DB}/query`,
      body: request,
    });
  });

  // Phase 9: a calendar's or a timeline's query carries its date window as it is.
  it("sends a query's date window", async () => {
    const { sync, seen } = server(() =>
      json(200, { rows: [], groups: null, total: 0, next: null }),
    );
    const request = {
      filter: null,
      sorts: [{ propertyId: 'Due00001', direction: 'asc' as const }],
      group: null,
      window: {
        propertyId: 'Due00001',
        endPropertyId: 'End00001',
        from: '2026-11-01',
        to: '2026-12-31',
      },
      context: { today: '2026-11-17', offsetMinutes: 120, me: null },
      after: null,
      limit: 500,
    };
    await sync.query(DB, request);
    expect(seen[0].body).toEqual(request);
  });

  // Phase 9: every `view.upsert` says how many view types this build knows, so the server can tell
  // an older build's table (a timeline it does not know, sent back) from a real change. Only the
  // wire carries it.
  it('sends viewTypes with every view.upsert, and with nothing else', async () => {
    const { sync, seen } = server(() => json(200, { results: [] }));
    const view = {
      id: PAGE,
      workspaceId: WS,
      databaseId: DB,
      name: 'Timeline',
      type: 'timeline' as const,
      orderKey: 'a0',
      config: {
        filter: null,
        sorts: [],
        group: null,
        properties: { order: [], hidden: [], widths: {} },
        timeline: { start: 'Due00001', scale: 'month' as const },
      },
      version: 1,
      createdAt: '2026-11-17T10:00:00Z',
    };
    const upsert = {
      opId: PAGE,
      type: 'view.upsert' as const,
      workspaceId: WS,
      entityId: PAGE,
      baseVersion: null,
      payload: view,
      createdAt: '2026-11-17T10:00:00Z',
    };
    const rename = {
      opId: WS,
      type: 'page.update' as const,
      workspaceId: WS,
      entityId: DB,
      baseVersion: null,
      payload: { title: 'Plans' },
      createdAt: '2026-11-17T10:00:00Z',
    };
    await sync.pushOps(WS, null, [upsert, rename] as never);
    const sent = (seen[0].body as { ops: { type: string; payload: Record<string, unknown> }[] })
      .ops;
    // Phase 12: seven, with `chart`.
    expect(sent[0].payload).toEqual({ ...view, viewTypes: 7 });
    expect(sent[1].payload).toEqual({ title: 'Plans' });
    // The operation itself (the outbox's copy) is left as it was.
    expect('viewTypes' in upsert.payload).toBe(false);
  });

  it('reads a timeline view as a timeline, and a type it does not know as a table', async () => {
    const view = (type: string) => ({
      id: PAGE,
      workspaceId: WS,
      databaseId: DB,
      name: type,
      type,
      orderKey: 'a0',
      config: { filter: null, sorts: [], group: null, timeline: { start: 'Due00001' } },
      version: '1',
      createdAt: '2026-11-17T10:00:00Z',
    });
    const workspace = {
      id: WS,
      name: 'W',
      icon: null,
      createdAt: '2026-11-17T10:00:00Z',
      version: 1,
      deletedAt: null,
      role: 'owner',
    };
    const { sync } = server(() =>
      json(200, {
        workspace,
        sections: [],
        pages: [],
        favourites: [],
        visits: [],
        cursor: 1,
        databases: [],
        views: [view('timeline'), view('gantt')],
      }),
    );
    const tree = await sync.tree(WS, null);
    expect(tree.views.map((v) => v.type)).toEqual(['timeline', 'table']);
    // Its settings are kept whole either way (an older build kept them too).
    expect(tree.views[1].config).toMatchObject({ timeline: { start: 'Due00001' } });
  });

  it('reads databases and views in the tree, and database, view and row changes in the feed', async () => {
    const view = {
      id: PAGE,
      workspaceId: WS,
      databaseId: DB,
      name: 'Board',
      type: 'board',
      orderKey: 'a0',
      config: { filter: null, sorts: [], group: { propertyId: 'Stage001' } },
      version: '2',
      createdAt: '2026-11-12T10:00:00Z',
    };
    const workspace = {
      id: WS,
      name: 'W',
      icon: null,
      createdAt: '2026-11-12T10:00:00Z',
      version: 1,
      deletedAt: null,
      role: 'owner',
    };
    let answer: unknown = {
      workspace,
      sections: [],
      pages: [{ ...page, id: DB, kind: 'database', parentPageId: null }],
      favourites: [],
      visits: [],
      cursor: 9,
      databases: [database],
      views: [view],
    };
    const { sync } = server(() => json(200, answer));
    const tree = await sync.tree(WS, null);
    expect(tree.pages[0].kind).toBe('database');
    expect(tree.databases).toEqual([{ ...database, version: 7, rowCount: 1 }]);
    expect(tree.views).toEqual([{ ...view, version: 2 }]);
    answer = {
      cursor: 12,
      more: false,
      changes: [
        { seq: 10, entityType: 'database', entityId: DB, kind: 'upsert', entity: { database } },
        { seq: 11, entityType: 'view', entityId: PAGE, kind: 'delete', entity: null },
        { seq: 12, entityType: 'row', entityId: PAGE, kind: 'upsert', entity: { row } },
      ],
    };
    const feed = await sync.changes(WS, 9, 500);
    expect(feed.changes.map((c) => [c.entityType, c.kind, c.entity && 'id' in c.entity])).toEqual([
      ['database', 'upsert', true],
      ['view', 'delete', null],
      ['row', 'upsert', true],
    ]);
    expect(feed.changes[2].entity).toMatchObject({ kind: 'row', values: row.values });
  });
});
