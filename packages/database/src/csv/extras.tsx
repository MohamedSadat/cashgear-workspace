// What the views stream adds to `DatabaseView` (the table stream's frame) for CSV: the view menu's
// "Import CSV…" and "Export this view as CSV" items, the import dialog while it is open, and a
// short status line after an export. One hook, so the frame needs one line per place.
import type { CgContextMenuItem } from '@cashgear/ui';
import type { Id } from '@cgw/workspace';
import { useEffect, useState, type ReactNode } from 'react';
import type { ViewRecord } from '../core';
import type { DatabaseHost } from '../host';
import { useDbT } from '../i18n';
import { exportFileName, exportView } from './exportView';
import { ImportDialog } from './ImportDialog';

export interface ViewsExtras {
  /** Items for the view menu (its context is the view). */
  menuItems: CgContextMenuItem<ViewRecord>[];
  /** The import dialog and the export's status, drawn once inside the database. */
  element: ReactNode;
}

export function useViewsExtras(host: DatabaseHost, databaseId: Id, editable: boolean): ViewsExtras {
  const { t } = useDbT();
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 6000);
    return () => clearTimeout(timer);
  }, [status]);

  const runExport = async (view: ViewRecord) => {
    const database = host.database(databaseId);
    if (!database) return;
    setStatus({ text: t('csv.exporting'), error: false });
    try {
      const name = exportFileName(host.pageTitle(databaseId) || t('untitledDatabase'), view.name);
      const result = await exportView(host, database, view, name);
      setStatus({
        text: result.partial
          ? t('csv.exportPartial', { count: result.count ?? 0 })
          : result.count === null
            ? t('csv.saved')
            : t('csv.exported', { count: result.count }),
        error: false,
      });
    } catch {
      setStatus({ text: t('csv.exportFailed'), error: true });
    }
  };

  const menuItems: CgContextMenuItem<ViewRecord>[] = [
    {
      key: 'csv-import',
      text: t('csv.menuImport'),
      beginGroup: true,
      disabled: !editable,
      command: () => setImporting(true),
    },
    {
      key: 'csv-export',
      text: t('csv.menuExport'),
      command: ({ invocation }) => void runExport(invocation.context),
    },
  ];

  const element = (
    <>
      {status ? (
        <p
          className={`cgw-db-notice${status.error ? ' cgw-db-error' : ''}`}
          role={status.error ? 'alert' : 'status'}
        >
          {status.text}
        </p>
      ) : null}
      {importing ? (
        <ImportDialog host={host} databaseId={databaseId} onClose={() => setImporting(false)} />
      ) : null}
    </>
  );
  return { menuItems, element };
}
