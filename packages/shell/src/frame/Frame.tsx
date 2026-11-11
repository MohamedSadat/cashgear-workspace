import { CgButton, CgSplitter, type CgSplitterActions, type CgSplitterState } from '@cashgear/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useShell, type CommandContext } from '../context';
import { navigate } from '../route';

const layoutKey = 'cgw-sidebar';

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
 * and hides the sidebar; its width and state are kept on this device.
 */
export function Frame({ sidebar, topBar, children }: FrameProps) {
  const { t } = useTranslation();
  const services = useShell();
  const splitter = useRef<CgSplitterActions>(null);
  const [collapsed, setCollapsed] = useState(
    () => savedLayout()?.collapsedPaneKeys.includes('sidebar') ?? false,
  );
  const defaultState = useMemo(savedLayout, []);

  const toggleSidebar = useCallback(() => {
    splitter.current?.togglePane('sidebar');
  }, []);

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

  return (
    <div className="cgw-frame" data-sidebar={collapsed ? 'collapsed' : 'open'}>
      <CgSplitter
        className="cgw-splitter"
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
            renderContent: () => (
              <div className="cgw-main">
                <header className="cgw-topbar">
                  <CgButton
                    appearance="ghost"
                    icon="sidebar"
                    className="cgw-icon-button"
                    aria-label={t(collapsed ? 'frame.expandSidebar' : 'frame.collapseSidebar')}
                    aria-expanded={!collapsed}
                    onClick={toggleSidebar}
                  >
                    <span className="cgw-visually-hidden">
                      {t(collapsed ? 'frame.expandSidebar' : 'frame.collapseSidebar')}
                    </span>
                  </CgButton>
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
