// Settings → Your data: export the workspace (from this device, or from the account as the server
// makes it), import an export, and what the browser keeps.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccount, useCloud } from '../cloud/CloudUi';
import { useShell } from '../context';
import { collaborates, useCollab } from '../collab/context';
import { useDatabaseHost } from '../database/context';
import { navigate } from '../route';
import type { WorkspaceSession } from '../session';

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
  const file = useRef<HTMLInputElement>(null);

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
        <button
          type="button"
          className="cgw-button"
          disabled={busy !== null}
          onClick={() => file.current?.click()}
        >
          {t('exchange.import')}
        </button>
        <input
          ref={file}
          type="file"
          accept=".zip,application/zip"
          hidden
          aria-label={t('exchange.import')}
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            event.target.value = '';
            if (!chosen) return;
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
          }}
        />
      </div>
      {message && (
        <p role="status" className="cgw-data-message">
          {message}
        </p>
      )}
    </section>
  );
}
