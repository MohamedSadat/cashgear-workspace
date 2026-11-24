// Settings → Automations (Phase 15, M15.3): for owners and admins, every rule of the workspace with
// a switch each and one for all, the time zone its dates and schedules are read in, and the
// webhooks rules may call (added with a secret shown once, removed). Read again when the feed says
// a rule changed. The server decides who may change what.
import { CgButton, CgCheckBox, CgSwitch } from '@cashgear/ui';
import { SyncHttpError, type Id } from '@cgw/workspace';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Cloud } from '../cloud/cloud';
import { useSection } from '../i18n/sections';
import type { WorkspaceSession } from '../session';
import { browserTimeZone, ruleOf } from './host';
import { automationsWords } from './words';
import './automations.css';

type Loose = (key: string, options?: Record<string, unknown>) => string;

interface Rule {
  id: Id;
  name: string;
  enabled: boolean;
  databaseTitle: string;
  author: string | null;
  runsToday: number;
  stopped: boolean;
}

interface Hook {
  id: Id;
  name: string;
  url: string;
  createdBy: string;
}

interface State {
  allOff: boolean;
  timeZone: string | null;
  rules: Rule[];
  webhooks: Hook[];
}

function codeOf(error: unknown): string {
  if (error instanceof SyncHttpError) return error.code;
  return error instanceof TypeError ? 'offline' : 'server.error';
}

async function data<T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const result = await request;
  if (result.response.ok) return result.data as T;
  const body = result.error as { code?: string } | undefined;
  throw new SyncHttpError(result.response.status, body?.code ?? 'server.error');
}

/** Every zone the browser knows, the workspace's first. */
function zones(current: string | null): string[] {
  let list: string[];
  try {
    list =
      (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
        'timeZone',
      ) ?? [];
  } catch {
    list = [];
  }
  const browser = browserTimeZone();
  return [
    ...new Set([...(current ? [current] : []), ...(browser ? [browser] : []), 'UTC', ...list]),
  ];
}

export function AutomationsSettings({
  cloud,
  session,
}: {
  cloud: Cloud;
  session: WorkspaceSession;
}) {
  useSection(automationsWords);
  const { t: raw } = useTranslation();
  const t = raw as unknown as Loose;
  const workspace = session.current;
  const manages = workspace?.role === 'owner' || workspace?.role === 'admin';
  const workspaceId = workspace?.id ?? '';
  const [state, setState] = useState<State | null>(null);
  const [load, setLoad] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [reading, setReading] = useState(0);
  const [message, setMessage] = useState<{ text: string; alert: boolean } | null>(null);
  const [zone, setZone] = useState<string>('');
  const [hookName, setHookName] = useState('');
  const [hookUrl, setHookUrl] = useState('');
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [removing, setRemoving] = useState<Hook | null>(null);
  const zoneList = useMemo(() => zones(state?.timeZone ?? null), [state?.timeZone]);

  useEffect(() => {
    if (!manages || !workspaceId) return;
    let live = true;
    const path = { params: { path: { workspaceId } } };
    data(cloud.api.GET('/api/v1/workspaces/{workspaceId}/automations', path)).then(
      (answer) => {
        if (!live) return;
        setState({
          allOff: answer.allOff,
          timeZone: answer.timeZone ?? null,
          rules: answer.automations.map((a) => ({
            id: a.rule.id,
            name: ruleOf(a.rule as never).name,
            enabled: a.rule.enabled,
            databaseTitle: a.databaseTitle,
            author: a.author?.name ?? null,
            runsToday: Number(a.runsToday),
            stopped: a.lastRun?.status === 'stopped',
          })),
          webhooks: answer.webhooks.map((w) => ({
            id: w.id,
            name: w.name,
            url: w.url,
            createdBy: w.createdBy.name,
          })),
        });
        setZone(answer.timeZone ?? '');
        setLoad('ready');
      },
      () => live && setLoad('failed'),
    );
    return () => {
      live = false;
    };
  }, [cloud, manages, workspaceId, reading]);

  useEffect(
    () =>
      cloud.onAutomations((changed) => {
        if (changed === workspaceId) setReading((n) => n + 1);
      }),
    [cloud, workspaceId],
  );

  if (!workspace || workspace.localOnly) return null;

  const failed = (error: unknown, fallback = 'automations.settings.failed') => {
    const code = codeOf(error);
    setMessage({
      text:
        code === 'access.denied'
          ? t('automations.settings.denied')
          : code === 'webhook.address'
            ? t('automations.webhooks.address')
            : code === 'timeZone.unknown'
              ? t('automations.settings.timeZoneUnknown')
              : code === 'limit.size'
                ? t('automations.webhooks.full')
                : t(fallback),
      alert: true,
    });
  };

  const settings = async (body: { allOff?: boolean; timeZone?: string }, done: string) => {
    setMessage(null);
    try {
      await data(
        cloud.api.PUT('/api/v1/workspaces/{workspaceId}/automations/settings', {
          params: { path: { workspaceId } },
          body: { allOff: body.allOff ?? null, timeZone: body.timeZone ?? null },
        }),
      );
      setMessage({ text: done, alert: false });
      setReading((n) => n + 1);
    } catch (error) {
      failed(error);
    }
  };

  return (
    <section className="cgw-automations-settings" aria-labelledby="cgw-automations-title">
      <h2 id="cgw-automations-title">{t('automations.settings.title')}</h2>
      <p>{t('automations.settings.intro')}</p>
      {!manages ? (
        <p className="cgw-muted">{t('automations.settings.readOnly')}</p>
      ) : load === 'failed' ? (
        <p role="alert">{t('automations.settings.loadFailed')}</p>
      ) : !state ? null : (
        <>
          {message ? (
            <p role={message.alert ? 'alert' : 'status'} data-testid="automations-message">
              {message.text}
            </p>
          ) : null}
          <CgCheckBox
            label={t('automations.settings.allOff')}
            description={t('automations.settings.allOffHelp')}
            checked={state.allOff}
            onCheckedChange={(on) =>
              void settings(
                { allOff: on === true },
                t(on === true ? 'automations.settings.turnedOff' : 'automations.settings.turnedOn'),
              )
            }
          />
          <div className="cgw-automations-zone">
            <label htmlFor="cgw-automations-zone">{t('automations.settings.timeZone')}</label>
            <select
              id="cgw-automations-zone"
              className="cgw-automations-select"
              value={zone}
              onChange={(event) => setZone(event.target.value)}
            >
              {!state.timeZone ? (
                <option value="">{t('automations.settings.timeZoneUnset')}</option>
              ) : null}
              {zoneList.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
            <CgButton
              size="small"
              appearance="outline"
              disabled={!zone || zone === state.timeZone}
              onClick={() =>
                void settings({ timeZone: zone }, t('automations.settings.timeZoneSaved', { zone }))
              }
            >
              {t('automations.settings.timeZone')}
            </CgButton>
            <p className="cgw-muted">{t('automations.settings.timeZoneHelp')}</p>
          </div>
          {state.rules.length ? (
            <ul className="cgw-automations-list" aria-label={t('automations.settings.listLabel')}>
              {state.rules.map((rule) => {
                const name = rule.name || t('automations.settings.untitled');
                return (
                  <li key={rule.id} className="cgw-automations-item">
                    <CgSwitch
                      checked={rule.enabled}
                      aria-label={t('automations.settings.switchLabel', { name })}
                      onCheckedChange={async (enabled) => {
                        try {
                          await data(
                            cloud.api.PUT(
                              '/api/v1/workspaces/{workspaceId}/automations/{automationId}/enabled',
                              {
                                params: { path: { workspaceId, automationId: rule.id } },
                                body: { enabled },
                              },
                            ),
                          );
                          setReading((n) => n + 1);
                        } catch (error) {
                          failed(error);
                        }
                      }}
                    />
                    <span className="cgw-automations-text">
                      <span dir="auto" className="cgw-automations-name">
                        {name}
                      </span>
                      <span className="cgw-muted">
                        {t('automations.settings.inDatabase', { database: rule.databaseTitle })}
                        {rule.author
                          ? ` · ${t('automations.settings.author', { name: rule.author })}`
                          : ''}
                        {` · ${t('automations.settings.runsToday', { count: rule.runsToday })}`}
                        {rule.stopped ? ` · ${t('automations.settings.lastStopped')}` : ''}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>{t('automations.settings.none')}</p>
          )}
          <h3>{t('automations.webhooks.title')}</h3>
          <p>{t('automations.webhooks.intro')}</p>
          {secret ? (
            <div className="cgw-automations-secret" role="status">
              <p>{t('automations.webhooks.added', { name: secret.name })}</p>
              <label htmlFor="cgw-webhook-secret">{t('automations.webhooks.secret')}</label>
              <input
                id="cgw-webhook-secret"
                readOnly
                value={secret.secret}
                dir="ltr"
                className="cgw-automations-input"
              />
              <CgButton
                size="small"
                onClick={() =>
                  void navigator.clipboard?.writeText(secret.secret).catch(() => undefined)
                }
              >
                {t('automations.webhooks.copy')}
              </CgButton>
            </div>
          ) : null}
          {state.webhooks.length ? (
            <ul className="cgw-automations-list">
              {state.webhooks.map((hook) => (
                <li key={hook.id} className="cgw-automations-item">
                  <span className="cgw-automations-text">
                    <span dir="auto" className="cgw-automations-name">
                      {hook.name}
                    </span>
                    <span className="cgw-muted" dir="ltr">
                      {hook.url}
                    </span>
                    <span className="cgw-muted">
                      {t('automations.webhooks.by', { name: hook.createdBy })}
                    </span>
                  </span>
                  {removing?.id === hook.id ? (
                    <span role="group" aria-label={t('automations.webhooks.removeNow')}>
                      <span>{t('automations.webhooks.removeAsk', { name: hook.name })}</span>
                      <CgButton
                        size="small"
                        intent="danger"
                        onClick={async () => {
                          try {
                            await data(
                              cloud.api.DELETE(
                                '/api/v1/workspaces/{workspaceId}/webhooks/{webhookId}',
                                {
                                  params: { path: { workspaceId, webhookId: hook.id } },
                                },
                              ),
                            );
                            setRemoving(null);
                            setMessage({
                              text: t('automations.webhooks.removed', { name: hook.name }),
                              alert: false,
                            });
                            setReading((n) => n + 1);
                          } catch (error) {
                            failed(error);
                          }
                        }}
                      >
                        {t('automations.webhooks.removeNow')}
                      </CgButton>
                      <CgButton size="small" appearance="ghost" onClick={() => setRemoving(null)}>
                        {t('frame.cancel')}
                      </CgButton>
                    </span>
                  ) : (
                    <CgButton
                      size="small"
                      appearance="ghost"
                      aria-label={t('automations.webhooks.removeLabel', { name: hook.name })}
                      onClick={() => setRemoving(hook)}
                    >
                      {t('automations.webhooks.remove')}
                    </CgButton>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>{t('automations.webhooks.none')}</p>
          )}
          <form
            className="cgw-automations-hook-form"
            onSubmit={async (event) => {
              event.preventDefault();
              setMessage(null);
              try {
                const made = await data(
                  cloud.api.POST('/api/v1/workspaces/{workspaceId}/webhooks', {
                    params: { path: { workspaceId } },
                    body: { name: hookName.trim(), url: hookUrl.trim() },
                  }),
                );
                setSecret({ name: made.webhook.name, secret: made.secret });
                setHookName('');
                setHookUrl('');
                setReading((n) => n + 1);
              } catch (error) {
                failed(error);
              }
            }}
          >
            <label htmlFor="cgw-webhook-name">{t('automations.webhooks.name')}</label>
            <input
              id="cgw-webhook-name"
              className="cgw-automations-input"
              dir="auto"
              required
              maxLength={200}
              value={hookName}
              onChange={(event) => setHookName(event.target.value)}
            />
            <label htmlFor="cgw-webhook-url">{t('automations.webhooks.url')}</label>
            <input
              id="cgw-webhook-url"
              className="cgw-automations-input"
              dir="ltr"
              type="url"
              required
              value={hookUrl}
              onChange={(event) => setHookUrl(event.target.value)}
            />
            <p className="cgw-muted">{t('automations.webhooks.urlHelp')}</p>
            <CgButton
              type="submit"
              size="small"
              intent="primary"
              disabled={!hookName.trim() || !hookUrl.trim()}
            >
              {t('automations.webhooks.add')}
            </CgButton>
          </form>
        </>
      )}
    </section>
  );
}
