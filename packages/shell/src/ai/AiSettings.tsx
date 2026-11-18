// Settings' "AI" section (Phase 7): owners and admins turn AI on or off for the workspace, set or
// remove its Anthropic key (sent once, never shown again: the server keeps it encrypted and only
// says whether one is set), pick the model and see this month's use. Members see whether it is on.
// The server decides every change again.
//
// Phase 10: search by meaning's part of it, with a switch of its own (it may be on while AI's
// completions are off), its Voyage AI key kept as the Anthropic one is, its model, this month's
// use and how many pages are ready.
import { useId, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccount, useCloud } from '../cloud/CloudUi';
import type { WorkspaceSession } from '../session';
import { useAi } from './context';
import { AiError, type AiSettings, type AiSettingsChange, type EmbeddingsSettings } from './types';
import './ai.css';

const MODEL_LABELS: Record<string, 'ai.modelOpus' | 'ai.modelSonnet' | 'ai.modelHaiku'> = {
  'claude-opus-5-5': 'ai.modelOpus',
  'claude-sonnet-5-5': 'ai.modelSonnet',
  'claude-haiku-5-5': 'ai.modelHaiku',
};

const EMBEDDING_MODEL_LABELS: Record<
  string,
  'ai.modelVoyage4' | 'ai.modelVoyage4Large' | 'ai.modelVoyage4Lite'
> = {
  'voyage-4': 'ai.modelVoyage4',
  'voyage-4-large': 'ai.modelVoyage4Large',
  'voyage-4-lite': 'ai.modelVoyage4Lite',
};

type Save = (
  change: AiSettingsChange,
  after?: () => void,
  missing?: 'ai.keyMissing' | 'ai.embeddingsKeyMissing',
) => void;

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
  // The switch shows what the person chose while its save is out, not the old value springing back.
  const [choosing, setChoosing] = useState<boolean | null>(null);
  const [choosingEmbeddings, setChoosingEmbeddings] = useState<boolean | null>(null);
  const state = useSyncExternalStore(
    (listener) => (ai ? ai.store.subscribe(listener) : () => {}),
    () => (ai ? ai.store.state(ai.workspaceId) : null),
  );
  if (!cloud || !account || !workspace) return null;
  const settings: AiSettings | null =
    state && state.status !== 'idle' ? (state.settings ?? null) : null;

  const save: Save = (change, after, missing = 'ai.keyMissing') => {
    if (!ai) return;
    setBusy(true);
    setMessage(null);
    void ai.store.save(ai.workspaceId, change).then(
      () => {
        setBusy(false);
        setChoosing(null);
        setChoosingEmbeddings(null);
        setMessage({ text: t('ai.saved'), error: false });
        after?.();
      },
      (error: unknown) => {
        setBusy(false);
        setChoosing(null);
        setChoosingEmbeddings(null);
        const code = error instanceof AiError ? error.code : 'server.error';
        setMessage({
          text: t(
            code === 'ai.keyMissing'
              ? missing
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
        <>
          <p data-testid="ai-state">{t(settings.enabled ? 'ai.stateOn' : 'ai.stateOff')}</p>
          {settings.embeddings && (
            <p data-testid="embeddings-state">
              {t(settings.embeddings.enabled ? 'ai.embeddingsStateOn' : 'ai.embeddingsStateOff')}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="cgw-muted">{t('ai.settingsNote')}</p>
          <label className="cgw-ai-check">
            <input
              type="checkbox"
              checked={choosing ?? settings.enabled}
              disabled={busy}
              onChange={(event) => {
                if (event.target.checked && !settings.hasKey) {
                  setMessage({ text: t('ai.keyMissing'), error: true });
                  return;
                }
                setChoosing(event.target.checked);
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
          {settings.embeddings && (
            <EmbeddingsPart
              embeddings={settings.embeddings}
              busy={busy}
              choosing={choosingEmbeddings}
              onChoose={setChoosingEmbeddings}
              save={save}
              dateText={dateText}
              onMissingKey={() => setMessage({ text: t('ai.embeddingsKeyMissing'), error: true })}
            />
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

/** Search by meaning, for owners and admins: its switch, Voyage AI key, model, use and progress. */
function EmbeddingsPart({
  embeddings,
  busy,
  choosing,
  onChoose,
  save,
  dateText,
  onMissingKey,
}: {
  embeddings: EmbeddingsSettings;
  busy: boolean;
  choosing: boolean | null;
  onChoose: (on: boolean) => void;
  save: Save;
  dateText: (iso: string) => string;
  onMissingKey: () => void;
}) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const keyId = useId();
  const modelId = useId();
  const modelNoteId = useId();
  const [key, setKey] = useState('');
  const number = (n: number) => n.toLocaleString(i18n.language);
  return (
    <section
      aria-labelledby={titleId}
      className="cgw-ai-embeddings"
      data-testid="embeddings-settings"
    >
      <h3 id={titleId}>{t('ai.embeddingsTitle')}</h3>
      <p className="cgw-muted">{t('ai.embeddingsNote')}</p>
      <label className="cgw-ai-check">
        <input
          type="checkbox"
          checked={choosing ?? embeddings.enabled}
          disabled={busy}
          onChange={(event) => {
            const on = event.target.checked;
            if (on && !embeddings.hasKey) {
              onMissingKey();
              return;
            }
            onChoose(on);
            save({ embeddings: { enabled: on } }, undefined, 'ai.embeddingsKeyMissing');
          }}
        />
        <span>{t('ai.embeddingsEnabled')}</span>
      </label>
      <div className="cgw-ai-field">
        <label htmlFor={keyId}>{t('ai.embeddingsKey')}</label>
        <p className="cgw-muted" data-testid="embeddings-key-state">
          {embeddings.hasKey
            ? embeddings.keySetAt
              ? embeddings.keySetBy
                ? t('ai.keySet', {
                    date: dateText(embeddings.keySetAt),
                    name: embeddings.keySetBy.name,
                  })
                : t('ai.keySetNoName', { date: dateText(embeddings.keySetAt) })
              : t('ai.keySetNoName', { date: '' })
            : t('ai.noKey')}
        </p>
        <form
          className="cgw-ai-key"
          onSubmit={(event) => {
            event.preventDefault();
            const value = key.trim();
            if (!value) return;
            save({ embeddings: { apiKey: value } }, () => setKey(''), 'ai.embeddingsKeyMissing');
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
            {t('ai.embeddingsSaveKey')}
          </button>
          {embeddings.hasKey && (
            <button
              type="button"
              className="cgw-button"
              disabled={busy}
              onClick={() => save({ embeddings: { apiKey: null } })}
            >
              {t('ai.embeddingsRemoveKey')}
            </button>
          )}
        </form>
        <p className="cgw-muted">{t('ai.keyNote')}</p>
      </div>
      <div className="cgw-ai-field">
        <label htmlFor={modelId}>{t('ai.embeddingsModel')}</label>
        <select
          id={modelId}
          className="cgw-input"
          value={embeddings.model}
          disabled={busy}
          aria-describedby={modelNoteId}
          onChange={(event) => save({ embeddings: { model: event.target.value } })}
        >
          {embeddings.models.map((model) => (
            <option key={model} value={model}>
              {EMBEDDING_MODEL_LABELS[model] ? t(EMBEDDING_MODEL_LABELS[model]) : model}
            </option>
          ))}
        </select>
        <p id={modelNoteId} className="cgw-muted">
          {t('ai.embeddingsModelNote')}
        </p>
      </div>
      {embeddings.usage && (
        <p className="cgw-muted" data-testid="embeddings-usage">
          {t('ai.embeddingsUsage', {
            requests: number(embeddings.usage.requests),
            tokens: number(embeddings.usage.tokens),
          })}
        </p>
      )}
      {embeddings.enabled && embeddings.progress && (
        <p className="cgw-muted" role="status" data-testid="embeddings-progress">
          {t('ai.embeddingsProgress', {
            embedded: number(embeddings.progress.embedded),
            pages: number(embeddings.progress.pages),
          })}
        </p>
      )}
    </section>
  );
}
