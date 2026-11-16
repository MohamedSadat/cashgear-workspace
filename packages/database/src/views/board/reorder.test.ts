// Board columns and gallery cards put in a new order (Phase 8, M8.3), drawn in jsdom over the
// in-memory host: by the keys (Space picks up, the arrows move, mirrored in RTL, Space drops,
// Escape cancels) and by the pointer (boxes stood in for jsdom's missing layout). A column's order
// is the view's (`group.order`, one view.upsert); a card's is the row's own (one page.move).
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDom } from '../../testing/dom';

installDom();
const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { newOp } = await import('@cgw/workspace');
const { DatabaseView } = await import('../../DatabaseView');
const { createDatabaseI18n } = await import('../../i18n');
const { seed } = await import('../../testing/fixtures');
const { VIEW_TYPES } = await import('../registry');
const { galleryDropIndex, galleryLayout, galleryColumns, cardWidth } =
  await import('../gallery/layout');
const { movedOrder, orderedGroups } = await import('./layout');

type Root = ReturnType<typeof createRoot>;
let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  // jsdom scrolls nothing.
  HTMLElement.prototype.scrollBy ??= function scrollBy() {};
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  document.documentElement.dir = 'ltr';
});
afterAll(() => (window as unknown as { close(): void }).close());

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const frame = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });

async function mount(node: ReturnType<typeof h>, language: 'en' | 'ar' = 'en') {
  const i18n = createDatabaseI18n(language);
  document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  container.setAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
  root = createRoot(container);
  await act(async () => root!.render(h(I18nextProvider, { i18n }, node)));
  await flush();
}
async function key(target: Element, k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
  await flush();
}
async function pointer(target: EventTarget, type: string, x: number, y: number) {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 7,
        clientX: x,
        clientY: y,
      }),
    );
  });
  await frame();
  await flush();
}
/** A box for an element jsdom lays out nowhere. */
function place(el: Element, left: number, top: number, width: number, height: number) {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON() {},
    }) as DOMRect;
}

async function viewOf(type: 'board' | 'gallery', rows: number, config = {}) {
  const s = seed(rows, { today: '2026-11-13' });
  const database = s.host.database(s.tasksId)!;
  const base = s.host.views(s.tasksId)[0];
  const id = s.host.newId();
  await s.host.apply([
    newOp('view.upsert', base.workspaceId, id, {
      ...base,
      id,
      name: type,
      type,
      orderKey: 'a1',
      config: { ...VIEW_TYPES[type].defaultConfig(database), ...config },
    }),
  ]);
  s.host.applied.length = 0;
  return {
    ...s,
    viewId: id,
    view: h(DatabaseView, { host: s.host, databaseId: s.tasksId, viewId: id }),
  };
}
const ops = (host: { applied: { type: string }[] }, kind: string) =>
  host.applied.filter((op) => op.type === kind);
/** The board's columns (`CgKanbanBoard`'s sections) and their grips. */
const sections = () => [
  ...container.querySelectorAll<HTMLElement>('section[data-cg-kanban-column]'),
];
const columnKeys = () => sections().map((c) => c.dataset.cgKanbanColumn);
const grip = (group: string) =>
  container.querySelector<HTMLElement>(`[data-cg-kanban-column-grip="${group}"]`)!;
/** The line among the columns where a moved column would land, while it shows. */
const columnLine = () =>
  container.querySelector('[data-cg-kanban-board] [data-cg-drop-indicator]:not([hidden])');

describe('the column order arithmetic', () => {
  it('puts the named keys first, in order, then the rest as they came', () => {
    const groups = ['', 'a', 'b', 'c'].map((key) => ({ key }));
    expect(orderedGroups(groups, ['c', 'a']).map((g) => g.key)).toEqual(['c', 'a', '', 'b']);
    expect(orderedGroups(groups, undefined)).toBe(groups);
    expect(movedOrder(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
  });
});

describe('a board column moved', () => {
  it('by the keys: one view.upsert of the order, the columns drawn in it', async () => {
    const { view, host, viewId, tasksId } = await viewOf('board', 12);
    await mount(view);
    expect(columnKeys()).toEqual(['', 'stTodo01', 'stDoing1', 'stDone01']);
    const handle = grip('stTodo01');
    expect(handle.getAttribute('aria-label')).toBe('Move the column Not started');
    handle.focus();
    await key(handle, ' ');
    await key(handle, 'ArrowRight');
    await key(handle, 'ArrowRight');
    await key(handle, ' ');
    const upserts = ops(host, 'view.upsert');
    expect(upserts).toHaveLength(1);
    expect(host.views(tasksId).find((v) => v.id === viewId)!.config.group!.order).toEqual([
      '',
      'stDoing1',
      'stDone01',
      'stTodo01',
    ]);
    expect(columnKeys()).toEqual(['', 'stDoing1', 'stDone01', 'stTodo01']);
    // The rows keep their status: only the view changed.
    expect(ops(host, 'row.update')).toHaveLength(0);
  });

  it('mirrors the arrows in Arabic, and Escape cancels', async () => {
    const { view, host } = await viewOf('board', 6);
    await mount(view, 'ar');
    const handle = grip('stDone01');
    handle.focus();
    await key(handle, ' ');
    await key(handle, 'ArrowRight');
    await key(handle, 'Escape');
    expect(host.applied).toHaveLength(0);
    await key(handle, ' ');
    // In RTL the earlier column is to the right.
    await key(handle, 'ArrowRight');
    await key(handle, 'Enter');
    expect(columnKeys()).toEqual(['', 'stTodo01', 'stDone01', 'stDoing1']);
  });

  it('by the pointer: dragged by its header to between two others', async () => {
    const { view } = await viewOf('board', 6);
    await mount(view);
    const scroller = container.querySelector('[data-cg-kanban-board] > [role="region"]')!;
    place(scroller, 0, 0, 2000, 800);
    sections().forEach((c, i) => place(c, 10 + i * 284, 0, 272, 600));
    // Its name in the header, not a control: a press there drags the column.
    const head = container.querySelector('[data-cg-kanban-column-head=""] [dir="auto"]')!;
    await pointer(head, 'pointerdown', 100, 20);
    await pointer(window, 'pointermove', 130, 22);
    // Past the middle of the third column (10 + 2 * 284 + 136 = 714).
    await pointer(window, 'pointermove', 740, 24);
    expect(columnLine()).toBeTruthy();
    await pointer(window, 'pointerup', 740, 24);
    expect(columnKeys()).toEqual(['stTodo01', 'stDoing1', '', 'stDone01']);
    expect(columnLine()).toBeNull();
  });

  it('cannot be moved without the right to edit', async () => {
    const s = await viewOf('board', 4);
    s.host.setCanEdit(false);
    await mount(s.view);
    expect(container.querySelector('[data-cg-kanban-column-grip]')).toBeNull();
  });
});

describe('a gallery card moved', () => {
  const cards = () =>
    [...container.querySelectorAll<HTMLElement>('.cgw-gallery-grid [data-card]')].map(
      (c) => c.dataset.rowId,
    );
  const order = (
    host: { rowRecords: Map<string, { orderKey: string; id: string }> },
    ids: string[],
  ) =>
    [...ids].sort((a, b) => {
      const x = host.rowRecords.get(a)!;
      const y = host.rowRecords.get(b)!;
      return x.orderKey < y.orderKey ? -1 : x.orderKey > y.orderKey ? 1 : x.id < y.id ? -1 : 1;
    });

  it('by the keys: one page.move to its new place, said aloud', async () => {
    const { view, host } = await viewOf('gallery', 6);
    await mount(view);
    const before = cards() as string[];
    const first = container.querySelector<HTMLElement>('.cgw-gallery-grid [data-card]')!;
    expect(first.getAttribute('aria-description')).toBe('Space picks the card up, Enter opens it.');
    first.focus();
    await key(first, ' ');
    expect(first.hasAttribute('data-cg-dragging')).toBe(true);
    await key(first, 'ArrowRight');
    await key(first, 'ArrowRight');
    await key(first, ' ');
    expect(host.applied.map((op) => op.type)).toEqual(['page.move']);
    expect(order(host, before)).toEqual([before[1], before[2], before[0], ...before.slice(3)]);
    expect(host.opened).toHaveLength(0);
  });

  it('by the pointer: dropped on the second half of a card goes after it', async () => {
    const { view, host } = await viewOf('gallery', 7);
    await mount(view);
    const before = cards() as string[];
    const grid = container.querySelector('.cgw-gallery-grid')!;
    place(container.querySelector('.cgw-gallery-scroll')!, 0, 0, 960, 600);
    place(grid, 12, 12, 936, 900);
    const cols = galleryColumns(960, 'medium');
    const width = cardWidth(960, cols);
    const tile = container.querySelectorAll<HTMLElement>('.cgw-gallery-grid [data-card]')[cols];
    const down = parseFloat(tile.style.insetBlockStart) + 10;
    // An empty gallery takes a drop at the start.
    expect(galleryDropIndex(galleryLayout([], [], cols, 0, false), 0, cols, width, 0, 0)).toBe(0);
    // The first card of the second row, on its second half.
    const first = container.querySelector<HTMLElement>('.cgw-gallery-grid [data-card]')!;
    await pointer(first, 'pointerdown', 40, 40);
    await pointer(window, 'pointermove', 60, 60);
    await pointer(window, 'pointermove', 12 + width - 20, 12 + down);
    expect(
      container.querySelector(
        '.cgw-gallery-grid > [data-cg-drop-indicator][data-orientation="vertical"]:not([hidden])',
      ),
    ).toBeTruthy();
    await pointer(window, 'pointerup', 12 + width - 20, 12 + down);
    expect(host.applied.map((op) => op.type)).toEqual(['page.move']);
    const expected = before.filter((id) => id !== before[0]);
    expected.splice(cols, 0, before[0]);
    expect(order(host, before)).toEqual(expected);
  });

  it('stays in the sort’s order when the view is sorted', async () => {
    const { view, host } = await viewOf('gallery', 4, {
      sorts: [{ propertyId: 'title', direction: 'asc' }],
    });
    await mount(view);
    expect(container.textContent).toContain('Sorted: cards keep the sort’s order');
    const first = container.querySelector<HTMLElement>('.cgw-gallery-grid [data-card]')!;
    expect(first.hasAttribute('aria-description')).toBe(false);
    first.focus();
    await key(first, ' ');
    expect(first.hasAttribute('data-cg-dragging')).toBe(false);
    expect(host.applied).toHaveLength(0);
  });
});
