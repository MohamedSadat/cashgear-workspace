// An ERP view block (Level 1, INTEGRATIONS.md): read-only ERP data from the reader's own ERP
// session. It finds the block's link among the workspace's, connects through the tab's sessions
// (a pop-up opened inside the click, or the system browser on the desktop), lets an editor pick
// the connector, fields, filter, sort and page size (each written to the block's attributes),
// and shows the query's records. Every state without data has its own text. What the ERP answers
// lives in React state only: nothing of it reaches the document, a store, a log or a report.
import { CgButton } from '@cashgear/ui';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { ConnectorSummary, ErpError, Language } from '../contract';
import { useErpT } from '../i18n';
import type { ErpSessionState } from '../session';
import { ConnectorView } from './ConnectorView';
import type { ErpLinkInfo, ErpViewHost } from './host';
import { errorText, Message, useWait } from './Message';
import './erp.css';

export interface ErpViewProps {
  host: ErpViewHost;
}

export function ErpView({ host }: ErpViewProps) {
  return (
    <div className="cgw-erp" data-testid="erp-view">
      <ErpBody host={host} />
    </div>
  );
}

function ErpBody({ host }: ErpViewProps) {
  const { t } = useErpT();
  const { connection, attrs } = host;
  const availability = useSyncExternalStore(
    connection.subscribe,
    connection.availability,
    connection.availability,
  );
  const online = useSyncExternalStore(connection.subscribe, connection.online, connection.online);
  const links = useSyncExternalStore(connection.subscribe, connection.links, connection.links);
  const ready = availability === 'ready' && online;
  // The links are read the first time (and again for another workspace or account).
  const linksLoading = links.status === 'loading';
  useEffect(() => {
    if (ready && linksLoading) connection.loadLinks();
  }, [connection, ready, linksLoading]);
  const known =
    links.status === 'ready' && attrs.linkId
      ? (links.links.find((link) => link.id === attrs.linkId) ?? null)
      : undefined;
  // A link this tab does not know may have been made a moment ago elsewhere: read them again.
  const missing = links.status === 'ready' && !!attrs.linkId && !known;
  useEffect(() => {
    if (missing && ready) connection.reloadLinks();
  }, [connection, missing, ready]);

  if (availability === 'checking') return <Message text={t('loading')} busy />;
  if (availability === 'signedOut') return <Message text={t('signIn')} testId="erp-signed-out" />;
  if (availability === 'localWorkspace')
    return <Message text={t('localWorkspace')} testId="erp-local" />;
  if (availability === 'noWorkspace') return <Message text={t('noWorkspace')} />;
  if (!online) return <Message text={t('offline')} testId="erp-offline" />;
  if (links.status === 'loading') return <Message text={t('linksLoading')} busy />;
  if (links.status === 'failed')
    return (
      <Message text={t('linksFailed')} testId="erp-links-failed">
        <CgButton appearance="outline" onClick={() => connection.reloadLinks()}>
          {t('retry')}
        </CgButton>
      </Message>
    );
  if (attrs.linkId) {
    if (!known) return <Message text={t('linkGone')} testId="erp-link-gone" />;
    return <LinkedView host={host} link={known} />;
  }
  // A new block: its link is chosen with its data.
  if (!links.links.length)
    return (
      <Message text={t('noLink')} testId="erp-no-link">
        <p className="cgw-erp-muted">{t('howToLink')}</p>
      </Message>
    );
  if (!host.editable) return <Message text={t('notChosen')} testId="erp-not-chosen" />;
  return <PendingLink host={host} links={links.links} />;
}

/** A block with no link yet, in a workspace with one or more: the company is chosen first. */
function PendingLink({ host, links }: { host: ErpViewHost; links: readonly ErpLinkInfo[] }) {
  const { t } = useErpT();
  const [chosen, setChosen] = useState(links[0]!.id);
  const id = useId();
  const link = links.find((l) => l.id === chosen) ?? links[0]!;
  return (
    <>
      {links.length > 1 && (
        <div className="cgw-erp-company">
          <label htmlFor={id}>{t('company')}</label>
          <select
            id={id}
            className="cgw-erp-select"
            value={link.id}
            onChange={(event) => setChosen(event.target.value)}
          >
            {links.map((l) => (
              <option key={l.id} value={l.id}>
                {l.companyName}
              </option>
            ))}
          </select>
        </div>
      )}
      <LinkedView key={link.id} host={host} link={link} pending />
    </>
  );
}

/** The session's state for one link, live. */
function useSessionState(host: ErpViewHost, linkId: string): ErpSessionState {
  const { sessions } = host;
  const subscribe = useCallback(
    (onChange: () => void) => sessions.subscribe((id) => id === linkId && onChange()),
    [sessions, linkId],
  );
  const read = useCallback(() => sessions.state(linkId), [sessions, linkId]);
  return useSyncExternalStore(subscribe, read, read);
}

function LinkedView({
  host,
  link,
  pending = false,
}: {
  host: ErpViewHost;
  link: ErpLinkInfo;
  /** The block has no link yet: choosing its data writes this one. */
  pending?: boolean;
}) {
  const { t } = useErpT();
  const { sessions, connection } = host;
  const state = useSessionState(host, link.id);
  const error = state === 'error' ? sessions.error(link.id) : null;
  const [closed, setClosed] = useState(false);
  const cancelled = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const wait = useWait(error);

  // Called inside the click: the pop-up opens in it (ErpSessions calls the flow at once).
  const connect = () => {
    setClosed(false);
    cancelled.current = false;
    void sessions
      .connect({ id: link.id, erpLinkId: link.erpLinkId, workspaceId: link.workspaceId })
      .then((next) => {
        // Back to `none` without a cancel here: the person closed the ERP's window.
        if (next === 'none' && !cancelled.current && live.current) setClosed(true);
      });
  };
  const connectButton = (label: 'connect' | 'connectAgain') => (
    <CgButton intent="primary" onClick={connect} disabled={wait > 0}>
      {t(label)}
    </CgButton>
  );

  switch (state) {
    case 'none':
      return (
        <Message
          text={closed ? t('popupClosed') : t('notConnected')}
          testId={closed ? 'erp-popup-closed' : 'erp-not-connected'}
        >
          {connectButton('connect')}
        </Message>
      );
    case 'connecting':
      return (
        <Message
          text={t(connection.connectKind === 'popup' ? 'connectingPopup' : 'connectingBrowser')}
          busy
          testId="erp-connecting"
        >
          <CgButton
            appearance="outline"
            onClick={() => {
              cancelled.current = true;
              sessions.cancel(link.id);
            }}
          >
            {t('cancel')}
          </CgButton>
        </Message>
      );
    case 'expired':
      return (
        <Message text={t('expired')} testId="erp-expired">
          {connectButton('connectAgain')}
        </Message>
      );
    case 'revoked':
      return (
        <Message
          text={t('linkRevoked', { company: link.companyName })}
          testId="erp-revoked"
          error={sessions.error(link.id)}
        />
      );
    case 'error':
      return (
        <Message
          text={errorText(t, error, {
            context: 'connect',
            connectKind: connection.connectKind,
            company: link.companyName,
            waitSeconds: wait,
          })}
          error={error}
          testId="erp-connect-error"
        >
          {connectButton('connectAgain')}
        </Message>
      );
    case 'connected':
      return <Connected host={host} link={link} pending={pending} />;
  }
}

function Connected({
  host,
  link,
  pending,
}: {
  host: ErpViewHost;
  link: ErpLinkInfo;
  pending: boolean;
}) {
  const { t, language: uiLanguage } = useErpT();
  // Labels from the schema in the interface's language: the schema carries both, and the page
  // around the block is in that language (decisions, 2026-11-14, Phase 5).
  const language: Language = uiLanguage;
  const { attrs } = host;
  if (pending || !attrs.connectorId) {
    if (!host.editable) return <Message text={t('notChosen')} testId="erp-not-chosen" />;
    return (
      <ConnectorPicker
        host={host}
        link={link}
        language={language}
        onPick={(connectorId) =>
          host.setAttrs({
            ...(pending ? { linkId: link.id } : {}),
            connectorId,
            fields: null,
            filter: null,
            sort: null,
            pageSize: null,
          })
        }
      />
    );
  }
  return (
    <ConnectorView
      key={`${link.id}/${attrs.connectorId}`}
      host={host}
      link={link}
      connectorId={attrs.connectorId}
      language={language}
    />
  );
}

type Loaded<T> =
  { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; error: ErpError };

/** The connectors this person may view, read when the picker shows. */
export function useConnectors(host: ErpViewHost, linkId: string, tick = 0) {
  const [state, setState] = useState<Loaded<readonly ConnectorSummary[]>>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    host.sessions.connectors(linkId, { signal: controller.signal }).then(
      (value) => !controller.signal.aborted && setState({ status: 'ready', value }),
      (error: ErpError) =>
        !controller.signal.aborted &&
        error.code !== 'aborted' &&
        setState({ status: 'error', error }),
    );
    return () => controller.abort();
  }, [host.sessions, linkId, tick]);
  return state;
}

function ConnectorPicker({
  host,
  link,
  language,
  onPick,
}: {
  host: ErpViewHost;
  link: ErpLinkInfo;
  language: Language;
  onPick: (connectorId: string) => void;
}) {
  const { t } = useErpT();
  const [tick, setTick] = useState(0);
  const connectors = useConnectors(host, link.id, tick);
  const heading = useId();
  const wait = useWait(connectors.status === 'error' ? connectors.error : null);
  if (connectors.status === 'loading') return <Message text={t('loading')} busy />;
  if (connectors.status === 'error')
    return (
      <Message
        text={errorText(t, connectors.error, {
          context: 'read',
          company: link.companyName,
          waitSeconds: wait,
        })}
        error={connectors.error}
        testId="erp-connectors-error"
      >
        <CgButton appearance="outline" disabled={wait > 0} onClick={() => setTick((n) => n + 1)}>
          {t('retry')}
        </CgButton>
      </Message>
    );
  if (!connectors.value.length)
    return <Message text={t('noConnectors')} testId="erp-no-connectors" />;
  return (
    <div className="cgw-erp-choose" role="group" aria-labelledby={heading} data-testid="erp-choose">
      <p id={heading} className="cgw-erp-choose-title">
        {t('chooseData')}
      </p>
      <ul className="cgw-erp-choose-list">
        {connectors.value.map((connector) => (
          <li key={connector.id}>
            <CgButton
              appearance="outline"
              data-connector={connector.id}
              onClick={() => onPick(connector.id)}
            >
              {connector.label[language] || connector.label.en}
            </CgButton>
          </li>
        ))}
      </ul>
    </div>
  );
}
