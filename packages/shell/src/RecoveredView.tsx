// `#/recovered`: pages made of changes the server would not take (M3.3), newest first, each with
// why it was set aside, when, the original page's title and a link to the page made of it. A
// recovered entry can be dismissed from the list; the page it made stays, as any page does.
// Entries still waiting (no private section to put them in yet) say so and cannot be dismissed:
// nothing typed is let go of without a page holding it.
import { useTranslation } from 'react-i18next';
import { useRecoveredRevision } from './cloud/CloudUi';
import type { Cloud } from './cloud/cloud';
import type { RecoveredItem } from './cloud/recovery';
import { navigate, routeHash } from './route';
import type { WorkspaceSession } from './session';
import { useMirror } from './sidebar/Sidebar';

const reasonKey = (reason: string) =>
  reason === 'doc.epochMismatch'
    ? 'recovered.reasonRestored'
    : reason === 'page.gone'
      ? 'recovered.reasonDeleted'
      : reason === 'access.denied'
        ? 'recovered.reasonAccess'
        : reason === 'page.removed'
          ? 'recovered.reasonRemoved'
          : 'recovered.reasonOther';

export function RecoveredView({ cloud, session }: { cloud: Cloud; session: WorkspaceSession }) {
  const { t, i18n } = useTranslation();
  useMirror(session);
  useRecoveredRevision(cloud);
  const items = cloud.recovery.visible();
  const format = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const open = (item: RecoveredItem) => {
    const page = item.recoveredPageId ? session.mirror.pages.get(item.recoveredPageId) : undefined;
    if (!page) return;
    if (page.workspaceId !== session.workspaceId) session.switchTo(page.workspaceId);
    navigate({ kind: 'page', pageId: page.id });
  };
  return (
    <section className="cgw-trash" aria-labelledby="cgw-recovered-title">
      <h1 id="cgw-recovered-title">{t('recovered.title')}</h1>
      <p className="cgw-muted">{t('recovered.intro')}</p>
      {items.length === 0 ? (
        <p>{t('recovered.empty')}</p>
      ) : (
        <ul className="cgw-trash-list" data-testid="recovered">
          {items.map((item) => {
            const title = item.title || t('page.untitled');
            const page = item.recoveredPageId
              ? session.mirror.pages.get(item.recoveredPageId)
              : undefined;
            return (
              <li key={item.id} className="cgw-trash-item cgw-recovered-item">
                <span className="cgw-recovered-text">
                  <span className="cgw-trash-title" dir="auto">
                    {t('recovered.from', { title })}
                  </span>
                  <span>{t(reasonKey(item.reason))}</span>
                  <span className="cgw-muted">
                    {t('recovered.at', { when: format.format(new Date(item.at)) })}
                  </span>
                  {item.status === 'pending' && (
                    <span className="cgw-muted">{t('recovered.waiting')}</span>
                  )}
                </span>
                {page && (
                  <a
                    className="cgw-button"
                    href={routeHash({ kind: 'page', pageId: page.id })}
                    onClick={(event) => {
                      event.preventDefault();
                      open(item);
                    }}
                  >
                    {t('recovered.open')}
                  </a>
                )}
                {item.status === 'recovered' && (
                  <button
                    type="button"
                    className="cgw-button"
                    aria-label={t('recovered.dismissLabel', { title })}
                    onClick={() =>
                      void cloud.recovery
                        .dismiss(item.id)
                        .catch((error: unknown) => console.warn('Could not dismiss:', error))
                    }
                  >
                    {t('recovered.dismiss')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
