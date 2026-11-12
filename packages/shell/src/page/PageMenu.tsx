// The page's menu in the top bar: favourite, share, history, export, template, available
// offline, trash.
import type { Id, PageRecord } from '@cgw/workspace';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { offlineMenuItems, useCloud } from '../cloud/CloudUi';
import { navigate } from '../route';
import { canEditPage, type WorkspaceSession } from '../session';
import { PointMenu } from '../sidebar/RowMenu';

export const pageEvents = new EventTarget();

/** Pages whose history was asked for (by a notice) before the page was on screen. */
const historyWanted = new Set<Id>();

/** Opens a page's history: now if the page is on screen, else as soon as it is. */
export function openHistory(pageId: Id) {
  historyWanted.add(pageId);
  pageEvents.dispatchEvent(new CustomEvent('history', { detail: pageId }));
}

/** True once for a page whose history was asked for: the page view opens it. */
export function takeHistoryRequest(pageId: Id): boolean {
  return historyWanted.delete(pageId);
}

export function PageMenu({
  session,
  page,
  onError,
  canShare = false,
}: {
  session: WorkspaceSession;
  page: PageRecord;
  onError: (error: unknown) => void;
  /** The page's workspace is in the signed-in account. */
  canShare?: boolean;
}) {
  const { t } = useTranslation();
  const cloud = useCloud();
  // Only someone who may edit the page changes it (the server checks again).
  const editable = canEditPage(page);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const favourite =
    !!session.workspaceId && session.mirror.isFavourite(session.workspaceId, page.id);
  return (
    <>
      <button
        type="button"
        className="cgw-icon-button cgw-topbar-button"
        aria-pressed={favourite}
        aria-label={t(favourite ? 'workspace.unfavourite' : 'workspace.favourite')}
        title={t(favourite ? 'workspace.unfavourite' : 'workspace.favourite')}
        onClick={() => void session.setFavourite(page.id, !favourite).catch(onError)}
      >
        {favourite ? '★' : '☆'}
      </button>
      <button
        type="button"
        className="cgw-icon-button cgw-topbar-button"
        aria-haspopup="menu"
        aria-label={t('workspace.pageMenu')}
        title={t('workspace.pageMenu')}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.right, y: rect.bottom + 4 });
        }}
      >
        ⋯
      </button>
      {menu && (
        <PointMenu
          x={menu.x - 200}
          y={menu.y}
          label={t('workspace.pageMenu')}
          onClose={() => setMenu(null)}
          items={[
            ...(canShare
              ? [
                  {
                    label: t('share.open'),
                    onSelect: () =>
                      pageEvents.dispatchEvent(new CustomEvent('share', { detail: page.id })),
                  },
                ]
              : []),
            {
              label: t('history.open'),
              onSelect: () =>
                pageEvents.dispatchEvent(new CustomEvent('history', { detail: page.id })),
            },
            {
              label: t('exchange.exportPage'),
              onSelect: () =>
                pageEvents.dispatchEvent(new CustomEvent('export', { detail: page.id })),
            },
            ...(editable
              ? [
                  {
                    label: t(page.isTemplate ? 'workspace.notTemplate' : 'workspace.makeTemplate'),
                    onSelect: () =>
                      void session
                        .updatePage(page.id, { isTemplate: !page.isTemplate })
                        .catch(onError),
                  },
                ]
              : []),
            ...offlineMenuItems(cloud, session, page.id, t),
            ...(editable
              ? [
                  {
                    label: t('workspace.moveToTrash'),
                    danger: true,
                    onSelect: () =>
                      void session
                        .trashPage(page.id)
                        .then(() => navigate({ kind: 'home' }), onError),
                  },
                ]
              : []),
          ]}
        />
      )}
    </>
  );
}
