// Settings → Single sign-on (Phase 11, M11.3), for the workspace's owners only (admins, members and
// guests never see it, and a workspace on this device only has none): the redirect address to
// register at the provider, the provider (issuer, client ID, a client secret that is sent and never
// shown again, whether people of the domains join as members, how long a session through it
// lasts), and the domains, each proven by a TXT record and then, once an owner has signed in
// through the provider, sign-on required for it (asked first: it signs out the domain's people who
// signed in another way, owners excepted). Removing the provider or a domain asks first. Loaded
// with Settings, not with the app. The server decides every request, and each refusal has its
// words; a stale version or something removed meanwhile reads the settings again.
import { CgCheckBox, CgSwitch } from '@cashgear/ui';
import { SyncHttpError, type Id, type WorkspaceRecord } from '@cgw/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../Dialog';
import { useSection } from '../i18n/sections';
import type { WorkspaceSession } from '../session';
import { useAccount } from './CloudUi';
import type { Cloud } from './cloud';
import {
  SESSION_HOURS,
  ssoHost,
  type ProviderChange,
  type SsoDomain,
  type SsoHost,
  type SsoProvider,
  type SsoSettings as Settings,
} from './sso';
import { ssoWords } from './ssoWords';
import './sso.css';

/**
 * The protocol's name, which no language translates; it and what is registered elsewhere as it is
 * (addresses, domains, records) are marked `lang="en"`, so a screen reader reads them as written.
 */
const PROTOCOL = 'OpenID Connect';

/** A refusal's words, by the server's code and what was asked (the provider, or a domain). */
export function ssoRefusalKey(code: string, about: 'provider' | 'domain') {
  switch (code) {
    case 'sso.domainTaken':
      return 'sso.domainTaken' as const;
    case 'sso.dnsNotFound':
      return 'sso.dnsNotFound' as const;
    case 'sso.notTested':
      return 'sso.notTested' as const;
    case 'sso.discoveryFailed':
      return 'sso.discoveryFailed' as const;
    case 'version.conflict':
      return 'sso.stale' as const;
    case 'request.invalid':
      return about === 'provider'
        ? ('sso.invalidProvider' as const)
        : ('sso.invalidDomain' as const);
    case 'access.denied':
      return 'sso.denied' as const;
    case 'conflict':
      return about === 'domain' ? ('sso.domainAdded' as const) : ('sso.stale' as const);
    case 'not.found':
      return about === 'domain' ? ('sso.domainGone' as const) : ('sso.providerGone' as const);
    default:
      return 'cloud.requestFailed' as const;
  }
}

const codeOf = (error: unknown) => (error instanceof SyncHttpError ? error.code : 'server.error');

/** The provider's form as typed: the secret field stays empty unless a new one is typed. */
export interface ProviderDraft {
  issuer: string;
  clientId: string;
  /** A new secret typed; empty keeps the one set (or none). */
  secret: string;
  /** "Remove the secret" pressed: the save sends null. */
  removeSecret: boolean;
  joinAsMember: boolean;
  /** As typed, checked by `hoursOf`. */
  hours: string;
}

export const draftOf = (provider: SsoProvider | null): ProviderDraft => ({
  issuer: provider?.issuer ?? '',
  clientId: provider?.clientId ?? '',
  secret: '',
  removeSecret: false,
  joinAsMember: provider?.joinAsMember ?? true,
  hours: String(provider?.sessionHours ?? SESSION_HOURS.initial),
});

/** Whole hours from 1 to 720, else null. */
export function hoursOf(text: string): number | null {
  const value = text.trim();
  if (!/^\d{1,3}$/.test(value)) return null;
  const hours = Number(value);
  return hours >= SESSION_HOURS.min && hours <= SESSION_HOURS.max ? hours : null;
}

/** What a save sends: a typed secret sets it, "Remove the secret" removes it, else it is kept. */
export function changeOf(draft: ProviderDraft): ProviderChange {
  const secret = draft.secret.trim();
  return {
    issuer: draft.issuer.trim(),
    clientId: draft.clientId.trim(),
    joinAsMember: draft.joinAsMember,
    sessionHours: hoursOf(draft.hours) ?? SESSION_HOURS.initial,
    ...(secret ? { clientSecret: secret } : draft.removeSecret ? { clientSecret: null } : {}),
  };
}

type Ask =
  | { kind: 'removeProvider' }
  | { kind: 'require'; domain: string }
  | { kind: 'removeDomain'; domain: string };

/** The section for the open workspace, after Members (Settings draws it for a synced one). */
export function SsoSection({ cloud, session }: { cloud: Cloud; session: WorkspaceSession }) {
  const account = useAccount(cloud);
  const workspace = session.current;
  const workspaceId: Id | undefined = workspace?.id;
  const host = useMemo(
    () => (workspaceId ? ssoHost(cloud, workspaceId) : null),
    [cloud, workspaceId],
  );
  if (!account || !workspace || workspace.localOnly || !host) return null;
  return <SsoSettings key={workspace.id} host={host} role={workspace.role} />;
}

export function SsoSettings({ host, role }: { host: SsoHost; role: WorkspaceRecord['role'] }) {
  // This screen's words come with it (i18n/sections.ts), before anything below reads them.
  useSection(ssoWords);
  const { t, i18n } = useTranslation();
  const owner = role === 'owner';
  const [settings, setSettings] = useState<Settings | null>(null);
  const [failed, setFailed] = useState(false);
  const [reading, setReading] = useState(0);
  const [draft, setDraft] = useState<ProviderDraft>(() => draftOf(null));
  const [newDomain, setNewDomain] = useState('');
  const [asking, setAsking] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [providerMessage, setProviderMessage] = useState<string | null>(null);
  const [domainsMessage, setDomainsMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /** The provider's version the form was last filled from ('none' without one). */
  const filledFrom = useRef<string | null>(null);
  const dates = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language],
  );
  const numbers = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const when = (iso: string) => dates.format(new Date(iso));

  // The form follows the provider as saved: when first read, and whenever its version moves (a
  // save here, another owner's, its removal); a read that finds the same version keeps the typing.
  const fill = (provider: SsoProvider | null) => {
    const version = provider ? String(provider.version) : 'none';
    if (filledFrom.current === version) return;
    filledFrom.current = version;
    setDraft(draftOf(provider));
  };

  useEffect(() => {
    if (!owner) return;
    let live = true;
    host.read().then(
      (answer) => {
        if (!live) return;
        setSettings(answer);
        setFailed(false);
        fill(answer.provider);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [host, owner, reading]);

  if (!owner) return null;
  const reload = () => setReading((n) => n + 1);
  const provider = settings?.provider ?? null;
  const hours = hoursOf(draft.hours);
  const limits = {
    min: numbers.format(SESSION_HOURS.min),
    max: numbers.format(SESSION_HOURS.max),
  };
  const canSave = !busy && !!draft.issuer.trim() && !!draft.clientId.trim() && hours !== null;

  const refused = (
    error: unknown,
    about: 'provider' | 'domain',
    values: { domain?: string; issuer?: string } = {},
  ) => {
    const code = codeOf(error);
    const text = t(ssoRefusalKey(code, about), {
      domain: values.domain ?? '',
      issuer: values.issuer ?? '',
    });
    (about === 'provider' ? setProviderMessage : setDomainsMessage)(text);
    // Changed or removed meanwhile, or the role changed: shown again as the server holds it.
    if (['version.conflict', 'not.found', 'conflict', 'access.denied'].includes(code)) reload();
  };

  const copy = (key: string, text: string, about: 'provider' | 'domain') => {
    const failedCopy = () =>
      (about === 'provider' ? setProviderMessage : setDomainsMessage)(t('sso.copyFailed'));
    if (!navigator.clipboard) return failedCopy();
    void navigator.clipboard.writeText(text).then(() => setCopied(key), failedCopy);
  };

  const save = async () => {
    const change = changeOf(draft);
    setBusy(true);
    setProviderMessage(null);
    try {
      const saved = await host.setProvider(change, provider?.version);
      setSettings((current) => (current ? { ...current, provider: saved } : current));
      fill(saved);
      setProviderMessage(t('sso.saved'));
    } catch (error) {
      refused(error, 'provider', { issuer: change.issuer });
    } finally {
      setBusy(false);
    }
  };

  const removeProvider = async () => {
    setBusy(true);
    try {
      await host.removeProvider();
      setProviderMessage(t('sso.providerRemoved'));
      reload();
    } catch (error) {
      refused(error, 'provider');
    } finally {
      setAsking(null);
      setBusy(false);
    }
  };

  const replace = (next: SsoDomain) =>
    setSettings((current) =>
      current
        ? {
            ...current,
            domains: current.domains.some((d) => d.domain === next.domain)
              ? current.domains.map((d) => (d.domain === next.domain ? next : d))
              : [...current.domains, next],
          }
        : current,
    );

  const addDomain = async () => {
    const domain = newDomain.trim();
    if (!domain) return;
    setBusy(true);
    setDomainsMessage(null);
    try {
      const added = await host.addDomain(domain);
      replace(added);
      setNewDomain('');
      setDomainsMessage(t('sso.added', { domain: added.domain }));
    } catch (error) {
      refused(error, 'domain', { domain });
    } finally {
      setBusy(false);
    }
  };

  const verify = async (domain: string) => {
    setBusy(true);
    setDomainsMessage(null);
    try {
      replace(await host.verifyDomain(domain));
      setDomainsMessage(t('sso.verified', { domain }));
    } catch (error) {
      refused(error, 'domain', { domain });
    } finally {
      setBusy(false);
    }
  };

  const setRequired = async (domain: string, required: boolean) => {
    setBusy(true);
    setDomainsMessage(null);
    try {
      replace(await host.requireDomain(domain, required));
      setDomainsMessage(t(required ? 'sso.requiredOn' : 'sso.requiredOff', { domain }));
      // The provider's test is read again with it (an owner's sign-in elsewhere set it).
      if (required) reload();
    } catch (error) {
      refused(error, 'domain', { domain });
    } finally {
      setAsking(null);
      setBusy(false);
    }
  };

  const removeDomain = async (domain: string) => {
    setBusy(true);
    setDomainsMessage(null);
    try {
      await host.removeDomain(domain);
      setSettings((current) =>
        current
          ? { ...current, domains: current.domains.filter((d) => d.domain !== domain) }
          : current,
      );
      setDomainsMessage(t('sso.removed', { domain }));
    } catch (error) {
      refused(error, 'domain', { domain });
    } finally {
      setAsking(null);
      setBusy(false);
    }
  };

  const copyButton = (key: string, text: string, what: string, about: 'provider' | 'domain') => (
    <button
      type="button"
      className="cgw-button"
      aria-label={t(copied === key ? 'sso.copied' : 'sso.copy', { what })}
      data-testid={`sso-copy-${key}`}
      onClick={() => copy(key, text, about)}
    >
      {t(copied === key ? 'share.copied' : 'share.copy')}
    </button>
  );

  return (
    <section className="cgw-sso" aria-labelledby="cgw-sso-title" data-testid="sso-settings">
      <h2 id="cgw-sso-title">{t('sso.title')}</h2>
      <p className="cgw-muted">{t('sso.intro')}</p>
      <p className="cgw-muted">
        {t('sso.protocol')}{' '}
        <span lang="en" dir="ltr">
          {PROTOCOL}
        </span>
      </p>
      {!settings ? (
        failed && <p className="cgw-muted">{t('sso.loadFailed')}</p>
      ) : (
        <>
          <section
            className="cgw-sso-part"
            aria-labelledby="cgw-sso-provider-title"
            data-testid="sso-provider"
          >
            <h3 id="cgw-sso-provider-title">{t('sso.providerTitle')}</h3>
            <div className="cgw-sso-field" role="group" aria-labelledby="cgw-sso-redirect-label">
              <span id="cgw-sso-redirect-label">{t('sso.redirect')}</span>
              <p className="cgw-muted">{t('sso.redirectNote')}</p>
              <div className="cgw-sso-copyable">
                <code lang="en" dir="ltr" className="cgw-sso-value" data-testid="sso-redirect">
                  {settings.redirectUri}
                </code>
                {copyButton('redirect', settings.redirectUri, t('sso.whatRedirect'), 'provider')}
              </div>
            </div>
            <form
              className="cgw-sso-form"
              noValidate
              data-testid="sso-provider-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (canSave) void save();
              }}
            >
              <div className="cgw-sso-field">
                <label htmlFor="cgw-sso-issuer">{t('sso.issuer')}</label>
                <input
                  id="cgw-sso-issuer"
                  className="cgw-input"
                  dir="ltr"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={500}
                  aria-describedby="cgw-sso-issuer-note"
                  value={draft.issuer}
                  onChange={(event) => setDraft({ ...draft, issuer: event.target.value })}
                />
                <p id="cgw-sso-issuer-note" className="cgw-muted">
                  {t('sso.issuerNote')}
                </p>
              </div>
              <div className="cgw-sso-field">
                <label htmlFor="cgw-sso-client">{t('sso.clientId')}</label>
                <input
                  id="cgw-sso-client"
                  className="cgw-input"
                  dir="ltr"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={256}
                  value={draft.clientId}
                  onChange={(event) => setDraft({ ...draft, clientId: event.target.value })}
                />
              </div>
              <div className="cgw-sso-field">
                <label htmlFor="cgw-sso-secret">{t('sso.clientSecret')}</label>
                <p id="cgw-sso-secret-state" className="cgw-muted" data-testid="sso-secret-state">
                  {draft.removeSecret
                    ? t('sso.secretRemoving')
                    : provider?.hasSecret
                      ? t('sso.secretSet')
                      : t('sso.secretNone')}
                </p>
                <div className="cgw-sso-row">
                  <input
                    id="cgw-sso-secret"
                    className="cgw-input"
                    type="password"
                    dir="ltr"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={500}
                    aria-describedby="cgw-sso-secret-state"
                    value={draft.secret}
                    onChange={(event) =>
                      setDraft({ ...draft, secret: event.target.value, removeSecret: false })
                    }
                  />
                  {provider?.hasSecret &&
                    (draft.removeSecret ? (
                      <button
                        type="button"
                        className="cgw-button"
                        onClick={() => setDraft({ ...draft, removeSecret: false })}
                      >
                        {t('sso.keepSecret')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="cgw-button"
                        onClick={() => setDraft({ ...draft, secret: '', removeSecret: true })}
                      >
                        {t('sso.removeSecret')}
                      </button>
                    ))}
                </div>
              </div>
              <CgCheckBox
                label={t('sso.join')}
                description={t('sso.joinNote')}
                checked={draft.joinAsMember}
                onCheckedChange={(checked) =>
                  setDraft({ ...draft, joinAsMember: checked === true })
                }
              />
              <div className="cgw-sso-field">
                <label htmlFor="cgw-sso-hours">{t('sso.hours')}</label>
                <input
                  id="cgw-sso-hours"
                  className="cgw-input cgw-sso-hours"
                  type="number"
                  min={SESSION_HOURS.min}
                  max={SESSION_HOURS.max}
                  step={1}
                  inputMode="numeric"
                  aria-describedby="cgw-sso-hours-note"
                  aria-invalid={hours === null || undefined}
                  value={draft.hours}
                  onChange={(event) => setDraft({ ...draft, hours: event.target.value })}
                />
                <p id="cgw-sso-hours-note" className="cgw-muted">
                  {hours === null ? t('sso.hoursInvalid', limits) : t('sso.hoursNote', limits)}
                </p>
              </div>
              {provider && (
                <p className="cgw-muted" data-testid="sso-tested">
                  {provider.testedAt
                    ? t('sso.tested', { when: when(provider.testedAt) })
                    : t('sso.untested')}
                </p>
              )}
              <div className="cgw-sso-buttons">
                <button
                  type="submit"
                  className="cgw-button is-primary"
                  data-testid="sso-save"
                  disabled={!canSave}
                >
                  {t('sso.save')}
                </button>
                {provider && (
                  <button
                    type="button"
                    className="cgw-button is-danger"
                    disabled={busy}
                    onClick={() => setAsking({ kind: 'removeProvider' })}
                  >
                    {t('sso.removeProvider')}
                  </button>
                )}
              </div>
            </form>
            {providerMessage && (
              <p role="status" className="cgw-muted" data-testid="sso-provider-status">
                {providerMessage}
              </p>
            )}
          </section>

          <section
            className="cgw-sso-part"
            aria-labelledby="cgw-sso-domains-title"
            data-testid="sso-domains"
          >
            <h3 id="cgw-sso-domains-title">{t('sso.domainsTitle')}</h3>
            <p className="cgw-muted">{t('sso.domainsIntro')}</p>
            {settings.domains.length === 0 ? (
              <p className="cgw-muted">{t('sso.domainsNone')}</p>
            ) : (
              <ul className="cgw-list" data-testid="sso-domain-list">
                {settings.domains.map((d) => (
                  <li key={d.domain} className="cgw-sso-domain" data-sso-domain={d.domain}>
                    <div className="cgw-sso-domain-head">
                      <strong lang="en" dir="ltr" className="cgw-sso-name">
                        {d.domain}
                      </strong>
                      <span className="cgw-muted">
                        {d.verifiedAt
                          ? t('sso.verifiedOn', { when: when(d.verifiedAt) })
                          : t('sso.unverified')}
                      </span>
                      <button
                        type="button"
                        className="cgw-button is-danger"
                        aria-label={t('sso.removeLabel', { domain: d.domain })}
                        disabled={busy}
                        onClick={() => setAsking({ kind: 'removeDomain', domain: d.domain })}
                      >
                        {t('sso.remove')}
                      </button>
                    </div>
                    {d.verifiedAt ? (
                      <CgSwitch
                        label={t('sso.require')}
                        aria-label={t('sso.requireLabel', { domain: d.domain })}
                        description={t('sso.requireNote')}
                        checked={d.required}
                        disabled={busy}
                        data-testid="sso-require"
                        onCheckedChange={(on) =>
                          on
                            ? setAsking({ kind: 'require', domain: d.domain })
                            : void setRequired(d.domain, false)
                        }
                      />
                    ) : (
                      <>
                        <p>{t('sso.recordIntro')}</p>
                        <dl className="cgw-sso-record">
                          <div>
                            <dt>{t('sso.recordName')}</dt>
                            <dd>
                              <code
                                lang="en"
                                dir="ltr"
                                className="cgw-sso-value"
                                data-testid="sso-record-name"
                              >
                                {d.record.name}
                              </code>
                              {copyButton(
                                `name-${d.domain}`,
                                d.record.name,
                                t('sso.whatName', { domain: d.domain }),
                                'domain',
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>{t('sso.recordValue')}</dt>
                            <dd>
                              <code
                                lang="en"
                                dir="ltr"
                                className="cgw-sso-value"
                                data-testid="sso-record-value"
                              >
                                {d.record.value}
                              </code>
                              {copyButton(
                                `value-${d.domain}`,
                                d.record.value,
                                t('sso.whatValue', { domain: d.domain }),
                                'domain',
                              )}
                            </dd>
                          </div>
                        </dl>
                        <div>
                          <button
                            type="button"
                            className="cgw-button"
                            aria-label={t('sso.verifyLabel', { domain: d.domain })}
                            disabled={busy}
                            onClick={() => void verify(d.domain)}
                          >
                            {t('sso.verify')}
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <form
              className="cgw-inline-form"
              noValidate
              data-testid="sso-domain-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy) void addDomain();
              }}
            >
              <label htmlFor="cgw-sso-domain">{t('sso.domain')}</label>
              <input
                id="cgw-sso-domain"
                className="cgw-input"
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                maxLength={253}
                value={newDomain}
                onChange={(event) => setNewDomain(event.target.value)}
              />
              <button type="submit" className="cgw-button" disabled={busy || !newDomain.trim()}>
                {t('sso.add')}
              </button>
            </form>
            {domainsMessage && (
              <p role="status" className="cgw-muted" data-testid="sso-domains-status">
                {domainsMessage}
              </p>
            )}
          </section>
        </>
      )}
      {asking?.kind === 'removeProvider' && (
        <Dialog
          role="alertdialog"
          title={t('sso.removeProviderTitle')}
          onClose={() => setAsking(null)}
        >
          <p>{t('sso.removeProviderBody')}</p>
          <div className="cgw-dialog-buttons">
            <button type="button" className="cgw-button" onClick={() => setAsking(null)}>
              {t('frame.cancel')}
            </button>
            <button
              type="button"
              className="cgw-button is-danger"
              disabled={busy}
              onClick={() => void removeProvider()}
            >
              {t('sso.removeProvider')}
            </button>
          </div>
        </Dialog>
      )}
      {asking?.kind === 'require' && (
        <Dialog
          role="alertdialog"
          title={t('sso.requireTitle', { domain: asking.domain })}
          onClose={() => setAsking(null)}
        >
          <p>{t('sso.requireBody', { domain: asking.domain })}</p>
          <div className="cgw-dialog-buttons">
            <button type="button" className="cgw-button" onClick={() => setAsking(null)}>
              {t('frame.cancel')}
            </button>
            <button
              type="button"
              className="cgw-button is-danger"
              disabled={busy}
              onClick={() => void setRequired(asking.domain, true)}
            >
              {t('sso.requireConfirm')}
            </button>
          </div>
        </Dialog>
      )}
      {asking?.kind === 'removeDomain' && (
        <Dialog
          role="alertdialog"
          title={t('sso.removeDomainTitle', { domain: asking.domain })}
          onClose={() => setAsking(null)}
        >
          <p>{t('sso.removeDomainBody')}</p>
          <div className="cgw-dialog-buttons">
            <button type="button" className="cgw-button" onClick={() => setAsking(null)}>
              {t('frame.cancel')}
            </button>
            <button
              type="button"
              className="cgw-button is-danger"
              disabled={busy}
              onClick={() => void removeDomain(asking.domain)}
            >
              {t('sso.removeDomainConfirm')}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
