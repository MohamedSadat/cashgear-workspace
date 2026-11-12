// The page's menu in the top bar: favourite, template, history, export, trash.
import type { PageRecord } from '@cgw/workspace';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { navigate } from '../route';
import type { WorkspaceSession } from '../session';
import { PointMenu } from '../sidebar/RowMenu';

export const pageEvents = new EventTarget();

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
            {
              label: t(page.isTemplate ? 'workspace.notTemplate' : 'workspace.makeTemplate'),
              onSelect: () =>
                void session.updatePage(page.id, { isTemplate: !page.isTemplate }).catch(onError),
            },
            {
              label: t('workspace.moveToTrash'),
              danger: true,
              onSelect: () =>
                void session.trashPage(page.id).then(() => navigate({ kind: 'home' }), onError),
            },
          ]}
        />
      )}
    </>
  );
}
