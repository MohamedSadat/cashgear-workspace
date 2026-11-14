// The comments panel beside the page (contract section 3): the open threads as the page reads,
// those on a block that was removed marked, the resolved ones behind a toggle; a thread's
// comments, replying, editing one's own, deleting one's own (or any, with full access), resolving
// and reopening. Offline it says comments need a connection and keeps what it last showed
// (DECISIONS.md, 2026-11-14: Phase 6). The server decides every write; the controls only follow
// the person's level on the page.
import type { PageDocument } from '@cgw/doc';
import type { BlockEditor } from '@cgw/editor';
import type { Id } from '@cgw/workspace';
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { routeHash } from '../route';
import { isRowRecord, type AnyPage, type WorkspaceSession } from '../session';
import { Avatar } from './Avatars';
import type { CommentBody } from './body';
import {
  orderThreads,
  type AnchorPlace,
  type CommentView,
  type CommentsStore,
  type ThreadView,
} from './comments';
import { Composer, type ComposerHandle } from './Composer';
import type { PeopleDirectory } from './people';

export type Level = 'full' | 'edit' | 'comment' | 'view';

/** The person's level on a page as the mirror has it (a row's is its database's). */
export function levelOf(session: WorkspaceSession, page: AnyPage): Level {
  const holder = isRowRecord(page) ? session.mirror.pages.get(page.databaseId) : page;
  const access = holder?.access ?? page.access;
  // A page with no level of its own in the mirror is the account's own.
  if (!access || access === 'full') return 'full';
  return access === 'edit' || access === 'comment' ? access : 'view';
}

export const mayComment = (level: Level) => level !== 'view';

/** A new thread being written: what it is on. */
export interface DraftAnchor {
  blockId: string;
  start: string | null;
  end: string | null;
  quote: string;
}

const placesKey = (places: AnchorPlace[] | null) =>
  places ? places.map((p) => `${p.threadId}:${p.found}:${p.pos}`).join(',') : '';

/** The page's pages as the "@" list offers them. */
function pageSearch(session: WorkspaceSession, pageId: Id) {
  return (query: string) => {
    const q = query.trim().toLocaleLowerCase();
    const out: { id: Id; title: string; icon: string | null }[] = [];
    for (const page of session.mirror.pages.values()) {
      if (page.workspaceId !== session.workspaceId || page.trashedAt || page.id === pageId)
        continue;
      if (q && !page.title.toLocaleLowerCase().includes(q)) continue;
      out.push({ id: page.id, title: page.title, icon: page.icon });
      if (out.length >= 5) break;
    }
    return out;
  };
}

export interface CommentsPanelProps {
  store: CommentsStore;
  people: PeopleDirectory | null;
  session: WorkspaceSession;
  page: AnyPage;
  level: Level;
  selfId: Id | null;
  editor: BlockEditor | null;
  doc: PageDocument;
  draft: DraftAnchor | null;
  onDraftDone: () => void;
  /**
   * A thread to show: focused when a notification asks (`focus`), only scrolled to and selected
   * when the editor's highlight was clicked (the caret stays in the page).
   */
  focusRequest: { threadId: Id; n: number; focus: boolean } | null;
  onClose: () => void;
}

export function CommentsPanel({
  store,
  people,
  session,
  page,
  level,
  selfId,
  editor,
  doc,
  draft,
  onDraftDone,
  focusRequest,
  onClose,
}: CommentsPanelProps) {
  const { t, i18n } = useTranslation();
  const snap = useSyncExternalStore(store.subscribe, store.snapshot);
  useSyncExternalStore(
    people ? people.subscribe : noSubscription,
    people ? people.getRevision : zero,
  );
  const [showResolved, setShowResolved] = useState(false);
  const [places, setPlaces] = useState<AnchorPlace[] | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /** What takes focus (or is only scrolled to) after the next render: a thread, or the heading. */
  const focusNext = useRef<{ thread: Id; scrollOnly?: boolean } | 'heading' | null>(
    draft || focusRequest ? null : 'heading',
  );
  const canComment = mayComment(level) && snap.online;
  const format = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language],
  );
  const names = useMemo(
    () => ({
      person: (userId: Id) => people?.name(userId) ?? t('presence.someone'),
      page: (pageId: Id) => {
        const found = session.mirror.pages.get(pageId);
        return found && !found.trashedAt
          ? found.title || t('page.untitled')
          : t('editor.missingPage');
      },
    }),
    // Names change with the directory's revision, which renders this again.
    [people, session, t, people?.getRevision()],
  );
  const pages = useMemo(() => pageSearch(session, page.id), [session, page.id]);

  // Where the editor finds each open thread, read again (not per keystroke: at most every 400 ms
  // while the page changes) and shown only when the order or a removed block changes.
  useEffect(() => {
    const read = () => {
      // No editor yet (the page is still opening): as they were made, until it is there.
      const next = editor ? editor.anchorsInOrder() : null;
      setPlaces((was) => (placesKey(was) === placesKey(next) && !!was === !!next ? was : next));
    };
    read();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      timer ??= setTimeout(() => {
        timer = null;
        read();
      }, 400);
    };
    doc.doc.on('update', soon);
    // The editor draws a changed list first; its places are read after.
    const off = store.subscribeEditor(soon);
    return () => {
      doc.doc.off('update', soon);
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [editor, doc, store]);

  const open = snap.threads.filter((thread) => !thread.resolvedAt);
  const resolved = snap.threads
    .filter((thread) => thread.resolvedAt)
    .sort((a, b) => (a.resolvedAt! < b.resolvedAt! ? 1 : -1));
  const ordered = orderThreads(open, places);

  // A thread asked for: shown (behind the toggle too), selected and focused.
  useEffect(() => {
    if (!focusRequest) return;
    const thread = snap.threads.find((th) => th.id === focusRequest.threadId);
    if (thread?.resolvedAt) setShowResolved(true);
    focusNext.current = { thread: focusRequest.threadId, scrollOnly: !focusRequest.focus };
    store.setActive(focusRequest.threadId);
    // The thread may not be read yet (a notification's): it is focused once it is.
  }, [focusRequest, store]);

  useLayoutEffect(() => {
    const next = focusNext.current;
    if (!next) return;
    if (next === 'heading') {
      focusNext.current = null;
      heading.current?.focus();
      return;
    }
    const el = list.current?.querySelector<HTMLElement>(`[data-thread-id="${next.thread}"]`);
    if (!el) return;
    focusNext.current = null;
    if (!next.scrollOnly) el.focus();
    el.scrollIntoView({ block: 'nearest' });
  });

  /** After a thread leaves the list (resolved, deleted): the next one, else the heading. */
  const focusAfter = (threadId: Id) => {
    const at = ordered.findIndex((o) => o.thread.id === threadId);
    const next = ordered[at + 1] ?? ordered[at - 1];
    focusNext.current = next ? { thread: next.thread.id } : 'heading';
  };

  const select = (threadId: Id) => {
    store.setActive(threadId);
    editor?.scrollToThread(threadId);
  };

  const focusEditor = () => {
    const ed = editor?.editor;
    if (ed && !ed.isDestroyed) ed.commands.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
    focusEditor();
  };

  const composerFor = {
    people,
    pages,
    personName: names.person,
    pageTitle: names.page,
  };

  const failure = snap.lastFailure;
  return (
    <section
      className="cgw-comments"
      aria-labelledby="cgw-comments-title"
      data-testid="comments-panel"
      onKeyDown={onKeyDown}
    >
      <header className="cgw-comments-header">
        <h2 id="cgw-comments-title" ref={heading} tabIndex={-1}>
          {t('comments.title')}
        </h2>
        <button
          type="button"
          className="cgw-link-button"
          aria-pressed={showResolved}
          disabled={!resolved.length && !showResolved}
          onClick={() => setShowResolved((shown) => !shown)}
        >
          {t('comments.showResolved', { count: resolved.length })}
        </button>
        <button
          type="button"
          className="cgw-icon-button cgw-topbar-button"
          aria-label={t('comments.close')}
          title={t('comments.close')}
          onClick={() => {
            onClose();
            focusEditor();
          }}
        >
          ×
        </button>
      </header>
      {!snap.online && (
        <p className="cgw-comments-notice" role="status" data-testid="comments-offline">
          {snap.loaded ? t('comments.offlineKept') : t('comments.offline')}
        </p>
      )}
      {snap.error && (
        <p className="cgw-comments-notice" role="alert">
          {snap.error === 'access.denied' ? t('comments.noAccess') : t('comments.readFailed')}
        </p>
      )}
      {failure && (
        <p className="cgw-comments-notice" role="alert">
          {failure.code === 'offline'
            ? t('comments.notDoneOffline')
            : failure.kind === 'resolve'
              ? t('comments.resolveFailed')
              : t('comments.deleteFailed')}
        </p>
      )}
      <div className="cgw-comments-body" ref={list}>
        {draft && (
          <div
            // Another selection's "Comment" starts a composer of its own.
            key={`${draft.blockId}:${draft.start}:${draft.end}:${draft.quote}`}
            className="cgw-thread is-draft"
            data-testid="comment-draft"
          >
            <Quote quote={draft.quote} />
            <Composer
              {...composerFor}
              label={t('comments.newLabel')}
              placeholder={t('comments.newPlaceholder')}
              submitLabel={t('comments.send')}
              disabled={!canComment}
              autoFocus
              onSubmit={(body) => {
                const id = store.createThread(draft, body);
                onDraftDone();
                if (id) {
                  store.setActive(id);
                  focusNext.current = { thread: id };
                }
              }}
              onCancel={() => {
                onDraftDone();
                focusEditor();
              }}
            />
          </div>
        )}
        {snap.loaded && !ordered.length && !draft && (
          <p className="cgw-muted cgw-comments-empty">{t('comments.empty')}</p>
        )}
        {!snap.loaded && snap.online && !snap.error && (
          <p className="cgw-muted cgw-comments-empty">{t('comments.loading')}</p>
        )}
        {ordered.length > 0 && (
          <ul className="cgw-thread-list" aria-label={t('comments.openThreads')}>
            {ordered.map(({ thread, removed }) => (
              <ThreadItem
                key={thread.id}
                thread={thread}
                removed={removed}
                active={store.activeThread === thread.id}
                level={level}
                canComment={canComment}
                online={snap.online}
                selfId={selfId}
                format={format}
                names={names}
                composer={composerFor}
                store={store}
                onSelect={() => select(thread.id)}
                onGone={() => focusAfter(thread.id)}
                onFocusThread={() => (focusNext.current = { thread: thread.id })}
              />
            ))}
          </ul>
        )}
        {showResolved && resolved.length > 0 && (
          <ul className="cgw-thread-list is-resolved" aria-label={t('comments.resolvedThreads')}>
            {resolved.map((thread) => (
              <ThreadItem
                key={thread.id}
                thread={thread}
                removed={false}
                active={store.activeThread === thread.id}
                level={level}
                canComment={canComment}
                online={snap.online}
                selfId={selfId}
                format={format}
                names={names}
                composer={composerFor}
                store={store}
                onSelect={() => store.setActive(thread.id)}
                onGone={() => (focusNext.current = { thread: thread.id })}
                onFocusThread={() => (focusNext.current = { thread: thread.id })}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

const noSubscription = () => () => {};
const zero = () => 0;

function Quote({ quote }: { quote: string }) {
  const { t } = useTranslation();
  return quote ? (
    <blockquote className="cgw-thread-quote-text" dir="auto">
      {quote}
    </blockquote>
  ) : (
    <p className="cgw-thread-quote-text cgw-muted">{t('comments.onBlock')}</p>
  );
}

interface Names {
  person: (userId: Id) => string;
  page: (pageId: Id) => string;
}

/** A comment's body as text, line breaks and mentions. */
export function BodyView({ body, names }: { body: CommentBody; names: Names }) {
  return (
    <p className="cgw-comment-body" dir="auto">
      {body.map((node, i) => {
        if (node.type === 'text') return <Fragment key={i}>{node.text}</Fragment>;
        if (node.type === 'hardBreak') return <br key={i} />;
        if (node.type === 'userMention')
          return (
            <span key={i} className="cgw-comment-mention is-user">
              @{names.person(node.attrs.userId)}
            </span>
          );
        return (
          <a
            key={i}
            className="cgw-comment-mention is-page"
            href={routeHash({ kind: 'page', pageId: node.attrs.pageId })}
          >
            {names.page(node.attrs.pageId)}
          </a>
        );
      })}
    </p>
  );
}

const failureKey = (code: string | undefined) =>
  code === 'offline'
    ? 'comments.failedOffline'
    : code === 'access.denied'
      ? 'comments.failedAccess'
      : code === 'comment.invalid'
        ? 'comments.failedInvalid'
        : code === 'not.found'
          ? 'comments.failedGone'
          : 'comments.failedOther';

interface ThreadItemProps {
  thread: ThreadView;
  removed: boolean;
  active: boolean;
  level: Level;
  canComment: boolean;
  online: boolean;
  selfId: Id | null;
  format: Intl.DateTimeFormat;
  names: Names;
  composer: Pick<ComponentProps<typeof Composer>, 'people' | 'pages' | 'personName' | 'pageTitle'>;
  store: CommentsStore;
  onSelect: () => void;
  /** The thread leaves this list (resolved, reopened, deleted). */
  onGone: () => void;
  onFocusThread: () => void;
}

function ThreadItem({
  thread,
  removed,
  active,
  level,
  canComment,
  online,
  selfId,
  format,
  names,
  composer,
  store,
  onSelect,
  onGone,
  onFocusThread,
}: ThreadItemProps) {
  const { t } = useTranslation();
  const [replying, setReplying] = useState(false);
  const reply = useRef<ComposerHandle>(null);
  const saved = thread.state === 'saved';
  const isResolved = !!thread.resolvedAt;
  const titleId = `cgw-thread-${thread.id}`;
  useEffect(() => {
    if (replying) reply.current?.focus();
  }, [replying]);
  return (
    <li
      className={`cgw-thread${active ? ' is-active' : ''}${removed ? ' is-removed' : ''}`}
      data-thread-id={thread.id}
      data-state={thread.state}
      tabIndex={-1}
      aria-labelledby={titleId}
      onClick={(event) => {
        // A click on the thread selects it; its own controls do their own thing.
        if (!(event.target as HTMLElement).closest('button, a, [role="textbox"]')) onSelect();
      }}
    >
      <div id={titleId} className="cgw-thread-anchor">
        {removed ? (
          <p className="cgw-thread-removed" data-testid="thread-removed">
            {t('comments.removedBlock')}
          </p>
        ) : null}
        {!removed && !isResolved ? (
          <button
            type="button"
            className="cgw-thread-quote"
            aria-description={t('comments.showInPage')}
            onClick={onSelect}
          >
            {thread.quote ? <span dir="auto">{thread.quote}</span> : t('comments.onBlock')}
          </button>
        ) : (
          <Quote quote={thread.quote} />
        )}
      </div>
      {isResolved && (
        <p className="cgw-muted cgw-thread-resolved">
          {t('comments.resolvedBy', {
            name: thread.resolvedBy
              ? names.person(thread.resolvedBy.id) || thread.resolvedBy.name
              : t('presence.someone'),
            when: format.format(new Date(thread.resolvedAt!)),
          })}
        </p>
      )}
      <ol className="cgw-comment-list">
        {thread.comments.map((comment, index) => (
          <CommentItem
            key={comment.id}
            comment={comment}
            first={index === 0}
            mine={comment.author.id === selfId}
            // The author edits and deletes their own; full access deletes any (the server checks).
            canDelete={comment.author.id === selfId || level === 'full'}
            canEdit={comment.author.id === selfId}
            online={online}
            showFailure={thread.state !== 'failed'}
            format={format}
            names={names}
            composer={composer}
            store={store}
            threadId={thread.id}
            onThreadGone={onGone}
            onFocusThread={onFocusThread}
          />
        ))}
      </ol>
      {thread.state === 'failed' && thread.opId && (
        <FailedWrite code={thread.error} opId={thread.opId} store={store} onDiscard={onGone} />
      )}
      {saved && canComment && (
        <div className="cgw-thread-actions">
          {!isResolved && !replying && (
            <button type="button" className="cgw-link-button" onClick={() => setReplying(true)}>
              {t('comments.reply')}
            </button>
          )}
          <button
            type="button"
            className="cgw-link-button"
            onClick={() => {
              store.setResolved(thread.id, !isResolved);
              onGone();
            }}
          >
            {isResolved ? t('comments.reopen') : t('comments.resolve')}
          </button>
        </div>
      )}
      {saved && canComment && !isResolved && replying && (
        <Composer
          {...composer}
          handle={reply}
          label={t('comments.replyLabel')}
          placeholder={t('comments.replyPlaceholder')}
          submitLabel={t('comments.send')}
          onSubmit={(body) => {
            store.reply(thread.id, body);
            reply.current?.clear();
          }}
          onCancel={() => {
            setReplying(false);
            onFocusThread();
          }}
        />
      )}
    </li>
  );
}

function FailedWrite({
  code,
  opId,
  store,
  onDiscard,
}: {
  code: string | undefined;
  opId: string;
  store: CommentsStore;
  onDiscard?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="cgw-comment-failed" role="alert">
      <span>{t(failureKey(code))}</span>
      <button type="button" className="cgw-link-button" onClick={() => store.retry(opId)}>
        {t('comments.retry')}
      </button>
      <button
        type="button"
        className="cgw-link-button"
        onClick={() => {
          store.discard(opId);
          onDiscard?.();
        }}
      >
        {t('comments.discard')}
      </button>
    </div>
  );
}

interface CommentItemProps {
  comment: CommentView;
  first: boolean;
  mine: boolean;
  canDelete: boolean;
  canEdit: boolean;
  online: boolean;
  /** The thread's own failure is shown instead (its first comment failed with it). */
  showFailure: boolean;
  format: Intl.DateTimeFormat;
  names: Names;
  composer: ThreadItemProps['composer'];
  store: CommentsStore;
  threadId: Id;
  onThreadGone: () => void;
  onFocusThread: () => void;
}

function CommentItem({
  comment,
  first,
  mine,
  canDelete,
  canEdit,
  online,
  showFailure,
  format,
  names,
  composer,
  store,
  threadId,
  onThreadGone,
  onFocusThread,
}: CommentItemProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const returnToEdit = useRef(false);
  const headId = `cgw-comment-${comment.id}`;
  const name = names.person(comment.author.id) || comment.author.name;
  const saved = comment.state === 'saved';
  useEffect(() => {
    if (!editing && returnToEdit.current) {
      returnToEdit.current = false;
      editButton.current?.focus();
    }
  }, [editing]);
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);
  return (
    <li className="cgw-comment" data-state={comment.state} data-testid="comment">
      <div className="cgw-comment-head" id={headId}>
        <Avatar userId={comment.author.id} name={name} decorative />
        <span className="cgw-comment-author" dir="auto">
          {mine ? t('comments.you', { name }) : name}
        </span>
        <time className="cgw-muted" dateTime={comment.createdAt}>
          {format.format(new Date(comment.createdAt))}
        </time>
        {comment.editedAt && <span className="cgw-muted">{t('comments.edited')}</span>}
        {comment.state === 'pending' && (
          <span className="cgw-muted" role="status">
            {t('comments.sending')}
          </span>
        )}
      </div>
      {editing ? (
        <Composer
          {...composer}
          initial={comment.body}
          autoFocus
          label={t('comments.editLabel')}
          placeholder={t('comments.replyPlaceholder')}
          submitLabel={t('comments.save')}
          onSubmit={(body) => {
            store.edit(threadId, comment.id, body);
            returnToEdit.current = true;
            setEditing(false);
          }}
          onCancel={() => {
            returnToEdit.current = true;
            setEditing(false);
          }}
        />
      ) : (
        <BodyView body={comment.body} names={names} />
      )}
      {comment.state === 'failed' && comment.opId && showFailure && (
        <FailedWrite code={comment.error} opId={comment.opId} store={store} />
      )}
      {saved && !editing && online && (canEdit || canDelete) && (
        <div className="cgw-comment-actions">
          {canEdit && (
            <button
              ref={editButton}
              type="button"
              className="cgw-link-button"
              aria-describedby={headId}
              onClick={() => setEditing(true)}
            >
              {t('comments.edit')}
            </button>
          )}
          {canDelete &&
            (confirming ? (
              <span className="cgw-comment-confirm" role="group" aria-labelledby={`${headId}-q`}>
                <span id={`${headId}-q`}>
                  {first ? t('comments.deleteThreadQuestion') : t('comments.deleteQuestion')}
                </span>
                <button
                  ref={confirmButton}
                  type="button"
                  className="cgw-link-button is-danger"
                  onClick={() => {
                    setConfirming(false);
                    store.remove(threadId, comment.id);
                    if (first) onThreadGone();
                    else onFocusThread();
                  }}
                >
                  {t('comments.deleteConfirm')}
                </button>
                <button
                  type="button"
                  className="cgw-link-button"
                  onClick={() => setConfirming(false)}
                >
                  {t('frame.cancel')}
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="cgw-link-button"
                aria-describedby={headId}
                onClick={() => setConfirming(true)}
              >
                {t('comments.delete')}
              </button>
            ))}
        </div>
      )}
    </li>
  );
}
