// What the sync engine's tests share: accounts, a device (a store and an engine over the fake
// server), a local workspace to upload, a virtual clock for the loop's timers, and the tree as the
// server shows it to an account (to compare a device's mirror with). Phase 4: a database to make
// (its properties, a view, rows), and rows as a device holds them and as the server has them.
import { newOp } from '../build';
import type { PropertyDef, PropertyId, Value, ViewRecord } from '../db/types';
import { uuidv7, type Id } from '../ids';
import { MemoryStore } from '../memory';
import type { Account, DocCodec, SyncApi } from '../sync/api';
import { SyncEngine, type SyncEvent, type SyncOptions } from '../sync/engine';
import type {
  LocalStore,
  PageCreate,
  PageRecord,
  RowRecord,
  SectionRecord,
  WorkspaceRecord,
} from '../types';
import { fakeCodec, type FakeServer } from './fakeServer';

export const ALICE: Account = {
  id: '0193a1b2-c3d4-7e5f-8a9b-00000000000a',
  email: 'a@x.test',
  displayName: 'A',
  deviceId: null,
};

export const BOB: Account = {
  id: '0193a1b2-c3d4-7e5f-8a9b-00000000000b',
  email: 'b@x.test',
  displayName: 'B',
  deviceId: null,
};

export interface Device {
  store: MemoryStore;
  engine: SyncEngine;
  events: SyncEvent[];
  /** The notice codes the user was shown, in order. */
  notices(): string[];
}

export function device(
  server: FakeServer,
  account: Account = ALICE,
  options: SyncOptions & {
    store?: MemoryStore;
    codec?: DocCodec;
    signIn?: boolean;
    /** Wraps the server's API (a call that also does something, a fault of the test's own). */
    api?: (base: SyncApi) => Partial<SyncApi>;
  } = {},
): Device {
  const store = options.store ?? new MemoryStore();
  const base = server.api(account);
  const api: SyncApi = options.api ? { ...base, ...options.api(base) } : base;
  const engine = new SyncEngine(store, api, options.codec ?? fakeCodec, {
    setTimer: () => null,
    clearTimer: () => undefined,
    random: () => 0.5,
    ...options,
  });
  const events: SyncEvent[] = [];
  engine.on((e) => events.push(e));
  if (options.signIn !== false) engine.setAccount(account);
  return {
    store,
    engine,
    events,
    notices: () => events.flatMap((e) => (e.kind === 'notice' ? [e.code] : [])),
  };
}

export const now = () => new Date().toISOString();

export function pageRecord(
  ws: Id,
  section: Id,
  title: string,
  parent: Id | null,
  orderKey: string,
): PageRecord {
  return {
    id: uuidv7(),
    workspaceId: ws,
    sectionId: section,
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
  };
}

/** A local workspace with a section and three pages: Alpha (with Beta under it) and Gamma. */
export async function localWorkspace(store: LocalStore) {
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
  const a = pageRecord(ws.id, section.id, 'Alpha', null, 'a0');
  const b = pageRecord(ws.id, section.id, 'Beta', a.id, 'a0');
  const c = pageRecord(ws.id, section.id, 'Gamma', null, 'a1');
  await store.applyLocalOps([
    newOp('workspace.create', ws.id, ws.id, ws),
    newOp('section.create', ws.id, section.id, section),
    ...[a, b, c].map((p) => newOp('page.create', ws.id, p.id, p)),
  ]);
  return { ws, section, a, b, c };
}

/** A workspace on the server (uploaded from a first device), held by that device. */
export async function sharedWorkspace(server: FakeServer, account: Account = ALICE) {
  const one = device(server, account);
  const made = await localWorkspace(one.store);
  await one.engine.upload(made.ws.id);
  await one.engine.syncOnce();
  return { one, ...made };
}

/** What a tree comparison looks at: the records' places, names, trash and versions. */
export const shape = (pages: PageRecord[]) =>
  Object.fromEntries(
    [...pages]
      .sort((x, y) => (x.id < y.id ? -1 : 1))
      .map((p) => [
        p.id,
        {
          title: p.title,
          icon: p.icon,
          sectionId: p.sectionId,
          parentPageId: p.parentPageId,
          orderKey: p.orderKey,
          trashed: p.trashedAt !== null,
          trashRootId: p.trashRootId,
          version: p.version,
        },
      ]),
  );

export async function mirrorShape(store: LocalStore, workspaceId: Id) {
  return shape((await store.readMirror(workspaceId)).pages);
}

/** The tree the server shows an account. */
export async function serverShape(server: FakeServer, account: Account, workspaceId: Id) {
  const offline = server.offline;
  server.offline = false;
  try {
    return shape((await server.api(account).tree(workspaceId, null)).pages);
  } finally {
    server.offline = offline;
  }
}

// Databases ---------------------------------------------------------------------------------------

/** Property ids of the tasks database (8 characters of base 62). */
export const PROP = {
  notes: 'Notes001',
  count: 'Count001',
  stage: 'Stage001',
  done: 'Done0001',
  /** A relation to rows of the same database, kept in step with `back`. */
  link: 'Link0001',
  back: 'Back0001',
} as const;

export const STAGE = { open: 'Open0001', shut: 'Shut0001' } as const;

/** The tasks database's properties (the title is added by the planner). */
export const TASK_PROPS: PropertyDef[] = [
  { id: PROP.notes, name: 'Notes', type: 'text' },
  { id: PROP.count, name: 'Count', type: 'number', number: { format: 'number', decimals: null } },
  {
    id: PROP.stage,
    name: 'Stage',
    type: 'select',
    options: [
      { id: STAGE.open, name: 'Open', colour: 'blue' },
      { id: STAGE.shut, name: 'Closed', colour: 'green' },
    ],
  },
  { id: PROP.done, name: 'Done', type: 'checkbox' },
];

/** The self-relation added to a tasks database (and its reverse, which the planner adds). */
export const linkDef = (databaseId: Id): PropertyDef => ({
  id: PROP.link,
  name: 'Blocks',
  type: 'relation',
  relation: { databaseId, reversePropertyId: PROP.back },
});

export function tableView(workspaceId: Id, databaseId: Id, name = 'Table', orderKey = 'a0') {
  const view: ViewRecord = {
    id: uuidv7(),
    workspaceId,
    databaseId,
    name,
    type: 'table',
    orderKey,
    config: {
      filter: null,
      sorts: [],
      group: null,
      properties: { order: [], hidden: [], widths: {} },
    },
    version: 1,
    createdAt: now(),
  };
  return view;
}

/** A row as `page.create` makes one, with its first values. */
export function rowCreate(
  ws: Id,
  section: Id,
  databaseId: Id,
  title: string,
  values: Record<PropertyId, Value> = {},
  orderKey = 'a0',
): PageCreate {
  return { ...pageRecord(ws, section, title, databaseId, orderKey), kind: 'row', row: { values } };
}

/**
 * A tasks database made on a device (in its outbox, as made offline): its page under `parent`, a
 * table view, the self-relation, and a row for each title given (in order).
 */
export async function makeDatabase(
  store: LocalStore,
  ws: Id,
  section: Id,
  parent: Id | null,
  titles: string[] = ['One', 'Two', 'Three'],
  title = 'Tasks',
) {
  const page = { ...pageRecord(ws, section, title, parent, 'a8'), kind: 'database' as const };
  const view = tableView(ws, page.id);
  const rows = titles.map((t, i) =>
    rowCreate(ws, section, page.id, t, { [PROP.count]: i + 1 }, `a${i}`),
  );
  await store.applyLocalOps([
    newOp('page.create', ws, page.id, { ...page, database: { properties: TASK_PROPS } }),
    newOp('db.update', ws, page.id, { properties: [linkDef(page.id)] }),
    newOp('view.upsert', ws, view.id, view),
    ...rows.map((r) => newOp('page.create', ws, r.id, r)),
  ]);
  return { db: page, view, rows };
}

/** What a row comparison looks at: its place, title, trash, values and versions. */
export const rowShape = (rows: RowRecord[]) =>
  Object.fromEntries(
    [...rows]
      .sort((x, y) => (x.id < y.id ? -1 : 1))
      .map((r) => [
        r.id,
        {
          title: r.title,
          orderKey: r.orderKey,
          trashed: r.trashedAt !== null,
          trashRootId: r.trashRootId,
          isTemplate: r.isTemplate,
          values: r.values,
          versions: r.versions,
          version: r.version,
        },
      ]),
  );

/** The rows a device holds of a database. */
export async function heldRows(store: LocalStore, databaseId: Id) {
  return rowShape(await store.readRows(databaseId));
}

/** The rows the server has of a database (every one, as `rows` gives them). */
export async function serverRows(server: FakeServer, account: Account, databaseId: Id) {
  const offline = server.offline;
  server.offline = false;
  try {
    const api = server.api(account);
    const rows: RowRecord[] = [];
    let after: Id | null = null;
    for (;;) {
      const page = await api.rows(databaseId, after, 1000);
      rows.push(...page.rows);
      if (!page.next) break;
      after = page.next;
    }
    return rowShape(rows);
  } finally {
    server.offline = offline;
  }
}

/** One row as the server has it. */
export function serverRow(server: FakeServer, rowId: Id): RowRecord | undefined {
  for (const space of server.spaces.values()) {
    const row = space.mirror.rowRecords.get(rowId);
    if (row) return row;
  }
  return undefined;
}

/** Timers on a clock the test moves: what the loop schedules runs only when the test says. */
export class VirtualClock {
  t = Date.UTC(2026, 10, 12, 9, 0, 0);
  private timers: { fn: () => void; at: number }[] = [];

  readonly now = () => this.t;
  readonly setTimer = (fn: () => void, ms: number) => {
    const timer = { fn, at: this.t + ms };
    this.timers.push(timer);
    return timer;
  };
  readonly clearTimer = (handle: unknown) => {
    this.timers = this.timers.filter((t) => t !== handle);
  };

  get pending(): number {
    return this.timers.length;
  }

  /** When the next timer is due, or null. */
  get next(): number | null {
    return this.timers.length ? Math.min(...this.timers.map((t) => t.at)) : null;
  }

  /** Moves the clock without firing anything: the machine was asleep. */
  jump(ms: number) {
    this.t += ms;
  }

  /** Fires the earliest timer (moving the clock to it unless it is already later), then waits. */
  async fireNext(engine: SyncEngine): Promise<boolean> {
    if (!this.timers.length) return false;
    const timer = this.timers.reduce((a, b) => (b.at < a.at ? b : a));
    this.timers = this.timers.filter((t) => t !== timer);
    this.t = Math.max(this.t, timer.at);
    timer.fn();
    await settle(engine);
    return true;
  }

  /** Fires every timer due within `ms` from now, in order. */
  async advance(engine: SyncEngine, ms: number) {
    const end = this.t + ms;
    while (this.next !== null && this.next <= end) await this.fireNext(engine);
    this.t = end;
  }
}

/** Lets a pass the timers started run to its end (and background work like a pool refill). */
export async function settle(engine: SyncEngine) {
  await engine.idle();
  await new Promise((resolve) => setImmediate(resolve));
  await engine.idle();
}
