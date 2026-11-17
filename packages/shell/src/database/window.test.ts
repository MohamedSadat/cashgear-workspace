// The date window through the shell's database host (Phase 9): a calendar's or a timeline's query
// carries its window to the server for a database the server queries (the fake server answers it
// by `queryRows`, as the C# port does by the same vectors), and `queryRows` applies it here for a
// database this device holds in full.
import type { RowSnapshot, RowSource } from '@cgw/database';
import {
  LOCAL_ROW_LIMIT,
  MemoryStore,
  newOp,
  type PropertyDef,
  type QueryRequest,
  type QuerySpec,
} from '@cgw/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer } from '../../../workspace/src/testing/fakeServer';
import {
  ALICE,
  device,
  localWorkspace,
  makeDatabase,
  sharedWorkspace,
} from '../../../workspace/src/testing/syncHarness';
import { WorkspaceSession } from '../session';
import { ShellDatabaseHost, type DatabaseSync } from './host';

const DUE: PropertyDef = {
  id: 'Due00001',
  name: 'Due',
  type: 'date',
  date: { includeTime: false },
};
const WINDOW = { propertyId: DUE.id, endPropertyId: null, from: '2026-11-10', to: '2026-11-19' };
const SPEC: QuerySpec = {
  filter: null,
  sorts: [{ propertyId: DUE.id, direction: 'asc' }],
  group: null,
  window: WINDOW,
};
/** Day `i` of November 2026 (1 to 28, then round again). */
const dueOf = (i: number) => ({ start: `2026-11-${String((i % 28) + 1).padStart(2, '0')}` });
const inWindow = (i: number) => {
  const day = (i % 28) + 1;
  return day >= 10 && day <= 19;
};

const hosts: ShellDatabaseHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
});

async function settled(source: RowSource, check: (s: RowSnapshot) => boolean) {
  for (let i = 0; i < 400; i++) {
    const snapshot = source.snapshot();
    if (!snapshot.loading && check(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the rows');
}

describe('the date window through the database host', { timeout: 30_000 }, () => {
  it('goes to the server with the query for a database the server queries', async () => {
    const server = new FakeServer();
    const shared = await sharedWorkspace(server);
    const { db } = await makeDatabase(
      shared.one.store,
      shared.ws.id,
      shared.section.id,
      shared.a.id,
    );
    await shared.one.store.applyLocalOps([
      newOp('db.update', shared.ws.id, db.id, { properties: [DUE] }),
    ]);
    await shared.one.engine.syncOnce();
    const count = LOCAL_ROW_LIMIT + 60;
    server.seedRows(db.id, count, (i) => ({ [DUE.id]: dueOf(i) }));
    const two = device(server);
    await two.engine.syncOnce();
    const session = await WorkspaceSession.start(two.store);
    session.switchTo(shared.ws.id);
    const host = new ShellDatabaseHost({ session, open: () => undefined });
    hosts.push(host);
    const asked: QueryRequest[] = [];
    const sync: DatabaseSync = {
      online: () => true,
      account: () => ({ id: ALICE.id, displayName: 'Ada', email: ALICE.email }),
      holdDatabase: (id) => two.engine.holdDatabase(id),
      queryDatabase: (id, request) => {
        asked.push(request);
        return two.engine.queryDatabase(id, request);
      },
      members: async () => [{ userId: ALICE.id, displayName: 'Ada', email: ALICE.email }],
      syncNow: () => two.engine.syncOnce(),
      importCsv: async () => ({ created: 0, problems: [] }),
      exportCsv: async () => new Uint8Array(),
      subscribe: () => () => undefined,
    };
    host.connect(sync);
    const source = host.rows(db.id, { viewId: null, spec: SPEC, pageSize: 500 });
    const expected = Array.from({ length: count }, (_, i) => i).filter(inWindow).length;
    const snapshot = await settled(source, (s) => s.total === expected);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0].window).toEqual(WINDOW);
    expect(snapshot.localOnly).toBe(false);
    expect(snapshot.rows.length).toBeLessThanOrEqual(500);
    for (const row of snapshot.rows) {
      const start = (row.values[DUE.id] as { start: string }).start;
      expect(start >= WINDOW.from && start <= WINDOW.to).toBe(true);
    }
    source.close();
  });

  it('is applied here for a database this device holds in full', async () => {
    const store = new MemoryStore();
    const made = await localWorkspace(store);
    const { db } = await makeDatabase(store, made.ws.id, made.section.id, made.a.id, [
      'Early',
      'Inside',
      'Late',
      'Undated',
    ]);
    const session = await WorkspaceSession.start(store);
    session.switchTo(made.ws.id);
    const host = new ShellDatabaseHost({ session, open: () => undefined });
    hosts.push(host);
    await host.apply([newOp('db.update', made.ws.id, db.id, { properties: [DUE] })]);
    const rows = session.mirror.rowsOf(db.id);
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    const set = (title: string, start: string) =>
      newOp('row.update', made.ws.id, byTitle.get(title)!.id, {
        values: { [DUE.id]: { start } },
      });
    await host.apply([
      set('Early', '2026-11-01'),
      set('Inside', '2026-11-12'),
      set('Late', '2026-12-01'),
    ]);
    const source = host.rows(db.id, { viewId: null, spec: SPEC });
    const snapshot = await settled(source, (s) => s.complete);
    expect(snapshot.rows.map((r) => r.title)).toEqual(['Inside']);
    source.close();
  });
});
