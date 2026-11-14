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
import { UpdateButton, UpdateCheck, useUpdates } from './frame/Updates';
import { applyLanguage, createI18n, type Language } from './i18n';
import { hasCloud, type WorkspacePlatform } from './platform';
import { navigate, parseRoute, routeHash, useHash } from './route';
import { WorkspaceSession, isRowRecord, type AnyPage } from './session';
import { Sidebar, useMirror } from './sidebar/Sidebar';
import { Breadcrumbs } from './page/PageHeader';
import { PageMenu, openHistory, pageEvents } from './page/PageMenu';
import { useAccount } from './cloud/CloudUi';
import { Notice, type NoticeAction } from './Notice';
import { RECOVERY_CODES, noticeTarget, noticeText, targetLabel } from './notices';
import { RecoveredView } from './RecoveredView';
import { TrashView, TRASH_RETENTION_DAYS } from './TrashView';
// The palette loads with the frame: keys typed straight after Ctrl+K must reach its field.
import { Palette } from './search/Palette';
import { ThemeController } from './theme';
import { normaliseText, type Id, type RowRecord } from '@cgw/workspace';
import type { PageDocument } from '@cgw/doc';
import { Cloud, type CloudNotice } from './cloud/cloud';
import {
  AccountButton,
  CloudContext,
  InviteView,
  SyncStatusLabel,
  UploadBanner,
} from './cloud/CloudUi';
import { DatabaseHostContext } from './database/context';
import { DatabaseDialogs, requestCsvImport, requestNewDatabase } from './database/dialogs';
import { ShellDatabaseHost } from './database/host';
import { assetsOf } from './page/editorHost';
import { workbookSync } from './sheet/launch';
import { WorkbookDialogs } from './sheet/WorkbookDialogs';
import { useErpServices } from './erp/host';
import { Collab, collabDeps } from './collab/collab';
import { CollabContext, collaborates, usePagePresence, usePeople } from './collab/context';
import { PresenceBar } from './collab/Avatars';
import { installErpLinkCapture } from './erp/linkTicket';
import { ErpLinkRoute } from './erp/LinkRoute';
import { isErpDeepLink } from '@cgw/erp';

// The editor, Tiptap and Yjs load in their own chunk, after the frame has painted from the mirror
// (ARCHITECTURE.md, Performance: Startup).
const loadPageView = () => import('./page/PageView');
const PageView = lazy(() => loadPageView().then((m) => ({ default: m.PageView })));
const ShareDialog = lazy(() =>
  import('./cloud/ShareDialog').then((m) => ({ default: m.ShareDialog })),
);
const SharedView = lazy(() =>
  import('./cloud/SharedView').then((m) => ({ default: m.SharedView })),
);
// The workspace's workbooks (Phase 5), loaded when the list opens.
const WorkbooksView = lazy(() =>
  import('./sheet/WorkbooksView').then((m) => ({ default: m.WorkbooksView })),
);
// The inbox (Phase 6), loaded when it opens.
const InboxView = lazy(() => import('./collab/InboxView').then((m) => ({ default: m.InboxView })));
// A database's own page: the database views' chunk, loaded when one opens.
const DatabasePage = lazy(() =>
  import('./database/DatabasePage').then((m) => ({ default: m.DatabasePage })),
);

export interface WorkspaceAppProps {
  platform: WorkspacePlatform;
}

export function WorkspaceApp({ platform }: WorkspaceAppProps) {
  const [i18n] = useState(() => createI18n());
  // Cash Gear ERP's link ticket leaves the address before any route is read (erp/linkTicket.ts).
  useState(installErpLinkCapture);
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
  const [cloud, setCloud] = useState<Cloud | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  useEffect(() => () => services.theme.dispose(), [services]);
  useEffect(() => {
    let live = true;
    let opened: WorkspaceSession | null = null;
    // The editor's chunk loads while the store opens, not after: the last page opens at start.
    void loadPageView().catch(() => undefined);
    let connected: Cloud | null = null;
    platform
      .openStore()
      .then((store) => WorkspaceSession.start(store))
      .then(
        (started) => {
          opened = started;
          if (!live) return void started.close();
          setSession(started);
          // The sync engine needs the document layer's codec, which loads with the editor.
          if (!hasCloud(platform)) return;
          void import('@cgw/doc').then(({ docCodec }) => {
            if (!live) return;
            connected = new Cloud(platform, started, docCodec, {
              // In the language the app is in when the page is made.
              recoveredTitle: (title) =>
                i18n.t('recovered.pageTitle', { title: title || i18n.t('page.untitled') }),
            });
            setCloud(connected);
            void connected.start();
          });
        },
        (error: unknown) => live && setFailed(error),
      );
    return () => {
      live = false;
      connected?.dispose();
      void opened?.close();
    };
  }, [platform, i18n]);

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
        <CloudContext.Provider value={cloud}>
          {session ? (
            <Workspace session={session} cloud={cloud} />
          ) : (
            <Starting failed={failed} platform={platform} />
          )}
        </CloudContext.Provider>
      </ShellContext.Provider>
    </I18nextProvider>
  );
}

/** The stores refuse a store a newer build wrote (and change nothing in it). */
const newerStore = (error: unknown) =>
  error instanceof Error && /written by a newer version/.test(error.message);

function Starting({ failed, platform }: { failed: unknown; platform: WorkspacePlatform }) {
  const { t } = useTranslation();
  if (newerStore(failed)) return <StoreTooNew platform={platform} />;
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

/**
 * The row a route names (rows are not in the mirror's pages): from the mirror, else looked for in
 * the store (its database's rows are read then). Undefined while it is looked for, null if this
 * device does not have it.
 */
function useRowRoute(session: WorkspaceSession, rowId: Id | null): RowRecord | null | undefined {
  useMirror(session);
  const [missing, setMissing] = useState<Id | null>(null);
  const known = rowId ? session.mirror.rowRecords.get(rowId) : undefined;
  const found = !!known;
  useEffect(() => {
    if (!rowId || found) return;
    let live = true;
    void session.findRow(rowId).then(
      (row) => live && !row && setMissing(rowId),
      () => live && setMissing(rowId),
    );
    return () => {
      live = false;
    };
  }, [session, rowId, found]);
  if (!rowId) return null;
  if (known) return known;
  return missing === rowId ? null : undefined;
}

function Workspace({ session, cloud }: { session: WorkspaceSession; cloud: Cloud | null }) {
  const { t, i18n } = useTranslation();
  const services = useShell();
  const route = parseRoute(useHash());
  const [, rerender] = useState(0);
  const [openDoc, setOpenDoc] = useState<PageDocument | null>(null);
  useMirror(session);
  useEffect(() => session.onSwitch(() => rerender((n) => n + 1)), [session]);

  // The database views' host over this session: one for the session, told when the server's
  // connection comes; the refusals it meets are shown as notices.
  const reportError = useRef<(error: unknown) => void>(() => undefined);
  const databases = useMemo(
    () =>
      new ShellDatabaseHost({
        session,
        assets: assetsOf(session, (name, bytes, type) =>
          services.platform.saveFile(name, bytes, type),
        ),
        openExternal: (url) => void services.platform.openExternal(url),
        saveFile: (name, bytes, type) => services.platform.saveFile(name, bytes, type),
        onError: (error) => reportError.current(error),
      }),
    [session, services],
  );
  useEffect(() => () => databases.dispose(), [databases]);
  // Collaboration (Phase 6): people, presence, comments and the inbox, over the cloud.
  // Made in an effect, so a render that React throws away leaves nothing listening.
  const [collab, setCollab] = useState<Collab | null>(null);
  useEffect(() => {
    if (!cloud) return setCollab(null);
    const made = new Collab(collabDeps(cloud, session, () => i18n.t('presence.someone')));
    setCollab(made);
    return () => {
      setCollab(null);
      made.dispose();
    };
  }, [cloud, session, i18n]);
  useEffect(() => databases.connect(cloud ? cloud.databaseSync() : null), [databases, cloud]);
  // "Export to a workbook" in the database views (Phase 5), over the same connection.
  useEffect(
    () => databases.connectWorkbooks(cloud ? workbookSync(cloud, services.platform) : null),
    [databases, cloud, services],
  );

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

  const routed = route.kind === 'page' ? route.pageId : null;
  const page = routed ? session.mirror.pages.get(routed) : undefined;
  // A row opens as a page with its properties above its body (contract section 7).
  const row = useRowRoute(session, page ? null : routed);
  const shown: AnyPage | undefined = page ?? row ?? undefined;
  const holder = isRowRecord(shown) ? session.mirror.pages.get(shown.databaseId) : undefined;
  const trashed = !!shown?.trashedAt || !!holder?.trashedAt;
  const onScreen = shown && !trashed ? shown : undefined;

  const visiting = page && !page.trashedAt ? page.id : null;
  useEffect(() => {
    if (visiting) void session.recordVisit(visiting).catch(() => undefined);
  }, [session, visiting]);

  const [notice, setNotice] = useState<{ text: string; action?: NoticeAction } | null>(null);
  const closeNotice = useCallback(() => setNotice(null), []);
  const account = useAccount(cloud);
  const [sharing, setSharing] = useState<string | null>(null);
  useEffect(() => {
    const open = (event: Event) => setSharing((event as CustomEvent<string>).detail);
    pageEvents.addEventListener('share', open);
    return () => pageEvents.removeEventListener('share', open);
  }, []);
  // What the sync engine or an open document has to say, in the interface language: what
  // happened, and a link to where the work is (the recovered page, the trash, the history).
  useEffect(() => {
    if (!cloud) return;
    let live = true;
    const show = async (n: CloudNotice) => {
      if (n.code === 'cloud.uploaded') return setNotice({ text: t('cloud.uploaded') });
      // What was set aside becomes a recovered page first, so the notice can lead to it.
      if (RECOVERY_CODES.has(n.code)) await cloud.recovery.settled();
      if (!live) return;
      const latest = n.pageId ? cloud.recovery.latestFor(n.pageId) : undefined;
      // The entry this notice speaks of: set aside for this reason, a moment ago.
      const item =
        latest && latest.reason === n.code && Date.now() - Date.parse(latest.at) < 600_000
          ? latest
          : undefined;
      const setAside = n.pageId
        ? !!item
        : cloud.recovery.items.some(
            (i) => i.workspaceId === n.workspaceId && i.status !== 'dismissed',
          );
      const info = { ...n, setAside };
      const title =
        (n.pageId && session.mirror.pages.get(n.pageId)?.title) ||
        latest?.title ||
        t('page.untitled');
      const found = noticeTarget(info, item?.recoveredPageId);
      // Nothing was set aside (a workspace lost with nothing unsent): no list to lead to.
      const target = found?.kind === 'recovered' && !setAside ? null : found;
      const action: NoticeAction | undefined = !target
        ? undefined
        : target.kind === 'recovered'
          ? {
              label: t(targetLabel(target) as 'notices.openPage'),
              href: routeHash(
                target.pageId ? { kind: 'page', pageId: target.pageId } : { kind: 'recovered' },
              ),
              onSelect: () => {
                const page = target.pageId ? session.mirror.pages.get(target.pageId) : undefined;
                if (page && page.workspaceId !== session.workspaceId)
                  session.switchTo(page.workspaceId);
              },
            }
          : target.kind === 'trash'
            ? {
                label: t(targetLabel(target) as 'notices.openPage'),
                href: routeHash({ kind: 'trash' }),
              }
            : target.kind === 'history'
              ? {
                  label: t(targetLabel(target) as 'notices.openPage'),
                  onSelect: () => {
                    navigate({ kind: 'page', pageId: target.pageId });
                    openHistory(target.pageId);
                  },
                }
              : {
                  label: t(targetLabel(target) as 'notices.openPage'),
                  href: routeHash({
                    kind: 'page',
                    pageId: target.pageId,
                    ...(target.kind === 'block' ? { blockId: target.blockId } : {}),
                  }),
                };
      // One key at a time is what the typed `t` takes; every key here takes `title` or nothing.
      setNotice({ text: t(noticeText(info) as 'notices.pageGone', { title }), action });
    };
    const off = cloud.onNotice((n) => void show(n));
    return () => {
      live = false;
      off();
    };
  }, [cloud, session, t]);
  const onError = useCallback(
    (error: unknown) => {
      const code = (error as { code?: string })?.code;
      console.warn('The change was refused:', error);
      setNotice({
        text: t(
          code === 'tree.cycle'
            ? 'errors.cycle'
            : code === 'version.conflict'
              ? 'errors.conflict'
              : 'errors.generic',
        ),
      });
    },
    [t],
  );
  reportError.current = onError;

  // "New database" in the palette: in the page on screen, else at the end of the first section.
  const here =
    onScreen && onScreen.kind === 'page' && session.canEdit(onScreen.id) ? onScreen : null;
  useEffect(() => {
    const placeHere = () => {
      const workspaceId = session.workspaceId;
      const sectionId =
        here?.sectionId ?? (workspaceId && session.mirror.sectionsOf(workspaceId)[0]?.id);
      if (!workspaceId || !sectionId) return null;
      const parentPageId = here?.id ?? null;
      return {
        workspaceId,
        sectionId,
        parentPageId,
        orderKey: session.keyFor(sectionId, parentPageId),
      };
    };
    const opened = (made: { databaseId: string } | null) =>
      made && navigate({ kind: 'page', pageId: made.databaseId });
    return services.commands.register(
      {
        id: 'app.newDatabase',
        group: 'navigation',
        label: () => t('databases.newDatabase'),
        keywords: () => [t('keywords.newDatabase')],
        run: () => {
          const place = placeHere();
          if (place) void requestNewDatabase(place).then(opened);
        },
      },
      {
        id: 'app.importCsv',
        group: 'navigation',
        label: () => t('databases.importCsv'),
        keywords: () => [t('keywords.importCsv')],
        run: () => {
          const place = placeHere();
          if (place) void requestCsvImport(place).then(opened);
        },
      },
    );
  }, [services, session, t, here]);

  // Pages in the trash longer than the retention go for good when the workspace opens.
  useEffect(() => {
    const workspaceId = session.workspaceId;
    if (!workspaceId) return;
    const before = new Date(Date.now() - TRASH_RETENTION_DAYS * 86_400_000).toISOString();
    // The mirror is read again (not merged: what went is gone from it), and the trash's count.
    void session.store
      .purgeTrash(workspaceId, before)
      .then(async (gone) => {
        if (gone.length) await session.reloadMirror();
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
      setNotice({ text: t('exchange.browserMayClear') });
    });
  }, [services, session, session.workspaceId, t]);

  const flushAll = useCallback(() => session.flushAll(), [session]);
  const updates = useUpdates(services.platform.updates, flushAll);

  // The tab's Cash Gear ERP services (erp/services.ts), told of the cloud as it comes.
  const erp = useErpServices(session);
  const erpRef = useRef(erp);
  erpRef.current = erp;

  // A deep link on the desktop chooses a route; the page router checks it again.
  useEffect(
    () =>
      services.platform.onDeepLink?.((hash) => {
        // Cash Gear ERP's return goes to the connect waiting for it, before any route: it is
        // never navigated to, so it never reaches the address or the history.
        if (erpRef.current?.takeDeepLink(hash) || isErpDeepLink(hash)) return;
        navigate(parseRoute(hash));
      }),
    [services],
  );

  useEffect(
    () =>
      collab
        ? services.commands.register({
            id: 'app.inbox',
            group: 'navigation',
            label: () => t('inbox.open'),
            keywords: () => [t('keywords.inbox')],
            when: () => !!collab.deps.self(),
            run: () => navigate({ kind: 'inbox' }),
          })
        : undefined,
    [services, collab, t],
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

  // A page shared by link opens on its own, signed in or not.
  if (route.kind === 'shared' && services.platform.apiBase)
    return (
      <Suspense fallback={<div className="cgw-page-loading">{t('app.loading')}</div>}>
        <SharedView
          apiBase={services.platform.apiBase}
          token={route.token}
          pageId={route.pageId ?? null}
        />
      </Suspense>
    );

  // Settings and invitations stay reachable before a workspace exists.
  if (
    !session.workspaceId &&
    route.kind !== 'settings' &&
    route.kind !== 'invite' &&
    route.kind !== 'erpLink'
  )
    return (
      <>
        <FirstRun session={session} onCreated={() => rerender((n) => n + 1)} />
        {cloud && (
          <div className="cgw-firstrun-account">
            <AccountButton cloud={cloud} />
          </div>
        )}
      </>
    );

  return (
    <CollabContext.Provider value={collab}>
      <DatabaseHostContext.Provider value={databases}>
        <Frame
          sidebar={
            <div className="cgw-sidebar-inner">
              <Sidebar
                session={session}
                activePageId={isRowRecord(shown) ? shown.databaseId : (page?.id ?? null)}
                onSearch={() => setPaletteOpen(true)}
                onError={onError}
              />
              {cloud && <UploadBanner cloud={cloud} session={session} />}
              <div className="cgw-sidebar-footer">
                {cloud && <AccountButton cloud={cloud} />}
                {cloud && (
                  <CgButton
                    appearance="ghost"
                    fullWidth
                    data-testid="workbooks-link"
                    onClick={() => navigate({ kind: 'workbooks' })}
                  >
                    {t('sheets.screenTitle')}
                  </CgButton>
                )}
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
              {onScreen && <Breadcrumbs session={session} page={onScreen} />}
              <SaveStatus
                doc={route.kind === 'page' && onScreen?.kind !== 'database' ? openDoc : null}
              />
              {onScreen && onScreen.kind !== 'database' && account && (
                <TopBarPresence collab={collab} session={session} page={onScreen} />
              )}
              {cloud && <SyncStatusLabel cloud={cloud} session={session} />}
              {onScreen && (
                <PageMenu
                  session={session}
                  page={onScreen}
                  onError={onError}
                  canShare={!!account && session.current?.localOnly === false}
                />
              )}
              <UpdateButton updates={updates} />
            </>
          }
        >
          {notice && <Notice text={notice.text} action={notice.action} onClose={closeNotice} />}
          {sharing && cloud && session.mirror.pages.get(sharing) && (
            <Suspense fallback={null}>
              <ShareDialog
                cloud={cloud}
                page={session.mirror.pages.get(sharing)!}
                onClose={() => setSharing(null)}
              />
            </Suspense>
          )}
          {paletteOpen && (
            <Palette
              session={session}
              databases={databases}
              onClose={() => setPaletteOpen(false)}
            />
          )}
          <DatabaseDialogs session={session} host={databases} />
          <WorkbookDialogs session={session} cloud={cloud} databases={databases} />
          {route.kind === 'invite' && cloud ? (
            <InviteView cloud={cloud} session={session} token={route.token} />
          ) : route.kind === 'erpLink' ? (
            <ErpLinkRoute session={session} services={erp} />
          ) : route.kind === 'settings' ? (
            <Settings onLanguage={setLanguage} session={session} updates={updates} />
          ) : route.kind === 'workbooks' ? (
            <Suspense fallback={<div className="cgw-page-loading">{t('app.loading')}</div>}>
              <WorkbooksView session={session} cloud={cloud} />
            </Suspense>
          ) : route.kind === 'inbox' && collab && account ? (
            <Suspense fallback={<div className="cgw-page-loading">{t('app.loading')}</div>}>
              <InboxView collab={collab} session={session} />
            </Suspense>
          ) : route.kind === 'trash' ? (
            <TrashView session={session} onError={onError} />
          ) : route.kind === 'recovered' && cloud ? (
            <RecoveredView cloud={cloud} session={session} />
          ) : onScreen ? (
            <Suspense fallback={<div className="cgw-page-loading">{t('app.loading')}</div>}>
              {onScreen.kind === 'database' ? (
                <DatabasePage key={onScreen.id} session={session} page={onScreen} />
              ) : (
                <PageView
                  session={session}
                  page={onScreen}
                  onEditor={(_, doc) => setOpenDoc(doc)}
                />
              )}
            </Suspense>
          ) : route.kind === 'page' && !page && row === undefined ? (
            <div className="cgw-page-loading">{t('app.loading')}</div>
          ) : route.kind === 'page' ? (
            <div className="cgw-empty">
              <h1>{trashed ? t('trash.pageInTrash') : t('frame.notFound')}</h1>
              {trashed && <a href="#/trash">{t('trash.open')}</a>}
            </div>
          ) : (
            <div className="cgw-empty">
              <h1>{t('frame.emptyTitle')}</h1>
              <p>{t('frame.emptyBody')}</p>
            </div>
          )}
        </Frame>
      </DatabaseHostContext.Provider>
    </CollabContext.Provider>
  );
}

/** The others on the page on screen, in the top bar (Phase 6). */
function TopBarPresence({
  collab,
  session,
  page,
}: {
  collab: Collab | null;
  session: WorkspaceSession;
  page: AnyPage;
}) {
  const shared = collaborates(collab, session, page.workspaceId);
  const store = usePagePresence(shared ? collab : null, page.id, page.workspaceId);
  const people = usePeople(shared ? collab : null, page.workspaceId);
  return <PresenceBar store={store} people={people} />;
}

/**
 * The local store was written by a newer version of the app (the person went back to an older
 * build): the whole window says so and asks for the update. The store is neither opened nor
 * wiped, since its outbox may hold work not sent yet (SYNC_DESIGN.md, Local schema migration).
 */
function StoreTooNew({ platform }: { platform: WorkspacePlatform }) {
  const { t } = useTranslation();
  const updates = useUpdates(platform.updates, async () => {});
  return (
    <main className="cgw-empty cgw-refusal" role="alert" aria-labelledby="cgw-refusal-title">
      <h1 id="cgw-refusal-title">{t('app.tooOldTitle')}</h1>
      <p>{t('app.tooOldBody')}</p>
      {updates.supported && <UpdateCheck updates={updates} />}
    </main>
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
