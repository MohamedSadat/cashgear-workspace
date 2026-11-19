// Settings → Account → Password (Phase 11, M11.3): an account made by single sign-on has no
// password. It is offered "Set a password", which asks the server for the reset mail (the same
// route as the sign-in page's "Forgot your password?"), unless a domain of the account requires
// its organisation's sign-on, where it says so instead (a password would not sign it in). An
// account with a password, and a domain that requires nothing, sees nothing here. What the account
// has is read from `/account/session` as Settings opens. Loaded with Settings, not with the app.
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSection } from '../i18n/sections';
import { useAccount } from './CloudUi';
import type { Cloud } from './cloud';
import { passwordHost, type AccountSignIn, type PasswordHost } from './sso';
import { ssoWords } from './ssoWords';
import './sso.css';

/** The part over the app's cloud (Settings passes it to Account, which draws it signed in). */
export function PasswordSection({ cloud }: { cloud: Cloud }) {
  const account = useAccount(cloud);
  const host = useMemo(() => passwordHost(cloud), [cloud]);
  if (!account) return null;
  return <PasswordSettings key={account.id} host={host} />;
}

export function PasswordSettings({ host }: { host: PasswordHost }) {
  // This screen's words come with it (i18n/sections.ts), before anything below reads them.
  useSection(ssoWords);
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<AccountSignIn | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    host.read().then(
      (answer) => live && setState(answer),
      // Offline or refused: nothing is offered (the rest of Account says the rest).
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [host]);

  if (!state || (state.hasPassword && !state.ssoRequired)) return null;
  const language = i18n.language === 'ar' ? 'ar' : 'en';

  const send = async () => {
    setBusy(true);
    try {
      await host.sendLink(state.email, language);
      setMessage(t('sso.passwordSent', { email: state.email }));
    } catch {
      setMessage(t('cloud.requestFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="cgw-sso-password"
      aria-labelledby="cgw-password-title"
      data-testid="password-settings"
    >
      <h3 id="cgw-password-title">{t('sso.passwordTitle')}</h3>
      {state.ssoRequired ? (
        <p className="cgw-muted" data-testid="password-organisation">
          {t('sso.passwordByOrganisation')}
        </p>
      ) : (
        <>
          <p className="cgw-muted">{t('sso.passwordNone', { email: state.email })}</p>
          <div>
            <button
              type="button"
              className="cgw-button"
              data-testid="password-set"
              disabled={busy}
              onClick={() => void send()}
            >
              {t('sso.setPassword')}
            </button>
          </div>
        </>
      )}
      {message && (
        <p role="status" className="cgw-muted" data-testid="password-status">
          {message}
        </p>
      )}
    </section>
  );
}
