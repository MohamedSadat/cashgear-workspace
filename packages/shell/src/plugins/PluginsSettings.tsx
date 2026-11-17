// Settings → Plugins (Phase 10, M10.5): a synced workspace's third-party plugins. Owners and admins
// add one from its bundle (a zip, read on this device first: its manifest's name, type, version
// and what it reads are shown, with what trusting it means, before anything is sent), update it
// (the same, for a type already there), turn it on or off, and remove it (asked first); everyone
// else sees the list read-only. The server decides who may and checks the bundle again; each
// change is audited there. Loaded with Settings' first look, not with the app.
import type { BundleError } from '@cgw/plugins/frame';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../Dialog';
import type { Cloud } from '../cloud/cloud';
import { useAccount } from '../cloud/CloudUi';
import type { WorkspaceSession } from '../session';
import { PluginRequestError, type WorkspacePlugin } from './api';
import { BUNDLE_LIMITS, readBundle, type BundleSummary } from './bundle';
import { pluginsStoreOf } from './services';
import type { PluginsStore } from './store';
import './plugins.css';

/** The section, for a synced workspace while someone is signed in. */
export function PluginsSettings({ cloud, session }: { cloud: Cloud; session: WorkspaceSession }) {
  const account = useAccount(cloud);
  const workspace = session.current;
  if (!account || !workspace || workspace.localOnly) return null;
  return (
    <PluginsSection
      key={`${account.id}:${workspace.id}`}
      store={pluginsStoreOf(cloud)}
      workspaceId={workspace.id}
      manages={workspace.role === 'owner' || workspace.role === 'admin'}
    />
  );
}

type Review = {
  bytes: Uint8Array;
  summary: BundleSummary;
  /** The plugin of that type already here: an update. */
  existing: WorkspacePlugin | null;
};

type Problem = { kind: 'bundle'; errors: BundleError[] } | { kind: 'text'; text: string };

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** A refused bundle's problems in the interface's words. */
function bundleText(t: Translate, error: BundleError): string {
  const path = error.path ?? '';
  switch (error.code) {
    case 'manifest.missing':
      return t('plugins.settings.errors.manifestMissing');
    case 'manifest.invalid':
      return error.path && error.path !== 'manifest.json'
        ? t('plugins.settings.errors.manifestField', { path })
        : t('plugins.settings.errors.manifestInvalid');
    case 'type.reserved':
      return t('plugins.settings.errors.typeReserved');
    case 'entry.missing':
      return t('plugins.settings.errors.entryMissing', { path });
    case 'file.type':
      return t('plugins.settings.errors.fileType', { path });
    case 'file.name':
      return t('plugins.settings.errors.fileName', { path });
    case 'bundle.tooLarge':
      return t('plugins.settings.errors.bundleTooLarge');
    default:
      return t('plugins.settings.errors.bundleZip');
  }
}

export function PluginsSection({
  store,
  workspaceId,
  manages,
}: {
  store: PluginsStore;
  workspaceId: string;
  /** An owner or an admin: they may add, update, turn on or off and remove. */
  manages: boolean;
}) {
  const { t: typed, i18n } = useTranslation();
  const t = typed as unknown as Translate;
  const language = i18n.language === 'ar' ? 'ar' : 'en';
  const titleId = useId();
  const introId = useId();
  const state = useSyncExternalStore(
    store.subscribe,
    () => store.state(workspaceId),
    () => store.state(workspaceId),
  );
  useEffect(() => void store.load(workspaceId), [store, workspaceId]);
  const plugins = store.plugins(workspaceId) ?? [];
  const input = useRef<HTMLInputElement>(null);
  const updating = useRef<WorkspacePlugin | null>(null);
  const [reading, setReading] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [removing, setRemoving] = useState<WorkspacePlugin | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const dates = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }),
    [i18n.language],
  );
  const sizes = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        style: 'unit',
        unit: 'kilobyte',
        unitDisplay: 'short',
        maximumFractionDigits: 1,
      }),
    [i18n.language],
  );
  const nameOf = (plugin: { name: { en: string; ar: string }; type: string }) =>
    plugin.name[language] || plugin.name.en || plugin.type;

  const failed = (error: unknown) => {
    if (error instanceof PluginRequestError) {
      if (error.code === 'plugin.invalid' && error.errors.length) {
        setProblem({ kind: 'bundle', errors: error.errors });
        return;
      }
      const key: Record<string, string> = {
        'plugin.older': 'pluginOlder',
        'access.denied': 'accessDenied',
        offline: 'offline',
        'bundle.tooLarge': 'bundleTooLarge',
        'plugin.invalid': 'manifestInvalid',
      };
      setProblem({
        kind: 'text',
        text: t(`plugins.settings.errors.${key[error.code] ?? 'failed'}`, { version: '' }),
      });
      return;
    }
    setProblem({ kind: 'text', text: t('plugins.settings.errors.failed') });
  };

  /** Add (or, for a row, Update): the file picker. */
  const choose = (plugin: WorkspacePlugin | null) => {
    updating.current = plugin;
    setProblem(null);
    setMessage(null);
    if (input.current) input.current.value = '';
    input.current?.click();
  };

  const chosen = async (file: File | undefined) => {
    if (!file) return;
    setProblem(null);
    if (file.size > BUNDLE_LIMITS.zipBytes) {
      setProblem({ kind: 'bundle', errors: [{ code: 'bundle.tooLarge' }] });
      return;
    }
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const read = readBundle(bytes);
      if (!read.ok) {
        setProblem({ kind: 'bundle', errors: read.errors });
        return;
      }
      const { manifest } = read.summary;
      const target = updating.current;
      if (target && manifest.type !== target.type) {
        setProblem({
          kind: 'text',
          text: t('plugins.settings.errors.otherType', { type: manifest.type }),
        });
        return;
      }
      const existing = plugins.find((p) => p.type === manifest.type) ?? null;
      if (existing && manifest.version < existing.version) {
        setProblem({
          kind: 'text',
          text: t('plugins.settings.errors.pluginOlder', { version: existing.version }),
        });
        return;
      }
      setReview({ bytes, summary: read.summary, existing });
    } catch {
      setProblem({ kind: 'bundle', errors: [{ code: 'bundle.zip' }] });
    } finally {
      setReading(false);
    }
  };

  const send = async () => {
    if (!review) return;
    setBusy(true);
    try {
      const { plugin, created } = await store.api.add(workspaceId, review.bytes);
      store.put(workspaceId, plugin);
      setReview(null);
      setMessage(
        created || !review.existing
          ? t('plugins.settings.added', { name: nameOf(plugin) })
          : t('plugins.settings.updated', { name: nameOf(plugin), version: plugin.version }),
      );
    } catch (error) {
      setReview(null);
      failed(error);
    } finally {
      setBusy(false);
    }
  };

  const turn = async (plugin: WorkspacePlugin, enabled: boolean) => {
    setBusy(true);
    setProblem(null);
    setMessage(null);
    try {
      const changed = await store.api.setEnabled(workspaceId, plugin.id, enabled);
      store.put(workspaceId, changed);
      setMessage(
        t(enabled ? 'plugins.settings.turnedOn' : 'plugins.settings.turnedOff', {
          name: nameOf(changed),
        }),
      );
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (plugin: WorkspacePlugin) => {
    setBusy(true);
    setProblem(null);
    setMessage(null);
    try {
      await store.api.remove(workspaceId, plugin.id);
      store.drop(workspaceId, plugin.id);
      setRemoving(null);
      setMessage(t('plugins.settings.removed', { name: nameOf(plugin) }));
    } catch (error) {
      setRemoving(null);
      failed(error);
    } finally {
      setBusy(false);
    }
  };

  const loading = state.status === 'idle' || (state.status === 'loading' && !plugins.length);
  const loadFailed = state.status === 'failed' && !store.plugins(workspaceId);

  return (
    <section
      className="cgw-plugins-settings"
      aria-labelledby={titleId}
      data-testid="plugins-settings"
    >
      <h2 id={titleId}>{t('plugins.settings.title')}</h2>
      <p className="cgw-muted" id={introId}>
        {t('plugins.settings.intro')}
      </p>
      {!manages ? <p className="cgw-muted">{t('plugins.settings.othersNote')}</p> : null}
      {loadFailed ? (
        <p role="alert">
          {t('plugins.settings.loadFailed')}{' '}
          <button
            type="button"
            className="cgw-button"
            onClick={() => void store.load(workspaceId, true)}
          >
            {t('plugins.settings.retry')}
          </button>
        </p>
      ) : loading ? (
        <p aria-busy="true" className="cgw-muted">
          {t('plugins.settings.loading')}
        </p>
      ) : plugins.length ? (
        <table className="cgw-plugins-table" data-testid="plugins-list">
          <caption className="cgw-visually-hidden">{t('plugins.settings.title')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('plugins.settings.columnName')}</th>
              <th scope="col">{t('plugins.settings.columnVersion')}</th>
              <th scope="col">{t('plugins.settings.columnSize')}</th>
              <th scope="col">{t('plugins.settings.columnAdded')}</th>
              <th scope="col">{t('plugins.settings.columnState')}</th>
              {manages ? (
                <th scope="col">
                  <span className="cgw-visually-hidden">{t('plugins.settings.columnActions')}</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {plugins.map((plugin) => {
              const name = nameOf(plugin);
              const when = plugin.updatedAt || plugin.addedAt;
              const date = when ? dates.format(new Date(when)) : '';
              return (
                <tr key={plugin.id} data-plugin={plugin.type}>
                  <td>
                    <span dir="auto" className="cgw-plugins-name">
                      {name}
                    </span>
                    <code dir="ltr" className="cgw-plugins-type">
                      {plugin.type}
                    </code>
                  </td>
                  <td>{plugin.version}</td>
                  <td>{sizes.format(plugin.sizeBytes / 1024)}</td>
                  <td className="cgw-muted">
                    {plugin.addedBy
                      ? t('plugins.settings.addedBy', { name: plugin.addedBy.name, when: date })
                      : t('plugins.settings.addedOn', { when: date })}
                  </td>
                  <td data-testid="plugin-state">
                    {t(plugin.enabled ? 'plugins.settings.on' : 'plugins.settings.off')}
                  </td>
                  {manages ? (
                    <td>
                      <div className="cgw-plugins-actions">
                        <button
                          type="button"
                          className="cgw-button"
                          disabled={busy}
                          aria-label={t(
                            plugin.enabled
                              ? 'plugins.settings.turnOffNamed'
                              : 'plugins.settings.turnOnNamed',
                            { name },
                          )}
                          onClick={() => void turn(plugin, !plugin.enabled)}
                        >
                          {t(
                            plugin.enabled ? 'plugins.settings.turnOff' : 'plugins.settings.turnOn',
                          )}
                        </button>
                        <button
                          type="button"
                          className="cgw-button"
                          disabled={busy || reading}
                          aria-label={t('plugins.settings.updateNamed', { name })}
                          onClick={() => choose(plugin)}
                        >
                          {t('plugins.settings.update')}
                        </button>
                        <button
                          type="button"
                          className="cgw-button is-danger"
                          disabled={busy}
                          aria-label={t('plugins.settings.removeNamed', { name })}
                          onClick={() => setRemoving(plugin)}
                        >
                          {t('plugins.settings.remove')}
                        </button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="cgw-muted" data-testid="plugins-none">
          {t('plugins.settings.none')}
        </p>
      )}
      {manages ? (
        <p>
          <button
            type="button"
            className="cgw-button"
            disabled={busy || reading}
            aria-describedby={introId}
            data-testid="plugins-add"
            onClick={() => choose(null)}
          >
            {t('plugins.settings.add')}
          </button>
          <input
            ref={input}
            type="file"
            accept=".zip,application/zip"
            hidden
            tabIndex={-1}
            aria-hidden="true"
            data-testid="plugins-file"
            onChange={(event) => void chosen(event.target.files?.[0])}
          />
        </p>
      ) : null}
      {reading ? (
        <p role="status" aria-busy="true" className="cgw-muted">
          {t('plugins.settings.reading')}
        </p>
      ) : null}
      {problem ? (
        <div role="alert" className="cgw-plugins-problem" data-testid="plugins-problem">
          {problem.kind === 'text' ? (
            <p>{problem.text}</p>
          ) : (
            <ul>
              {problem.errors.map((error, i) => (
                <li key={i}>{bundleText(t, error)}</li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {message ? (
        <p role="status" className="cgw-muted" data-testid="plugins-message">
          {message}
        </p>
      ) : null}
      {review ? (
        <ReviewDialog
          review={review}
          busy={busy}
          language={language}
          onSend={() => void send()}
          onClose={() => setReview(null)}
        />
      ) : null}
      {removing ? (
        <Dialog
          role="alertdialog"
          title={t('plugins.settings.removeNamed', { name: nameOf(removing) })}
          onClose={() => setRemoving(null)}
        >
          <p>{t('plugins.settings.removeConfirm', { name: nameOf(removing) })}</p>
          <div className="cgw-dialog-buttons">
            <button
              type="button"
              className="cgw-button is-danger"
              disabled={busy}
              onClick={() => void remove(removing)}
            >
              {t('plugins.settings.remove')}
            </button>
            <button type="button" className="cgw-button" onClick={() => setRemoving(null)}>
              {t('plugins.settings.cancel')}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

/** What the bundle is, shown before it is sent: its names, type, version, what it reads. */
function ReviewDialog({
  review,
  busy,
  language,
  onSend,
  onClose,
}: {
  review: Review;
  busy: boolean;
  language: 'en' | 'ar';
  onSend(): void;
  onClose(): void;
}) {
  const { t: typed } = useTranslation();
  const t = typed as unknown as Translate;
  const { manifest } = review.summary;
  const name = manifest.name[language] || manifest.name.en;
  const update = !!review.existing;
  return (
    <Dialog
      title={t(update ? 'plugins.settings.reviewUpdate' : 'plugins.settings.reviewAdd', { name })}
      onClose={onClose}
    >
      <div className="cgw-plugins-review" data-testid="plugins-review">
        <dl>
          <dt>{t('plugins.settings.fieldName')}</dt>
          <dd>
            <span lang="en" dir="ltr">
              {manifest.name.en}
            </span>
            {' · '}
            <span lang="ar" dir="rtl">
              {manifest.name.ar}
            </span>
          </dd>
          <dt>{t('plugins.settings.fieldType')}</dt>
          <dd>
            <code dir="ltr">{manifest.type}</code>
          </dd>
          <dt>{t('plugins.settings.fieldVersion')}</dt>
          <dd>
            {update
              ? t('plugins.settings.fromVersion', {
                  version: manifest.version,
                  installed: review.existing!.version,
                })
              : manifest.version}
          </dd>
          <dt>{t('plugins.settings.fieldReads')}</dt>
          <dd>
            {t(
              manifest.reads.rows ? 'plugins.settings.readsRows' : 'plugins.settings.readsNothing',
            )}
          </dd>
        </dl>
        {manifest.reads.rows ? (
          <p className="cgw-plugins-warning">{t('plugins.settings.rowsNote')}</p>
        ) : null}
        <p className="cgw-muted">{t('plugins.settings.sandboxNote')}</p>
      </div>
      <div className="cgw-dialog-buttons">
        <button
          type="button"
          className="cgw-button is-primary"
          disabled={busy}
          data-testid="plugins-confirm"
          onClick={onSend}
        >
          {busy
            ? t('plugins.settings.sending')
            : t(update ? 'plugins.settings.confirmUpdate' : 'plugins.settings.confirmAdd')}
        </button>
        <button type="button" className="cgw-button" onClick={onClose}>
          {t('plugins.settings.cancel')}
        </button>
      </div>
    </Dialog>
  );
}
