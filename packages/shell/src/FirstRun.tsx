import { CgButton, CgTextBox } from '@cashgear/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Language } from './i18n';
import { navigate } from './route';
import type { WorkspaceSession } from './session';

/** Shown when this device holds no workspace yet: name one and start. */
export function FirstRun({
  session,
  onCreated,
}: {
  session: WorkspaceSession;
  onCreated: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    // The frame is drawn once the workspace exists, before its first pages are all written: a
    // page the person opens meanwhile stays open ("Add a page" at once was sent back to "Getting
    // started" when the writes took longer, the web kill test on CI after Phase 8's strict writes).
    const before = location.hash;
    try {
      const { createFirstWorkspace } = await import('./gettingStarted');
      const first = await createFirstWorkspace(
        session,
        {
          workspace: name.trim() || t('workspace.defaultName'),
          shared: t('workspace.sectionShared'),
          private: t('workspace.sectionPrivate'),
        },
        i18n.language as Language,
      );
      onCreated();
      if (location.hash === before) navigate({ kind: 'page', pageId: first }, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="cgw-first-run" aria-labelledby="cgw-first-run-title">
      <h1 id="cgw-first-run-title">{t('workspace.welcome')}</h1>
      <p>{t('workspace.welcomeBody')}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label htmlFor="cgw-workspace-name">{t('workspace.nameLabel')}</label>
        <CgTextBox
          id="cgw-workspace-name"
          value={name}
          onValueChange={setName}
          placeholder={t('workspace.defaultName')}
          autoFocus
        />
        <CgButton type="submit" intent="primary" loading={busy}>
          {t('workspace.create')}
        </CgButton>
      </form>
      <p className="cgw-first-run-note">{t('page.onThisDevice')}</p>
    </main>
  );
}
