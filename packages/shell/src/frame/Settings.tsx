import { CgRadioGroup } from '@cashgear/ui';
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useShell, useThemePreference } from '../context';
import { LANGUAGES, type Language } from '../i18n';
import type { ThemePreference } from '../theme';
import { DataPanel } from '../exchange/DataPanel';
import type { WorkspaceSession } from '../session';
import { UpdateCheck, type UpdatesState } from './Updates';
import { AccountSettings, MembersSettings, useCloud } from '../cloud/CloudUi';
import { GroupsSection } from '../cloud/GroupsSettings';
import { PasskeysSection } from '../cloud/PasskeysSettings';
import { PasswordSection } from '../cloud/PasswordSettings';
import { SignOutSection } from '../cloud/SignOutSection';
import { SsoSection } from '../cloud/SsoSettings';
import { OfflineSettings } from '../cloud/OfflineSettings';
import { MailSettings } from '../cloud/MailSettings';
import { ErpSettingsSection } from '../erp/SettingsSection';
import { AiSettingsSection } from '../ai/AiSettings';

/** The publishing section, loaded with Settings' first look (not with the app). */
const PublishingSettings = lazy(() =>
  import('../cloud/PublishingSettings').then((m) => ({ default: m.PublishingSettings })),
);
/** Phase 10: the plugins section, loaded the same way. */
const PluginsSettings = lazy(() =>
  import('../plugins/PluginsSettings').then((m) => ({ default: m.PluginsSettings })),
);

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
      {cloud && (
        <AccountSettings
          cloud={cloud}
          passwordSection={<PasswordSection cloud={cloud} />}
          passkeys={<PasskeysSection cloud={cloud} />}
          signOut={<SignOutSection cloud={cloud} />}
        />
      )}
      {cloud && <MailSettings cloud={cloud} />}
      {cloud && session.workspaceId && (
        <MembersSettings
          cloud={cloud}
          session={session}
          groups={(members) => <GroupsSection cloud={cloud} session={session} members={members} />}
        />
      )}
      {cloud && session.workspaceId && <SsoSection cloud={cloud} session={session} />}
      {cloud && session.workspaceId && (
        <Suspense fallback={null}>
          <PublishingSettings cloud={cloud} session={session} />
        </Suspense>
      )}
      {session.workspaceId && <OfflineSettings cloud={cloud} session={session} />}
      {/* With no workspace shown (signed out, every one here synced), an export can still be
          brought back: the panel then offers its import alone. */}
      <DataPanel session={session} />
      {cloud && session.workspaceId && <ErpSettingsSection session={session} />}
      {cloud && session.workspaceId && <AiSettingsSection session={session} />}
      {cloud && session.workspaceId && (
        <Suspense fallback={null}>
          <PluginsSettings cloud={cloud} session={session} />
        </Suspense>
      )}
      {cloud && session.workspaceId && (
        <>
          <h2>{t('sheets.screenTitle')}</h2>
          <p>
            <a href="#/workbooks" data-testid="settings-workbooks">
              {t('sheets.settingsLink')}
            </a>
          </p>
        </>
      )}
      <h2>{t('settings.about')}</h2>
      <p data-testid="host-info">
        {t(platform.kind === 'desktop' ? 'frame.platformDesktop' : 'frame.platformWeb')}{' '}
        {t('app.version', { version: updates.version ?? __CGW_VERSION__ })}
      </p>
      <UpdateCheck updates={updates} />
    </section>
  );
}
