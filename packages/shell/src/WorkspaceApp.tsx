import { CgButton } from '@cashgear/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { CommandRegistry } from './commands';
import { ShellContext, useShell, type CommandContext, type ShellServices } from './context';
import { Frame } from './frame/Frame';
import { Settings } from './frame/Settings';
import { applyLanguage, createI18n, type Language } from './i18n';
import type { WorkspacePlatform } from './platform';
import { navigate, parseRoute, useHash } from './route';
import { ThemeController } from './theme';

export interface WorkspaceAppProps {
  platform: WorkspacePlatform;
}

export function WorkspaceApp({ platform }: WorkspaceAppProps) {
  const [i18n] = useState(() => createI18n());
  const services = useMemo<ShellServices>(
    () => ({
      platform,
      theme: new ThemeController(platform),
      commands: new CommandRegistry<CommandContext>(),
    }),
    [platform],
  );
  useEffect(() => () => services.theme.dispose(), [services]);

  return (
    <I18nextProvider i18n={i18n}>
      <ShellContext.Provider value={services}>
        <Workspace />
      </ShellContext.Provider>
    </I18nextProvider>
  );
}

function Workspace() {
  const { t, i18n } = useTranslation();
  const services = useShell();
  const route = parseRoute(useHash());

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

  return (
    <Frame
      sidebar={
        <div className="cgw-sidebar-inner">
          <div className="cgw-sidebar-header">{t('app.title')}</div>
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
    >
      {route.kind === 'settings' ? (
        <Settings onLanguage={setLanguage} />
      ) : (
        <div className="cgw-empty">
          <h1>{t('frame.emptyTitle')}</h1>
          <p>{t('frame.emptyBody')}</p>
        </div>
      )}
    </Frame>
  );
}
