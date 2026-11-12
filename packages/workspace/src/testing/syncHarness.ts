// What the sync engine's tests share: accounts, a device (a store and an engine over the fake
// server), a local workspace to upload, a virtual clock for the loop's timers, and the tree as the
// server shows it to an account (to compare a device's mirror with).
import { newOp } from '../build';
import { uuidv7, type Id } from '../ids';
import { MemoryStore } from '../memory';
import type { Account, DocCodec, SyncApi } from '../sync/api';
import { SyncEngine, type SyncEvent, type SyncOptions } from '../sync/engine';
import type { LocalStore, PageRecord, SectionRecord, WorkspaceRecord } from '../types';
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
