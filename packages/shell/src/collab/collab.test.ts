// Phase 6 in the shell: presence colours and their contrast, the people directory, presence on a
// page (others' cursors, expiry, this session left out, what is sent and how often) and in the
// sidebar, the comments store (refetch, optimistic writes, failures, offline), the composer's
// body, the panel's order and removed blocks, the inbox's read state, and the comments command
// with its shortcut on an Arabic layout. Component tests run in jsdom, with `createElement`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
// The routes read the address as a browser's globals; event targets are jsdom's, whose events
// they take (Node's own refuses them).
Object.assign(globalThis, {
  location: window.location,
  history: window.history,
  EventTarget: window.EventTarget,
});
const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { SyncHttpError } = await import('@cgw/workspace');
const { createI18n } = await import('../i18n');
const { CommandRegistry } = await import('../commands');
const { matchesShortcut, formatShortcut } = await import('../shortcuts');
const { colourIndex, colourOf, initialsOf, PRESENCE_COLOURS } = await import('./colour');
const { PeopleDirectory } = await import('./people');
const { PagePresence, TransportHub, WorkspacePresence, PRESENCE_TTL_MS, HEARTBEAT_MS } =
  await import('./presence');
const { CommentsStore, orderThreads } = await import('./comments');
const body = await import('./body');
const { InboxStore } = await import('./inbox');
const { Collab } = await import('./collab');
const { Composer, insertMention } = await import('./Composer');
const { CommentsPanel, levelOf } = await import('./CommentsPanel');
const { InboxView } = await import('./InboxView');
const { PresenceBar } = await import('./Avatars');
const { COMMENTS_SHORTCUT, registerCommentsCommand } = await import('./commands');
const { takeThreadRequest } = await import('./threads');
type PresenceTransport = import('./presence').PresenceTransport;
type PresenceMessage = import('./presence').PresenceMessage;
type TransportState = import('./presence').TransportState;
type CommentsApi = import('./comments').CommentsApi;
type ThreadDto = import('./comments').ThreadDto;
type CommentDto = import('./comments').CommentDto;
type NotificationsApi = import('./inbox').NotificationsApi;
type NotificationDto = import('./inbox').NotificationDto;
type CollabDeps = import('./collab').CollabDeps;
type WorkspaceSession = import('../session').WorkspaceSession;

const ADA = '01936f6e-0000-7000-8000-0000000000a1';
const BEN = '01936f6e-0000-7000-8000-0000000000b2';
const CY = '01936f6e-0000-7000-8000-0000000000c3';
const PAGE = '01936f6e-0000-7000-8000-00000000d001';
const OTHER_PAGE = '01936f6e-0000-7000-8000-00000000d002';
const WS = '01936f6e-0000-7000-8000-00000000e001';

const members = [
  { userId: ADA, displayName: 'Ada Lovelace', email: 'ada@example.com' },
  { userId: BEN, displayName: 'Ben Ali', email: 'ben@example.com' },
  { userId: CY, displayName: 'سلمى الإدريسي', email: 'salma@example.com' },
];

async function until(check: () => boolean, what = 'the condition') {
  for (let i = 0; i < 400 && !check(); i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

/** A transport the tests drive: what it was sent, and events they emit. */
function fakeTransport(state: TransportState = 'connected') {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const sent: { pageId: string; state: unknown }[] = [];
  const transport = {
    state,
    on(event: string, listener: (value: unknown) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return () => void listeners.get(event)!.delete(listener);
    },
    awareness(pageId: string, value: unknown) {
      sent.push({ pageId, state: value });
    },
    emit(event: string, value: unknown) {
      if (event === 'state') transport.state = value as TransportState;
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
    sent,
  };
  return transport;
}

const message = (
  presenceId: string,
  userId: string,
  state: PresenceMessage['state'],
  pageId = PAGE,
): PresenceMessage => ({ pageId, presenceId, userId, state });

const cursor = (anchor: string, head = anchor) => ({ anchor, head });

describe('presence colours', () => {
  it('are one of eight, the same for an id every time, and spread over ids', () => {
    expect(colourIndex(ADA)).toBe(colourIndex(ADA));
    expect(colourOf(ADA)).toBe(`var(--cgw-presence-${colourIndex(ADA)})`);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const index = colourIndex(`01936f6e-0000-7000-8000-${String(i).padStart(12, '0')}`);
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(PRESENCE_COLOURS);
      seen.add(index);
    }
    expect(seen.size).toBe(PRESENCE_COLOURS);
  });

  it('hold enough contrast in both themes', async () => {
    // The stylesheet as written (Vitest gives CSS modules no text); Node's own reader, named by a
    // variable so the package's types (DOM only) need not know it.
    const fs = 'node:fs';
    const { readFileSync } = (await import(/* @vite-ignore */ fs)) as {
      readFileSync(path: URL, encoding: 'utf8'): string;
    };
    const css = readFileSync(new URL('./collab.css', import.meta.url), 'utf8');
    const block = (selector: RegExp) => {
      const found = selector.exec(css);
      if (!found) throw new Error(`No block for ${selector}`);
      const text = css.slice(found.index, css.indexOf('}', found.index));
      const tokens = new Map(
        [...text.matchAll(/--cgw-presence-(\w+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]),
      );
      return tokens;
    };
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const themes = [
      // The library's surfaces (`--cg-surface`, `--cg-surface-subtle`, `--cg-page-bg`).
      {
        tokens: block(/:root,\s*\[data-cg-theme='light'\]\s*\{/),
        surfaces: ['#ffffff', '#f2f5fa', '#f4f6f9'],
      },
      {
        tokens: block(/\[data-cg-theme='dark'\]\s*\{/),
        surfaces: ['#151b24', '#1e2734', '#0f141c'],
      },
    ];
    for (const { tokens, surfaces } of themes) {
      const text = tokens.get('text')!;
      for (let i = 1; i <= PRESENCE_COLOURS; i++) {
        const colour = tokens.get(String(i))!;
        expect(colour, `--cgw-presence-${i}`).toMatch(/^#/);
        // Initials on the colour: text contrast.
        expect(contrast(colour, text), `${colour} with ${text}`).toBeGreaterThanOrEqual(4.5);
        // A cursor or ring of the colour beside the page: non-text contrast.
        for (const surface of surfaces)
          expect(contrast(colour, surface), `${colour} on ${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('give initials, one letter for a name in Arabic script', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('  ben ')).toBe('B');
    expect(initialsOf('سلمى الإدريسي')).toBe('س');
    expect(initialsOf('')).toBe('?');
  });
});

describe('the people directory', () => {
  it('finds people by name, a word of it or their address, folded, at most eight', async () => {
    const directory = new PeopleDirectory(WS, async () => [
      ...members,
      ...Array.from({ length: 12 }, (_, i) => ({
        userId: `u${i}`,
        displayName: `Zed ${i}`,
        email: `z${i}@example.com`,
      })),
    ]);
    await directory.refresh();
    expect(directory.search('ada').map((p) => p.id)).toEqual([ADA]);
    expect(directory.search('LOVE').map((p) => p.id)).toEqual([ADA]);
    expect(directory.search('ben@').map((p) => p.id)).toEqual([BEN]);
    // Arabic folded as search folds it (the hamza on the alef).
    expect(directory.search('الادريسي').map((p) => p.id)).toEqual([CY]);
    expect(directory.search('zed')).toHaveLength(8);
    expect(directory.name(BEN)).toBe('Ben Ali');
  });

  it('tells its listeners only when someone or a name changed, and asks again for one it does not know', async () => {
    let answer = members;
    const read = vi.fn(async () => answer);
    let now = 0;
    const directory = new PeopleDirectory(WS, read, () => now);
    await directory.refresh();
    const heard = vi.fn();
    directory.subscribe(heard);
    await directory.refresh();
    expect(heard).not.toHaveBeenCalled();
    answer = members.map((m) => (m.userId === BEN ? { ...m, displayName: 'Ben A.' } : m));
    await directory.refresh();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(directory.name(BEN)).toBe('Ben A.');
    const calls = read.mock.calls.length;
    now = 120_000;
    expect(directory.name('someone-new')).toBeUndefined();
    await until(() => read.mock.calls.length === calls + 1, 'a read for the unknown id');
    // Not again within the minute.
    directory.name('someone-new');
    expect(read.mock.calls.length).toBe(calls + 1);
  });
});

describe('presence on a page', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function setup(self = ADA) {
    const transport = fakeTransport();
    const hub = new TransportHub(() => transport as unknown as PresenceTransport);
    const people = new PeopleDirectory(WS, async () => members);
    await people.refresh();
    const store = new PagePresence({
      pageId: PAGE,
      hub,
      selfId: () => self,
      people,
      unknownName: () => 'Someone',
    });
    return { transport, hub, people, store };
  }

  it('shows the others’ cursors with names and colours from the directory, never this session', async () => {
    const { transport, store } = await setup();
    store.attach(7);
    transport.emit('awareness', message('p1', BEN, { clientId: 11, cursor: cursor('a') }));
    // This session's own state is not someone else's; the same person elsewhere is a cursor.
    transport.emit('awareness', message('p2', ADA, { clientId: 7, cursor: cursor('b') }));
    transport.emit('awareness', message('p3', ADA, { clientId: 8, cursor: cursor('c') }));
    // Another page's message is not this page's.
    transport.emit(
      'awareness',
      message('p4', CY, { clientId: 9, cursor: cursor('d') }, OTHER_PAGE),
    );
    expect(store.cursors().map((c) => [c.userId, c.name, c.anchor])).toEqual([
      [ADA, 'Ada Lovelace', 'c'],
      [BEN, 'Ben Ali', 'a'],
    ]);
    expect(store.cursors()[1].colour).toBe(colourOf(BEN));
    // The top bar: other people only, distinct.
    expect(store.people()).toEqual([BEN]);
  });

  it('drops an entry not heard from in 30 seconds, and one that says it left', async () => {
    const { transport, store } = await setup();
    transport.emit('awareness', message('p1', BEN, { clientId: 11, cursor: cursor('a') }));
    vi.advanceTimersByTime(20_000);
    transport.emit('awareness', message('p2', CY, { clientId: 12, cursor: null }));
    expect(store.people()).toEqual([BEN, CY]);
    vi.advanceTimersByTime(PRESENCE_TTL_MS - 20_000);
    expect(store.people()).toEqual([CY]);
    expect(store.cursors()).toEqual([]);
    transport.emit('awareness', message('p2', CY, null));
    expect(store.people()).toEqual([]);
  });

  it('tells the avatars only when someone comes or goes, the editor when a cursor moves', async () => {
    const { transport, store } = await setup();
    const avatars = vi.fn();
    const editor = vi.fn();
    store.subscribePeople(avatars);
    store.subscribe(editor);
    transport.emit('awareness', message('p1', BEN, { clientId: 11, cursor: cursor('a') }));
    const first = store.cursors();
    for (const at of ['b', 'c', 'd'])
      transport.emit('awareness', message('p1', BEN, { clientId: 11, cursor: cursor(at) }));
    expect(avatars).toHaveBeenCalledTimes(1);
    expect(editor).toHaveBeenCalledTimes(4);
    expect(store.cursors()).not.toBe(first);
    // The same state again: nothing changed, nobody told, the same array.
    const now = store.cursors();
    transport.emit('awareness', message('p1', BEN, { clientId: 11, cursor: cursor('d') }));
    expect(store.cursors()).toBe(now);
    expect(editor).toHaveBeenCalledTimes(4);
  });

  it('sends this session’s selection at most every 50 ms, again every 10 s, and null on leaving', async () => {
    const { transport, store } = await setup();
    store.attach(7);
    expect(transport.sent).toEqual([{ pageId: PAGE, state: { clientId: 7, cursor: null } }]);
    store.setLocal(cursor('a'));
    store.setLocal(cursor('b'));
    store.setLocal(cursor('c'));
    expect(transport.sent).toHaveLength(1);
    vi.advanceTimersByTime(50);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1].state).toEqual({ clientId: 7, cursor: cursor('c') });
    // Blurred: the cursor goes, the person stays on the page.
    vi.advanceTimersByTime(100);
    store.setLocal(null);
    expect(transport.sent[2].state).toEqual({ clientId: 7, cursor: null });
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(transport.sent).toHaveLength(4);
    store.detach();
    expect(transport.sent.at(-1)).toEqual({ pageId: PAGE, state: null });
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    expect(transport.sent).toHaveLength(5);
  });

  it('forgets the others when the connection goes, and says itself again when it comes back', async () => {
    const { transport, store } = await setup();
    store.attach(7);
    transport.emit('awareness', message('p1', BEN, { clientId: 11, cursor: cursor('a') }));
    transport.emit('state', 'disconnected');
    expect(store.people()).toEqual([]);
    const before = transport.sent.length;
    transport.emit('state', 'connected');
    vi.advanceTimersByTime(300);
    expect(transport.sent.length).toBe(before + 1);
  });

  it('waits for the page’s join before saying anything, as the hub takes it for joined pages only', async () => {
    const transport = fakeTransport();
    const hub = new TransportHub(() => transport as unknown as PresenceTransport);
    let joined = false;
    const store = new PagePresence({
      pageId: PAGE,
      hub,
      selfId: () => ADA,
      people: null,
      unknownName: () => 'Someone',
      joined: () => joined,
    });
    store.attach(7);
    store.setLocal(cursor('a'));
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(transport.sent).toEqual([]);
    joined = true;
    store.setJoined(true);
    expect(transport.sent).toEqual([{ pageId: PAGE, state: { clientId: 7, cursor: cursor('a') } }]);
    // Left (the connection went): nothing until it is joined again.
    store.setJoined(false);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(transport.sent).toHaveLength(1);
    store.dispose();
  });

  it('names someone the directory does not know with the fallback', async () => {
    const { transport, store } = await setup();
    transport.emit('awareness', message('p1', 'stranger', { clientId: 3, cursor: cursor('a') }));
    expect(store.cursors()[0].name).toBe('Someone');
  });
});

describe('presence in the sidebar', () => {
  it('keeps the others who have each page open, one array per page until it changes', () => {
    const transport = fakeTransport();
    const hub = new TransportHub(() => transport as unknown as PresenceTransport);
    const presence = new WorkspacePresence(hub, () => ADA);
    const heard = vi.fn();
    presence.subscribe(heard);
    transport.emit('pagePresence', { workspaceId: WS, pageId: PAGE, userIds: [ADA, BEN] });
    expect(presence.of(PAGE)).toEqual([BEN]);
    const kept = presence.of(PAGE);
    transport.emit('pagePresence', { workspaceId: WS, pageId: PAGE, userIds: [BEN, ADA] });
    expect(presence.of(PAGE)).toBe(kept);
    expect(heard).toHaveBeenCalledTimes(1);
    // Only this person there: nothing to show.
    transport.emit('pagePresence', { workspaceId: WS, pageId: OTHER_PAGE, userIds: [ADA] });
    expect(presence.of(OTHER_PAGE)).toEqual([]);
    // The join's answer replaces what was known of the workspace.
    presence.seed(WS, [{ pageId: OTHER_PAGE, userIds: [CY] }]);
    expect(presence.of(PAGE)).toEqual([]);
    expect(presence.of(OTHER_PAGE)).toEqual([CY]);
    transport.emit('state', 'disconnected');
    expect(presence.of(OTHER_PAGE)).toEqual([]);
  });
});

// Comments -------------------------------------------------------------------------------------------

const t0 = '2026-11-14T10:00:00.000Z';
const t1 = '2026-11-14T11:00:00.000Z';

function thread(id: string, over: Partial<ThreadDto> = {}): ThreadDto {
  return {
    id,
    pageId: PAGE,
    blockId: `block${id.slice(-7)}`.padEnd(12, 'x').slice(0, 12),
    anchor: { start: null, end: null },
    quote: `quote ${id}`,
    createdBy: { id: BEN, name: 'Ben Ali' },
    createdAt: t0,
    resolvedAt: null,
    resolvedBy: null,
    version: 1,
    comments: [
      {
        id: `${id}-c1`,
        threadId: id,
        author: { id: BEN, name: 'Ben Ali' },
        body: [{ type: 'text', text: `first of ${id}` }],
        createdAt: t0,
        editedAt: null,
      },
    ],
    ...over,
  };
}

/** The comment routes over a list the test holds, with hooks to hold or fail a call. */
function fakeComments(initial: ThreadDto[] = []) {
  const threads = new Map(initial.map((t) => [t.id, structuredClone(t)]));
  let gate: Promise<void> | null = null;
  let fail: unknown = null;
  const step = async () => {
    if (gate) await gate;
    if (fail) {
      const error = fail;
      fail = null;
      throw error;
    }
  };
  const api: CommentsApi = {
    list: vi.fn(async () => {
      await step();
      return [...threads.values()].map((t) => structuredClone(t));
    }),
    createThread: vi.fn(async (pageId, t) => {
      await step();
      const made: ThreadDto = {
        id: t.id,
        pageId,
        blockId: t.blockId,
        anchor: t.anchor,
        quote: t.quote,
        createdBy: { id: ADA, name: 'Ada Lovelace' },
        createdAt: t1,
        resolvedAt: null,
        resolvedBy: null,
        version: 1,
        comments: [
          {
            id: t.comment.id,
            threadId: t.id,
            author: { id: ADA, name: 'Ada Lovelace' },
            body: t.comment.body,
            createdAt: t1,
            editedAt: null,
          },
        ],
      };
      threads.set(t.id, made);
      return structuredClone(made);
    }),
    setResolved: vi.fn(async (threadId, resolved) => {
      await step();
      const t = threads.get(threadId)!;
      t.resolvedAt = resolved ? t1 : null;
      t.resolvedBy = resolved ? { id: ADA, name: 'Ada Lovelace' } : null;
      return structuredClone(t);
    }),
    reply: vi.fn(async (threadId, c) => {
      await step();
      const made: CommentDto = {
        id: c.id,
        threadId,
        author: { id: ADA, name: 'Ada Lovelace' },
        body: c.body,
        createdAt: t1,
        editedAt: null,
      };
      threads.get(threadId)!.comments.push(made);
      return structuredClone(made);
    }),
    edit: vi.fn(async (commentId, b) => {
      await step();
      for (const t of threads.values())
        for (const c of t.comments)
          if (c.id === commentId) {
            c.body = b;
            c.editedAt = t1;
            return structuredClone(c);
          }
      throw new SyncHttpError(404, 'not.found');
    }),
    remove: vi.fn(async (commentId) => {
      await step();
      for (const t of threads.values()) {
        if (t.comments[0]?.id === commentId) threads.delete(t.id);
        else t.comments = t.comments.filter((c) => c.id !== commentId);
      }
    }),
  };
  return {
    api,
    threads,
    hold() {
      let open!: () => void;
      gate = new Promise((resolve) => (open = resolve));
      return () => {
        gate = null;
        open();
      };
    },
    failNext(error: unknown) {
      fail = error;
    },
  };
}

const offlineError = () => new TypeError('Failed to fetch');
const unreachable = (error: unknown) => error instanceof TypeError;

function commentsStore(server: ReturnType<typeof fakeComments>, online = () => true) {
  return new CommentsStore({
    pageId: PAGE,
    api: server.api,
    online,
    self: () => ({ id: ADA, name: 'Ada Lovelace' }),
    unreachable,
  });
}

const text = (s: string) => [{ type: 'text' as const, text: s }];

describe('the comments store', () => {
  it('shows a new thread at once, then as the server has it, and reads the page again', async () => {
    const server = fakeComments([thread('t-1')]);
    const store = commentsStore(server);
    await store.load();
    const release = server.hold();
    const id = store.createThread(
      { blockId: 'blockAAAAAAA', start: 'rA', end: 'rB', quote: 'hello' },
      text('Looks good'),
    )!;
    const pending = store.snapshot().threads.find((t) => t.id === id)!;
    expect(pending.state).toBe('pending');
    expect(pending.comments[0].author.id).toBe(ADA);
    expect(store.editorThreads().map((t) => t.id)).toContain(id);
    release();
    await until(() => store.snapshot().threads.find((t) => t.id === id)?.state === 'saved');
    await until(() => (server.api.list as ReturnType<typeof vi.fn>).mock.calls.length >= 2);
    expect(store.snapshot().threads.map((t) => t.id)).toEqual(['t-1', id]);
    expect(store.snapshot().threads[1].comments[0].createdAt).toBe(t1);
  });

  it('shows only the newest read: one that started before a write was answered is dropped', async () => {
    const server = fakeComments([thread('t-1')]);
    const store = commentsStore(server);
    await store.load();
    const release = server.hold();
    const stale = store.load();
    server.threads.set('t-2', thread('t-2'));
    const fresh = store.load();
    release();
    await Promise.all([stale, fresh]);
    expect(store.snapshot().threads.map((t) => t.id)).toEqual(['t-1', 't-2']);
  });

  it('keeps a reply the server did not take, marked, to send again or discard', async () => {
    const server = fakeComments([thread('t-1')]);
    const store = commentsStore(server);
    await store.load();
    server.failNext(new SyncHttpError(403, 'access.denied'));
    store.reply('t-1', text('One more'));
    await until(() => store.snapshot().threads[0].comments[1]?.state === 'failed');
    const failed = store.snapshot().threads[0].comments[1];
    expect(failed.error).toBe('access.denied');
    store.retry(failed.opId!);
    await until(() => store.snapshot().threads[0].comments[1]?.state === 'saved');
    expect(server.threads.get('t-1')!.comments).toHaveLength(2);
    server.failNext(offlineError());
    store.reply('t-1', text('And another'));
    await until(() => store.snapshot().threads[0].comments[2]?.state === 'failed');
    expect(store.snapshot().threads[0].comments[2].error).toBe('offline');
    store.discard(store.snapshot().threads[0].comments[2].opId!);
    expect(store.snapshot().threads[0].comments).toHaveLength(2);
  });

  it('edits, deletes (the first comment takes its thread) and resolves, each at once', async () => {
    const server = fakeComments([
      thread('t-1'),
      thread('t-2', {
        comments: [
          ...thread('t-2').comments,
          {
            id: 't-2-c2',
            threadId: 't-2',
            author: { id: ADA, name: 'Ada' },
            body: text('mine'),
            createdAt: t1,
            editedAt: null,
          },
        ],
      }),
    ]);
    const store = commentsStore(server);
    await store.load();
    store.edit('t-2', 't-2-c2', text('mine, edited'));
    expect(store.snapshot().threads[1].comments[1].body).toEqual(text('mine, edited'));
    store.remove('t-1', 't-1-c1');
    expect(store.snapshot().threads.map((t) => t.id)).toEqual(['t-2']);
    store.setResolved('t-2', true);
    expect(store.snapshot().threads[0].resolvedAt).not.toBeNull();
    // Resolved threads are not drawn in the page.
    expect(store.editorThreads()).toEqual([]);
    await until(() => store.snapshot().threads.every((t) => t.state === 'saved'));
    await until(() => !server.threads.has('t-1') && !!server.threads.get('t-2')?.resolvedAt);
  });

  it('takes back a resolve the server refused, and says why', async () => {
    const server = fakeComments([thread('t-1')]);
    const store = commentsStore(server);
    await store.load();
    server.failNext(new SyncHttpError(403, 'access.denied'));
    store.setResolved('t-1', true);
    await until(() => !!store.snapshot().lastFailure);
    expect(store.snapshot().lastFailure).toEqual({ kind: 'resolve', code: 'access.denied' });
    expect(store.snapshot().threads[0].resolvedAt).toBeNull();
  });

  it('keeps what it showed when offline, and reads again when the connection comes back', async () => {
    const server = fakeComments([thread('t-1')]);
    let online = true;
    const store = commentsStore(server, () => online);
    await store.load();
    online = false;
    server.threads.set('t-2', thread('t-2'));
    await store.load();
    expect(store.snapshot().online).toBe(false);
    expect(store.snapshot().threads.map((t) => t.id)).toEqual(['t-1']);
    online = true;
    store.setOnline(true);
    await until(() => store.snapshot().threads.length === 2);
  });

  it('gives the editor the open threads with the selected one active, the same array until they change', async () => {
    const server = fakeComments([thread('t-1'), thread('t-2', { resolvedAt: t1 })]);
    const store = commentsStore(server);
    const heard = vi.fn();
    store.subscribeEditor(heard);
    await store.load();
    expect(store.editorThreads().map((t) => [t.id, t.active])).toEqual([['t-1', false]]);
    const list = store.editorThreads();
    await store.load();
    expect(store.editorThreads()).toBe(list);
    store.setActive('t-1');
    expect(store.editorThreads()[0].active).toBe(true);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('asks nothing about a page made here until the server holds it, then reads it and sends what waited', async () => {
    const server = fakeComments([]);
    let held = false;
    const joins = new Set<(pageId: string, joined: boolean) => void>();
    const events = new Set<(event: { kind: string; pageId?: string }) => void>();
    const collab = new Collab({
      self: () => ({ id: ADA, name: 'Ada Lovelace' }),
      online: () => true,
      onStatus: () => () => {},
      members: async () => members,
      onEvent: (listener) => {
        events.add(listener);
        return () => void events.delete(listener);
      },
      transport: () => null,
      onJoined: (listener) => {
        joins.add(listener);
        return () => void joins.delete(listener);
      },
      serverHolds: async () => held,
      comments: server.api,
      notifications: {
        list: async () => ({ notifications: [], unread: 0, next: null }),
        read: async () => ({ unread: 0 }),
      },
      unreachable,
      unknownName: () => 'Someone',
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    const store = collab.commentsFor(PAGE);
    await until(() => store.snapshot().loaded);
    // Its comments there are none; nothing was asked (a 404 is a console error in a browser).
    expect(store.snapshot().threads).toEqual([]);
    expect(server.api.list).not.toHaveBeenCalled();
    const id = store.createThread(
      { blockId: 'blockAAAAAAA', start: null, end: null, quote: '' },
      text('Early'),
    )!;
    await settle();
    expect(server.api.createThread).not.toHaveBeenCalled();
    expect(store.snapshot().threads[0]).toMatchObject({ id, state: 'pending' });
    // The mirror read again while the page is still not on the server: still nothing asked.
    for (const listener of events) listener({ kind: 'mirror' });
    await settle();
    expect(server.api.list).not.toHaveBeenCalled();
    // Another page's join is not this one's.
    held = true;
    for (const listener of joins) listener(OTHER_PAGE, true);
    await settle();
    expect(server.api.list).not.toHaveBeenCalled();
    // Its own join: read, and the thread that waited is sent.
    for (const listener of joins) listener(PAGE, true);
    await until(() => store.snapshot().threads[0]?.state === 'saved');
    expect(server.api.createThread).toHaveBeenCalledTimes(1);
    expect(server.api.list).toHaveBeenCalled();
    expect(server.threads.has(id)).toBe(true);
    // A store for a page already on the server reads at once.
    const second = collab.commentsFor(OTHER_PAGE);
    await until(() =>
      (server.api.list as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === OTHER_PAGE),
    );
    second.dispose();
    store.dispose();
    collab.dispose();
  });

  it('reads a page made here on the mirror’s word once the server holds it', async () => {
    const server = fakeComments([]);
    let held = false;
    const events = new Set<(event: { kind: string }) => void>();
    const collab = new Collab({
      self: () => ({ id: ADA, name: 'Ada Lovelace' }),
      online: () => true,
      onStatus: () => () => {},
      members: async () => members,
      onEvent: (listener) => {
        events.add(listener);
        return () => void events.delete(listener);
      },
      transport: () => null,
      serverHolds: async () => held,
      comments: server.api,
      notifications: {
        list: async () => ({ notifications: [], unread: 0, next: null }),
        read: async () => ({ unread: 0 }),
      },
      unreachable,
      unknownName: () => 'Someone',
    });
    const store = collab.commentsFor(PAGE);
    await until(() => store.snapshot().loaded);
    expect(server.api.list).not.toHaveBeenCalled();
    held = true;
    for (const listener of events) listener({ kind: 'mirror' });
    await until(() => (server.api.list as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    store.dispose();
    collab.dispose();
  });

  it('is read again when the feed says the page’s comments changed', async () => {
    const server = fakeComments([thread('t-1')]);
    const events = new Set<(event: { kind: string; pageId?: string }) => void>();
    const deps: CollabDeps = {
      self: () => ({ id: ADA, name: 'Ada Lovelace' }),
      online: () => true,
      onStatus: () => () => {},
      members: async () => members,
      onEvent: (listener) => {
        events.add(listener);
        return () => void events.delete(listener);
      },
      transport: () => null,
      comments: server.api,
      notifications: {
        list: async () => ({ notifications: [], unread: 0, next: null }),
        read: async () => ({ unread: 0 }),
      },
      unreachable,
      unknownName: () => 'Someone',
    };
    const collab = new Collab(deps);
    const store = collab.commentsFor(PAGE);
    await until(() => store.snapshot().loaded);
    server.threads.set('t-2', thread('t-2'));
    for (const listener of events) listener({ kind: 'comments', pageId: OTHER_PAGE });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.snapshot().threads).toHaveLength(1);
    for (const listener of events) listener({ kind: 'comments', pageId: PAGE });
    await until(() => store.snapshot().threads.length === 2);
    store.dispose();
    collab.dispose();
  });
});

describe('the routes', () => {
  it('are called as the contract has them, and their answers read', async () => {
    const { createApi } = await import('@cgw/api');
    const { commentsApi } = await import('./comments');
    const { notificationsApi } = await import('./inbox');
    const seen: { method: string; url: string; body: unknown }[] = [];
    const answers: unknown[] = [];
    const api = createApi({
      baseUrl: 'http://127.0.0.1:5280',
      auth: { kind: 'bearer', token: async () => 'test-token' },
      fetch: async (input: RequestInfo | URL) => {
        const request = input as Request;
        const text = await request.text();
        seen.push({
          method: request.method,
          url: request.url,
          body: text ? JSON.parse(text) : null,
        });
        const next = answers.shift();
        return next === 204
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify(next), {
              status: next && typeof next === 'object' && 'code' in next ? 403 : 200,
              headers: { 'Content-Type': 'application/json' },
            });
      },
    });
    const comments = commentsApi(api);
    answers.push({ threads: [{ ...thread('t-1'), version: '3' }] });
    const [listed] = await comments.list(PAGE);
    expect(listed.version).toBe(3);
    expect(seen[0]).toMatchObject({
      method: 'GET',
      url: `http://127.0.0.1:5280/api/v1/pages/${PAGE}/comments/threads?state=all`,
    });
    answers.push(thread('t-2'));
    await comments.createThread(PAGE, {
      id: 't-2',
      blockId: 'blockAAAAAAA',
      anchor: { start: null, end: null },
      quote: '',
      comment: { id: 'c', body: text('x') },
    });
    expect(seen[1]).toMatchObject({
      method: 'POST',
      body: { id: 't-2', comment: { id: 'c', body: text('x') } },
    });
    answers.push({ code: 'access.denied', title: 'No' });
    await expect(comments.setResolved('t-2', true)).rejects.toMatchObject({
      status: 403,
      code: 'access.denied',
    });
    expect(seen[2]).toMatchObject({
      method: 'PATCH',
      url: 'http://127.0.0.1:5280/api/v1/comments/threads/t-2',
      body: { resolved: true },
    });
    answers.push(204);
    await comments.remove('c');
    expect(seen[3]).toMatchObject({
      method: 'DELETE',
      url: 'http://127.0.0.1:5280/api/v1/comments/c',
    });

    const notifications = notificationsApi(api);
    answers.push({
      notifications: [note('n1'), { ...note('n2'), kind: 'later' }],
      unread: '1',
      next: 'x',
    });
    const page = await notifications.list({ unread: true, after: 'abc' });
    // A kind this build does not know is left out.
    expect(page).toMatchObject({ unread: 1, next: 'x', notifications: [{ id: 'n1' }] });
    expect(seen[4].url).toBe(
      'http://127.0.0.1:5280/api/v1/account/notifications?limit=50&unread=true&after=abc',
    );
    answers.push({ unread: 0 });
    await notifications.read({ ids: ['n1'] });
    expect(seen[5]).toMatchObject({ method: 'POST', body: { ids: ['n1'], all: null } });
  });
});

describe('the export’s Markdown', () => {
  it('writes a mentioned person’s name from the workspace’s people, else "@" alone', async () => {
    const { MemoryStore } = await import('@cgw/workspace');
    const { build } = await import('@cgw/doc');
    const { WorkspaceSession } = await import('../session');
    const { buildExport } = await import('../exchange/exchange');
    const session = await WorkspaceSession.start(new MemoryStore());
    const { shared } = await session.createWorkspace('W', { shared: 'S', private: 'P' });
    await session.createPage(
      { sectionId: shared.id, parentPageId: null, title: 'Notes' },
      build.docOf(build.paragraph('Ask ', build.userMention(BEN), ' and ', build.userMention(CY))),
    );
    const markdown = async (options: object) => {
      const { files } = await buildExport(session, { untitled: 'Untitled', ...options });
      const file = Object.keys(files).find((name) => name.endsWith('Notes.md'))!;
      return new TextDecoder().decode(files[file]);
    };
    const people = new PeopleDirectory(WS, async () => members);
    await people.refresh();
    expect(await markdown({ userName: people.name })).toContain('Ask @Ben Ali and @سلمى الإدريسي');
    // Without a directory, the database host's names; without either, "@" alone.
    expect(await markdown({ people: { [BEN]: 'Ben' } })).toContain('Ask @Ben and @');
    expect(await markdown({})).toContain('Ask @ and @');
    await session.close();
  });
});

describe('the panel’s order', () => {
  it('lists open threads as the page reads, those on removed blocks after, marked', () => {
    const server = [thread('t-1'), thread('t-2'), thread('t-3'), thread('t-4')].map((t) => ({
      ...t,
      state: 'saved' as const,
      comments: t.comments.map((c) => ({ ...c, state: 'saved' as const })),
    }));
    const ordered = orderThreads(server, [
      { threadId: 't-1', found: 'missing', pos: null },
      { threadId: 't-2', found: 'quote', pos: 40 },
      { threadId: 't-3', found: 'range', pos: 5 },
    ]);
    expect(ordered.map((o) => [o.thread.id, o.removed])).toEqual([
      ['t-3', false],
      ['t-2', false],
      // Not seen by the editor yet (made a moment ago): after the placed ones, not marked.
      ['t-4', false],
      ['t-1', true],
    ]);
    // Without the editor's places: as they were made.
    expect(orderThreads(server, null).map((o) => o.thread.id)).toEqual([
      't-1',
      't-2',
      't-3',
      't-4',
    ]);
  });
});

describe('a comment’s body', () => {
  it('is read from the composer: text, line breaks a browser made, mentions; trimmed and merged', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '  Hi <span data-user-id="u1" contenteditable="false">@Ada</span> see ' +
      '<span data-page-id="p1" contenteditable="false">Budget</span><div><br></div><div><b>bold</b>' +
      String.fromCharCode(160) +
      'line</div>a<br>b<br><br>';
    expect(body.bodyFromElement(root)).toEqual([
      { type: 'text', text: 'Hi ' },
      { type: 'userMention', attrs: { userId: 'u1' } },
      { type: 'text', text: ' see ' },
      { type: 'pageMention', attrs: { pageId: 'p1' } },
      { type: 'hardBreak' },
      { type: 'hardBreak' },
      { type: 'text', text: 'bold line' },
      { type: 'hardBreak' },
      { type: 'text', text: 'a' },
      { type: 'hardBreak' },
      { type: 'text', text: 'b' },
    ]);
  });

  it('holds text without line breaks inside, and keeps to the limits', () => {
    expect(body.normaliseBody([{ type: 'text', text: 'a\r\nb\n' }])).toEqual([
      { type: 'text', text: 'a' },
      { type: 'hardBreak' },
      { type: 'text', text: 'b' },
    ]);
    expect(body.bodyProblem([])).toBe('empty');
    expect(body.bodyProblem([{ type: 'text', text: '   ' }])).toBe('empty');
    expect(body.bodyProblem([{ type: 'userMention', attrs: { userId: ADA } }])).toBeNull();
    expect(body.bodyProblem(text('x'.repeat(4000)))).toBeNull();
    expect(body.bodyProblem(text('x'.repeat(4001)))).toBe('tooLong');
    const many = Array.from({ length: 51 }, () => ({
      type: 'userMention' as const,
      attrs: { userId: ADA },
    }));
    expect(body.bodyProblem(many)).toBe('tooManyMentions');
    // What the server sends is kept to the shape this build draws.
    expect(
      body.readBody([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'hardBreak' }]),
    ).toEqual([{ type: 'text', text: 'a' }, { type: 'hardBreak' }]);
  });

  it('finds the "@" being typed', () => {
    expect(body.mentionQueryAt('Hi @ad', 6)).toEqual({ query: 'ad', start: 3 });
    expect(body.mentionQueryAt('@', 1)).toEqual({ query: '', start: 0 });
    expect(body.mentionQueryAt('mail a@b', 8)).toBeNull();
    expect(body.mentionQueryAt('Hi @ad more', 11)).toBeNull();
    expect(body.mentionQueryAt('مرحبا @سل', 9)).toEqual({ query: 'سل', start: 6 });
  });

  it('puts a mention where the "@" was typed', () => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    const node = document.createTextNode('Hi @ad');
    root.append(node);
    const range = document.createRange();
    range.setStart(node, 6);
    range.collapse(true);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    insertMention(root, { node, start: 3 }, { kind: 'user', id: ADA }, 'Ada Lovelace');
    expect(body.bodyFromElement(root)).toEqual([
      { type: 'text', text: 'Hi ' },
      { type: 'userMention', attrs: { userId: ADA } },
    ]);
    expect(root.textContent).toBe('Hi @Ada Lovelace ');
    root.remove();
  });
});

// The inbox ------------------------------------------------------------------------------------------

function note(id: string, over: Partial<NotificationDto> = {}): NotificationDto {
  return {
    id,
    kind: 'mention',
    workspaceId: WS,
    pageId: PAGE,
    pageTitle: 'Budget',
    blockId: 'blockAAAAAAA',
    threadId: null,
    commentId: null,
    actor: { id: BEN, name: 'Ben Ali' },
    excerpt: 'Please look at @Ada',
    createdAt: t0,
    readAt: null,
    ...over,
  };
}

function fakeNotifications(items: NotificationDto[]) {
  const list = items.map((n) => ({ ...n }));
  const unread = () => list.filter((n) => !n.readAt).length;
  const api: NotificationsApi = {
    list: vi.fn(async ({ unread: only, after }) => {
      const shown = list.filter((n) => !only || !n.readAt);
      const start = after ? Number(after) : 0;
      const page = shown.slice(start, start + 2);
      return {
        notifications: page.map((n) => ({ ...n })),
        unread: unread(),
        next: start + 2 < shown.length ? String(start + 2) : null,
      };
    }),
    read: vi.fn(async ({ ids, all }) => {
      for (const n of list) if (all || ids?.includes(n.id)) n.readAt ??= t1;
      return { unread: unread() };
    }),
  };
  return { api, list };
}

describe('the inbox', () => {
  it('reads its first page and the unread count, and more on asking', async () => {
    const server = fakeNotifications([note('n1'), note('n2'), note('n3', { readAt: t0 })]);
    const inbox = new InboxStore({
      api: server.api,
      online: () => true,
      signedIn: () => true,
      unreachable,
    });
    await inbox.load();
    expect(inbox.snapshot().items.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(inbox.unread()).toBe(2);
    await inbox.loadMore();
    expect(inbox.snapshot().items.map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
    expect(inbox.snapshot().next).toBeNull();
  });

  it('marks one read at once, then takes the server’s count; and all of them', async () => {
    const server = fakeNotifications([note('n1'), note('n2')]);
    const inbox = new InboxStore({
      api: server.api,
      online: () => true,
      signedIn: () => true,
      unreachable,
    });
    await inbox.load();
    inbox.markRead('n1');
    expect(inbox.unread()).toBe(1);
    expect(inbox.snapshot().items[0].readAt).not.toBeNull();
    await until(() => (server.api.read as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    expect(server.api.read).toHaveBeenCalledWith({ ids: ['n1'] });
    inbox.markAllRead();
    expect(inbox.unread()).toBe(0);
    expect(inbox.snapshot().items.every((n) => n.readAt)).toBe(true);
    await until(() => server.list.every((n) => n.readAt));
  });

  it('is empty signed out, and keeps what it showed offline', async () => {
    const server = fakeNotifications([note('n1')]);
    let signedIn = true;
    let online = true;
    const inbox = new InboxStore({
      api: server.api,
      online: () => online,
      signedIn: () => signedIn,
      unreachable,
    });
    await inbox.load();
    online = false;
    await inbox.load();
    expect(inbox.snapshot()).toMatchObject({ online: false, unread: 1 });
    signedIn = false;
    await inbox.load();
    expect(inbox.snapshot().items).toEqual([]);
    expect(inbox.unread()).toBe(0);
  });
});

// The interface -------------------------------------------------------------------------------------

const roots: { unmount(): void }[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function render(node: ReturnType<typeof h>, language: 'en' | 'ar' = 'en') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const i18n = createI18n(language);
  act(() => root.render(h(I18nextProvider, { i18n }, node)));
  return container;
}

const fakeSession = (over: Record<string, unknown> = {}) =>
  ({
    workspaceId: WS,
    mirror: {
      pages: new Map([
        [PAGE, { id: PAGE, title: 'Budget', icon: null, workspaceId: WS, trashedAt: null }],
        [
          OTHER_PAGE,
          { id: OTHER_PAGE, title: 'Plans', icon: '📌', workspaceId: WS, trashedAt: null },
        ],
      ]),
      rowRecords: new Map(),
      workspaces: new Map([[WS, { id: WS, localOnly: false }]]),
      subscribe: () => () => {},
    },
    switchTo: vi.fn(),
    ...over,
  }) as unknown as WorkspaceSession;

const fakeDoc = () => ({ doc: { on: () => {}, off: () => {} } }) as never;

describe('the comments panel', () => {
  it('lists threads as the page reads, marks removed blocks, and keeps resolved ones behind a toggle', async () => {
    const server = fakeComments([
      thread('t-1', { quote: 'gone text' }),
      thread('t-2', { quote: 'second' }),
      thread('t-3', { quote: 'first' }),
      thread('t-4', { quote: 'done', resolvedAt: t1, resolvedBy: { id: BEN, name: 'Ben Ali' } }),
    ]);
    const store = commentsStore(server);
    await store.load();
    const people = new PeopleDirectory(WS, async () => members);
    await people.refresh();
    const editor = {
      editor: { isDestroyed: false, commands: { focus: vi.fn() } },
      anchorsInOrder: () => [
        { threadId: 't-1', found: 'missing', pos: null },
        { threadId: 't-2', found: 'range', pos: 30 },
        { threadId: 't-3', found: 'range', pos: 2 },
      ],
      scrollToThread: vi.fn(),
    };
    const onClose = vi.fn();
    const container = render(
      h(CommentsPanel, {
        store,
        people,
        session: fakeSession(),
        page: { id: PAGE, workspaceId: WS, kind: 'page', access: 'comment' } as never,
        level: 'comment',
        selfId: ADA,
        editor: editor as never,
        doc: fakeDoc(),
        draft: null,
        onDraftDone: () => {},
        focusRequest: null,
        onClose,
      }),
    );
    const quotes = () =>
      [...container.querySelectorAll('.cgw-thread-list:not(.is-resolved) [data-thread-id]')].map(
        (el) => el.getAttribute('data-thread-id'),
      );
    expect(quotes()).toEqual(['t-3', 't-2', 't-1']);
    const removed = container.querySelector(
      '[data-thread-id="t-1"] [data-testid="thread-removed"]',
    );
    expect(removed?.textContent).toBe('On a block that was removed');
    expect(container.querySelector('[data-thread-id="t-4"]')).toBeNull();
    // The panel's heading has focus when it opens.
    expect(document.activeElement?.id).toBe('cgw-comments-title');
    const toggle = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Resolved'),
    )!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    act(() => toggle.click());
    expect(container.querySelector('[data-thread-id="t-4"]')?.textContent).toContain(
      'Resolved by Ben Ali',
    );
    // A quote shows its place in the page.
    act(() =>
      (container.querySelector('[data-thread-id="t-2"] .cgw-thread-quote') as HTMLElement).click(),
    );
    expect(editor.scrollToThread).toHaveBeenCalledWith('t-2');
    expect(store.activeThread).toBe('t-2');
    // Resolving moves focus to the next thread.
    const resolve = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-thread-id="t-2"] button'),
    ].find((b) => b.textContent === 'Resolve')!;
    act(() => resolve.click());
    expect(document.activeElement?.getAttribute('data-thread-id')).toBe('t-1');
    // Escape closes the panel.
    act(() =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('says comments need a connection offline, keeping what it showed, and offers no writes', async () => {
    const server = fakeComments([thread('t-1')]);
    let online = true;
    const store = commentsStore(server, () => online);
    await store.load();
    online = false;
    store.setOnline(false);
    const container = render(
      h(CommentsPanel, {
        store,
        people: null,
        session: fakeSession(),
        page: { id: PAGE, workspaceId: WS, kind: 'page' } as never,
        level: 'full',
        selfId: ADA,
        editor: null,
        doc: fakeDoc(),
        draft: null,
        onDraftDone: () => {},
        focusRequest: null,
        onClose: () => {},
      }),
      'ar',
    );
    expect(container.querySelector('[data-testid="comments-offline"]')?.textContent).toBe(
      'التعليقات تحتاج إلى اتصال. هذه هي التي ظهرت آخر مرة كنت فيها متصلًا.',
    );
    expect(container.querySelector('[data-thread-id="t-1"]')).not.toBeNull();
    const labels = [...container.querySelectorAll('[data-thread-id="t-1"] button')].map(
      (b) => b.textContent,
    );
    expect(labels).not.toContain('ردّ');
    expect(labels).not.toContain('حلّ');
  });

  it('starts a thread from the editor’s "Comment": the composer has focus, sending makes it', async () => {
    const server = fakeComments([]);
    const store = commentsStore(server);
    await store.load();
    const onDraftDone = vi.fn();
    const container = render(
      h(CommentsPanel, {
        store,
        people: null,
        session: fakeSession(),
        page: { id: PAGE, workspaceId: WS, kind: 'page' } as never,
        level: 'comment',
        selfId: ADA,
        editor: null,
        doc: fakeDoc(),
        draft: { blockId: 'blockAAAAAAA', start: 'rA', end: 'rB', quote: 'the plan' },
        onDraftDone,
        focusRequest: null,
        onClose: () => {},
      }),
    );
    const draft = container.querySelector('[data-testid="comment-draft"]')!;
    expect(draft.querySelector('blockquote')?.textContent).toBe('the plan');
    const area = draft.querySelector<HTMLElement>('[role="textbox"]')!;
    expect(document.activeElement).toBe(area);
    area.append(document.createTextNode('Is this right?'));
    act(() => area.dispatchEvent(new Event('input', { bubbles: true })));
    act(() =>
      area.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
      ),
    );
    expect(onDraftDone).toHaveBeenCalled();
    await until(() => server.threads.size === 1);
    const [made] = server.threads.values();
    expect(made).toMatchObject({ blockId: 'blockAAAAAAA', anchor: { start: 'rA', end: 'rB' } });
    expect(made.comments[0].body).toEqual(text('Is this right?'));
    expect(store.activeThread).toBe(made.id);
  });

  it('offers no "Comment" to someone who may only view', () => {
    expect(
      levelOf(
        { mirror: { pages: new Map() } } as unknown as WorkspaceSession,
        { id: PAGE, kind: 'page', access: 'view' } as never,
      ),
    ).toBe('view');
    expect(
      levelOf(
        { mirror: { pages: new Map() } } as unknown as WorkspaceSession,
        { id: PAGE, kind: 'page' } as never,
      ),
    ).toBe('full');
  });
});

describe('the composer', () => {
  it('offers people and pages on "@", and sends the body with the mention', async () => {
    const people = new PeopleDirectory(WS, async () => members);
    await people.refresh();
    const onSubmit = vi.fn();
    const container = render(
      h(Composer, {
        label: 'New comment',
        placeholder: 'Add a comment…',
        submitLabel: 'Comment',
        people,
        pages: (q: string) =>
          'plans'.startsWith(q.toLowerCase())
            ? [{ id: OTHER_PAGE, title: 'Plans', icon: '📌' }]
            : [],
        personName: (id: string) => people.name(id) ?? '',
        pageTitle: () => 'Plans',
        onSubmit,
      }),
    );
    const area = container.querySelector<HTMLElement>('[role="textbox"]')!;
    const send = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Comment',
    )!;
    expect(send.disabled).toBe(true);
    const node = document.createTextNode('Thanks @be');
    area.append(node);
    const range = document.createRange();
    range.setStart(node, node.length);
    range.collapse(true);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    act(() => area.dispatchEvent(new Event('input', { bubbles: true })));
    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    expect(area.getAttribute('aria-controls')).toBe(listbox!.id);
    const options = [...container.querySelectorAll('[role="option"]')];
    expect(options.map((o) => o.textContent)).toEqual(['Ben Aliben@example.com']);
    expect(area.getAttribute('aria-activedescendant')).toBe(options[0].id);
    act(() => area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(area.querySelector('[data-user-id]')?.textContent).toBe('@Ben Ali');
    expect(send.disabled).toBe(false);
    act(() =>
      area.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
      ),
    );
    expect(onSubmit).toHaveBeenCalledWith([
      { type: 'text', text: 'Thanks ' },
      { type: 'userMention', attrs: { userId: BEN } },
    ]);
  });
});

describe('the inbox view', () => {
  it('lists notifications, opens one at its thread and marks it read, and marks all read', async () => {
    const server = fakeNotifications([
      note('n1', { kind: 'reply', threadId: 'th-1', commentId: 'c-9' }),
      note('n2', { kind: 'commentMention', readAt: t0 }),
    ]);
    const deps: CollabDeps = {
      self: () => ({ id: ADA, name: 'Ada Lovelace' }),
      online: () => true,
      onStatus: () => () => {},
      members: async () => members,
      onEvent: () => () => {},
      transport: () => null,
      comments: fakeComments().api,
      notifications: server.api,
      unreachable,
      unknownName: () => 'Someone',
    };
    const collab = new Collab(deps);
    await until(() => collab.inbox.snapshot().loaded);
    const container = render(h(InboxView, { collab, session: fakeSession() }));
    await until(() => !!container.querySelector('[data-testid="inbox-list"]'));
    await until(() => container.textContent!.includes('Ben Ali replied'));
    const items = [...container.querySelectorAll('.cgw-inbox-item')];
    expect(items.map((li) => li.classList.contains('is-unread'))).toEqual([true, false]);
    expect(items[0].textContent).toContain('Ben Ali replied in a thread on “Budget”');
    expect(items[0].textContent).toContain('Unread');
    act(() => (items[0].querySelector('a') as HTMLElement).click());
    expect(location.hash).toBe(`#/p/${PAGE}`);
    expect(takeThreadRequest(PAGE)).toBe('th-1');
    expect(collab.inbox.unread()).toBe(0);
    await until(() => server.list[0].readAt !== null);
    collab.dispose();
  });
});

describe('the top bar’s avatars', () => {
  it('name the others on the page', async () => {
    const transport = fakeTransport();
    const hub = new TransportHub(() => transport as unknown as PresenceTransport);
    const people = new PeopleDirectory(WS, async () => members);
    await people.refresh();
    const store = new PagePresence({
      pageId: PAGE,
      hub,
      selfId: () => ADA,
      people,
      unknownName: () => 'Someone',
    });
    const container = render(h(PresenceBar, { store, people }));
    expect(container.querySelector('[data-testid="presence-bar"]')).toBeNull();
    act(() => {
      transport.emit('awareness', message('p1', BEN, { clientId: 2, cursor: null }));
      transport.emit('awareness', message('p2', CY, { clientId: 3, cursor: cursor('x') }));
    });
    const bar = container.querySelector('[data-testid="presence-bar"]')!;
    expect(bar.getAttribute('aria-label')).toBe('People on this page: 2');
    expect(
      [...bar.querySelectorAll('[role="img"]')].map((el) => el.getAttribute('aria-label')),
    ).toEqual(['Ben Ali', 'سلمى الإدريسي']);
    store.dispose();
  });
});

describe('the comments command', () => {
  it('runs on its shortcut by key position, so an Arabic layout gives the same chord', () => {
    const registry = new CommandRegistry();
    const toggle = vi.fn();
    const i18n = createI18n('en');
    const off = registerCommentsCommand(registry as never, i18n.t, toggle);
    // On an Arabic layout KeyM types "ة"; the code is still KeyM.
    const event = new KeyboardEvent('keydown', {
      key: 'ة',
      code: 'KeyM',
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      cancelable: true,
    });
    expect(matchesShortcut(event, COMMENTS_SHORTCUT, false)).toBe(true);
    expect(registry.handleKey(event, null)).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(formatShortcut(COMMENTS_SHORTCUT, false)).toBe('Ctrl+Alt+Shift+M');
    // Found in the palette by words in either language.
    expect(registry.list(null, 'تعليق').map((c) => c.id)).toEqual(['page.comments']);
    expect(registry.get('page.comments')!.label()).toBe('Show or hide comments');
    off();
    expect(registry.get('page.comments')).toBeUndefined();
  });
});
