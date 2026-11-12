// The page tree: a stand-in for Track U4's CgTreeView with drag and drop, inline rename,
// virtualisation and lazy children, behind the props that component will take. Rows come from the
// mirror; only the rows on screen are in the DOM.
import type { Id } from '@cgw/workspace';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useCloud, useOfflineMarks } from '../cloud/CloudUi';
import { requestCsvImport, requestNewDatabase } from '../database/dialogs';
import { pageGlyph } from '../database/make';
import { navigate } from '../route';
import { canEditPage, type WorkspaceSession } from '../session';
import { PointMenu, RowMenu } from './RowMenu';
import { dropTarget, dropZone, treeRows, type DropZone, type TreeRow } from './tree';

export const ROW_HEIGHT = 28;
const OVERSCAN = 8;
const DRAG_TYPE = 'application/x-cgw-page';

export interface PageTreeProps {
  session: WorkspaceSession;
  activePageId: Id | null;
  onError: (error: unknown) => void;
}

/** Which pages are expanded, kept per device and per workspace in the local store. */
function useExpanded(session: WorkspaceSession, workspaceId: Id) {
  const [expanded, setExpanded] = useState<Set<Id>>(() => new Set());
  const key = `tree/expanded/${workspaceId}`;
  useEffect(() => {
    let live = true;
    void session.store.getPref<Id[]>(key).then((ids) => {
      if (live && ids) setExpanded(new Set(ids));
    });
    return () => {
      live = false;
    };
  }, [session, key]);
  const update = useCallback(
    (change: (set: Set<Id>) => void) =>
      setExpanded((previous) => {
        const next = new Set(previous);
        change(next);
        void session.store.setPref(key, [...next]);
        return next;
      }),
    [session, key],
  );
  return [expanded, update] as const;
}

export function PageTree({ session, activePageId, onError }: PageTreeProps) {
  const { t } = useTranslation();
  const workspaceId = session.workspaceId!;
  const [expanded, updateExpanded] = useExpanded(session, workspaceId);
  // Offline: the pages this device holds; the others are marked (null when online).
  const marks = useOfflineMarks(useCloud());
  const revision = session.mirror.getRevision();
  const rows = useMemo(
    () => treeRows(session.mirror, workspaceId, expanded),
    // The mirror changes in place; its revision says when.
    [session, workspaceId, expanded, revision],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Id | null>(null);
  const [drop, setDrop] = useState<{ key: string; zone: DropZone } | null>(null);
  const [menu, setMenu] = useState<{ pageId: Id; x: number; y: number } | null>(null);
  const [databaseMenu, setDatabaseMenu] = useState<{
    sectionId: Id;
    name: string;
    x: number;
    y: number;
  } | null>(null);
  const dragging = useRef<Id | null>(null);

  // Open the ancestors of the page on screen, so it shows in the tree.
  useEffect(() => {
    if (!activePageId) return;
    const ancestors = session.mirror.ancestors(activePageId);
    if (ancestors.some((a) => !expanded.has(a.id)))
      updateExpanded((set) => ancestors.forEach((a) => set.add(a.id)));
  }, [activePageId, session]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(
    rows.length,
    Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN,
  );
  const focusIndex = Math.max(
    0,
    rows.findIndex((r) => r.key === (focusKey ?? activePageId)),
  );

  const focusRow = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    setFocusKey(row.key);
    const el = scroller.current;
    const top = rows.indexOf(row) * ROW_HEIGHT;
    if (el && (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight))
      el.scrollTop = top - el.clientHeight / 2;
    requestAnimationFrame(() =>
      scroller.current?.querySelector<HTMLElement>(`[data-key="${row.key}"]`)?.focus(),
    );
  };

  const toggle = (id: Id, open?: boolean) =>
    updateExpanded((set) => {
      if (open ?? !set.has(id)) set.add(id);
      else set.delete(id);
    });

  const addPage = async (sectionId: Id, parentPageId: Id | null) => {
    try {
      const page = await session.createPage({ sectionId, parentPageId });
      if (parentPageId) toggle(parentPageId, true);
      navigate({ kind: 'page', pageId: page.id });
    } catch (error) {
      onError(error);
    }
  };

  /** "New database": empty, or from a template (the dialog), where a page would go. */
  const addDatabase = async (
    sectionId: Id,
    parentPageId: Id | null,
    from: 'new' | 'csv' = 'new',
  ) => {
    const place = {
      workspaceId,
      sectionId,
      parentPageId,
      orderKey: session.keyFor(sectionId, parentPageId),
    };
    const made = await (from === 'csv' ? requestCsvImport(place) : requestNewDatabase(place));
    if (!made) return;
    if (parentPageId) toggle(parentPageId, true);
    navigate({ kind: 'page', pageId: made.databaseId });
  };

  const onKeyDown = (event: KeyboardEvent, row: TreeRow, index: number) => {
    if (renaming) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(index + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(index - 1);
        return;
      case 'Home':
        event.preventDefault();
        focusRow(0);
        return;
      case 'End':
        event.preventDefault();
        focusRow(rows.length - 1);
        return;
    }
    if (row.kind !== 'page') return;
    const rtl = document.documentElement.dir === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (event.key === forward) {
      event.preventDefault();
      if (row.hasChildren && !row.expanded) toggle(row.page.id, true);
      else if (row.expanded) focusRow(index + 1);
    } else if (event.key === back) {
      event.preventDefault();
      if (row.expanded) toggle(row.page.id, false);
      else if (row.page.parentPageId)
        focusRow(rows.findIndex((r) => r.key === row.page.parentPageId));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      navigate({ kind: 'page', pageId: row.page.id });
    } else if (event.key === 'F2') {
      event.preventDefault();
      if (canEditPage(row.page)) setRenaming(row.page.id);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      if (canEditPage(row.page)) void session.trashPage(row.page.id).catch(onError);
    } else if (
      canEditPage(row.page) &&
      event.altKey &&
      event.shiftKey &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      event.preventDefault();
      const siblings = session.siblingsOf(row.page.sectionId, row.page.parentPageId);
      const at = siblings.findIndex((p) => p.id === row.page.id);
      const target = event.key === 'ArrowUp' ? at - 2 : at + 1;
      if (target < -1 || target >= siblings.length) return;
      void session
        .movePage(row.page.id, {
          sectionId: row.page.sectionId,
          parentPageId: row.page.parentPageId,
          after: target < 0 ? null : siblings[target].id,
        })
        .catch(onError);
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      setMenu({ pageId: row.page.id, x: rect.left + 24, y: rect.bottom });
    }
  };

  /**
   * A page goes inside another only if the account may edit that one (the server checks again),
   * and never inside a database (only its rows sit under it).
   */
  const mayHold = (parentPageId: Id | null) => {
    if (!parentPageId) return true;
    const parent = session.mirror.pages.get(parentPageId);
    return canEditPage(parent) && parent?.kind !== 'database';
  };

  const onDragOver = (event: DragEvent, row: TreeRow) => {
    if (!dragging.current) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const zone =
      row.kind === 'section' ? 'inside' : dropZone(event.clientY - rect.top, rect.height);
    const target = dropTarget(session.mirror, dragging.current, row, zone);
    if (!target || !mayHold(target.parentPageId)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (drop?.key !== row.key || drop.zone !== zone) setDrop({ key: row.key, zone });
  };

  const onDrop = (event: DragEvent, row: TreeRow) => {
    const pageId = dragging.current;
    if (!pageId || !drop) return;
    event.preventDefault();
    const target = dropTarget(session.mirror, pageId, row, drop.zone);
    setDrop(null);
    dragging.current = null;
    if (!target || !mayHold(target.parentPageId)) return;
    if (target.parentPageId) toggle(target.parentPageId, true);
    void session.movePage(pageId, target).catch(onError);
  };

  return (
    <div
      ref={scroller}
      className="cgw-tree"
      role="tree"
      aria-label={t('workspace.pages')}
      onScroll={(event) => {
        const el = event.currentTarget;
        setViewport({ top: el.scrollTop, height: el.clientHeight });
      }}
    >
      <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
        {rows.slice(first, last).map((row, offset) => {
          const index = first + offset;
          const style = { top: index * ROW_HEIGHT, height: ROW_HEIGHT };
          const focused = index === focusIndex;
          const dropClass = drop?.key === row.key ? ` is-drop-${drop.zone}` : '';
          if (row.kind === 'section')
            return (
              <div
                key={row.key}
                data-key={row.key}
                className={`cgw-tree-section${dropClass}`}
                style={style}
                role="treeitem"
                aria-level={1}
                aria-selected={false}
                tabIndex={focused ? 0 : -1}
                onKeyDown={(event) => onKeyDown(event, row, index)}
                onDragOver={(event) => onDragOver(event, row)}
                onDragLeave={() => setDrop(null)}
                onDrop={(event) => onDrop(event, row)}
              >
                <span className="cgw-tree-section-name">{row.section.name}</span>
                <button
                  type="button"
                  className="cgw-tree-action"
                  tabIndex={-1}
                  aria-label={t('databases.newDatabaseIn', { name: row.section.name })}
                  title={t('databases.newDatabaseIn', { name: row.section.name })}
                  data-action="new-database"
                  aria-haspopup="menu"
                  onClick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setDatabaseMenu({
                      sectionId: row.section.id,
                      name: row.section.name,
                      x: rect.left,
                      y: rect.bottom,
                    });
                  }}
                >
                  <span aria-hidden="true">{pageGlyph({ icon: null, kind: 'database' })}</span>
                </button>
                <button
                  type="button"
                  className="cgw-tree-action"
                  tabIndex={-1}
                  aria-label={t('workspace.addPageIn', { name: row.section.name })}
                  title={t('workspace.addPageIn', { name: row.section.name })}
                  onClick={() => void addPage(row.section.id, null)}
                >
                  +
                </button>
              </div>
            );
          const { page } = row;
          const active = page.id === activePageId;
          const unavailable = !!marks && !marks.has(page.id);
          // The account may only view it: no rename, drag, trash or page inside it.
          const editable = canEditPage(page);
          return (
            <div
              key={row.key}
              data-key={row.key}
              className={`cgw-tree-row${active ? ' is-active' : ''}${unavailable ? ' is-unavailable' : ''}${dropClass}`}
              title={unavailable ? t('offline.notAvailable') : undefined}
              style={{ ...style, paddingInlineStart: 8 + row.depth * 16 }}
              role="treeitem"
              aria-level={row.depth + 2}
              aria-setsize={row.siblings}
              aria-posinset={row.index + 1}
              aria-expanded={row.hasChildren ? row.expanded : undefined}
              aria-selected={active}
              aria-current={active ? 'page' : undefined}
              tabIndex={focused ? 0 : -1}
              draggable={editable && renaming !== page.id}
              onKeyDown={(event) => onKeyDown(event, row, index)}
              onClick={() => navigate({ kind: 'page', pageId: page.id })}
              onDoubleClick={() => editable && setRenaming(page.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ pageId: page.id, x: event.clientX, y: event.clientY });
              }}
              onFocus={() => setFocusKey(row.key)}
              onDragStart={(event) => {
                dragging.current = page.id;
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(DRAG_TYPE, page.id);
                event.dataTransfer.setData('text/plain', page.title);
              }}
              onDragEnd={() => {
                dragging.current = null;
                setDrop(null);
              }}
              onDragOver={(event) => onDragOver(event, row)}
              onDragLeave={() => setDrop(null)}
              onDrop={(event) => onDrop(event, row)}
            >
              <button
                type="button"
                className="cgw-tree-twisty"
                tabIndex={-1}
                aria-hidden="true"
                data-open={row.expanded}
                style={{ visibility: row.hasChildren ? 'visible' : 'hidden' }}
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(page.id);
                }}
              />
              <span className="cgw-tree-icon" aria-hidden="true">
                {pageGlyph(page)}
              </span>
              {renaming === page.id ? (
                <RenameField
                  initial={page.title}
                  label={t('page.title')}
                  onDone={(title) => {
                    setRenaming(null);
                    if (title !== null && title !== page.title)
                      void session.updatePage(page.id, { title }).catch(onError);
                    focusRow(index);
                  }}
                />
              ) : (
                <span className="cgw-tree-title" dir="auto">
                  {page.title || t('page.untitled')}
                </span>
              )}
              {unavailable && (
                <span className="cgw-visually-hidden">{t('offline.notAvailable')}</span>
              )}
              <span className="cgw-tree-actions">
                <button
                  type="button"
                  className="cgw-tree-action"
                  tabIndex={-1}
                  aria-label={t('workspace.pageMenu')}
                  title={t('workspace.pageMenu')}
                  onClick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setMenu({ pageId: page.id, x: rect.left, y: rect.bottom });
                  }}
                >
                  ⋯
                </button>
                {editable && page.kind !== 'database' && (
                  <button
                    type="button"
                    className="cgw-tree-action"
                    tabIndex={-1}
                    aria-label={t('workspace.addSubpage')}
                    title={t('workspace.addSubpage')}
                    onClick={(event) => {
                      event.stopPropagation();
                      void addPage(page.sectionId, page.id);
                    }}
                  >
                    +
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {menu && (
        <RowMenu
          session={session}
          pageId={menu.pageId}
          x={menu.x}
          y={menu.y}
          onRename={() => setRenaming(menu.pageId)}
          onAddInside={() => {
            const page = session.mirror.pages.get(menu.pageId);
            if (page) void addPage(page.sectionId, page.id);
          }}
          onAddDatabase={(from) => {
            const page = session.mirror.pages.get(menu.pageId);
            if (page) void addDatabase(page.sectionId, page.id, from);
          }}
          onClose={() => setMenu(null)}
          onError={onError}
        />
      )}
      {databaseMenu && (
        <PointMenu
          x={databaseMenu.x}
          y={databaseMenu.y}
          label={t('databases.newDatabaseIn', { name: databaseMenu.name })}
          onClose={() => setDatabaseMenu(null)}
          items={[
            {
              label: t('databases.newDatabase'),
              onSelect: () => void addDatabase(databaseMenu.sectionId, null),
            },
            {
              label: t('databases.importCsv'),
              onSelect: () => void addDatabase(databaseMenu.sectionId, null, 'csv'),
            },
          ]}
        />
      )}
    </div>
  );
}

function RenameField({
  initial,
  label,
  onDone,
}: {
  initial: string;
  label: string;
  onDone: (title: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };
  return (
    <input
      className="cgw-tree-rename"
      aria-label={label}
      dir="auto"
      autoFocus
      value={value}
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(value.trim())}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') finish(value.trim());
        if (event.key === 'Escape') finish(null);
      }}
    />
  );
}
