// Phase 6's collaboration in the shell, one per cloud connection: the people of each workspace,
// presence on the open pages and in the sidebar, the inbox, and the comments of an open page.
// What it needs of the cloud is narrow (`CollabDeps`), so the stores are tested without one.
import type { Id } from '@cgw/workspace';
import { unreachable, type Cloud } from '../cloud/cloud';
import type { WorkspaceSession } from '../session';
import { CommentsStore, commentsApi, type CommentsApi, type PersonRef } from './comments';
import { InboxStore, notificationsApi, type NotificationsApi } from './inbox';
import { PeopleDirectory, type Member } from './people';
import { PagePresence, TransportHub, WorkspacePresence, type PresenceTransport } from './presence';

/** A sync event as the collaboration parts read it (the engine's `SyncEvent`, Phase 6's kinds). */
export interface CollabEvent {
  kind: string;
  workspaceId?: Id;
  pageId?: Id;
}

export interface CollabDeps {
  /** The signed-in person, or null. */
  self(): PersonRef | null;
  /** Someone is signed in and the server can be reached. */
  online(): boolean;
  /** Told when the account or the connection's state changes. */
  onStatus(listener: () => void): () => void;
  members(workspaceId: Id): Promise<Member[]>;
  /** The sync engine's events: `members`, and Phase 6's `comments` and `notifications`. */
  onEvent(listener: (event: CollabEvent) => void): () => void;
  /** The realtime transport now, or null (signed out, or a build without one). */
  transport(): PresenceTransport | null;
  /** Whether a page is joined on the hub now, and told when that changes (the cloud's `onJoined`). */
  isJoined?(pageId: Id): boolean;
  onJoined?(listener: (pageId: Id, joined: boolean) => void): () => void;
  /**
   * Whether the server holds a page yet (one made here is not until its first push is taken):
   * nothing is asked about a page before it does. Absent: always.
   */
  serverHolds?(pageId: Id): Promise<boolean>;
  comments: CommentsApi;
  notifications: NotificationsApi;
  unreachable(error: unknown): boolean;
  /** A cursor's name when the directory does not know the person, in the interface language. */
  unknownName(): string;
}

/** What the collaboration parts need of the cloud connection. */
export function collabDeps(
  cloud: Cloud,
  session: WorkspaceSession,
  unknownName: () => string,
): CollabDeps {
  return {
    self: () => {
      const account = cloud.account;
      return account ? { id: account.id, name: account.displayName } : null;
    },
    online: () => {
      const state = cloud.status.state;
      return !!cloud.account && state !== 'offline' && state !== 'signedOut';
    },
    onStatus: (listener) => cloud.subscribe(listener),
    members: (workspaceId) => cloud.members(workspaceId),
    onEvent: (listener) => cloud.engine.on((event) => listener(event as CollabEvent)),
    // The hub's connection (cloud/realtime.ts): running while someone is signed in.
    transport: () => cloud.realtime,
    isJoined: (pageId) => cloud.engine.isJoined(pageId),
    onJoined: (listener) => cloud.onJoined(listener),
    // Joined on the hub, or a document cursor here: the server has taken (or sent) the page's
    // document, so it holds the page.
    serverHolds: async (pageId) =>
      cloud.engine.isJoined(pageId) || !!(await session.store.docCursor(pageId)),
    comments: commentsApi(cloud.api),
    notifications: notificationsApi(cloud.api),
    unreachable,
    unknownName,
  };
}

export class Collab {
  readonly hub: TransportHub;
  readonly workspacePresence: WorkspacePresence;
  readonly inbox: InboxStore;
  private readonly directories = new Map<Id, PeopleDirectory>();
  private readonly pages = new Map<Id, { store: PagePresence; users: number }>();
  private readonly comments = new Set<CommentsStore>();
  private readonly offs: (() => void)[] = [];
  private selfId: Id | null;
  private wasOnline: boolean;

  constructor(readonly deps: CollabDeps) {
    this.selfId = deps.self()?.id ?? null;
    this.wasOnline = deps.online();
    this.hub = new TransportHub(() => deps.transport());
    this.workspacePresence = new WorkspacePresence(this.hub, () => this.deps.self()?.id ?? null);
    this.inbox = new InboxStore({
      api: deps.notifications,
      online: () => deps.online(),
      signedIn: () => !!deps.self(),
      unreachable: (error) => deps.unreachable(error),
    });
    this.offs.push(
      deps.onStatus(() => this.onStatus()),
      deps.onEvent((event) => this.onEvent(event)),
      ...(deps.onJoined
        ? [
            deps.onJoined((pageId, joined) => {
              this.pages.get(pageId)?.store.setJoined(joined);
              // Joined: the server holds the page; comments that waited for it are read now.
              if (joined)
                for (const store of this.comments) if (store.pageId === pageId) store.recheck();
            }),
          ]
        : []),
    );
    void this.inbox.load();
  }

  private onStatus() {
    this.hub.check();
    const self = this.deps.self()?.id ?? null;
    const online = this.deps.online();
    const accountChanged = self !== this.selfId;
    const back = online && !this.wasOnline;
    this.selfId = self;
    this.wasOnline = online;
    if (accountChanged) {
      // Another person (or nobody): what the last one could see goes.
      this.workspacePresence.clear();
      for (const directory of this.directories.values()) void directory.refresh();
    }
    for (const store of this.comments) store.setOnline(online);
    if (accountChanged || back) void this.inbox.load();
  }

  private onEvent(event: CollabEvent) {
    switch (event.kind) {
      case 'members':
        if (event.workspaceId) void this.directories.get(event.workspaceId)?.refresh();
        break;
      case 'comments':
        for (const store of this.comments) if (store.pageId === event.pageId) void store.load();
        break;
      case 'notifications':
        void this.inbox.load();
        break;
      case 'mirror':
        // A pass took this device's changes (a page made here among them, perhaps).
        for (const store of this.comments) store.recheck();
        break;
    }
  }

  /** The workspace's people (one directory per workspace, read on first use). */
  people(workspaceId: Id): PeopleDirectory {
    let directory = this.directories.get(workspaceId);
    if (!directory) {
      directory = new PeopleDirectory(workspaceId, (id) => this.deps.members(id));
      this.directories.set(workspaceId, directory);
      void directory.refresh();
    }
    return directory;
  }

  /** A page's presence, shared by its editor and the top bar; `release` when done with it. */
  presence(pageId: Id, workspaceId: Id): { store: PagePresence; release: () => void } {
    let entry = this.pages.get(pageId);
    if (!entry) {
      entry = {
        store: new PagePresence({
          pageId,
          hub: this.hub,
          selfId: () => this.deps.self()?.id ?? null,
          people: this.people(workspaceId),
          unknownName: () => this.deps.unknownName(),
          ...(this.deps.isJoined ? { joined: () => this.deps.isJoined!(pageId) } : {}),
        }),
        users: 0,
      };
      this.pages.set(pageId, entry);
    }
    entry.users++;
    const held = entry;
    let released = false;
    return {
      store: held.store,
      release: () => {
        if (released) return;
        released = true;
        if (--held.users > 0) return;
        held.store.dispose();
        if (this.pages.get(pageId) === held) this.pages.delete(pageId);
      },
    };
  }

  /** The open page's comments, read now; `dispose` it when the page closes. */
  commentsFor(pageId: Id): CommentsStore {
    const store = new CommentsStore({
      pageId,
      api: this.deps.comments,
      online: () => this.deps.online(),
      self: () => this.deps.self(),
      unreachable: (error) => this.deps.unreachable(error),
      ...(this.deps.serverHolds ? { serverHolds: () => this.deps.serverHolds!(pageId) } : {}),
    });
    this.comments.add(store);
    const dispose = store.dispose.bind(store);
    store.dispose = () => {
      this.comments.delete(store);
      dispose();
    };
    void store.load();
    return store;
  }

  /**
   * `JoinWorkspaces`' answer, for the sidebar: not reachable yet (the engine keeps it to itself);
   * the transport or the cloud passes it here once it gives it (phase-6-shell-ui.md).
   */
  seedWorkspace(workspaceId: Id, presence: { pageId: Id; userIds: Id[] }[]) {
    this.workspacePresence.seed(workspaceId, presence);
  }

  dispose() {
    for (const off of this.offs) off();
    this.offs.length = 0;
    for (const { store } of this.pages.values()) store.dispose();
    this.pages.clear();
    for (const store of [...this.comments]) store.dispose();
    for (const directory of this.directories.values()) directory.dispose();
    this.directories.clear();
    this.workspacePresence.dispose();
    this.inbox.dispose();
    this.hub.dispose();
  }
}
