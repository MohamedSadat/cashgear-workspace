// The board, list, calendar and gallery drawn in jsdom over the in-memory host: columns and cards,
// keyboard moves that write one `row.update` (RTL mirrored), new cards preset to their column,
// virtualised columns and lists, the calendar's month and its moves, the gallery's cards, and the
// layout settings and the row-template menu in the toolbar.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDom } from '../../testing/dom';

installDom();
const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { newOp } = await import('@cgw/workspace');
const { DatabaseView } = await import('../../DatabaseView');
const { createDatabaseI18n } = await import('../../i18n');
const { seed, P } = await import('../../testing/fixtures');
const { VIEW_TYPES } = await import('../registry');

type Root = ReturnType<typeof createRoot>;
type ViewType = 'board' | 'list' | 'calendar' | 'gallery';
let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
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
async function click(target: Element) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
  await flush();
}
async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** A seeded Tasks database shown as a view of `type` (its default configuration, then `config`). */
async function viewOf(
  type: ViewType,
  rows: number,
  config: Record<string, unknown> = {},
  options: { pageSize?: number } = {},
) {
  const s = seed(rows, { today: '2026-11-13', ...options });
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
  return { ...s, view: h(DatabaseView, { host: s.host, databaseId: s.tasksId, viewId: id }) };
}
const ops = (host: { applied: { type: string }[] }, kind: string) =>
  host.applied.filter((op) => op.type === kind);
/** A board's column (`CgKanbanBoard`'s section) by its group key, and its cards' boxes. */
const columnOf = (key: string) =>
  container.querySelector<HTMLElement>(`section[data-cg-kanban-column="${key}"]`)!;
const firstCard = (key: string) =>
  columnOf(key).querySelector<HTMLElement>('[data-cg-kanban-card]')!;
const rowIdOf = (card: HTMLElement) =>
  card.querySelector<HTMLElement>('[data-row-id]')!.dataset.rowId!;

describe('the board', () => {
  it('draws a column per status with its count, and the cards', async () => {
    const { view, host, tasksId } = await viewOf('board', 30);
    await mount(view);
    const columns = [...container.querySelectorAll<HTMLElement>('section[data-cg-kanban-column]')];
    expect(columns.map((c) => c.dataset.cgKanbanColumn)).toEqual([
      '',
      'stTodo01',
      'stDoing1',
      'stDone01',
    ]);
    const counts = new Map<string, number>();
    for (const r of host.rowsOf(tasksId))
      counts.set(r.values[P.status] as string, (counts.get(r.values[P.status] as string) ?? 0) + 1);
    expect(columns[1].querySelectorAll('[data-cg-kanban-card]').length).toBe(
      counts.get('stTodo01'),
    );
    expect(columns[1].getAttribute('aria-label')).toContain(`Cards: ${counts.get('stTodo01')}`);
    expect(columns[0].textContent).toContain('No cards');
    // One card is in the tab order.
    expect(container.querySelectorAll('[data-cg-kanban-card][tabindex="0"]').length).toBe(1);
  });

  it('moves a card to the next column by keyboard: one row.update of its status', async () => {
    const { view, host } = await viewOf('board', 12);
    await mount(view);
    const card = firstCard('stTodo01');
    const rowId = rowIdOf(card);
    card.focus();
    await key(card, ' ');
    expect(card.hasAttribute('data-cg-picked')).toBe(true);
    await key(card, 'ArrowRight');
    await key(card, ' ');
    const updates = ops(host, 'row.update');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      entityId: rowId,
      payload: { values: { [P.status]: 'stDoing1' } },
    });
    expect(host.rowRecords.get(rowId)!.values[P.status]).toBe('stDoing1');
  });

  it('mirrors the arrows in Arabic: left is the next column', async () => {
    const { view, host } = await viewOf('board', 12);
    await mount(view, 'ar');
    const card = firstCard('stTodo01');
    card.focus();
    await key(card, ' ');
    await key(card, 'ArrowLeft');
    await key(card, 'Enter');
    expect(ops(host, 'row.update')[0]).toMatchObject({
      payload: { values: { [P.status]: 'stDoing1' } },
    });
  });

  it('reorders within a column with one page.move, and Escape cancels', async () => {
    const { view, host } = await viewOf('board', 20);
    await mount(view);
    const first = firstCard('stTodo01');
    first.focus();
    await key(first, ' ');
    await key(first, 'Escape');
    expect(host.applied).toHaveLength(0);
    await key(first, ' ');
    await key(first, 'ArrowDown');
    await key(first, 'ArrowDown');
    await key(first, ' ');
    expect(host.applied.map((op) => op.type)).toEqual(['page.move']);
  });

  it('makes a new card preset to its column on Enter, and nothing on Escape', async () => {
    const { view, host } = await viewOf('board', 4);
    await mount(view);
    const done = columnOf('stDone01');
    await click(done.querySelector('.cgw-board-new')!);
    let input = done.querySelector<HTMLInputElement>('.cgw-inline-editor')!;
    await key(input, 'Escape');
    expect(host.applied).toHaveLength(0);
    await click(done.querySelector('.cgw-board-new')!);
    input = done.querySelector<HTMLInputElement>('.cgw-inline-editor')!;
    await type(input, 'Close the books');
    await key(input, 'Enter');
    const created = ops(host, 'page.create');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      payload: { title: 'Close the books', row: { values: { [P.status]: 'stDone01' } } },
    });
  });

  it('draws only the cards in the window of a long column', async () => {
    const { view } = await viewOf('board', 3000);
    await mount(view);
    const drawn = container.querySelectorAll('[data-cg-kanban-card]').length;
    expect(drawn).toBeGreaterThan(10);
    expect(drawn).toBeLessThan(200);
  });

  it('asks for the next page of a column whose last card is in view, until it has them all', async () => {
    const { view, host, tasksId } = await viewOf('board', 24, {}, { pageSize: 2 });
    await mount(view);
    await flush();
    const counts = new Map<string, number>();
    for (const r of host.rowsOf(tasksId)) {
      const key = (r.values[P.status] as string | undefined) ?? '';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts)
      expect(columnOf(key).querySelectorAll('[data-cg-kanban-card]').length).toBe(count);
    expect(container.textContent).not.toContain('Load more');
  });

  it('loads more of a long column from its foot', async () => {
    const { view } = await viewOf('board', 3000, {}, { pageSize: 100 });
    await mount(view);
    const todo = columnOf('stTodo01');
    const more = [...todo.querySelectorAll('button')].find((b) => b.textContent === 'Load more')!;
    expect(todo.querySelector('[data-cg-kanban-card][aria-setsize="100"]')).toBeTruthy();
    await click(more);
    expect(todo.querySelector('[data-cg-kanban-card][aria-setsize="200"]')).toBeTruthy();
  });

  it('asks for a group property when the board has none', async () => {
    const { view, host } = await viewOf('board', 3, { group: null });
    await mount(view);
    const select = container.querySelector<HTMLSelectElement>('.cgw-view-setup select')!;
    expect(select).toBeTruthy();
    await act(async () => {
      select.value = P.priority;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(ops(host, 'view.upsert')[0]).toMatchObject({
      payload: { config: { group: { propertyId: P.priority } } },
    });
  });
});

describe('the list', () => {
  it('draws a line per row with its shown properties, virtualised, and Enter opens one', async () => {
    const { view, host } = await viewOf('list', 2000);
    await mount(view);
    const lines = container.querySelectorAll<HTMLElement>('.cgw-db-list-row');
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.length).toBeLessThan(80);
    lines[0].focus();
    await key(lines[0], 'ArrowDown');
    expect(document.activeElement).toBe(container.querySelectorAll('.cgw-db-list-row')[1]);
    await key(document.activeElement!, 'Enter');
    expect(host.opened.at(-1)?.kind).toBe('row');
  });

  it('shows groups with counts that collapse', async () => {
    const { view } = await viewOf('list', 8, { group: { propertyId: P.status } });
    await mount(view);
    const headers = container.querySelectorAll<HTMLButtonElement>('.cgw-db-list-group-button');
    expect(headers.length).toBe(4);
    const before = container.querySelectorAll('.cgw-db-list-row').length;
    await click(headers[1]);
    expect(headers[1].getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('.cgw-db-list-row').length).toBeLessThan(before);
  });
});

describe('the calendar', () => {
  /** `CgMonthCalendar`'s month heading, and its rows' bars (by row id). */
  const heading = () => container.querySelector('[data-cg-month-calendar] [aria-live]')!;
  const bars = () => [...container.querySelectorAll<HTMLElement>('[data-cg-month-item]')];

  it("shows today's month from the week's first day, and the rows on their days", async () => {
    const { view, host, tasksId } = await viewOf('calendar', 200);
    await mount(view);
    expect(heading().textContent).toBe('November 2026');
    const headers = [...container.querySelectorAll('[role="columnheader"]')].map(
      (c) => c.textContent,
    );
    expect(headers[0]).toBe('Sun');
    // The grid runs from Sunday 1 November to Saturday 5 December.
    const shown = host.rowsOf(tasksId).filter((r) => {
      const start = (r.values[P.due] as { start: string } | undefined)?.start ?? '';
      return start >= '2026-11-01' && start <= '2026-12-05';
    });
    const placed = new Set(bars().map((e) => e.dataset.cgMonthItem));
    const hidden = [...container.querySelectorAll('[role="gridcell"] [aria-haspopup="dialog"]')]
      .length;
    expect(placed.size + hidden).toBeGreaterThan(0);
    for (const id of placed) expect(shown.some((r) => r.id === id)).toBe(true);
    const undated = host.rowsOf(tasksId).filter((r) => !r.values[P.due]).length;
    expect(container.querySelector('.cgw-cal-undated-toggle')!.textContent).toBe(
      `No date: ${undated}`,
    );
  });

  // Axe: a row's children are its cells (the rows drawn over a week are a cell of its own after
  // the days, named by the rows it shows), and the "No date" toggle names its list only while the
  // list is there.
  it("draws a week's rows in a cell of the week, and names the undated list only when open", async () => {
    const { view } = await viewOf('calendar', 200);
    await mount(view);
    const items = bars();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const cell = item.parentElement!.closest('[role]')!;
      expect(cell.getAttribute('role')).toBe('gridcell');
      // Named by the rows it shows (an `aria-label` would have to hold their titles).
      expect(cell.hasAttribute('aria-label')).toBe(false);
      expect(cell.parentElement!.getAttribute('role')).toBe('row');
    }
    const weeks = [...container.querySelectorAll('[role="grid"] > [role="row"]')].slice(1);
    expect(weeks.length).toBeGreaterThanOrEqual(4);
    for (const row of weeks)
      for (const child of row.children) expect(child.getAttribute('role')).toBe('gridcell');
    const toggle = container.querySelector<HTMLElement>('.cgw-cal-undated-toggle')!;
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    await act(async () => toggle.click());
    const list = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(list?.classList.contains('cgw-cal-undated')).toBe(true);
  });

  it('starts the week on Saturday in Arabic', async () => {
    const { view } = await viewOf('calendar', 5);
    await mount(view, 'ar');
    const first = container.querySelector('[role="columnheader"]')!.getAttribute('aria-label');
    expect(first).toBe(
      new Intl.DateTimeFormat('ar', { weekday: 'long', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2026, 9, 31)),
      ),
    );
  });

  it('moves a row a day on with Alt and the arrow, keeping it a date: one row.update', async () => {
    const { view, host } = await viewOf('calendar', 300);
    await mount(view);
    const item = bars()[0];
    const rowId = item.dataset.cgMonthItem!;
    const before = host.rowRecords.get(rowId)!.values[P.due] as { start: string };
    item.focus();
    await key(item, 'ArrowRight', { altKey: true });
    const updates = ops(host, 'row.update');
    expect(updates).toHaveLength(1);
    const next = new Date(Date.parse(`${before.start}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(updates[0]).toMatchObject({
      entityId: rowId,
      payload: { values: { [P.due]: { start: next } } },
    });
  });

  it('turns the page and comes back to today', async () => {
    const { view } = await viewOf('calendar', 5);
    await mount(view);
    await click(container.querySelector('[aria-label="Next month"]')!);
    expect(heading().textContent).toBe('December 2026');
    await click(
      [...container.querySelectorAll('[data-cg-month-calendar] button')].find(
        (b) => b.textContent === 'Today',
      )!,
    );
    expect(heading().textContent).toBe('November 2026');
    await frame();
  });

  it('drops a row with no date on the day under the pointer, marking the day on the way', async () => {
    const { view, host } = await viewOf('calendar', 60);
    await mount(view);
    await act(async () => container.querySelector<HTMLElement>('.cgw-cal-undated-toggle')!.click());
    // jsdom lays nothing out: the days get boxes of 100 by 80, seven to a row.
    const box = (left: number, top: number, width: number, height: number) =>
      ({
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        x: left,
        y: top,
      }) as DOMRect;
    const days = [...container.querySelectorAll<HTMLElement>('[data-cg-month-day]')];
    days.forEach(
      (d, i) =>
        (d.getBoundingClientRect = () => box((i % 7) * 100, 100 + Math.floor(i / 7) * 80, 100, 80)),
    );
    const scroller = container.querySelector<HTMLElement>('[role="grid"]')!.parentElement!;
    scroller.getBoundingClientRect = () => box(0, 100, 700, 600);
    const target = days.find((d) => d.getAttribute('aria-label')?.includes('18'))!;
    const index = days.indexOf(target);
    const x = (index % 7) * 100 + 50;
    const y = 100 + Math.floor(index / 7) * 80 + 40;
    const item = container.querySelector<HTMLElement>('.cgw-cal-undated [data-cal-drag]')!;
    const pointer = async (el: EventTarget, type: string, px: number, py: number) =>
      act(async () => {
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 3,
            clientX: px,
            clientY: py,
          }),
        );
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      });
    await pointer(item, 'pointerdown', 900, 120);
    await pointer(window, 'pointermove', 880, 130);
    await pointer(window, 'pointermove', x, y);
    expect(target.hasAttribute('data-drop')).toBe(true);
    await pointer(window, 'pointerup', x, y);
    expect(target.hasAttribute('data-drop')).toBe(false);
    const day = Number(target.dataset.cgMonthDay);
    expect(ops(host, 'row.update')[0]).toMatchObject({
      payload: {
        values: { [P.due]: { start: new Date(day * 86_400_000).toISOString().slice(0, 10) } },
      },
    });
  });

  it('places a row with no date on the selected day, and the toolbar’s New makes one there', async () => {
    const { view, host, tasksId } = await viewOf('calendar', 60);
    await mount(view);
    // Today, 13 November, is selected; the arrow selects the 14th.
    const selected = () =>
      container.querySelector<HTMLElement>('[role="gridcell"][aria-selected="true"]')!;
    selected().focus();
    await key(selected(), 'ArrowRight');
    await act(async () => container.querySelector<HTMLElement>('.cgw-cal-undated-toggle')!.click());
    const undated = host.rowsOf(tasksId).filter((r) => !r.values[P.due]);
    expect(undated.length).toBeGreaterThan(0);
    const place = container.querySelector<HTMLElement>(
      '.cgw-cal-undated [aria-label^="Place on"]',
    )!;
    await click(place);
    expect(ops(host, 'row.update')[0]).toMatchObject({
      payload: { values: { [P.due]: { start: '2026-11-14' } } },
    });
    const newButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'New',
    )!;
    await click(newButton);
    await frame();
    await flush();
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] .cgw-inline-editor')!;
    expect(input).toBeTruthy();
    await type(input, 'Plan the week');
    await key(input, 'Enter');
    expect(ops(host, 'page.create')[0]).toMatchObject({
      payload: { title: 'Plan the week', row: { values: { [P.due]: { start: '2026-11-14' } } } },
    });
  });

  it('asks for a date property when it has none', async () => {
    const { view } = await viewOf('calendar', 3, { calendarBy: null });
    await mount(view);
    expect(container.querySelector('.cgw-view-setup')!.textContent).toContain('Choose one');
  });
});

describe('the gallery', () => {
  it('draws cards in rows with a New tile, and Enter opens a card', async () => {
    const { view, host } = await viewOf('gallery', 9);
    await mount(view);
    const cards = container.querySelectorAll<HTMLElement>('.cgw-gallery-grid [data-card]');
    expect(cards.length).toBe(9);
    expect(container.querySelector('.cgw-gallery-new')).toBeTruthy();
    expect(cards[0].querySelector('.cgw-gallery-cover')).toBeTruthy();
    cards[0].focus();
    await key(cards[0], 'ArrowRight');
    await key(document.activeElement!, 'Enter');
    expect(host.opened.at(-1)).toEqual({ kind: 'row', id: cards[1].dataset.rowId });
  });

  it('has no picture area with no cover', async () => {
    const { view } = await viewOf('gallery', 3, { cover: { kind: 'none' } });
    await mount(view);
    expect(container.querySelector('.cgw-gallery-cover')).toBeNull();
  });
});

describe('the toolbar for these views', () => {
  it('offers Layout for the calendar and the gallery, not for the board', async () => {
    const board = await viewOf('board', 2);
    await mount(board.view);
    const names = () =>
      [...container.querySelectorAll('.cgw-db-toolbar button')].map((b) => b.textContent);
    expect(names()).not.toContain('Layout');
    await act(async () => root?.unmount());
    root = null;
    const gallery = await viewOf('gallery', 2);
    await mount(gallery.view);
    expect(names()).toContain('Layout');
  });

  it('always offers the template menu to an editor', async () => {
    const { view } = await viewOf('board', 2);
    await mount(view);
    expect(container.querySelector('[aria-label="New from a template"]')).toBeTruthy();
  });
});
