// Settings → Publishing (Phase 9, M9.1): the workspace's switch for publishing pages to the web,
// and its live sites. Owners and admins turn it off, which unpublishes every site of the workspace
// at once (each audited) and refuses publishing until it is on again; turning it on brings no site
// back. Everyone else sees whether it is on. The server decides who may change it.
import { CgCheckBox } from '@cashgear/ui';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceSession } from '../session';
import type { Cloud } from './cloud';
import { useAccount } from './CloudUi';
import { publishFailure, publishingApi, type Publishing, type PublishingApi } from './publishing';
import './publish.css';

/** The section, for a synced workspace while someone is signed in. */
export function PublishingSettings({
  cloud,
  session,
}: {
  cloud: Cloud;
  session: WorkspaceSession;
}) {
  const account = useAccount(cloud);
  const api = useMemo(() => publishingApi(cloud.api), [cloud]);
  const workspace = session.current;
  if (!account || !workspace || workspace.localOnly) return null;
  return (
    <PublishingSection
      key={`${account.id}:${workspace.id}`}
      api={api}
      workspaceId={workspace.id}
      manages={workspace.role === 'owner' || workspace.role === 'admin'}
    />
  );
}

type State = 'loading' | 'ready' | 'loadFailed';

export function PublishingSection({
  api,
  workspaceId,
  manages,
}: {
  api: Pick<PublishingApi, 'publishing' | 'setPublishing' | 'unpublish'>;
  workspaceId: string;
  /** An owner or an admin: they may turn it off and on, and see every live site. */
  manages: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [publishing, setPublishing] = useState<Publishing | null>(null);
  const [state, setState] = useState<State>('loading');
  const [reading, setReading] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; alert: boolean } | null>(null);
  const format = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });

  useEffect(() => {
    let live = true;
    setState('loading');
    api.publishing(workspaceId).then(
      (answer) => {
        if (!live) return;
        setPublishing(answer);
        setState('ready');
      },
      () => live && setState('loadFailed'),
    );
    return () => {
      live = false;
    };
  }, [api, workspaceId, reading]);

  const failed = (error: unknown) => {
    const code = publishFailure(error);
    setMessage({
      text:
        code === 'access.denied'
          ? t('publish.settingsDenied')
          : code === 'offline'
            ? t('publish.offline')
            : t('publish.failed'),
      alert: true,
    });
  };

  const turn = async (enabled: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const answer = await api.setPublishing(workspaceId, enabled);
      setPublishing(answer);
      setConfirming(false);
      setMessage({ text: t(enabled ? 'publish.turnedOn' : 'publish.turnedOff'), alert: false });
    } catch (error) {
      setConfirming(false);
      failed(error);
    } finally {
      setBusy(false);
    }
  };

  const unpublish = async (pageId: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await api.unpublish(pageId);
      setMessage({ text: t('publish.unpublished'), alert: false });
      setReading((n) => n + 1);
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };

  const sites = publishing?.sites ?? [];
  return (
    <section aria-labelledby="cgw-publishing-title" data-testid="publishing-settings">
      <h3 id="cgw-publishing-title">{t('publish.settingsTitle')}</h3>
      <p className="cgw-muted" id="cgw-publishing-intro">
        {t('publish.settingsIntro')}
      </p>
      {state === 'loadFailed' ? (
        <p role="alert">
          {t('publish.loadFailed')}{' '}
          <button type="button" className="cgw-button" onClick={() => setReading((n) => n + 1)}>
            {t('mail.retry')}
          </button>
        </p>
      ) : state === 'loading' || !publishing ? (
        <p aria-busy="true" className="cgw-muted">
          {t('app.loading')}
        </p>
      ) : (
        <>
          <CgCheckBox
            label={t('publish.switch')}
            checked={publishing.enabled}
            disabled={!manages || busy}
            aria-describedby="cgw-publishing-intro"
            data-testid="publishing-switch"
            onCheckedChange={(checked) => {
              if (checked === true) void turn(true);
              else setConfirming(true);
            }}
          />
          {!manages ? (
            <p className="cgw-muted">
              {t(publishing.enabled ? 'publish.switchOnOthers' : 'publish.switchOffOthers')}
            </p>
          ) : null}
          {confirming ? (
            <div
              role="alertdialog"
              aria-labelledby="cgw-publishing-confirm"
              className="cgw-publish-confirm"
            >
              <p id="cgw-publishing-confirm">
                {t('publish.turnOffConfirm', { number: sites.length })}
              </p>
              <button
                type="button"
                className="cgw-button is-danger"
                disabled={busy}
                onClick={() => void turn(false)}
              >
                {t('publish.turnOff')}
              </button>
              <button
                type="button"
                className="cgw-button"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                {t('frame.cancel')}
              </button>
            </div>
          ) : null}
          {manages ? (
            sites.length ? (
              <table className="cgw-publishing-sites" data-testid="publishing-sites">
                <caption className="cgw-visually-hidden">{t('publish.sitesTitle')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('publish.columnPage')}</th>
                    <th scope="col">{t('publish.columnAddress')}</th>
                    <th scope="col">{t('publish.columnPublished')}</th>
                    <th scope="col">
                      <span className="cgw-visually-hidden">{t('publish.columnActions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sites.map((site) => {
                    const title = site.pageTitle || t('page.untitled');
                    return (
                      <tr key={site.id} data-site={site.slug}>
                        <td dir="auto">
                          {site.pageIcon ? `${site.pageIcon} ` : ''}
                          {title}
                        </td>
                        <td>
                          <a
                            href={site.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="cgw-publish-url"
                            dir="ltr"
                          >
                            {site.url}
                          </a>
                        </td>
                        <td className="cgw-muted">
                          {site.publishedBy
                            ? t('publish.publishedBy', {
                                name: site.publishedBy.name,
                                when: format.format(new Date(site.publishedAt)),
                              })
                            : t('publish.publishedOn', {
                                when: format.format(new Date(site.publishedAt)),
                              })}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="cgw-button"
                            disabled={busy}
                            aria-label={t('publish.unpublishNamed', { title })}
                            onClick={() => void unpublish(site.pageId)}
                          >
                            {t('publish.unpublish')}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="cgw-muted" data-testid="publishing-none">
                {t('publish.noSites')}
              </p>
            )
          ) : null}
        </>
      )}
      {message ? (
        <p
          role={message.alert ? 'alert' : 'status'}
          className={message.alert ? 'cgw-publish-problem' : 'cgw-muted'}
          data-testid="publishing-message"
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
