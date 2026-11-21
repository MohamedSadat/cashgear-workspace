// Settings → Your data: export the workspace (from this device, or from the account as the server
// makes it), import an export, import from Markdown, Notion or Word (Phase 8, the import panel),
// and what the browser keeps.
//
// Phase 9 (M9.3): a synced workspace's export holds its workbooks, read from the account
// (exchange/workbooks.ts). An export imported while signed in goes to the account as a new synced
// workspace, and its workbooks are made again there; imported signed out, it stays on this device
// and its workbooks are skipped, which the message says.
//
// With no workspace shown (signed out on a device whose workspaces are all synced: another
// account's are never shown), the panel is still in Settings and offers the import alone.
import { CgFilePicker } from '@cashgear/ui';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Cloud } from '../cloud/cloud';
import { useAccount, useCloud } from '../cloud/CloudUi';
import { useShell } from '../context';
import { collaborates, useCollab } from '../collab/context';
import { useDatabaseHost } from '../database/context';
import { pageEvents } from '../page/PageMenu';
import { navigate } from '../route';
import type { WorkspaceSession } from '../session';
import { workbookApi } from '../sheet/api';
import type { ExportOptions, ExportWorkbookReport } from './exchange';

/** The import panel and what it reads with load when it is opened, not with Settings. */
const ImportPanel = lazy(() =>
  import('./import/ImportPanel').then((m) => ({ default: m.ImportPanel })),
);

export async function exportAndSave(
  session: WorkspaceSession,
  save: (name: string, bytes: Uint8Array, type: string) => Promise<void>,
  untitled: string,
  pageIds?: string[],
  /** People's names, for a database's CSV (the database host's people). */
  people?: { id: string; name: string }[],
  /** A mentioned person's name, for the pages' Markdown (the workspace's people directory). */
  userName?: (userId: string) => string | undefined,
  /** Phase 9: the workspace's workbooks, read from the account (`workbookReader`). */
  workbooks?: ExportOptions['workbooks'],
): Promise<ExportWorkbookReport> {
  const { exportZip } = await import('./exchange');
  await session.flushAll();
  const result = await exportZip(session, {
    pageIds,
    untitled,
    people: people && Object.fromEntries(people.map((p) => [p.id, p.name])),
    ...(userName ? { userName } : {}),
    ...(workbooks ? { workbooks } : {}),
    // A chart's or a board's line in the Markdown, in the interface language (Phase 7).
    language: document.documentElement.lang.startsWith('ar') ? 'ar' : 'en',
  });
  await save(result.name, result.bytes, 'application/zip');
  return result.workbooks;
}

/** Someone is signed in and the server is not known to be out of reach. */
const reachable = (cloud: Cloud | null) => {
  const state = cloud?.status.state;
  return !!cloud?.account && state !== 'offline' && state !== 'signedOut';
};

export function DataPanel({ session }: { session: WorkspaceSession }) {
  const { t } = useTranslation();
  const { platform } = useShell();
  const cloud = useCloud();
  const account = useAccount(cloud);
  const databases = useDatabaseHost();
  // Mentions in the export's Markdown are written with names (Phase 6).
  const collab = useCollab();
  const workspace = session.current;
  // The server decides; the button is offered to those it would answer.
  const serverExport =
    !!cloud &&
    !!account &&
    !!workspace &&
    !workspace.localOnly &&
    (workspace.role === 'owner' || workspace.role === 'admin');
  const [busy, setBusy] = useState<null | 'export' | 'import' | 'serverExport'>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [importing, setImporting] = useState(false);

  /** What the export says about the workbooks it holds, or could not read. */
  const exported = (report: ExportWorkbookReport) =>
    [
      t('exchange.exported'),
      report.unreadable
        ? t('exchange.workbooksUnreadable')
        : report.written
          ? t('exchange.workbooksWritten', { count: report.written })
          : '',
      !report.unreadable && report.failed
        ? t('exchange.workbooksFailed', { count: report.failed })
        : '',
    ]
      .filter(Boolean)
      .join(' ');

  /**
   * Reads a workspace export and imports it, then opens its first page. Signed in, the new
   * workspace goes to the account and its workbooks are made there; else they are skipped.
   */
  const importExport = (chosen: File) => {
    setBusy('import');
    setMessage(null);
    void chosen
      .arrayBuffer()
      .then(async (buffer) => {
        const { importZip } = await import('./exchange');
        const toAccount = reachable(cloud);
        const result = await importZip(
          session,
          new Uint8Array(buffer),
          t('exchange.importedSuffix'),
          { workbooks: toAccount ? 'make' : 'skip' },
        );
        const parts: string[] = [];
        if (toAccount && cloud) {
          try {
            await cloud.upload(result.workspaceId);
            parts.push(t('exchange.importedToAccount'));
            if (result.pendingWorkbooks.length) {
              const { makeWorkbooks } = await import('./workbooks');
              const made = await makeWorkbooks(
                workbookApi(cloud.api),
                result.workspaceId,
                result.pendingWorkbooks,
              );
              if (made.made) parts.push(t('exchange.workbooksMade', { count: made.made }));
              if (made.failed) parts.push(t('exchange.workbooksNotMade', { count: made.failed }));
            }
          } catch (error) {
            // Still on this device, whole: it can be uploaded later. Its workbooks were not made.
            console.warn('The imported workspace did not reach the account:', error);
            parts.push(t('exchange.imported'), t('exchange.uploadFailed'));
            if (result.pendingWorkbooks.length)
              parts.push(t('exchange.workbooksNotMade', { count: result.pendingWorkbooks.length }));
          }
        } else parts.push(t('exchange.imported'));
        if (result.skippedWorkbooks)
          parts.push(t('exchange.workbooksSkipped', { count: result.skippedWorkbooks }));
        const report = parts.join(' ');
        setMessage(report);
        if (result.first) {
          // The new workspace's first page closes this panel: its report goes with it, as the
          // window's notice (after the account's own "uploaded", which it says more fully).
          navigate({ kind: 'page', pageId: result.first });
          window.setTimeout(
            () => pageEvents.dispatchEvent(new CustomEvent('notice', { detail: report })),
            0,
          );
        }
      })
      .catch((error: unknown) => {
        console.error(error);
        setMessage(t('exchange.importFailed'));
      })
      .finally(() => setBusy(null));
  };

  useEffect(() => {
    if (platform.kind !== 'web') return;
    void navigator.storage?.persisted?.().then(setPersisted, () => setPersisted(false));
  }, [platform]);

  return (
    <section className="cgw-data" aria-labelledby="cgw-data-title">
      <h2 id="cgw-data-title">{t('exchange.title')}</h2>
      <p className="cgw-muted">
        {platform.kind === 'web'
          ? t(persisted ? 'exchange.browserKept' : 'exchange.browserMayClear')
          : t('exchange.desktopKept')}
      </p>
      <div className="cgw-data-buttons">
        {/* With no workspace shown here there is nothing to export: only the import is offered. */}
        {workspace && (
          <button
            type="button"
            className="cgw-button"
            disabled={busy !== null}
            onClick={() => {
              setBusy('export');
              setMessage(null);
              // A synced workspace's workbooks are in the account: read from there, when it can be.
              const workbooks =
                cloud && workspace && !workspace.localOnly && reachable(cloud)
                  ? workbookReaderFor(cloud, workspace.id)
                  : undefined;
              exportAndSave(
                session,
                (n, b, ty) => platform.saveFile(n, b, ty),
                t('page.untitled'),
                undefined,
                databases?.people(),
                workspace && collaborates(collab, session, workspace.id)
                  ? collab!.people(workspace.id).name
                  : undefined,
                workbooks,
              )
                .then((report) => setMessage(exported(report)))
                .catch((error: unknown) => {
                  console.error(error);
                  setMessage(t('exchange.exportFailed'));
                })
                .finally(() => setBusy(null));
            }}
          >
            {t('exchange.exportWorkspace')}
          </button>
        )}
        {serverExport && (
          <button
            type="button"
            className="cgw-button"
            disabled={busy !== null}
            onClick={() => {
              setBusy('serverExport');
              setMessage(t('exchange.serverExporting'));
              cloud
                .exportWorkspace(workspace.id)
                .then((bytes) =>
                  platform.saveFile(
                    `${workspace.name || t('page.untitled')}.zip`,
                    bytes,
                    'application/zip',
                  ),
                )
                .then(() => setMessage(t('exchange.exported')))
                .catch((error: unknown) => {
                  console.error(error);
                  setMessage(t('exchange.exportFailed'));
                })
                .finally(() => setBusy(null));
            }}
          >
            {t('exchange.serverExport')}
          </button>
        )}
        {/* The library's file picker (Track U16): it gives the export chosen, nothing else. */}
        <CgFilePicker
          appearance="outline"
          accept=".zip,application/zip"
          disabled={busy !== null}
          // A file the dialog let through that is not a zip: the import says why it fails.
          onReject={([chosen]) => importExport(chosen)}
          onPick={([chosen]) => importExport(chosen)}
        >
          {t('exchange.import')}
        </CgFilePicker>
        {/* Markdown, Notion and Word come into the workspace shown. */}
        {workspace && (
          <button
            type="button"
            className="cgw-button"
            // A guest makes no pages of their own (the server refuses them): it is not offered.
            disabled={busy !== null || workspace.role === 'guest'}
            onClick={() => setImporting(true)}
          >
            {t('exchange.importOther')}
          </button>
        )}
      </div>
      {importing && (
        <Suspense fallback={null}>
          <ImportPanel session={session} onClose={() => setImporting(false)} />
        </Suspense>
      )}
      {message && (
        <p role="status" className="cgw-data-message" data-testid="data-message">
          {message}
        </p>
      )}
    </section>
  );
}

/**
 * A synced workspace's workbooks for an export, read from the account while it can be reached;
 * undefined otherwise (the export then holds none, and says nothing is missing).
 */
export function accountWorkbooks(
  cloud: Cloud | null,
  workspaceId: string,
): ExportOptions['workbooks'] | undefined {
  return cloud && reachable(cloud) ? workbookReaderFor(cloud, workspaceId) : undefined;
}

/** The export's workbook reader over the connection, loaded with the first export that needs it. */
function workbookReaderFor(cloud: Cloud, workspaceId: string): ExportOptions['workbooks'] {
  return async (wanted) => {
    const { workbookReader } = await import('./workbooks');
    return workbookReader(workbookApi(cloud.api), workspaceId)(wanted);
  };
}
