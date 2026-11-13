import type { Id, PageRecord } from '@cgw/workspace';
import { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useCloud, useOfflineMarks, useRecoveredRevision } from '../cloud/CloudUi';
import { Dialog } from '../Dialog';
import { navigate, routeHash } from '../route';
import type { WorkspaceSession } from '../session';
import { pageGlyph } from '../database/make';
import { PageTree } from './PageTree';
import { PointMenu } from './RowMenu';

export function useMirror(session: WorkspaceSession): number {
  return useSyncExternalStore(
    (listener) => session.mirror.subscribe(listener),
    session.mirror.getRevision,
  );
}

/** How many rows of the workspace are in the trash on their own (counted by the session). */
export function useTrashedRowCount(session: WorkspaceSession, workspaceId: Id | null): number {
  return useSyncExternalStore(session.onTrashedRows, () =>
    workspaceId ? session.trashedRowCount(workspaceId) : 0,
  );
}

function PageLink({
  page,
  active,
  unavailable,
}: {
  page: PageRecord;
  active: boolean;
  /** Offline, and this device does not hold the page. */
  unavailable: boolean;
}) {
  const { t } = useTranslation();
  return (
    <a
      href={routeHash({ kind: 'page', pageId: page.id })}
      className={`cgw-side-link${active ? ' is-active' : ''}${unavailable ? ' is-unavailable' : ''}`}
      aria-current={active ? 'page' : undefined}
      title={unavailable ? t('offline.notAvailable') : undefined}
    >
      <span aria-hidden="true">{pageGlyph(page)}</span>
      <span className="cgw-tree-title" dir="auto">
        {page.title || t('page.untitled')}
      </span>
      {unavailable && <span className="cgw-visually-hidden">{t('offline.notAvailable')}</span>}
    </a>
  );
}

export interface SidebarProps {
  session: WorkspaceSession;
  activePageId: Id | null;
  onSearch: () => void;
  onError: (error: unknown) => void;
}

/**
 * Workspace switcher, search, favourites, recent pages, the tree, templates, the trash and, when
 * there are any, the recovered pages.
 */
export function Sidebar({ session, activePageId, onSearch, onError }: SidebarProps) {
  const { t } = useTranslation();
  useMirror(session);
  const cloud = useCloud();
  const marks = useOfflineMarks(cloud);
  useRecoveredRevision(cloud);
  const [switcher, setSwitcher] = useState<{ x: number; y: number } | null>(null);
  const [templates, setTemplates] = useState<{ x: number; y: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const workspaceId = session.workspaceId;
  const trashedRows = useTrashedRowCount(session, workspaceId);
  if (!workspaceId) return null;
  const favourites = session.mirror.favouritesOf(workspaceId);
  const recent = session.mirror.recentOf(workspaceId, 5);
  const templateList = session.mirror.templatesOf(workspaceId);
  // Pages trashed with what is under them, and rows trashed on their own.
  const trashCount = session.mirror.trash(workspaceId).length + trashedRows;
  const recoveredCount = cloud ? cloud.recovery.visible().length : 0;
  const unavailable = (page: PageRecord) => !!marks && !marks.has(page.id);
  return (
    <div className="cgw-sidebar-inner">
      <button
        type="button"
        className="cgw-workspace-switcher"
        aria-haspopup="menu"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setSwitcher({ x: rect.left + 8, y: rect.bottom });
        }}
      >
        <span className="cgw-workspace-name">{session.current?.name}</span>
        <span aria-hidden="true">▾</span>
      </button>
      <button type="button" className="cgw-side-button" onClick={onSearch}>
        <span aria-hidden="true">⌕</span> {t('search.open')}
        <kbd className="cgw-kbd">{t('search.shortcut')}</kbd>
      </button>
      <div className="cgw-sidebar-body">
        {favourites.length > 0 && (
          <section className="cgw-side-group" aria-label={t('workspace.favourites')}>
            <h2 className="cgw-side-heading">{t('workspace.favourites')}</h2>
            {favourites.map((page) => (
              <PageLink
                key={page.id}
                page={page}
                active={page.id === activePageId}
                unavailable={unavailable(page)}
              />
            ))}
          </section>
        )}
        {recent.length > 0 && (
          <section className="cgw-side-group" aria-label={t('workspace.recent')}>
            <h2 className="cgw-side-heading">{t('workspace.recent')}</h2>
            {recent.map((page) => (
              <PageLink key={page.id} page={page} active={false} unavailable={unavailable(page)} />
            ))}
          </section>
        )}
        <PageTree session={session} activePageId={activePageId} onError={onError} />
      </div>
      <div className="cgw-sidebar-tools">
        {templateList.length > 0 && (
          <button
            type="button"
            className="cgw-side-button"
            aria-haspopup="menu"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setTemplates({ x: rect.left + 8, y: rect.top - 8 });
            }}
          >
            <span aria-hidden="true">⧉</span> {t('workspace.newFromTemplate')}
          </button>
        )}
        {recoveredCount > 0 && (
          <a href={routeHash({ kind: 'recovered' })} className="cgw-side-button">
            <span aria-hidden="true">♻</span> {t('recovered.title')}
            <span className="cgw-count">{recoveredCount}</span>
          </a>
        )}
        <a href={routeHash({ kind: 'trash' })} className="cgw-side-button">
          <span aria-hidden="true">🗑</span> {t('trash.title')}
          {trashCount > 0 && <span className="cgw-count">{trashCount}</span>}
        </a>
      </div>
      {switcher && (
        <PointMenu
          x={switcher.x}
          y={switcher.y}
          label={t('workspace.switch')}
          onClose={() => setSwitcher(null)}
          items={[
            ...session.workspaces().map((w) => ({
              label: w.id === workspaceId ? `✓ ${w.name}` : w.name,
              onSelect: () => {
                session.switchTo(w.id);
                navigate({ kind: 'home' });
              },
            })),
            { label: t('workspace.createAnother'), onSelect: () => setCreating(true) },
          ]}
        />
      )}
      {templates && (
        <PointMenu
          x={templates.x}
          y={templates.y}
          label={t('workspace.newFromTemplate')}
          onClose={() => setTemplates(null)}
          items={templateList.map((template) => ({
            label: `${pageGlyph(template)} ${template.title || t('page.untitled')}`,
            onSelect: () =>
              void session
                .newFromTemplate(template.id)
                .then((page) => navigate({ kind: 'page', pageId: page.id }), onError),
          }))}
        />
      )}
      {creating && (
        <CreateWorkspaceDialog
          onClose={() => setCreating(false)}
          onCreate={async (name) => {
            const { createFirstWorkspace } = await import('../gettingStarted');
            const first = await createFirstWorkspace(
              session,
              {
                workspace: name || t('workspace.defaultName'),
                shared: t('workspace.sectionShared'),
                private: t('workspace.sectionPrivate'),
              },
              document.documentElement.lang === 'ar' ? 'ar' : 'en',
            );
            navigate({ kind: 'page', pageId: first });
          }}
        />
      )}
    </div>
  );
}

function CreateWorkspaceDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  return (
    <Dialog title={t('workspace.createAnother')} onClose={onClose}>
      <form
        className="cgw-dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate(name.trim()).then(onClose);
        }}
      >
        <label htmlFor="cgw-new-workspace">{t('workspace.nameLabel')}</label>
        <input
          id="cgw-new-workspace"
          className="cgw-input"
          value={name}
          autoFocus
          placeholder={t('workspace.defaultName')}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="cgw-dialog-buttons">
          <button type="button" className="cgw-button" onClick={onClose}>
            {t('frame.cancel')}
          </button>
          <button type="submit" className="cgw-button is-primary">
            {t('workspace.create')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
