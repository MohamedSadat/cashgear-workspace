// The inbox (contract section 5): the person's notifications from every workspace they are in,
// read when the account is known, again when the feed says the inbox changed and when the server
// can be reached again. Marking read shows at once; the server's count follows. In the app only
// (DECISIONS.md, 2026-11-14: Phase 6); nothing is stored on this device.
import type { ApiClient } from '@cgw/api';
import type { Id } from '@cgw/workspace';
import { answer, type PersonRef } from './comments';

export type NotificationKind = 'mention' | 'commentMention' | 'reply';

export interface NotificationDto {
  id: Id;
  kind: NotificationKind;
  workspaceId: Id;
  pageId: Id;
  pageTitle: string;
  blockId: string | null;
  threadId: Id | null;
  commentId: Id | null;
  actor: PersonRef;
  excerpt: string;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationPage {
  notifications: NotificationDto[];
  unread: number;
  next: string | null;
}

export interface NotificationsApi {
  list(query: {
    unread?: boolean;
    after?: string | null;
    limit?: number;
  }): Promise<NotificationPage>;
  read(body: { ids?: Id[]; all?: boolean }): Promise<{ unread: number }>;
}

const KINDS = new Set<string>(['mention', 'commentMention', 'reply']);

export function readNotification(value: unknown): NotificationDto | null {
  const n = value as Record<string, unknown>;
  if (!n || !KINDS.has(String(n.kind))) return null;
  const actor = (n.actor ?? {}) as { id?: unknown; name?: unknown };
  return {
    id: String(n.id),
    kind: n.kind as NotificationKind,
    workspaceId: String(n.workspaceId),
    pageId: String(n.pageId),
    pageTitle: String(n.pageTitle ?? ''),
    blockId: (n.blockId as string | null | undefined) ?? null,
    threadId: (n.threadId as string | null | undefined) ?? null,
    commentId: (n.commentId as string | null | undefined) ?? null,
    actor: { id: String(actor.id ?? ''), name: String(actor.name ?? '') },
    excerpt: String(n.excerpt ?? ''),
    createdAt: String(n.createdAt),
    readAt: (n.readAt as string | null | undefined) ?? null,
  };
}

/** The notification routes over the app's API client (typed from the OpenAPI document). */
export function notificationsApi(api: ApiClient): NotificationsApi {
  return {
    list: async ({ unread, after, limit = 50 }) => {
      const page = await answer(
        api.GET('/api/v1/account/notifications', {
          params: {
            query: {
              limit,
              ...(unread !== undefined ? { unread } : {}),
              ...(after ? { after } : {}),
            },
          },
        }),
      );
      return {
        notifications: page.notifications.flatMap((n) => readNotification(n) ?? []),
        unread: Number(page.unread ?? 0),
        next: page.next ?? null,
      };
    },
    read: async (body) => {
      const result = await answer(
        api.POST('/api/v1/account/notifications/read', {
          body: { ids: body.ids ?? null, all: body.all ?? null },
        }),
      );
      return { unread: Number(result.unread ?? 0) };
    },
  };
}

export interface InboxSnapshot {
  items: NotificationDto[];
  unread: number;
  /** More to read (`loadMore`). */
  next: string | null;
  loaded: boolean;
  online: boolean;
  unreadOnly: boolean;
  loadingMore: boolean;
}

export interface InboxOptions {
  api: NotificationsApi;
  /** Someone is signed in and the server can be reached. */
  online: () => boolean;
  /** Someone is signed in (signed out, the inbox is empty). */
  signedIn: () => boolean;
  unreachable: (error: unknown) => boolean;
  now?: () => Date;
}

const EMPTY: InboxSnapshot = Object.freeze({
  items: [],
  unread: 0,
  next: null,
  loaded: false,
  online: true,
  unreadOnly: false,
  loadingMore: false,
}) as InboxSnapshot;

export class InboxStore {
  private state: InboxSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;

  constructor(private readonly options: InboxOptions) {}

  snapshot = (): InboxSnapshot => this.state;

  /** The unread count alone, for the sidebar (renders again only when it changes). */
  unread = (): number => this.state.unread;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private set(change: Partial<InboxSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  /** Reads the first page again; offline, what was shown stays. */
  async load(): Promise<void> {
    if (this.disposed) return;
    if (!this.options.signedIn()) {
      this.generation++;
      if (this.state !== EMPTY) {
        this.state = { ...EMPTY, unreadOnly: this.state.unreadOnly };
        for (const listener of this.listeners) listener();
      }
      return;
    }
    if (!this.options.online()) return this.set({ online: false });
    const generation = ++this.generation;
    try {
      const page = await this.options.api.list({
        ...(this.state.unreadOnly ? { unread: true } : {}),
        limit: 50,
      });
      if (generation !== this.generation) return;
      this.set({
        items: page.notifications,
        unread: page.unread,
        next: page.next,
        loaded: true,
        online: true,
      });
    } catch (error) {
      if (generation !== this.generation) return;
      if (this.options.unreachable(error)) this.set({ online: false });
      else console.warn('The inbox could not be read:', error);
    }
  }

  async loadMore(): Promise<void> {
    const { next } = this.state;
    if (!next || this.state.loadingMore || !this.options.online()) return;
    const generation = this.generation;
    this.set({ loadingMore: true });
    try {
      const page = await this.options.api.list({
        ...(this.state.unreadOnly ? { unread: true } : {}),
        after: next,
        limit: 50,
      });
      if (generation !== this.generation) return this.set({ loadingMore: false });
      const known = new Set(this.state.items.map((n) => n.id));
      this.set({
        items: [...this.state.items, ...page.notifications.filter((n) => !known.has(n.id))],
        unread: page.unread,
        next: page.next,
        loadingMore: false,
      });
    } catch (error) {
      this.set({
        loadingMore: false,
        ...(this.options.unreachable(error) ? { online: false } : {}),
      });
    }
  }

  setUnreadOnly(unreadOnly: boolean) {
    if (unreadOnly === this.state.unreadOnly) return;
    this.set({ unreadOnly, next: null });
    void this.load();
  }

  /** One opened: read at once here, then at the server. It stays in the list until read again. */
  markRead(id: Id) {
    const item = this.state.items.find((n) => n.id === id);
    if (!item || item.readAt) return;
    const at = (this.options.now?.() ?? new Date()).toISOString();
    this.set({
      items: this.state.items.map((n) => (n.id === id ? { ...n, readAt: at } : n)),
      unread: Math.max(0, this.state.unread - 1),
    });
    this.send({ ids: [id] });
  }

  markAllRead() {
    if (!this.state.unread && this.state.items.every((n) => n.readAt)) return;
    const at = (this.options.now?.() ?? new Date()).toISOString();
    this.set({
      items: this.state.items.map((n) => (n.readAt ? n : { ...n, readAt: at })),
      unread: 0,
    });
    this.send({ all: true });
  }

  private send(body: { ids?: Id[]; all?: boolean }) {
    // A read started before this answer could still count the item: it is not shown.
    this.generation++;
    void this.options.api.read(body).then(
      (result) => this.set({ unread: result.unread }),
      (error: unknown) => {
        if (this.options.unreachable(error)) this.set({ online: false });
        // The server's state, whatever happened.
        void this.load();
      },
    );
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
}
