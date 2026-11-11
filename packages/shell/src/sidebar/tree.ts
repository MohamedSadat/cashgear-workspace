// The sidebar's rows, drawn from the mirror (DATA_MODEL.md, "Large workspaces"): only expanded
// pages' children are listed, so a 10,000-page workspace costs what is on screen.
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

/** Where a drop lands, from the pointer's place in a row: above, inside, or below it. */
export type DropZone = 'before' | 'inside' | 'after';

export function dropZone(offsetY: number, height: number): DropZone {
  if (offsetY < height * 0.28) return 'before';
  if (offsetY > height * 0.72) return 'after';
  return 'inside';
}

/** What a drop of `pageId` on a row means as a move; null when it would make a cycle. */
export function dropTarget(
  mirror: Mirror,
  pageId: Id,
  row: TreeRow,
  zone: DropZone,
): { sectionId: Id; parentPageId: Id | null; after: Id | null | undefined } | null {
  if (row.kind === 'section') return { sectionId: row.section.id, parentPageId: null, after: null };
  const target = row.page;
  if (target.id === pageId) return null;
  if (mirror.ancestors(target.id).some((a) => a.id === pageId)) return null;
  if (zone === 'inside')
    return { sectionId: target.sectionId, parentPageId: target.id, after: undefined };
  const siblings = target.parentPageId
    ? mirror.childrenOf(target.parentPageId)
    : mirror.topPages(target.sectionId);
  const others = siblings.filter((p) => p.id !== pageId);
  const after =
    zone === 'after'
      ? target.id
      : (others[others.findIndex((p) => p.id === target.id) - 1]?.id ?? null);
  return { sectionId: target.sectionId, parentPageId: target.parentPageId, after };
}
