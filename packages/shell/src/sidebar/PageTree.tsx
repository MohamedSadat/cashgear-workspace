// The page tree: the library's tree view (Track U4) over the mirror. Sections are its top rows,
// their pages below; only expanded pages' children are listed (`treeRows`), and only the rows on
// screen are drawn (`virtualize`), so a 10,000-page workspace costs what is on screen. Moving,
// renaming and expanding are the session's: the tree reports them, the mirror redraws it.
import {
  CgTreeView,
  type CgTreeViewActions,
  type CgTreeViewDropCandidate,
  type CgTreeViewMoveDetails,
  type CgTreeViewNodeRenderContext,
} from '@cashgear/ui';
import type { Id, PageRecord } from '@cgw/workspace';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useAccount, useCloud, useOfflineMarks } from '../cloud/CloudUi';
import { SidePresence } from '../collab/Avatars';
import { collaborates, useCollab, usePeople } from '../collab/context';
import { requestCsvImport, requestNewDatabase } from '../database/dialogs';
import { pageGlyph } from '../database/make';
import { navigate } from '../route';
import { canEditPage, type WorkspaceSession } from '../session';
import { PointMenu, RowMenu } from './RowMenu';
import { SECTION, expandedKey, onExpandRequest, treeNodes, treeRows, type TreeItem } from './tree';

/** One row's height: the virtual window's arithmetic, and the Phase 1 budget's. */
const ROW_HEIGHT = 28;
const OVERSCAN = 8;

export interface PageTreeProps {
  session: WorkspaceSession;
  activePageId: Id | null;
  onError: (error: unknown) => void;
}

/** Which pages are expanded, kept per device and per workspace in the local store. */
function useExpanded(session: WorkspaceSession, workspaceId: Id) {
  const [expanded, setExpanded] = useState<Set<Id>>(() => new Set());
  const key = expandedKey(workspaceId);
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
  const cloud = useCloud();
  const marks = useOfflineMarks(cloud);
  // Phase 6: who else has a page open, beside it (a workspace in the account only).
  const collab = useCollab();
  const account = useAccount(cloud);
  const people = usePeople(
    account && collaborates(collab, session, workspaceId) ? collab : null,
    workspaceId,
  );
  const revision = session.mirror.getRevision();
  const untitled = t('page.untitled');
  const nodes = useMemo(
    () =>
      treeNodes(treeRows(session.mirror, workspaceId, expanded), {
        untitled,
        unavailable: (pageId) => !!marks && !marks.has(pageId),
        editable: canEditPage,
        currentPageId: activePageId,
      }),
    // The mirror changes in place; its revision says when.
    [session, workspaceId, expanded, revision, untitled, marks, activePageId],
  );
  // Sections never fold (`collapsible: false`): the set is the pages'.
  const expandedKeys = expanded as ReadonlySet<string>;
  const actions = useRef<CgTreeViewActions>(null);
  const [menu, setMenu] = useState<{ pageId: Id; x: number; y: number } | null>(null);
  const [databaseMenu, setDatabaseMenu] = useState<{
    sectionId: Id;
    name: string;
    x: number;
    y: number;
  } | null>(null);

  // Open the ancestors of the page on screen, so it shows in the tree.
  useEffect(() => {
    if (!activePageId) return;
    const ancestors = session.mirror.ancestors(activePageId);
    if (ancestors.some((a) => !expanded.has(a.id)))
      updateExpanded((set) => ancestors.forEach((a) => set.add(a.id)));
  }, [activePageId, session]);

  // Phase 8: a page expanded from outside the tree (an import's top page once it is made), with
  // its ancestors, as a person's ArrowRight would leave it.
  useEffect(
    () =>
      onExpandRequest((pageId) => {
        const page = session.mirror.pages.get(pageId);
        if (page?.workspaceId !== workspaceId) return false;
        const ancestors = session.mirror.ancestors(pageId);
        updateExpanded((set) => [page, ...ancestors].forEach((p) => set.add(p.id)));
        return true;
      }),
    [session, workspaceId, updateExpanded],
  );

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

  /**
   * A page goes inside another only if the account may edit that one (the server checks again),
   * and never inside a database (only its rows sit under it); at a section's top always. Never
   * beside a section: the top level is the sections'.
   */
  const mayHold = (parentKey: string | null) => {
    if (parentKey === null) return false;
    if (parentKey.startsWith(SECTION)) return true;
    const parent = session.mirror.pages.get(parentKey);
    return canEditPage(parent) && parent?.kind !== 'database';
  };

  const canDrop = (candidate: CgTreeViewDropCandidate<TreeItem>) =>
    candidate.item?.kind === 'page' && mayHold(candidate.parentKey);

  /** The move the tree asked for, as the session's: its section, parent and the page it follows. */
  const onNodeMove = (details: CgTreeViewMoveDetails<TreeItem>) => {
    const page = session.mirror.pages.get(details.key);
    const parentKey = details.parentKey;
    if (!page || !parentKey || !mayHold(parentKey)) return;
    const inside = details.position === 'inside';
    const target = parentKey.startsWith(SECTION)
      ? {
          sectionId: parentKey.slice(SECTION.length),
          parentPageId: null,
          // Dropped on a section: first in it.
          after: inside ? null : details.previousKey,
        }
      : {
          sectionId: session.mirror.pages.get(parentKey)!.sectionId,
          parentPageId: parentKey,
          // Inside a page: where the session puts a page it is given (its children may not be
          // listed while it is closed).
          after: inside ? undefined : details.previousKey,
        };
    if (target.parentPageId) toggle(target.parentPageId, true);
    void session.movePage(page.id, target).catch(onError);
  };

  /** Where a moved page went, for the announcement: its parent's title, or its section's name. */
  const placeOf = (parentKey: string | null) => {
    if (!parentKey) return '';
    if (parentKey.startsWith(SECTION))
      return session.mirror.sections.get(parentKey.slice(SECTION.length))?.name ?? '';
    return session.mirror.pages.get(parentKey)?.title || untitled;
  };

  /** The page a row draws, read from its content (the row is the library's). */
  const pageOfRow = (row: Element | null): PageRecord | undefined => {
    const id = row?.querySelector<HTMLElement>('[data-page-id]')?.dataset.pageId;
    return id ? session.mirror.pages.get(id) : undefined;
  };

  // Keys the tree leaves to the app: Delete trashes a page, the menu key opens its actions.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = event.target as HTMLElement;
    if (row.getAttribute('role') !== 'treeitem') return;
    const page = pageOfRow(row);
    if (!page) return;
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (event.key === 'Delete' && plain) {
      event.preventDefault();
      event.stopPropagation();
      if (canEditPage(page)) void session.trashPage(page.id).catch(onError);
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      event.stopPropagation();
      const rect = row.getBoundingClientRect();
      setMenu({ pageId: page.id, x: rect.left + 24, y: rect.bottom });
    }
  };

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const page = pageOfRow((event.target as HTMLElement).closest('[role="treeitem"]'));
    if (!page) return;
    event.preventDefault();
    setMenu({ pageId: page.id, x: event.clientX, y: event.clientY });
  };

  const content = (context: CgTreeViewNodeRenderContext<TreeItem>) => {
    const item = context.item;
    if (!item) return null;
    if (item.kind === 'section')
      return (
        <span className="cgw-tree-section-name" data-section-id={item.section.id}>
          {item.section.name}
        </span>
      );
    const { page, unavailable } = item;
    return (
      <span
        className="cgw-tree-item"
        data-page-id={page.id}
        title={unavailable ? t('offline.notAvailable') : undefined}
      >
        <span className="cgw-tree-icon" aria-hidden="true">
          {pageGlyph(page)}
        </span>
        <span className="cgw-tree-title" dir="auto">
          {page.title || untitled}
        </span>
        {/* The row is named by this content (`aria-labelledby`): a space between its parts keeps
            the words apart in the name (Axe's label-in-name read "elsewhereNot" without it). The
            flex row draws no space. The avatars draw no letters here: letters are text the name
            would not hold. */}
        {unavailable && (
          <>
            {' '}
            <span className="cgw-visually-hidden">{t('offline.notAvailable')}</span>
          </>
        )}
        {people && (
          <>
            {' '}
            <SidePresence collab={collab} pageId={page.id} people={people} initials={false} />
          </>
        )}
      </span>
    );
  };

  const rowActions = (context: CgTreeViewNodeRenderContext<TreeItem>) => {
    const item = context.item;
    if (!item) return null;
    if (item.kind === 'section') {
      const { section } = item;
      return (
        <>
          <button
            type="button"
            className="cgw-tree-action"
            tabIndex={-1}
            aria-label={t('databases.newDatabaseIn', { name: section.name })}
            title={t('databases.newDatabaseIn', { name: section.name })}
            data-action="new-database"
            aria-haspopup="menu"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setDatabaseMenu({
                sectionId: section.id,
                name: section.name,
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
            aria-label={t('workspace.addPageIn', { name: section.name })}
            title={t('workspace.addPageIn', { name: section.name })}
            onClick={() => void addPage(section.id, null)}
          >
            +
          </button>
        </>
      );
    }
    const { page } = item;
    return (
      <>
        <button
          type="button"
          className="cgw-tree-action"
          tabIndex={-1}
          aria-label={t('workspace.pageMenu')}
          title={t('workspace.pageMenu')}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ pageId: page.id, x: rect.left, y: rect.bottom });
          }}
        >
          ⋯
        </button>
        {canEditPage(page) && page.kind !== 'database' && (
          <button
            type="button"
            className="cgw-tree-action"
            tabIndex={-1}
            aria-label={t('workspace.addSubpage')}
            title={t('workspace.addSubpage')}
            onClick={() => void addPage(page.sectionId, page.id)}
          >
            +
          </button>
        )}
      </>
    );
  };

  return (
    <>
      <CgTreeView<TreeItem>
        className="cgw-tree"
        aria-label={t('workspace.pages')}
        nodes={nodes}
        size="small"
        virtualize
        rowHeight={ROW_HEIGHT}
        overscan={OVERSCAN}
        // Right to left, ArrowLeft opens a row, as the reading direction goes.
        arrowKeys="logical"
        // The page on screen is the selected row; choosing a row opens its page, and the
        // selection follows the route.
        selectedKey={activePageId}
        beforeSelectionChange={() => false}
        onNodeActivate={(details) => {
          const item = details.node?.item;
          if (item?.kind === 'page') navigate({ kind: 'page', pageId: item.page.id });
        }}
        expandedKeys={expandedKeys}
        onExpandedKeysChange={(_keys, details) => {
          // The tree's own corrections (a page not listed) leave what this device keeps alone.
          if (details.source === 'collection' || !details.key) return;
          if (details.key.startsWith(SECTION)) return;
          toggle(details.key, details.expanded);
        }}
        // The toggle's name; the library puts the row's title where `{0}` is.
        labels={{
          expand: t('workspace.expandRow', { title: '{0}' }),
          collapse: t('workspace.collapseRow', { title: '{0}' }),
        }}
        // A workspace always has sections; without any, an empty tree (no English of its own).
        renderEmpty={() => <></>}
        nodeRenderer={content}
        renderActions={rowActions}
        onNodeRename={({ key, text }) => {
          const page = session.mirror.pages.get(key);
          const title = text.trim();
          if (page && title !== page.title) void session.updatePage(key, { title }).catch(onError);
        }}
        renameLabel={t('page.title')}
        onNodeMove={onNodeMove}
        canDrop={canDrop}
        moveLabels={{
          instructions: t('workspace.moveInstructions', { keys: 'Alt+Shift' }),
          moved: (details) =>
            t('workspace.moved', {
              title: session.mirror.pages.get(details.key)?.title || untitled,
              place: placeOf(details.parentKey),
            }),
        }}
        actionsRef={actions}
        onKeyDownCapture={onKeyDownCapture}
        onContextMenu={onContextMenu}
      />
      {menu && (
        <RowMenu
          session={session}
          pageId={menu.pageId}
          x={menu.x}
          y={menu.y}
          onRename={() => {
            try {
              void actions.current?.startRename(menu.pageId).catch(onError);
            } catch (error) {
              // The row is not drawn (scrolled away and closed meanwhile).
              onError(error);
            }
          }}
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
    </>
  );
}
