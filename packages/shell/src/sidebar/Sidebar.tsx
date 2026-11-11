import { CgButton } from '@cashgear/ui';
import type { PageRecord, SectionRecord } from '@cgw/workspace';
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { navigate, routeHash } from '../route';
import type { WorkspaceSession } from '../session';

export function useMirror(session: WorkspaceSession): number {
  return useSyncExternalStore(
    (listener) => session.mirror.subscribe(listener),
    session.mirror.getRevision,
  );
}

/** The workspace's sections and their pages. M1.6 replaces the list with the full tree. */
export function Sidebar({
  session,
  activePageId,
}: {
  session: WorkspaceSession;
  activePageId: string | null;
}) {
  const { t } = useTranslation();
  useMirror(session);
  const workspaceId = session.workspaceId;
  if (!workspaceId) return null;
  const sections = session.mirror.sectionsOf(workspaceId);
  const addPage = async (section: SectionRecord, parent: PageRecord | null) => {
    const page = await session.createPage({
      sectionId: section.id,
      parentPageId: parent?.id ?? null,
    });
    navigate({ kind: 'page', pageId: page.id });
  };
  const renderPages = (section: SectionRecord, pages: PageRecord[], depth: number) =>
    pages.length ? (
      <ul role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? section.name : undefined}>
        {pages.map((page) => (
          <li key={page.id} role="treeitem" aria-selected={page.id === activePageId}>
            <a href={routeHash({ kind: 'page', pageId: page.id })} className="cgw-tree-link">
              <span aria-hidden="true">{page.icon ?? '📄'}</span> {page.title || t('page.untitled')}
            </a>
            {renderPages(section, session.mirror.childrenOf(page.id), depth + 1)}
          </li>
        ))}
      </ul>
    ) : null;
  return (
    <div className="cgw-sidebar-body">
      {sections.map((section) => (
        <section key={section.id} className="cgw-sidebar-section">
          <header className="cgw-sidebar-section-header">
            <span>{section.name}</span>
            <CgButton
              appearance="ghost"
              icon="add"
              aria-label={t('workspace.addPageIn', { name: section.name })}
              onClick={() => void addPage(section, null)}
            >
              <span className="cgw-visually-hidden">
                {t('workspace.addPageIn', { name: section.name })}
              </span>
            </CgButton>
          </header>
          {renderPages(section, session.mirror.topPages(section.id), 0)}
        </section>
      ))}
    </div>
  );
}
