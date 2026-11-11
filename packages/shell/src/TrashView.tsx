// The trash: pages trashed with their subpages, newest first. Restore brings back the same unit;
// "Delete for good" asks first and cannot be undone. Pages older than the retention (60 days) are
// purged when the workspace opens.
import type { Id } from '@cgw/workspace';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from './Dialog';
import { navigate } from './route';
import type { WorkspaceSession } from './session';
import { useMirror } from './sidebar/Sidebar';

export const TRASH_RETENTION_DAYS = 60;

export function TrashView({
  session,
  onError,
}: {
  session: WorkspaceSession;
  onError: (e: unknown) => void;
}) {
  const { t, i18n } = useTranslation();
  useMirror(session);
  const [confirm, setConfirm] = useState<Id | null>(null);
  if (!session.workspaceId) return null;
  const roots = session.mirror.trash(session.workspaceId);
  const format = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return (
    <section className="cgw-trash" aria-labelledby="cgw-trash-title">
      <h1 id="cgw-trash-title">{t('trash.title')}</h1>
      <p className="cgw-muted">{t('trash.retention', { days: TRASH_RETENTION_DAYS })}</p>
      {roots.length === 0 ? (
        <p>{t('trash.empty')}</p>
      ) : (
        <ul className="cgw-trash-list">
          {roots.map((page) => {
            const inside = session.mirror.descendantIds(page.id).length;
            return (
              <li key={page.id} className="cgw-trash-item">
                <span aria-hidden="true">{page.icon ?? '📄'}</span>
                <span className="cgw-trash-title" dir="auto">
                  {page.title || t('page.untitled')}
                </span>
                <span className="cgw-muted">
                  {inside > 0 ? t('trash.withSubpages', { count: inside }) : ''}{' '}
                  {format.format(new Date(page.trashedAt!))}
                </span>
                <button
                  type="button"
                  className="cgw-button"
                  onClick={() =>
                    void session
                      .restorePage(page.id)
                      .then(() => navigate({ kind: 'page', pageId: page.id }), onError)
                  }
                >
                  {t('trash.restore')}
                </button>
                <button
                  type="button"
                  className="cgw-button is-danger"
                  onClick={() => setConfirm(page.id)}
                >
                  {t('trash.deleteForGood')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {confirm && (
        <Dialog role="alertdialog" title={t('trash.confirmTitle')} onClose={() => setConfirm(null)}>
          <p>
            {t('trash.confirmBody', {
              title: session.mirror.pages.get(confirm)?.title || t('page.untitled'),
            })}
          </p>
          <div className="cgw-dialog-buttons">
            <button type="button" className="cgw-button" onClick={() => setConfirm(null)}>
              {t('frame.cancel')}
            </button>
            <button
              type="button"
              className="cgw-button is-danger"
              onClick={() => {
                const id = confirm;
                setConfirm(null);
                void session.deletePage(id).catch(onError);
              }}
            >
              {t('trash.deleteForGood')}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
