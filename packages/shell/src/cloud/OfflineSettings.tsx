// Settings → Offline (M3.1): the pages kept offline (each can stop being kept), how many of them
// this device holds and how many are still to fetch, and the storage this workspace uses here
// (and, in a browser, what the browser allows the app). Read when the section opens and again on
// the engine's `offline` events; nothing here changes while typing.
import type { Id, OfflineProgress, StorageUsage } from '@cgw/workspace';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShell } from '../context';
import { routeHash } from '../route';
import type { WorkspaceSession } from '../session';
import { useMirror } from '../sidebar/Sidebar';
import type { Cloud } from './cloud';
import { useOfflineRevision } from './CloudUi';

/** Bytes for people: kB, MB or GB, in the interface language. */
function useBytes() {
  const { i18n } = useTranslation();
  return (bytes: number) => {
    const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
      value /= 1000;
      unit++;
    }
    return new Intl.NumberFormat(i18n.language, {
      style: 'unit',
      unit: units[unit],
      unitDisplay: 'short',
      maximumFractionDigits: unit < 2 ? 0 : 1,
    }).format(value);
  };
}

export function OfflineSettings({
  cloud,
  session,
}: {
  cloud: Cloud | null;
  session: WorkspaceSession;
}) {
  const { t, i18n } = useTranslation();
  const { platform } = useShell();
  useMirror(session);
  const revision = useOfflineRevision(cloud);
  const bytes = useBytes();
  const workspace = session.current;
  const workspaceId: Id | null = workspace?.id ?? null;
  const synced = !!cloud && !!workspace && !workspace.localOnly;
  const [progress, setProgress] = useState<OfflineProgress | null>(null);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [browser, setBrowser] = useState<{ usage: number; quota: number } | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void session.store.storageUsage(workspaceId).then(
      (answer) => live && setUsage(answer),
      () => live && setUsage(null),
    );
    if (synced)
      void cloud.engine.offlineProgress(workspaceId).then(
        (answer) => live && setProgress(answer),
        () => live && setProgress(null),
      );
    else setProgress(null);
    if (platform.kind === 'web' && navigator.storage?.estimate)
      void navigator.storage.estimate().then(
        (estimate) =>
          live &&
          setBrowser(estimate.quota ? { usage: estimate.usage ?? 0, quota: estimate.quota } : null),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [cloud, session, workspaceId, synced, revision, platform]);

  if (!workspace) return null;
  const pins = synced ? cloud.offline.pinList() : [];
  return (
    <section aria-labelledby="cgw-offline-title">
      <h2 id="cgw-offline-title">{t('offline.title')}</h2>
      {!synced ? (
        <p className="cgw-muted">{t('offline.localOnly')}</p>
      ) : (
        <>
          <p className="cgw-muted">{t('offline.intro')}</p>
          {pins.length === 0 ? (
            <p>{t('offline.none')}</p>
          ) : (
            <>
              {progress && (
                <p role="status" data-testid="offline-progress">
                  {progress.toFetch > 0
                    ? t('offline.progress', {
                        held: progress.held,
                        pinned: progress.pinned,
                        toFetch: progress.toFetch,
                      })
                    : t('offline.progressDone', { pinned: progress.pinned })}
                </p>
              )}
              <ul className="cgw-list" data-testid="offline-pins">
                {pins.map((pin) => {
                  const page = session.mirror.pages.get(pin.pageId);
                  const title = page?.title || t('page.untitled');
                  return (
                    <li key={pin.pageId} className="cgw-list-row">
                      <span>
                        <span aria-hidden="true">{page?.icon ?? '📄'} </span>
                        <a href={routeHash({ kind: 'page', pageId: pin.pageId })} dir="auto">
                          {title}
                        </a>
                        <span className="cgw-muted">
                          {' · '}
                          {t(pin.subtree ? 'offline.pinnedSubtree' : 'offline.pinnedPage')}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="cgw-button"
                        aria-label={t('offline.removeLabel', { title })}
                        onClick={() =>
                          void cloud.offline
                            .unpin(pin.pageId)
                            .catch((error: unknown) => console.warn('Unpin failed:', error))
                        }
                      >
                        {t('offline.remove')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {progress && (
            <p className="cgw-muted">{t('offline.available', { count: progress.available })}</p>
          )}
        </>
      )}
      <h3>{t('offline.storage')}</h3>
      {usage && (
        <dl className="cgw-facts" data-testid="storage-usage">
          <dt>{t('offline.storagePages')}</dt>
          <dd>{new Intl.NumberFormat(i18n.language).format(usage.pages)}</dd>
          <dt>{t('offline.storageDocs')}</dt>
          <dd>{bytes(usage.docBytes)}</dd>
          <dt>{t('offline.storageFiles')}</dt>
          <dd>{bytes(usage.assetBytes)}</dd>
          <dt>{t('offline.storageHistory')}</dt>
          <dd>{bytes(usage.historyBytes)}</dd>
          {usage.quarantineBytes > 0 && (
            <>
              <dt>{t('offline.storageSetAside')}</dt>
              <dd>{bytes(usage.quarantineBytes)}</dd>
            </>
          )}
        </dl>
      )}
      {browser && (
        <p className="cgw-muted">
          {t('offline.browserUsage', { usage: bytes(browser.usage), quota: bytes(browser.quota) })}
        </p>
      )}
    </section>
  );
}
