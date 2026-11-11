import {
  CgButton,
  CgDrawer,
  CgSplitter,
  type CgSplitterActions,
  type CgSplitterState,
} from '@cashgear/ui';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useShell, type CommandContext } from '../context';
import { navigate } from '../route';

const layoutKey = 'cgw-sidebar';
/** Below this width the sidebar is a drawer over the page (ARCHITECTURE.md, narrow screens). */
const NARROW = '(max-width: 767px)';

function subscribeNarrow(listener: () => void) {
  const list = matchMedia(NARROW);
  list.addEventListener('change', listener);
  return () => list.removeEventListener('change', listener);
}

const isNarrow = () => matchMedia(NARROW).matches;

function savedLayout(): CgSplitterState | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(layoutKey) ?? 'null') as CgSplitterState | null;
    return saved?.version === 1 ? saved : undefined;
  } catch {
    return undefined;
  }
}

export interface FrameProps {
  sidebar: ReactNode;
  topBar?: ReactNode;
  children: ReactNode;
}

/**
 * The app frame: a resizable, collapsible sidebar beside the page, with a top bar. Ctrl+\ shows
 * and hides the sidebar; its width and state are kept on this device. On a narrow screen the
 * sidebar is a drawer over the page instead, closed when a page opens or on Escape.
 */
export function Frame({ sidebar, topBar, children }: FrameProps) {
  const { t } = useTranslation();
  const services = useShell();
  const splitter = useRef<CgSplitterActions>(null);
  const [collapsed, setCollapsed] = useState(
    () => savedLayout()?.collapsedPaneKeys.includes('sidebar') ?? false,
  );
  const defaultState = useMemo(savedLayout, []);
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow);
  const [drawer, setDrawer] = useState(false);
  // Focus goes back to the drawer's button when the drawer closes, except when it closes because
  // a page opened: then focus belongs to that page.
  const [giveFocusBack, setGiveFocusBack] = useState(true);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  // Track U (PROGRESS.md): CgSplitter names its separator with an English template ("Resize A and
  // B") that takes no translation. Until it does, the separator gets its name from the catalogue
  // after each render.
  useLayoutEffect(() => {
    frameRef.current
      ?.querySelector('.cgw-splitter [role="separator"]')
      ?.setAttribute('aria-label', t('frame.resize'));
  });

  const toggleSidebar = useCallback(() => {
    if (isNarrow()) {
      setGiveFocusBack(true);
      setDrawer((open) => !open);
    } else splitter.current?.togglePane('sidebar');
  }, []);

  // The drawer closes when a page opens, and when the screen grows wide again.
  useEffect(() => {
    if (!narrow) {
      setDrawer(false);
      return;
    }
    const close = () => {
      setGiveFocusBack(false);
      setDrawer(false);
    };
    window.addEventListener('hashchange', close);
    return () => window.removeEventListener('hashchange', close);
  }, [narrow]);

  const context = useMemo<CommandContext>(
    () => ({ services, toggleSidebar }),
    [services, toggleSidebar],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      services.commands.handleKey(event, context);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [services, context]);

  useEffect(
    () =>
      services.commands.register(
        {
          id: 'app.toggleSidebar',
          group: 'app',
          label: () => t('commands.toggleSidebar'),
          keywords: () => [t('keywords.sidebar')],
          shortcut: 'Mod+Backslash',
          run: (ctx) => ctx.toggleSidebar(),
        },
        {
          id: 'app.openSettings',
          group: 'app',
          label: () => t('commands.openSettings'),
          keywords: () => [t('keywords.settings')],
          shortcut: 'Mod+Comma',
          run: () => navigate({ kind: 'settings' }),
        },
      ),
    [services, t],
  );

  const toggleButton = (open: boolean) => (
    <CgButton
      ref={toggleRef}
      appearance="ghost"
      icon="sidebar"
      className="cgw-icon-button"
      aria-label={t(open ? 'frame.collapseSidebar' : 'frame.expandSidebar')}
      aria-expanded={open}
      aria-controls={narrow ? 'cgw-drawer' : undefined}
      onClick={toggleSidebar}
    >
      <span className="cgw-visually-hidden">
        {t(open ? 'frame.collapseSidebar' : 'frame.expandSidebar')}
      </span>
    </CgButton>
  );

  // CgDrawer, over the page: it shades the page, makes it inert, keeps focus in the drawer, and
  // closes on Escape or a tap outside, giving focus back to the button.
  if (narrow) {
    return (
      <CgDrawer
        className="cgw-frame"
        data-layout="narrow"
        data-sidebar={drawer ? 'open' : 'collapsed'}
        aria-label={t('frame.sidebar')}
        open={drawer}
        onOpenChange={(open) => setDrawer(open)}
        mode="overlay"
        position="start"
        openSize="20rem"
        responsiveOverlay={false}
        restoreFocus={giveFocusBack}
        panelId="cgw-drawer"
        panelClassName="cgw-drawer"
        renderDrawer={() => <div className="cgw-sidebar">{sidebar}</div>}
        renderApplicationContent={() => (
          <div className="cgw-main">
            <header className="cgw-topbar">
              {toggleButton(drawer)}
              <div className="cgw-topbar-content">{topBar}</div>
            </header>
            {/* CgDrawer draws the main landmark around this. */}
            <div className="cgw-page-area" role="region" aria-label={t('frame.main')}>
              {children}
            </div>
          </div>
        )}
      />
    );
  }

  return (
    <div ref={frameRef} className="cgw-frame" data-sidebar={collapsed ? 'collapsed' : 'open'}>
      <CgSplitter
        className="cgw-splitter"
        aria-label={t('frame.layout')}
        actionsRef={splitter}
        defaultState={defaultState}
        onStateChange={(state) => {
          setCollapsed(state.collapsedPaneKeys.includes('sidebar'));
          try {
            localStorage.setItem(layoutKey, JSON.stringify(state));
          } catch {
            // The layout then lasts until the page closes.
          }
        }}
        panes={[
          {
            key: 'sidebar',
            className: 'cgw-pane',
            size: '260px',
            minimumSize: '200px',
            maximumSize: '480px',
            collapsible: true,
            ariaLabel: t('frame.sidebar'),
            renderContent: () => (
              <nav className="cgw-sidebar" aria-label={t('frame.sidebar')}>
                {sidebar}
              </nav>
            ),
          },
          {
            key: 'main',
            className: 'cgw-pane',
            ariaLabel: t('frame.main'),
            renderContent: () => (
              <div className="cgw-main">
                <header className="cgw-topbar">
                  {toggleButton(!collapsed)}
                  <div className="cgw-topbar-content">{topBar}</div>
                </header>
                <main className="cgw-page-area" aria-label={t('frame.main')}>
                  {children}
                </main>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
