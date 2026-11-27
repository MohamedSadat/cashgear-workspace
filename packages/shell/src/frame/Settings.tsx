import { CgRadioGroup, CgSwitch, CgTabs, type CgTabDescriptor } from '@cashgear/ui';
import { lazy, Suspense, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useShell, useThemePreference } from '../context';
import { LANGUAGES, type Language } from '../i18n';
import { useSection } from '../i18n/sections';
import type { ThemePreference } from '../theme';
import { DataPanel } from '../exchange/DataPanel';
import type { WorkspaceSession } from '../session';
import { navigate, type SettingsTab } from '../route';
import { recentHidden, setRecentShown } from './recentSwitch';
import { UpdateCheck, type UpdatesState } from './Updates';
import { settingsTabsWords } from './settingsWords';
import { AccountSettings, MembersSettings, useAccount, useCloud } from '../cloud/CloudUi';
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
/** Phase 15: Settings → Automations, loaded the same way. */
const AutomationsSettings = lazy(() =>
  import('../automations/AutomationsSettings').then((m) => ({ default: m.AutomationsSettings })),
);
/** Phase 10: the plugins section, loaded the same way. */
const PluginsSettings = lazy(() =>
  import('../plugins/PluginsSettings').then((m) => ({ default: m.PluginsSettings })),
);

/** The frame's narrow layout (a phone, Frame.tsx's NARROW): the tab list across the top. */
const NARROW = '(max-width: 767px)';
const narrowNow = () => matchMedia(NARROW).matches;
function onNarrow(listener: () => void) {
  const list = matchMedia(NARROW);
  list.addEventListener('change', listener);
  return () => list.removeEventListener('change', listener);
}

/**
 * Settings in tabs (after 0.19.0, DECISIONS.md 2026-11-27), each at its own address
 * (`#/settings/{tab}`). A tab is listed only when it has something to show: those of a synced
 * workspace only while signed in. An address naming one not listed shows General, and the tab it
 * names once it is (the account read at start, say).
 */
export function Settings({
  onLanguage,
  session,
  updates,
  tab: asked = 'general',
}: {
  onLanguage: (language: Language) => void;
  session: WorkspaceSession;
  updates: UpdatesState;
  tab?: SettingsTab;
}) {
  useSection(settingsTabsWords);
  const { t, i18n } = useTranslation();
  const { theme, platform } = useShell();
  const preference = useThemePreference();
  const [recentShown, showRecent] = useState(() => !recentHidden());
  const narrow = useSyncExternalStore(onNarrow, narrowNow);
  const cloud = useCloud();
  const account = useAccount(cloud);
  const workspace = session.current;
  const signedIn = !!cloud && !!account;
  const inWorkspace = signedIn && !!session.workspaceId;
  const synced = inWorkspace && !!workspace && !workspace.localOnly;

  const panels: Record<SettingsTab, ReactNode | null> = {
    general: (
      <>
        <h2>{t('settingsTabs.appearance')}</h2>
        <CgRadioGroup<ThemePreference>
          legend={t('settingsTabs.theme')}
          orientation="horizontal"
          value={preference}
          onValueChange={(value) => theme.setPreference(value)}
          options={[
            { value: 'system', label: t('settingsTabs.themeSystem') },
            { value: 'light', label: t('settingsTabs.themeLight') },
            { value: 'dark', label: t('settingsTabs.themeDark') },
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
        <CgSwitch
          label={t('settingsTabs.showRecent')}
          checked={recentShown}
          onCheckedChange={(checked) => {
            setRecentShown(checked);
            showRecent(checked);
          }}
          data-testid="show-recent"
        />
        <h2>{t('settingsTabs.about')}</h2>
        <p data-testid="host-info">
          {t(
            platform.kind === 'desktop'
              ? 'settingsTabs.platformDesktop'
              : 'settingsTabs.platformWeb',
          )}{' '}
          {t('settingsTabs.version', { version: updates.version ?? __CGW_VERSION__ })}
        </p>
        <UpdateCheck updates={updates} />
      </>
    ),
    // Signed out, the account's tab offers the sign-in.
    account: cloud ? (
      <>
        <AccountSettings
          cloud={cloud}
          passwordSection={<PasswordSection cloud={cloud} />}
          passkeys={<PasskeysSection cloud={cloud} />}
          signOut={<SignOutSection cloud={cloud} />}
        />
        <MailSettings cloud={cloud} />
      </>
    ) : null,
    members:
      cloud && inWorkspace ? (
        <>
          <MembersSettings
            cloud={cloud}
            session={session}
            groups={(members) => (
              <GroupsSection cloud={cloud} session={session} members={members} />
            )}
          />
          <SsoSection cloud={cloud} session={session} />
        </>
      ) : null,
    ai: inWorkspace ? <AiSettingsSection session={session} /> : null,
    publishing:
      cloud && synced ? (
        <Suspense fallback={null}>
          <PublishingSettings cloud={cloud} session={session} />
        </Suspense>
      ) : null,
    integrations:
      cloud && synced ? (
        <>
          <ErpSettingsSection session={session} />
          <Suspense fallback={null}>
            <PluginsSettings cloud={cloud} session={session} />
          </Suspense>
          <Suspense fallback={null}>
            <AutomationsSettings cloud={cloud} session={session} />
          </Suspense>
          <section aria-labelledby="cgw-workbooks-settings-title">
            <h2 id="cgw-workbooks-settings-title">{t('sheets.screenTitle')}</h2>
            <p>
              <a href="#/workbooks" data-testid="settings-workbooks">
                {t('settingsTabs.workbooksLink')}
              </a>
            </p>
          </section>
        </>
      ) : null,
    data: (
      <>
        {session.workspaceId && <OfflineSettings cloud={cloud} session={session} />}
        {/* With no workspace shown (signed out, every one here synced), an export can still be
            brought back: the panel then offers its import alone. */}
        <DataPanel session={session} />
      </>
    ),
  };

  const shown = (Object.keys(panels) as SettingsTab[]).filter((key) => panels[key] !== null);
  const active: SettingsTab = shown.includes(asked) ? asked : 'general';
  const tabs: CgTabDescriptor[] = shown.map((key) => ({
    key,
    text: t(`settingsTabs.${key}`),
    content: key === active ? <div className="cgw-settings-panel">{panels[key]}</div> : null,
  }));

  return (
    <section className="cgw-settings" aria-labelledby="cgw-settings-title">
      <h1 id="cgw-settings-title">{t('settings.title')}</h1>
      <CgTabs
        className="cgw-settings-tabs"
        tabs={tabs}
        activeKey={active}
        onActiveKeyChange={(key) => {
          if (key && key !== active)
            navigate({
              kind: 'settings',
              tab: key === 'general' ? undefined : (key as SettingsTab),
            });
        }}
        // The library's tab lists are laid out by a grid, so "left" is the start side in
        // Arabic too.
        position={narrow ? 'top' : 'left'}
        scrollMode={narrow ? 'native' : 'none'}
        contentMode="active-only"
        ariaLabel={t('settingsTabs.label')}
        labels={{ previousTabs: t('settingsTabs.previous'), nextTabs: t('settingsTabs.next') }}
      />
    </section>
  );
}
