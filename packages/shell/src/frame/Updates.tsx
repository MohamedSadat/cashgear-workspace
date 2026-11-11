// Desktop updates, as Sheet does: the release feed is checked a little after start and every six
// hours. A newer version waits for the person, who installs it from the button in the top bar;
// the installer then closes the app and starts the new version. Settings can check at once.
import { CgButton } from '@cashgear/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../Dialog';
import type { PlatformUpdates, UpdateInfo } from '../platform';

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 6 * 3600_000;

export interface UpdatesState {
  /** False in a browser: there is nothing to update. */
  supported: boolean;
  /** The installed version, once known. */
  version: string | null;
  /** The newer version waiting, or null. */
  available: UpdateInfo | null;
  /** While installing: the download so far, 0 to 1 (null while unknown). */
  installing: { fraction: number | null } | null;
  error: string | null;
  check(): Promise<UpdateInfo | null>;
  install(): Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function useUpdates(
  updates: PlatformUpdates | undefined,
  beforeInstall: () => Promise<void>,
): UpdatesState {
  const [version, setVersion] = useState<string | null>(null);
  const [available, setAvailable] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState<UpdatesState['installing']>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!updates) return;
    void updates.version().then(setVersion, () => undefined);
  }, [updates]);

  const check = useCallback(async () => {
    if (!updates) return null;
    const found = await updates.check();
    setAvailable(found);
    return found;
  }, [updates]);

  useEffect(() => {
    if (!updates) return;
    // A feed that cannot be reached is no news: the next check tries again.
    const quiet = () => void check().catch((cause) => console.warn('Update check:', cause));
    const first = setTimeout(quiet, FIRST_CHECK_MS);
    const timer = setInterval(quiet, CHECK_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [updates, check]);

  const install = useCallback(async () => {
    if (!updates) return;
    setError(null);
    setInstalling({ fraction: null });
    try {
      // Nothing typed is lost: pending saves are written before the installer closes the app.
      await beforeInstall();
      await updates.install((received, total) =>
        setInstalling({ fraction: total ? received / total : null }),
      );
    } catch (cause) {
      setError(message(cause));
      setInstalling(null);
    }
  }, [updates, beforeInstall]);

  return useMemo(
    () => ({ supported: !!updates, version, available, installing, error, check, install }),
    [updates, version, available, installing, error, check, install],
  );
}

/** The top bar's "Update to 0.1.1" button, and the dialog it opens. */
export function UpdateButton({ updates }: { updates: UpdatesState }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!updates.available) return null;
  const { version, notes } = updates.available;
  return (
    <>
      <CgButton
        appearance="outline"
        size="small"
        data-testid="update-status"
        onClick={() => setOpen(true)}
      >
        {t('updates.button', { version })}
      </CgButton>
      {open && (
        <Dialog
          title={t('updates.title', { version })}
          onClose={() => !updates.installing && setOpen(false)}
        >
          {notes && (
            <div className="cgw-update-notes" dir="auto">
              {notes}
            </div>
          )}
          <p>{t('updates.explain')}</p>
          {updates.error && (
            <p role="alert" className="cgw-update-error">
              {t('updates.failed', { error: updates.error })}
            </p>
          )}
          {updates.installing && (
            <progress
              className="cgw-update-progress"
              aria-label={t('updates.downloading')}
              max={1}
              value={updates.installing.fraction ?? undefined}
            />
          )}
          <div className="cgw-dialog-buttons">
            <CgButton
              appearance="ghost"
              disabled={!!updates.installing}
              onClick={() => setOpen(false)}
            >
              {t('updates.later')}
            </CgButton>
            <CgButton
              intent="primary"
              data-testid="update-install"
              disabled={!!updates.installing}
              onClick={() => void updates.install()}
            >
              {t('updates.install')}
            </CgButton>
          </div>
        </Dialog>
      )}
    </>
  );
}

/** Settings, About: check the feed now, and say what it found. */
export function UpdateCheck({ updates }: { updates: UpdatesState }) {
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'checking' | 'current' | 'found' | 'failed'>('idle');
  if (!updates.supported) return null;
  return (
    <div className="cgw-update-check">
      <CgButton
        appearance="outline"
        disabled={state === 'checking'}
        onClick={() => {
          setState('checking');
          updates.check().then(
            (found) => setState(found ? 'found' : 'current'),
            () => setState('failed'),
          );
        }}
      >
        {t('updates.check')}
      </CgButton>
      <span role="status" data-testid="update-check-result">
        {state === 'checking'
          ? t('updates.checking')
          : state === 'current'
            ? t('updates.current')
            : state === 'found' && updates.available
              ? t('updates.found', { version: updates.available.version })
              : state === 'failed'
                ? t('updates.checkFailed')
                : ''}
      </span>
    </div>
  );
}
