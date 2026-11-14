// An in-memory hub over the fake server (testing/fakeServer.ts), as `realtime.1` has the real one
// (Phase 6 contracts, section 1): `JoinWorkspaces`, `JoinPage`, `LeavePage`, `PushUpdates` (the
// fake server's own push, so the same checks and the same sequence) and `Awareness`; and the
// relay, which sends only what the fake server serves to pulls (never an update its worker
// refused), one frame per joined page per tick, from what it last relayed to the head, to every
// connection that joined the page. An epoch change is a frame with `complete: false`; a followed
// workspace whose feed moved gets `ChangesAvailable`; a connection whose person lost a page or the
// workspace gets `AccessRevoked` and leaves it. Presence is relayed, never stored. Everything
// crosses as JSON (bytes as base64), as on the wire.
//
// The relay ticks on its own a microtask after anything the server holds changes (`auto`), or
// when a test says (`relay`, `flush`). Its devices' transports are the real `HubTransport`, with
// its reconnect loop, over this hub's sockets.
//
// Faults (seeded): frames dropped, duplicated, held back and sent after the next tick's
// (reordered), or delayed by a number of microtask turns; a call carried out and its answer lost
// with the socket; sockets cut and refused until restored, one device's or everyone's (`cut`,
// `restore`); a blip (`drop`); a reconnect storm (`storm`: every socket dropped at once, so every
// device's own loop brings it back).
import { uuidv7, type Id } from '../ids';
import { OfflineError, SyncHttpError, type Account } from '../sync/api';
import { fromBase64 } from '../sync/http';
import {
  HUB,
  HubTransport,
  REALTIME_LIMITS,
  wireFrame,
  type Answer,
  type HubSocket,
  type HubTransportOptions,
  type PresenceMessage,
  type PresenceState,
  type RelayFrame,
} from '../sync/realtime';
import type { FakeServer } from './fakeServer';

export interface HubFaults {
  /** Chance a frame is never sent. */
  drop: number;
  /** Chance a frame is sent twice. */
  duplicate: number;
  /** Chance a frame is held back and sent after the next tick's frames. */
  reorder: number;
  /** Most microtask turns a frame takes to arrive (frames overtake one another). */
  maxDelay: number;
  /** Chance a call is carried out and its answer lost, with the socket. */
  loseAnswer: number;
}

export const NO_HUB_FAULTS: HubFaults = {
  drop: 0,
  duplicate: 0,
  reorder: 0,
  maxDelay: 0,
  loseAnswer: 0,
};

export interface FakeHubOptions {
  /** For the faults (a seeded one makes a run replay). */
  random?: () => number;
  faults?: Partial<HubFaults>;
  /** The relay ticks a microtask after every change (default); false: only when told. */
  auto?: boolean;
}

type Owner = object;

/** One socket's connection, as the hub holds it. */
class Connection {
  readonly workspaces = new Set<Id>();
  /** Joined pages: this connection's presence id and last state on each. */
  readonly pages = new Map<Id, { presenceId: string; state: PresenceState | null }>();
  readonly handlers = new Map<string, (payload: unknown) => void>();
  private readonly closers: ((error?: unknown) => void)[] = [];
  /** Frames held back (reordered), with the tick they were held in. */
  held: { event: string; payload: unknown; tick: number }[] = [];
  closed = false;

  constructor(
    readonly hub: FakeHub,
    readonly account: Account,
    readonly owner: Owner,
  ) {}

  readonly socket: HubSocket = {
    invoke: (method, ...args) => this.hub.invoke(this, method, args),
    on: (event, handler) => void this.handlers.set(event, handler),
    onClose: (handler) => void this.closers.push(handler),
    close: async () => this.close(),
  };

  close() {
    if (this.closed) return;
    this.closed = true;
    this.held = [];
    this.hub.closed(this);
    const closers = this.closers.splice(0);
    queueMicrotask(() => {
      for (const close of closers) close();
    });
  }
}

const json = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

export class FakeHub {
  private readonly connections = new Set<Connection>();
  /** What this hub last relayed of each joined page. */
  private readonly relayed = new Map<Id, { epoch: number; head: number }>();
  /** Each followed workspace's feed head as last told. */
  private readonly feedSeen = new Map<Id, number>();
  /** Pages whose next frame says `complete: false` (rows a compaction removed). */
  private readonly incompleteNext = new Set<Id>();
  private readonly blocked = new Set<Owner>();
  private down = false;
  private relayPending = false;
  private inflight = 0;
  private tick = 0;
  private readonly random: () => number;
  private readonly off: () => void;
  faults: HubFaults;
  auto: boolean;
  /** Hub methods called, in order. */
  calls: string[] = [];
  readonly stats = {
    attempts: 0,
    connects: 0,
    frames: 0,
    dropped: 0,
    duplicated: 0,
    reordered: 0,
    lostAnswers: 0,
    revoked: 0,
  };

  constructor(
    readonly server: FakeServer,
    options: FakeHubOptions = {},
  ) {
    this.random = options.random ?? Math.random;
    this.faults = { ...NO_HUB_FAULTS, ...options.faults };
    this.auto = options.auto ?? true;
    this.off = server.onChange(() => this.changed());
  }

  /** Stops listening to the server. */
  dispose() {
    this.off();
    for (const connection of [...this.connections]) connection.close();
  }

  /** A device's transport over this hub (not started). */
  transport(account: Account, options: Omit<HubTransportOptions, 'open'> = {}): HubTransport {
    const transport: HubTransport = new HubTransport({
      ...options,
      open: () => this.open(account, transport),
    });
    return transport;
  }

  /** Open connections, all or one device's. */
  sockets(owner?: Owner): number {
    return [...this.connections].filter((c) => !owner || c.owner === owner).length;
  }

  /** Who has each page open now (distinct people). */
  presence(pageId: Id): Id[] {
    return [
      ...new Set([...this.connections].filter((c) => c.pages.has(pageId)).map((c) => c.account.id)),
    ];
  }

  // Faults -----------------------------------------------------------------------------------------

  /** Sockets are cut (one device's, or everyone's) and refused until `restore`. */
  cut(owner?: Owner) {
    if (owner) this.blocked.add(owner);
    else this.down = true;
    for (const c of [...this.connections]) if (!owner || c.owner === owner) c.close();
  }

  restore(owner?: Owner) {
    if (owner) this.blocked.delete(owner);
    else {
      this.down = false;
      this.blocked.clear();
    }
  }

  /** A blip: the sockets close (one device's, or everyone's) and may open again at once. */
  drop(owner?: Owner) {
    for (const c of [...this.connections]) if (!owner || c.owner === owner) c.close();
  }

  /** Every socket drops at once (an app-pool recycle): each device's loop brings it back. */
  storm() {
    this.drop();
  }

  /** The page's next frame says its rows could not all be read (the client pulls). */
  incomplete(pageId: Id) {
    this.incompleteNext.add(pageId);
  }

  private chance(p: number) {
    return p > 0 && this.random() < p;
  }

  // Sockets ----------------------------------------------------------------------------------------

  private async open(account: Account, owner: Owner): Promise<HubSocket> {
    await Promise.resolve();
    this.stats.attempts++;
    if (this.down || this.blocked.has(owner)) throw new OfflineError('The hub cannot be reached');
    // A ticket is had only with a session (`POST /realtime/tickets`).
    if (this.server.isExpired(account.id)) throw new SyncHttpError(401, 'auth.required');
    const connection = new Connection(this, account, owner);
    this.connections.add(connection);
    this.stats.connects++;
    return connection.socket;
  }

  /** A connection closed: the others on its pages are told it left. */
  closed(connection: Connection) {
    this.connections.delete(connection);
    for (const pageId of [...connection.pages.keys()]) this.leave(connection, pageId);
  }

  async invoke(connection: Connection, method: string, args: unknown[]): Promise<unknown> {
    await Promise.resolve();
    if (connection.closed) throw new Error('The connection is closed');
    this.calls.push(method);
    let answer: Answer<unknown>;
    try {
      answer = { ok: true, value: json(this.run(connection, method, json(args))) };
    } catch (error) {
      if (!(error instanceof SyncHttpError)) throw error;
      answer = {
        ok: false,
        status: error.status,
        code: error.code,
        title: error.message,
        ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
      };
    }
    if (method !== HUB.awareness && this.chance(this.faults.loseAnswer)) {
      this.stats.lostAnswers++;
      connection.close();
      throw new Error('The connection was lost');
    }
    await Promise.resolve();
    if (connection.closed) throw new Error('The connection was lost');
    return answer;
  }

  private run(c: Connection, method: string, args: unknown[]): unknown {
    switch (method) {
      case HUB.joinWorkspaces:
        return this.joinWorkspaces(c, args[0]);
      case HUB.joinPage:
        return this.joinPage(c, String(args[0]));
      case HUB.leavePage:
        this.leave(c, String(args[0]));
        return {};
      case HUB.pushUpdates:
        return this.push(c, String(args[0]), args[1]);
      case HUB.awareness:
        return this.awareness(c, String(args[0]), args[1]);
      default:
        throw new SyncHttpError(400, 'request.invalid', `No hub method ${method}`);
    }
  }

  private joinWorkspaces(c: Connection, ids: unknown) {
    if (
      !Array.isArray(ids) ||
      ids.length > REALTIME_LIMITS.workspaces ||
      !ids.every((id) => typeof id === 'string')
    )
      throw new SyncHttpError(400, 'request.invalid');
    const members = (ids as Id[]).filter((id) => this.server.isMember(c.account, id));
    c.workspaces.clear();
    for (const id of members) {
      c.workspaces.add(id);
      if (!this.feedSeen.has(id)) this.feedSeen.set(id, this.server.feedHead(id));
    }
    return members.map((workspaceId) => ({
      workspaceId,
      seq: this.server.feedHead(workspaceId),
      presence: this.pagesOpen(workspaceId, c.account),
    }));
  }

  private joinPage(c: Connection, pageId: Id) {
    if (!c.pages.has(pageId) && c.pages.size >= REALTIME_LIMITS.pages)
      throw new SyncHttpError(400, 'limit.pages');
    const joined = this.server.hubJoinPage(c.account, pageId);
    if (!c.pages.has(pageId)) c.pages.set(pageId, { presenceId: uuidv7(), state: null });
    if (!this.relayed.has(pageId)) this.relayed.set(pageId, this.server.docHead(pageId)!);
    const presence: PresenceMessage[] = [];
    for (const other of this.connections)
      if (other !== c) {
        const at = other.pages.get(pageId);
        if (at?.state)
          presence.push({
            pageId,
            presenceId: at.presenceId,
            userId: other.account.id,
            state: at.state,
          });
      }
    this.presenceMoved(joined.workspaceId, pageId);
    return { ...joined, presence };
  }

  private leave(c: Connection, pageId: Id) {
    const at = c.pages.get(pageId);
    if (!at) return;
    c.pages.delete(pageId);
    this.toOthers(c, pageId, {
      pageId,
      presenceId: at.presenceId,
      userId: c.account.id,
      state: null,
    });
    const workspaceId = this.server.workspaceOf(pageId);
    if (workspaceId) this.presenceMoved(workspaceId, pageId);
  }

  private push(c: Connection, pageId: Id, body: unknown) {
    const request = body as {
      epoch?: unknown;
      clientSchemaVersion?: unknown;
      updates?: { updateId?: unknown; data?: unknown }[];
    };
    if (
      !request ||
      typeof request.epoch !== 'number' ||
      typeof request.clientSchemaVersion !== 'number' ||
      !Array.isArray(request.updates)
    )
      throw new SyncHttpError(400, 'request.invalid');
    const updates = request.updates.map((u) => {
      if (typeof u?.updateId !== 'string' || typeof u.data !== 'string')
        throw new SyncHttpError(400, 'request.invalid');
      return { updateId: u.updateId, data: fromBase64(u.data) };
    });
    // The hub takes at most 1 MB of decoded bytes a call; the client sends more over HTTP.
    if (updates.reduce((n, u) => n + u.data.byteLength, 0) > REALTIME_LIMITS.pushBytes)
      throw new SyncHttpError(413, 'limit.size');
    return this.server.hubPush(c.account, pageId, {
      epoch: request.epoch,
      clientSchemaVersion: request.clientSchemaVersion,
      updates,
    });
  }

  private awareness(c: Connection, pageId: Id, state: unknown) {
    const at = c.pages.get(pageId);
    if (!at) throw new SyncHttpError(403, 'access.denied');
    if (JSON.stringify(state ?? null).length > REALTIME_LIMITS.presenceBytes)
      throw new SyncHttpError(413, 'limit.size');
    at.state = (state ?? null) as PresenceState | null;
    this.toOthers(c, pageId, { pageId, presenceId: at.presenceId, userId: c.account.id, state });
    return {};
  }

  /** A presence message to the page's other connections. */
  private toOthers(c: Connection, pageId: Id, message: PresenceMessage | Record<string, unknown>) {
    for (const other of this.connections)
      if (other !== c && other.pages.has(pageId)) this.deliver(other, HUB.awareness, message);
  }

  /** Pages of a workspace someone has open, with who, among those the account may read. */
  private pagesOpen(workspaceId: Id, account: Account) {
    const out = new Map<Id, Set<Id>>();
    for (const c of this.connections)
      for (const pageId of c.pages.keys())
        if (this.server.workspaceOf(pageId) === workspaceId && this.server.canRead(account, pageId))
          (out.get(pageId) ?? out.set(pageId, new Set()).get(pageId)!).add(c.account.id);
    return [...out].map(([pageId, users]) => ({ pageId, userIds: [...users] }));
  }

  /** Who has the page open changed: its workspace's followers who may read it are told. */
  private presenceMoved(workspaceId: Id, pageId: Id) {
    const userIds = this.presence(pageId);
    for (const c of this.connections)
      if (c.workspaces.has(workspaceId) && this.server.canRead(c.account, pageId))
        this.deliver(c, HUB.pagePresence, { workspaceId, pageId, userIds });
  }

  // The relay ------------------------------------------------------------------------------------

  private changed() {
    if (this.relayPending) return;
    this.relayPending = true;
    if (this.auto) queueMicrotask(() => this.relay());
  }

  /**
   * One tick of the relay: access checked for every connection (what is lost is left, and told);
   * a frame for each joined page whose head or epoch moved since the last tick; ChangesAvailable
   * for each followed workspace whose feed moved; frames held back earlier sent after this tick's.
   */
  relay() {
    this.relayPending = false;
    const tick = ++this.tick;
    for (const c of [...this.connections]) this.checkAccess(c);
    const open = [...this.connections];
    const pages = new Map<Id, Connection[]>();
    for (const c of open)
      for (const pageId of c.pages.keys())
        (pages.get(pageId) ?? pages.set(pageId, []).get(pageId)!).push(c);
    for (const pageId of [...this.relayed.keys()])
      if (!pages.has(pageId)) this.relayed.delete(pageId);
    for (const [pageId, joined] of pages) {
      const now = this.server.docHead(pageId);
      if (!now) continue;
      const last = this.relayed.get(pageId) ?? now;
      this.relayed.set(pageId, now);
      let frame: RelayFrame | null = null;
      if (now.epoch !== last.epoch)
        frame = {
          pageId,
          epoch: now.epoch,
          after: 0,
          cursor: now.head,
          headSeq: now.head,
          updates: [],
          rejected: [],
          complete: false,
        };
      else if (now.head > last.head)
        frame = {
          pageId,
          epoch: now.epoch,
          after: last.head,
          cursor: now.head,
          headSeq: now.head,
          ...this.server.docRange(pageId, last.head, now.head),
          complete: !this.incompleteNext.delete(pageId),
        };
      if (!frame) continue;
      this.stats.frames++;
      const wire = wireFrame(frame);
      for (const c of joined) this.deliver(c, HUB.updates, wire, tick);
    }
    const followed = new Set(open.flatMap((c) => [...c.workspaces]));
    for (const workspaceId of followed) {
      const head = this.server.feedHead(workspaceId);
      if (head <= (this.feedSeen.get(workspaceId) ?? head)) {
        this.feedSeen.set(workspaceId, head);
        continue;
      }
      this.feedSeen.set(workspaceId, head);
      for (const c of open)
        if (c.workspaces.has(workspaceId))
          this.deliver(c, HUB.changesAvailable, { workspaceId, seq: head });
    }
    for (const c of open) this.release(c, tick);
  }

  /** What a connection's person may no longer reach is left, and the connection told. */
  private checkAccess(c: Connection) {
    if (this.server.isExpired(c.account.id)) {
      for (const workspaceId of c.workspaces)
        this.revoke(c, { workspaceId, pageId: null, reason: 'session.ended' });
      c.close();
      return;
    }
    for (const workspaceId of [...c.workspaces])
      if (!this.server.isMember(c.account, workspaceId)) {
        for (const pageId of [...c.pages.keys()])
          if (this.server.workspaceOf(pageId) === workspaceId) this.leave(c, pageId);
        c.workspaces.delete(workspaceId);
        this.revoke(c, { workspaceId, pageId: null, reason: 'member.removed' });
      }
    for (const pageId of [...c.pages.keys()])
      if (!this.server.canRead(c.account, pageId)) {
        this.leave(c, pageId);
        this.revoke(c, {
          workspaceId: this.server.workspaceOf(pageId) ?? '',
          pageId,
          reason: 'access.denied',
        });
      }
  }

  private revoke(c: Connection, message: { workspaceId: Id; pageId: Id | null; reason: string }) {
    this.stats.revoked++;
    this.deliver(c, HUB.accessRevoked, message);
  }

  /** Sends an event, through the faults when it is a frame (`tick` given). */
  private deliver(c: Connection, event: string, payload: unknown, tick?: number) {
    if (c.closed) return;
    let copies = 1;
    let turns = 0;
    if (tick !== undefined) {
      const f = this.faults;
      if (this.chance(f.drop)) {
        this.stats.dropped++;
        return;
      }
      if (this.chance(f.reorder)) {
        this.stats.reordered++;
        c.held.push({ event, payload, tick });
        return;
      }
      if (this.chance(f.duplicate)) {
        this.stats.duplicated++;
        copies = 2;
      }
      turns = f.maxDelay > 0 ? Math.floor(this.random() * (f.maxDelay + 1)) : 0;
    }
    for (let i = 0; i < copies; i++) this.send(c, event, payload, turns + i);
  }

  /** Frames held back before this tick go now, after this tick's. */
  private release(c: Connection, tick = Infinity) {
    const due = c.held.filter((h) => h.tick < tick);
    c.held = c.held.filter((h) => h.tick >= tick);
    for (const h of due) this.send(c, h.event, h.payload, 0);
  }

  private send(c: Connection, event: string, payload: unknown, turns: number) {
    const wire = json(payload);
    this.inflight++;
    void (async () => {
      try {
        for (let i = 0; i <= turns; i++) await Promise.resolve();
        if (!c.closed) c.handlers.get(event)?.(wire);
      } finally {
        this.inflight--;
      }
    })();
  }

  /**
   * Relays and delivers until nothing is left to send (held frames too), letting the engines
   * given take what came after each round.
   */
  async flush(engines: { idle(): Promise<void> }[] = []) {
    for (let round = 0; round < 200; round++) {
      this.relay();
      for (const c of this.connections) this.release(c);
      while (this.inflight) await Promise.resolve();
      for (const engine of engines) await engine.idle();
      await new Promise((resolve) => setImmediate(resolve));
      for (const engine of engines) await engine.idle();
      const held = [...this.connections].some((c) => c.held.length);
      if (!this.relayPending && !this.inflight && !held) return;
    }
    throw new Error('The hub did not settle');
  }
}
