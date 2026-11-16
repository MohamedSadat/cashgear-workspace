import { Mirror, MemoryStore } from '@cgw/workspace';
import { seedTree } from '@cgw/workspace/testing';
import { describe, expect, it } from 'vitest';
import { treeNodes, treeRows } from './tree';

async function seeded() {
  const store = new MemoryStore();
  const tree = await seedTree(store);
  const mirror = new Mirror(await store.readMirror(null));
  return { mirror, ...tree };
}

describe('sidebar tree', () => {
  it('lists only the children of expanded pages', async () => {
    const { mirror, ws, a, b, c, d } = await seeded();
    const titles = (expanded: string[]) =>
      treeRows(mirror, ws.id, new Set(expanded)).map((r) =>
        r.kind === 'page' ? `${'  '.repeat(r.depth)}${r.page.title}` : `#${r.section.name}`,
      );
    expect(titles([])).toEqual(['#Pages', 'Alpha', 'Gamma']);
    expect(titles([a.id])).toEqual(['#Pages', 'Alpha', '  Beta', 'Gamma']);
    expect(titles([a.id, b.id])).toEqual(['#Pages', 'Alpha', '  Beta', '    Delta', 'Gamma']);
    const rows = treeRows(mirror, ws.id, new Set([a.id]));
    const alpha = rows.find((r) => r.kind === 'page' && r.page.id === a.id);
    expect(alpha).toMatchObject({ hasChildren: true, expanded: true, index: 0, siblings: 2 });
    void c;
    void d;
  });

  it('gives the tree view its nodes: sections on top, pages under them, closed pages lazy', async () => {
    const { mirror, ws, section, a, b, c } = await seeded();
    const nodes = treeNodes(treeRows(mirror, ws.id, new Set([a.id])), {
      untitled: 'Untitled',
      unavailable: (id) => id === c.id,
      editable: () => true,
    });
    expect(nodes).toHaveLength(1);
    const [top] = nodes;
    expect(top).toMatchObject({
      key: `section:${section.id}`,
      text: 'Pages',
      allowSelection: false,
      allowDrag: false,
      allowRename: false,
    });
    const [alpha, gamma] = top.children!;
    expect(alpha).toMatchObject({ key: a.id, text: 'Alpha', renameText: 'Alpha', allowDrag: true });
    // Alpha is open: its child listed. Beta is closed and has a child: lazy, not listed.
    expect(alpha.children!.map((n) => n.key)).toEqual([b.id]);
    expect(alpha.children![0]).toMatchObject({ hasChildren: true });
    expect(alpha.children![0].children).toBeUndefined();
    // Gamma is not on this device while offline: marked.
    expect(gamma).toMatchObject({ key: c.id, className: 'is-unavailable' });
    expect(gamma.hasChildren).toBeUndefined();
  });
});
