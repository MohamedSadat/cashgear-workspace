import { Mirror, MemoryStore } from '@cgw/workspace';
import { seedTree } from '@cgw/workspace/testing';
import { describe, expect, it } from 'vitest';
import { dropTarget, dropZone, treeRows } from './tree';

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

  it('reads a drop as before, inside or after a row, and refuses a cycle', async () => {
    const { mirror, ws, a, b, c, d } = await seeded();
    expect(dropZone(2, 28)).toBe('before');
    expect(dropZone(14, 28)).toBe('inside');
    expect(dropZone(26, 28)).toBe('after');
    const rows = treeRows(mirror, ws.id, new Set([a.id, b.id]));
    const rowOf = (id: string) => rows.find((r) => r.kind === 'page' && r.page.id === id)!;
    // Alpha into its own grandchild Delta: refused.
    expect(dropTarget(mirror, a.id, rowOf(d.id), 'inside')).toBeNull();
    expect(dropTarget(mirror, a.id, rowOf(a.id), 'after')).toBeNull();
    // Delta inside Gamma, and after Gamma at the top.
    expect(dropTarget(mirror, d.id, rowOf(c.id), 'inside')).toMatchObject({ parentPageId: c.id });
    expect(dropTarget(mirror, d.id, rowOf(c.id), 'after')).toMatchObject({
      parentPageId: null,
      after: c.id,
    });
    // Before Alpha: first among the top pages.
    expect(dropTarget(mirror, c.id, rowOf(a.id), 'before')).toMatchObject({
      parentPageId: null,
      after: null,
    });
  });
});
