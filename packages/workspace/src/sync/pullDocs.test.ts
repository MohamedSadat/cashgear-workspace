// Phase 12's batch pull of documents (`POST /workspaces/{id}/docs/pull`, the shared shape in the
// Phase 12 streams' notes): one suite, run against the in-memory server and against the HTTP
// client, whose scripted fetch speaks the route's JSON over the same in-memory server. Each page
// is answered as the single route answers it, in the request's order; one page's refusal never
// fails the rest; the request itself fails for 0, more than 100 or repeated pages, for a workspace
// not the account's, and with the rate limit's 429 and its `Retry-After`; past the answer's size
// the rest are deferred, the first page always answered.
import { createApi } from '@cgw/api';
import { describe, expect, it } from 'vitest';
import { uuidv7, type Id } from '../ids';
import { fakeUpdate, FakeServer, MAX_PULL_PAGES } from '../testing/fakeServer';
import { ALICE, BOB, sharedWorkspace } from '../testing/syncHarness';
import { SyncHttpError, type Account, type DocPull, type SyncApi } from './api';
import { httpSyncApi, toBase64 } from './http';

type Make = (server: FakeServer, account: Account) => SyncApi;

/** The in-memory server's own API. */
const memory: Make = (server, account) => server.api(account);

/** A pull as the route writes it: bytes as base64, some 64-bit numbers as text. */
const wirePull = (pull: DocPull) => ({
  ...pull,
  headSeq: String(pull.headSeq),
  updates: pull.updates.map((u) => ({ seq: u.seq, updateId: u.updateId, data: toBase64(u.data) })),
});

/** The HTTP client over a fetch that answers the batch route from the in-memory server. */
const http: Make = (server, account) => {
  const backend = server.api(account);
  const api = createApi({
    baseUrl: 'https://api.test',
    auth: { kind: 'bearer', token: async () => 'token' },
    fetch: (async (request: Request) => {
      const path = new URL(request.url).pathname;
      const match = /^\/api\/v1\/workspaces\/([^/]+)\/docs\/pull$/.exec(path);
      if (request.method !== 'POST' || !match) return json(404, { code: 'not.found' });
      const body = JSON.parse(await request.text()) as {
        pages: { pageId: Id; after: number }[];
      };
      try {
        const docs = await backend.pullDocs(match[1], body.pages);
        return json(200, {
          docs: docs.map((item) =>
            item.pull
              ? { pageId: item.pageId, status: 200, code: null, pull: wirePull(item.pull) }
              : { pageId: item.pageId, status: item.status, code: item.code, pull: null },
          ),
        });
      } catch (error) {
        if (!(error instanceof SyncHttpError)) throw error;
        const wait: Record<string, string> = error.retryAfterMs
          ? { 'Retry-After': String(error.retryAfterMs / 1000) }
          : {};
        return json(error.status, { code: error.code, title: error.message }, wait);
      }
    }) as typeof fetch,
  });
  return httpSyncApi(api);
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

/** Bytes as numbers, so pulls compare by content. */
const plain = (pull: DocPull) => ({
  ...pull,
  updates: pull.updates.map((u) => ({ ...u, data: [...u.data] })),
});

async function scene(server = new FakeServer()) {
  const shared = await sharedWorkspace(server);
  const { a, b, c } = shared;
  const backend = server.api(ALICE);
  const push = (pageId: Id, ...words: string[]) =>
    backend.pushDoc(pageId, {
      epoch: 0,
      clientSchemaVersion: 1,
      updates: words.map((w) => ({ updateId: uuidv7(), data: fakeUpdate(90, w) })),
    });
  await push(a.id, 'alpha', ' one', ' two');
  await push(b.id, 'beta');
  await push(c.id, 'gamma');
  // Another workspace of the same person.
  const other = await sharedWorkspace(server);
  await push(other.a.id, 'elsewhere');
  return { ...shared, other, backend };
}

const caught = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (error) {
    return error as SyncHttpError;
  }
  throw new Error('no error');
};

describe.each([
  ['the in-memory server', memory],
  ['the HTTP client', http],
] as const)('the batch pull of documents: %s', (_name, make) => {
  it("answers each page in the request's order, exactly as the single route does", async () => {
    const server = new FakeServer();
    const { ws, a, b, c, backend } = await scene(server);
    const api = make(server, ALICE);
    const asked = [
      { pageId: c.id, after: 0 },
      { pageId: a.id, after: 1 },
      { pageId: b.id, after: 1 },
    ];
    const docs = await api.pullDocs(ws.id, asked);
    expect(docs.map((d) => [d.pageId, d.status])).toEqual([
      [c.id, 200],
      [a.id, 200],
      [b.id, 200],
    ]);
    for (const [i, { pageId, after }] of asked.entries())
      expect(plain(docs[i].pull!)).toEqual(plain(await backend.pullDoc(pageId, after)));
    expect(docs[1].pull!.updates.map((u) => u.seq)).toEqual([2, 3]);
    expect(docs[2].pull!.updates).toEqual([]);
    expect(typeof docs[0].pull!.headSeq).toBe('number');
    expect(new TextDecoder().decode(docs[0].pull!.updates[0].data)).toContain('gamma');
  });

  it("answers a refused page with the single route's status and code, and the rest as ever", async () => {
    const server = new FakeServer();
    const { ws, a, b, c, other } = await scene(server);
    server.purge(c.id);
    server.revoke(ws.id, b.id, ALICE.id);
    const api = make(server, ALICE);
    const docs = await api.pullDocs(ws.id, [
      { pageId: c.id, after: 0 },
      { pageId: b.id, after: 0 },
      { pageId: other.a.id, after: 0 },
      { pageId: uuidv7(), after: 0 },
      { pageId: a.id, after: 0 },
    ]);
    expect(docs.map((d) => [d.status, d.code ?? null])).toEqual([
      [410, 'page.gone'],
      [404, 'not.found'],
      // A page of another workspace, even one the account may read, is not found in this one.
      [404, 'not.found'],
      [404, 'not.found'],
      [200, null],
    ]);
    expect(docs[4].pull!.updates).toHaveLength(3);
  });

  it('refuses the request for no page, more than 100, or one page twice, and a workspace not the account’s', async () => {
    const server = new FakeServer();
    const { ws, a } = await scene(server);
    const api = make(server, ALICE);
    expect(await caught(api.pullDocs(ws.id, []))).toMatchObject({
      status: 400,
      code: 'request.invalid',
    });
    const many = Array.from({ length: MAX_PULL_PAGES + 1 }, () => ({ pageId: uuidv7(), after: 0 }));
    expect(await caught(api.pullDocs(ws.id, many))).toMatchObject({ status: 400 });
    // At the limit, every page answered (here, not found).
    expect(await api.pullDocs(ws.id, many.slice(1))).toHaveLength(MAX_PULL_PAGES);
    const twice = [
      { pageId: a.id, after: 0 },
      { pageId: a.id, after: 1 },
    ];
    expect(await caught(api.pullDocs(ws.id, twice))).toMatchObject({ status: 400 });
    expect(
      await caught(make(server, BOB).pullDocs(ws.id, [{ pageId: a.id, after: 0 }])),
    ).toMatchObject({ status: 404, code: 'not.found' });
  });

  it('is one request of the rate limit: a 429 with its Retry-After', async () => {
    const server = new FakeServer();
    const { ws, a } = await scene(server);
    server.throttle('pullDocs', 7000);
    expect(
      await caught(make(server, ALICE).pullDocs(ws.id, [{ pageId: a.id, after: 0 }])),
    ).toMatchObject({ status: 429, code: 'limit.rate', retryAfterMs: 7000 });
  });

  it("defers the pages past the answer's size, and always answers the first", async () => {
    const server = new FakeServer({ pullDocsBytes: 40 });
    const { ws, a, b, c } = await scene(server);
    const api = make(server, ALICE);
    // Alpha's three updates are more than the cap alone: as the first page, it is answered.
    const docs = await api.pullDocs(ws.id, [
      { pageId: a.id, after: 0 },
      { pageId: b.id, after: 0 },
      { pageId: c.id, after: 0 },
    ]);
    expect(docs.map((d) => [d.pageId, d.status, d.code ?? null])).toEqual([
      [a.id, 200, null],
      [b.id, 0, 'deferred'],
      [c.id, 0, 'deferred'],
    ]);
    // Asked again, each comes.
    const again = await api.pullDocs(ws.id, [
      { pageId: b.id, after: 0 },
      { pageId: c.id, after: 0 },
    ]);
    expect(again.map((d) => d.status)).toEqual([200, 0]);
    expect(new TextDecoder().decode(again[0].pull!.updates[0].data)).toContain('beta');
  });
});
