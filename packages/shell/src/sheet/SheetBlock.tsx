// A workbook block in a page (`EditorHost.workbooks.mount`, docs/INTEGRATIONS.md "Cash Gear
// Sheet"): the workbook's name and when its version was saved, then its view. Before the live
// embed has drawn, and offline, the stored picture with its date (this device's, else the
// server's); online and near the viewport, Sheet's `/embed` in a sandboxed frame from the build's
// one Sheet origin (`SheetEmbed`, sheet-embed.1), given a signed URL the server made after the
// workbook's own check. Every other state says what it is: no access (no picture), in the trash,
// deleted, empty, each embed error, offline, a local workspace. An editor of the workbook asks the
// embed for a picture of each new version or view and sends it; this device keeps the last one.
import { CgContextMenu, type CgContextMenuActions, type CgContextMenuItem } from '@cashgear/ui';
import { getSigned } from '@cgw/api';
import {
  SheetEmbed,
  parseRange,
  rangeCells,
  viewHash,
  type SheetChartInfo,
  type SheetEmbedEvents,
  type SheetEmbedOptions,
  type SheetErrorCode,
  type SheetLoaded,
  type SheetLocale,
  type SheetMountOptions,
  type SheetSize,
  type SheetSource,
  type SheetView,
} from '@cgw/editor';
import type { Id } from '@cgw/workspace';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { Cloud } from '../cloud/cloud';
import type { WorkspacePlatform } from '../platform';
import { navigate } from '../route';
import type { WorkspaceSession } from '../session';
import type { ThemeController } from '../theme';
import {
  canEditWorkbook,
  failureCode,
  statusOf,
  workbookApi,
  type Workbook,
  type WorkbookApi,
} from './api';
import type { WorkbookPictures } from './pictures';
import { openInSheet, sheetOriginOf } from './launch';
import { requestRangeImport } from './requests';
import {
  DEFAULT_HEIGHT,
  MAX_HEIGHT,
  MIN_HEIGHT,
  RANGE_EXAMPLE,
  blockView,
  drawnIs,
  previewRequest,
  versionOfEtag,
} from './view';

/** What the embed is to the block (SheetEmbed, or a test's stand-in). */
export interface EmbedLike {
  readonly frame: HTMLIFrameElement;
  setView(view: SheetView): void;
  setTheme(look: Pick<SheetEmbedOptions, 'theme' | 'direction' | 'locale'>): void;
  refresh(source: SheetSource): void;
  requestPreview: SheetEmbed['requestPreview'];
  destroy(): void;
}

export type EmbedFactory = (
  container: HTMLElement,
  options: SheetEmbedOptions,
  events: SheetEmbedEvents,
) => EmbedLike;

export interface SheetBlockDeps {
  session: WorkspaceSession;
  /** The connection to the server, which may come after the block is drawn. */
  cloud: { get(): Cloud | null; subscribe(listener: () => void): () => void };
  platform: Pick<WorkspacePlatform, 'kind' | 'openExternal' | 'sheetOrigin'>;
  theme: Pick<ThemeController, 'theme' | 'subscribe'>;
  pictures: WorkbookPictures;
  /** The page holding the block (a range import's new database goes under it). */
  pageId: Id | null;
  /** Tests: the workbook routes (default: over the cloud's client). */
  api?: WorkbookApi;
  /** Tests: makes the embed (default: SheetEmbed). */
  embed?: EmbedFactory;
  /** Tests: how a launch link is opened in a browser (default: a new tab, `noopener`). */
  openTab?: (url: string) => void;
}

type Reach = 'local' | 'checking' | 'signedOut' | 'offline' | 'online';

/** Whether the workbook routes can be asked now. */
function useReach(session: WorkspaceSession, cloud: Cloud | null): Reach {
  const read = (): Reach => {
    if (session.current?.localOnly !== false || !cloud) return 'local';
    const account = cloud.account;
    if (account === undefined) return 'checking';
    if (!account) return 'signedOut';
    const state = cloud.status.state;
    if (state === 'offline') return 'offline';
    if (state === 'signedOut') return 'signedOut';
    return 'online';
  };
  return useSyncExternalStore((listener) => {
    const offs = [session.mirror.subscribe(listener), cloud?.subscribe(listener)];
    return () => offs.forEach((off) => off?.());
  }, read);
}

type RecordState =
  | { kind: 'loading' }
  | { kind: 'ok'; workbook: Workbook }
  | { kind: 'noAccess' }
  | { kind: 'deleted' }
  | { kind: 'failed' }
  | { kind: 'offline' };

type LiveState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'loaded' }
  | { kind: 'error'; code: SheetErrorCode };

interface Picture {
  url: string;
  madeAt: string;
  etag: string;
  hash: string;
  /** The workbook's name when the picture was kept, for the block offline. */
  name?: string;
}

const sourceOf = (readUrl: string, etag: string): SheetSource => ({
  kind: 'url',
  url: readUrl,
  etag,
});

const ERROR_TEXT: Record<SheetErrorCode, string> = {
  'source.unavailable': 'sheets.errorUnavailable',
  'source.forbidden': 'sheets.errorUnavailable',
  'view.notFound': 'sheets.errorNotFound',
  'workbook.tooLarge': 'sheets.errorTooLarge',
  'range.tooLarge': 'sheets.errorRangeTooLarge',
  'contract.unsupported': 'sheets.errorContract',
};

export function SheetBlock({
  options,
  deps,
}: {
  options: SheetMountOptions;
  deps: SheetBlockDeps;
}) {
  const { t, i18n } = useTranslation();
  const { session, platform, pictures } = deps;
  const cloud = useSyncExternalStore(deps.cloud.subscribe, deps.cloud.get);
  const reach = useReach(session, cloud);
  const theme = useSyncExternalStore(deps.theme.subscribe, () => deps.theme.theme);
  const language: SheetLocale = i18n.language === 'ar' ? 'ar' : 'en';
  const api = useMemo(() => deps.api ?? (cloud ? workbookApi(cloud.api) : null), [deps.api, cloud]);
  const workbookId = options.workbookId;
  const view = useMemo(
    () => blockView({ sheet: options.sheet, range: options.range, chartId: options.chartId }),
    [options.sheet, options.range, options.chartId],
  );
  const viewKey = JSON.stringify(view);
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void viewHash(view).then((h) => live && setHash(h));
    return () => {
      live = false;
    };
    // The view's text is what matters, not the object.
  }, [viewKey]);

  // ---- The record ---------------------------------------------------------------------------
  const [record, setRecord] = useState<RecordState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (reach !== 'online' || !api) return;
    let live = true;
    api.get(workbookId).then(
      (workbook) => live && setRecord({ kind: 'ok', workbook }),
      (error: unknown) => {
        if (!live) return;
        const status = statusOf(error);
        setRecord(
          status === 404
            ? { kind: 'noAccess' }
            : status === 410
              ? { kind: 'deleted' }
              : failureCode(error) === 'offline'
                ? { kind: 'offline' }
                : { kind: 'failed' },
        );
      },
    );
    return () => {
      live = false;
    };
  }, [reach, api, workbookId, attempt]);
  const workbook = record.kind === 'ok' ? record.workbook : null;
  const trashed = !!workbook?.trashedAt;
  const hasVersion = !!workbook?.versionId;

  // ---- The picture --------------------------------------------------------------------------
  const [picture, setPicture] = useState<Picture | null>(null);
  const shownPicture = useRef<Picture | null>(null);
  const showPicture = useCallback((bytes: Uint8Array, about: Omit<Picture, 'url'>) => {
    const url = URL.createObjectURL(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
    );
    if (shownPicture.current) URL.revokeObjectURL(shownPicture.current.url);
    shownPicture.current = { url, ...about };
    setPicture(shownPicture.current);
  }, []);
  useEffect(
    () => () => {
      if (shownPicture.current) URL.revokeObjectURL(shownPicture.current.url);
      shownPicture.current = null;
    },
    [],
  );
  // Offline, the device's; online, once the server said the reader may see the workbook.
  const pictureAllowed = reach === 'offline' || (!!workbook && !trashed && hasVersion);
  const currentEtag = workbook?.etag ?? null;
  useEffect(() => {
    if (!hash || !pictureAllowed) return;
    let live = true;
    void (async () => {
      const kept = await pictures.get(workbookId, hash);
      if (!live) return;
      if (kept)
        showPicture(kept.bytes, {
          madeAt: kept.meta.madeAt,
          etag: kept.meta.etag,
          hash,
          name: kept.meta.name,
        });
      else if (shownPicture.current?.hash !== hash) setPicture(null);
      if (reach !== 'online' || !api || !workbook || kept?.meta.etag === currentEtag) return;
      try {
        const found = await api.picture(workbookId, hash);
        if (!live || !found) return;
        if (kept && Date.parse(kept.meta.madeAt) >= Date.parse(found.madeAt)) return;
        const response = await getSigned(found.url);
        if (!live || !response.ok) return;
        const bytes = new Uint8Array(await response.arrayBuffer());
        await pictures.put(workbook, hash, bytes, {
          madeAt: found.madeAt,
          versionId: found.versionId,
          etag: found.etag,
          width: found.width,
          height: found.height,
          name: workbook.name,
        });
        if (live) showPicture(bytes, { madeAt: found.madeAt, etag: found.etag, hash });
      } catch {
        // No picture from the server now: the device's, if any, stays.
      }
    })();
    return () => {
      live = false;
    };
    // `workbook` changes with each read of the record; its version is what matters here.
  }, [hash, pictureAllowed, reach, api, workbookId, currentEtag, pictures, showPicture]);

  // ---- The live embed -----------------------------------------------------------------------
  const stage = useRef<HTMLDivElement>(null);
  const embedRef = useRef<EmbedLike | null>(null);
  const [live, setLive] = useState<LiveState>({ kind: 'idle' });
  const [loaded, setLoaded] = useState<SheetLoaded | null>(null);
  const [size, setSize] = useState<SheetSize | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (reach === 'online') setConnected(true);
  }, [reach]);
  const origin = useMemo(() => sheetOriginOf(platform), [platform]);
  const wantLive = !!workbook && !trashed && hasVersion && !!origin && connected && !!api;

  // What the embed's events read: the latest of each, not the first render's.
  const latest = useRef({ view, hash, workbook, theme, language, options });
  latest.current = { view, hash, workbook, theme, language, options };
  const pictured = useRef(new Set<string>());
  const retried = useRef(false);
  /** The view the embed was last sent. */
  const sentView = useRef<string | null>(null);
  /** "Open in Cash Gear Sheet", as of this render (the embed's own button calls it too). */
  const launchSheet = useRef(async () => {});

  const askPicture = useCallback(
    (drawn: SheetLoaded, frameHeight: number) => {
      const embed = embedRef.current;
      const { view: wanted, hash: h, workbook: book } = latest.current;
      if (!embed || !h || !book || !api || !drawnIs(drawn.view, wanted)) return;
      const key = `${drawn.etag}|${h}`;
      if (pictured.current.has(key)) return;
      if (shownPicture.current?.hash === h && shownPicture.current.etag === drawn.etag) return;
      pictured.current.add(key);
      const width = stage.current?.getBoundingClientRect().width || drawn.size.width;
      const request = previewRequest(
        Math.min(width, drawn.size.width),
        frameHeight,
        typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
      );
      void embed
        .requestPreview(request)
        .then(async (preview) => {
          const bytes = new Uint8Array(preview.bytes);
          const versionId = versionOfEtag(preview.etag);
          // Only someone who may edit the workbook changes what others are shown.
          if (canEditWorkbook(book.access))
            await api.putPicture(book.id, h, bytes, versionId).catch(() => undefined);
          const madeAt = new Date().toISOString();
          await pictures.put(book, h, bytes, {
            madeAt,
            versionId,
            etag: preview.etag,
            width: preview.width,
            height: preview.height,
            name: book.name,
          });
          if (latest.current.hash === h)
            showPicture(bytes, { madeAt, etag: preview.etag, hash: h });
        })
        .catch(() => undefined);
    },
    [api, pictures, showPicture],
  );

  const freshSource = useCallback(async (): Promise<SheetSource | null> => {
    if (!api) return null;
    const content = await api.content(workbookId);
    return content.readUrl && content.etag ? sourceOf(content.readUrl, content.etag) : null;
  }, [api, workbookId]);

  /** A refusal of the content route: the record says what the block is now. */
  const contentFailed = useCallback((error: unknown) => {
    const status = statusOf(error);
    if (status === 404) setRecord({ kind: 'noAccess' });
    else if (status === 410)
      setRecord((current) =>
        current.kind === 'ok' && current.workbook.trashedAt ? current : { kind: 'deleted' },
      );
    else setLive({ kind: 'error', code: 'source.unavailable' });
  }, []);

  useEffect(() => {
    const container = stage.current;
    if (!wantLive || !container || !origin) return;
    let alive = true;
    let embed: EmbedLike | null = null;
    retried.current = false;
    setLive({ kind: 'connecting' });
    const events: SheetEmbedEvents = {
      loaded: (drawn) => {
        if (!alive) return;
        retried.current = false;
        setLoaded(drawn);
        setSize(drawn.size);
        setLive({ kind: 'loaded' });
        const cap = latest.current.options.height ?? DEFAULT_HEIGHT;
        askPicture(drawn, Math.min(drawn.size.height, cap));
      },
      resize: (next) => alive && setSize(next),
      error: (failure) => {
        if (!alive) return;
        if (failure.code === 'source.forbidden' && !retried.current) {
          // The signed URL expired: one new one, then as unavailable.
          retried.current = true;
          freshSource().then(
            (source) => {
              if (alive && source) embed?.refresh(source);
              else if (alive) setLive({ kind: 'error', code: 'source.unavailable' });
            },
            (error: unknown) => alive && contentFailed(error),
          );
          return;
        }
        setLive({
          kind: 'error',
          code: failure.code === 'source.forbidden' ? 'source.unavailable' : failure.code,
        });
      },
      openRequested: () => alive && void launchSheet.current(),
    };
    void freshSource().then(
      (source) => {
        if (!alive) return;
        if (!source) {
          // The record said there was a version; the content says there is none now.
          setAttempt((n) => n + 1);
          return;
        }
        const now = latest.current;
        const make: EmbedFactory =
          deps.embed ?? ((c, o, e) => new SheetEmbed(c, o, e) as unknown as EmbedLike);
        try {
          embed = make(
            container,
            {
              sheetOrigin: origin,
              source,
              view: now.view,
              theme: now.theme,
              direction: now.language === 'ar' ? 'rtl' : 'ltr',
              locale: now.language,
              title: t('sheets.liveTitle', { name: now.workbook?.name ?? '' }),
            },
            events,
          );
          embedRef.current = embed;
          sentView.current = JSON.stringify(now.view);
        } catch (error) {
          console.warn('The workbook could not be embedded:', error);
          setLive({ kind: 'error', code: 'source.unavailable' });
        }
      },
      (error: unknown) => alive && contentFailed(error),
    );
    return () => {
      alive = false;
      embed?.destroy();
      embedRef.current = null;
      setLoaded(null);
      setSize(null);
      setLive({ kind: 'idle' });
    };
    // The embed is made once per workbook; views, themes and refreshes go to it.
  }, [wantLive, workbookId, origin]);

  // Another view: shown by the same embed.
  useEffect(() => {
    const embed = embedRef.current;
    if (!embed || sentView.current === viewKey) return;
    sentView.current = viewKey;
    try {
      embed.setView(view);
      setLive({ kind: 'connecting' });
    } catch {
      setLive({ kind: 'error', code: 'view.notFound' });
    }
  }, [view, viewKey]);

  // Another theme or language: drawn again, no answer.
  useEffect(() => {
    embedRef.current?.setTheme({
      theme,
      direction: language === 'ar' ? 'rtl' : 'ltr',
      locale: language,
    });
  }, [theme, language]);

  // ---- Actions -------------------------------------------------------------------------------
  const [busy, setBusy] = useState<'refresh' | 'open' | 'restore' | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = async () => {
    setNote(null);
    setBusy('refresh');
    try {
      setAttempt((n) => n + 1);
      const embed = embedRef.current;
      if (embed) {
        retried.current = false;
        const source = await freshSource();
        if (source && embedRef.current === embed) {
          embed.refresh(source);
          setLive({ kind: 'connecting' });
        }
      }
    } catch (error) {
      contentFailed(error);
    } finally {
      setBusy(null);
    }
  };

  launchSheet.current = async () => {
    if (!api) return;
    setNote(null);
    setBusy('open');
    try {
      await openInSheet(api, workbookId, platform, deps.openTab);
    } catch (error) {
      const status = statusOf(error);
      if (status === 404 || status === 410) contentFailed(error);
      else setNote(t('sheets.openFailed'));
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    if (!api || !workbook) return;
    setBusy('restore');
    try {
      const restored = await api.update(workbook.id, { trashed: false }, workbook.version);
      setRecord({ kind: 'ok', workbook: restored });
    } catch {
      setNote(t('sheets.restoreFailed'));
    } finally {
      setBusy(null);
    }
  };

  const [picking, setPicking] = useState(false);
  const notFound = live.kind === 'error' && live.code === 'view.notFound';
  const rangeTooLarge = live.kind === 'error' && live.code === 'range.tooLarge';
  const canPick = options.editable && !!workbook && hasVersion && !trashed;

  const menu = useRef<CgContextMenuActions<null>>(null);
  const items: CgContextMenuItem<null>[] = [
    {
      key: 'refresh',
      text: t('sheets.refresh'),
      disabled: !workbook || reach !== 'online',
      command: () => void refresh(),
    },
    {
      key: 'open',
      text: t('sheets.open'),
      disabled: !workbook || trashed || reach !== 'online',
      command: () => void launchSheet.current(),
    },
    {
      key: 'view',
      text: t('sheets.changeView'),
      visible: options.editable,
      disabled: !canPick,
      beginGroup: true,
      command: () => setPicking(true),
    },
    {
      key: 'import',
      text: t('sheets.importRange'),
      visible: options.editable,
      disabled: !workbook || !hasVersion || trashed || reach !== 'online' || view.kind !== 'range',
      command: () => {
        if (!workbook) return;
        const drawn = loaded?.view.kind === 'range' ? loaded.view : null;
        void requestRangeImport({
          workbookId: workbook.id,
          name: workbook.name,
          sheet: drawn?.sheet ?? options.sheet,
          range: drawn?.range ?? options.range,
          pageId: deps.pageId,
        });
      },
    },
    {
      key: 'list',
      text: t('sheets.allWorkbooks'),
      beginGroup: true,
      command: () => navigate({ kind: 'workbooks' }),
    },
  ];

  // ---- Drawing -------------------------------------------------------------------------------
  const date = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  const cap = options.height ?? DEFAULT_HEIGHT;
  const frameHeight = size ? Math.max(1, Math.min(size.height, cap)) : null;
  const showLive = wantLive && live.kind === 'loaded';

  let message: string | null = null;
  let tone: 'quiet' | 'warn' = 'quiet';
  if (reach === 'local') message = t('sheets.local');
  else if (reach === 'signedOut') message = t('sheets.signIn');
  else if (reach === 'checking') message = t('sheets.loading');
  else if (record.kind === 'loading')
    message =
      reach === 'offline' ? (picture ? null : t('sheets.offlineNone')) : t('sheets.loading');
  else if (record.kind === 'noAccess') message = t('sheets.noAccess');
  else if (record.kind === 'deleted') message = t('sheets.deleted');
  else if (record.kind === 'failed') message = t('sheets.failed');
  else if (record.kind === 'offline') message = picture ? null : t('sheets.offlineNone');
  else if (trashed) message = t('sheets.trashed');
  else if (!hasVersion) message = t('sheets.emptyNote');
  else if (!origin) message = t('sheets.noOrigin');
  else if (live.kind === 'error') {
    message = t(ERROR_TEXT[live.code] as 'sheets.errorUnavailable');
    tone = 'warn';
  } else if (reach === 'offline' && !showLive) message = picture ? null : t('sheets.offlineNone');
  if (message && (record.kind === 'noAccess' || record.kind === 'deleted')) tone = 'warn';

  const offline = reach === 'offline' || record.kind === 'offline';
  // No access, deleted, trashed or empty: never a picture.
  const pictureShown =
    !!picture &&
    !showLive &&
    (offline || (!!workbook && !trashed && hasVersion)) &&
    record.kind !== 'noAccess' &&
    record.kind !== 'deleted';
  const caption = picture
    ? t(offline ? 'sheets.offline' : 'sheets.pictureFrom', { when: date(picture.madeAt) })
    : '';

  // Offline, the name kept with the picture (never when the server said no).
  const name = workbook?.name || (offline ? picture?.name : undefined) || t('sheets.block');
  const saved = workbook?.savedAt
    ? workbook.savedBy
      ? t('sheets.savedBy', { when: date(workbook.savedAt), name: workbook.savedBy.name })
      : t('sheets.saved', { when: date(workbook.savedAt) })
    : workbook && !hasVersion
      ? t('sheets.empty')
      : '';
  const state =
    reach !== 'online' && reach !== 'offline'
      ? reach
      : record.kind !== 'ok'
        ? record.kind
        : trashed
          ? 'trashed'
          : !hasVersion
            ? 'empty'
            : live.kind === 'error'
              ? `error:${live.code}`
              : live.kind;

  return (
    <div className="cgw-sheet" data-state={state} data-offline={offline || undefined}>
      <div className="cgw-sheet-head">
        <span className="cgw-sheet-glyph" aria-hidden="true">
          ⊞
        </span>
        <span className="cgw-sheet-title">
          <span className="cgw-sheet-name" dir="auto">
            {name}
          </span>
          {saved ? <span className="cgw-sheet-saved">{saved}</span> : null}
        </span>
        {workbook && !trashed && reach === 'online' ? (
          <>
            {hasVersion ? (
              <button
                type="button"
                className="cgw-button cgw-sheet-button"
                disabled={busy !== null}
                onClick={() => void refresh()}
              >
                {busy === 'refresh' ? t('sheets.refreshing') : t('sheets.refresh')}
              </button>
            ) : null}
            <button
              type="button"
              className="cgw-button cgw-sheet-button is-primary"
              disabled={busy !== null}
              onClick={() => void launchSheet.current()}
            >
              {busy === 'open' ? t('sheets.opening') : t('sheets.open')}
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="cgw-sheet-icon"
          aria-label={t('sheets.menu')}
          title={t('sheets.menu')}
          onClick={(event) => void menu.current?.showNear(event.currentTarget, null)}
        >
          <span aria-hidden="true">⋯</span>
        </button>
      </div>
      {message ? (
        <p className={`cgw-sheet-message is-${tone}`} role={tone === 'warn' ? 'alert' : 'status'}>
          {message}
        </p>
      ) : null}
      {reach === 'signedOut' && cloud ? (
        <p className="cgw-sheet-actions">
          <button
            type="button"
            className="cgw-button cgw-sheet-button"
            onClick={() => void cloud.signIn(language).catch(() => undefined)}
          >
            {t('sheets.signInButton')}
          </button>
        </p>
      ) : null}
      {trashed && workbook ? (
        <p className="cgw-sheet-actions">
          {canEditWorkbook(workbook.access) ? (
            <button
              type="button"
              className="cgw-button cgw-sheet-button"
              disabled={busy !== null}
              onClick={() => void restore()}
            >
              {t('sheets.restore')}
            </button>
          ) : null}
          <a className="cgw-sheet-link" href="#/workbooks">
            {t('sheets.allWorkbooks')}
          </a>
        </p>
      ) : null}
      {(notFound || rangeTooLarge) && canPick && !picking ? (
        <p className="cgw-sheet-actions">
          <button
            type="button"
            className="cgw-button cgw-sheet-button"
            onClick={() => setPicking(true)}
          >
            {t('sheets.changeView')}
          </button>
        </p>
      ) : null}
      {note ? (
        <p className="cgw-sheet-message is-warn" role="alert">
          {note}
        </p>
      ) : null}
      {picking && workbook ? (
        <ViewPicker
          api={api}
          workbook={workbook}
          sheets={loaded ? loaded.sheets.map((s) => s.name) : null}
          charts={loaded?.charts ?? []}
          options={options}
          onCancel={() => setPicking(false)}
          onApply={(attrs) => {
            setPicking(false);
            options.setAttrs(attrs);
          }}
        />
      ) : null}
      <div className="cgw-sheet-stage">
        {pictureShown && picture ? (
          <figure className="cgw-sheet-picture">
            <img src={picture.url} alt={t('sheets.pictureAlt', { name })} />
            <figcaption>{caption}</figcaption>
          </figure>
        ) : null}
        <div
          ref={stage}
          className="cgw-sheet-live"
          data-shown={showLive || undefined}
          hidden={!wantLive}
          style={showLive && frameHeight ? { blockSize: `${frameHeight}px` } : undefined}
        />
      </div>
      <CgContextMenu<null>
        items={items}
        actionsRef={menu}
        ariaLabel={t('sheets.menu')}
        className="cgw-sheet-menu"
      />
    </div>
  );
}

/**
 * Which part of the workbook the block shows: a sheet (the embed's list, else the server's), a
 * range in A1 notation (at most 5,000 cells; empty is the used range), or a chart the embed drew;
 * and the frame's most height.
 */
function ViewPicker({
  api,
  workbook,
  sheets,
  charts,
  options,
  onApply,
  onCancel,
}: {
  api: WorkbookApi | null;
  workbook: Workbook;
  sheets: string[] | null;
  charts: SheetChartInfo[];
  options: SheetMountOptions;
  onApply(attrs: Partial<SheetMountOptions>): void;
  onCancel(): void;
}) {
  const { t } = useTranslation();
  const [names, setNames] = useState<string[] | null>(sheets);
  useEffect(() => {
    if (sheets || !api) return;
    let live = true;
    api.sheets(workbook.id).then(
      (list) => live && setNames(list.filter((s) => !s.hidden).map((s) => s.name)),
      () => live && setNames([]),
    );
    return () => {
      live = false;
    };
  }, [api, workbook.id, sheets]);
  const [sheet, setSheet] = useState(options.sheet ?? '');
  const [range, setRange] = useState(options.range ?? '');
  const [chart, setChart] = useState(options.chartId ?? '');
  const [height, setHeight] = useState(options.height ? String(options.height) : '');
  const [error, setError] = useState<string | null>(null);
  const id = useMemo(() => `cgw-sheet-view-${Math.random().toString(36).slice(2, 10)}`, []);
  const listed = names ?? [];
  const sheetChoices = sheet && !listed.some((n) => n === sheet) ? [sheet, ...listed] : listed;

  const apply = () => {
    const text = range.trim().toUpperCase();
    if (!chart && text) {
      if (!parseRange(text)) return setError(t('sheets.rangeInvalid'));
      if ((rangeCells(text) ?? Infinity) > 5000) return setError(t('sheets.rangeTooLarge'));
    }
    let most: number | null = null;
    if (height.trim()) {
      const n = Number(height);
      if (!Number.isFinite(n) || n < MIN_HEIGHT || n > MAX_HEIGHT)
        return setError(t('sheets.heightInvalid', { min: MIN_HEIGHT, max: MAX_HEIGHT }));
      most = Math.round(n);
    }
    const picked = charts.find((c) => c.id === chart);
    onApply(
      picked
        ? { sheet: picked.sheet, range: null, chartId: picked.id, height: most }
        : { sheet: sheet || null, range: text || null, chartId: null, height: most },
    );
  };

  return (
    <form
      className="cgw-sheet-picker"
      aria-labelledby={`${id}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <h3 id={`${id}-title`} className="cgw-sheet-picker-title">
        {t('sheets.viewTitle')}
      </h3>
      <label htmlFor={`${id}-sheet`}>{t('sheets.sheet')}</label>
      <select
        id={`${id}-sheet`}
        className="cgw-input"
        value={sheet}
        disabled={!!chart}
        onChange={(event) => setSheet(event.target.value)}
      >
        <option value="">{t('sheets.firstSheet')}</option>
        {sheetChoices.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-range`}>{t('sheets.range')}</label>
      <input
        id={`${id}-range`}
        className="cgw-input"
        dir="ltr"
        value={range}
        disabled={!!chart}
        placeholder={RANGE_EXAMPLE}
        aria-describedby={`${id}-range-hint`}
        onChange={(event) => {
          setRange(event.target.value);
          setError(null);
        }}
      />
      <span id={`${id}-range-hint`} className="cgw-sheet-hint">
        {t('sheets.rangeHint')}
      </span>
      {charts.length ? (
        <>
          <label htmlFor={`${id}-chart`}>{t('sheets.chart')}</label>
          <select
            id={`${id}-chart`}
            className="cgw-input"
            value={chart}
            onChange={(event) => setChart(event.target.value)}
          >
            <option value="">{t('sheets.noChart')}</option>
            {charts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </>
      ) : null}
      <label htmlFor={`${id}-height`}>{t('sheets.height')}</label>
      <input
        id={`${id}-height`}
        className="cgw-input"
        type="number"
        inputMode="numeric"
        min={MIN_HEIGHT}
        max={MAX_HEIGHT}
        value={height}
        placeholder={String(DEFAULT_HEIGHT)}
        onChange={(event) => {
          setHeight(event.target.value);
          setError(null);
        }}
      />
      {error ? (
        <p className="cgw-sheet-message is-warn" role="alert">
          {error}
        </p>
      ) : null}
      <div className="cgw-sheet-picker-buttons">
        <button type="button" className="cgw-button cgw-sheet-button" onClick={onCancel}>
          {t('frame.cancel')}
        </button>
        <button type="submit" className="cgw-button cgw-sheet-button is-primary">
          {t('sheets.apply')}
        </button>
      </div>
    </form>
  );
}
