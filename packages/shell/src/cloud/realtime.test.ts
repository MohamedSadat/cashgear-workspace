// The app's real-time connection (Phase 6): a fresh single-use ticket from the API per attempt, by
// the app's own sign-in (the cookie and antiforgery header on the web, the bearer on the desktop),
// the hub's address with it; and its wiring: the page on screen joined while it is shown and the
// hub connected, its saves sent through the hub and batched short while joined, nothing after
// sign-out.
import { createApi } from '@cgw/api';
import { docCodec, newDocumentUpdate, type PageDocument } from '@cgw/doc';
import {
  HUB,
  MemoryStore,
  OfflineError,
  SyncHttpError,
  fromBase64,
  uuidv7,
  type HubSocket,
  type Id,
  type PageRecord,
} from '@cgw/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { CloudPlatform } from '../platform';
import { WorkspaceSession, type CloudHooks } from '../session';
import { Cloud } from './cloud';
import { createRealtime, hubUrl, realtimeTicket } from './realtime';

const BASE = 'http://127.0.0.1:9';
const realFetch = globalThis.fetch;

type Route = (request: Request, body: unknown) => Response | Promise<Response> | undefined;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

/** A fetch that answers by method and path, records every request, and answers 503 otherwise. */
function serve(routes: Record<string, Route>) {
  const seen: { route: string; headers: Headers; credentials: RequestCredentials }[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    const route = `${request.method} ${path}`;
    seen.push({ route, headers: request.headers, credentials: request.credentials });
    const text = await request.clone().text();
    const body: unknown = text ? JSON.parse(text) : undefined;
    const answer = await routes[route]?.(request, body);
    return answer ?? json({ code: 'server.unavailable', title: 'Down for the test' }, 503);
  }) as typeof fetch;
  return seen;
}

async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the ticket and the address', () => {
  it('takes a ticket with the cookie and its antiforgery header on the web', async () => {
    const seen = serve({
      'GET /api/v1/account/antiforgery': () => json({ token: 'csrf-1' }),
      'POST /api/v1/realtime/tickets': () =>
        json({ ticket: 'tkt-1', expiresAt: new Date().toISOString() }),
    });
    const api = createApi({ baseUrl: BASE, auth: { kind: 'cookie' } });
    expect(await realtimeTicket(api)).toBe('tkt-1');
    const post = seen.find((s) => s.route === 'POST /api/v1/realtime/tickets')!;
    expect(post.headers.get('X-CSRF-TOKEN')).toBe('csrf-1');
    expect(post.credentials).toBe('include');
    expect(post.headers.get('Authorization')).toBeNull();
  });

  it('takes a ticket with the bearer token on the desktop, and never sends cookies', async () => {
    const seen = serve({
      'POST /api/v1/realtime/tickets': () => json({ ticket: 'tkt-2', expiresAt: '' }),
    });
    const api = createApi({ baseUrl: BASE, auth: { kind: 'bearer', token: async () => 'tok' } });
    expect(await realtimeTicket(api)).toBe('tkt-2');
    expect(seen.map((s) => s.route)).toEqual(['POST /api/v1/realtime/tickets']);
    expect(seen[0].headers.get('Authorization')).toBe('Bearer tok');
    expect(seen[0].credentials).toBe('omit');
  });

  it('turns failures into what the loop understands', async () => {
    // The client takes the fetch there is when it is made.
    const bearer = () =>
      createApi({ baseUrl: BASE, auth: { kind: 'bearer', token: async () => 'tok' } });
    serve({
      'POST /api/v1/realtime/tickets': () =>
        json({ code: 'limit.rate', title: 'Slow down' }, 429, { 'Retry-After': '7' }),
    });
    await expect(realtimeTicket(bearer())).rejects.toMatchObject({
      status: 429,
      code: 'limit.rate',
      retryAfterMs: 7000,
    });
    serve({ 'POST /api/v1/realtime/tickets': () => new Response('', { status: 401 }) });
    const signedOut = await realtimeTicket(bearer()).catch((e: unknown) => e);
    expect(signedOut).toBeInstanceOf(SyncHttpError);
    expect(signedOut).toMatchObject({ status: 401, code: 'auth.required' });
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(realtimeTicket(bearer())).rejects.toBeInstanceOf(OfflineError);
  });

  it("puts the ticket in the hub's address, encoded, and nothing else", () => {
    expect(hubUrl('https://api.example.test/', 'a+b/c=')).toBe(
      'https://api.example.test/api/v1/realtime?ticket=a%2Bb%2Fc%3D',
    );
  });

  it('takes a fresh ticket for every attempt, the first and after a drop', async () => {
    let n = 0;
    serve({ 'POST /api/v1/realtime/tickets': () => json({ ticket: `t${++n}`, expiresAt: '' }) });
    const api = createApi({ baseUrl: BASE, auth: { kind: 'bearer', token: async () => 'tok' } });
    const urls: string[] = [];
    const sockets: { drop: () => void }[] = [];
    const transport = createRealtime(api, {
      minDelayMs: 1,
      connect: async (url) => {
        urls.push(url);
        const made = testSocket();
        sockets.push(made);
        return made.s;
      },
    });
    transport.start();
    await until(() => transport.state === 'connected');
    sockets[0].drop();
    await until(() => urls.length === 2 && transport.state === 'connected');
    transport.stop();
    expect(urls).toEqual([hubUrl(BASE, 't1'), hubUrl(BASE, 't2')]);
  });
});

/** A socket whose hub answers the way a test says (every call ok by default). */
function testSocket(
  answer: (method: string, args: unknown[]) => unknown = () => ({ ok: true, value: {} }),
) {
  const handlers = new Map<string, (payload: unknown) => void>();
  let close: (() => void) | null = null;
  const invoked: { method: string; args: unknown[] }[] = [];
  const s: HubSocket = {
    invoke: async (method, ...args) => {
      invoked.push({ method, args });
      return answer(method, args);
    },
    on: (event, handler) => void handlers.set(event, handler),
    onClose: (handler) => void (close = handler),
    close: async () => close?.(),
  };
  return {
    s,
    invoked,
    emit: (e: string, p: unknown) => handlers.get(e)?.(p),
    drop: () => close?.(),
  };
}

describe("the session's page on screen", () => {
  it('is told as it changes: the page opened last, until another opens or it closes', async () => {
    const store = new MemoryStore();
    const session = await WorkspaceSession.start(store);
    const live: [Id, boolean][] = [];
    const saved: Id[] = [];
    const hooks: CloudHooks = {
      clientIdFor: async () => undefined,
      pullPage: async () => undefined,
      changed: () => undefined,
      live: (pageId, open) => live.push([pageId, open]),
      saved: (pageId) => saved.push(pageId),
    };
    const [a, b] = [uuidv7(), uuidv7()];
    for (const id of [a, b])
      await store.appendDocUpdates(id, [{ updateId: uuidv7(), data: newDocumentUpdate(id) }]);
    const docA = await session.openDoc(a);
    // Connected after the page opened: told of it at once.
    session.connect(hooks);
    expect(live).toEqual([[a, true]]);
    await session.openDoc(b);
    expect(live).toEqual([
      [a, true],
      [a, false],
      [b, true],
    ]);
    // A save of an open document is told as a save (the page's own).
    docA.doc.transact(() => docA.fragment.insert(0, [new Y.XmlText('x')]));
    await docA.flush();
    expect(saved).toEqual([a]);
    await session.close();
    expect(live.at(-1)).toEqual([b, false]);
  });
});

describe('the cloud over the hub', () => {
  const account = { id: uuidv7(), email: 'ada@example.test', displayName: 'Ada', deviceId: null };
  const platform = {
    kind: 'web',
    apiBase: BASE,
    auth: { kind: 'cookie' },
    setWindowTheme: async () => {},
    openExternal: async () => {},
    openStore: async () => new MemoryStore(),
    saveFile: async () => {},
  } as CloudPlatform;

  it('joins the page on screen, sends its saves through the hub in short batches, and stops on sign-out', async () => {
    const store = new MemoryStore();
    const workspaceId = uuidv7();
    const sectionId = uuidv7();
    const pageId = uuidv7();
    const at = new Date().toISOString();
    await store.applyRemote({
      workspaceId,
      workspaces: [
        {
          id: workspaceId,
          name: 'Team',
          icon: null,
          createdAt: at,
          version: 1,
          localOnly: false,
          deletedAt: null,
          accountId: account.id,
        },
      ],
      sections: [
        {
          id: sectionId,
          workspaceId,
          name: 'Team',
          orderKey: 'a0',
          visibility: 'workspace',
          version: 1,
          createdAt: at,
        },
      ],
      pages: [
        {
          id: pageId,
          workspaceId,
          sectionId,
          parentPageId: null,
          orderKey: 'a0',
          kind: 'page',
          title: 'Live',
          icon: null,
          coverAssetId: null,
          isTemplate: false,
          templateOfPageId: null,
          version: 1,
          createdAt: at,
          updatedAt: at,
          trashedAt: null,
          trashRootId: null,
        } satisfies PageRecord,
      ],
    });
    // The page is held here, all of it sent.
    await store.applyRemoteDocUpdates(pageId, {
      epoch: 0,
      headSeq: 1,
      updates: [{ seq: 1, updateId: uuidv7(), data: newDocumentUpdate(pageId) }],
    });
    let tickets = 0;
    const seen = serve({
      'GET /api/v1/account/session': () => json({ account }),
      'GET /api/v1/account/antiforgery': () => json({ token: 'csrf' }),
      'POST /api/v1/account/signout': () => json({}),
      'POST /api/v1/realtime/tickets': () => json({ ticket: `t${++tickets}`, expiresAt: '' }),
      [`POST /api/v1/workspaces/${workspaceId}/yjs-clients`]: (_r, body) =>
        json({
          issued: [],
          registered: (body as { register: number[] }).register,
          refused: [],
        }),
    });
    let seq = 1;
    const sockets: ReturnType<typeof testSocket>[] = [];
    const urls: string[] = [];
    const hub = (method: string, args: unknown[]) => {
      if (method === HUB.joinWorkspaces)
        return {
          ok: true,
          value: (args[0] as Id[]).map((id) => ({ workspaceId: id, seq: 0, presence: [] })),
        };
      if (method === HUB.joinPage)
        return {
          ok: true,
          value: {
            workspaceId,
            epoch: 0,
            headSeq: 1,
            schemaVersion: 5,
            level: 'full',
            presence: [],
          },
        };
      if (method === HUB.pushUpdates) {
        const updates = (args[1] as { updates: { updateId: Id }[] }).updates;
        return {
          ok: true,
          value: { acks: updates.map((u) => ({ updateId: u.updateId, seq: ++seq })), headSeq: seq },
        };
      }
      return { ok: true, value: {} };
    };
    const session = await WorkspaceSession.start(store);
    const cloud = new Cloud(platform, session, docCodec, {
      realtime: (api) =>
        createRealtime(api, {
          minDelayMs: 1,
          connect: async (url) => {
            urls.push(url);
            const made = testSocket(hub);
            sockets.push(made);
            return made.s;
          },
        }),
    });
    try {
      await cloud.refreshAccount();
      await until(() => cloud.realtime.state === 'connected');
      // The workspace is followed once the engine knows it syncs.
      await until(() => sockets[0].invoked.some((c) => c.method === HUB.joinWorkspaces));
      const doc: PageDocument = await session.openDoc(pageId);
      await until(() => doc.isLive);
      expect(sockets[0].invoked.filter((c) => c.method === HUB.joinPage)).toEqual([
        { method: HUB.joinPage, args: [pageId] },
      ]);

      doc.doc.transact(() => doc.fragment.insert(0, [new Y.XmlText('typed')]));
      await until(() => sockets[0].invoked.some((c) => c.method === HUB.pushUpdates));
      const push = sockets[0].invoked.find((c) => c.method === HUB.pushUpdates)!;
      const sent = (push.args[1] as { updates: { updateId: Id; data: string }[] }).updates;
      const stored = (await store.loadDoc(pageId)).updates.find(
        (u) => u.updateId === sent[0].updateId,
      )!;
      expect(fromBase64(sent[0].data)).toEqual(stored.data);
      // Sent: its sequence is the hub's answer (HTTP is down in this test).
      for (let i = 0; i < 100 && (await store.unsentDocUpdates(10)).length; i++)
        await new Promise((r) => setTimeout(r, 5));
      expect(await store.unsentDocUpdates(10)).toEqual([]);
      expect(seen.some((s) => s.route === `POST /api/v1/pages/${pageId}/doc/updates`)).toBe(false);

      // The connection drops: the usual batches; it comes back with a new ticket and rejoins.
      const lives: boolean[] = [];
      const setLive = doc.setLive.bind(doc);
      doc.setLive = (live) => {
        lives.push(live);
        setLive(live);
      };
      sockets[0].drop();
      await until(() => sockets.length === 2 && doc.isLive);
      expect(lives[0]).toBe(false);
      expect(lives.at(-1)).toBe(true);
      expect(urls[1]).toBe(hubUrl(BASE, 't2'));
      expect(sockets[1].invoked.some((c) => c.method === HUB.joinPage)).toBe(true);

      // Signed out: the connection closes and is not opened again.
      await cloud.signOut();
      expect(cloud.realtime.state).toBe('disconnected');
      await new Promise((r) => setTimeout(r, 30));
      expect(sockets).toHaveLength(2);
      expect(doc.isLive).toBe(false);
    } finally {
      cloud.dispose();
      await session.close();
    }
  });
});
