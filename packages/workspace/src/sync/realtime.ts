// The real-time channel (Phase 6, `realtime.1`; SYNC_DESIGN.md, Real-time collaboration): what the
// sync engine uses beside HTTP while a hub connection is open, the frames and presence messages it
// carries, and `HubTransport`, the half of a transport that does not depend on SignalR: typed
// events, every method's `Answer<T>` turned into SyncHttpError (so a refusal over the hub is the
// same refusal as over HTTP), bytes as base64 in and out, and the reconnect loop (1 s doubling to
// 30 s, with jitter; at once when the shell says the network or the window came back). The shell
// gives it sockets (SignalR over WebSockets, a single-use ticket each:
// packages/shell/src/cloud/realtime.ts); the tests give it the in-memory hub's
// (testing/fakeHub.ts). No SignalR here.
import type { Id } from '../ids';
import { OfflineError, SyncHttpError, type DocPushRequest } from './api';
import { fromBase64, toBase64 } from './http';

export type RealtimeState = 'connecting' | 'connected' | 'disconnected';

/** What a client says about itself on a page. Validated exactly by the server: these keys only. */
export interface PresenceState {
  /** The Yjs client id this session writes as (uint32), so a cursor can be told from the others. */
  clientId: number;
  /** The selection as two Yjs relative positions (base64), or null when the editor is not focused. */
  cursor: { anchor: string; head: string } | null;
}

export interface PresenceMessage {
  pageId: Id;
  /** Random per connection and page; never the SignalR connection id. */
  presenceId: string;
  /** Stamped by the server from the connection's ticket: a client never names itself. */
  userId: Id;
  /** Null when that connection left the page, went away or lost access. */
  state: PresenceState | null;
}

/** Who has a page open, for a workspace's followers (others only is the receiver's filter). */
export interface PagePresence {
  workspaceId: Id;
  pageId: Id;
  userIds: Id[];
}

/** A followed workspace's change feed moved on. */
export interface ChangesAvailable {
  workspaceId: Id;
  seq: number;
}

/** This connection lost a page (or, with `pageId` null, the whole workspace). */
export interface AccessRevoked {
  workspaceId: Id;
  pageId: Id | null;
  /** `access.denied`, `member.removed` or `session.ended` (the server then closes the connection). */
  reason: string;
}

export interface JoinedWorkspace {
  workspaceId: Id;
  /** The feed's head. */
  seq: number;
  /** Who has which page open, among pages the caller can read. */
  presence: { pageId: Id; userIds: Id[] }[];
}

export type PageLevel = 'full' | 'edit' | 'comment' | 'view';

export interface JoinedPage {
  workspaceId: Id;
  epoch: number;
  /** The page's validated head when it was joined. */
  headSeq: number;
  schemaVersion: number;
  level: PageLevel;
  /** The others' presence on the page now. */
  presence: PresenceMessage[];
}

/** A relay as it travels (JSON, bytes as base64): like a pull's answer, for (after, cursor]. */
export interface RealtimeFrame {
  pageId: Id;
  epoch: number;
  /** The head this frame continues from: a client whose own cursor is below it lacks something. */
  after: number;
  /** The head this frame brings the page to (the next `after`). */
  cursor: number;
  headSeq: number;
  /** Valid updates in (after, cursor], in sequence order (refused ones are never served). */
  updates: { seq: number; updateId: Id; data: string }[];
  /** Update ids in (after, cursor] the worker refused (every pusher's; each client matches its own). */
  rejected: Id[];
  /** False when the rows could not all be read (a compaction removed them): pull over HTTP. */
  complete: boolean;
}

/** A relay as the engine takes it: the frame with its updates' bytes decoded. */
export interface RelayFrame extends Omit<RealtimeFrame, 'updates'> {
  updates: { seq: number; updateId: Id; data: Uint8Array }[];
}

export interface DocPushAnswer {
  acks: { updateId: Id; seq: number }[];
  headSeq: number;
}

/** What every hub method answers. */
export type Answer<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; title: string; retryAfterMs?: number };

/** The transport's events and what each carries. */
export interface RealtimeEvents {
  state: RealtimeState;
  updates: RelayFrame;
  awareness: PresenceMessage;
  changesAvailable: ChangesAvailable;
  pagePresence: PagePresence;
  accessRevoked: AccessRevoked;
}

export interface RealtimeTransport {
  readonly state: RealtimeState;
  /** Typed events; each `on` returns its own off. */
  on<K extends keyof RealtimeEvents>(
    event: K,
    listener: (value: RealtimeEvents[K]) => void,
  ): () => void;
  /** Follows these workspaces (at most 50), replacing the connection's earlier set. */
  joinWorkspaces(ids: Id[]): Promise<JoinedWorkspace[]>;
  joinPage(pageId: Id): Promise<JoinedPage>;
  leavePage(pageId: Id): Promise<void>;
  /** As SyncApi.pushDoc; OfflineError when not connected; SyncHttpError for a refusal. */
  pushDoc(pageId: Id, request: DocPushRequest): Promise<DocPushAnswer>;
  /** Fire and forget; dropped while disconnected. */
  awareness(pageId: Id, state: PresenceState | null): void;
}

/** The hub's limits a client keeps to (contract section 1). */
export const REALTIME_LIMITS = {
  /** Decoded update bytes one `PushUpdates` takes; anything larger goes over HTTP. */
  pushBytes: 1024 * 1024,
  /** Updates one live push sends (as an HTTP push's). */
  pushUpdates: 200,
  /** Pages joined per connection, and workspaces followed. */
  pages: 50,
  workspaces: 50,
  /** JSON of one presence state. */
  presenceBytes: 1024,
} as const;

/** The hub's method and event names (`realtime.1`). */
export const HUB = {
  joinWorkspaces: 'JoinWorkspaces',
  joinPage: 'JoinPage',
  leavePage: 'LeavePage',
  pushUpdates: 'PushUpdates',
  awareness: 'Awareness',
  updates: 'Updates',
  changesAvailable: 'ChangesAvailable',
  pagePresence: 'PagePresence',
  accessRevoked: 'AccessRevoked',
} as const;

// Reading what the server sends: never trusted to be well formed -----------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value));
const isCount = (value: unknown) => Number.isSafeInteger(num(value)) && num(value) >= 0;
const isText = (value: unknown): value is string => typeof value === 'string';
const texts = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every(isText) ? value : null;

/** The value of a hub answer, or its refusal as SyncHttpError. */
export function answerValue<T>(answer: unknown): T {
  if (isRecord(answer) && answer.ok === true) return answer.value as T;
  if (isRecord(answer) && answer.ok === false && isCount(answer.status))
    throw new SyncHttpError(
      num(answer.status),
      isText(answer.code) ? answer.code : 'server.error',
      isText(answer.title) ? answer.title : undefined,
      isCount(answer.retryAfterMs) ? num(answer.retryAfterMs) : undefined,
    );
  throw new SyncHttpError(500, 'server.error', 'The hub answered with something unexpected');
}

/** A frame from the wire with its bytes decoded; null when it is not one. */
export function relayFrame(wire: unknown): RelayFrame | null {
  if (!isRecord(wire) || !isText(wire.pageId)) return null;
  if (![wire.epoch, wire.after, wire.cursor, wire.headSeq].every(isCount)) return null;
  const rejected = texts(wire.rejected);
  if (!Array.isArray(wire.updates) || !rejected || typeof wire.complete !== 'boolean') return null;
  const updates: RelayFrame['updates'] = [];
  for (const u of wire.updates as unknown[]) {
    if (!isRecord(u) || !isCount(u.seq) || !isText(u.updateId) || !isText(u.data)) return null;
    let data: Uint8Array;
    try {
      data = fromBase64(u.data);
    } catch {
      return null;
    }
    updates.push({ seq: num(u.seq), updateId: u.updateId, data });
  }
  return {
    pageId: wire.pageId,
    epoch: num(wire.epoch),
    after: num(wire.after),
    cursor: num(wire.cursor),
    headSeq: num(wire.headSeq),
    updates,
    rejected,
    complete: wire.complete,
  };
}

/** A frame for the wire (the hub's side; the testing hub sends these). */
export function wireFrame(frame: RelayFrame): RealtimeFrame {
  return { ...frame, updates: frame.updates.map((u) => ({ ...u, data: toBase64(u.data) })) };
}

function presenceState(value: unknown): PresenceState | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isCount(value.clientId)) return undefined;
  const cursor = value.cursor;
  if (cursor === null) return { clientId: num(value.clientId), cursor: null };
  if (!isRecord(cursor) || !isText(cursor.anchor) || !isText(cursor.head)) return undefined;
  return { clientId: num(value.clientId), cursor: { anchor: cursor.anchor, head: cursor.head } };
}

/** A presence message from the wire; null when it is not one. */
export function presenceMessage(wire: unknown): PresenceMessage | null {
  if (!isRecord(wire) || !isText(wire.pageId) || !isText(wire.presenceId) || !isText(wire.userId))
    return null;
  const state = presenceState(wire.state);
  if (state === undefined) return null;
  return { pageId: wire.pageId, presenceId: wire.presenceId, userId: wire.userId, state };
}

function pagePresence(wire: unknown): PagePresence | null {
  if (!isRecord(wire) || !isText(wire.workspaceId) || !isText(wire.pageId)) return null;
  const userIds = texts(wire.userIds);
  return userIds ? { workspaceId: wire.workspaceId, pageId: wire.pageId, userIds } : null;
}

function changesAvailable(wire: unknown): ChangesAvailable | null {
  if (!isRecord(wire) || !isText(wire.workspaceId) || !isCount(wire.seq)) return null;
  return { workspaceId: wire.workspaceId, seq: num(wire.seq) };
}

function accessRevoked(wire: unknown): AccessRevoked | null {
  if (!isRecord(wire) || !isText(wire.workspaceId) || !isText(wire.reason)) return null;
  if (wire.pageId !== null && !isText(wire.pageId)) return null;
  return { workspaceId: wire.workspaceId, pageId: wire.pageId, reason: wire.reason };
}

function joinedPage(value: unknown): JoinedPage {
  if (!isRecord(value) || !isText(value.workspaceId) || !isCount(value.epoch))
    throw new SyncHttpError(500, 'server.error', 'A page joined without its state');
  const levels: PageLevel[] = ['full', 'edit', 'comment', 'view'];
  return {
    workspaceId: value.workspaceId,
    epoch: num(value.epoch),
    headSeq: isCount(value.headSeq) ? num(value.headSeq) : 0,
    schemaVersion: isCount(value.schemaVersion) ? num(value.schemaVersion) : 1,
    level: levels.includes(value.level as PageLevel) ? (value.level as PageLevel) : 'view',
    presence: (Array.isArray(value.presence) ? value.presence : [])
      .map(presenceMessage)
      .filter((m): m is PresenceMessage => m !== null),
  };
}

function joinedWorkspaces(value: unknown): JoinedWorkspace[] {
  if (!Array.isArray(value)) return [];
  const out: JoinedWorkspace[] = [];
  for (const w of value as unknown[]) {
    if (!isRecord(w) || !isText(w.workspaceId) || !isCount(w.seq)) continue;
    const presence = (Array.isArray(w.presence) ? (w.presence as unknown[]) : []).flatMap((p) => {
      const userIds = isRecord(p) ? texts(p.userIds) : null;
      return isRecord(p) && isText(p.pageId) && userIds ? [{ pageId: p.pageId, userIds }] : [];
    });
    out.push({ workspaceId: w.workspaceId, seq: num(w.seq), presence });
  }
  return out;
}

// The transport ------------------------------------------------------------------------------------

/** One open connection to the hub, as a transport uses it (SignalR's, or the testing hub's). */
export interface HubSocket {
  /** Calls a hub method and resolves with what it answered; rejects when the connection is lost. */
  invoke(method: string, ...args: unknown[]): Promise<unknown>;
  /** Handles a hub event (one handler per event). */
  on(event: string, handler: (payload: unknown) => void): void;
  /** Called once when the connection closes, whatever closed it. */
  onClose(handler: (error?: unknown) => void): void;
  close(): Promise<void>;
}

export interface HubTransportOptions {
  /**
   * Opens a socket: a fresh ticket and a new connection each time. Throws OfflineError when the
   * server cannot be reached, SyncHttpError when it refuses (a 429's `Retry-After` is honoured).
   */
  open(): Promise<HubSocket>;
  /** The first wait after a failure, doubling up to `maxDelayMs` (1 s, 30 s). */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** For tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
}

type Listeners = { [K in keyof RealtimeEvents]: Set<(value: RealtimeEvents[K]) => void> };

/**
 * A transport over hub sockets, with its own reconnect loop: after a failure or a drop it waits
 * `min × 2^n` (capped at `max`) times a jitter of 0.5 to 1, so a server recycle's clients come
 * back spread out; `retryNow` (the network back, the window focused) tries at once.
 */
export class HubTransport implements RealtimeTransport {
  private state_: RealtimeState = 'disconnected';
  private socket: HubSocket | null = null;
  private started = false;
  private failures = 0;
  private timer: unknown = null;
  /** Bumped by every attempt and by `stop`: an older attempt's socket is closed, not used. */
  private attempt = 0;
  private readonly listeners: Listeners = {
    state: new Set(),
    updates: new Set(),
    awareness: new Set(),
    changesAvailable: new Set(),
    pagePresence: new Set(),
    accessRevoked: new Set(),
  };

  constructor(private readonly options: HubTransportOptions) {}

  get state(): RealtimeState {
    return this.state_;
  }

  /** Whether the loop is running (started and not stopped). */
  get running(): boolean {
    return this.started;
  }

  on<K extends keyof RealtimeEvents>(
    event: K,
    listener: (value: RealtimeEvents[K]) => void,
  ): () => void {
    const set = this.listeners[event] as Set<(value: RealtimeEvents[K]) => void>;
    set.add(listener);
    return () => void set.delete(listener);
  }

  private emit<K extends keyof RealtimeEvents>(event: K, value: RealtimeEvents[K]) {
    for (const listener of [...this.listeners[event]] as ((value: RealtimeEvents[K]) => void)[]) {
      try {
        listener(value);
      } catch (error) {
        console.error('A real-time listener failed:', error);
      }
    }
  }

  private setState(state: RealtimeState) {
    if (state === this.state_) return;
    this.state_ = state;
    this.emit('state', state);
  }

  /** Connects, and keeps connecting after every failure or drop until `stop`. */
  start() {
    if (this.started) return;
    this.started = true;
    this.failures = 0;
    void this.connect();
  }

  /** Closes the connection and stops the loop. */
  stop() {
    this.started = false;
    this.attempt++;
    this.clearTimer();
    const socket = this.socket;
    this.socket = null;
    this.setState('disconnected');
    if (socket) void socket.close().catch(() => undefined);
  }

  /** Tries again at once if disconnected (the network came back, the window was focused). */
  retryNow() {
    if (!this.started || this.state_ !== 'disconnected') return;
    this.clearTimer();
    void this.connect();
  }

  private clearTimer() {
    if (this.timer !== null)
      (this.options.clearTimer ?? ((h) => clearTimeout(h as number)))(this.timer);
    this.timer = null;
  }

  private async connect() {
    const attempt = ++this.attempt;
    this.setState('connecting');
    let socket: HubSocket;
    try {
      socket = await this.options.open();
    } catch (error) {
      if (attempt !== this.attempt) return;
      this.setState('disconnected');
      this.retryLater(error instanceof SyncHttpError ? (error.retryAfterMs ?? 0) : 0);
      if (!(error instanceof OfflineError) && !(error instanceof SyncHttpError))
        console.warn('The real-time connection could not open:', error);
      return;
    }
    if (attempt !== this.attempt) {
      void socket.close().catch(() => undefined);
      return;
    }
    this.socket = socket;
    this.listen(socket);
    socket.onClose(() => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setState('disconnected');
      if (this.started) this.retryLater(0);
    });
    this.failures = 0;
    this.setState('connected');
  }

  /** The next attempt, after the backoff (and no sooner than the server asked). */
  private retryLater(atLeastMs: number) {
    if (!this.started) return;
    const min = this.options.minDelayMs ?? 1000;
    const max = this.options.maxDelayMs ?? 30_000;
    const base = Math.min(max, min * 2 ** this.failures++);
    const wait = Math.max(atLeastMs, base * (0.5 + 0.5 * (this.options.random ?? Math.random)()));
    this.clearTimer();
    this.timer = (this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
      this.timer = null;
      if (this.started && this.state_ === 'disconnected') void this.connect();
    }, wait);
  }

  private listen(socket: HubSocket) {
    const take =
      <K extends keyof RealtimeEvents>(
        event: K,
        read: (wire: unknown) => RealtimeEvents[K] | null,
      ) =>
      (payload: unknown) => {
        if (this.socket !== socket) return;
        const value = read(payload);
        if (value === null) console.warn(`A malformed ${event} message was ignored.`);
        else this.emit(event, value);
      };
    socket.on(HUB.updates, take('updates', relayFrame));
    socket.on(HUB.awareness, take('awareness', presenceMessage));
    socket.on(HUB.changesAvailable, take('changesAvailable', changesAvailable));
    socket.on(HUB.pagePresence, take('pagePresence', pagePresence));
    socket.on(HUB.accessRevoked, take('accessRevoked', accessRevoked));
  }

  /** A hub method's value; OfflineError when not connected or the connection went meanwhile. */
  private async call<T>(method: string, ...args: unknown[]): Promise<T> {
    const socket = this.socket;
    if (!socket || this.state_ !== 'connected')
      throw new OfflineError('The real-time connection is not open');
    let answer: unknown;
    try {
      answer = await socket.invoke(method, ...args);
    } catch (error) {
      // The connection went (the answer with it), or the hub failed the call while it stayed.
      if (this.socket !== socket) throw new OfflineError(error);
      throw new SyncHttpError(500, 'server.error', String(error));
    }
    return answerValue<T>(answer);
  }

  /**
   * Follows workspaces; who has which page open there comes as `pagePresence` events too, so a
   * listener hears the state at the join and every change after it the same way.
   */
  async joinWorkspaces(ids: Id[]): Promise<JoinedWorkspace[]> {
    const answers = joinedWorkspaces(await this.call<unknown>(HUB.joinWorkspaces, ids));
    for (const answer of answers)
      for (const p of answer.presence)
        this.emit('pagePresence', { workspaceId: answer.workspaceId, ...p });
    return answers;
  }

  /** Joins a page; the others' presence on it comes as `awareness` events too. */
  async joinPage(pageId: Id): Promise<JoinedPage> {
    const joined = joinedPage(await this.call<unknown>(HUB.joinPage, pageId));
    for (const message of joined.presence) this.emit('awareness', message);
    return joined;
  }

  async leavePage(pageId: Id): Promise<void> {
    await this.call<unknown>(HUB.leavePage, pageId);
  }

  async pushDoc(pageId: Id, request: DocPushRequest): Promise<DocPushAnswer> {
    const answer = await this.call<{ acks?: unknown; headSeq?: unknown }>(HUB.pushUpdates, pageId, {
      epoch: request.epoch,
      clientSchemaVersion: request.clientSchemaVersion,
      updates: request.updates.map((u) => ({ updateId: u.updateId, data: toBase64(u.data) })),
    });
    const acks = Array.isArray(answer?.acks) ? (answer.acks as unknown[]) : [];
    return {
      acks: acks.flatMap((a) =>
        isRecord(a) && isText(a.updateId) && isCount(a.seq)
          ? [{ updateId: a.updateId, seq: num(a.seq) }]
          : [],
      ),
      headSeq: isCount(answer?.headSeq) ? num(answer.headSeq) : 0,
    };
  }

  awareness(pageId: Id, state: PresenceState | null): void {
    if (this.state_ !== 'connected') return;
    this.call<unknown>(HUB.awareness, pageId, state).catch(() => undefined);
  }
}
