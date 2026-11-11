import { CgButton } from '@cashgear/ui';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { CommandRegistry } from './commands';
import { ShellContext, useShell, type CommandContext, type ShellServices } from './context';
import { FirstRun } from './FirstRun';
import { Frame } from './frame/Frame';
import { Settings } from './frame/Settings';
import { UpdateButton, useUpdates } from './frame/Updates';
import { applyLanguage, createI18n, type Language } from './i18n';
import type { WorkspacePlatform } from './platform';
import { navigate, parseRoute, useHash } from './route';
import { WorkspaceSession } from './session';
import { Sidebar, useMirror } from './sidebar/Sidebar';
import { Breadcrumbs } from './page/PageHeader';
import { PageMenu } from './page/PageMenu';
import { Notice } from './Notice';
import { TrashView, TRASH_RETENTION_DAYS } from './TrashView';
// The palette loads with the frame: keys typed straight after Ctrl+K must reach its field.
import { Palette } from './search/Palette';
import { ThemeController } from './theme';
import { normaliseText } from '@cgw/workspace';
import type { PageDocument } from '@cgw/doc';

// The editor, Tiptap and Yjs load in their own chunk, after the frame has painted from the mirror
// (ARCHITECTURE.md, Performance: Startup).
const loadPageView = () => import('./page/PageView');
const PageView = lazy(() => loadPageView().then((m) => ({ default: m.PageView })));

export interface WorkspaceAppProps {
  platform: WorkspacePlatform;
}

export function WorkspaceApp({ platform }: WorkspaceAppProps) {
  const [i18n] = useState(() => createI18n());
  const services = useMemo<ShellServices>(
    () => ({
      platform,
      theme: new ThemeController(platform),
      commands: new CommandRegistry<CommandContext>(normaliseText),
      editor: { current: null },
    }),
    [platform],
  );
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  useEffect(() => () => services.theme.dispose(), [services]);
  useEffect(() => {
    let live = true;
    let opened: WorkspaceSession | null = null;
    // The editor's chunk loads while the store opens, not after: the last page opens at start.
    void loadPageView().catch(() => undefined);
    platform
      .openStore()
      .then((store) => WorkspaceSession.start(store))
      .then(
        (started) => {
          opened = started;
          if (live) setSession(started);
          else void started.close();
        },
        (error: unknown) => live && setFailed(error),
      );
    return () => {
      live = false;
      void opened?.close();
    };
  }, [platform]);

  // Pending saves are written before the page is hidden or closed (SYNC_DESIGN.md, Autosave).
  useEffect(() => {
    if (!session) return;
    const flush = () => void session.flushAll();
    const onVisibility = () => document.visibilityState === 'hidden' && flush();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    const offClose = platform.onCloseRequested?.(() => session.flushAll());
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      offClose?.();
    };
  }, [session, platform]);

  return (
    <I18nextProvider i18n={i18n}>
      <ShellContext.Provider value={services}>
        {session ? <Workspace session={session} /> : <Starting failed={failed} />}
      </ShellContext.Provider>
    </I18nextProvider>
  );
}

function Starting({ failed }: { failed: unknown }) {
  const { t } = useTranslation();
  return failed ? (
    <main className="cgw-empty" role="alert">
      <h1>{t('app.storeFailed')}</h1>
      <p>{String(failed)}</p>
    </main>
  ) : (
    <main className="cgw-empty" aria-busy="true">
      {t('app.loading')}
    </main>
  );
}

function Workspace({ session }: { session: WorkspaceSession }) {
  const { t, i18n } = useTranslation();
  const services = useShell();
  const route = parseRoute(useHash());
  const [, rerender] = useState(0);
  const [openDoc, setOpenDoc] = useState<PageDocument | null>(null);
  useMirror(session);
  useEffect(() => session.onSwitch(() => rerender((n) => n + 1)), [session]);

  // Starting with no page asked for (the desktop window, a bare address), the last page visited
  // opens, as it was left.
  useEffect(() => {
    if (location.hash && location.hash !== '#/') return;
    const workspaceId = session.workspaceId;
    const last = workspaceId ? session.mirror.recentOf(workspaceId, 1)[0] : undefined;
    if (last) navigate({ kind: 'page', pageId: last.id }, true);
  }, [session]);

  const setLanguage = useCallback(
    (language: Language) => {
      void i18n.changeLanguage(language);
      applyLanguage(language);
    },
    [i18n],
  );

  useEffect(() => {
    document.title = t('app.title');
  }, [t, i18n.language]);

  useEffect(
    () =>
      services.commands.register(
        ...(['light', 'dark', 'system'] as const).map((preference) => ({
          id: `app.theme.${preference}`,
          group: 'app' as const,
          label: () =>
            t(
              preference === 'light'
                ? 'commands.themeLight'
                : preference === 'dark'
                  ? 'commands.themeDark'
                  : 'commands.themeSystem',
            ),
          keywords: () => [t('keywords.theme')],
          run: () => services.theme.setPreference(preference),
        })),
        ...(['en', 'ar'] as const).map((language) => ({
          id: `app.language.${language}`,
          group: 'app' as const,
          label: () =>
            t(language === 'en' ? 'commands.languageEnglish' : 'commands.languageArabic'),
          keywords: () => [t('keywords.language')],
          run: () => setLanguage(language),
        })),
      ),
    [services, t, setLanguage],
  );

  const page = route.kind === 'page' ? session.mirror.pages.get(route.pageId) : undefined;

  const visiting = page && !page.trashedAt ? page.id : null;
  useEffect(() => {
    if (visiting) void session.recordVisit(visiting).catch(() => undefined);
  }, [session, visiting]);

  const [notice, setNotice] = useState<string | null>(null);
  const onError = useCallback(
    (error: unknown) => {
      const code = (error as { code?: string })?.code;
      console.warn('The change was refused:', error);
      setNotice(
        t(
          code === 'tree.cycle'
            ? 'errors.cycle'
            : code === 'version.conflict'
              ? 'errors.conflict'
              : 'errors.generic',
        ),
      );
    },
    [t],
  );

  // Pages in the trash longer than the retention go for good when the workspace opens.
  useEffect(() => {
    const workspaceId = session.workspaceId;
    if (!workspaceId) return;
    const before = new Date(Date.now() - TRASH_RETENTION_DAYS * 86_400_000).toISOString();
    void session.store
      .purgeTrash(workspaceId, before)
      .then(async (gone) => {
        if (gone.length) session.mirror.load(await session.store.readMirror(null));
      })
      .catch(() => undefined);
  }, [session, session.workspaceId]);

  // In a browser, ask to keep the data; if refused, say so once on this device (SYNC_DESIGN.md).
  useEffect(() => {
    if (!services.platform.requestPersistence || !session.workspaceId) return;
    void services.platform.requestPersistence().then((kept) => {
      if (kept) return;
      try {
        if (localStorage.getItem('cgw-persist-notice')) return;
        localStorage.setItem('cgw-persist-notice', new Date().toISOString());
      } catch {
        // Without storage the notice shows each time, which is the safer side.
      }
      setNotice(t('exchange.browserMayClear'));
    });
  }, [services, session, session.workspaceId, t]);

  const flushAll = useCallback(() => session.flushAll(), [session]);
  const updates = useUpdates(services.platform.updates, flushAll);

  // A deep link on the desktop chooses a route; the page router checks it again.
  useEffect(
    () =>
      services.platform.onDeepLink?.((hash) => {
        navigate(parseRoute(hash));
      }),
    [services],
  );

  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(
    () =>
      services.commands.register({
        id: 'app.search',
        group: 'navigation',
        label: () => t('search.open'),
        keywords: () => [t('keywords.search')],
        shortcut: 'Mod+KeyK',
        run: () => setPaletteOpen(true),
      }),
    [services, t],
  );

  // Settings stay reachable before a workspace exists (language and theme come first).
  if (!session.workspaceId && route.kind !== 'settings')
    return <FirstRun session={session} onCreated={() => rerender((n) => n + 1)} />;

  return (
    <Frame
      sidebar={
        <div className="cgw-sidebar-inner">
          <Sidebar
            session={session}
            activePageId={page?.id ?? null}
            onSearch={() => setPaletteOpen(true)}
            onError={onError}
          />
          <div className="cgw-sidebar-footer">
            <CgButton
              appearance="ghost"
              icon="settings"
              fullWidth
              onClick={() => navigate({ kind: 'settings' })}
            >
              {t('frame.settings')}
            </CgButton>
          </div>
        </div>
      }
      topBar={
        <>
          {page && !page.trashedAt && <Breadcrumbs session={session} page={page} />}
          <SaveStatus doc={route.kind === 'page' ? openDoc : null} />
          {page && !page.trashedAt && <PageMenu session={session} page={page} onError={onError} />}
          <UpdateButton updates={updates} />
        </>
      }
    >
      {notice && <Notice text={notice} onClose={() => setNotice(null)} />}
      {paletteOpen && <Palette session={session} onClose={() => setPaletteOpen(false)} />}
      {route.kind === 'settings' ? (
        <Settings onLanguage={setLanguage} session={session} updates={updates} />
      ) : route.kind === 'trash' ? (
        <TrashView session={session} onError={onError} />
      ) : page && !page.trashedAt ? (
        <Suspense fallback={<div className="cgw-page-loading">{t('app.loading')}</div>}>
          <PageView session={session} page={page} onEditor={(_, doc) => setOpenDoc(doc)} />
        </Suspense>
      ) : route.kind === 'page' ? (
        <div className="cgw-empty">
          <h1>{page?.trashedAt ? t('trash.pageInTrash') : t('frame.notFound')}</h1>
          {page?.trashedAt && <a href="#/trash">{t('trash.open')}</a>}
        </div>
      ) : (
        <div className="cgw-empty">
          <h1>{t('frame.emptyTitle')}</h1>
          <p>{t('frame.emptyBody')}</p>
        </div>
      )}
    </Frame>
  );
}

/**
 * Whether the open page is saved. Drawn without React: a React commit while the editor has focus
 * reads the editor's selection offsets, which walks the page's DOM (about 14 ms at 5,000 blocks),
 * and the state changes several times a second while typing.
 */
function SaveStatus({ doc }: { doc: PageDocument | null }) {
  const { t } = useTranslation();
  const label = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = label.current;
    if (!el || !doc) return;
    const show = () => {
      const state = doc.saveState;
      el.dataset.state = state;
      el.textContent =
        state === 'saved'
          ? t('page.saved')
          : state === 'saving'
            ? t('page.saving')
            : state === 'unsaved'
              ? t('page.unsaved')
              : state === 'error'
                ? t('page.saveError')
                : t('page.readOnly');
    };
    show();
    return doc.onSaveState(show);
  }, [doc, t]);
  if (!doc) return null;
  return (
    <span
      ref={label}
      className="cgw-save-status"
      role="status"
      aria-live="polite"
      data-testid="save-status"
    />
  );
}
