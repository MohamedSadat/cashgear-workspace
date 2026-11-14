// The settings section "Cash Gear ERP": the workspace's links to ERP companies, this tab's
// session for each (and "Disconnect"), "Unlink" for owners and admins (the server checks it
// again), and how a link is made, which starts in the ERP.
import { CgButton } from '@cashgear/ui';
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react';
import { useErpT } from '../i18n';
import type { ErpSessionState } from '../session';
import type { ErpLinkInfo, ErpSessionsApi, ErpSettingsHost } from './host';
import './erp.css';

export function ErpSettings({ host }: { host: ErpSettingsHost }) {
  const { t } = useErpT();
  const titleId = useId();
  const { connection } = host;
  const links = useSyncExternalStore(connection.subscribe, connection.links, connection.links);
  const online = useSyncExternalStore(connection.subscribe, connection.online, connection.online);
  // Read the first time, and again for another workspace or account.
  const linksLoading = links.status === 'loading';
  useEffect(() => {
    if (online && linksLoading) connection.loadLinks();
  }, [connection, online, linksLoading]);
  return (
    <section aria-labelledby={titleId} className="cgw-erp-settings" data-testid="erp-settings">
      <h2 id={titleId}>{t('settingsTitle')}</h2>
      <p className="cgw-erp-muted">{t('settingsIntro')}</p>
      {!online && links.status !== 'ready' ? (
        <p role="status">{t('offline')}</p>
      ) : links.status === 'loading' ? (
        <p role="status" aria-busy="true">
          {t('loading')}
        </p>
      ) : links.status === 'failed' ? (
        <p role="status">
          {t('linksFailed')}{' '}
          <CgButton appearance="ghost" size="small" onClick={() => connection.reloadLinks()}>
            {t('retry')}
          </CgButton>
        </p>
      ) : links.links.length === 0 ? (
        <p data-testid="erp-settings-none">{t('settingsNone')}</p>
      ) : (
        <ul className="cgw-erp-links" data-testid="erp-links">
          {links.links.map((link) => (
            <LinkRow key={link.id} host={host} link={link} />
          ))}
        </ul>
      )}
      <p className="cgw-erp-muted">{t('howToLink')}</p>
      {host.openErp && (
        <div className="cgw-erp-actions">
          <CgButton appearance="outline" onClick={host.openErp}>
            {t('openErp')}
          </CgButton>
        </div>
      )}
    </section>
  );
}

function useLinkState(sessions: ErpSessionsApi | null, linkId: string): ErpSessionState {
  const subscribe = useCallback(
    (onChange: () => void) =>
      sessions ? sessions.subscribe((id) => id === linkId && onChange()) : () => undefined,
    [sessions, linkId],
  );
  const read = useCallback(() => sessions?.state(linkId) ?? 'none', [sessions, linkId]);
  return useSyncExternalStore(subscribe, read, read);
}

function LinkRow({ host, link }: { host: ErpSettingsHost; link: ErpLinkInfo }) {
  const { t, locale } = useErpT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const state = useLinkState(host.sessions, link.id);
  const info = state === 'connected' ? host.sessions?.session(link.id) : null;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
    new Date(link.linkedAt),
  );
  return (
    <li className="cgw-erp-link" data-link={link.id}>
      <div className="cgw-erp-link-main">
        <span className="cgw-erp-title" dir="auto">
          {link.companyName}
        </span>
        <span className="cgw-erp-muted">
          {t('settingsLinkedBy', { name: link.linkedBy?.name ?? '', date })}
        </span>
        <span className="cgw-erp-muted" data-testid="erp-link-session">
          {info ? t('connectedHere', { user: info.user.displayName }) : t('notConnectedHere')}
        </span>
      </div>
      <div className="cgw-erp-actions">
        {info && host.sessions && (
          <CgButton
            appearance="ghost"
            size="small"
            aria-label={t('disconnectNamed', { company: link.companyName })}
            onClick={() => host.sessions?.disconnect(link.id)}
          >
            {t('disconnect')}
          </CgButton>
        )}
        {host.canManage && !confirming && (
          <CgButton
            appearance="outline"
            size="small"
            aria-label={t('unlinkNamed', { company: link.companyName })}
            onClick={() => {
              setFailed(false);
              setConfirming(true);
            }}
          >
            {t('unlink')}
          </CgButton>
        )}
      </div>
      {confirming && (
        <div
          className="cgw-erp-confirm"
          role="group"
          aria-label={t('unlinkNamed', { company: link.companyName })}
        >
          <p>{t('unlinkConfirm', { company: link.companyName })}</p>
          <div className="cgw-erp-actions">
            <CgButton
              intent="danger"
              size="small"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await host.unlink(link);
                  host.sessions?.disconnect(link.id);
                } catch {
                  setFailed(true);
                } finally {
                  setBusy(false);
                  setConfirming(false);
                }
              }}
            >
              {t('unlink')}
            </CgButton>
            <CgButton appearance="ghost" size="small" onClick={() => setConfirming(false)}>
              {t('cancel')}
            </CgButton>
          </div>
        </div>
      )}
      {failed && (
        <p role="alert" className="cgw-erp-invalid">
          {t('unlinkFailed')}
        </p>
      )}
    </li>
  );
}
