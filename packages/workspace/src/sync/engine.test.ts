// The sync engine against an in-memory server (testing/fakeServer.ts): uploads, two devices
// converging on the tree and on documents, lost answers replayed, refusals, access revoked.
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../memory';
import { newOp } from '../build';
import { keyBetween } from '../order';
import { uuidv7, type Id } from '../ids';
import { decode, fakeCodec, fakeUpdate, FakeServer } from '../testing/fakeServer';
import type { LocalStore, PageRecord, SectionRecord, WorkspaceRecord } from '../types';
import { SyncEngine, type SyncEvent } from './engine';
import type { Account } from './api';

const ALICE: Account = {
  id: '0193a1b2-c3d4-7e5f-8a9b-00000000000a',
  email: 'a@x.test',
  displayName: 'A',
  deviceId: null,
};

function device(server: FakeServer, account = ALICE) {
  const store = new MemoryStore();
  const engine = new SyncEngine(store, server.api(account), fakeCodec, {
    setTimer: () => null,
    clearTimer: () => undefined,
    random: () => 0.5,
  });
  const events: SyncEvent[] = [];
  engine.on((e) => events.push(e));
  engine.setAccount(account);
  return { store, engine, events };
}

const now = () => new Date().toISOString();

async function localWorkspace(store: LocalStore) {
  const ws: WorkspaceRecord = {
    id: uuidv7(),
    name: 'Mine',
    icon: null,
    createdAt: now(),
    version: 1,
    localOnly: true,
    deletedAt: null,
  };
  const section: SectionRecord = {
    id: uuidv7(),
    workspaceId: ws.id,
    name: 'Pages',
    orderKey: 'a0',
    visibility: 'workspace',
    version: 1,
    createdAt: now(),
  };
  const page = (title: string, parent: Id | null, orderKey: string): PageRecord => ({
    id: uuidv7(),
    workspaceId: ws.id,
    sectionId: section.id,
    parentPageId: parent,
    orderKey,
    kind: 'page',
    title,
    icon: null,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    trashedAt: null,
    trashRootId: null,
  });
  const a = page('Alpha', null, 'a0');
  const b = page('Beta', a.id, 'a0');
  const c = page('Gamma', null, 'a1');
  await store.applyLocalOps([
    newOp('workspace.create', ws.id, ws.id, ws),
    newOp('section.create', ws.id, section.id, section),
    ...[a, b, c].map((p) => newOp('page.create', ws.id, p.id, p)),
  ]);
  return { ws, section, a, b, c };
}

const titles = async (store: LocalStore, ws: Id) =>
  Object.fromEntries(
    (await store.readMirror(ws)).pages.map((p) => [
      p.id,
      [p.title, p.parentPageId, p.trashedAt !== null],
    ]),
  );

describe('sync engine', () => {
  it('uploads a local workspace intact, and a second device gets the same tree and documents', async () => {
    const server = new FakeServer();
    const one = device(server);
    const { ws, a, b, c } = await localWorkspace(one.store);
    await one.store.appendDocUpdates(a.id, [
      { updateId: uuidv7(), data: fakeUpdate(777, 'hello') },
    ]);
    await one.store.compactDoc(a.id, fakeUpdate(777, 'hello'), 1);
    await one.store.appendDocUpdates(a.id, [
      { updateId: uuidv7(), data: fakeUpdate(778, ' world') },
    ]);
    await one.store.applyLocalOps([
      newOp('favourite.set', ws.id, c.id, { favourite: true, orderKey: 'a0' }),
    ]);
    await one.store.applyLocalOps([newOp('page.trash', ws.id, c.id, {}, 1)]);

    await one.engine.upload(ws.id);
    await one.engine.syncOnce();
    expect((await one.store.readMirror(ws.id)).workspaces[0]).toMatchObject({
      localOnly: false,
      accountId: ALICE.id,
    });
    expect(await one.store.nextOutboxBatch(100, ws.id)).toEqual([]);
    expect(await one.store.unsentDocUpdates(100)).toEqual([]);
    // The Yjs client ids the local pages were written with are registered to the account.
    expect([...server.spaces.get(ws.id)!.yjs.keys()].sort()).toEqual([777, 778]);

    const two = device(server);
    await two.engine.syncOnce();
    expect(await titles(two.store, ws.id)).toEqual(await titles(one.store, ws.id));
    expect((await two.store.readMirror(ws.id)).favourites.map((f) => f.pageId)).toEqual([c.id]);
    await two.engine.pullPage(a.id);
    const doc = await two.store.loadDoc(a.id);
    expect(decode(fakeCodec.merge(doc.updates.map((u) => u.data))).text).toBe('hello world');
    expect(b.parentPageId).toBe(a.id);
  });

  it("pushes a page's document only once the page itself is on the server", async () => {
    const server = new FakeServer();
    const store = new MemoryStore();
    const { ws, section } = await localWorkspace(store);
    const base = server.api(ALICE);
    const made: PageRecord = {
      ...(await store.readMirror(ws.id)).pages[0],
      id: uuidv7(),
      sectionId: section.id,
      parentPageId: null,
      orderKey: 'a5',
      title: 'Made during a pass',
    };
    let typed = false;
    const engine = new SyncEngine(
      store,
      {
        ...base,
        // The person makes a page and types in it while the pass pushes the outbox: its create
        // waits in the outbox when the pass pushes documents.
        pushOps: async (...args: Parameters<typeof base.pushOps>) => {
          const answer = await base.pushOps(...args);
          if (!typed) {
            typed = true;
            await store.applyLocalOps([newOp('page.create', ws.id, made.id, made)]);
            await store.appendDocUpdates(made.id, [
              { updateId: uuidv7(), data: fakeUpdate(901, 'typed') },
            ]);
          }
          return answer;
        },
      },
      fakeCodec,
      { setTimer: () => null, clearTimer: () => undefined, random: () => 0.5 },
    );
    engine.setAccount(ALICE);
    await engine.upload(ws.id);
    await engine.syncOnce();
    // Not refused and set aside: still waiting to be sent.
    expect((await store.unsentDocUpdates(100)).map((d) => d.pageId)).toEqual([made.id]);
    await engine.syncOnce();
    expect(await store.unsentDocUpdates(100)).toEqual([]);

    const two = device(server);
    await two.engine.syncOnce();
    await two.engine.pullPage(made.id);
    const doc = await two.store.loadDoc(made.id);
    expect(decode(fakeCodec.merge(doc.updates.map((u) => u.data))).text).toBe('typed');
  });

  it('carries edits both ways within a pass: titles, moves and document updates', async () => {
    const server = new FakeServer();
    const one = device(server);
    const { ws, a, c } = await localWorkspace(one.store);
    await one.engine.upload(ws.id);
    await one.engine.syncOnce();
    const two = device(server);
    await two.engine.syncOnce();
    await two.engine.pullPage(a.id);

    await one.store.applyLocalOps([newOp('page.update', ws.id, a.id, { title: 'Alpha renamed' })]);
    const cRecord = (await two.store.getPage(c.id))!;
    await two.store.applyLocalOps([
      newOp(
        'page.move',
        ws.id,
        c.id,
        { sectionId: cRecord.sectionId, parentPageId: a.id, orderKey: keyBetween(null, null) },
        cRecord.version,
      ),
    ]);
    const update = uuidv7();
    await one.store.appendDocUpdates(a.id, [{ updateId: update, data: fakeUpdate(1, 'typed') }]);
    await one.engine.clientIdFor(ws.id);

    for (let i = 0; i < 2; i++) {
      await one.engine.syncOnce();
      await two.engine.syncOnce();
    }
    expect(await titles(one.store, ws.id)).toEqual(await titles(two.store, ws.id));
    expect((await two.store.getPage(a.id))?.title).toBe('Alpha renamed');
    expect((await one.store.getPage(c.id))?.parentPageId).toBe(a.id);
    const pulled = await two.store.loadDoc(a.id);
    expect(pulled.updates.map((u) => u.updateId)).toContain(update);
    expect(two.events.some((e) => e.kind === 'doc' && e.pageId === a.id)).toBe(true);
  });

  it('replays the outbox after a lost answer without duplicating anything', async () => {
    const server = new FakeServer();
    const one = device(server);
    const { ws, a } = await localWorkspace(one.store);
    await one.engine.upload(ws.id);
    await one.engine.syncOnce();
    const child = {
      ...(await one.store.getPage(a.id))!,
      id: uuidv7(),
      parentPageId: a.id,
      title: 'Once',
      orderKey: 'b0',
    };
    await one.store.applyLocalOps([newOp('page.create', ws.id, child.id, child)]);
    await one.store.appendDocUpdates(child.id, [{ updateId: uuidv7(), data: fakeUpdate(5, 'x') }]);
    server.lose('pushOps');
    await expect(one.engine.syncOnce()).rejects.toThrow();
    expect((await one.store.nextOutboxBatch(10, ws.id)).length).toBe(1);
    server.lose('pushDoc');
    await expect(one.engine.syncOnce()).rejects.toThrow();
    await one.engine.syncOnce();
    expect(await one.store.nextOutboxBatch(10, ws.id)).toEqual([]);
    expect(await one.store.unsentDocUpdates(10)).toEqual([]);
    const pages = [...server.spaces.get(ws.id)!.mirror.pages.values()].filter(
      (p) => p.title === 'Once',
    );
    expect(pages).toHaveLength(1);
    expect(server.docs.get(child.id)!.rows).toHaveLength(1);
  });

  it("takes the server's state when it refuses an operation, and says so", async () => {
    const server = new FakeServer();
    const one = device(server);
    const { ws, a, b } = await localWorkspace(one.store);
    await one.engine.upload(ws.id);
    await one.engine.syncOnce();
    const two = device(server);
    await two.engine.syncOnce();
    // Both move a; two's move reaches the server second, on a stale version.
    const pageA = (await one.store.getPage(a.id))!;
    await one.store.applyLocalOps([newOp('page.update', ws.id, a.id, { title: 'First' })]);
    await one.engine.syncOnce();
    await two.store.applyLocalOps([newOp('page.trash', ws.id, a.id, {}, pageA.version)]);
    await two.engine.syncOnce();
    expect(two.events.some((e) => e.kind === 'notice' && e.code === 'version.conflict')).toBe(true);
    expect((await two.store.getPage(a.id))?.trashedAt).toBeNull();
    expect((await two.store.getPage(b.id))?.trashedAt).toBeNull();
    expect((await two.store.getPage(a.id))?.title).toBe('First');
  });

  it('removes a subtree the account lost access to', async () => {
    const server = new FakeServer();
    const one = device(server);
    const { ws, a, b, c } = await localWorkspace(one.store);
    await one.engine.upload(ws.id);
    await one.engine.syncOnce();
    server.revoke(ws.id, a.id);
    await one.engine.syncOnce();
    const ids = (await one.store.readMirror(ws.id)).pages.map((p) => p.id);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it('uploads assets of a synced workspace and keeps them when offline', async () => {
    const server = new FakeServer();
    const one = device(server);
    const { ws } = await localWorkspace(one.store);
    const asset = {
      id: uuidv7(),
      workspaceId: ws.id,
      fileName: 'a.png',
      contentType: 'image/png',
      sizeBytes: 3,
      sha256: 'x',
      width: 1,
      height: 1,
      createdAt: now(),
    };
    await one.store.putAsset(asset, new Uint8Array([1, 2, 3]));
    await one.engine.upload(ws.id);
    server.offline = true;
    await expect(one.engine.syncOnce()).rejects.toThrow();
    expect((await one.store.pendingAssets(10)).map((x) => x.id)).toEqual([asset.id]);
    server.offline = false;
    await one.engine.syncOnce();
    expect(await one.store.pendingAssets(10)).toEqual([]);
    expect([...server.blobs.get(`fake://assets/${asset.id}`)!]).toEqual([1, 2, 3]);
  });

  it("issues this session a Yjs client id from the server's pool", async () => {
    const server = new FakeServer();
    const one = device(server);
    const { ws } = await localWorkspace(one.store);
    expect(await one.engine.clientIdFor(ws.id)).toBeUndefined();
    await one.engine.upload(ws.id);
    await one.engine.syncOnce();
    const first = await one.engine.clientIdFor(ws.id);
    expect(await one.engine.clientIdFor(ws.id)).toBe(first);
    // The pool fills in the background; the next session takes one the server issued.
    await new Promise((r) => setTimeout(r, 0));
    const next = device(server);
    await next.store.applyRemote({
      workspaceId: ws.id,
      workspaces: [{ ...(await one.store.readMirror(ws.id)).workspaces[0] }],
    });
    const pool = (await one.store.getPref<number[]>(`sync:yjsPool:${ws.id}`)) ?? [];
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.every((id) => server.spaces.get(ws.id)!.yjs.get(id) === ALICE.id)).toBe(true);
  });

  it('says syncing as soon as a local change waits, and synced only once nothing does', async () => {
    const server = new FakeServer();
    const one = device(server);
    const { ws, a } = await localWorkspace(one.store);
    await one.engine.upload(ws.id);
    await one.engine.syncOnce();
    expect(one.engine.status.state).toBe('synced');
    await one.store.applyLocalOps([newOp('page.update', ws.id, a.id, { title: 'Changed' })]);
    one.engine.changed();
    // Before any pass has run: the change is not on the server, and the status does not say so.
    expect(one.engine.status.state).toBe('syncing');
    await one.engine.syncOnce();
    expect(one.engine.status).toMatchObject({ state: 'synced', waiting: 0 });
  });

  it('reports signed out, and offline with what waits, without discarding anything', async () => {
    const server = new FakeServer();
    const one = device(server);
    const { ws, a } = await localWorkspace(one.store);
    await one.engine.upload(ws.id);
    one.engine.setAccount(null);
    await one.engine.syncOnce();
    expect(one.engine.status.state).toBe('signedOut');
    one.engine.setAccount(ALICE);
    server.offline = true;
    await one.store.applyLocalOps([newOp('page.update', ws.id, a.id, { title: 'Waiting' })]);
    await expect(one.engine.syncOnce()).rejects.toThrow();
    expect((await one.store.nextOutboxBatch(100, ws.id)).length).toBeGreaterThan(0);
  });
});
