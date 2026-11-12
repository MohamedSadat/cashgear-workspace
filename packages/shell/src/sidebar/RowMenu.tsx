// A page's menu in the tree: rename, add inside, favourite, template, available offline, trash.
// Arrow keys move through it; Escape closes it.
import type { Id } from '@cgw/workspace';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { offlineMenuItems, useCloud } from '../cloud/CloudUi';
import { canEditPage, type WorkspaceSession } from '../session';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/** A small menu at a point; focus moves into it and back out when it closes. */
export function PointMenu({
  x,
  y,
  label,
  items,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ top: y, left: x });
  const returnTo = useRef<Element | null>(document.activeElement);
  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    const rtl = getComputedStyle(el).direction === 'rtl';
    const left = rtl ? x - el.offsetWidth : x;
    setPlace({
      top: Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)),
      left: Math.max(8, Math.min(left, window.innerWidth - el.offsetWidth - 8)),
    });
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [x, y]);
  const close = () => {
    onClose();
    (returnTo.current as HTMLElement | null)?.focus?.();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const all = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      all[(at + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      close();
    }
  };
  return (
    <>
      <div className="cgw-menu-backdrop" onMouseDown={close} />
      <div
        ref={menu}
        className="cgw-menu"
        role="menu"
        aria-label={label}
        style={place}
        onKeyDown={onKeyDown}
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={`cgw-menu-item${item.danger ? ' is-danger' : ''}`}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

export function RowMenu({
  session,
  pageId,
  x,
  y,
  onRename,
  onAddInside,
  onClose,
  onError,
}: {
  session: WorkspaceSession;
  pageId: Id;
  x: number;
  y: number;
  onRename: () => void;
  onAddInside: () => void;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const cloud = useCloud();
  const page = session.mirror.pages.get(pageId);
  if (!page || !session.workspaceId) return null;
  const favourite = session.mirror.isFavourite(session.workspaceId, pageId);
  // A page the account may only view: nothing here changes it (the server checks again).
  const editable = canEditPage(page);
  const favouriteItem = {
    label: t(favourite ? 'workspace.unfavourite' : 'workspace.favourite'),
    onSelect: () => void session.setFavourite(pageId, !favourite).catch(onError),
  };
  return (
    <PointMenu
      x={x}
      y={y}
      label={t('workspace.pageMenu')}
      onClose={onClose}
      items={
        editable
          ? [
              { label: t('workspace.rename'), onSelect: onRename },
              { label: t('workspace.addSubpage'), onSelect: onAddInside },
              favouriteItem,
              {
                label: t(page.isTemplate ? 'workspace.notTemplate' : 'workspace.makeTemplate'),
                onSelect: () =>
                  void session.updatePage(pageId, { isTemplate: !page.isTemplate }).catch(onError),
              },
              ...offlineMenuItems(cloud, session, pageId, t),
              {
                label: t('workspace.moveToTrash'),
                danger: true,
                onSelect: () => void session.trashPage(pageId).catch(onError),
              },
            ]
          : [favouriteItem, ...offlineMenuItems(cloud, session, pageId, t)]
      }
    />
  );
}
