// The views drawn in jsdom over the in-memory host: the grid's roles and counts, virtualisation,
// keyboard movement (RTL mirrored), cell edits written once on commit (and not on Escape), the
// pickers, the property menu, the filter, sort and properties editors, read-only, the row panel.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom } from './testing/dom';

installDom();
const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { DatabaseView } = await import('./DatabaseView');
const { RowProperties } = await import('./RowProperties');
const { createDatabaseI18n } = await import('./i18n');
const { seed, P } = await import('./testing/fixtures');

type Root = ReturnType<typeof createRoot>;
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

async function mount(node: ReturnType<typeof h>, language: 'en' | 'ar' = 'en') {
  const i18n = createDatabaseI18n(language);
  document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  container.setAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
  root = createRoot(container);
  await act(async () => root!.render(h(I18nextProvider, { i18n }, node)));
  await flush();
}

const grid = () => container.querySelector<HTMLElement>('[role="grid"]')!;
const active = () => document.getElementById(grid().getAttribute('aria-activedescendant')!)!;
async function key(target: Element, k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
  await flush();
}
async function mouse(target: Element, type: string) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
  });
  await flush();
}
async function type(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
  await act(async () => {
    const proto = Object.getPrototypeOf(input);
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const opsOf = (host: { applied: { type: string }[] }, kind: string) =>
  host.applied.filter((op) => op.type === kind);

function table(rows = 20, options = {}) {
  const s = seed(rows, options);
  return {
    ...s,
    view: h(DatabaseView, { host: s.host, databaseId: s.tasksId, embedded: false }),
  };
}

describe('the table', () => {
  it('is a grid with its row and column counts and a header', async () => {
    const { view, host, tasksId } = table(20);
    await mount(view);
    const g = grid();
    const columns = host.database(tasksId)!.properties.length;
    expect(g.getAttribute('aria-colcount')).toBe(String(columns));
    // Header, 20 rows and the New row.
    expect(g.getAttribute('aria-rowcount')).toBe('22');
    expect(g.querySelectorAll('[role="columnheader"]')).toHaveLength(columns);
    expect(g.querySelector('[role="columnheader"]')!.textContent).toContain('Name');
    expect(container.textContent).toContain('Rows: 20');
  });

  it('draws only the rows in the window', async () => {
    const { view } = table(10_000);
    await mount(view);
    const rows = grid().querySelectorAll('.cgw-tbody [role="row"]');
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThan(60);
    expect(grid().querySelector<HTMLElement>('.cgw-tbody')!.style.blockSize).toBe(
      `${10_001 * 34}px`,
    );
  });

  it('moves the active cell with the arrows, mirrored in RTL', async () => {
    const { view } = table(5);
    await mount(view);
    const g = grid();
    await key(g, 'ArrowDown');
    expect(active().getAttribute('aria-colindex')).toBe('1');
    await key(g, 'ArrowRight');
    expect(active().getAttribute('aria-colindex')).toBe('2');
    await key(g, 'ArrowUp', { ctrlKey: true });
    expect(active().getAttribute('role')).toBe('columnheader');
  });

  it('mirrors left and right in Arabic', async () => {
    const { view } = table(5);
    await mount(view, 'ar');
    const g = grid();
    await key(g, 'ArrowLeft');
    expect(active().getAttribute('aria-colindex')).toBe('2');
    await key(g, 'ArrowRight');
    expect(active().getAttribute('aria-colindex')).toBe('1');
    expect(container.textContent).toContain('الصفوف: 5');
  });

  it('edits a title: one page.update on Enter, nothing on Escape', async () => {
    const { view, host } = table(3);
    await mount(view);
    const g = grid();
    await key(g, 'Enter');
    let input = g.querySelector<HTMLInputElement>('.cgw-inline-editor')!;
    expect(input).toBeTruthy();
    await type(input, 'Quarter close');
    expect(opsOf(host, 'page.update')).toHaveLength(0);
    await key(input, 'Enter');
    expect(opsOf(host, 'page.update')).toHaveLength(1);
    expect(opsOf(host, 'page.update')[0]).toMatchObject({ payload: { title: 'Quarter close' } });
    expect(g.querySelector('.cgw-inline-editor')).toBeNull();
    expect(active().textContent).toContain('Quarter close');

    await key(g, 'Enter');
    input = g.querySelector<HTMLInputElement>('.cgw-inline-editor')!;
    await type(input, 'Thrown away');
    await key(input, 'Escape');
    expect(opsOf(host, 'page.update')).toHaveLength(1);
  });

  it('starts typing into a cell and Tab commits and moves on', async () => {
    const { view, host, tasksId } = table(3);
    await mount(view);
    const g = grid();
    const amountCol = host.database(tasksId)!.properties.findIndex((p) => p.id === P.amount);
    await key(g, 'ArrowDown');
    await key(g, 'Home');
    for (let i = 0; i < amountCol; i++) await key(g, 'ArrowRight');
    await key(g, '٤');
    const input = g.querySelector<HTMLInputElement>('.cgw-inline-editor')!;
    expect(input.value).toBe('٤');
    await type(input, '٤٢٫٥');
    await key(input, 'Tab');
    const update = opsOf(host, 'row.update');
    expect(update).toHaveLength(1);
    expect(update[0]).toMatchObject({ payload: { values: { [P.amount]: 42.5 } } });
    expect(active().getAttribute('aria-colindex')).toBe(String(amountCol + 2));
  });

  it('keeps an invalid number in the editor on Enter and writes nothing', async () => {
    const { view, host, tasksId } = table(2);
    await mount(view);
    const g = grid();
    const amountCol = host.database(tasksId)!.properties.findIndex((p) => p.id === P.amount);
    for (let i = 0; i < amountCol; i++) await key(g, 'ArrowRight');
    await key(g, 'Enter');
    const input = g.querySelector<HTMLInputElement>('.cgw-inline-editor')!;
    await type(input, 'abc');
    await key(input, 'Enter');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(opsOf(host, 'row.update')).toHaveLength(0);
  });

  it('toggles a checkbox with Space, one row.update each', async () => {
    const { view, host, tasksId } = table(2);
    await mount(view);
    const g = grid();
    const col = host.database(tasksId)!.properties.findIndex((p) => p.id === P.done);
    // The first row's first cell is active from the start; walk to its checkbox.
    for (let i = 0; i < col; i++) await key(g, 'ArrowRight');
    await vi.waitFor(() => expect(active().getAttribute('aria-colindex')).toBe(String(col + 1)));
    const box = () => active().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const rowOf = () => active().closest<HTMLElement>('[role="row"]')!;
    const title = rowOf().querySelector('.cgw-title-text')!.textContent;
    const rowId = host.rowsOf(tasksId).find((r) => r.title === title)!.id;
    const before = box().checked;
    await key(g, ' ');
    await vi.waitFor(() => expect(opsOf(host, 'row.update')).toHaveLength(1));
    expect(host.applied.filter((op) => op.type === 'row.update')[0].entityId).toBe(rowId);
    await vi.waitFor(() => expect(box().checked).toBe(!before));
    expect(host.rowRecords.get(rowId)!.values[P.done] === true).toBe(!before);
    await key(g, ' ');
    await vi.waitFor(() => expect(opsOf(host, 'row.update')).toHaveLength(2));
    await vi.waitFor(() => expect(box().checked).toBe(before));
  });

  it('clears a cell with Delete', async () => {
    const { view, host, tasksId } = table(2);
    await mount(view);
    const g = grid();
    const col = host.database(tasksId)!.properties.findIndex((p) => p.id === P.amount);
    for (let i = 0; i < col; i++) await key(g, 'ArrowRight');
    await key(g, 'Delete');
    expect(opsOf(host, 'row.update')[0]).toMatchObject({
      payload: { values: { [P.amount]: null } },
    });
  });

  it('picks a select option in a flyout: one row.update, and creates an option', async () => {
    const { view, host, tasksId } = table(2);
    await mount(view);
    const g = grid();
    const col = host.database(tasksId)!.properties.findIndex((p) => p.id === P.priority);
    for (let i = 0; i < col; i++) await key(g, 'ArrowRight');
    await key(g, 'Enter');
    const search = document.querySelector<HTMLInputElement>('.cgw-picker-input')!;
    expect(search).toBeTruthy();
    const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(options.join('|')).toContain('High');
    await type(search, 'Urgent');
    await key(search, 'Enter');
    expect(opsOf(host, 'db.update')).toHaveLength(1);
    const update = opsOf(host, 'row.update');
    expect(update).toHaveLength(1);
    const option = host
      .database(tasksId)!
      .properties.find((p) => p.id === P.priority)!
      .options!.find((o) => o.name === 'Urgent')!;
    expect(update[0]).toMatchObject({ payload: { values: { [P.priority]: option.id } } });
    expect(document.querySelector('.cgw-picker-input')).toBeNull();
  });

  it('chooses several tags and writes them once, when the flyout closes', async () => {
    const { view, host, tasksId } = table(2);
    await mount(view);
    const g = grid();
    const col = host.database(tasksId)!.properties.findIndex((p) => p.id === P.tags);
    for (let i = 0; i < col; i++) await key(g, 'ArrowRight');
    await key(g, 'Delete');
    const cleared = opsOf(host, 'row.update').length;
    await key(g, 'Enter');
    const search = document.querySelector<HTMLInputElement>('.cgw-picker-input')!;
    await key(search, 'Enter');
    await key(search, 'ArrowDown');
    await key(search, 'Enter');
    expect(opsOf(host, 'row.update')).toHaveLength(cleared);
    await key(search, 'Escape');
    const updates = opsOf(host, 'row.update');
    expect(updates).toHaveLength(cleared + 1);
    expect(
      (updates[updates.length - 1] as unknown as { payload: { values: Record<string, string[]> } })
        .payload.values[P.tags],
    ).toEqual(['tgFin001', 'tgOps001']);
  });

  it('is read-only without the right to edit', async () => {
    const { view, host } = table(2, { canEdit: false });
    await mount(view);
    const g = grid();
    expect(g.getAttribute('aria-readonly')).toBe('true');
    await key(g, 'Enter');
    expect(g.querySelector('.cgw-inline-editor')).toBeNull();
    expect(container.textContent).toContain('View only');
    expect(container.textContent).not.toContain('＋ New');
    expect(host.applied).toHaveLength(0);
  });

  it('adds a row from the New item and puts the caret in its title', async () => {
    const { view, host } = table(1);
    await mount(view);
    const newItem = grid().querySelector('.cgw-new-row')!;
    await mouse(newItem, 'click');
    await vi.waitFor(() => expect(opsOf(host, 'page.create')).toHaveLength(1));
    await vi.waitFor(() => expect(grid().querySelector('.cgw-inline-editor')).toBeTruthy());
    expect(grid().getAttribute('aria-rowcount')).toBe('4');
  });

  it('groups rows in collapsible sections with counts', async () => {
    const { host, tasksId, viewId } = seed(6);
    const view = host.views(tasksId)[0];
    await host.apply([
      {
        opId: 'x',
        type: 'view.upsert',
        workspaceId: view.workspaceId,
        entityId: viewId,
        baseVersion: null,
        createdAt: new Date().toISOString(),
        payload: { ...view, config: { ...view.config, group: { propertyId: P.status } } },
      },
    ]);
    await mount(h(DatabaseView, { host, databaseId: tasksId }));
    const heads = [...grid().querySelectorAll('.cgw-trow-group')];
    // "No Status" and the three options.
    expect(heads).toHaveLength(4);
    expect(heads[1].textContent).toContain('Not started');
    const before = grid().querySelectorAll('.cgw-tbody [role="row"]').length;
    await mouse(heads[1].querySelector('.cgw-group-toggle')!, 'click');
    expect(grid().querySelectorAll('.cgw-tbody [role="row"]').length).toBeLessThan(before);
  });
});

describe('the toolbar and menus', () => {
  it('opens the property menu from a header and renames the property', async () => {
    const { view, host } = table(2);
    await mount(view);
    const header = grid().querySelectorAll('[role="columnheader"]')[1];
    await act(async () => {
      header.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }),
      );
      header.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }),
      );
    });
    await flush();
    const name = document.querySelector<HTMLInputElement>('[aria-label="Property name"]')!;
    expect(name.value).toBe('Status');
    await type(name, 'State');
    await key(name, 'Enter');
    const update = opsOf(host, 'db.update');
    expect(update).toHaveLength(1);
    expect(JSON.stringify(update[0])).toContain('"State"');
  });

  it('adds a filter through the filter editor: one view.upsert', async () => {
    const { view, host } = table(5);
    await mount(view);
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Filter',
    )!;
    await mouse(button, 'click');
    const add = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Add a filter',
    )!;
    await mouse(add, 'click');
    expect(opsOf(host, 'view.upsert')).toHaveLength(1);
    expect(container.textContent).toContain('Filters: 1');
  });

  it('sorts from the sort editor', async () => {
    const { view, host, tasksId } = table(5);
    await mount(view);
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Sort')!;
    await mouse(button, 'click');
    const add = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Add a sort',
    )!;
    await mouse(add, 'click');
    expect(host.views(tasksId)[0].config.sorts).toHaveLength(1);
  });

  it('hides a property and lists deleted properties to restore', async () => {
    const { view, host, tasksId } = table(2);
    const db = host.database(tasksId)!;
    const notes = db.properties.find((p) => p.id === P.notes)!;
    await host.apply([
      {
        opId: 'y',
        type: 'db.update',
        workspaceId: db.workspaceId,
        entityId: tasksId,
        baseVersion: null,
        createdAt: new Date().toISOString(),
        payload: { properties: [{ ...notes, trashedAt: '2026-11-12T00:00:00Z' }] },
      },
    ]);
    await mount(view);
    expect(grid().querySelectorAll('[role="columnheader"]')).toHaveLength(db.properties.length - 1);
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Properties',
    )!;
    await mouse(button, 'click');
    const restore = document.querySelector<HTMLElement>('[aria-label="Restore Notes"]')!;
    expect(restore).toBeTruthy();
    await mouse(restore, 'click');
    expect(host.database(tasksId)!.properties.find((p) => p.id === P.notes)!.trashedAt).toBeNull();
  });

  it('adds a view of another type, shown as not ready yet', async () => {
    const { view, host, tasksId } = table(2);
    await mount(view);
    const add = container.querySelector<HTMLElement>('[aria-label="Add a view"]')!;
    await mouse(add, 'click');
    const board = [...document.querySelectorAll('[role="menuitem"]')].find((b) =>
      b.textContent?.includes('Board'),
    )!;
    await mouse(board, 'click');
    expect(host.views(tasksId)).toHaveLength(2);
    expect(host.views(tasksId)[1]).toMatchObject({ type: 'board', name: 'Board' });
  });
});

describe('a row page', () => {
  it('shows and edits the row properties', async () => {
    const { host, tasksId } = seed(2);
    const row = host.rowsOf(tasksId)[0];
    await mount(h(RowProperties, { host, rowId: row.id }));
    const names = [...container.querySelectorAll('.cgw-row-prop-name [dir="auto"]')].map(
      (n) => n.textContent,
    );
    expect(names).toContain('Status');
    expect(names).not.toContain('Name');
    const notes = [...container.querySelectorAll<HTMLElement>('.cgw-row-prop-value')].find(
      (v) => v.getAttribute('aria-label') === 'Edit Notes',
    )!;
    await key(notes, 'Enter');
    const input = notes.querySelector<HTMLTextAreaElement>('textarea')!;
    await type(input, 'Checked with finance');
    await key(input, 'Enter');
    expect(opsOf(host, 'row.update')).toHaveLength(1);
    expect(host.rowRecords.get(row.id)!.values[P.notes]).toBe('Checked with finance');
  });
});
