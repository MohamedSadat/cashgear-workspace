// Presence (contract section 4) over the realtime transport's `awareness` and `pagePresence`
// events: who is on the open page and where their cursor is, and which pages of the workspace
// others have open. Names and colours come from the directory, never from a message. Nothing here
// is React: the editor reads cursors through its own subscription, and the avatars subscribe to
// the people on a page, which changes only when someone comes or goes, never per keystroke.
import type { Id } from '@cgw/workspace';
import { colourOf } from './colour';
import type { PeopleDirectory } from './people';

/** What a client says about itself on a page (contract section 1). */
export interface PresenceState {
  clientId: number;
  cursor: { anchor: string; head: string } | null;
}

export interface PresenceMessage {
  pageId: Id;
  presenceId: string;
  userId: Id;
  state: PresenceState | null;
}

export interface PagePresenceEvent {
  workspaceId: Id;
  pageId: Id;
  userIds: Id[];
}

export type TransportState = 'connecting' | 'connected' | 'disconnected';

/** What presence needs of the realtime transport (`RealtimeTransport`, contract section 1). */
export interface PresenceTransport {
  readonly state: TransportState;
  on(event: 'state', listener: (state: TransportState) => void): () => void;
  on(event: 'awareness', listener: (message: PresenceMessage) => void): () => void;
  on(event: 'pagePresence', listener: (presence: PagePresenceEvent) => void): () => void;
  awareness(pageId: Id, state: PresenceState | null): void;
}

/** An entry not heard from for this long is dropped. */
export const PRESENCE_TTL_MS = 30_000;
/** This session's selection is sent at most this often. */
export const SEND_EVERY_MS = 50;
/** And again this often while the page is open, so the others keep it. */
export const HEARTBEAT_MS = 10_000;
/** After the connection comes back (and the page is joined again), the state is sent again. */
const RESEND_AFTER_CONNECT_MS = 300;

/**
 * The transport as it is now: the cloud makes a new one on sign-in and drops it on sign-out, so
 * the stores listen here once and this follows whichever transport there is.
 */
export class TransportHub {
  private current: PresenceTransport | null = null;
  private offs: (() => void)[] = [];
  private readonly awarenessListeners = new Set<(message: PresenceMessage) => void>();
  private readonly pagePresenceListeners = new Set<(presence: PagePresenceEvent) => void>();
  private readonly stateListeners = new Set<(state: TransportState) => void>();

  constructor(private readonly find: () => PresenceTransport | null) {
    this.check();
  }

  /** Looks for the transport again (the account or the connection changed). */
  check() {
    const next = this.find();
    if (next === this.current) return;
    for (const off of this.offs) off();
    this.offs = [];
    this.current = next;
    if (next)
      this.offs = [
        next.on('awareness', (message) => {
          for (const listener of this.awarenessListeners) listener(message);
        }),
        next.on('pagePresence', (presence) => {
          for (const listener of this.pagePresenceListeners) listener(presence);
        }),
        next.on('state', (state) => {
          for (const listener of this.stateListeners) listener(state);
        }),
      ];
    const state = next?.state ?? 'disconnected';
    for (const listener of this.stateListeners) listener(state);
  }

  get state(): TransportState {
    return this.current?.state ?? 'disconnected';
  }

  send(pageId: Id, state: PresenceState | null) {
    this.current?.awareness(pageId, state);
  }

  onAwareness(listener: (message: PresenceMessage) => void): () => void {
    this.awarenessListeners.add(listener);
    return () => void this.awarenessListeners.delete(listener);
  }

  onPagePresence(listener: (presence: PagePresenceEvent) => void): () => void {
    this.pagePresenceListeners.add(listener);
    return () => void this.pagePresenceListeners.delete(listener);
  }

  onState(listener: (state: TransportState) => void): () => void {
    this.stateListeners.add(listener);
    return () => void this.stateListeners.delete(listener);
  }

  dispose() {
    for (const off of this.offs) off();
    this.offs = [];
    this.current = null;
    this.awarenessListeners.clear();
    this.pagePresenceListeners.clear();
    this.stateListeners.clear();
  }
}

export interface Cursor {
  key: string;
  userId: Id;
  name: string;
  colour: string;
  anchor: string;
  head: string;
}

interface Entry {
  userId: Id;
  state: PresenceState;
  heard: number;
}

const EMPTY: readonly Id[] = Object.freeze([]);

export interface PagePresenceOptions {
  pageId: Id;
  hub: TransportHub;
  /** The signed-in person: left out of the people shown. */
  selfId: () => Id | null;
  people: PeopleDirectory | null;
  /** A cursor's name when the directory does not know the person ("Someone"). */
  unknownName: () => string;
  /**
   * Whether this connection has joined the page on the hub now (the cloud's `onJoined`): the
   * server takes `Awareness` only for a joined page, so this session's state waits for the join
   * and goes as it is made (`setJoined`). Absent: sent whenever connected.
   */
  joined?: () => boolean;
  now?: () => number;
}

/**
 * One page's presence: the others' cursors for the editor (contract section 6, `presence`), the
 * people on the page for the top bar, and this session's own state sent to the others.
 */
export class PagePresence {
  readonly pageId: Id;
  private readonly entries = new Map<string, Entry>();
  private cursorList: Cursor[] = [];
  private cursorKey = '';
  private peopleList: readonly Id[] = EMPTY;
  private readonly cursorListeners = new Set<() => void>();
  private readonly peopleListeners = new Set<() => void>();
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private readonly offs: (() => void)[] = [];
  private readonly now: () => number;
  // This session.
  private clientId: number | null = null;
  private cursor: PresenceState['cursor'] = null;
  private attached = false;
  private lastSent = Number.NEGATIVE_INFINITY;
  private trailing: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private resend: ReturnType<typeof setTimeout> | null = null;
  private joinedNow: boolean | null;

  constructor(private readonly options: PagePresenceOptions) {
    this.pageId = options.pageId;
    this.now = options.now ?? Date.now;
    this.joinedNow = options.joined ? options.joined() : null;
    this.offs.push(
      options.hub.onAwareness((message) => this.receive(message)),
      options.hub.onState((state) => this.onState(state)),
    );
    if (options.people) this.offs.push(options.people.subscribe(() => this.recompute()));
  }

  // What the others say -----------------------------------------------------------------------

  receive(message: PresenceMessage) {
    if (message.pageId !== this.pageId) return;
    if (!message.state) {
      if (this.entries.delete(message.presenceId)) this.recompute();
      return;
    }
    // This session's own state, if it ever comes back, is not someone else's.
    if (message.userId === this.options.selfId() && message.state.clientId === this.clientId)
      return;
    this.entries.set(message.presenceId, {
      userId: message.userId,
      state: message.state,
      heard: this.now(),
    });
    this.recompute();
  }

  private onState(state: TransportState) {
    if (state === 'disconnected') {
      // Nobody can be heard from: what was known is not shown as if it were current.
      if (this.entries.size) {
        this.entries.clear();
        this.recompute();
      }
      return;
    }
    // With joins told (`setJoined`), the page's join after the reconnect sends it instead.
    if (state === 'connected' && this.attached && this.joinedNow === null) {
      if (this.resend) clearTimeout(this.resend);
      this.resend = setTimeout(() => {
        this.resend = null;
        if (this.attached) this.sendNow();
      }, RESEND_AFTER_CONNECT_MS);
    }
  }

  /** Drops entries not heard from within the time to live, then waits for the next one. */
  private expire = () => {
    this.expiry = null;
    const now = this.now();
    let changed = false;
    for (const [id, entry] of this.entries)
      if (now - entry.heard >= PRESENCE_TTL_MS) {
        this.entries.delete(id);
        changed = true;
      }
    if (changed) this.recompute();
    else this.scheduleExpiry();
  };

  private scheduleExpiry() {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    if (!this.entries.size) return;
    const oldest = Math.min(...[...this.entries.values()].map((e) => e.heard));
    this.expiry = setTimeout(this.expire, Math.max(0, oldest + PRESENCE_TTL_MS - this.now()));
  }

  private recompute() {
    const self = this.options.selfId();
    const people = this.options.people;
    // One cursor per person and session (their Yjs client id), the newest if two say so.
    const byKey = new Map<string, Entry>();
    for (const entry of this.entries.values()) {
      if (!entry.state.cursor) continue;
      const key = `${entry.userId}:${entry.state.clientId}`;
      const was = byKey.get(key);
      if (!was || was.heard <= entry.heard) byKey.set(key, entry);
    }
    const cursors = [...byKey].map(([key, entry]): Cursor => {
      const cursor = entry.state.cursor!;
      return {
        key,
        userId: entry.userId,
        name: people?.name(entry.userId) ?? this.options.unknownName(),
        colour: colourOf(entry.userId),
        anchor: cursor.anchor,
        head: cursor.head,
      };
    });
    cursors.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const cursorKey = cursors.map((c) => `${c.key}|${c.anchor}|${c.head}|${c.name}`).join('\n');
    if (cursorKey !== this.cursorKey) {
      this.cursorKey = cursorKey;
      this.cursorList = cursors;
      for (const listener of this.cursorListeners) listener();
    }
    // The people on the page, in the order they came, this person left out.
    const seen: Id[] = [];
    for (const entry of this.entries.values())
      if (entry.userId !== self && !seen.includes(entry.userId)) seen.push(entry.userId);
    if (seen.join(',') !== this.peopleList.join(',')) {
      this.peopleList = seen.length ? Object.freeze(seen) : EMPTY;
      for (const listener of this.peopleListeners) listener();
    }
    this.scheduleExpiry();
  }

  /** Others' cursors on this page now (not this session, not stale); the same array until one changes. */
  cursors = (): Cursor[] => this.cursorList;

  /** The editor's subscription: told when a cursor moves, comes or goes. */
  subscribe = (listener: () => void): (() => void) => {
    this.cursorListeners.add(listener);
    return () => void this.cursorListeners.delete(listener);
  };

  /** The other people on the page (distinct, this person left out); the same array until it changes. */
  people = (): readonly Id[] => this.peopleList;

  /** The avatars' subscription: told only when someone comes or goes. */
  subscribePeople = (listener: () => void): (() => void) => {
    this.peopleListeners.add(listener);
    return () => void this.peopleListeners.delete(listener);
  };

  // What this session says -------------------------------------------------------------------------

  /** The page is open in this session's editor, writing as `clientId`: it says so now and every 10 s. */
  attach(clientId: number) {
    if (this.attached && this.clientId === clientId) return;
    this.detach();
    this.clientId = clientId;
    this.attached = true;
    this.sendNow();
    this.heartbeat = setInterval(() => this.sendNow(), HEARTBEAT_MS);
  }

  /** This editor's selection (relative positions), or null when it is not focused. */
  setLocal = (cursor: PresenceState['cursor']) => {
    this.cursor = cursor;
    if (!this.attached) return;
    if (this.trailing) return; // The send already waiting takes the latest.
    const wait = this.lastSent + SEND_EVERY_MS - this.now();
    if (wait <= 0) this.sendNow();
    else
      this.trailing = setTimeout(() => {
        this.trailing = null;
        if (this.attached) this.sendNow();
      }, wait);
  };

  /** The page was joined on the hub (this session's state goes now), or is no longer. */
  setJoined(joined: boolean) {
    if (this.joinedNow === joined) return;
    this.joinedNow = joined;
    if (joined && this.attached) this.sendNow();
  }

  private sendNow() {
    if (this.clientId === null || this.joinedNow === false) return;
    this.lastSent = this.now();
    this.options.hub.send(this.pageId, { clientId: this.clientId, cursor: this.cursor });
  }

  /** The page is left: the others are told at once (null), and nothing more is sent. */
  detach() {
    if (this.trailing) clearTimeout(this.trailing);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.resend) clearTimeout(this.resend);
    this.trailing = this.heartbeat = this.resend = null;
    if (!this.attached) return;
    this.attached = false;
    this.cursor = null;
    this.options.hub.send(this.pageId, null);
  }

  dispose() {
    this.detach();
    for (const off of this.offs) off();
    this.offs.length = 0;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    this.entries.clear();
    this.cursorListeners.clear();
    this.peopleListeners.clear();
  }
}

/**
 * Which pages of the open workspaces others have open (`PagePresence` events and the answer to
 * `JoinWorkspaces`), for the sidebar's avatars. Each page's list stays the same array until it
 * changes, so a row reading its own page renders again only when that page's people change.
 */
export class WorkspacePresence {
  private readonly pages = new Map<Id, { workspaceId: Id; userIds: readonly Id[] }>();
  private readonly listeners = new Set<() => void>();
  private readonly offs: (() => void)[] = [];

  constructor(
    hub: TransportHub,
    private readonly selfId: () => Id | null,
  ) {
    this.offs.push(
      hub.onPagePresence((p) => this.set(p.workspaceId, p.pageId, p.userIds)),
      hub.onState((state) => state === 'disconnected' && this.clear()),
    );
  }

  set(workspaceId: Id, pageId: Id, userIds: readonly Id[]) {
    const self = this.selfId();
    const others = [...new Set(userIds)].filter((id) => id !== self).sort();
    const was = this.pages.get(pageId);
    if ((was?.userIds ?? EMPTY).join(',') === others.join(',')) return;
    if (others.length) this.pages.set(pageId, { workspaceId, userIds: Object.freeze(others) });
    else this.pages.delete(pageId);
    this.emit();
  }

  /** A workspace's pages as `JoinWorkspaces` answered: what was known of it is replaced. */
  seed(workspaceId: Id, presence: { pageId: Id; userIds: Id[] }[]) {
    for (const [pageId, entry] of this.pages)
      if (entry.workspaceId === workspaceId && !presence.some((p) => p.pageId === pageId))
        this.set(workspaceId, pageId, []);
    for (const p of presence) this.set(workspaceId, p.pageId, p.userIds);
  }

  clear() {
    if (!this.pages.size) return;
    this.pages.clear();
    this.emit();
  }

  /** The others who have the page open (the same array until it changes). */
  of = (pageId: Id): readonly Id[] => this.pages.get(pageId)?.userIds ?? EMPTY;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private emit() {
    for (const listener of this.listeners) listener();
  }

  dispose() {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.pages.clear();
    this.listeners.clear();
  }
}
