// Settings → Account's Sign out (2026-11-21). A sign-out leaves the account's synced workspaces on
// this device, hidden from anyone else who uses it (the session shows a signed-in account its own
// workspaces only); ticking the box removes them too, once everything waiting has reached the
// server. Loaded with Settings, not with the app.
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSection } from '../i18n/sections';
import type { Cloud } from './cloud';
import { signOutWords } from './signOutWords';

export function SignOutSection({ cloud }: { cloud: Cloud }) {
  // This screen's words come with it (i18n/sections.ts), before anything below reads them.
  useSection(signOutWords);
  const { t, i18n } = useTranslation();
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const box = useId();
  const note = useId();

  const signOut = async () => {
    if (!remove) return void cloud.signOut();
    setBusy(true);
    setMessage(t('signOut.removing'));
    try {
      const { waiting } = await cloud.signOutAndRemove();
      setMessage(
        waiting
          ? t('signOut.waiting', { number: new Intl.NumberFormat(i18n.language).format(waiting) })
          : null,
      );
    } catch {
      setMessage(t('cloud.requestFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cgw-signout" data-testid="sign-out">
      <p>
        <input
          id={box}
          type="checkbox"
          checked={remove}
          disabled={busy}
          aria-describedby={note}
          data-testid="sign-out-remove"
          onChange={(event) => setRemove(event.target.checked)}
        />{' '}
        <label htmlFor={box}>{t('signOut.remove')}</label>
      </p>
      <p id={note} className="cgw-muted">
        {t('signOut.removeNote')}
      </p>
      <button type="button" className="cgw-button" disabled={busy} onClick={() => void signOut()}>
        {t('cloud.signOut')}
      </button>
      {message && (
        <p role="status" data-testid="sign-out-message">
          {message}
        </p>
      )}
    </div>
  );
}
