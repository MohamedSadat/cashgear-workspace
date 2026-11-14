// "Export to a workbook" on a view's menu (Phase 5, M5.5): asks for the workbook's name (the
// database's and the view's at first), then the host has the server write the view's rows as the
// first version of a new workbook (`DatabaseHost.exportWorkbook`), and a notice offers "Open in
// Cash Gear Sheet" (`DatabaseHost.openWorkbook`). Offered where the host can do it (a synced
// workspace); the views never reach the server themselves.
import { CgButton, CgPopup, type CgContextMenuItem } from '@cashgear/ui';
import type { Id } from '@cgw/workspace';
import { useEffect, useState, type ReactNode } from 'react';
import type { ViewRecord } from '../core';
import type { DatabaseHost } from '../host';
import { useDbT } from '../i18n';
import './csv.css';

export interface WorkbookExportExtras {
  menuItems: CgContextMenuItem<ViewRecord>[];
  element: ReactNode;
}

type Status =
  | { kind: 'naming'; view: ViewRecord; name: string }
  | { kind: 'exporting' }
  | { kind: 'done'; workbookId: Id; name: string }
  | { kind: 'failed'; text: string };

export function useWorkbookExport(host: DatabaseHost, databaseId: Id): WorkbookExportExtras {
  const { t } = useDbT();
  const [status, setStatus] = useState<Status | null>(null);
  // A notice goes after a while; the "done" one stays a little longer for its button.
  useEffect(() => {
    if (!status || status.kind === 'naming' || status.kind === 'exporting') return;
    const timer = setTimeout(() => setStatus(null), status.kind === 'done' ? 15_000 : 8000);
    return () => clearTimeout(timer);
  }, [status]);
  if (!host.exportWorkbook) return { menuItems: [], element: null };

  const start = async (view: ViewRecord, name: string) => {
    const exportWorkbook = host.exportWorkbook;
    if (!exportWorkbook) return;
    setStatus({ kind: 'exporting' });
    try {
      const made = await exportWorkbook.call(host, databaseId, view.id, name);
      setStatus({ kind: 'done', workbookId: made.workbookId, name: made.name });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setStatus({
        kind: 'failed',
        text:
          code === 'offline'
            ? t('workbook.offline')
            : code === 'limit.size'
              ? t('workbook.tooLarge')
              : t('workbook.failed'),
      });
    }
  };

  const menuItems: CgContextMenuItem<ViewRecord>[] = [
    {
      key: 'workbook-export',
      text: t('workbook.menuExport'),
      command: ({ invocation }) => {
        const view = invocation.context;
        const title = host.pageTitle(databaseId) || t('untitledDatabase');
        setStatus({ kind: 'naming', view, name: `${title} – ${view.name}`.slice(0, 200) });
      },
    },
  ];

  const element = status ? (
    status.kind === 'naming' ? (
      <CgPopup
        open
        headerText={t('workbook.title')}
        closeButtonAriaLabel={t('csv.close')}
        width="min(28rem, calc(100vw - 24px))"
        onOpenChange={(open) => {
          if (!open) setStatus(null);
        }}
        footer={
          <div className="cgw-csv-actions">
            <CgButton appearance="ghost" onClick={() => setStatus(null)}>
              {t('cancel')}
            </CgButton>
            <CgButton
              intent="primary"
              disabled={!status.name.trim()}
              onClick={() => void start(status.view, status.name.trim())}
            >
              {t('workbook.start')}
            </CgButton>
          </div>
        }
      >
        <form
          className="cgw-db-workbook-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (status.name.trim()) void start(status.view, status.name.trim());
          }}
        >
          <label htmlFor="cgw-db-workbook-name">{t('workbook.name')}</label>
          <input
            id="cgw-db-workbook-name"
            className="cgw-text-input"
            data-cg-initial-focus=""
            dir="auto"
            maxLength={200}
            value={status.name}
            onChange={(event) => setStatus({ ...status, name: event.target.value })}
          />
          <p className="cgw-db-workbook-note">{t('workbook.note')}</p>
        </form>
      </CgPopup>
    ) : (
      <p
        className={`cgw-db-notice${status.kind === 'failed' ? ' cgw-db-error' : ''}`}
        role={status.kind === 'failed' ? 'alert' : 'status'}
      >
        {status.kind === 'exporting'
          ? t('workbook.exporting')
          : status.kind === 'failed'
            ? status.text
            : t('workbook.done', { name: status.name })}
        {status.kind === 'done' && host.openWorkbook ? (
          <>
            {' '}
            <CgButton
              appearance="outline"
              size="small"
              onClick={() => host.openWorkbook?.(status.workbookId)}
            >
              {t('workbook.open')}
            </CgButton>
          </>
        ) : null}
      </p>
    )
  ) : null;
  return { menuItems, element };
}
