// The trash: pages trashed with their subpages, newest first. Restore brings back the same unit;
// "Delete for good" asks first and cannot be undone. Pages older than the retention (60 days) are
// purged when the workspace opens. Phase 4: rows trashed on their own (each its own trash root),
// read from the local store, with the database they go back to.
import type { Id, RowRecord } from '@cgw/workspace';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pageGlyph } from './database/make';
import { Dialog } from './Dialog';
import { navigate } from './route';
import type { WorkspaceSession } from './session';
import { useMirror } from './sidebar/Sidebar';

export const TRASH_RETENTION_DAYS = 60;

/** The workspace's trashed rows, read again whenever the mirror changes. */
function useTrashedRows(session: WorkspaceSession, workspaceId: Id | null): RowRecord[] {
  const revision = useMirror(session);
  const [rows, setRows] = useState<RowRecord[]>([]);
  useEffect(() => {
    if (!workspaceId) return setRows([]);
    let live = true;
    void session.store.trashedRows(workspaceId).then(
      (found) => live && setRows(found),
      () => live && setRows([]),
    );
    return () => {
      live = false;
    };
  }, [session, workspaceId, revision]);
  return rows;
}

export function TrashView({
  session,
  onError,
}: {
  session: WorkspaceSession;
  onError: (e: unknown) => void;
}) {
  const { t, i18n } = useTranslation();
  useMirror(session);
  const [confirm, setConfirm] = useState<{ id: Id; title: string; row: boolean } | null>(null);
  const rows = useTrashedRows(session, session.workspaceId);
  if (!session.workspaceId) return null;
  const roots = session.mirror.trash(session.workspaceId);
  const format = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const restore = (id: Id) =>
    void session.restorePage(id).then(() => navigate({ kind: 'page', pageId: id }), onError);
  return (
    <section className="cgw-trash" aria-labelledby="cgw-trash-title">
      <h1 id="cgw-trash-title">{t('trash.title')}</h1>
      <p className="cgw-muted">{t('trash.retention', { days: TRASH_RETENTION_DAYS })}</p>
      {roots.length === 0 && rows.length === 0 ? (
        <p>{t('trash.empty')}</p>
      ) : (
        <ul className="cgw-trash-list">
          {roots.map((page) => {
            const inside = session.mirror.descendantIds(page.id).length;
            return (
              <li key={page.id} className="cgw-trash-item">
                <span aria-hidden="true">{pageGlyph(page)}</span>
                <span className="cgw-trash-title" dir="auto">
                  {page.title || t('page.untitled')}
                </span>
                <span className="cgw-muted">
                  {inside > 0 ? t('trash.withSubpages', { count: inside }) : ''}{' '}
                  {format.format(new Date(page.trashedAt!))}
                </span>
                <button type="button" className="cgw-button" onClick={() => restore(page.id)}>
                  {t('trash.restore')}
                </button>
                <button
                  type="button"
                  className="cgw-button is-danger"
                  onClick={() =>
                    setConfirm({ id: page.id, title: page.title || t('page.untitled'), row: false })
                  }
                >
                  {t('trash.deleteForGood')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > 0 && (
        <section aria-labelledby="cgw-trash-rows" data-testid="trashed-rows">
          <h2 id="cgw-trash-rows">{t('databases.trashRows')}</h2>
          <p className="cgw-muted">{t('databases.trashRowsNote')}</p>
          <ul className="cgw-trash-list">
            {rows.map((row) => {
              const database = session.mirror.pages.get(row.databaseId);
              const title = row.title || t('page.untitled');
              return (
                <li key={row.id} className="cgw-trash-item">
                  <span aria-hidden="true">{pageGlyph(row)}</span>
                  <span className="cgw-trash-title" dir="auto">
                    {title}
                  </span>
                  <span className="cgw-muted">
                    <span dir="auto">
                      {t('databases.rowIn', {
                        database: database?.title || t('database.untitledDatabase'),
                      })}
                    </span>{' '}
                    {format.format(new Date(row.trashedAt!))}
                  </span>
                  <button type="button" className="cgw-button" onClick={() => restore(row.id)}>
                    {t('trash.restore')}
                  </button>
                  <button
                    type="button"
                    className="cgw-button is-danger"
                    onClick={() => setConfirm({ id: row.id, title, row: true })}
                  >
                    {t('trash.deleteForGood')}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {confirm && (
        <Dialog role="alertdialog" title={t('trash.confirmTitle')} onClose={() => setConfirm(null)}>
          <p>
            {confirm.row
              ? t('databases.confirmRow', { title: confirm.title })
              : t('trash.confirmBody', { title: confirm.title })}
          </p>
          <div className="cgw-dialog-buttons">
            <button type="button" className="cgw-button" onClick={() => setConfirm(null)}>
              {t('frame.cancel')}
            </button>
            <button
              type="button"
              className="cgw-button is-danger"
              onClick={() => {
                const { id } = confirm;
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
