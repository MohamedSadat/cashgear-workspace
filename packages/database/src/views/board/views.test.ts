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
async function viewOf(type: ViewType, rows: number, config: Record<string, unknown> = {}) {
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
  return { ...s, view: h(DatabaseView, { host: s.host, databaseId: s.tasksId, viewId: id }) };
}
const ops = (host: { applied: { type: string }[] }, kind: string) =>
  host.applied.filter((op) => op.type === kind);

describe('the board', () => {
  it('draws a column per status with its count, and the cards', async () => {
    const { view, host, tasksId } = await viewOf('board', 30);
    await mount(view);
    const columns = [...container.querySelectorAll<HTMLElement>('.cgw-board-column')];
    expect(columns.map((c) => c.dataset.group)).toEqual(['', 'stTodo01', 'stDoing1', 'stDone01']);
    const counts = new Map<string, number>();
    for (const r of host.rowsOf(tasksId))
      counts.set(r.values[P.status] as string, (counts.get(r.values[P.status] as string) ?? 0) + 1);
    expect(columns[1].querySelectorAll('[data-card]').length).toBe(counts.get('stTodo01'));
    expect(columns[1].getAttribute('aria-label')).toContain(`Cards: ${counts.get('stTodo01')}`);
    expect(columns[0].textContent).toContain('No cards');
    // One card is in the tab order.
    expect(container.querySelectorAll('[data-card][tabindex="0"]').length).toBe(1);
  });

  it('moves a card to the next column by keyboard: one row.update of its status', async () => {
    const { view, host } = await viewOf('board', 12);
    await mount(view);
    const card = container.querySelector<HTMLElement>('[data-group="stTodo01"] [data-card]')!;
    const rowId = card.dataset.rowId!;
    card.focus();
    await key(card, ' ');
    expect(card.hasAttribute('data-dragging')).toBe(true);
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
    const card = container.querySelector<HTMLElement>('[data-group="stTodo01"] [data-card]')!;
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
    const first = container.querySelector<HTMLElement>('[data-group="stTodo01"] [data-card]')!;
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
    const done = container.querySelector<HTMLElement>('[data-group="stDone01"]')!;
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
    const drawn = container.querySelectorAll('[data-card]').length;
    expect(drawn).toBeGreaterThan(10);
    expect(drawn).toBeLessThan(200);
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
    const lines = container.querySelectorAll<HTMLElement>('.cgw-list-row');
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.length).toBeLessThan(80);
    lines[0].focus();
    await key(lines[0], 'ArrowDown');
    expect(document.activeElement).toBe(container.querySelectorAll('.cgw-list-row')[1]);
    await key(document.activeElement!, 'Enter');
    expect(host.opened.at(-1)?.kind).toBe('row');
  });

  it('shows groups with counts that collapse', async () => {
    const { view } = await viewOf('list', 8, { group: { propertyId: P.status } });
    await mount(view);
    const headers = container.querySelectorAll<HTMLButtonElement>('.cgw-list-group-button');
    expect(headers.length).toBe(4);
    const before = container.querySelectorAll('.cgw-list-row').length;
    await click(headers[1]);
    expect(headers[1].getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('.cgw-list-row').length).toBeLessThan(before);
  });
});

describe('the calendar', () => {
  it("shows today's month from the week's first day, and the rows on their days", async () => {
    const { view, host, tasksId } = await viewOf('calendar', 200);
    await mount(view);
    expect(container.querySelector('.cgw-cal-month')!.textContent).toBe('November 2026');
    const headers = [...container.querySelectorAll('[role="columnheader"]')].map(
      (c) => c.textContent,
    );
    expect(headers[0]).toBe('Sun');
    // The grid runs from Sunday 1 November to Saturday 5 December.
    const shown = host.rowsOf(tasksId).filter((r) => {
      const start = (r.values[P.due] as { start: string } | undefined)?.start ?? '';
      return start >= '2026-11-01' && start <= '2026-12-05';
    });
    const placed = new Set(
      [...container.querySelectorAll<HTMLElement>('[data-cal-item]')].map((e) => e.dataset.rowId),
    );
    const hidden = [...container.querySelectorAll('.cgw-cal-more')].length;
    expect(placed.size + hidden).toBeGreaterThan(0);
    for (const id of placed) expect(shown.some((r) => r.id === id)).toBe(true);
    const undated = host.rowsOf(tasksId).filter((r) => !r.values[P.due]).length;
    expect(container.querySelector('.cgw-cal-undated-toggle')!.textContent).toBe(
      `No date: ${undated}`,
    );
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
    const item = container.querySelector<HTMLElement>('[data-cal-item]')!;
    const rowId = item.dataset.rowId!;
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
    expect(container.querySelector('.cgw-cal-month')!.textContent).toBe('December 2026');
    await click(
      [...container.querySelectorAll('.cgw-cal-head button')].find(
        (b) => b.textContent === 'Today',
      )!,
    );
    expect(container.querySelector('.cgw-cal-month')!.textContent).toBe('November 2026');
    await frame();
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
