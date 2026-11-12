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
// Seeded and deterministic: every choice comes from the seed, and every delay is a number of
// microtask turns, so the same seed interleaves the same way (the caller makes ids deterministic
// by seeding `crypto.getRandomValues` and `Date.now`).
import * as Y from 'yjs';
import {
  MemoryStore,
  OfflineError,
  OpError,
  SyncEngine,
  SyncHttpError,
  compareSiblings,
  keyBetween,
  newOp,
  uuidv7,
  type Account,
  type Id,
  type PageRecord,
  type SyncApi,
} from '@cgw/workspace';
import { FakeServer } from '../../../workspace/src/testing/fakeServer';
import { localWorkspace, shape } from '../../../workspace/src/testing/syncHarness';
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
}

export const DEFAULT_FAULTS: Faults = {
  loseRequest: 0.04,
  loseAnswer: 0.04,
  duplicate: 0.05,
  partitionStart: 0.08,
  partitionEnd: 0.3,
  maxDelay: 12,
};

export interface SimOptions {
  seed: number;
  /** Rounds in which every client acts (edits, tree operations, a pass) at once. */
  steps: number;
  faults?: Faults;
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
  faults: {
    lostRequests: number;
    lostAnswers: number;
    duplicates: number;
    partitioned: number;
  };
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
const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

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
  clientId = 0;

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
    return open;
  }

  /** What the document layer's autosave does: the edits since the last save, as one update. */
  async flush(pageId: Id) {
    const open = this.docs.get(pageId);
    if (!open?.pending.length) return;
    const data = Y.mergeUpdates(open.pending.splice(0));
    await this.store.appendDocUpdates(pageId, [{ updateId: uuidv7(), data }]);
    this.engine.changed();
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
  readonly clients: Client[];
  workspaceId: Id = '';
  sectionId: Id = '';
  faultsOn = false;
  readonly stats = { lostRequests: 0, lostAnswers: 0, duplicates: 0, partitioned: 0 };
  edits = 0;
  treeOps = 0;
  /** The server takes one request at a time, as its transactions would. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly rng: Random,
    readonly faults: Faults,
  ) {
    this.server = new FakeServer({ codec: docCodec, random: rng.next });
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

  /** Alice's workspace on the server; Bob and Carol members who hold it; a pin each. */
  async setUp() {
    const [alice, bob, carol] = this.clients;
    alice.engine.setAccount(alice.account);
    const made = await localWorkspace(alice.store);
    this.workspaceId = made.ws.id;
    this.sectionId = made.section.id;
    await alice.engine.upload(made.ws.id);
    await alice.pass();
    for (const client of [bob, carol]) {
      this.server.addMember(made.ws.id, client.account.id);
      client.engine.setAccount(client.account);
      await client.pass();
    }
    for (const client of this.clients)
      client.clientId = (await client.engine.clientIdFor(made.ws.id))!;
    // Pins: Bob keeps Alpha's subtree, Carol Gamma (fetched in the background, a few at a time).
    await bob.engine.pin(made.a.id, true);
    await carol.engine.pin(made.c.id, false);
  }

  /** One round: every client edits, changes the tree and syncs, all at once. */
  async step() {
    await Promise.all(this.clients.map((client) => this.act(client)));
  }

  private async act(client: Client) {
    const r = client.rng;
    const f = this.faults;
    if (client.partitioned ? r.chance(f.partitionEnd) : r.chance(f.partitionStart))
      client.partitioned = !client.partitioned;
    const pass = r.chance(0.6) ? client.pass() : Promise.resolve();
    const actions = r.int(0, 3);
    for (let i = 0; i < actions; i++) {
      if (r.chance(0.7)) await this.editDoc(client);
      else await this.treeOp(client);
    }
    await pass;
  }

  private async livePages(client: Client): Promise<PageRecord[]> {
    return (await client.store.readMirror(this.workspaceId)).pages.filter((p) => !p.trashedAt);
  }

  private async editDoc(client: Client) {
    const page = client.rng.pick(await this.livePages(client));
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

  /** The faults stop; everyone syncs until nothing waits and everyone holds the server's head. */
  async settle(): Promise<number> {
    this.faultsOn = false;
    for (const client of this.clients) client.partitioned = false;
    for (let round = 1; round <= 30; round++) {
      for (const client of this.clients) {
        await client.flushAll();
        await client.pass();
      }
      if (round === 3)
        // Every client holds every page's document, so all of them can be compared.
        for (const client of this.clients)
          for (const page of (await client.store.readMirror(this.workspaceId)).pages)
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
      const heads = await client.store.docCursors(this.workspaceId);
      for (const [pageId, doc] of this.server.docs)
        if (
          space.mirror.pages.has(pageId) &&
          heads[pageId]?.headSeq !== (doc.rows.at(-1)?.seq ?? 0)
        )
          return false;
    }
    return true;
  }

  /** Every disagreement between the clients and the server, and what converged. */
  async check(): Promise<{ problems: string[]; digest: string; pages: number; updates: number }> {
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
    for (const pageId of space.mirror.pages.keys()) {
      const parts = this.server.docParts(pageId);
      serverDocs.set(pageId, { json: json(parts), hash: await docCodec.stateHash(parts), parts });
    }
    for (const client of this.clients) {
      const name = client.account.displayName;
      const tree = shape((await client.store.readMirror(ws)).pages);
      for (const id of new Set([...Object.keys(tree), ...Object.keys(serverTree)]))
        if (JSON.stringify(tree[id]) !== JSON.stringify(serverTree[id]))
          problems.push(
            `${name}'s ${id} differs: ${JSON.stringify(tree[id])} here, ${JSON.stringify(serverTree[id])} there`,
          );
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
    });
    let updates = 0;
    for (const doc of this.server.docs.values()) updates += doc.rows.length;
    return { problems, digest, pages: byId.size, updates };
  }
}

/** One seeded run: set up, `steps` rounds under faults, settle, check. */
export async function simulate(options: SimOptions): Promise<SimReport> {
  const sim = new Simulation(random(options.seed), options.faults ?? DEFAULT_FAULTS);
  await sim.setUp();
  sim.faultsOn = true;
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
    faults: { ...sim.stats },
    settleRounds,
    digest: result.digest,
    problems: result.problems,
  };
}
