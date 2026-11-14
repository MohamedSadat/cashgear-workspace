// The convergence simulator (IMPLEMENTATION_PLAN.md Phase 3, Automated tests; SYNC_DESIGN.md,
// "Two and three simulated clients, random operations, random network order, loss and
// duplication"): three people, each a sync engine over a MemoryStore with real Yjs documents,
// edit pages (blocks inserted, deleted, moved, text typed and deleted) and the tree (create,
// rename, move, trash, restore) against the fake server, through a fault layer that partitions
// clients for random spells, loses requests and answers, duplicates requests and reorders
// answers. At the end everyone syncs, and the checks say whether all three hold the server's tree
// and its documents (the same JSON, the same state hash) and whether every update the server
// acknowledged to a client is still in the server's state.
//
// Phase 4: Alice's workspace is uploaded with a database (a view, rows, a self-relation), which
// every client holds. Clients also edit it: rows made, values set (often the same property of the
// same row on several clients at once, often values that need coercing), titles, relations,
// rows trashed, restored and reordered, property types changed, properties deleted and restored,
// options deleted and added, properties added, the view changed; rows' documents are edited as
// pages' are, and the tree operations may move or trash the database's page. Every client must end
// with the server's database record, views and rows (values, per-property versions, versions).
//
// Phase 6 (`hub: true`): every client also holds a connection to the in-memory hub
// (testing/fakeHub.ts) and has the pages it opens joined, so its saves go through the hub and
// others' edits come in its frames; the frames are dropped, duplicated, reordered and delayed, a
// push's answer is lost with its socket now and then, sockets are cut for spells (always while a
// client is partitioned), and the whole hub drops every socket at once now and then (a recycle).
// Convergence must hold all the same: whatever the hub loses, HTTP brings.
//
// Seeded and deterministic: every choice comes from the seed, and every delay is a number of
// microtask turns, so the same seed interleaves the same way (the caller makes ids deterministic
// by seeding `crypto.getRandomValues` and `Date.now`).
import * as Y from 'yjs';
import {
  MemoryStore,
  OfflineError,
  OpError,
  STORED_TYPES,
  SyncEngine,
  SyncHttpError,
  compareSiblings,
  keyBetween,
  newOp,
  uuidv7,
  type Account,
  type Id,
  type Operation,
  type PageRecord,
  type PropertyDef,
  type PropertyType,
  type RowRecord,
  type RealtimeTransport,
  type SyncApi,
  type Value,
} from '@cgw/workspace';
import { FakeHub, NO_HUB_FAULTS } from '../../../workspace/src/testing/fakeHub';
import { FakeServer } from '../../../workspace/src/testing/fakeServer';
import {
  PROP,
  localWorkspace,
  makeDatabase,
  rowCreate,
  rowShape,
  shape,
} from '../../../workspace/src/testing/syncHarness';
import { docCodec } from '../codec';
import { CONTENT, LOAD, REMOTE, retryPending } from '../document';

export interface Faults {
  /** Chance a request never reaches the server. */
  loseRequest: number;
  /** Chance the server's answer never comes back (the request was applied). */
  loseAnswer: number;
  /** Chance the server gets a request twice. */
  duplicate: number;
  /** Per step, the chance a connected client is cut off, and a cut-off one comes back. */
  partitionStart: number;
  partitionEnd: number;
  /** Most microtask turns a request or an answer is held back (answers come back reordered). */
  maxDelay: number;
  // Over the hub (`hub: true`).
  /** Chance a frame is dropped, sent twice, or held back and sent after the next tick's. */
  dropFrame: number;
  duplicateFrame: number;
  reorderFrame: number;
  /** Most microtask turns a frame takes to arrive. */
  frameDelay: number;
  /** Chance a hub call is carried out and its answer lost with the socket. */
  loseHubAnswer: number;
  /** Per step, the chance a client's socket is cut, and a cut one restored. */
  cutStart: number;
  cutEnd: number;
  /** Per step, the chance the hub drops every socket at once. */
  storm: number;
}

export const DEFAULT_FAULTS: Faults = {
  loseRequest: 0.04,
  loseAnswer: 0.04,
  duplicate: 0.05,
  partitionStart: 0.08,
  partitionEnd: 0.3,
  maxDelay: 12,
  dropFrame: 0.08,
  duplicateFrame: 0.08,
  reorderFrame: 0.08,
  frameDelay: 12,
  loseHubAnswer: 0.03,
  cutStart: 0.08,
  cutEnd: 0.3,
  storm: 0.03,
};

export interface SimOptions {
  seed: number;
  /** Rounds in which every client acts (edits, tree operations, a pass) at once. */
  steps: number;
  faults?: Faults;
  /** Phase 6: every client also syncs through the in-memory hub. */
  hub?: boolean;
}

export interface SimReport {
  seed: number;
  steps: number;
  pages: number;
  /** Document updates the server holds, operations it applied, acknowledgements clients saw. */
  updates: number;
  ops: number;
  acked: number;
  edits: number;
  treeOps: number;
  /** Database operations the clients made, and the rows the server ended with. */
  dbOps: number;
  rows: number;
  faults: {
    lostRequests: number;
    lostAnswers: number;
    duplicates: number;
    partitioned: number;
  };
  /** Over the hub: frames relayed and the faults they met, sockets cut, storms, hub pushes. */
  hub: {
    frames: number;
    dropped: number;
    duplicated: number;
    reordered: number;
    lostAnswers: number;
    connects: number;
    cuts: number;
    storms: number;
    pushes: number;
  } | null;
  /** Rounds of syncing it took to settle once the faults stopped. */
  settleRounds: number;
  /** What converged, without ids (for the determinism check). */
  digest: string;
  /** Every disagreement found; empty when everyone converged. */
  problems: string[];
}

/** mulberry32: small, fast and good enough to drive a simulation. */
export function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T | undefined =>
      items.length ? items[Math.floor(next() * items.length)] : undefined,
  };
}

type Random = ReturnType<typeof random>;

const PEOPLE: Account[] = ['Alice', 'Bob', 'Carol'].map((name, i) => ({
  id: `0193a1b2-c3d4-7e5f-8a9b-00000000000${i + 1}`,
  email: `${name.toLowerCase()}@sim.test`,
  displayName: name,
  deviceId: null,
}));

const WORDS = ['alpha', 'beta', 'gamma', 'سلام', 'delta', 'كتاب', 'echo', 'zulu', ' ', ' ', '.'];
const NAMES = ['alpha', 'beta', 'gamma', 'سلام', 'delta', 'كتاب', 'Open', 'Closed', '12', '7.5'];
const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** The types a property's type changes between (a relation keeps its type). */
const TYPES: PropertyType[] = ['text', 'number', 'select', 'multiSelect', 'checkbox', 'date'];
const MAX_PROPERTIES = 12;

interface OpenDoc {
  doc: Y.Doc;
  /** Local updates not yet in the store. */
  pending: Uint8Array[];
  /** Remote updates that came while the document was loading. */
  early: Uint8Array[];
  ready: boolean;
}

/** A sync error the loop expects under faults (it backs off); anything else is a bug. */
const expected = (error: unknown) =>
  error instanceof OfflineError || error instanceof SyncHttpError || error instanceof OpError;

class Client {
  readonly store = new MemoryStore();
  readonly engine: SyncEngine;
  readonly docs = new Map<Id, OpenDoc>();
  /** Pages this client made (it may edit them before the server has them). */
  readonly created = new Set<Id>();
  /** Every acknowledgement this client received: what the server said it holds. */
  readonly acked: { pageId: Id; updateId: Id; data: Uint8Array }[] = [];
  partitioned = false;
  /** Over the hub: this client's socket is cut (for a spell, or while partitioned). */
  cut = false;
  clientId = 0;
  readonly transport: ReturnType<FakeHub['transport']> | null;

  constructor(
    readonly sim: Simulation,
    readonly account: Account,
    readonly rng: Random,
  ) {
    this.engine = new SyncEngine(this.store, sim.faulty(this, sim.server.api(account)), docCodec, {
      setTimer: () => null,
      clearTimer: () => undefined,
      random: rng.next,
    });
    // Its own loop's timers never fire here: a dropped socket comes back on the client's next
    // step (`retryNow`, as the network's return or the window's focus does).
    this.transport =
      sim.hub?.transport(account, {
        setTimer: () => null,
        clearTimer: () => undefined,
        random: random(rng.int(1, 1e9)).next,
      }) ?? null;
    if (this.transport) {
      this.engine.setRealtime(this.recording(this.transport));
      this.transport.start();
    }
    this.engine.on((event) => {
      if (event.kind === 'doc') {
        const open = this.docs.get(event.pageId);
        if (!open) return;
        if (!open.ready) open.early.push(...event.updates);
        else {
          open.doc.transact(() => {
            for (const update of event.updates) Y.applyUpdate(open.doc, update, REMOTE);
          }, REMOTE);
          retryPending(open.doc, REMOTE);
        }
      } else if (event.kind === 'docReset') this.docs.delete(event.pageId);
    });
  }

  /** The transport with every acknowledgement it brings recorded, as the HTTP ones are. */
  private recording(transport: RealtimeTransport): RealtimeTransport {
    return {
      get state() {
        return transport.state;
      },
      on: (event, listener) => transport.on(event, listener),
      joinWorkspaces: (ids) => transport.joinWorkspaces(ids),
      joinPage: (pageId) => transport.joinPage(pageId),
      leavePage: (pageId) => transport.leavePage(pageId),
      pushDoc: async (pageId, request) => {
        const answer = await transport.pushDoc(pageId, request);
        this.sim.hubPushes++;
        for (const ack of answer.acks) {
          const sent = request.updates.find((u) => u.updateId === ack.updateId);
          if (sent) this.acked.push({ pageId, updateId: ack.updateId, data: sent.data });
        }
        return answer;
      },
      awareness: (pageId, state) => transport.awareness(pageId, state),
    };
  }

  /** The page's document, loaded from the store (pulled first if this device does not hold it). */
  async open(pageId: Id): Promise<OpenDoc | null> {
    const existing = this.docs.get(pageId);
    if (existing) return existing.ready ? existing : null;
    if (!this.created.has(pageId) && !(await this.store.docCursor(pageId))) {
      try {
        await this.engine.pullPage(pageId);
      } catch (error) {
        if (expected(error)) return null;
        throw error;
      }
      if (!(await this.store.docCursor(pageId))) return null;
      if (this.docs.has(pageId)) return null;
    }
    const open: OpenDoc = { doc: new Y.Doc(), pending: [], early: [], ready: false };
    open.doc.clientID = this.clientId;
    this.docs.set(pageId, open);
    const stored = await this.store.loadDoc(pageId);
    open.doc.transact(() => {
      if (stored.snapshot) Y.applyUpdate(open.doc, stored.snapshot, LOAD);
      for (const update of stored.updates) Y.applyUpdate(open.doc, update.data, LOAD);
      for (const update of open.early) Y.applyUpdate(open.doc, update, REMOTE);
    }, LOAD);
    retryPending(open.doc);
    open.early = [];
    open.ready = true;
    open.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== LOAD && origin !== REMOTE) open.pending.push(update);
    });
    // The shell has it open: joined on the hub while connected.
    this.engine.live(pageId, true);
    return open;
  }

  /** What the document layer's autosave does: the edits since the last save, as one update. */
  async flush(pageId: Id) {
    const open = this.docs.get(pageId);
    if (!open?.pending.length) return;
    const data = Y.mergeUpdates(open.pending.splice(0));
    await this.store.appendDocUpdates(pageId, [{ updateId: uuidv7(), data }]);
    // Through the hub at once when the page is joined; otherwise a local change, as in Phase 3.
    this.engine.saved(pageId);
  }

  async flushAll() {
    for (const pageId of [...this.docs.keys()]) await this.flush(pageId);
  }

  /** One pass, with the faults it meets taken as the loop takes them (it tries again). */
  async pass() {
    try {
      await this.engine.syncOnce();
    } catch (error) {
      if (!expected(error)) throw error;
    }
  }
}

export class Simulation {
  readonly server: FakeServer;
  readonly hub: FakeHub | null;
  readonly clients: Client[];
  workspaceId: Id = '';
  sectionId: Id = '';
  databaseId: Id = '';
  faultsOn = false;
  readonly stats = { lostRequests: 0, lostAnswers: 0, duplicates: 0, partitioned: 0 };
  readonly hubStats = { cuts: 0, storms: 0 };
  hubPushes = 0;
  edits = 0;
  treeOps = 0;
  dbOps = 0;
  /** The server takes one request at a time, as its transactions would. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly rng: Random,
    readonly faults: Faults,
    hub = false,
  ) {
    this.server = new FakeServer({ codec: docCodec, random: rng.next });
    this.hub = hub ? new FakeHub(this.server, { random: random(rng.int(1, 1e9)).next }) : null;
    this.clients = PEOPLE.map(
      (account, i) => new Client(this, account, random(rng.int(1, 1e9) + i)),
    );
  }

  private serve<T>(call: () => Promise<T>): Promise<T> {
    const run = this.queue.then(call, call);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async delay() {
    const turns = this.faultsOn ? this.rng.int(0, this.faults.maxDelay) : 0;
    for (let i = 0; i < turns; i++) await Promise.resolve();
  }

  /** The client's API through the faults: cut off, lost both ways, duplicated, delayed. */
  faulty(client: Client, base: SyncApi): SyncApi {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(base) as (keyof SyncApi)[]) {
      const method = base[key] as (...args: unknown[]) => Promise<unknown>;
      out[key] = async (...args: unknown[]) => {
        await this.delay();
        const f = this.faultsOn ? this.faults : null;
        if (f && client.partitioned) {
          this.stats.partitioned++;
          throw new OfflineError('partitioned');
        }
        if (f && this.rng.chance(f.loseRequest)) {
          this.stats.lostRequests++;
          throw new OfflineError('request lost');
        }
        const call = () => method(...args);
        let outcome = await this.serve(call).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        if (f && this.rng.chance(f.duplicate)) {
          this.stats.duplicates++;
          const again = await this.serve(call).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          if (this.rng.chance(0.5)) outcome = again;
        }
        await this.delay();
        if (f && (client.partitioned || this.rng.chance(f.loseAnswer))) {
          this.stats.lostAnswers++;
          throw new OfflineError('answer lost');
        }
        if ('error' in outcome) throw outcome.error;
        if (key === 'pushDoc') {
          const [pageId, request] = args as Parameters<SyncApi['pushDoc']>;
          const answer = outcome.value as Awaited<ReturnType<SyncApi['pushDoc']>>;
          for (const ack of answer.acks) {
            const sent = request.updates.find((u) => u.updateId === ack.updateId);
            if (sent) client.acked.push({ pageId, updateId: ack.updateId, data: sent.data });
          }
        }
        return outcome.value;
      };
    }
    return out as unknown as SyncApi;
  }

  /**
   * Alice's workspace on the server, uploaded with a database under Alpha (a view, four rows, two
   * of them related); Bob and Carol members who hold it and its database; a pin each.
   */
  async setUp() {
    const [alice, bob, carol] = this.clients;
    alice.engine.setAccount(alice.account);
    const made = await localWorkspace(alice.store);
    this.workspaceId = made.ws.id;
    this.sectionId = made.section.id;
    const tasks = await makeDatabase(alice.store, made.ws.id, made.section.id, made.a.id, [
      'One',
      'Two',
      'Three',
      'Four',
    ]);
    this.databaseId = tasks.db.id;
    await alice.store.applyLocalOps([
      newOp('row.update', made.ws.id, tasks.rows[0].id, {
        values: { [PROP.link]: [tasks.rows[1].id], [PROP.notes]: 'first' },
      }),
    ]);
    await alice.engine.upload(made.ws.id);
    await alice.pass();
    for (const client of [bob, carol]) {
      this.server.addMember(made.ws.id, client.account.id);
      client.engine.setAccount(client.account);
      await client.pass();
      await client.engine.holdDatabase(this.databaseId);
      await client.pass();
    }
    for (const client of this.clients)
      client.clientId = (await client.engine.clientIdFor(made.ws.id))!;
    // Pins: Bob keeps Alpha's subtree, Carol Gamma (fetched in the background, a few at a time).
    await bob.engine.pin(made.a.id, true);
    await carol.engine.pin(made.c.id, false);
  }

  /** The hub's frames meet their faults while the faults are on. */
  hubFaults(on: boolean) {
    if (!this.hub) return;
    const f = this.faults;
    this.hub.faults = on
      ? {
          drop: f.dropFrame,
          duplicate: f.duplicateFrame,
          reorder: f.reorderFrame,
          maxDelay: f.frameDelay,
          loseAnswer: f.loseHubAnswer,
        }
      : NO_HUB_FAULTS;
  }

  /** One round: every client edits, changes the tree and syncs, all at once. */
  async step() {
    if (this.hub && this.rng.chance(this.faults.storm)) {
      // An app-pool recycle: every socket drops at once.
      this.hub.storm();
      this.hubStats.storms++;
    }
    await Promise.all(this.clients.map((client) => this.act(client)));
  }

  /** A client's socket follows its partition and its own cut spells; a dropped one comes back. */
  private socket(client: Client) {
    const transport = client.transport;
    if (!transport || !this.hub) return;
    const r = client.rng;
    if (client.cut ? r.chance(this.faults.cutEnd) : r.chance(this.faults.cutStart)) {
      client.cut = !client.cut;
      if (client.cut) this.hubStats.cuts++;
    }
    if (client.cut || client.partitioned) this.hub.cut(transport);
    else {
      this.hub.restore(transport);
      transport.retryNow();
    }
  }

  private async act(client: Client) {
    const r = client.rng;
    const f = this.faults;
    if (client.partitioned ? r.chance(f.partitionEnd) : r.chance(f.partitionStart))
      client.partitioned = !client.partitioned;
    this.socket(client);
    const pass = r.chance(0.6) ? client.pass() : Promise.resolve();
    const actions = r.int(0, 3);
    for (let i = 0; i < actions; i++) {
      const roll = r.next();
      if (roll < 0.45) await this.editDoc(client);
      else if (roll < 0.65) await this.treeOp(client);
      else await this.dbOp(client);
    }
    await pass;
  }

  /** Pages with a document (a database's page has none), not in the trash. */
  private async livePages(client: Client): Promise<PageRecord[]> {
    return (await client.store.readMirror(this.workspaceId)).pages.filter(
      (p) => !p.trashedAt && p.kind !== 'database',
    );
  }

  /** Rows whose documents may be edited: held, not trashed, and known to the server. */
  private async editableRows(client: Client): Promise<RowRecord[]> {
    const creating = new Set(
      (await client.store.nextOutboxBatch(10_000, this.workspaceId))
        .filter((op) => op.type === 'page.create')
        .map((op) => op.entityId),
    );
    return (await client.store.readRows(this.databaseId)).filter(
      (row) => !row.trashedAt && !creating.has(row.id),
    );
  }

  private async editDoc(client: Client) {
    const page = client.rng.chance(0.25)
      ? client.rng.pick(await this.editableRows(client))
      : client.rng.pick(await this.livePages(client));
    if (!page) return;
    const open = await client.open(page.id);
    if (!open) return;
    const edits = client.rng.int(1, 3);
    for (let i = 0; i < edits; i++) this.mutate(client.rng, open.doc);
    this.edits += edits;
    await client.flush(page.id);
  }

  /** One edit shaped like a page's: a block inserted, deleted or moved; text typed or deleted. */
  private mutate(r: Random, doc: Y.Doc) {
    const fragment = doc.getXmlFragment(CONTENT);
    const blocks = fragment.length;
    const roll = r.next();
    const word = () => r.pick(WORDS)!;
    const textOf = (index: number): Y.XmlText | null => {
      const block = fragment.get(index);
      if (!(block instanceof Y.XmlElement)) return null;
      const first = block.get(0);
      if (first instanceof Y.XmlText) return first;
      const text = new Y.XmlText();
      block.insert(0, [text]);
      return text;
    };
    doc.transact(() => {
      if (blocks === 0 || roll < 0.18) {
        const block = new Y.XmlElement(r.chance(0.2) ? 'heading' : 'paragraph');
        block.setAttribute('id', Array.from({ length: 12 }, () => r.pick([...ID_CHARS])).join(''));
        const text = new Y.XmlText();
        text.insert(0, word());
        block.insert(0, [text]);
        fragment.insert(r.int(0, blocks), [block]);
      } else if (roll < 0.28 && blocks > 1) {
        fragment.delete(r.int(0, blocks - 1), 1);
      } else if (roll < 0.4 && blocks > 1) {
        // A move is a delete and an insert in Yjs: a copy of the block (same id) elsewhere.
        const from = r.int(0, blocks - 1);
        const block = fragment.get(from);
        if (!(block instanceof Y.XmlElement)) return;
        const copy = new Y.XmlElement(block.nodeName);
        const id = block.getAttribute('id');
        if (id) copy.setAttribute('id', id);
        const text = new Y.XmlText();
        text.insert(0, textOf(from)?.toString() ?? '');
        copy.insert(0, [text]);
        fragment.delete(from, 1);
        fragment.insert(r.int(0, blocks - 1), [copy]);
      } else if (roll < 0.88) {
        const text = textOf(r.int(0, blocks - 1));
        if (text) text.insert(r.int(0, text.length), word());
      } else {
        const text = textOf(r.int(0, blocks - 1));
        if (text && text.length) {
          const at = r.int(0, text.length - 1);
          text.delete(at, Math.min(text.length - at, r.int(1, 4)));
        }
      }
    });
  }

  private async treeOp(client: Client) {
    const r = client.rng;
    const ws = this.workspaceId;
    const pages = (await client.store.readMirror(ws)).pages;
    const live = pages.filter((p) => !p.trashedAt);
    const after = (parent: Id | null, except?: Id) => {
      const siblings = live
        .filter((p) => p.parentPageId === parent && p.id !== except)
        .sort(compareSiblings);
      return keyBetween(siblings.at(-1)?.orderKey ?? null, null);
    };
    const roll = r.next();
    try {
      if (roll < 0.3 || !live.length) {
        const parent = r.chance(0.35) ? null : (r.pick(live)?.id ?? null);
        const at = new Date().toISOString();
        const page: PageRecord = {
          id: uuidv7(),
          workspaceId: ws,
          sectionId: this.sectionId,
          parentPageId: parent,
          orderKey: after(parent),
          kind: 'page',
          title: `${client.account.displayName} ${this.treeOps}`,
          icon: null,
          coverAssetId: null,
          isTemplate: false,
          templateOfPageId: null,
          version: 1,
          createdAt: at,
          updatedAt: at,
          trashedAt: null,
          trashRootId: null,
        };
        await client.store.applyLocalOps([newOp('page.create', ws, page.id, page)]);
        client.created.add(page.id);
      } else if (roll < 0.5) {
        const page = r.pick(live)!;
        await client.store.applyLocalOps([
          newOp('page.update', ws, page.id, { title: `${page.title}'` }),
        ]);
      } else if (roll < 0.75) {
        const page = r.pick(live)!;
        const parent = r.chance(0.3)
          ? null
          : (r.pick(live.filter((p) => p.id !== page.id))?.id ?? null);
        await client.store.applyLocalOps([
          newOp(
            'page.move',
            ws,
            page.id,
            { sectionId: page.sectionId, parentPageId: parent, orderKey: after(parent, page.id) },
            page.version,
          ),
        ]);
      } else if (roll < 0.87) {
        const page = r.pick(live)!;
        await client.store.applyLocalOps([newOp('page.trash', ws, page.id, {}, page.version)]);
      } else {
        const root = r.pick(pages.filter((p) => p.trashedAt && p.trashRootId === p.id));
        if (!root) return;
        await client.store.applyLocalOps([newOp('page.restore', ws, root.id, {})]);
      }
      this.treeOps++;
      client.engine.changed();
    } catch (error) {
      // The local planner refuses what the tree rules forbid (a cycle, a trashed parent).
      if (!(error instanceof OpError)) throw error;
    }
  }

  /** A fresh property or option id: 8 characters of base 62, from the client's own seed. */
  private shortId(r: Random) {
    return Array.from({ length: 8 }, () => r.pick([...ID_CHARS])).join('');
  }

  /**
   * A value to write: often one that needs coercing (a number as text, an option by name), now
   * and then nothing (a clear).
   */
  private valueFor(r: Random, def: PropertyDef): Value | null {
    if (r.chance(0.1)) return null;
    const ids = (def.options ?? []).map((o) => o.id);
    switch (def.type) {
      case 'number':
        return r.chance(0.25) ? r.pick(NAMES)! : r.int(0, 99);
      case 'checkbox':
        return r.chance(0.5);
      case 'date':
        return { start: `2026-11-${String(r.int(1, 28)).padStart(2, '0')}` };
      case 'select':
      case 'status':
        if (!ids.length || r.chance(0.2)) return r.pick(NAMES)!;
        return r.pick(ids)!;
      case 'multiSelect': {
        const picked = ids.filter(() => r.chance(0.4));
        return picked.length ? picked : r.pick(NAMES)!;
      }
      default:
        return r.chance(0.2) ? String(r.int(0, 99)) : r.pick(NAMES)!;
    }
  }

  /** A property's def as another type, its options carried to an option type. */
  private retyped(def: PropertyDef, type: PropertyType): PropertyDef {
    const out: PropertyDef = { id: def.id, name: def.name, type };
    if (type === 'number') out.number = { format: 'number', decimals: null };
    if (type === 'select' || type === 'multiSelect')
      out.options = (def.options ?? []).map(({ id, name, colour }) => ({ id, name, colour }));
    return out;
  }

  /** One change to the database, its rows or its view, as a person makes them in a view. */
  private async dbOp(client: Client) {
    const r = client.rng;
    const ws = this.workspaceId;
    const db = this.databaseId;
    const mirror = await client.store.readMirror(ws);
    const record = mirror.databases.find((d) => d.id === db);
    const page = mirror.pages.find((p) => p.id === db);
    if (!record || !page) return;
    const rows = await client.store.readRows(db);
    const live = rows.filter((row) => !row.trashedAt);
    const stored = record.properties.filter(
      (p) => STORED_TYPES.includes(p.type) && p.type !== 'relation',
    );
    const shown = stored.filter((p) => !p.trashedAt);
    const ordered = [...live].sort(compareSiblings);
    const roll = r.next();
    let op: Operation;
    if (roll < 0.14 || !live.length) {
      const values: Record<string, Value> = {};
      const def = r.pick(shown);
      const value = def && this.valueFor(r, def);
      if (def && value !== null && value !== undefined) values[def.id] = value;
      const row = rowCreate(
        ws,
        page.sectionId,
        db,
        `${client.account.displayName} row ${this.dbOps}`,
        values,
        keyBetween(ordered.at(-1)?.orderKey ?? null, null),
      );
      op = newOp('page.create', ws, row.id, row);
    } else if (roll < 0.48) {
      // Values of one or two properties: three people often write the same ones at once.
      const row = r.pick(live)!;
      const values: Record<string, Value | null> = {};
      for (let i = r.int(1, 2); i > 0; i--) {
        const def = r.pick(r.chance(0.8) ? shown : stored);
        if (def) values[def.id] = this.valueFor(r, def);
      }
      op = newOp('row.update', ws, row.id, { values });
    } else if (roll < 0.54) {
      const row = r.pick(live)!;
      op = newOp('page.update', ws, row.id, {
        title: `${row.title.split(' ~')[0]} ~${this.dbOps}`,
      });
    } else if (roll < 0.64) {
      // A relation: the row now blocks up to three rows (or none).
      const row = r.pick(live)!;
      const targets = live.filter(() => r.chance(0.3)).slice(0, 3);
      op = newOp('row.update', ws, row.id, {
        values: { [PROP.link]: targets.length ? targets.map((t) => t.id) : null },
      });
    } else if (roll < 0.7) {
      const trashed = rows.filter((row) => row.trashedAt && row.trashRootId === row.id);
      if (trashed.length && r.chance(0.5)) op = newOp('page.restore', ws, r.pick(trashed)!.id, {});
      else {
        const row = r.pick(live)!;
        op = newOp('page.trash', ws, row.id, {}, row.version);
      }
    } else if (roll < 0.74) {
      const row = r.pick(live)!;
      const at = r.int(0, ordered.length);
      const orderKey = keyBetween(
        ordered[at - 1]?.orderKey ?? null,
        ordered[at]?.orderKey === ordered[at - 1]?.orderKey
          ? null
          : (ordered[at]?.orderKey ?? null),
      );
      op = newOp(
        'page.move',
        ws,
        row.id,
        { sectionId: row.sectionId, parentPageId: db, orderKey },
        row.version,
      );
    } else if (roll < 0.81) {
      const def = r.pick(shown);
      if (!def) return;
      const type = r.pick(TYPES.filter((t) => t !== def.type))!;
      op = newOp('db.update', ws, db, { properties: [this.retyped(def, type)] });
    } else if (roll < 0.86) {
      const def = r.pick(stored);
      if (!def) return;
      op = newOp('db.update', ws, db, {
        properties: [{ ...def, trashedAt: def.trashedAt ? null : new Date().toISOString() }],
      });
    } else if (roll < 0.92) {
      const def = r.pick(shown.filter((p) => p.type === 'select' || p.type === 'multiSelect'));
      if (!def) return;
      const options = def.options ?? [];
      const next =
        options.length > 1 && r.chance(0.6)
          ? options.filter((o) => o.id !== r.pick(options)!.id)
          : [...options, { id: this.shortId(r), name: r.pick(NAMES)!, colour: 'blue' as const }];
      op = newOp('db.update', ws, db, { properties: [{ ...def, options: next }] });
    } else if (roll < 0.95 && record.properties.length < MAX_PROPERTIES) {
      const type = r.pick(TYPES)!;
      op = newOp('db.update', ws, db, {
        properties: [this.retyped({ id: this.shortId(r), name: `P${this.dbOps}`, type }, type)],
      });
    } else {
      const view = r.pick(mirror.views.filter((v) => v.databaseId === db));
      if (!view) return;
      const by = r.pick(stored);
      op = newOp('view.upsert', ws, view.id, {
        ...view,
        name: `${client.account.displayName} view ${this.dbOps}`,
        config: {
          ...view.config,
          sorts: by && r.chance(0.5) ? [{ propertyId: by.id, direction: 'asc' }] : [],
        },
      });
    }
    try {
      await client.store.applyLocalOps([op]);
      this.dbOps++;
      client.engine.changed();
    } catch (error) {
      // The local planner refuses what the rules forbid (a trashed row, a version moved on).
      if (!(error instanceof OpError)) throw error;
    }
  }

  /** The faults stop; everyone syncs until nothing waits and everyone holds the server's head. */
  async settle(): Promise<number> {
    this.faultsOn = false;
    this.hubFaults(false);
    for (const client of this.clients) {
      client.partitioned = false;
      client.cut = false;
      if (client.transport) {
        this.hub!.restore(client.transport);
        client.transport.retryNow();
      }
    }
    const engines = this.clients.map((client) => client.engine);
    for (let round = 1; round <= 30; round++) {
      for (const client of this.clients) {
        await client.flushAll();
        await client.pass();
        // What it sent through the hub, and the frames that came of it, settle too.
        await this.hub?.flush(engines);
      }
      if (round === 3)
        // Every client holds every page's and row's document, so all of them can be compared.
        for (const client of this.clients)
          for (const page of [
            ...(await client.store.readMirror(this.workspaceId)).pages,
            ...(await client.store.readRows(this.databaseId)),
          ])
            await client.engine.pullPage(page.id);
      if (round > 3 && (await this.quiet())) return round;
    }
    return -1;
  }

  private async quiet(): Promise<boolean> {
    const space = this.server.spaces.get(this.workspaceId)!;
    for (const client of this.clients) {
      if ((await client.store.nextOutboxBatch(1, this.workspaceId)).length) return false;
      if ((await client.store.unsentDocUpdates(1)).length) return false;
      if ((await client.store.syncCursor(this.workspaceId)) !== space.seq) return false;
      const hold = await client.store.dbHold(this.databaseId);
      if (space.mirror.databases.has(this.databaseId) && !(hold?.mode === 'full' && hold.complete))
        return false;
      const heads = await client.store.docCursors(this.workspaceId);
      for (const [pageId, doc] of this.server.docs)
        if (
          (space.mirror.pages.has(pageId) || space.mirror.rowRecords.has(pageId)) &&
          heads[pageId]?.headSeq !== (doc.rows.at(-1)?.seq ?? 0)
        )
          return false;
    }
    return true;
  }

  /** Every disagreement between the clients and the server, and what converged. */
  async check(): Promise<{
    problems: string[];
    digest: string;
    pages: number;
    updates: number;
    rows: number;
  }> {
    const problems: string[] = [];
    const ws = this.workspaceId;
    const space = this.server.spaces.get(ws)!;
    const serverTree = shape((await this.server.api(this.clients[0].account).tree(ws, null)).pages);
    const json = (parts: Uint8Array[]) => {
      const doc = new Y.Doc();
      doc.transact(() => {
        for (const part of parts) Y.applyUpdate(doc, part, LOAD);
      }, LOAD);
      retryPending(doc);
      const out = doc.getXmlFragment(CONTENT).toJSON();
      doc.destroy();
      return out;
    };
    const serverDocs = new Map<Id, { json: string; hash: string; parts: Uint8Array[] }>();
    for (const pageId of [...space.mirror.pages.keys(), ...space.mirror.rowRecords.keys()]) {
      const parts = this.server.docParts(pageId);
      serverDocs.set(pageId, { json: json(parts), hash: await docCodec.stateHash(parts), parts });
    }
    const db = this.databaseId;
    const serverRows = rowShape(space.mirror.rowsOf(db));
    const serverDatabase = JSON.stringify(space.mirror.databases.get(db) ?? null);
    const views = (list: { id: Id }[]) =>
      JSON.stringify([...list].sort((a, b) => (a.id < b.id ? -1 : 1)));
    const serverViews = views(space.mirror.viewsOf(db));
    for (const client of this.clients) {
      const name = client.account.displayName;
      const mirror = await client.store.readMirror(ws);
      const tree = shape(mirror.pages);
      for (const id of new Set([...Object.keys(tree), ...Object.keys(serverTree)]))
        if (JSON.stringify(tree[id]) !== JSON.stringify(serverTree[id]))
          problems.push(
            `${name}'s ${id} differs: ${JSON.stringify(tree[id])} here, ${JSON.stringify(serverTree[id])} there`,
          );
      // The database: its record, its views and every row, values and versions included.
      const database = JSON.stringify(mirror.databases.find((d) => d.id === db) ?? null);
      if (database !== serverDatabase)
        problems.push(`${name}'s database differs: ${database} here, ${serverDatabase} there`);
      const mine = views(mirror.views.filter((v) => v.databaseId === db));
      if (mine !== serverViews)
        problems.push(`${name}'s views differ: ${mine} here, ${serverViews} there`);
      const rows = rowShape(await client.store.readRows(db));
      for (const id of new Set([...Object.keys(rows), ...Object.keys(serverRows)]))
        if (JSON.stringify(rows[id]) !== JSON.stringify(serverRows[id]))
          problems.push(
            `${name}'s row ${id} differs: ${JSON.stringify(rows[id])} here, ${JSON.stringify(serverRows[id])} there`,
          );
      const hold = await client.store.dbHold(db);
      if (!hold || hold.mode !== 'full' || !hold.complete)
        problems.push(`${name} does not hold the database in full: ${JSON.stringify(hold)}`);
      for (const [pageId, server] of serverDocs) {
        const stored = await client.store.loadDoc(pageId);
        const parts = [
          ...(stored.snapshot ? [stored.snapshot] : []),
          ...stored.updates.map((u) => u.data),
        ];
        if (json(parts) !== server.json) problems.push(`${name}'s stored ${pageId} differs`);
        if ((await docCodec.stateHash(parts)) !== server.hash)
          problems.push(`${name}'s state hash of ${pageId} differs`);
        const open = client.docs.get(pageId);
        if (open?.ready && open.doc.getXmlFragment(CONTENT).toJSON() !== server.json)
          problems.push(`${name}'s open ${pageId} differs`);
      }
      for (const ack of client.acked) {
        const server = serverDocs.get(ack.pageId);
        const rows = this.server.docs.get(ack.pageId)?.rows ?? [];
        if (!server || !rows.some((r) => r.updateId === ack.updateId)) {
          problems.push(`${name}'s acknowledged ${ack.updateId} is not on the server`);
          continue;
        }
        if ((await docCodec.stateHash([...server.parts, ack.data])) !== server.hash)
          problems.push(`${name}'s acknowledged ${ack.updateId} is not in the server's state`);
      }
      for (const entry of await client.store.quarantine(null))
        problems.push(`${name} set ${entry.pageId} aside (${entry.reason})`);
      if (client.store.corruptUpdates().length) problems.push(`${name} kept an update aside`);
    }
    // What converged, without ids: titles in tree order with depth and trash, and the documents.
    const byId = new Map([...space.mirror.pages.values()].map((p) => [p.id, p]));
    const depth = (p: PageRecord) => {
      let d = 0;
      for (let q = p; q.parentPageId && d < 1000; q = byId.get(q.parentPageId)!) d++;
      return d;
    };
    const digest = JSON.stringify({
      pages: [...byId.values()]
        .map((p) => `${depth(p)}:${p.title}:${p.trashedAt ? 't' : ''}`)
        .sort(),
      docs: [...serverDocs.values()].map((d) => d.json).sort(),
      // Related rows by their titles: ids differ from run to run.
      rows: Object.values(serverRows)
        .map((r) => {
          const values = Object.fromEntries(
            Object.entries(r.values).map(([k, v]) => [
              k,
              k === PROP.link || k === PROP.back
                ? (v as Id[]).map((id) => serverRows[id]?.title ?? '?')
                : v,
            ]),
          );
          return `${r.title}:${r.trashed ? 't' : ''}:${JSON.stringify(values)}`;
        })
        .sort(),
      properties: space.mirror.databases.get(db)?.properties.map((p) => `${p.name}:${p.type}`),
    });
    let updates = 0;
    for (const doc of this.server.docs.values()) updates += doc.rows.length;
    return {
      problems,
      digest,
      pages: byId.size,
      updates,
      rows: Object.keys(serverRows).length,
    };
  }
}

/** One seeded run: set up, `steps` rounds under faults, settle, check. */
export async function simulate(options: SimOptions): Promise<SimReport> {
  const sim = new Simulation(random(options.seed), options.faults ?? DEFAULT_FAULTS, !!options.hub);
  await sim.setUp();
  sim.faultsOn = true;
  sim.hubFaults(true);
  for (let i = 0; i < options.steps; i++) await sim.step();
  const settleRounds = await sim.settle();
  const result = await sim.check();
  if (settleRounds < 0) result.problems.push('the clients did not settle in 30 rounds');
  return {
    seed: options.seed,
    steps: options.steps,
    pages: result.pages,
    updates: result.updates,
    ops: [...sim.server.spaces.values()].reduce((n, s) => n + s.applied.size, 0),
    acked: sim.clients.reduce((n, c) => n + c.acked.length, 0),
    edits: sim.edits,
    treeOps: sim.treeOps,
    dbOps: sim.dbOps,
    rows: result.rows,
    faults: { ...sim.stats },
    hub: sim.hub
      ? {
          frames: sim.hub.stats.frames,
          dropped: sim.hub.stats.dropped,
          duplicated: sim.hub.stats.duplicated,
          reordered: sim.hub.stats.reordered,
          lostAnswers: sim.hub.stats.lostAnswers,
          connects: sim.hub.stats.connects,
          cuts: sim.hubStats.cuts,
          storms: sim.hubStats.storms,
          pushes: sim.hubPushes,
        }
      : null,
    settleRounds,
    digest: result.digest,
    problems: result.problems,
  };
}
