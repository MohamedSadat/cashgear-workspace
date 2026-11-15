// Settings' "AI" section (Phase 7): owners and admins turn AI on or off for the workspace, set or
// remove its Anthropic key (sent once, never shown again: the server keeps it encrypted and only
// says whether one is set), pick the model and see this month's use. Members see whether it is on.
// The server decides every change again.
import { useId, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccount, useCloud } from '../cloud/CloudUi';
import type { WorkspaceSession } from '../session';
import { useAi } from './context';
import { AiError, type AiSettings, type AiSettingsChange } from './types';
import './ai.css';

const MODEL_LABELS: Record<string, 'ai.modelOpus' | 'ai.modelSonnet' | 'ai.modelHaiku'> = {
  'claude-opus-5-5': 'ai.modelOpus',
  'claude-sonnet-5-5': 'ai.modelSonnet',
  'claude-haiku-5-5': 'ai.modelHaiku',
};

export function AiSettingsSection({ session }: { session: WorkspaceSession }) {
  const { t, i18n } = useTranslation();
  const cloud = useCloud();
  const account = useAccount(cloud);
  const workspace = session.current;
  const ai = useAi(session, workspace?.id ?? null);
  const titleId = useId();
  const keyId = useId();
  const [key, setKey] = useState('');
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const state = useSyncExternalStore(
    (listener) => (ai ? ai.store.subscribe(listener) : () => {}),
    () => (ai ? ai.store.state(ai.workspaceId) : null),
  );
  if (!cloud || !account || !workspace) return null;
  const settings: AiSettings | null =
    state && state.status !== 'idle' ? (state.settings ?? null) : null;

  const save = (change: AiSettingsChange, after?: () => void) => {
    if (!ai) return;
    setBusy(true);
    setMessage(null);
    void ai.store.save(ai.workspaceId, change).then(
      () => {
        setBusy(false);
        setMessage({ text: t('ai.saved'), error: false });
        after?.();
      },
      (error: unknown) => {
        setBusy(false);
        const code = error instanceof AiError ? error.code : 'server.error';
        setMessage({
          text: t(
            code === 'ai.keyMissing'
              ? 'ai.keyMissing'
              : code === 'access.denied' || (error instanceof AiError && error.status === 403)
                ? 'ai.forbidden'
                : 'ai.saveFailed',
          ),
          error: true,
        });
      },
    );
  };

  const dateText = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.language, {
      dateStyle: 'medium',
    } as Intl.DateTimeFormatOptions);

  return (
    <section aria-labelledby={titleId} className="cgw-ai-settings" data-testid="ai-settings">
      <h2 id={titleId}>{t('ai.settingsTitle')}</h2>
      {workspace.localOnly ? (
        <p className="cgw-muted">{t('ai.localWorkspace')}</p>
      ) : !settings ? (
        <p className="cgw-muted" role="status">
          {t(state?.status === 'failed' ? 'ai.failed' : 'ai.loading')}
        </p>
      ) : !ai?.canManage ? (
        <p data-testid="ai-state">{t(settings.enabled ? 'ai.stateOn' : 'ai.stateOff')}</p>
      ) : (
        <>
          <p className="cgw-muted">{t('ai.settingsNote')}</p>
          <label className="cgw-ai-check">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={busy}
              onChange={(event) => {
                if (event.target.checked && !settings.hasKey) {
                  setMessage({ text: t('ai.keyMissing'), error: true });
                  return;
                }
                save({ enabled: event.target.checked });
              }}
            />
            <span>{t('ai.enabled')}</span>
          </label>
          <div className="cgw-ai-field">
            <label htmlFor={keyId}>{t('ai.key')}</label>
            <p className="cgw-muted" data-testid="ai-key-state">
              {settings.hasKey
                ? settings.keySetAt
                  ? settings.keySetBy
                    ? t('ai.keySet', {
                        date: dateText(settings.keySetAt),
                        name: settings.keySetBy.name,
                      })
                    : t('ai.keySetNoName', { date: dateText(settings.keySetAt) })
                  : t('ai.keySetNoName', { date: '' })
                : t('ai.noKey')}
            </p>
            <form
              className="cgw-ai-key"
              onSubmit={(event) => {
                event.preventDefault();
                const value = key.trim();
                if (!value) return;
                save({ apiKey: value }, () => setKey(''));
              }}
            >
              <input
                id={keyId}
                className="cgw-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                placeholder={t('ai.keyPlaceholder')}
                value={key}
                disabled={busy}
                onChange={(event) => setKey(event.target.value)}
              />
              <button type="submit" className="cgw-button" disabled={busy || !key.trim()}>
                {t('ai.saveKey')}
              </button>
              {settings.hasKey && (
                <button
                  type="button"
                  className="cgw-button"
                  disabled={busy}
                  onClick={() => save({ apiKey: null })}
                >
                  {t('ai.removeKey')}
                </button>
              )}
            </form>
            <p className="cgw-muted">{t('ai.keyNote')}</p>
          </div>
          <label className="cgw-ai-field">
            <span>{t('ai.model')}</span>
            <select
              className="cgw-input"
              value={settings.model}
              disabled={busy}
              onChange={(event) => save({ model: event.target.value })}
            >
              {settings.models.map((model) => (
                <option key={model} value={model}>
                  {MODEL_LABELS[model] ? t(MODEL_LABELS[model]) : model}
                </option>
              ))}
            </select>
          </label>
          {settings.usage && (
            <p className="cgw-muted" data-testid="ai-usage">
              {t('ai.usage', {
                requests: settings.usage.requests.toLocaleString(i18n.language),
                input: settings.usage.inputTokens.toLocaleString(i18n.language),
                output: settings.usage.outputTokens.toLocaleString(i18n.language),
              })}
            </p>
          )}
        </>
      )}
      {message && (
        <p
          className={message.error ? 'cgw-ai-problem' : 'cgw-ai-notice'}
          role={message.error ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
