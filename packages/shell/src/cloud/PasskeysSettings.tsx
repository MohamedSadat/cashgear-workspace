// Settings → Account → Passkeys (Phase 11, M11.2): the account's passkeys with their names, when
// each was added and last used (in the interface language's dates); rename in place; remove after
// asking (sessions it signed in stay until signed out under Devices); and "Add a passkey", which
// opens the API's own page, where the ceremony runs (this tab on the web, back to Settings, which
// reads the list as it opens; the system browser on the desktop, the list read again when the
// window has the focus back). For anyone signed in: passkeys are the account's. Loaded with
// Settings, not with the app; the server decides every request, and each refusal has its words.
import { SyncHttpError } from '@cgw/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../Dialog';
import { useSection } from '../i18n/sections';
import type { Cloud } from './cloud';
import { PASSKEY_LIMIT, passkeysHost, type Passkey, type PasskeysHost } from './passkeys';
import { passkeysWords } from './passkeysWords';
import './passkeys.css';

/** A refusal's words, by the server's code. */
export function passkeyRefusalKey(code: string) {
  switch (code) {
    case 'request.invalid':
      return 'passkeys.invalid' as const;
    case 'not.found':
      return 'passkeys.gone' as const;
    default:
      return 'cloud.requestFailed' as const;
  }
}

const codeOf = (error: unknown) => (error instanceof SyncHttpError ? error.code : 'server.error');

/** The section over the app's cloud (Settings passes it to Account, which draws it signed in). */
export function PasskeysSection({ cloud }: { cloud: Cloud }) {
  const host = useMemo(() => passkeysHost(cloud), [cloud]);
  return <PasskeysSettings host={host} />;
}

export function PasskeysSettings({ host }: { host: PasskeysHost }) {
  // This screen's words come with it (i18n/sections.ts), before anything below reads them.
  useSection(passkeysWords);
  const { t, i18n } = useTranslation();
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reading, setReading] = useState(0);
  /** The page opened in the system browser: the list is read again as the window comes back. */
  const [away, setAway] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLUListElement>(null);
  const language = i18n.language === 'ar' ? 'ar' : 'en';
  const dates = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language],
  );
  const when = (iso: string) => dates.format(new Date(iso));

  useEffect(() => {
    let live = true;
    host.list().then(
      (list) => {
        if (!live) return;
        setPasskeys(list);
        setFailed(false);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [host, reading]);

  useEffect(() => {
    if (!away) return;
    const again = () => setReading((n) => n + 1);
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [away]);

  // The name's field takes the focus as it opens; once closed, the row's Rename has it back.
  const renamingId = renaming?.id;
  const wasRenaming = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (renamingId) field.current?.focus();
    else if (wasRenaming.current)
      rows.current
        ?.querySelector<HTMLButtonElement>(`[data-passkey-id="${wasRenaming.current}"] button`)
        ?.focus();
    wasRenaming.current = renamingId;
  }, [renamingId]);

  const refused = (error: unknown) => {
    const code = codeOf(error);
    setMessage(t(passkeyRefusalKey(code)));
    // Removed meanwhile (another tab, another device): the list as it is now.
    if (code === 'not.found') {
      setRenaming(null);
      setReading((n) => n + 1);
    }
  };

  const rename = async (passkey: Passkey, name: string) => {
    if (name === passkey.name) {
      setRenaming(null);
      return;
    }
    setBusy(true);
    try {
      const renamed = await host.rename(passkey.id, name);
      setPasskeys((list) => list?.map((p) => (p.id === renamed.id ? renamed : p)) ?? null);
      setRenaming(null);
      setMessage(t('passkeys.renamed', { name: renamed.name }));
    } catch (error) {
      refused(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (passkey: Passkey) => {
    setBusy(true);
    try {
      await host.remove(passkey.id);
      setPasskeys((list) => list?.filter((p) => p.id !== passkey.id) ?? null);
      if (renaming?.id === passkey.id) setRenaming(null);
      setMessage(t('passkeys.removed', { name: passkey.name }));
    } catch (error) {
      refused(error);
    } finally {
      setRemoving(null);
      setBusy(false);
    }
  };

  const add = async () => {
    setBusy(true);
    try {
      if ((await host.add(language)) === 'browser') {
        setAway(true);
        setMessage(t('passkeys.inBrowser'));
      }
    } catch {
      setMessage(t('cloud.requestFailed'));
    } finally {
      setBusy(false);
    }
  };

  const full = !!passkeys && passkeys.length >= PASSKEY_LIMIT;
  return (
    <section
      className="cgw-passkeys"
      aria-labelledby="cgw-passkeys-title"
      data-testid="passkeys-settings"
    >
      <h3 id="cgw-passkeys-title">{t('passkeys.title')}</h3>
      <p className="cgw-muted">{t('passkeys.intro')}</p>
      {passkeys === null ? (
        failed && <p className="cgw-muted">{t('passkeys.loadFailed')}</p>
      ) : passkeys.length === 0 ? (
        <p className="cgw-muted">{t('passkeys.none')}</p>
      ) : (
        <ul ref={rows} className="cgw-list" data-testid="passkeys-list">
          {passkeys.map((passkey) => (
            <li key={passkey.id} className="cgw-list-row" data-passkey-id={passkey.id}>
              {renaming?.id === passkey.id ? (
                <form
                  className="cgw-passkey-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = renaming.name.trim();
                    if (name && !busy) void rename(passkey, name);
                  }}
                >
                  <label htmlFor="cgw-passkey-name">{t('passkeys.name')}</label>
                  <input
                    ref={field}
                    id="cgw-passkey-name"
                    className="cgw-input"
                    maxLength={60}
                    autoComplete="off"
                    value={renaming.name}
                    onChange={(event) => setRenaming({ id: passkey.id, name: event.target.value })}
                  />
                  <button
                    type="submit"
                    className="cgw-button is-primary"
                    disabled={busy || !renaming.name.trim()}
                  >
                    {t('share.save')}
                  </button>
                  <button type="button" className="cgw-button" onClick={() => setRenaming(null)}>
                    {t('frame.cancel')}
                  </button>
                </form>
              ) : (
                <>
                  <span className="cgw-passkey-text">
                    <strong dir="auto" className="cgw-passkey-name">
                      {passkey.name}
                    </strong>
                    <span className="cgw-muted">
                      {t('passkeys.added', { when: when(passkey.createdAt) })} ·{' '}
                      {passkey.lastUsedAt
                        ? t('passkeys.lastUsed', { when: when(passkey.lastUsedAt) })
                        : t('passkeys.neverUsed')}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="cgw-button"
                    aria-label={t('passkeys.renameLabel', { name: passkey.name })}
                    disabled={busy}
                    onClick={() => setRenaming({ id: passkey.id, name: passkey.name })}
                  >
                    {t('passkeys.rename')}
                  </button>
                  <button
                    type="button"
                    className="cgw-button is-danger"
                    aria-label={t('passkeys.removeLabel', { name: passkey.name })}
                    disabled={busy}
                    onClick={() => setRemoving(passkey)}
                  >
                    {t('passkeys.remove')}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div>
        <button
          type="button"
          className="cgw-button"
          data-testid="passkey-add"
          disabled={busy || passkeys === null || full}
          onClick={() => void add()}
        >
          {t('passkeys.add')}
        </button>
      </div>
      {full && (
        <p className="cgw-muted">
          {t('passkeys.full', {
            number: new Intl.NumberFormat(i18n.language).format(PASSKEY_LIMIT),
          })}
        </p>
      )}
      {message && (
        <p role="status" className="cgw-muted" data-testid="passkeys-status">
          {message}
        </p>
      )}
      {removing && (
        <Dialog
          role="alertdialog"
          title={t('passkeys.removeTitle', { name: removing.name })}
          onClose={() => setRemoving(null)}
        >
          <p>{t('passkeys.removeBody')}</p>
          <div className="cgw-dialog-buttons">
            <button type="button" className="cgw-button" onClick={() => setRemoving(null)}>
              {t('frame.cancel')}
            </button>
            <button
              type="button"
              className="cgw-button is-danger"
              disabled={busy}
              onClick={() => void remove(removing)}
            >
              {t('passkeys.removeConfirm')}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
