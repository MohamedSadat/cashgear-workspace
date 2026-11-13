// Phase 4's sync of databases against the fake server: a database made offline reaching another
// device with its views and rows, large databases fetched in passes and kept fresh by the feed, a
// hold following its database's size, the server's query, pins holding databases, rows'
// documents, and the upload of a local workspace with databases.
import { describe, expect, it } from 'vitest';
import { newOp } from '../build';
import { LOCAL_ROW_LIMIT } from '../db/types';
import { uuidv7, type Id } from '../ids';
import { decode, fakeCodec, fakeUpdate, FakeServer } from '../testing/fakeServer';
import {
  ALICE,
  BOB,
  PROP,
  device,
  heldRows,
  localWorkspace,
  makeDatabase,
  rowCreate,
  serverRow,
  serverRows,
  sharedWorkspace,
  tableView,
  VirtualClock,
  type Device,
} from '../testing/syncHarness';
import type { LocalStore } from '../types';

const CONTEXT = { today: '2026-11-12', offsetMinutes: 0, me: null };

const text = async (store: LocalStore, pageId: Id) =>
  decode(fakeCodec.merge((await store.loadDoc(pageId)).updates.map((u) => u.data))).text;

const rowCalls = (server: FakeServer) => server.calls.filter((c) => c === 'rows').length;

async function sync(...devices: Device[]) {
  for (const d of devices) await d.engine.syncOnce();
}

/** Alice's workspace with a tasks database under Alpha, on the server; a second device of hers. */
async function withTasks(server = new FakeServer()) {
  const shared = await sharedWorkspace(server);
  const made = await makeDatabase(shared.one.store, shared.ws.id, shared.section.id, shared.a.id);
  await shared.one.engine.syncOnce();
  const two = device(server);
  await two.engine.syncOnce();
  return { server, ...shared, ...made, two };
}

// Up to 3 s a test here under a full run: CI's smaller runner needs room past the 5 s default.
describe('databases: sync', { timeout: 30_000 }, () => {
  it('a database made offline on one device reaches another with its views and rows', async () => {
    const server = new FakeServer();
    const { one, ws, section, a } = await sharedWorkspace(server);
    server.offline = true;
    const { db, view, rows } = await makeDatabase(one.store, ws.id, section.id, a.id);
    await one.store.applyLocalOps([
      newOp('row.update', ws.id, rows[0].id, { values: { [PROP.link]: [rows[1].id] } }),
    ]);
    await expect(one.engine.syncOnce()).rejects.toThrow();
    server.offline = false;
    await one.engine.syncOnce();
    expect(await one.store.nextOutboxBatch(10, ws.id)).toEqual([]);

    const two = device(server);
    await two.engine.syncOnce();
    const mirror = await two.store.readMirror(ws.id);
    expect(mirror.pages.find((p) => p.id === db.id)).toMatchObject({ kind: 'database' });
    expect(mirror.databases.map((d) => d.id)).toEqual([db.id]);
    expect(mirror.views.map((v) => v.id)).toEqual([view.id]);
    // Rows come only for a database this device holds (a view showing it, a pin).
    expect(await two.store.readRows(db.id)).toEqual([]);
    expect(await two.engine.holdProgress(db.id)).toMatchObject({ hold: null, total: 3 });
    await two.engine.holdDatabase(db.id);
    expect(two.events).toContainEqual({ kind: 'rows', workspaceId: ws.id, databaseId: db.id });
    await two.engine.syncOnce();
    expect(await two.engine.holdProgress(db.id)).toMatchObject({ held: 3, total: 3, local: true });

    const server_ = await serverRows(server, ALICE, db.id);
    expect(await heldRows(two.store, db.id)).toEqual(server_);
    expect(await heldRows(one.store, db.id)).toEqual(server_);
    // The relation was kept in step on the server: Two is blocked by One.
    expect(serverRow(server, rows[1].id)!.values[PROP.back]).toEqual([rows[0].id]);
    expect(serverRow(server, rows[0].id)).toMatchObject({
      createdBy: ALICE.id,
      updatedBy: ALICE.id,
    });
    const record = (await one.store.readMirror(ws.id)).databases[0];
    expect(mirror.databases[0]).toEqual(record);
    expect(record.properties.map((p) => p.id)).toEqual([
      'title',
      PROP.notes,
      PROP.count,
      PROP.stage,
      PROP.done,
      PROP.link,
      PROP.back,
    ]);
    // The device that made it holds it whole from the start; nothing was fetched for it.
    expect(await one.store.dbHold(db.id)).toMatchObject({ mode: 'full', complete: true });
    expect(one.engine.status).toMatchObject({ state: 'synced', waiting: 0 });
  });

  // Found by the Phase 4 e2e specs: a file added to a row while online was pushed before its
  // bytes, refused (a file the server does not hold), and taken back: the row lost it. A page's
  // cover had the same order since Phase 2.
  it("a file added to a row, and a page's cover, go up before the operations that name them", async () => {
    const { server, one, ws, a, db, rows } = await withTasks();
    const FILES = 'Files001';
    await one.store.applyLocalOps([
      newOp('db.update', ws.id, db.id, {
        properties: [{ id: FILES, name: 'Files', type: 'files' }],
      }),
    ]);
    await one.engine.syncOnce();
    const asset = {
      id: uuidv7(),
      workspaceId: ws.id,
      fileName: 'widget.png',
      contentType: 'image/png',
      sizeBytes: 3,
      sha256: 'abc',
      width: 2,
      height: 2,
      createdAt: new Date().toISOString(),
    };
    await one.store.putAsset(asset, new Uint8Array([137, 80, 78]));
    const page = (await one.store.readMirror(ws.id)).pages.find((p) => p.id === a.id)!;
    await one.store.applyLocalOps([
      newOp('row.update', ws.id, rows[0].id, { values: { [FILES]: [asset.id] } }),
      newOp('page.update', ws.id, a.id, { coverAssetId: asset.id }, page.version),
    ]);
    await one.engine.syncOnce();
    expect(one.events.filter((e) => e.kind === 'notice')).toEqual([]);
    expect(await one.store.nextOutboxBatch(10, ws.id)).toEqual([]);
    expect(serverRow(server, rows[0].id)!.values[FILES]).toEqual([asset.id]);
    expect((await one.store.readRows(db.id)).find((r) => r.id === rows[0].id)).toMatchObject({
      values: { [FILES]: [asset.id] },
    });
    const there = [...server.spaces.values()][0].mirror.pages.get(a.id);
    expect(there?.coverAssetId).toBe(asset.id);
  });

  it('fetches a large database in passes of four requests, the next 100 ms later, then keeps it fresh from the feed', async () => {
    const server = new FakeServer();
    const clock = new VirtualClock();
    const { one, ws, section } = await sharedWorkspace(server);
    const db = (await makeDatabase(one.store, ws.id, section.id, null, [])).db.id;
    await one.engine.syncOnce();
    const seeded = server.seedRows(db, 4500, (i) => ({ [PROP.count]: i }));
    const two = device(server, ALICE, { ...clock });
    two.engine.start();
    await clock.advance(two.engine, 0);
    await two.engine.holdDatabase(db);
    await clock.advance(two.engine, 0);
    expect(rowCalls(server)).toBe(4);
    expect(await two.engine.holdProgress(db)).toMatchObject({
      held: 4000,
      total: 4500,
      local: false,
      hold: { mode: 'full', complete: false },
    });
    // Rows remain: the next pass comes soon, and finishes.
    expect(clock.next! - clock.t).toBe(100);
    await clock.advance(two.engine, 100);
    expect(rowCalls(server)).toBe(5);
    expect(await two.engine.holdProgress(db)).toMatchObject({ held: 4500, local: true });
    expect(clock.next! - clock.t).toBe(1500);

    // Kept fresh by the feed: a row edited, one trashed, one made, on another device.
    await one.engine.syncOnce();
    expect(Object.keys(await heldRows(one.store, db))).toHaveLength(4500);
    const made = rowCreate(ws.id, section.id, db, 'Made later', {}, 'zz');
    await one.store.applyLocalOps([
      newOp('row.update', ws.id, seeded[10].id, { values: { [PROP.notes]: 'fresh' } }),
      newOp('page.trash', ws.id, seeded[11].id, {}, seeded[11].version),
      newOp('page.create', ws.id, made.id, made),
    ]);
    await one.engine.syncOnce();
    await clock.advance(two.engine, 1500);
    expect(rowCalls(server)).toBe(5);
    const there = await serverRows(server, ALICE, db);
    expect(await heldRows(two.store, db)).toEqual(there);
    expect(await heldRows(one.store, db)).toEqual(there);
    expect((await two.store.getPage(seeded[10].id)) as unknown).toMatchObject({
      values: { [PROP.notes]: 'fresh' },
    });
    expect(await two.engine.holdProgress(db)).toMatchObject({ held: 4500, total: 4500 });
    two.engine.stop();
  });

  it('a full hold whose database passes the local limit becomes partial, the server answers its queries, and it is full again when small', async () => {
    const server = new FakeServer();
    const { one, ws, db, rows, two } = await withTasks(server);
    await two.engine.holdDatabase(db.id);
    await two.engine.syncOnce();
    expect(await two.store.dbHold(db.id)).toMatchObject({ mode: 'full', complete: true });
    const seeded = server.seedRows(db.id, LOCAL_ROW_LIMIT - 1, (i) => ({ [PROP.count]: 100 + i }));
    await two.engine.syncOnce();
    await two.engine.syncOnce();
    expect(await two.store.dbHold(db.id)).toMatchObject({ mode: 'partial', complete: false });
    expect(await two.engine.holdProgress(db.id)).toMatchObject({ local: false, total: 5002 });

    // The server's query: its rows are kept here, as the partial hold's cache.
    const before = (await two.store.readRows(db.id)).length;
    const answer = await two.engine.queryDatabase(db.id, {
      filter: {
        kind: 'group',
        op: 'and',
        children: [{ kind: 'condition', propertyId: PROP.count, operator: 'le', value: 2 }],
      },
      sorts: [{ propertyId: PROP.count, direction: 'desc' }],
      context: CONTEXT,
    });
    expect(answer.rows.map((r) => r.id)).toEqual([rows[1].id, rows[0].id]);
    expect(answer.total).toBe(2);
    expect((await two.store.readRows(db.id)).length).toBe(before);
    const paged = await two.engine.queryDatabase(db.id, { context: CONTEXT, limit: 500 });
    expect(paged).toMatchObject({ total: 5002, next: '500' });
    expect(paged.rows).toHaveLength(500);

    // Rows trashed on another device bring it under the limit: held in full again, fetched.
    await one.engine.syncOnce();
    await one.store.applyLocalOps(
      seeded.slice(0, 3).map((r) => newOp('page.trash', ws.id, r.id, {}, r.version)),
    );
    await one.engine.syncOnce();
    const calls = rowCalls(server);
    await two.engine.syncOnce();
    await two.engine.syncOnce();
    expect(rowCalls(server)).toBeGreaterThan(calls);
    expect(await two.store.dbHold(db.id)).toMatchObject({ mode: 'full', complete: true });
    expect(await heldRows(two.store, db.id)).toEqual(await serverRows(server, ALICE, db.id));
  });

  it('a pinned subtree holds the databases in it, in full', async () => {
    const { server, ws, a, db, two } = await withTasks();
    await two.engine.pin(a.id, true);
    await two.engine.syncOnce();
    await two.engine.syncOnce();
    expect(await two.store.dbHold(db.id)).toMatchObject({ mode: 'full', complete: true });
    expect(await heldRows(two.store, db.id)).toEqual(await serverRows(server, ALICE, db.id));
    expect(two.events).toContainEqual({ kind: 'offline', workspaceId: ws.id });
  });

  it("a row's document is pushed, pulled when its head moves, and set aside like a page's", async () => {
    const { server, one, ws, db, rows, two } = await withTasks();
    await two.engine.holdDatabase(db.id);
    await two.engine.syncOnce();
    const row = rows[0].id;
    await one.store.appendDocUpdates(row, [{ updateId: uuidv7(), data: fakeUpdate(81, 'body') }]);
    await one.engine.syncOnce();
    expect(server.docs.get(row)!.rows).toHaveLength(1);
    await two.engine.pullPage(row);
    expect(await text(two.store, row)).toBe('body');
    // The row's head moved: the feed's row change says so, and the held document is pulled.
    await one.store.appendDocUpdates(row, [{ updateId: uuidv7(), data: fakeUpdate(81, '!') }]);
    await one.engine.syncOnce();
    two.events.length = 0;
    await two.engine.syncOnce();
    expect(await text(two.store, row)).toBe('body!');
    expect(two.events.some((e) => e.kind === 'doc' && e.pageId === row)).toBe(true);
    expect((await two.store.getPage(row))!.docHeadSeq).toBe(2);
    // Deleted for good on the server while edits wait here: set aside for a recovered page.
    await two.store.appendDocUpdates(row, [{ updateId: uuidv7(), data: fakeUpdate(82, 'late') }]);
    server.purge(row);
    await two.engine.syncOnce();
    expect(two.notices()).toEqual(['page.gone']);
    expect(await two.store.quarantine(ws.id)).toMatchObject([{ pageId: row, reason: 'page.gone' }]);
    expect(await two.store.getPage(row)).toBeNull();
  });

  it('uploads a local workspace with its databases, views, rows and their documents, and keeps them held', async () => {
    const server = new FakeServer();
    const one = device(server);
    const { ws, section, a } = await localWorkspace(one.store);
    const { db, view, rows } = await makeDatabase(one.store, ws.id, section.id, a.id);
    const board = { ...tableView(ws.id, db.id, 'Board', 'a1'), type: 'board' as const };
    await one.store.applyLocalOps([
      newOp('view.upsert', ws.id, board.id, board),
      newOp('row.update', ws.id, rows[0].id, {
        values: { [PROP.link]: [rows[1].id, rows[2].id], [PROP.notes]: 'local' },
      }),
      newOp('page.trash', ws.id, rows[2].id, {}),
    ]);
    await one.store.appendDocUpdates(rows[1].id, [
      { updateId: uuidv7(), data: fakeUpdate(91, 'row body') },
    ]);
    await one.engine.upload(ws.id);
    await one.engine.syncOnce();
    expect(await one.store.nextOutboxBatch(10, ws.id)).toEqual([]);
    expect(await one.store.unsentDocUpdates(10)).toEqual([]);
    expect(await one.store.dbHold(db.id)).toMatchObject({ mode: 'full', complete: true });
    expect([...server.spaces.get(ws.id)!.yjs.keys()]).toContain(91);

    const two = device(server);
    await two.engine.syncOnce();
    await two.engine.holdDatabase(db.id);
    await two.engine.syncOnce();
    const there = await serverRows(server, ALICE, db.id);
    expect(await heldRows(two.store, db.id)).toEqual(there);
    expect(await heldRows(one.store, db.id)).toEqual(there);
    expect(there[rows[0].id].values).toMatchObject({
      [PROP.notes]: 'local',
      [PROP.link]: [rows[1].id, rows[2].id],
    });
    expect(there[rows[1].id].values[PROP.back]).toEqual([rows[0].id]);
    expect(there[rows[2].id]).toMatchObject({ trashed: true, trashRootId: rows[2].id });
    const views = (m: Awaited<ReturnType<LocalStore['readMirror']>>) =>
      m.views.map((v) => [v.name, v.type, v.orderKey]).sort();
    expect(views(await two.store.readMirror(ws.id))).toEqual([
      ['Board', 'board', 'a1'],
      [view.name, 'table', 'a0'],
    ]);
    expect((await two.store.readMirror(ws.id)).databases).toEqual(
      (await one.store.readMirror(ws.id)).databases,
    );
    await two.engine.pullPage(rows[1].id);
    expect(await text(two.store, rows[1].id)).toBe('row body');
  });

  it('a database deleted for good on the server goes here with its views, rows and hold; unsent row edits are set aside', async () => {
    const { server, ws, db, rows, two } = await withTasks();
    await two.engine.holdDatabase(db.id);
    await two.engine.syncOnce();
    await two.engine.pullPage(rows[0].id);
    await two.store.appendDocUpdates(rows[0].id, [
      { updateId: uuidv7(), data: fakeUpdate(83, 'typed late') },
    ]);
    server.purge(db.id);
    await two.engine.syncOnce();
    // The push found the row gone (410): its edits were set aside; the feed removed the rest.
    expect(two.notices()).toEqual(['page.gone']);
    const mirror = await two.store.readMirror(ws.id);
    expect(mirror.pages.map((p) => p.id)).not.toContain(db.id);
    expect(mirror.databases).toEqual([]);
    expect(mirror.views).toEqual([]);
    expect(await two.store.readRows(db.id)).toEqual([]);
    expect(await two.store.dbHold(db.id)).toBeNull();
    expect(await two.store.getPage(rows[0].id)).toBeNull();
    expect((await two.store.quarantine(ws.id)).map((e) => e.pageId)).toEqual([rows[0].id]);
  });

  it("a database change the feed brings while only its page's rename waits is taken once the rename is answered", async () => {
    const { server, one, ws, db, two } = await withTasks();
    await one.store.applyLocalOps([
      newOp('db.update', ws.id, db.id, {
        properties: [{ id: 'Extra001', name: 'Extra', type: 'text' }],
      }),
    ]);
    await one.engine.syncOnce();
    // The database's page is renamed here while the pass reads the feed: the store keeps the
    // local database record while that waits, and the rename's answer carries only the page.
    let renamed = false;
    const typing = device(server, ALICE, {
      store: two.store,
      api: (base) => ({
        changes: async (...args) => {
          if (!renamed) {
            renamed = true;
            await two.store.applyLocalOps([
              newOp('page.update', ws.id, db.id, { title: 'Renamed' }),
            ]);
          }
          return base.changes(...args);
        },
      }),
    });
    const ids = async () =>
      (await two.store.readMirror(ws.id)).databases[0].properties.map((p) => p.id);
    await typing.engine.syncOnce();
    expect(await ids()).not.toContain('Extra001');
    await typing.engine.syncOnce();
    expect(await ids()).toContain('Extra001');
    expect((await two.store.readMirror(ws.id)).databases[0]).toEqual(
      server.spaces.get(ws.id)!.mirror.databases.get(db.id),
    );
    expect((await two.store.getPage(db.id))!.title).toBe('Renamed');
  });

  it('a page renamed elsewhere while only a visit to it waits here is taken once the visit is answered', async () => {
    const { server, one, ws, a, two } = await withTasks();
    await one.store.applyLocalOps([newOp('page.update', ws.id, a.id, { title: 'Renamed there' })]);
    await one.engine.syncOnce();
    let visited = false;
    const reading = device(server, ALICE, {
      store: two.store,
      api: (base) => ({
        changes: async (...args) => {
          if (!visited) {
            visited = true;
            await two.store.applyLocalOps([
              newOp('visit.record', ws.id, a.id, { at: new Date().toISOString() }),
            ]);
          }
          return base.changes(...args);
        },
      }),
    });
    await reading.engine.syncOnce();
    await reading.engine.syncOnce();
    expect((await two.store.getPage(a.id))!.title).toBe('Renamed there');
  });

  it('a database made by another person is held only once a view asks for it, and only rows of held databases are kept', async () => {
    const server = new FakeServer();
    const { one, ws, section, a } = await sharedWorkspace(server);
    server.addMember(ws.id, BOB.id);
    const bob = device(server, BOB);
    await bob.engine.syncOnce();
    const { db, rows } = await makeDatabase(one.store, ws.id, section.id, a.id);
    await one.engine.syncOnce();
    await bob.engine.syncOnce();
    expect(await bob.store.readRows(db.id)).toEqual([]);
    await one.store.applyLocalOps([
      newOp('row.update', ws.id, rows[0].id, { values: { [PROP.notes]: 'unseen' } }),
    ]);
    await sync(one, bob);
    expect(await bob.store.readRows(db.id)).toEqual([]);
    await bob.engine.holdDatabase(db.id);
    await bob.engine.syncOnce();
    expect(await heldRows(bob.store, db.id)).toEqual(await serverRows(server, BOB, db.id));
    expect(serverRow(server, rows[0].id)!.updatedBy).toBe(ALICE.id);
  });
});
