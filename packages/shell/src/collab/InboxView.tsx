// `#/inbox`: the person's notifications (contract section 5): mentions in pages, mentions in
// comments and replies, from every workspace they are in. Opening one marks it read and goes to
// its page at its block, or opens the comments at its thread. "Mark all as read". Online only:
// offline it says so and keeps what it last showed.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { navigate, routeHash } from '../route';
import type { WorkspaceSession } from '../session';
import { Avatar } from './Avatars';
import type { Collab } from './collab';
import type { NotificationDto } from './inbox';
import { openThread } from './threads';

const textKey = (kind: NotificationDto['kind']) =>
  kind === 'mention'
    ? 'inbox.mention'
    : kind === 'commentMention'
      ? 'inbox.commentMention'
      : 'inbox.reply';

export function InboxView({ collab, session }: { collab: Collab; session: WorkspaceSession }) {
  const { t, i18n } = useTranslation();
  const inbox = collab.inbox;
  const snap = useSyncExternalStore(inbox.subscribe, inbox.snapshot);
  const format = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language],
  );
  // What came while the inbox was closed.
  useEffect(() => void inbox.load(), [inbox]);

  const openOne = (n: NotificationDto) => {
    inbox.markRead(n.id);
    const page = session.mirror.pages.get(n.pageId) ?? session.mirror.rowRecords.get(n.pageId);
    const workspaceId = page?.workspaceId ?? n.workspaceId;
    if (workspaceId !== session.workspaceId && session.mirror.workspaces.has(workspaceId))
      session.switchTo(workspaceId);
    if (n.threadId) openThread(n.pageId, n.threadId);
    navigate({
      kind: 'page',
      pageId: n.pageId,
      ...(n.blockId && !n.threadId ? { blockId: n.blockId } : {}),
    });
  };

  const titleOf = (n: NotificationDto) => {
    const page = session.mirror.pages.get(n.pageId) ?? session.mirror.rowRecords.get(n.pageId);
    return page?.title || n.pageTitle || t('page.untitled');
  };
  const nameOf = (n: NotificationDto) =>
    collab.people(n.workspaceId).name(n.actor.id) ?? (n.actor.name || t('presence.someone'));

  return (
    <section className="cgw-inbox" aria-labelledby="cgw-inbox-title">
      <h1 id="cgw-inbox-title">{t('inbox.title')}</h1>
      <div className="cgw-inbox-tools">
        <label className="cgw-inbox-filter">
          <input
            type="checkbox"
            checked={snap.unreadOnly}
            onChange={(event) => inbox.setUnreadOnly(event.target.checked)}
          />
          {t('inbox.unreadOnly')}
        </label>
        <span className="cgw-muted" role="status" data-testid="inbox-unread">
          {t('inbox.unreadCount', { count: snap.unread })}
        </span>
        <button
          type="button"
          className="cgw-button"
          disabled={!snap.unread || !snap.online}
          onClick={() => inbox.markAllRead()}
        >
          {t('inbox.markAllRead')}
        </button>
      </div>
      {!snap.online && (
        <p className="cgw-page-notice" role="status">
          {snap.loaded ? t('inbox.offlineKept') : t('inbox.offline')}
        </p>
      )}
      {snap.loaded && !snap.items.length && (
        <p className="cgw-muted">{snap.unreadOnly ? t('inbox.emptyUnread') : t('inbox.empty')}</p>
      )}
      {!snap.loaded && snap.online && <p className="cgw-muted">{t('app.loading')}</p>}
      {snap.items.length > 0 && (
        <ul className="cgw-inbox-list" data-testid="inbox-list">
          {snap.items.map((n) => {
            const title = titleOf(n);
            const name = nameOf(n);
            return (
              <li key={n.id} className={`cgw-inbox-item${n.readAt ? '' : ' is-unread'}`}>
                <a
                  href={routeHash({
                    kind: 'page',
                    pageId: n.pageId,
                    ...(n.blockId && !n.threadId ? { blockId: n.blockId } : {}),
                  })}
                  onClick={(event) => {
                    event.preventDefault();
                    openOne(n);
                  }}
                >
                  <Avatar userId={n.actor.id} name={name} decorative />
                  <span className="cgw-inbox-text">
                    <span className="cgw-inbox-line">
                      {!n.readAt && (
                        <span className="cgw-inbox-dot">
                          <span className="cgw-visually-hidden">{t('inbox.unread')}</span>
                        </span>
                      )}
                      <span dir="auto">{t(textKey(n.kind), { name, title })}</span>
                    </span>
                    {n.excerpt && (
                      <span className="cgw-inbox-excerpt" dir="auto">
                        {n.excerpt}
                      </span>
                    )}
                    <time className="cgw-muted" dateTime={n.createdAt}>
                      {format.format(new Date(n.createdAt))}
                    </time>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {snap.next && (
        <button
          type="button"
          className="cgw-button"
          disabled={snap.loadingMore || !snap.online}
          onClick={() => void inbox.loadMore()}
        >
          {snap.loadingMore ? t('app.loading') : t('inbox.more')}
        </button>
      )}
    </section>
  );
}
