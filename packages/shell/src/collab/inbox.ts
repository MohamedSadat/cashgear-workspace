// The inbox (contract section 5): the person's notifications from every workspace they are in,
// read when the account is known, again when the feed says the inbox changed and when the server
// can be reached again. Marking read shows at once; the server's count follows. In the app only
// (DECISIONS.md, 2026-11-14: Phase 6); nothing is stored on this device.
import type { ApiClient } from '@cgw/api';
import type { Id } from '@cgw/workspace';
import { answer, type PersonRef } from './comments';

/**
 * Phase 15: `automation`, a rule's notice or (with `reason`) a run of one's own that stopped.
 * Phase 17: `approval`, an approval a rule asks of the person (with `approval`); `reminder`, a row's
 * date reached, by a rule's reminder or the person's own (with `reminder`).
 */
export type NotificationKind =
  'mention' | 'commentMention' | 'reply' | 'automation' | 'approval' | 'reminder';

/** Phase 17: what a reminder is of: a date property (its name as it is now) and its value's start. */
export interface ReminderOf {
  propertyId: string;
  propertyName: string;
  /** A day (`YYYY-MM-DD`) or a UTC instant; null when the row had none by then. */
  start: string | null;
}

/** Phase 17: an approval as its item shows it: `open` while it is asked, else its outcome. */
export interface ApprovalState {
  id: Id;
  state: 'open' | 'approved' | 'rejected' | 'noAnswer' | 'stopped';
  /** The person's own answer, if they gave one. */
  answer: 'approve' | 'reject' | null;
  comment: string | null;
  mode: 'any' | 'all';
  deadlineAt: string;
  asked: number;
  answered: number;
}

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
  /** Phase 15: the rule's name as it is now, and why its run stopped. */
  automationName?: string | null;
  reason?: string | null;
  /** Phase 17, kind `approval`. */
  approval?: ApprovalState | null;
  /** Phase 17, kind `reminder`. */
  reminder?: ReminderOf | null;
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
  /** Phase 17: the person's answer to an approval; rejects with the refusal's code (`approval.closed`). */
  answer(
    approvalId: Id,
    answer: 'approve' | 'reject',
    comment: string | null,
  ): Promise<ApprovalState>;
}

const KINDS = new Set<string>([
  'mention',
  'commentMention',
  'reply',
  'automation',
  'approval',
  'reminder',
]);

function readReminder(value: unknown): ReminderOf | null {
  const r = value as Record<string, unknown> | null | undefined;
  if (!r || typeof r.propertyId !== 'string') return null;
  return {
    propertyId: r.propertyId,
    propertyName: String(r.propertyName ?? ''),
    start: typeof r.start === 'string' ? r.start : null,
  };
}

const STATES = new Set(['open', 'approved', 'rejected', 'noAnswer', 'stopped']);

export function readApproval(value: unknown): ApprovalState | null {
  const a = value as Record<string, unknown> | null | undefined;
  if (!a || typeof a.id !== 'string') return null;
  return {
    id: a.id,
    // A state a later server names reads as no longer asked.
    state: (STATES.has(String(a.state)) ? a.state : 'stopped') as ApprovalState['state'],
    answer: a.answer === 'approve' || a.answer === 'reject' ? a.answer : null,
    comment: typeof a.comment === 'string' ? a.comment : null,
    mode: a.mode === 'all' ? 'all' : 'any',
    deadlineAt: String(a.deadlineAt ?? ''),
    asked: Number(a.asked ?? 0),
    answered: Number(a.answered ?? 0),
  };
}

export function readNotification(value: unknown): NotificationDto | null {
  const n = value as Record<string, unknown>;
  if (!n || !KINDS.has(String(n.kind))) return null;
  // An approval with nothing to answer is no item.
  const approval = n.kind === 'approval' ? readApproval(n.approval) : null;
  if (n.kind === 'approval' && !approval) return null;
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
    automationName: (n.automationName as string | null | undefined) ?? null,
    reason: (n.reason as string | null | undefined) ?? null,
    approval,
    reminder: n.kind === 'reminder' ? readReminder(n.reminder) : null,
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
    answer: async (approvalId, answerGiven, comment) => {
      const result = await answer(
        api.POST('/api/v1/account/approvals/{approvalId}', {
          params: { path: { approvalId } },
          body: { answer: answerGiven, comment },
        }),
      );
      return readApproval(result) as ApprovalState;
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

  /**
   * Phase 17: an approval answered. The item shows the answer and is read once the server took it;
   * a refusal (decided meanwhile, past its deadline) reads the inbox again and rejects with its code.
   */
  async answer(id: Id, answer: 'approve' | 'reject', comment: string | null): Promise<void> {
    const item = this.state.items.find((n) => n.id === id);
    if (!item?.approval) return;
    try {
      const approval = await this.options.api.answer(item.approval.id, answer, comment);
      const at = (this.options.now?.() ?? new Date()).toISOString();
      this.set({
        items: this.state.items.map((n) =>
          n.id === id ? { ...n, approval, readAt: n.readAt ?? at } : n,
        ),
        unread: item.readAt ? this.state.unread : Math.max(0, this.state.unread - 1),
      });
    } catch (error) {
      if (this.options.unreachable(error)) this.set({ online: false });
      void this.load();
      throw error;
    }
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
