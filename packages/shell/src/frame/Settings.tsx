import { CgRadioGroup } from '@cashgear/ui';
import { useTranslation } from 'react-i18next';
import { useShell, useThemePreference } from '../context';
import { LANGUAGES, type Language } from '../i18n';
import type { ThemePreference } from '../theme';

export function Settings({ onLanguage }: { onLanguage: (language: Language) => void }) {
  const { t, i18n } = useTranslation();
  const { theme, platform } = useShell();
  const preference = useThemePreference();
  return (
    <section className="cgw-settings" aria-labelledby="cgw-settings-title">
      <h1 id="cgw-settings-title">{t('settings.title')}</h1>
      <h2>{t('settings.appearance')}</h2>
      <CgRadioGroup<ThemePreference>
        legend={t('theme.label')}
        orientation="horizontal"
        value={preference}
        onValueChange={(value) => theme.setPreference(value)}
        options={[
          { value: 'system', label: t('theme.system') },
          { value: 'light', label: t('theme.light') },
          { value: 'dark', label: t('theme.dark') },
        ]}
      />
      <CgRadioGroup<Language>
        legend={t('language.label')}
        orientation="horizontal"
        value={i18n.language as Language}
        onValueChange={onLanguage}
        options={LANGUAGES.map((language) => ({
          value: language,
          label: <span lang={language}>{t(`language.${language}`)}</span>,
        }))}
      />
      <h2>{t('settings.about')}</h2>
      <p data-testid="host-info">
        {t(platform.kind === 'desktop' ? 'frame.platformDesktop' : 'frame.platformWeb')}{' '}
        {t('app.version', { version: __CGW_VERSION__ })}
      </p>
    </section>
  );
}
