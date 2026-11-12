import { CgRadioGroup } from '@cashgear/ui';
import { useTranslation } from 'react-i18next';
import { useShell, useThemePreference } from '../context';
import { LANGUAGES, type Language } from '../i18n';
import type { ThemePreference } from '../theme';
import { DataPanel } from '../exchange/DataPanel';
import type { WorkspaceSession } from '../session';
import { UpdateCheck, type UpdatesState } from './Updates';
import { AccountSettings, MembersSettings, useCloud } from '../cloud/CloudUi';
import { OfflineSettings } from '../cloud/OfflineSettings';

export function Settings({
  onLanguage,
  session,
  updates,
}: {
  onLanguage: (language: Language) => void;
  session: WorkspaceSession;
  updates: UpdatesState;
}) {
  const { t, i18n } = useTranslation();
  const { theme, platform } = useShell();
  const preference = useThemePreference();
  const cloud = useCloud();
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
      {cloud && <AccountSettings cloud={cloud} />}
      {cloud && session.workspaceId && <MembersSettings cloud={cloud} session={session} />}
      {session.workspaceId && <OfflineSettings cloud={cloud} session={session} />}
      {session.workspaceId && <DataPanel session={session} />}
      <h2>{t('settings.about')}</h2>
      <p data-testid="host-info">
        {t(platform.kind === 'desktop' ? 'frame.platformDesktop' : 'frame.platformWeb')}{' '}
        {t('app.version', { version: updates.version ?? __CGW_VERSION__ })}
      </p>
      <UpdateCheck updates={updates} />
    </section>
  );
}
