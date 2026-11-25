// `#/inbox`: the person's notifications (contract section 5): mentions in pages, mentions in
// comments and replies, from every workspace they are in. Opening one marks it read and goes to
// its page at its block, or opens the comments at its thread. "Mark all as read". Online only:
// offline it says so and keeps what it last showed.
import { CgAvatar } from '@cashgear/ui';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { navigate, routeHash } from '../route';
import type { WorkspaceSession } from '../session';
import type { Collab } from './collab';
import { avatarColours } from './colour';
import type { InboxStore, NotificationDto } from './inbox';
import { openThread } from './threads';
import { useSection } from '../i18n/sections';
import { automationsWords } from '../automations/words';

type Loose = (key: string, options?: Record<string, unknown>) => string;

const REASONS = new Set(['author.access', 'access.denied', 'not.found', 'webhook.access']);

/** Phase 15: a rule's notice, or a run of the person's own rule that stopped, in words. */
function automationText(n: NotificationDto, t: Loose, name: string, title: string) {
  const rule = n.automationName || t('automations.settings.untitled');
  if (n.reason)
    return {
      line: t('automations.inbox.stopped', { name: `“${rule}”` }),
      excerpt: t(`automations.inbox.reasons.${REASONS.has(n.reason) ? n.reason : 'other'}`),
    };
  return {
    line: t('automations.inbox.notice', { actor: name, name: `“${rule}”`, title }),
    excerpt: n.excerpt,
  };
}

/**
 * Phase 17: an approval asked of the person: Approve or Reject with a comment while it is asked,
 * else what came of it. Sent once; a refusal (decided meanwhile, past its deadline) says so.
 */
function ApprovalAnswer({
  n,
  inbox,
  t,
  title,
  format,
  online,
}: {
  n: NotificationDto;
  inbox: InboxStore;
  t: Loose;
  title: string;
  format: Intl.DateTimeFormat;
  online: boolean;
}) {
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const approval = n.approval!;
  const send = async (answer: 'approve' | 'reject') => {
    setSending(true);
    setProblem(null);
    try {
      await inbox.answer(n.id, answer, comment.trim() || null);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setProblem(
        t(code === 'approval.closed' ? 'automations.inbox.closed' : 'automations.inbox.failed'),
      );
    } finally {
      setSending(false);
    }
  };
  if (approval.answer || approval.state !== 'open')
    return (
      <p className="cgw-inbox-approval cgw-muted" data-state={approval.state}>
        {approval.answer
          ? t(
              approval.answer === 'approve'
                ? 'automations.inbox.youApproved'
                : 'automations.inbox.youRejected',
            )
          : ''}{' '}
        {approval.state === 'open'
          ? approval.mode === 'all'
            ? t('automations.inbox.answeredOf', {
                answered: approval.answered,
                asked: approval.asked,
              })
            : ''
          : t(`automations.inbox.${approval.state === 'stopped' ? 'closed' : approval.state}`)}
      </p>
    );
  const due = new Date(approval.deadlineAt);
  return (
    <div
      className="cgw-inbox-approval"
      role="group"
      aria-label={t('automations.inbox.answerLabel', { title })}
    >
      <textarea
        className="cgw-inbox-comment"
        dir="auto"
        maxLength={1000}
        aria-label={t('automations.inbox.comment')}
        placeholder={t('automations.inbox.comment')}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />
      <span className="cgw-inbox-approval-actions">
        <button
          type="button"
          className="cgw-button is-primary"
          disabled={sending || !online}
          onClick={() => void send('approve')}
        >
          {t('automations.inbox.approve')}
        </button>
        <button
          type="button"
          className="cgw-button"
          disabled={sending || !online}
          onClick={() => void send('reject')}
        >
          {t('automations.inbox.reject')}
        </button>
        {Number.isNaN(due.getTime()) ? null : (
          <span className="cgw-muted">
            {t('automations.inbox.answerBy', { when: format.format(due) })}
          </span>
        )}
        {approval.mode === 'all' ? (
          <span className="cgw-muted">
            {t('automations.inbox.answeredOf', {
              answered: approval.answered,
              asked: approval.asked,
            })}
          </span>
        ) : null}
      </span>
      {!online ? <p className="cgw-muted">{t('automations.inbox.offline')}</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}
    </div>
  );
}

/** Phase 17: a reminder's date as the person reads it: a day, or an instant at its time. */
function reminderDate(start: string | null, language: string): string {
  if (!start) return '';
  const day = start.length === 10;
  const date = new Date(day ? `${start}T00:00:00Z` : start);
  if (Number.isNaN(date.getTime())) return start;
  return new Intl.DateTimeFormat(
    language,
    day ? { dateStyle: 'medium', timeZone: 'UTC' } : { dateStyle: 'medium', timeStyle: 'short' },
  ).format(date);
}

/** Phase 17: a reminder's line and what it is of (with a rule's message after it, if it has one). */
function reminderText(n: NotificationDto, t: Loose, title: string, language: string) {
  const of = n.reminder
    ? t('automations.inbox.reminderOf', {
        property: n.reminder.propertyName || t('automations.inbox.reminderDate'),
        date: reminderDate(n.reminder.start, language),
      })
    : '';
  return {
    line: t('automations.inbox.reminder', { title }),
    excerpt: [of, n.excerpt].filter(Boolean).join(' · '),
  };
}

const textKey = (kind: NotificationDto['kind']) =>
  kind === 'mention'
    ? 'inbox.mention'
    : kind === 'commentMention'
      ? 'inbox.commentMention'
      : 'inbox.reply';

export function InboxView({ collab, session }: { collab: Collab; session: WorkspaceSession }) {
  const { t, i18n } = useTranslation();
  useSection(automationsWords);
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
                  <CgAvatar name={name} {...avatarColours(n.actor.id)} decorative />
                  <span className="cgw-inbox-text">
                    <span className="cgw-inbox-line">
                      {!n.readAt && (
                        <span className="cgw-inbox-dot">
                          <span className="cgw-visually-hidden">{t('inbox.unread')}</span>
                        </span>
                      )}
                      <span dir="auto">
                        {n.kind === 'automation'
                          ? automationText(n, t as unknown as Loose, name, title).line
                          : n.kind === 'reminder'
                            ? reminderText(n, t as unknown as Loose, title, i18n.language).line
                            : n.kind === 'approval'
                              ? t('automations.inbox.approval', {
                                  actor: name,
                                  name: `“${n.automationName || t('automations.settings.untitled')}”`,
                                  title,
                                })
                              : t(textKey(n.kind), { name, title })}
                      </span>
                    </span>
                    {(n.kind === 'automation'
                      ? automationText(n, t as unknown as Loose, name, title).excerpt
                      : n.kind === 'reminder'
                        ? reminderText(n, t as unknown as Loose, title, i18n.language).excerpt
                        : n.excerpt) && (
                      <span className="cgw-inbox-excerpt" dir="auto">
                        {n.kind === 'automation'
                          ? automationText(n, t as unknown as Loose, name, title).excerpt
                          : n.kind === 'reminder'
                            ? reminderText(n, t as unknown as Loose, title, i18n.language).excerpt
                            : n.excerpt}
                      </span>
                    )}
                    <time className="cgw-muted" dateTime={n.createdAt}>
                      {format.format(new Date(n.createdAt))}
                    </time>
                  </span>
                </a>
                {n.kind === 'approval' && n.approval ? (
                  <ApprovalAnswer
                    n={n}
                    inbox={inbox}
                    t={t as unknown as Loose}
                    title={title}
                    format={format}
                    online={snap.online}
                  />
                ) : null}
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
