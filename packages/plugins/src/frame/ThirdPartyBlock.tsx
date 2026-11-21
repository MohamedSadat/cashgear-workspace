// A third-party plugin's block (Phase 10, M10.4): the plugin's bundle in its sandboxed frame
// (PluginFrameHost, plugin-frame.1) when the workspace has the plugin on and the server can be
// reached; else a placeholder naming the plugin, or its type where its name is not known here (not
// installed, turned off, no connection, signed out, a local workspace, a share link, a page of
// another workspace). The document keeps the block's type, version and props exactly as they are:
// the plugin writes its own props only (one undoable edit each, the host's `$` keys kept), when
// the reader may edit and the block was not written by a later version of the plugin. A plugin
// that asks for rows (`reads.rows`) is shown the view its block names (`$view`, chosen with the
// linked-view picker, written here, never by the plugin), read through the database host.
import { CgButton } from '@cashgear/ui';
import { useRowSource, type DatabaseHost, type RowRequest } from '@cgw/database';
import type { ViewRecord } from '@cgw/workspace';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { usePluginT } from '../i18n';
import type { PluginFrameOptions } from '../types';
import { Message } from '../views/common';
import type { Rows } from './contract';
import { PluginFrameHost, type PluginFrameStop } from './host';
import { mergeProps, readBlockProps, withView, type ViewRef } from './props';
import { rowsOf, rowsProperties, rowsRequest } from './rows';
import type { InstalledPlugin, ThirdPartyDeps } from './types';

type Language = 'en' | 'ar';

const nameOf = (plugin: InstalledPlugin, language: Language) =>
  plugin.name[language] || plugin.name.en || plugin.type;

export function ThirdPartyBlock({
  options,
  deps,
}: {
  options: PluginFrameOptions;
  deps: ThirdPartyDeps;
}) {
  const { t, locale } = usePluginT();
  const language: Language = locale.startsWith('ar') ? 'ar' : 'en';
  const type = options.type ?? '';
  const { source } = deps;
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source]);
  const read = useCallback(() => source.availability(type), [source, type]);
  const availability = useSyncExternalStore(subscribe, read, read);
  useEffect(() => source.ensure(), [source]);

  switch (availability.kind) {
    case 'loading':
      return <Message text={t('common.loading')} busy />;
    case 'installed':
      return (
        <Installed
          key={`${availability.plugin.id}:${availability.plugin.version}:${availability.plugin.revision ?? ''}`}
          plugin={availability.plugin}
          online={availability.online}
          options={options}
          deps={deps}
          language={language}
        />
      );
    case 'missing':
      return <Note text={t('frame.notInstalled', { type })} />;
    case 'disabled':
      return <Note text={t('frame.disabled', { name: nameOf(availability.plugin, language) })} />;
    case 'offline':
      return <Note text={t('frame.offlineType', { type })} />;
    case 'signedOut':
      return <Note text={t('frame.signedOutType', { type })} />;
    case 'failed':
      return (
        <Message text={t('frame.listFailed', { type })} error>
          <CgButton appearance="outline" onClick={() => source.refresh()}>
            {t('frame.retry')}
          </CgButton>
        </Message>
      );
    case 'local':
      return <Note text={t('frame.local', { type })} />;
    case 'shared':
      return <Note text={t('frame.shared', { type })} />;
    case 'otherWorkspace':
      return <Note text={t('frame.otherWorkspace', { type })} />;
  }
}

/** A placeholder's text, read by screen readers as part of the block. */
function Note({ text }: { text: string }) {
  return (
    <div className="cgw-plugin-message" role="note" data-plugin-note="">
      <span>{text}</span>
    </div>
  );
}

const NO_VIEWS: ViewRecord[] = [];
const noSubscribe = () => () => {};

/** A view's rows for the plugin, live: ready once its first answer is in (or there is none to ask). */
function useRows(host: DatabaseHost | null, view: ViewRef | null) {
  const subscribe = useCallback(
    (listener: () => void) => (host ? host.subscribe(listener) : noSubscribe()),
    [host],
  );
  const databaseId = view?.databaseId ?? null;
  const readDatabase = () => (host && databaseId ? host.database(databaseId) : null);
  const readViews = () => (host && databaseId ? host.views(databaseId) : NO_VIEWS);
  const readTitle = () => (host && databaseId ? (host.pageTitle(databaseId) ?? null) : null);
  const database = useSyncExternalStore(subscribe, readDatabase, readDatabase);
  const views = useSyncExternalStore(subscribe, readViews, readViews);
  const title = useSyncExternalStore(subscribe, readTitle, readTitle);
  const viewRecord = view ? (views.find((v) => v.id === view.viewId) ?? views[0] ?? null) : null;
  const requestText = viewRecord && database ? JSON.stringify(rowsRequest(viewRecord)) : null;
  const request = useMemo<RowRequest | null>(
    () => (requestText ? (JSON.parse(requestText) as RowRequest) : null),
    [requestText],
  );
  const { snapshot } = useRowSource(
    host ?? (null as unknown as DatabaseHost),
    databaseId ?? '',
    host ? request : null,
  );
  const defs = useMemo(
    () => (host && database && viewRecord ? rowsProperties(host, database, viewRecord) : []),
    [host, database, viewRecord],
  );
  const rows = useMemo<Rows | null>(() => {
    if (!host || !database || !viewRecord || snapshot.error) return null;
    if (snapshot.loading && !snapshot.rows.length) return null;
    return rowsOf(database, viewRecord, defs, snapshot);
  }, [host, database, viewRecord, defs, snapshot]);
  const ready =
    !host ||
    !view ||
    !database ||
    !viewRecord ||
    !!snapshot.error ||
    !snapshot.loading ||
    snapshot.rows.length > 0;
  return { rows, ready, title };
}

/** The app's theme, live; else the document's. */
function useLook(theme: ThirdPartyDeps['theme']): 'light' | 'dark' {
  const subscribe = useCallback(
    (listener: () => void) => (theme ? theme.subscribe(listener) : noSubscribe()),
    [theme],
  );
  const read = () =>
    theme?.theme ??
    (document.documentElement.dataset.cgTheme === 'dark' ? ('dark' as const) : ('light' as const));
  return useSyncExternalStore(subscribe, read, read);
}

type Phase =
  | { kind: 'asking' }
  | { kind: 'ready'; url: string }
  | { kind: 'noAddress'; code: string }
  | { kind: 'unavailable' }
  | { kind: 'stopped'; why: PluginFrameStop }
  | { kind: 'failed' };

function Installed({
  plugin,
  online,
  options,
  deps,
  language,
}: {
  plugin: InstalledPlugin;
  online: boolean;
  options: PluginFrameOptions;
  deps: ThirdPartyDeps;
  language: Language;
}) {
  const { t, rtl } = usePluginT();
  const name = nameOf(plugin, language);
  const block = useMemo(() => readBlockProps(options.props), [options.props]);
  const newer = options.version !== null && options.version > plugin.version;
  const editable = options.editable && !newer;
  const theme = useLook(deps.theme);
  const direction: 'ltr' | 'rtl' = rtl ? 'rtl' : 'ltr';
  const view = plugin.reads.rows ? block.view : null;
  const rows = useRows(plugin.reads.rows ? deps.data.databases : null, view);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'asking' });
  const phaseNow = useRef(phase);
  phaseNow.current = phase;

  // What the frame's callbacks read: always the latest block and options.
  const latest = useRef({ options, block, editable, plugin });
  latest.current = { options, block, editable, plugin };

  // A frame address (a ticket of a few minutes) for each frame made: Reload asks again.
  const { source, pluginsOrigin } = deps;
  useEffect(() => {
    if (!pluginsOrigin) {
      setPhase({ kind: 'unavailable' });
      return;
    }
    let live = true;
    setPhase({ kind: 'asking' });
    source.frameUrl(plugin.id).then(
      (url) => live && setPhase({ kind: 'ready', url }),
      (error: unknown) => {
        if (!live) return;
        const code = (error as { code?: string } | null)?.code ?? 'failed';
        // The plugin was turned off or removed meanwhile: the list says so once read again.
        if (code === 'notFound') source.refresh();
        setPhase({ kind: 'noAddress', code });
      },
    );
    return () => {
      live = false;
    };
  }, [source, pluginsOrigin, plugin.id, attempt]);

  // Back online after the address could not be asked for: asked again. A frame already drawn
  // goes on as it is.
  useEffect(() => {
    const now = phaseNow.current;
    if (online && now.kind === 'noAddress' && now.code === 'offline') setAttempt((n) => n + 1);
  }, [online]);

  // The frame is made once its first rows are known (when it is shown any), and made again only
  // for a new address: a view chosen later reaches it as a `rows` message.
  const url = phase.kind === 'ready' ? phase.url : null;
  const [started, setStarted] = useState<string | null>(null);
  useEffect(() => {
    if (url && rows.ready) setStarted(url);
  }, [url, rows.ready]);
  const live = url !== null && started === url;

  const holder = useRef<HTMLDivElement>(null);
  const frame = useRef<PluginFrameHost | null>(null);
  const initial = useRef({ block, rows: rows.rows, theme, direction, language, editable, newer });
  initial.current = { block, rows: rows.rows, theme, direction, language, editable, newer };
  useEffect(() => {
    if (!live || !url || !holder.current || !pluginsOrigin) return;
    const now = initial.current;
    let made: PluginFrameHost;
    try {
      made = new PluginFrameHost(
        holder.current,
        {
          pluginsOrigin,
          url,
          title: t('frame.title', { name }),
          plugin: { type: plugin.type, version: plugin.version },
          block: { version: options.version, editable: now.editable, newer: now.newer },
          props: now.block.shown,
          look: { theme: now.theme, direction: now.direction, language: now.language },
          rows: now.rows,
          height: plugin.height,
        },
        {
          setProps: (props) => {
            const current = latest.current;
            if (!current.editable) return 'props.readOnly';
            current.options.setProps(mergeProps(current.block.raw, props), current.plugin.version);
            return 'saved';
          },
          stopped: (why) => setPhase({ kind: 'stopped', why }),
          error: () => {
            frame.current?.destroy();
            setPhase({ kind: 'failed' });
          },
        },
      );
    } catch {
      setPhase({ kind: 'unavailable' });
      return;
    }
    frame.current = made;
    return () => {
      made.destroy();
      if (frame.current === made) frame.current = null;
    };
    // Made again only for a new address; every other change goes through the frame's setters.
  }, [live, url, pluginsOrigin]);

  useEffect(() => frame.current?.setProps(block.shown), [block.shown]);
  useEffect(
    () => frame.current?.setLook({ theme, direction, language }),
    [theme, direction, language],
  );
  useEffect(
    () => frame.current?.setBlock({ version: options.version, editable, newer }),
    [options.version, editable, newer],
  );
  useEffect(() => frame.current?.setRows(rows.rows), [rows.rows]);

  const reload = () => setAttempt((n) => n + 1);
  const pick = deps.data.pickDatabase;
  const chooseView = () =>
    void pick?.().then((ref) => {
      const current = latest.current;
      if (!ref || !current.editable) return;
      current.options.setProps(
        withView(current.block.raw, { databaseId: ref.databaseId, viewId: ref.viewId }),
        current.options.version ?? current.plugin.version,
      );
    });

  let problem: { text: string; reload?: boolean; busy?: boolean } | null = null;
  switch (phase.kind) {
    case 'asking':
      problem = { text: t('frame.loading', { name }), busy: true };
      break;
    case 'ready':
      if (!live) problem = { text: t('frame.loading', { name }), busy: true };
      break;
    case 'noAddress':
      problem =
        phase.code === 'offline'
          ? { text: t('frame.offline', { name }) }
          : { text: t('frame.loadFailed', { name }), reload: true };
      break;
    case 'unavailable':
      problem = { text: t('frame.unavailable', { name }) };
      break;
    case 'stopped':
      problem = {
        text: t(
          phase.why === 'timeout'
            ? 'frame.timeout'
            : phase.why === 'contract'
              ? 'frame.contract'
              : 'frame.stopped',
          { name },
        ),
        reload: true,
      };
      break;
    case 'failed':
      problem = { text: t('frame.failed', { name }), reload: true };
      break;
  }

  return (
    <div className="cgw-plugin-frame" data-plugin-type={plugin.type} data-phase={phase.kind}>
      {plugin.reads.rows ? (
        view ? (
          <div className="cgw-plugin-frame-bar">
            <span dir="auto" className="cgw-plugin-frame-source">
              {t('frame.rowsFrom', { title: rows.title || t('common.untitledDatabase') })}
            </span>
            {editable && pick ? (
              <CgButton appearance="ghost" onClick={chooseView}>
                {t('common.changeDatabase')}
              </CgButton>
            ) : null}
          </div>
        ) : editable && pick ? (
          <Message text={t('frame.chooseView', { name })}>
            <CgButton appearance="outline" onClick={chooseView}>
              {t('common.chooseDatabase')}
            </CgButton>
          </Message>
        ) : null
      ) : null}
      {newer ? <p className="cgw-plugin-note">{t('frame.newer', { name })}</p> : null}
      {problem ? (
        <Message text={problem.text} busy={problem.busy} error={!!problem.reload}>
          {problem.reload ? (
            <CgButton appearance="outline" onClick={reload}>
              {t('frame.reload')}
            </CgButton>
          ) : null}
        </Message>
      ) : null}
      <div ref={holder} className="cgw-plugin-frame-holder" hidden={!live} />
    </div>
  );
}
