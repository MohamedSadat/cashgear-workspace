// The sidebar's rows, drawn from the mirror (DATA_MODEL.md, "Large workspaces"): only expanded
// pages' children are listed, so a 10,000-page workspace costs what is on screen. The page tree
// (`PageTree`, the library's tree view) is built from them.
import type { CgTreeViewNodeDescriptor } from '@cashgear/ui';
import type { Id, Mirror, PageRecord, SectionRecord } from '@cgw/workspace';

export type TreeRow =
  | { kind: 'section'; key: string; section: SectionRecord; empty: boolean }
  | {
      kind: 'page';
      key: string;
      page: PageRecord;
      depth: number;
      hasChildren: boolean;
      expanded: boolean;
      /** Position among its siblings, for assistive technology. */
      index: number;
      siblings: number;
      sectionId: Id;
    };

export function treeRows(mirror: Mirror, workspaceId: Id, expanded: ReadonlySet<Id>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (pages: PageRecord[], depth: number, sectionId: Id) => {
    pages.forEach((page, index) => {
      const hasChildren = mirror.hasChildren(page.id);
      const open = hasChildren && expanded.has(page.id);
      rows.push({
        kind: 'page',
        key: page.id,
        page,
        depth,
        hasChildren,
        expanded: open,
        index,
        siblings: pages.length,
        sectionId,
      });
      if (open) walk(mirror.childrenOf(page.id), depth + 1, sectionId);
    });
  };
  for (const section of mirror.sectionsOf(workspaceId)) {
    const top = mirror.topPages(section.id);
    rows.push({ kind: 'section', key: `section:${section.id}`, section, empty: top.length === 0 });
    walk(top, 0, section.id);
  }
  return rows;
}

/** A section's key in the tree view (a page's is its id). */
export const SECTION = 'section:';

/** What a node of the tree view stands for. */
export type TreeItem =
  | { kind: 'section'; section: SectionRecord }
  | { kind: 'page'; page: PageRecord; unavailable: boolean };

type Node = CgTreeViewNodeDescriptor<TreeItem>;

/**
 * The tree's nodes from the rows the sidebar shows: each section with its top pages, and each
 * expanded page with its children. A page with children not listed is `hasChildren`.
 */
export function treeNodes(
  rows: TreeRow[],
  {
    untitled,
    unavailable,
    editable,
    currentPageId = null,
  }: {
    untitled: string;
    /** Offline, and this device does not hold the page. */
    unavailable: (pageId: Id) => boolean;
    /** The account may change the page (rename, move). */
    editable: (page: PageRecord) => boolean;
    /** The page on screen: its row is the current one (`aria-current="page"`). */
    currentPageId?: Id | null;
  },
): Node[] {
  const roots: Node[] = [];
  // The children list at each depth: 0 is the section's, 1 its first pages', and so on.
  const lists: Node[][] = [];
  for (const row of rows) {
    if (row.kind === 'section') {
      const children: Node[] = [];
      roots.push({
        key: `${SECTION}${row.section.id}`,
        text: row.section.name,
        item: { kind: 'section', section: row.section },
        children,
        // A heading: always open, no toggle.
        collapsible: false,
        allowSelection: false,
        allowDrag: false,
        allowRename: false,
        className: 'cgw-tree-section',
      });
      lists.length = 0;
      lists.push(children);
      continue;
    }
    const { page } = row;
    const mayEdit = editable(page);
    const away = unavailable(page.id);
    const children: Node[] | undefined = row.expanded ? [] : undefined;
    lists[row.depth]?.push({
      key: page.id,
      text: page.title || untitled,
      renameText: page.title,
      item: { kind: 'page', page, unavailable: away },
      ...(children ? { children } : {}),
      ...(row.hasChildren ? { hasChildren: true } : {}),
      // The account may only view it: no rename, drag or move.
      allowDrag: mayEdit,
      allowRename: mayEdit,
      ...(away ? { className: 'is-unavailable' } : {}),
      ...(page.id === currentPageId ? { current: 'page' as const } : {}),
    });
    lists.length = row.depth + 1;
    if (children) lists.push(children);
  }
  return roots;
}

/** Where the tree keeps which pages are expanded, per device and workspace (the local store). */
export const expandedKey = (workspaceId: Id) => `tree/expanded/${workspaceId}`;

/** A request from outside the tree to expand a page's row; true when a tree drawn took it. */
type ExpandListener = (pageId: Id) => boolean;
const expandListeners = new Set<ExpandListener>();

/** The tree drawn takes expand requests while it is (`PageTree`). */
export function onExpandRequest(listener: ExpandListener): () => void {
  expandListeners.add(listener);
  return () => void expandListeners.delete(listener);
}

/**
 * Expands a page's row, and its ancestors', in the tree's own state, as a person's ArrowRight
 * would leave it (Phase 8: an import's top page once the import ends, so what was made shows).
 * When no tree is drawn, the state the tree reads when it is drawn is written instead.
 */
export async function expandInTree(
  store: {
    getPref<T>(key: string): Promise<T | undefined>;
    setPref(key: string, value: unknown): Promise<void>;
  },
  mirror: Mirror,
  pageId: Id,
): Promise<void> {
  let taken = false;
  for (const listener of expandListeners) taken = listener(pageId) || taken;
  const page = mirror.pages.get(pageId);
  if (taken || !page) return;
  const key = expandedKey(page.workspaceId);
  const held = (await store.getPref<Id[]>(key)) ?? [];
  const ids = [pageId, ...mirror.ancestors(pageId).map((a) => a.id)];
  await store.setPref(key, [...new Set([...held, ...ids])]);
}
