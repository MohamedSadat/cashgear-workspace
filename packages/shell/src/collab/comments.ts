// Comments (contract section 3), online only (DECISIONS.md, 2026-11-14: Phase 6): a page's
// threads read from the server when the page opens, again when the feed says its comments changed
// and after each write. Writes show at once and are kept, marked, when the server does not take
// them, so nothing typed is lost; offline the store keeps what it last showed. Nothing is stored
// on this device. The editor host's `comments` (contract section 6) reads the open threads here.
import type { ApiClient } from '@cgw/api';
import { SyncHttpError, uuidv7, type Id } from '@cgw/workspace';
import { readBody, type CommentBody } from './body';

export interface PersonRef {
  id: Id;
  name: string;
}

export interface CommentAnchor {
  start: string | null;
  end: string | null;
}

export interface CommentDto {
  id: Id;
  threadId: Id;
  author: PersonRef;
  body: CommentBody;
  createdAt: string;
  editedAt: string | null;
}

export interface ThreadDto {
  id: Id;
  pageId: Id;
  blockId: string;
  anchor: CommentAnchor;
  quote: string;
  createdBy: PersonRef;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: PersonRef | null;
  version: number;
  comments: CommentDto[];
}

export interface NewThread {
  id: Id;
  blockId: string;
  anchor: CommentAnchor;
  quote: string;
  comment: { id: Id; body: CommentBody };
}

/** The comment routes (contract section 3). */
export interface CommentsApi {
  /** Every thread of the page, open and resolved, by `createdAt`. */
  list(pageId: Id): Promise<ThreadDto[]>;
  createThread(pageId: Id, thread: NewThread): Promise<ThreadDto>;
  setResolved(threadId: Id, resolved: boolean): Promise<ThreadDto>;
  reply(threadId: Id, comment: { id: Id; body: CommentBody }): Promise<CommentDto>;
  edit(commentId: Id, body: CommentBody): Promise<CommentDto>;
  remove(commentId: Id): Promise<void>;
}

type Answer<T> = { data?: T; error?: unknown; response: Response };

/** The answer's data, or a SyncHttpError with the server's code. */
export async function answer<T>(request: Promise<Answer<T>>): Promise<T> {
  const result = await request;
  if (result.response.ok) return result.data as T;
  const body = result.error as { code?: string; title?: string } | undefined;
  const retry = Number(result.response.headers?.get?.('Retry-After'));
  throw new SyncHttpError(
    result.response.status,
    body?.code ?? 'server.error',
    body?.title ?? result.response.statusText,
    Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined,
  );
}

const person = (value: unknown): PersonRef => {
  const p = value as { id?: unknown; name?: unknown } | null;
  return { id: String(p?.id ?? ''), name: String(p?.name ?? '') };
};

export function readComment(value: unknown): CommentDto {
  const c = value as Record<string, unknown>;
  return {
    id: String(c.id),
    threadId: String(c.threadId),
    author: person(c.author),
    body: readBody(c.body),
    createdAt: String(c.createdAt),
    editedAt: (c.editedAt as string | null | undefined) ?? null,
  };
}

export function readThread(value: unknown): ThreadDto {
  const t = value as Record<string, unknown>;
  const anchor = (t.anchor ?? {}) as Record<string, unknown>;
  return {
    id: String(t.id),
    pageId: String(t.pageId),
    blockId: String(t.blockId),
    anchor: {
      start: (anchor.start as string | null | undefined) ?? null,
      end: (anchor.end as string | null | undefined) ?? null,
    },
    quote: String(t.quote ?? ''),
    createdBy: person(t.createdBy),
    createdAt: String(t.createdAt),
    resolvedAt: (t.resolvedAt as string | null | undefined) ?? null,
    resolvedBy: t.resolvedBy ? person(t.resolvedBy) : null,
    version: Number(t.version ?? 0),
    comments: Array.isArray(t.comments) ? t.comments.map(readComment) : [],
  };
}

/** The comment routes over the app's API client (typed from the server's OpenAPI document). */
export function commentsApi(api: ApiClient): CommentsApi {
  return {
    list: async (pageId) =>
      (
        await answer(
          api.GET('/api/v1/pages/{pageId}/comments/threads', {
            params: { path: { pageId }, query: { state: 'all' } },
          }),
        )
      ).threads.map(readThread),
    createThread: async (pageId, thread) =>
      readThread(
        await answer(
          api.POST('/api/v1/pages/{pageId}/comments/threads', {
            params: { path: { pageId } },
            body: thread,
          }),
        ),
      ),
    setResolved: async (threadId, resolved) =>
      readThread(
        await answer(
          api.PATCH('/api/v1/comments/threads/{threadId}', {
            params: { path: { threadId } },
            body: { resolved },
          }),
        ),
      ),
    reply: async (threadId, comment) =>
      readComment(
        await answer(
          api.POST('/api/v1/comments/threads/{threadId}/comments', {
            params: { path: { threadId } },
            body: comment,
          }),
        ),
      ),
    edit: async (commentId, body) =>
      readComment(
        await answer(
          api.PATCH('/api/v1/comments/{commentId}', {
            params: { path: { commentId } },
            body: { body },
          }),
        ),
      ),
    remove: async (commentId) => {
      await answer(api.DELETE('/api/v1/comments/{commentId}', { params: { path: { commentId } } }));
    },
  };
}

// The store ---------------------------------------------------------------------------------------

export type WriteState = 'saved' | 'pending' | 'failed';

export interface CommentView extends CommentDto {
  state: WriteState;
  /** The write that made it pending or failed, for "Try again" and "Discard". */
  opId?: string;
  /** The server's code when it failed (`offline` when there was no answer). */
  error?: string;
}

export interface ThreadView extends Omit<ThreadDto, 'comments'> {
  comments: CommentView[];
  state: WriteState;
  opId?: string;
  error?: string;
}

export interface CommentsSnapshot {
  threads: ThreadView[];
  /** The first answer came (else the threads shown are none, or the last ones known). */
  loaded: boolean;
  /** The server can be reached; offline the threads are the ones last shown. */
  online: boolean;
  /** A refusal of the list itself (`access.denied`, say), else null. */
  error: string | null;
  /** A write that failed and was taken back (resolve, delete): its code, until the next write. */
  lastFailure: { kind: Op['kind']; code: string } | null;
}

/** What the editor draws (contract section 6, `comments.threads`). */
export interface EditorThread {
  id: Id;
  blockId: string;
  start: string | null;
  end: string | null;
  quote: string;
  active: boolean;
}

type Op = { opId: string; status: 'pending' | 'failed'; error?: string } & (
  | { kind: 'thread'; thread: ThreadDto }
  | { kind: 'reply'; comment: CommentDto }
  | { kind: 'edit'; threadId: Id; commentId: Id; body: CommentBody; editedAt: string }
  | { kind: 'delete'; threadId: Id; commentId: Id }
  | { kind: 'resolve'; threadId: Id; resolved: boolean; by: PersonRef; at: string }
);

export interface CommentsStoreOptions {
  pageId: Id;
  api: CommentsApi;
  /** Whether the server can be reached now. */
  online: () => boolean;
  /** The signed-in person (a write's author). */
  self: () => PersonRef | null;
  /** A failure that means "no answer" (offline, a network error, 5xx, 429). */
  unreachable: (error: unknown) => boolean;
  /**
   * Whether the server holds the page yet. A page made on this device is not there until its
   * first document push is taken: until then nothing is asked about it (the server would answer
   * 404, which a browser logs as an error), its comments are none, and writes wait. Asked again
   * on `recheck` (the page joined on the hub, the mirror read again). Absent: always.
   */
  serverHolds?: () => Promise<boolean>;
  now?: () => Date;
}

const codeOf = (error: unknown, unreachable: (e: unknown) => boolean) =>
  unreachable(error) ? 'offline' : error instanceof SyncHttpError ? error.code : 'server.error';

export class CommentsStore {
  readonly pageId: Id;
  private base = new Map<Id, ThreadDto>();
  private ops: Op[] = [];
  private loaded = false;
  private online: boolean;
  private error: string | null = null;
  private lastFailure: CommentsSnapshot['lastFailure'] = null;
  private generation = 0;
  private current: CommentsSnapshot;
  private editorList: EditorThread[] = [];
  private editorKey = '';
  private active: Id | null = null;
  /** The server holds the page (`serverHolds`); writes made before it does wait in `queued`. */
  private held: boolean;
  private readonly queued: Op[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly editorListeners = new Set<() => void>();
  private disposed = false;

  constructor(private readonly options: CommentsStoreOptions) {
    this.pageId = options.pageId;
    this.online = options.online();
    this.held = !options.serverHolds;
    this.current = this.build();
  }

  /** Whether the server holds the page; the first time it does, the writes that waited go. */
  private async holdsNow(): Promise<boolean> {
    if (this.held) return true;
    const held = (await this.options.serverHolds?.().catch(() => false)) ?? true;
    if (!held || this.held || this.disposed) return this.held;
    this.held = true;
    for (const op of this.queued.splice(0)) void this.send(op);
    return true;
  }

  /** The page may be on the server now (it was joined, the mirror was read again): read it then. */
  recheck() {
    if (!this.held && !this.disposed) void this.load();
  }

  private now() {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  /**
   * Reads the threads again. Only the newest read's answer is shown: one that started before a
   * write was answered could lack it. Offline, what was shown stays.
   */
  async load(): Promise<void> {
    if (this.disposed) return;
    if (!this.options.online()) {
      this.setOnline(false);
      return;
    }
    if (!(await this.holdsNow())) {
      // Made here and not on the server yet: it has no comments there to read.
      if (this.disposed || this.loaded) return;
      this.loaded = true;
      this.changed();
      return;
    }
    if (this.disposed) return;
    const generation = ++this.generation;
    try {
      const threads = await this.options.api.list(this.pageId);
      if (this.disposed || generation !== this.generation) return;
      this.base = new Map(threads.map((t) => [t.id, t]));
      this.loaded = true;
      this.online = true;
      this.error = null;
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      if (this.options.unreachable(error)) this.online = false;
      else this.error = codeOf(error, this.options.unreachable);
    }
    this.changed();
  }

  /** The connection came or went (the cloud's status): reads again when it comes back. */
  setOnline(online: boolean) {
    if (online === this.online) return;
    this.online = online;
    this.changed();
    if (online) void this.load();
  }

  snapshot = (): CommentsSnapshot => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  // The editor's part ----------------------------------------------------------------------------

  /** The open threads to draw, the selected one `active`; the same array until they change. */
  editorThreads = (): EditorThread[] => this.editorList;

  subscribeEditor = (listener: () => void): (() => void) => {
    this.editorListeners.add(listener);
    return () => void this.editorListeners.delete(listener);
  };

  get activeThread(): Id | null {
    return this.active;
  }

  setActive(threadId: Id | null) {
    if (threadId === this.active) return;
    this.active = threadId;
    this.changed();
  }

  // Writes -----------------------------------------------------------------------------------------

  /** A new thread on a block (and a range of it) with its first comment; returns its id. */
  createThread(
    anchor: { blockId: string; start: string | null; end: string | null; quote: string },
    body: CommentBody,
  ): Id | null {
    const self = this.options.self();
    if (!self) return null;
    const at = this.now();
    const id = uuidv7();
    const thread: ThreadDto = {
      id,
      pageId: this.pageId,
      blockId: anchor.blockId,
      anchor: { start: anchor.start, end: anchor.end },
      quote: anchor.quote.slice(0, 1000),
      createdBy: self,
      createdAt: at,
      resolvedAt: null,
      resolvedBy: null,
      version: 0,
      comments: [{ id: uuidv7(), threadId: id, author: self, body, createdAt: at, editedAt: null }],
    };
    this.run({ opId: uuidv7(), status: 'pending', kind: 'thread', thread });
    return id;
  }

  reply(threadId: Id, body: CommentBody): Id | null {
    const self = this.options.self();
    if (!self) return null;
    const comment: CommentDto = {
      id: uuidv7(),
      threadId,
      author: self,
      body,
      createdAt: this.now(),
      editedAt: null,
    };
    this.run({ opId: uuidv7(), status: 'pending', kind: 'reply', comment });
    return comment.id;
  }

  edit(threadId: Id, commentId: Id, body: CommentBody) {
    this.run({
      opId: uuidv7(),
      status: 'pending',
      kind: 'edit',
      threadId,
      commentId,
      body,
      editedAt: this.now(),
    });
  }

  /** Deletes a comment; the thread's first comment takes the thread with it (contract section 3). */
  remove(threadId: Id, commentId: Id) {
    this.run({ opId: uuidv7(), status: 'pending', kind: 'delete', threadId, commentId });
  }

  setResolved(threadId: Id, resolved: boolean) {
    const self = this.options.self();
    if (!self) return;
    this.run({
      opId: uuidv7(),
      status: 'pending',
      kind: 'resolve',
      threadId,
      resolved,
      by: self,
      at: this.now(),
    });
  }

  /** Sends a failed write again. */
  retry(opId: string) {
    const op = this.ops.find((o) => o.opId === opId);
    if (!op || op.status !== 'failed') return;
    op.status = 'pending';
    delete op.error;
    this.changed();
    void this.send(op);
  }

  /** Gives up a failed write: what it showed goes. */
  discard(opId: string) {
    const before = this.ops.length;
    this.ops = this.ops.filter((o) => o.opId !== opId || o.status !== 'failed');
    if (this.ops.length !== before) this.changed();
  }

  private run(op: Op) {
    this.ops.push(op);
    this.lastFailure = null;
    this.changed();
    void this.send(op);
  }

  private async send(op: Op) {
    const { api } = this.options;
    // A page not on the server yet: the write waits (shown as sending) until it is.
    if (!(await this.holdsNow())) {
      if (!this.queued.includes(op)) this.queued.push(op);
      return;
    }
    if (this.disposed || !this.ops.includes(op)) return;
    try {
      switch (op.kind) {
        case 'thread': {
          const t = op.thread;
          const saved = await api.createThread(this.pageId, {
            id: t.id,
            blockId: t.blockId,
            anchor: t.anchor,
            quote: t.quote,
            comment: { id: t.comments[0].id, body: t.comments[0].body },
          });
          this.base.set(saved.id, saved);
          break;
        }
        case 'reply': {
          const saved = await api.reply(op.comment.threadId, {
            id: op.comment.id,
            body: op.comment.body,
          });
          this.putComment(saved);
          break;
        }
        case 'edit':
          this.putComment(await api.edit(op.commentId, op.body));
          break;
        case 'delete': {
          await api.remove(op.commentId);
          const thread = this.base.get(op.threadId);
          if (thread?.comments[0]?.id === op.commentId) this.base.delete(op.threadId);
          else if (thread)
            this.base.set(thread.id, {
              ...thread,
              comments: thread.comments.filter((c) => c.id !== op.commentId),
            });
          break;
        }
        case 'resolve':
          this.base.set(op.threadId, await api.setResolved(op.threadId, op.resolved));
          break;
      }
      this.ops = this.ops.filter((o) => o !== op);
      this.online = true;
    } catch (error) {
      if (this.disposed) return;
      const code = codeOf(error, this.options.unreachable);
      if (code === 'offline') this.online = false;
      if (op.kind === 'delete' || op.kind === 'resolve') {
        // Nothing typed is lost: the change is taken back and the panel says why.
        this.ops = this.ops.filter((o) => o !== op);
        this.lastFailure = { kind: op.kind, code };
      } else {
        op.status = 'failed';
        op.error = code;
      }
    }
    if (this.disposed) return;
    this.changed();
    // The page's comments as the server has them now (another person's, the write's own).
    void this.load();
  }

  private putComment(saved: CommentDto) {
    const thread = this.base.get(saved.threadId);
    if (!thread) return;
    const at = thread.comments.findIndex((c) => c.id === saved.id);
    const comments =
      at >= 0 ? thread.comments.map((c, i) => (i === at ? saved : c)) : [...thread.comments, saved];
    this.base.set(thread.id, { ...thread, comments });
  }

  // What is shown ----------------------------------------------------------------------------------

  /** The server's threads with the writes not answered yet laid over them (each by id, once). */
  private view(): ThreadView[] {
    const threads = new Map<Id, ThreadView>();
    for (const t of this.base.values())
      threads.set(t.id, {
        ...t,
        state: 'saved',
        comments: t.comments.map((c) => ({ ...c, state: 'saved' })),
      });
    for (const op of this.ops) {
      const mark = { state: op.status, opId: op.opId, ...(op.error ? { error: op.error } : {}) };
      switch (op.kind) {
        case 'thread': {
          if (threads.has(op.thread.id)) break;
          threads.set(op.thread.id, {
            ...op.thread,
            ...mark,
            comments: op.thread.comments.map((c) => ({ ...c, ...mark })),
          });
          break;
        }
        case 'reply': {
          const thread = threads.get(op.comment.threadId);
          if (!thread || thread.comments.some((c) => c.id === op.comment.id)) break;
          thread.comments = [...thread.comments, { ...op.comment, ...mark }];
          break;
        }
        case 'edit': {
          const thread = threads.get(op.threadId);
          if (!thread) break;
          thread.comments = thread.comments.map((c) =>
            c.id === op.commentId ? { ...c, body: op.body, editedAt: op.editedAt, ...mark } : c,
          );
          break;
        }
        case 'delete': {
          const thread = threads.get(op.threadId);
          if (!thread) break;
          if (thread.comments[0]?.id === op.commentId) threads.delete(op.threadId);
          else thread.comments = thread.comments.filter((c) => c.id !== op.commentId);
          break;
        }
        case 'resolve': {
          const thread = threads.get(op.threadId);
          if (!thread) break;
          thread.resolvedAt = op.resolved ? op.at : null;
          thread.resolvedBy = op.resolved ? op.by : null;
          break;
        }
      }
    }
    return [...threads.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
    );
  }

  private build(): CommentsSnapshot {
    return {
      threads: this.view(),
      loaded: this.loaded,
      online: this.online,
      error: this.error,
      lastFailure: this.lastFailure,
    };
  }

  private changed() {
    if (this.disposed) return;
    this.current = this.build();
    const open = this.current.threads.filter((t) => !t.resolvedAt);
    const list = open.map((t): EditorThread => ({
      id: t.id,
      blockId: t.blockId,
      start: t.anchor.start,
      end: t.anchor.end,
      quote: t.quote,
      active: t.id === this.active,
    }));
    const key = list
      .map((t) => `${t.id}|${t.blockId}|${t.start}|${t.end}|${t.quote}|${t.active}`)
      .join('\n');
    if (key !== this.editorKey) {
      this.editorKey = key;
      this.editorList = list;
      for (const listener of this.editorListeners) listener();
    }
    for (const listener of this.listeners) listener();
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
    this.editorListeners.clear();
  }
}

// The panel's order --------------------------------------------------------------------------------

/** Where the editor found a thread's anchor (`anchorsInOrder()`, contract section 6). */
export interface AnchorPlace {
  threadId: string;
  found: 'range' | 'quote' | 'block' | 'missing';
  pos: number | null;
}

/**
 * The open threads as the page reads (by where the editor found them), those whose block is gone
 * after them, marked; without the editor's places (it is not there yet), by when they were made.
 * A thread the editor has not seen yet (made a moment ago) comes after the placed ones, unmarked.
 */
export function orderThreads(
  threads: ThreadView[],
  places: AnchorPlace[] | null,
): { thread: ThreadView; removed: boolean }[] {
  if (!places) return threads.map((thread) => ({ thread, removed: false }));
  const byId = new Map(places.map((p) => [p.threadId, p]));
  const rank = (t: ThreadView) => {
    const place = byId.get(t.id);
    if (!place) return { group: 1, pos: 0 };
    if (place.found === 'missing' || place.pos === null) return { group: 2, pos: 0 };
    return { group: 0, pos: place.pos };
  };
  return threads
    .map((thread, index) => ({ thread, index, ...rank(thread) }))
    .sort((a, b) => a.group - b.group || a.pos - b.pos || a.index - b.index)
    .map(({ thread, group }) => ({ thread, removed: group === 2 }));
}
