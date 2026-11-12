// A database's own page (a page of kind `database`): its icon, cover and title as a page has
// them, then the database as a full-page `DatabaseView`. A database page has no document of its
// own in Phase 4. The view last chosen here is shown again on this device.
import { DatabaseView } from '@cgw/database';
import type { Id, PageRecord } from '@cgw/workspace';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShell } from '../context';
import { exportAndSave } from '../exchange/DataPanel';
import { PageHeader } from '../page/PageHeader';
import { pageEvents } from '../page/PageMenu';
import { TitleField } from '../page/TitleField';
import type { WorkspaceSession } from '../session';
import { useDatabaseHost } from './context';

const VIEW_PREF = (databaseId: Id) => `database/view/${databaseId}`;

export function DatabasePage({ session, page }: { session: WorkspaceSession; page: PageRecord }) {
  const { t } = useTranslation();
  const host = useDatabaseHost();
  const readOnly = !session.canEdit(page.id);
  const [viewId, setViewId] = useState<{ id: Id; view: Id | null } | null>(null);
  useEffect(() => {
    let live = true;
    void session.store
      .getPref<Id>(VIEW_PREF(page.id))
      .catch(() => undefined)
      .then((view) => live && setViewId({ id: page.id, view: view ?? null }));
    return () => {
      live = false;
    };
  }, [session, page.id]);
  // "Export this page" from the page's menu: the database with its rows (and a CSV of them).
  const { platform } = useShell();
  useEffect(() => {
    const onExport = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== page.id) return;
      void exportAndSave(
        session,
        (n, b, ty) => platform.saveFile(n, b, ty),
        t('page.untitled'),
        [page.id],
        host?.people(),
      ).catch((error: unknown) => console.error('Export failed:', error));
    };
    pageEvents.addEventListener('export', onExport);
    return () => pageEvents.removeEventListener('export', onExport);
  }, [page.id, session, platform, t, host]);
  const ready = viewId?.id === page.id;
  return (
    <article
      className="cgw-page cgw-database-page"
      aria-label={page.title || t('database.untitledDatabase')}
    >
      {readOnly && (
        <div className="cgw-page-notice" role="status" data-testid="page-read-only">
          {t('page.viewOnly')}
        </div>
      )}
      <PageHeader session={session} page={page} readOnly={readOnly} />
      <TitleField
        session={session}
        page={page}
        readOnly={readOnly}
        placeholder={t('database.untitledDatabase')}
        onEnter={() => undefined}
      />
      {host && ready ? (
        <DatabaseView
          key={page.id}
          host={host}
          databaseId={page.id}
          viewId={viewId.view}
          editable={!readOnly}
          onViewChange={(view) =>
            void session.store.setPref(VIEW_PREF(page.id), view).catch(() => undefined)
          }
        />
      ) : (
        <div className="cgw-page-loading">{t('app.loading')}</div>
      )}
    </article>
  );
}
