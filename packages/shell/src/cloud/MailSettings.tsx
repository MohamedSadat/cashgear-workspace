// Settings → Email notifications (Phase 8, M8.5): the account's mail for mentions and replies
// still unread in the app: on (at most every 15 minutes), a daily summary, or off. Signed in only.
// Read when the section opens and written on each choice; the server decides, and a write that
// fails puts the last saved choice back and says so. Each mail also turns itself off in one click,
// without signing in (the server's unsubscribe link), and this shows what that left.
import { CgRadioGroup } from '@cashgear/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Cloud } from './cloud';
import { useAccount } from './CloudUi';

export type MailMode = 'on' | 'digest' | 'off';
const MODES: readonly MailMode[] = ['on', 'digest', 'off'];
const isMode = (value: unknown): value is MailMode => MODES.includes(value as MailMode);

/** What the section needs of the cloud (a fake in tests). */
export interface MailSettingsApi {
  notificationSettings(): Promise<{ email: string }>;
  setNotificationSettings(email: MailMode): Promise<{ email: string }>;
}

type State = 'loading' | 'ready' | 'saving' | 'saved' | 'failed' | 'loadFailed';

/** The section, for the signed-in account only. */
export function MailSettings({ cloud }: { cloud: Cloud }) {
  const account = useAccount(cloud);
  if (!account) return null;
  return <MailSettingsSection key={account.id} api={cloud} />;
}

export function MailSettingsSection({ api }: { api: MailSettingsApi }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<MailMode | null>(null);
  const [state, setState] = useState<State>('loading');
  const [reading, setReading] = useState(0);
  // What the server last said was saved, and which write is the newest: an older answer that
  // arrives late changes nothing.
  const saved = useRef<MailMode | null>(null);
  const writes = useRef(0);

  useEffect(() => {
    let live = true;
    setState('loading');
    api.notificationSettings().then(
      (answer) => {
        if (!live) return;
        const value = isMode(answer.email) ? answer.email : 'on';
        saved.current = value;
        setMode(value);
        setState('ready');
      },
      () => live && setState('loadFailed'),
    );
    return () => {
      live = false;
    };
  }, [api, reading]);

  const choose = (next: MailMode) => {
    const write = ++writes.current;
    setMode(next);
    setState('saving');
    api.setNotificationSettings(next).then(
      (answer) => {
        if (write !== writes.current) return;
        const value = isMode(answer.email) ? answer.email : next;
        saved.current = value;
        setMode(value);
        setState('saved');
      },
      () => {
        if (write !== writes.current) return;
        setMode(saved.current);
        setState('failed');
      },
    );
  };

  const status =
    state === 'saving'
      ? t('mail.saving')
      : state === 'saved'
        ? t('mail.saved')
        : state === 'failed'
          ? t('mail.failed')
          : '';
  return (
    <section aria-labelledby="cgw-mail-title" data-testid="mail-settings">
      <h3 id="cgw-mail-title">{t('mail.title')}</h3>
      <p className="cgw-muted" id="cgw-mail-intro">
        {t('mail.intro')}
      </p>
      {state === 'loadFailed' ? (
        <p role="alert">
          {t('mail.loadFailed')}{' '}
          <button type="button" className="cgw-button" onClick={() => setReading((n) => n + 1)}>
            {t('mail.retry')}
          </button>
        </p>
      ) : (
        mode && (
          <CgRadioGroup<MailMode>
            legend={t('mail.legend')}
            value={mode}
            onValueChange={choose}
            aria-describedby="cgw-mail-intro"
            data-testid="mail-mode"
            options={[
              { value: 'on', label: t('mail.on') },
              { value: 'digest', label: t('mail.digest') },
              { value: 'off', label: t('mail.off') },
            ]}
          />
        )
      )}
      <p className="cgw-muted" role="status" data-testid="mail-settings-status">
        {status}
      </p>
    </section>
  );
}
