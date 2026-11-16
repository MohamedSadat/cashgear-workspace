// Settings → Your data: export the workspace (from this device, or from the account as the server
// makes it), import an export, import from Markdown, Notion or Word (Phase 8, the import panel),
// and what the browser keeps.
import { CgFilePicker } from '@cashgear/ui';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccount, useCloud } from '../cloud/CloudUi';
import { useShell } from '../context';
import { collaborates, useCollab } from '../collab/context';
import { useDatabaseHost } from '../database/context';
import { navigate } from '../route';
import type { WorkspaceSession } from '../session';

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
) {
  const { exportZip } = await import('./exchange');
  await session.flushAll();
  const { bytes, name } = await exportZip(session, {
    pageIds,
    untitled,
    people: people && Object.fromEntries(people.map((p) => [p.id, p.name])),
    ...(userName ? { userName } : {}),
    // A chart's or a board's line in the Markdown, in the interface language (Phase 7).
    language: document.documentElement.lang.startsWith('ar') ? 'ar' : 'en',
  });
  await save(name, bytes, 'application/zip');
}

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

  /** Reads a workspace export and imports it, then opens its first page. */
  const importExport = (chosen: File) => {
    setBusy('import');
    setMessage(null);
    void chosen
      .arrayBuffer()
      .then(async (buffer) => {
        const { importZip } = await import('./exchange');
        const first = await importZip(
          session,
          new Uint8Array(buffer),
          t('exchange.importedSuffix'),
        );
        setMessage(t('exchange.imported'));
        if (first) navigate({ kind: 'page', pageId: first });
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
        <button
          type="button"
          className="cgw-button"
          disabled={busy !== null || !session.workspaceId}
          onClick={() => {
            setBusy('export');
            setMessage(null);
            exportAndSave(
              session,
              (n, b, ty) => platform.saveFile(n, b, ty),
              t('page.untitled'),
              undefined,
              databases?.people(),
              workspace && collaborates(collab, session, workspace.id)
                ? collab!.people(workspace.id).name
                : undefined,
            )
              .then(() => setMessage(t('exchange.exported')))
              .catch((error: unknown) => {
                console.error(error);
                setMessage(t('exchange.exportFailed'));
              })
              .finally(() => setBusy(null));
          }}
        >
          {t('exchange.exportWorkspace')}
        </button>
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
        <button
          type="button"
          className="cgw-button"
          // A guest makes no pages of their own (the server refuses them): it is not offered.
          disabled={busy !== null || !session.workspaceId || workspace?.role === 'guest'}
          onClick={() => setImporting(true)}
        >
          {t('exchange.importOther')}
        </button>
      </div>
      {importing && (
        <Suspense fallback={null}>
          <ImportPanel session={session} onClose={() => setImporting(false)} />
        </Suspense>
      )}
      {message && (
        <p role="status" className="cgw-data-message">
          {message}
        </p>
      )}
    </section>
  );
}
