import { CgButton } from '@cashgear/ui';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { CommandRegistry } from './commands';
import { ShellContext, useShell, type CommandContext, type ShellServices } from './context';
import { FirstRun } from './FirstRun';
import { Frame } from './frame/Frame';
import { Settings } from './frame/Settings';
import { applyLanguage, createI18n, type Language } from './i18n';
import { useSaveState } from './page/usePageDoc';
import type { WorkspacePlatform } from './platform';
import { navigate, parseRoute, useHash } from './route';
import { WorkspaceSession } from './session';
import { Sidebar, useMirror } from './sidebar/Sidebar';
import { Breadcrumbs } from './page/PageHeader';
import { PageMenu } from './page/PageMenu';
import { Notice } from './Notice';
import { TrashView, TRASH_RETENTION_DAYS } from './TrashView';
import { ThemeController } from './theme';
import { normaliseText } from '@cgw/workspace';
import type { PageDocument } from '@cgw/doc';

// The editor, Tiptap and Yjs load in their own chunk, after the frame has painted from the mirror
// (ARCHITECTURE.md, Performance: Startup).
const PageView = lazy(() => import('./page/PageView').then((m) => ({ default: m.PageView })));
const Palette = lazy(() => import('./search/Palette').then((m) => ({ default: m.Palette })));

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
        </>
      }
    >
      {notice && <Notice text={notice} onClose={() => setNotice(null)} />}
      {paletteOpen && (
        <Suspense fallback={null}>
          <Palette session={session} onClose={() => setPaletteOpen(false)} />
        </Suspense>
      )}
      {route.kind === 'settings' ? (
        <Settings onLanguage={setLanguage} session={session} />
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

function SaveStatus({ doc }: { doc: PageDocument | null }) {
  const { t } = useTranslation();
  const state = useSaveState(doc);
  if (!state) return null;
  const label =
    state === 'saved'
      ? t('page.saved')
      : state === 'saving'
        ? t('page.saving')
        : state === 'unsaved'
          ? t('page.unsaved')
          : state === 'error'
            ? t('page.saveError')
            : t('page.readOnly');
  return (
    <span
      className="cgw-save-status"
      data-state={state}
      role="status"
      aria-live="polite"
      data-testid="save-status"
    >
      {label}
    </span>
  );
}
