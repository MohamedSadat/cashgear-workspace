// Settings' "AI" section (Phase 7): owners and admins turn AI on or off for the workspace, set or
// remove its Anthropic key (sent once, never shown again: the server keeps it encrypted and only
// says whether one is set), pick the model and see this month's use. Members see whether it is on.
// The server decides every change again.
//
// Phase 10: search by meaning's part of it, with a switch of its own (it may be on while AI's
// completions are off), its Voyage AI key kept as the Anthropic one is, its model, this month's
// use and how many pages are ready.
//
// Phase 13: where each part's key comes from, the workspace's own or Cash Gear's subscription (when
// this server offers it to the workspace, with the month's allowance and use), and search by meaning
// made on this server by its own model (voyage-4-nano), with no key and no text leaving it.
//
// Phase 18: Cash Gear's paid plans (BillingSection, loaded with this part only once the server's
// `/version` says it offers billing).
import { lazy, Suspense, useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccount, useCloud } from '../cloud/CloudUi';
import { useSection } from '../i18n/sections';
import type { WorkspaceSession } from '../session';
import { cloudBillingApi } from './billing';
import { useAi } from './context';
import { aiPlanWords } from './planWords';
import {
  AiError,
  LOCAL_EMBEDDINGS_MODEL,
  type AiSettings,
  type AiSettingsChange,
  type Allowance,
  type EmbeddingsSettings,
  type KeySource,
} from './types';

/** Phase 13: where search by meaning is made. */
type EmbeddingsSource = KeySource | 'local';
import './ai.css';

/** Phase 18: the plan's part, loaded once the server offers billing. */
const BillingSection = lazy(() => import('./BillingSection'));

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

/** Phase 13: a month on Cash Gear's subscription, as Settings says it. */
function AllowanceText({ allowance, testId }: { allowance: Allowance; testId: string }) {
  const { t, i18n } = useTranslation();
  const number = (n: number) => n.toLocaleString(i18n.language);
  return (
    <p className="cgw-muted" data-testid={testId}>
      {t('aiPlan.subscriptionUse', {
        used: number(allowance.used),
        allowance: number(allowance.allowance),
      })}
      {allowance.reserved > 0
        ? ' ' + t('aiPlan.subscriptionHeld', { reserved: number(allowance.reserved) })
        : ''}
    </p>
  );
}

export function AiSettingsSection({ session }: { session: WorkspaceSession }) {
  useSection(aiPlanWords);
  const { t, i18n } = useTranslation();
  const cloud = useCloud();
  const account = useAccount(cloud);
  const workspace = session.current;
  const ai = useAi(session, workspace?.id ?? null);
  const titleId = useId();
  const keyId = useId();
  const sourceName = useId();
  const [key, setKey] = useState('');
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // The switch shows what the person chose while its save is out, not the old value springing back.
  const [choosing, setChoosing] = useState<boolean | null>(null);
  const [choosingEmbeddings, setChoosingEmbeddings] = useState<boolean | null>(null);
  // Phase 13: the same for where each part's key comes from, and where search by meaning is made.
  const [choosingSource, setChoosingSource] = useState<KeySource | 'local' | null>(null);
  const [choosingMade, setChoosingMade] = useState<EmbeddingsSource | null>(null);
  const state = useSyncExternalStore(
    (listener) => (ai ? ai.store.subscribe(listener) : () => {}),
    () => (ai ? ai.store.state(ai.workspaceId) : null),
  );
  const settings: AiSettings | null =
    state && state.status !== 'idle' ? (state.settings ?? null) : null;
  // Phase 13: read again when Settings opens (the month's use on the subscription, the pages
  // embedded), and every 5 s while pages wait to be embedded, so the progress moves.
  // Only as the AI context reads them: signed in, of a workspace on the account (an import not yet
  // uploaded is not, and the server answers 404).
  const store = ai?.store;
  const workspaceId = ai?.workspaceId;
  const readable =
    !!account && !!ai && ai.availability !== 'localWorkspace' && ai.availability !== 'signedOut';
  useEffect(() => {
    if (store && workspaceId && readable) store.load(workspaceId, true);
  }, [store, workspaceId, readable]);
  // Phase 18: Cash Gear's paid plans, when the server offers them.
  const billing = useMemo(() => (cloud ? cloudBillingApi(cloud.api) : null), [cloud]);
  const [billingOffered, setBillingOffered] = useState(false);
  useEffect(() => {
    let live = true;
    if (billing && readable) void billing.offered().then((on) => live && setBillingOffered(on));
    return () => {
      live = false;
    };
  }, [billing, readable]);
  const progress = settings?.embeddings?.enabled ? settings.embeddings.progress : undefined;
  const embedding = !!progress && progress.embedded < progress.pages;
  useEffect(() => {
    if (!store || !workspaceId || !embedding || !readable) return;
    const timer = setInterval(() => store.load(workspaceId, true), 5000);
    return () => clearInterval(timer);
  }, [store, workspaceId, embedding, readable]);
  if (!cloud || !account || !workspace) return null;
  // Phase 18: the server's own model, chosen as a third source of answers (no key, no allowance).
  const localModel = settings?.localModel;
  const onLocal = settings?.provider === 'local';
  const claudeModels = (settings?.models ?? []).filter((m) => m !== localModel);
  const source = onLocal ? 'local' : settings?.keySource;
  const toClaude = onLocal ? { model: claudeModels[0] ?? 'claude-opus-5-5' } : {};

  const save: Save = (change, after, missing = 'ai.keyMissing') => {
    if (!ai) return;
    setBusy(true);
    setMessage(null);
    void ai.store.save(ai.workspaceId, change).then(
      () => {
        setBusy(false);
        setChoosing(null);
        setChoosingEmbeddings(null);
        setChoosingSource(null);
        setChoosingMade(null);
        setMessage({ text: t('ai.saved'), error: false });
        after?.();
      },
      (error: unknown) => {
        setBusy(false);
        setChoosing(null);
        setChoosingEmbeddings(null);
        setChoosingSource(null);
        setChoosingMade(null);
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
                if (
                  event.target.checked &&
                  !settings.hasKey &&
                  settings.keySource !== 'subscription' &&
                  !onLocal
                ) {
                  setMessage({ text: t('ai.keyMissing'), error: true });
                  return;
                }
                setChoosing(event.target.checked);
                save({ enabled: event.target.checked });
              }}
            />
            <span>{t('ai.enabled')}</span>
          </label>
          {(settings.subscription ||
            settings.keySource === 'subscription' ||
            localModel ||
            onLocal) && (
            <fieldset className="cgw-ai-field cgw-ai-sources" data-testid="ai-key-source">
              <legend>{t('aiPlan.keyLegend')}</legend>
              <label className="cgw-ai-check">
                <input
                  type="radio"
                  name={sourceName}
                  checked={(choosingSource ?? source) === 'own'}
                  disabled={busy}
                  onChange={() => {
                    setChoosingSource('own');
                    save({ keySource: 'own', ...toClaude });
                  }}
                />
                <span>{t('aiPlan.keyOwn', { provider: 'Anthropic' })}</span>
              </label>
              <label className="cgw-ai-check">
                <input
                  type="radio"
                  name={sourceName}
                  checked={(choosingSource ?? source) === 'subscription'}
                  disabled={busy || !settings.subscription}
                  onChange={() => {
                    setChoosingSource('subscription');
                    save({ keySource: 'subscription', ...toClaude });
                  }}
                />
                <span>{t('aiPlan.keySubscription')}</span>
              </label>
              {(localModel || onLocal) && (
                <label className="cgw-ai-check">
                  <input
                    type="radio"
                    name={sourceName}
                    checked={(choosingSource ?? source) === 'local'}
                    disabled={busy || !localModel}
                    onChange={() => {
                      if (!localModel) return;
                      setChoosingSource('local');
                      save({ model: localModel });
                    }}
                  />
                  <span>{t('aiPlan.keyLocal', { model: localModel ?? settings.model })}</span>
                </label>
              )}
            </fieldset>
          )}
          {onLocal ? (
            <p className="cgw-muted" data-testid="ai-local">
              {t('aiPlan.localCompletionsNote', { provider: 'Claude' })}
            </p>
          ) : settings.keySource === 'subscription' ? (
            <div className="cgw-ai-field" data-testid="ai-subscription">
              <p className="cgw-muted">{t('aiPlan.subscriptionNote')}</p>
              {settings.subscription && (
                <AllowanceText allowance={settings.subscription} testId="ai-allowance" />
              )}
            </div>
          ) : (
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
          )}
          {!onLocal && (
            <label className="cgw-ai-field">
              <span>{t('ai.model')}</span>
              <select
                className="cgw-input"
                value={settings.model}
                disabled={busy}
                onChange={(event) => save({ model: event.target.value })}
              >
                {claudeModels.map((model) => (
                  <option key={model} value={model}>
                    {MODEL_LABELS[model] ? t(MODEL_LABELS[model]) : model}
                  </option>
                ))}
              </select>
            </label>
          )}
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
              picked={choosingMade}
              onPick={setChoosingMade}
              save={save}
              dateText={dateText}
              onMissingKey={() => setMessage({ text: t('ai.embeddingsKeyMissing'), error: true })}
            />
          )}
          {billing && billingOffered && ai && (
            <Suspense fallback={null}>
              <BillingSection
                workspaceId={ai.workspaceId}
                api={billing}
                open={(link) => {
                  // A tab opened inside the click (a link that comes later would be blocked), sent on
                  // when the server answers; the desktop's system browser.
                  if (cloud.platform.kind === 'web') {
                    const tab = window.open('about:blank', '_blank');
                    link.then(
                      (url) => {
                        if (tab) tab.location.href = url;
                        else window.location.assign(url);
                      },
                      () => tab?.close(),
                    );
                  } else
                    void link.then(
                      (url) => cloud.platform.openExternal(url),
                      () => undefined,
                    );
                }}
                onPlanChanged={() => ai.store.load(ai.workspaceId, true)}
              />
            </Suspense>
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
  picked,
  onPick,
  save,
  dateText,
  onMissingKey,
}: {
  embeddings: EmbeddingsSettings;
  busy: boolean;
  choosing: boolean | null;
  onChoose: (on: boolean) => void;
  /** Phase 13: where search by meaning is made, as chosen while its save is out. */
  picked: EmbeddingsSource | null;
  onPick: (source: EmbeddingsSource) => void;
  save: Save;
  dateText: (iso: string) => string;
  onMissingKey: () => void;
}) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const keyId = useId();
  const modelId = useId();
  const modelNoteId = useId();
  const sourceName = useId();
  const [key, setKey] = useState('');
  const number = (n: number) => n.toLocaleString(i18n.language);
  // Phase 13: where search by meaning is made: Voyage with the workspace's key or Cash Gear's, or
  // this server's own model.
  const local = embeddings.model === LOCAL_EMBEDDINGS_MODEL;
  const source = local ? 'local' : embeddings.keySource;
  const offersLocal = embeddings.models.includes(LOCAL_EMBEDDINGS_MODEL);
  const voyageModels = embeddings.models.filter((m) => m !== LOCAL_EMBEDDINGS_MODEL);
  const voyageModel = local ? (voyageModels[0] ?? 'voyage-4') : embeddings.model;
  const choose = (next: EmbeddingsSource) => {
    if (next === source) return;
    onPick(next);
    if (next === 'local') save({ embeddings: { model: LOCAL_EMBEDDINGS_MODEL } });
    else
      save(
        { embeddings: { keySource: next, model: voyageModel } },
        undefined,
        'ai.embeddingsKeyMissing',
      );
  };
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
            if (on && !embeddings.hasKey && source === 'own') {
              onMissingKey();
              return;
            }
            onChoose(on);
            save({ embeddings: { enabled: on } }, undefined, 'ai.embeddingsKeyMissing');
          }}
        />
        <span>{t('ai.embeddingsEnabled')}</span>
      </label>
      {(offersLocal || embeddings.subscription || source !== 'own') && (
        <fieldset className="cgw-ai-field cgw-ai-sources" data-testid="embeddings-source">
          <legend>{t('aiPlan.embeddingsLegend')}</legend>
          <label className="cgw-ai-check">
            <input
              type="radio"
              name={sourceName}
              checked={(picked ?? source) === 'own'}
              disabled={busy}
              onChange={() => choose('own')}
            />
            <span>{t('aiPlan.sourceOwn', { provider: 'Voyage AI' })}</span>
          </label>
          {(embeddings.subscription || source === 'subscription') && (
            <label className="cgw-ai-check">
              <input
                type="radio"
                name={sourceName}
                checked={(picked ?? source) === 'subscription'}
                disabled={busy || !embeddings.subscription}
                onChange={() => choose('subscription')}
              />
              <span>{t('aiPlan.sourceSubscription', { provider: 'Voyage AI' })}</span>
            </label>
          )}
          {(offersLocal || local) && (
            <label className="cgw-ai-check">
              <input
                type="radio"
                name={sourceName}
                checked={(picked ?? source) === 'local'}
                disabled={busy || !offersLocal}
                onChange={() => choose('local')}
              />
              <span>{t('aiPlan.sourceLocal', { model: LOCAL_EMBEDDINGS_MODEL })}</span>
            </label>
          )}
        </fieldset>
      )}
      {local && (
        <p className="cgw-muted" data-testid="embeddings-local">
          {t('aiPlan.localNote')}
        </p>
      )}
      {source === 'subscription' && (
        <div className="cgw-ai-field" data-testid="embeddings-subscription">
          <p className="cgw-muted">{t('aiPlan.subscriptionNote')}</p>
          {embeddings.subscription && (
            <AllowanceText allowance={embeddings.subscription} testId="embeddings-allowance" />
          )}
        </div>
      )}
      {source === 'own' && (
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
      )}
      {!local && (
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
            {voyageModels.map((model) => (
              <option key={model} value={model}>
                {EMBEDDING_MODEL_LABELS[model] ? t(EMBEDDING_MODEL_LABELS[model]) : model}
              </option>
            ))}
          </select>
          <p id={modelNoteId} className="cgw-muted">
            {t('ai.embeddingsModelNote')}
          </p>
        </div>
      )}
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
