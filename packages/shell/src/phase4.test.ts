// Phase 4 in the shell: the database views' host over the session (a local workspace, and a
// synced one over the fake server: full holds, partial holds, offline), rows as pages (their body
// made on first open, a template's copied, trashed rows), CSV through the server's routes, and the
// workspace export and import with databases (format version 2, and version 1 still read).
import type { RowSnapshot, RowSource } from '@cgw/database';
import { PageDocument, fragmentToJSON, newDocumentUpdate, plainText } from '@cgw/doc';
import {
  LOCAL_ROW_LIMIT,
  MemoryStore,
  newOp,
  parseCsv,
  uuidv7,
  type QuerySpec,
  type RowRecord,
} from '@cgw/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeServer } from '../../workspace/src/testing/fakeServer';
import {
  ALICE,
  PROP,
  STAGE,
  device,
  localWorkspace,
  makeDatabase,
  rowCreate,
  sharedWorkspace,
  type Device,
} from '../../workspace/src/testing/syncHarness';
import { ShellDatabaseHost, type DatabaseSync } from './database/host';
import { emptyRowsOps, newDatabaseOps, pageGlyph } from './database/make';
import {
  FORMAT,
  MANIFEST,
  buildExport,
  readExport,
  type ExportManifest,
} from './exchange/exchange';
import { WorkspaceSession } from './session';

const ALL: QuerySpec = { filter: null, sorts: [], group: null };
const NAMES = { title: 'Name', table: 'Table' };

async function until(check: () => boolean | Promise<boolean>, what = 'the condition') {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** The next snapshot that has finished loading. */
async function settled(source: RowSource, check: (s: RowSnapshot) => boolean = () => true) {
  await until(() => !source.snapshot().loading && check(source.snapshot()), 'a settled snapshot');
  return source.snapshot();
}

const titles = (snapshot: RowSnapshot) => snapshot.rows.map((r) => r.title);

const hosts: ShellDatabaseHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
});

function hostFor(session: WorkspaceSession, extra: { saveFile?: ReturnType<typeof vi.fn> } = {}) {
  const host = new ShellDatabaseHost({
    session,
    saveFile: extra.saveFile as never,
    open: () => undefined,
  });
  hosts.push(host);
  return host;
}

/** The engine's database API as the cloud gives it, over a device of the fake server. */
function syncOf(d: Device, server: FakeServer, overrides: Partial<DatabaseSync> = {}) {
  const listeners = new Set<() => void>();
  const sync: DatabaseSync = {
    online: () => !server.offline,
    account: () => ({ id: ALICE.id, displayName: 'Ada', email: ALICE.email }),
    holdDatabase: (id) => d.engine.holdDatabase(id),
    queryDatabase: (id, request) => d.engine.queryDatabase(id, request),
    peekQuery: (id, request) => server.api(ALICE).query(id, request),
    members: async () => [{ userId: ALICE.id, displayName: 'Ada', email: ALICE.email }],
    syncNow: () => d.engine.syncOnce(),
    importCsv: async () => ({ created: 0, problems: [] }),
    exportCsv: async () => new Uint8Array(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    ...overrides,
  };
  return { sync, changed: () => listeners.forEach((l) => l()) };
}

/** A session over a device's store, told of the engine's changes as the cloud tells it. */
async function sessionOf(d: Device) {
  const session = await WorkspaceSession.start(d.store);
  d.engine.on((event) => {
    if (event.kind === 'rows') session.rowsChanged(event.databaseId);
    if (event.kind === 'mirror') void session.reloadMirror();
  });
  return session;
}

/** A local workspace with an empty database (a table view, three empty rows) under Alpha. */
async function localDatabase() {
  const store = new MemoryStore();
  const made = await localWorkspace(store);
  const session = await WorkspaceSession.start(store);
  session.switchTo(made.ws.id);
  const host = hostFor(session);
  const database = newDatabaseOps(
    {
      workspaceId: made.ws.id,
      sectionId: made.section.id,
      parentPageId: made.a.id,
      orderKey: 'a5',
    },
    NAMES,
  );
  await host.apply(database.ops);
  return { store, session, host, ...made, ...database };
}

describe('a change through the session', () => {
  // Found by bench/phase4.mjs: a cell edit showed only once IndexedDB's write committed (about
  // 20 ms), the old value drawn meanwhile ("local ≤ 16 ms").
  it("shows before the store's write resolves, and a refused write takes the store's truth back", async () => {
    const { store, session, databaseId } = await localDatabase();
    const row = session.mirror.rowsOf(databaseId)[0];
    let release!: () => void;
    let refuse = false;
    const write = store.applyLocalOps.bind(store);
    store.applyLocalOps = async (ops) => {
      await new Promise<void>((done) => (release = done));
      if (refuse) throw new Error('The store refused it');
      return write(ops);
    };
    const edit = (title: string) =>
      session.apply([newOp('page.update', row.workspaceId, row.id, { title }, null)]);
    const first = edit('Shown at once');
    await until(() => !!release, 'the write to start');
    expect(session.record(row.id)?.title).toBe('Shown at once');
    release();
    await first;
    expect(((await store.getPage(row.id)) as RowRecord).title).toBe('Shown at once');
    // Refused by the store: the mirror reads the store's truth again.
    refuse = true;
    release = undefined as never;
    const second = edit('Never stored');
    await until(() => !!release, 'the second write to start');
    expect(session.record(row.id)?.title).toBe('Never stored');
    release();
    await expect(second).rejects.toThrow('The store refused it');
    expect(session.record(row.id)?.title).toBe('Shown at once');
  });
});

describe('the database host on a local workspace', () => {
  it('reads the database, its views and rows from the session, live', async () => {
    const { session, host, databaseId, viewId, ws } = await localDatabase();
    expect(host.database(databaseId)?.properties.map((p) => p.type)).toEqual(['title']);
    expect(host.views(databaseId).map((v) => v.id)).toEqual([viewId]);
    // The same objects while nothing changed (each read can be a React snapshot).
    expect(host.views(databaseId)).toBe(host.views(databaseId));
    expect(host.databases()).toBe(host.databases());
    expect(host.databases().map((d) => d.id)).toEqual([databaseId]);
    expect(session.mirror.pages.get(databaseId)?.kind).toBe('database');
    // Rows never in the tree.
    expect(session.mirror.childrenOf(databaseId)).toEqual([]);

    const source = host.rows(databaseId, { viewId, spec: ALL });
    let snapshot = await settled(source);
    expect(snapshot).toMatchObject({ total: 3, complete: true, localOnly: false, error: null });
    const [first] = snapshot.rows;
    expect(host.page(first.id)).toMatchObject({ kind: 'row', databaseId });

    // A title and a property, as the views write them.
    await host.apply([
      newOp('db.update', ws.id, databaseId, {
        properties: [{ id: 'Count001', name: 'Count', type: 'number' }],
      }),
    ]);
    await host.apply([newOp('page.update', ws.id, first.id, { title: 'First' })]);
    await host.apply([newOp('row.update', ws.id, first.id, { values: { Count001: '7' } })]);
    snapshot = await settled(source, (s) => s.rows.some((r) => r.title === 'First'));
    const row = snapshot.rows.find((r) => r.id === first.id)!;
    expect(row.values.Count001).toBe(7);
    expect(session.mirror.rowRecords.get(first.id)?.values.Count001).toBe(7);

    // Sorted and searched here.
    const sorted = host.rows(databaseId, {
      viewId,
      spec: { ...ALL, sorts: [{ propertyId: 'Count001', direction: 'desc' }], search: 'fir' },
    });
    expect(titles(await settled(sorted))).toEqual(['First']);
    sorted.close();
    source.close();
  });

  it('computes formulas here, and keeps people to the person when local', async () => {
    const { host, databaseId, viewId, ws } = await localDatabase();
    await host.apply([
      newOp('db.update', ws.id, databaseId, {
        properties: [
          { id: 'Count001', name: 'Count', type: 'number' },
          {
            id: 'Twice001',
            name: 'Twice',
            type: 'formula',
            formula: { expression: 'prop("Count001") * 2' },
          },
        ],
      }),
    ]);
    const source = host.rows(databaseId, { viewId, spec: ALL });
    const [row] = (await settled(source)).rows;
    await host.apply([newOp('row.update', ws.id, row.id, { values: { Count001: 21 } })]);
    const snapshot = await settled(source, (s) => s.rows.some((r) => r.computed.Twice001 === 42));
    expect(snapshot.rows.find((r) => r.id === row.id)?.computed.Twice001).toBe(42);
    expect((host.page(row.id) as RowRecord).computed.Twice001).toBe(42);
    expect(host.me()).toBeNull();
    expect(host.people()).toEqual([]);
    expect(host.importCsv).toBeUndefined();
    expect(host.canEdit(databaseId)).toBe(true);
    expect(host.queryContext()).toBe(host.queryContext());
    expect(host.queryContext().today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    source.close();
  });

  it('gives order keys among the rows and lists row templates', async () => {
    const { session, host, databaseId, ws, section } = await localDatabase();
    const rows = [...session.mirror.rowsOf(databaseId)].sort((a, b) =>
      a.orderKey < b.orderKey ? -1 : 1,
    );
    const start = host.rowOrderKey(databaseId, 'start');
    const end = host.rowOrderKey(databaseId, 'end');
    const between = host.rowOrderKey(databaseId, { after: rows[0].id, before: rows[1].id });
    expect(start < rows[0].orderKey).toBe(true);
    expect(end > rows[2].orderKey).toBe(true);
    expect(between > rows[0].orderKey && between < rows[1].orderKey).toBe(true);
    const template = {
      ...rowCreate(ws.id, section.id, databaseId, 'Weekly', {}, end),
      isTemplate: true,
    };
    await host.apply([newOp('page.create', ws.id, template.id, template)]);
    await until(() => host.rowTemplates(databaseId).length === 1);
    expect(host.rowTemplates(databaseId)).toBe(host.rowTemplates(databaseId));
    expect(pageGlyph(session.mirror.pages.get(databaseId))).toBe('▦');
  });

  it('opens a row as a page: its body made once on its first open, a template body copied', async () => {
    const { store, session, host, databaseId, ws, section } = await localDatabase();
    const [row] = session.mirror.rowsOf(databaseId);
    expect((await store.loadDoc(row.id)).updates).toHaveLength(0);
    const doc = await session.openDoc(row.id);
    expect(doc.fragment.length).toBe(1);
    expect((await store.loadDoc(row.id)).updates).toHaveLength(1);
    await session.close().catch(() => undefined);

    // A template with a body: a row made from it starts with that body.
    const reopened = await WorkspaceSession.start(store);
    reopened.switchTo(ws.id);
    const host2 = hostFor(reopened);
    const template = {
      ...rowCreate(ws.id, section.id, databaseId, 'Template', {}, 'b1'),
      isTemplate: true,
    };
    await host2.apply([newOp('page.create', ws.id, template.id, template)]);
    await store.appendDocUpdates(template.id, [
      {
        updateId: uuidv7(),
        data: newDocumentUpdate(template.id, {
          type: 'doc',
          content: [
            {
              type: 'block',
              attrs: { id: 'AbCdEfGhIjKl' },
              content: [
                {
                  type: 'textBody',
                  attrs: { kind: 'paragraph' },
                  content: [{ type: 'text', text: 'Agenda' }],
                },
              ],
            },
          ],
        }),
      },
    ]);
    const made = {
      ...rowCreate(ws.id, section.id, databaseId, 'From it', {}, 'b2'),
      templateOfPageId: template.id,
    };
    await host2.apply([newOp('page.create', ws.id, made.id, made)]);
    await until(async () => (await store.loadDoc(made.id)).updates.length > 0, 'the copied body');
    const copy = await PageDocument.open(made.id, store, { canEdit: false });
    const json = fragmentToJSON(copy.fragment);
    expect(plainText(json)).toContain('Agenda');
    // New block ids, as a copy of a page has.
    expect(JSON.stringify(json)).not.toContain('AbCdEfGhIjKl');
    await copy.close();
    void host;
  });

  it('lists trashed rows in the trash and restores them into their database', async () => {
    const { store, session, host, databaseId, ws } = await localDatabase();
    const [row] = session.mirror.rowsOf(databaseId);
    await session.trashPage(row.id);
    expect((await store.trashedRows(ws.id)).map((r) => r.id)).toEqual([row.id]);
    const source = host.rows(databaseId, { viewId: null, spec: ALL });
    expect((await settled(source, (s) => s.total === 2)).total).toBe(2);
    await session.restorePage(row.id);
    expect(await store.trashedRows(ws.id)).toEqual([]);
    expect((await settled(source, (s) => s.total === 3)).total).toBe(3);
    source.close();
  });

  it("counts the trash's rows for the sidebar, reading the store only when a change moves it", async () => {
    const { store, session, host, databaseId, ws } = await localDatabase();
    const reads = vi.spyOn(store, 'trashedRows');
    let told = 0;
    const off = session.onTrashedRows(() => told++);
    const count = async (n: number) => {
      await until(() => session.trashedRowCount(ws.id) === n, `a count of ${n}`);
      await until(async () => (await store.trashedRows(ws.id)).length === n);
    };
    expect(session.trashedRowCount(ws.id)).toBe(0);
    await until(() => reads.mock.calls.length === 1, 'the first count');
    const [one, two] = session.mirror.rowsOf(databaseId);
    await session.trashPage(one.id);
    await until(() => session.trashedRowCount(ws.id) === 1, 'one row');
    await session.trashPage(two.id);
    await until(() => session.trashedRowCount(ws.id) === 2, 'two rows');
    expect(told).toBe(2);
    // Edits that do not move a row in or out of the trash read nothing.
    const before = reads.mock.calls.length;
    const [three] = session.mirror.rowsOf(databaseId).filter((r) => !r.trashedAt);
    await host.apply([newOp('page.update', ws.id, three.id, { title: 'Renamed' })]);
    await session.updatePage(three.id, { icon: '✅' });
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads.mock.calls.length).toBe(before);
    // A restore, and a delete for good.
    await session.restorePage(one.id);
    await count(1);
    await session.deletePage(two.id);
    await count(0);
    // The sync engine's word that rows changed (another device's trash, say): counted again.
    const at = reads.mock.calls.length;
    session.rowsChanged(databaseId);
    await until(() => reads.mock.calls.length > at, 'a count after the rows changed');
    off();
  });

  it('makes empty rows after the last ones', async () => {
    const { session, host, databaseId, ws, section } = await localDatabase();
    const last = [...session.mirror.rowsOf(databaseId)]
      .map((r) => r.orderKey)
      .sort()
      .at(-1)!;
    await host.apply(
      emptyRowsOps({ id: databaseId, workspaceId: ws.id, sectionId: section.id }, 2, {
        after: last,
      }),
    );
    expect(session.mirror.rowsOf(databaseId)).toHaveLength(5);
  });
});

describe('the database host on a synced workspace', () => {
  /** Alice's tasks database under Alpha on the server, and a second device of hers with a session. */
  async function synced(server = new FakeServer()) {
    const shared = await sharedWorkspace(server);
    const made = await makeDatabase(shared.one.store, shared.ws.id, shared.section.id, shared.a.id);
    await shared.one.engine.syncOnce();
    const two = device(server);
    await two.engine.syncOnce();
    const session = await sessionOf(two);
    session.switchTo(shared.ws.id);
    const host = hostFor(session);
    const { sync, changed } = syncOf(two, server);
    host.connect(sync);
    return { server, ...shared, ...made, two, session, host, sync, changed };
  }

  it('holds a database a view shows, asks the server until it is complete, then queries here', async () => {
    const { db, view, two, host, session } = await synced();
    expect(await two.store.dbHold(db.id)).toBeNull();
    const source = host.rows(db.id, { viewId: view.id, spec: ALL });
    // Held (the view asked for it) and not fetched yet: the server's query answers.
    await until(async () => !!(await two.store.dbHold(db.id)), 'the hold');
    let snapshot = await settled(source, (s) => s.total === 3);
    expect(titles(snapshot).sort()).toEqual(['One', 'Three', 'Two']);
    expect(snapshot.localOnly).toBe(false);
    // A pass fetches every row: the view reads them on this device from then on.
    await two.engine.syncOnce();
    await until(() => host.queriesLocally(db.id), 'a complete hold');
    snapshot = await settled(source, (s) => s.total === 3);
    expect(snapshot.complete).toBe(true);
    expect(session.mirror.rowsOf(db.id)).toHaveLength(3);
    // People are the workspace's members.
    await until(() => host.people().length === 1);
    expect(host.me()).toMatchObject({ id: ALICE.id, name: 'Ada' });
    expect(host.queryContext().people).toEqual({ [ALICE.id]: 'Ada' });
    source.close();
  });

  it('shows the rows on this device, flagged, while offline', async () => {
    const { server, db, view, host } = await synced();
    server.offline = true;
    const source = host.rows(db.id, { viewId: view.id, spec: ALL });
    const snapshot = await settled(source, (s) => s.localOnly);
    expect(snapshot).toMatchObject({ localOnly: true, complete: true, total: 0, error: null });
    source.close();
  });

  it('pages a large database through the server, keeps its rows, and falls back to them offline', async () => {
    const server = new FakeServer();
    const { db, view, two, host, changed, session } = await synced(server);
    server.seedRows(db.id, LOCAL_ROW_LIMIT + 5, (i) => ({ [PROP.count]: i }));
    await two.engine.syncOnce();
    expect(
      (await session.store.readMirror(null)).databases.find((d) => d.id === db.id)?.rowCount,
    ).toBe(LOCAL_ROW_LIMIT + 8);
    const spec: QuerySpec = { ...ALL, sorts: [{ propertyId: PROP.count, direction: 'desc' }] };
    const source = host.rows(db.id, { viewId: view.id, spec, pageSize: 50 });
    let snapshot = await settled(source, (s) => s.rows.length === 50);
    expect((await two.store.dbHold(db.id))?.mode).toBe('partial');
    expect(snapshot).toMatchObject({
      total: LOCAL_ROW_LIMIT + 8,
      complete: false,
      localOnly: false,
    });
    expect(snapshot.rows[0].values[PROP.count]).toBe(LOCAL_ROW_LIMIT + 4);
    source.loadMore();
    snapshot = await settled(source, (s) => s.rows.length === 100);
    expect(snapshot.rows[99].values[PROP.count]).toBe(LOCAL_ROW_LIMIT - 95);
    // The rows the server gave are kept (a partial hold is that cache): offline, they show.
    await until(async () => (await two.store.readRows(db.id)).length >= 100, 'the kept rows');
    server.offline = true;
    changed();
    const offline = host.rows(db.id, { viewId: view.id, spec });
    snapshot = await settled(offline, (s) => s.localOnly && s.rows.length >= 100);
    expect(snapshot.rows[0].values[PROP.count]).toBe(LOCAL_ROW_LIMIT + 4);
    // An edit shows at once in the server's rows, from this device's copy.
    server.offline = false;
    const top = source.snapshot().rows[0];
    await host.apply([
      newOp('row.update', top.workspaceId, top.id, { values: { [PROP.notes]: 'Seen' } }),
    ]);
    snapshot = await settled(source, (s) => s.rows[0]?.values[PROP.notes] === 'Seen');
    expect(snapshot.rows[0].id).toBe(top.id);
    offline.close();
    source.close();
  });

  // Found by the Phase 4 e2e specs (Edge): a query that failed as the network came back left the
  // view on this device's rows for good, since the network had already been seen to return.
  it('asks the server again after a query failed while online', async () => {
    const server = new FakeServer();
    const { db, view, two, session } = await synced(server);
    server.seedRows(db.id, LOCAL_ROW_LIMIT + 5, (i) => ({ [PROP.count]: i }));
    await two.engine.syncOnce();
    let failures = 1;
    const { sync, changed } = syncOf(two, server, {
      queryDatabase: async (id, request) => {
        if (failures-- > 0)
          throw Object.assign(new Error('The network is down'), { name: 'NetworkError' });
        return two.engine.queryDatabase(id, request);
      },
    });
    const host = hostFor(session);
    host.connect(sync);
    const source = host.rows(db.id, { viewId: view.id, spec: ALL, pageSize: 50 });
    expect((await settled(source, (s) => s.localOnly)).localOnly).toBe(true);
    expect(sync.online()).toBe(true);
    // The engine's next status (online all along): the view asks the server again.
    changed();
    const snapshot = await settled(source, (s) => !s.localOnly && s.total === LOCAL_ROW_LIMIT + 8);
    expect(snapshot.rows).toHaveLength(50);
    source.close();
  });

  it('groups the server’s rows and pages within a group', async () => {
    const server = new FakeServer();
    const { db, view, two, host } = await synced(server);
    server.seedRows(db.id, LOCAL_ROW_LIMIT + 1, (i) => ({
      [PROP.stage]: i % 2 ? STAGE.open : STAGE.shut,
    }));
    await two.engine.syncOnce();
    const spec: QuerySpec = { ...ALL, group: { propertyId: PROP.stage } };
    const source = host.rows(db.id, { viewId: view.id, spec, pageSize: 20 });
    let snapshot = await settled(source, (s) => !!s.groups?.length);
    const open = snapshot.groups!.find((g) => g.key === STAGE.open)!;
    expect(open.complete).toBe(false);
    const before = open.rows.length;
    source.loadMore(STAGE.open);
    snapshot = await settled(
      source,
      (s) => s.groups!.find((g) => g.key === STAGE.open)!.rows.length > before,
    );
    expect(snapshot.groups!.map((g) => g.key)).toEqual(['', STAGE.open, STAGE.shut]);
    source.close();
  });

  it('finds a row a search named that this device does not hold', async () => {
    const server = new FakeServer();
    const { db, two, host, session } = await synced(server);
    const [far] = server.seedRows(db.id, LOCAL_ROW_LIMIT + 1);
    await two.engine.syncOnce();
    expect(await session.findRow(far.id)).toBeNull();
    expect(await host.locateRow(far.id, far.title)).toBe(true);
    expect((await session.findRow(far.id))?.databaseId).toBe(db.id);
  });

  it('pulls a row a search found from the database the hit names, asking no other', async () => {
    const server = new FakeServer();
    const { db, one, two, ws, section, a, host, session } = await synced(server);
    const other = await makeDatabase(one.store, ws.id, section.id, a.id, ['Far away'], 'Projects');
    await one.engine.syncOnce();
    await two.engine.syncOnce();
    const asked: string[] = [];
    let passes = 0;
    const { sync } = syncOf(two, server, {
      peekQuery: (id, request) => {
        asked.push(`peek ${id}`);
        return server.api(ALICE).query(id, request);
      },
      queryDatabase: (id, request) => {
        asked.push(`query ${id}`);
        return two.engine.queryDatabase(id, request);
      },
      syncNow: () => {
        passes++;
        return two.engine.syncOnce();
      },
    });
    host.connect(sync);
    const [far] = other.rows;
    expect(await session.findRow(far.id)).toBeNull();
    expect(await host.locateRow(far.id, far.title, other.db.id)).toBe(true);
    expect((await session.findRow(far.id))?.databaseId).toBe(other.db.id);
    expect(asked).toEqual([`query ${other.db.id}`]);
    expect(passes).toBe(0);
    expect(await two.store.dbHold(db.id)).toBeNull();
  });

  it('pulls a template a search found, which no query answers, with a pass', async () => {
    const server = new FakeServer();
    const { one, two, ws, section, a, host, session, sync } = await synced(server);
    const other = await makeDatabase(one.store, ws.id, section.id, a.id, ['Far away'], 'Projects');
    const template = {
      ...rowCreate(ws.id, section.id, other.db.id, 'Weekly review', {}, 'b0'),
      isTemplate: true,
    };
    await one.store.applyLocalOps([newOp('page.create', ws.id, template.id, template)]);
    await one.engine.syncOnce();
    await two.engine.syncOnce();
    let passes = 0;
    host.connect({
      ...sync,
      syncNow: () => {
        passes++;
        return two.engine.syncOnce();
      },
    });
    expect(await host.locateRow(template.id, template.title, other.db.id)).toBe(true);
    expect((await session.findRow(template.id))?.isTemplate).toBe(true);
    expect(passes).toBe(1);
  });

  it('imports a CSV on the server once the database it made has reached it', async () => {
    const server = new FakeServer();
    const seen: boolean[] = [];
    const { two, host, session, ws, section, a } = await synced(server);
    const { sync } = syncOf(two, server, {
      importCsv: async (databaseId) => {
        // The database is on the server when its rows are imported.
        const tree = await server.api(ALICE).tree(ws.id, null);
        seen.push(tree.databases.some((d) => d.id === databaseId));
        return { created: 2, problems: [] };
      },
      exportCsv: async () => new TextEncoder().encode('﻿Name\r\nOne\r\n'),
    });
    host.connect(sync);
    const made = newDatabaseOps(
      { workspaceId: ws.id, sectionId: section.id, parentPageId: a.id, orderKey: 'b0' },
      NAMES,
      { rows: 0 },
    );
    await host.apply(made.ops);
    const answer = await host.importCsv!(made.databaseId, {
      csv: 'Name\r\nA\r\nB\r\n',
      columns: ['title'],
      header: true,
    });
    expect(answer.created).toBe(2);
    expect(seen).toEqual([true]);
    const blob = await host.exportCsv!(made.databaseId, made.viewId);
    expect(new Uint8Array(await blob.arrayBuffer())[0]).toBe(0xef);
    void session;
  });

  it('saves a file through the platform', async () => {
    const saveFile = vi.fn(async () => undefined);
    const store = new MemoryStore();
    const session = await WorkspaceSession.start(store);
    const host = hostFor(session, { saveFile });
    await host.saveFile(
      'Tasks - Table.csv',
      new Blob(['﻿Name\r\n'], { type: 'text/csv;charset=utf-8' }),
    );
    expect(saveFile).toHaveBeenCalledWith(
      'Tasks - Table.csv',
      expect.any(Uint8Array),
      'text/csv;charset=utf-8',
    );
  });
});

describe('the export and import of a workspace with databases', () => {
  async function exported() {
    const store = new MemoryStore();
    const made = await localWorkspace(store);
    const tasks = await makeDatabase(store, made.ws.id, made.section.id, made.a.id);
    const session = await WorkspaceSession.start(store);
    session.switchTo(made.ws.id);
    const [one, two] = tasks.rows;
    await session.apply([
      newOp('row.update', made.ws.id, one.id, {
        values: { [PROP.link]: [two.id], [PROP.notes]: '=1+1' },
      }),
    ]);
    // A body for the first row.
    await session.writeFirstDocument(one.id, made.ws.id, {
      type: 'doc',
      content: [
        {
          type: 'block',
          attrs: { id: 'AbCdEfGhIjKl' },
          content: [
            {
              type: 'textBody',
              attrs: { kind: 'paragraph' },
              content: [{ type: 'text', text: 'Row body' }],
            },
          ],
        },
      ],
    });
    const { files, manifest } = await buildExport(session, { untitled: 'Untitled' });
    return { store, session, files, manifest, ...made, ...tasks };
  }

  it('writes version 2: databases, rows with values, every entry’s kind, a CSV beside each database', async () => {
    const { files, manifest, db, view, rows } = await exported();
    expect(manifest).toMatchObject({ format: FORMAT, version: 2 });
    expect(manifest.pages.every((p) => p.kind)).toBe(true);
    const database = manifest.databases!.find((d) => d.id === db.id)!;
    expect(database.views.map((v) => v.id)).toEqual([view.id]);
    expect(database.properties.map((p) => p.id)).toContain(PROP.link);
    const entry = manifest.pages.find((p) => p.id === db.id)!;
    expect(entry.kind).toBe('database');
    const csvPath = entry.markdown!.replace(/\.md$/, '.csv');
    expect(csvPath).toMatch(/Tasks\/Tasks\.csv$/);
    // UTF-8 with its BOM, for spreadsheets.
    expect([...files[csvPath].slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(files[csvPath]);
    const table = parseCsv(csv);
    expect(table[0]).toEqual(expect.arrayContaining(['Name', 'Notes', 'Count', 'Blocks']));
    expect(table).toHaveLength(4);
    // People read it: related rows by title, and formula-like text guarded.
    expect(csv).toContain(`'=1+1`);
    expect(table[1]).toContain('Two');
    const rowEntries = manifest.pages.filter((p) => p.kind === 'row');
    expect(rowEntries).toHaveLength(3);
    const first = rowEntries.find((r) => r.id === rows[0].id)!;
    expect(first).toMatchObject({ databaseId: db.id, parentPageId: db.id });
    expect(first.values![PROP.link]).toEqual([rows[1].id]);
    // A row's body sits in its database's folder, as a child page's does.
    expect(first.markdown).toMatch(/Tasks\/One\/One\.md$/);
    expect(new TextDecoder().decode(files[first.markdown!])).toContain('Row body');
    expect(rowEntries.find((r) => r.id === rows[2].id)!.markdown).toBeUndefined();
    expect(files[MANIFEST]).toBeDefined();
  });

  it('reads it back into a new workspace: databases, views, rows and relations with new ids', async () => {
    const { session, files, rows: original, db } = await exported();
    const first = await readExport(session, files, ' (imported)');
    expect(first).toBeTruthy();
    const workspaceId = session.workspaceId!;
    expect(session.current?.name).toBe('Mine (imported)');
    const databases = [...session.mirror.databases.values()].filter(
      (d) => d.workspaceId === workspaceId,
    );
    expect(databases).toHaveLength(1);
    const copy = databases[0];
    expect(copy.id).not.toBe(db.id);
    expect(copy.properties.map((p) => p.id)).toEqual(
      session.mirror.databases.get(db.id)!.properties.map((p) => p.id),
    );
    const link = copy.properties.find((p) => p.id === PROP.link)!;
    expect(link.relation?.databaseId).toBe(copy.id);
    expect(session.mirror.viewsOf(copy.id)).toHaveLength(1);
    const rows = await session.loadRows(copy.id);
    expect(rows.map((r) => r.title).sort()).toEqual(['One', 'Three', 'Two']);
    const one = rows.find((r) => r.title === 'One')!;
    const two = rows.find((r) => r.title === 'Two')!;
    expect(one.values[PROP.link]).toEqual([two.id]);
    expect(two.values[PROP.back]).toEqual([one.id]);
    expect(one.values[PROP.notes]).toBe('=1+1');
    expect(original.some((r) => r.id === one.id)).toBe(false);
    // The row's body came with it.
    const doc = await PageDocument.open(one.id, session.store, { canEdit: false });
    expect(plainText(fragmentToJSON(doc.fragment))).toContain('Row body');
    await doc.close();
  });

  it('still reads a version 1 export', async () => {
    const store = new MemoryStore();
    const session = await WorkspaceSession.start(store);
    const sectionId = uuidv7();
    const pageId = uuidv7();
    const manifest: ExportManifest = {
      format: FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: { id: uuidv7(), name: 'Old', icon: null },
      sections: [{ id: sectionId, name: 'Pages', orderKey: 'a0', visibility: 'workspace' }],
      pages: [
        {
          id: pageId,
          sectionId,
          parentPageId: null,
          orderKey: 'a0',
          title: 'Kept',
          icon: null,
          coverAssetId: null,
          isTemplate: false,
          markdown: 'Pages/Kept/Kept.md',
          json: 'Pages/Kept/Kept.json',
        },
      ],
      assets: [],
    };
    const files = {
      [MANIFEST]: new TextEncoder().encode(JSON.stringify(manifest)),
      'Pages/Kept/Kept.json': new TextEncoder().encode(
        JSON.stringify({
          id: pageId,
          title: 'Kept',
          icon: null,
          schemaVersion: 1,
          content: { type: 'doc', content: [] },
        }),
      ),
    };
    const first = await readExport(session, files, '');
    expect(session.mirror.pages.get(first)).toMatchObject({ title: 'Kept', kind: 'page' });
  });

  it('reads the server’s version 2 as well: full view records and a database page’s document', async () => {
    const { session, files, manifest, db } = await exported();
    const server: ExportManifest = {
      ...manifest,
      databases: manifest.databases!.map((d) => ({
        ...d,
        views: d.views.map((v) => ({
          ...v,
          workspaceId: 'w',
          databaseId: d.id,
          version: 3,
          createdAt: 'x',
        })),
      })),
    };
    await readExport(
      session,
      { ...files, [MANIFEST]: new TextEncoder().encode(JSON.stringify(server)) },
      '',
    );
    const copies = [...session.mirror.databases.values()].filter((d) => d.id !== db.id);
    expect(copies).toHaveLength(1);
    expect(session.mirror.viewsOf(copies[0].id)[0].version).toBe(1);
  });
});
