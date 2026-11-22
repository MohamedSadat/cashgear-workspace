// Settings → Publishing → Your own host names (Phase 14, M14.4): owners and admins add a host name,
// are shown the DNS `TXT` record that proves it and the name to point it at, verify it, and remove
// it; each name says whether it is proven, which page's site it serves and its certificate's state.
// The site itself is given a proven name in its share dialog's "Publish to the web". Read again
// when the feed says the workspace's publishing changed (the worker's certificate too). The server
// decides who may do what.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSection } from '../i18n/sections';
import { EXAMPLE_HOST, siteDomainsWords } from './domainsWords';
import {
  publishFailure,
  type CertificateState,
  type PublishingApi,
  type SiteDomain,
  type SiteDomains,
} from './publishing';

export type DomainsApi = Pick<
  PublishingApi,
  'domains' | 'addDomain' | 'verifyDomain' | 'removeDomain'
>;

const REASONS = ['notPointed', 'challenge', 'rateLimited', 'unreachable', 'dns'] as const;
type Reason = (typeof REASONS)[number] | 'failed';

const reasonOf = (code: string | null): Reason =>
  REASONS.includes(code as (typeof REASONS)[number]) ? (code as Reason) : 'failed';

/** A name's certificate in words (also the share dialog's). */
export function useCertificateText() {
  useSection(siteDomainsWords);
  const { t, i18n } = useTranslation();
  const format = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });
  return (state: CertificateState, error: string | null, expiresAt: string | null): string => {
    const reason = t(`siteDomains.reasons.${reasonOf(error)}`);
    if (state === 'live')
      return error
        ? t('siteDomains.certRenewFailed', { reason })
        : t('siteDomains.certLive', { when: expiresAt ? format.format(new Date(expiresAt)) : '' });
    if (state === 'ordering') return t('siteDomains.certOrdering');
    if (state === 'failed') return t('siteDomains.certFailed', { reason });
    return t('siteDomains.certNone');
  };
}

export function SiteDomainsSection({
  api,
  workspaceId,
  changes,
}: {
  api: DomainsApi;
  workspaceId: string;
  changes?: (listener: (workspaceId: string) => void) => () => void;
}) {
  useSection(siteDomainsWords);
  const { t } = useTranslation();
  const certificate = useCertificateText();
  const [read, setRead] = useState<SiteDomains | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'loadFailed' | 'absent'>('loading');
  const [reading, setReading] = useState(0);
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<SiteDomain | null>(null);
  const [message, setMessage] = useState<{ text: string; alert: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    api.domains(workspaceId).then(
      (answer) => {
        if (!live) return;
        setRead(answer);
        setState('ready');
      },
      (error: unknown) => {
        // A server before 0.14.0 has no such route: the section is not offered.
        if (live) setState(publishFailure(error) === 'not.found' ? 'absent' : 'loadFailed');
      },
    );
    return () => {
      live = false;
    };
  }, [api, workspaceId, reading]);

  useEffect(
    () =>
      changes?.((changed) => {
        if (changed === workspaceId) setReading((n) => n + 1);
      }),
    [changes, workspaceId],
  );

  const refused = (error: unknown) => {
    const code = publishFailure(error);
    setMessage({
      alert: true,
      text:
        code === 'request.invalid'
          ? t('siteDomains.invalid', { example: EXAMPLE_HOST })
          : code === 'conflict'
            ? t('siteDomains.exists')
            : code === 'domain.taken'
              ? t('siteDomains.taken')
              : code === 'domain.dnsNotFound'
                ? t('siteDomains.notFound')
                : code === 'access.denied'
                  ? t('siteDomains.denied')
                  : code === 'offline'
                    ? t('publish.offline')
                    : t('siteDomains.failed'),
    });
  };

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await work();
      setMessage({ text, alert: false });
      setReading((n) => n + 1);
    } catch (error) {
      refused(error);
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    run(async () => {
      const made = await api.addDomain(workspaceId, host.trim());
      setHost('');
      return t('siteDomains.added', { host: made.host });
    });

  const domains = read?.domains ?? [];
  if (state === 'absent') return null;
  return (
    <section aria-labelledby="cgw-domains-title" data-testid="site-domains">
      <h4 id="cgw-domains-title">{t('siteDomains.title')}</h4>
      <p className="cgw-muted" id="cgw-domains-intro">
        {t('siteDomains.intro', { example: EXAMPLE_HOST })}
      </p>
      {state === 'loadFailed' ? (
        <p role="alert">
          {t('siteDomains.loadFailed')}{' '}
          <button type="button" className="cgw-button" onClick={() => setReading((n) => n + 1)}>
            {t('mail.retry')}
          </button>
        </p>
      ) : state === 'loading' || !read ? (
        <p aria-busy="true" className="cgw-muted">
          {t('app.loading')}
        </p>
      ) : (
        <>
          {!read.certificates ? (
            <p className="cgw-muted" role="note" data-testid="certificates-off">
              {t('siteDomains.certificatesOff')}
            </p>
          ) : null}
          {domains.length ? (
            <ul className="cgw-domains" data-testid="site-domain-list">
              {domains.map((domain) => (
                <li key={domain.id} data-host={domain.host} className="cgw-domain">
                  <p>
                    <strong dir="ltr">{domain.host}</strong>{' '}
                    <span className="cgw-muted" data-testid="domain-state">
                      {!domain.verifiedAt
                        ? t('siteDomains.unproven')
                        : domain.pageId
                          ? t('siteDomains.serves', {
                              title: domain.pageTitle || t('page.untitled'),
                            })
                          : t('siteDomains.free')}
                    </span>
                  </p>
                  {domain.verifiedAt ? (
                    <p className="cgw-muted" data-testid="domain-certificate">
                      {certificate(
                        domain.certificate,
                        domain.certificateError,
                        domain.certificateExpiresAt,
                      )}
                    </p>
                  ) : (
                    <div className="cgw-domain-record">
                      <p>{t('siteDomains.recordIntro')}</p>
                      <dl>
                        <dt>{t('siteDomains.recordName')}</dt>
                        <dd dir="ltr">
                          <code>{domain.record.name}</code>
                        </dd>
                        <dt>{t('siteDomains.recordValue')}</dt>
                        <dd dir="ltr">
                          <code data-testid="domain-record-value">{domain.record.value}</code>
                        </dd>
                      </dl>
                      <p>{t('siteDomains.pointIntro', { target: domain.target })}</p>
                    </div>
                  )}
                  <p className="cgw-domain-buttons">
                    {!domain.verifiedAt ? (
                      <button
                        type="button"
                        className="cgw-button is-primary"
                        disabled={busy}
                        aria-label={t('siteDomains.verifyLabel', { host: domain.host })}
                        onClick={() =>
                          void run(async () => {
                            const done = await api.verifyDomain(workspaceId, domain.id);
                            return t('siteDomains.verified', { host: done.host });
                          })
                        }
                      >
                        {t('siteDomains.verify')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="cgw-button"
                      disabled={busy}
                      aria-label={t('siteDomains.removeLabel', { host: domain.host })}
                      onClick={() => setRemoving(domain)}
                    >
                      {t('siteDomains.remove')}
                    </button>
                  </p>
                  {removing?.id === domain.id ? (
                    <div
                      role="alertdialog"
                      aria-labelledby={`cgw-domain-remove-${domain.id}`}
                      className="cgw-publish-confirm"
                    >
                      <p id={`cgw-domain-remove-${domain.id}`}>
                        {t('siteDomains.removeAsk', { host: domain.host })}
                      </p>
                      <button
                        type="button"
                        className="cgw-button is-danger"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api.removeDomain(workspaceId, domain.id);
                            setRemoving(null);
                            return t('siteDomains.removed', { host: domain.host });
                          })
                        }
                      >
                        {t('siteDomains.removeNow')}
                      </button>
                      <button
                        type="button"
                        className="cgw-button"
                        disabled={busy}
                        onClick={() => setRemoving(null)}
                      >
                        {t('frame.cancel')}
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="cgw-muted" data-testid="site-domains-none">
              {t('siteDomains.none')}
            </p>
          )}
          <form
            className="cgw-domain-add"
            onSubmit={(event) => {
              event.preventDefault();
              if (host.trim()) void add();
            }}
          >
            <label htmlFor="cgw-domain-host">{t('siteDomains.hostLabel')}</label>
            <input
              id="cgw-domain-host"
              className="cgw-input"
              dir="ltr"
              spellCheck={false}
              autoComplete="off"
              maxLength={253}
              value={host}
              aria-describedby="cgw-domain-host-help"
              onChange={(event) => setHost(event.target.value)}
            />
            <p id="cgw-domain-host-help" className="cgw-muted">
              {t('siteDomains.hostHelp', { example: EXAMPLE_HOST })}
            </p>
            <button type="submit" className="cgw-button" disabled={busy || !host.trim()}>
              {t('siteDomains.add')}
            </button>
          </form>
        </>
      )}
      {message ? (
        <p
          role={message.alert ? 'alert' : 'status'}
          className={message.alert ? 'cgw-publish-problem' : 'cgw-muted'}
          data-testid="site-domains-message"
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
