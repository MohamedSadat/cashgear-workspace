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
const { seed, P, PEOPLE } = await import('./testing/fixtures');

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
    // The header and 20 rows (the New line is no row of the grid: Phase 12).
    expect(g.getAttribute('aria-rowcount')).toBe('21');
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
    const search = document.querySelector<HTMLInputElement>(
      '[data-cg-option-picker] [role="combobox"]',
    )!;
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
    expect(document.querySelector('[data-cg-option-picker]')).toBeNull();
  });

  it('finds an option as every search does: ta marbuta, alef maqsura, Arabic-Indic digits', async () => {
    const { OptionPicker } = await import('./pickers/OptionPicker');
    const def = {
      id: 'pSchool1',
      name: 'Place',
      type: 'select' as const,
      options: [
        { id: 'oSchool1', name: 'مدرسة', colour: 'blue' as const },
        { id: 'oHosp001', name: 'مستشفى', colour: 'red' as const },
        { id: 'oYear001', name: 'Plan 2026', colour: 'green' as const },
      ],
    };
    const onDefChange = vi.fn();
    await mount(
      h(OptionPicker, {
        def,
        selected: [],
        multiple: false,
        canManage: true,
        onSelect: vi.fn(),
        onDefChange,
      }),
      'ar',
    );
    const search = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
    const listed = () =>
      [...container.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim());
    await type(search, 'مدرسه');
    expect(listed()).toEqual(['مدرسة']);
    await type(search, 'مستشفي');
    expect(listed()).toEqual(['مستشفى']);
    await type(search, '٢٠٢٦');
    // Found by its digits (and, as a name of its own, offered as a new one after it).
    expect(listed()[0]).toBe('Plan 2026');
    // A name that reads as one already there is not offered as a new option.
    await type(search, 'مدرسه');
    await key(search, 'Enter');
    expect(onDefChange).not.toHaveBeenCalled();
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
    const search = document.querySelector<HTMLInputElement>(
      '[data-cg-option-picker] [role="combobox"]',
    )!;
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
    // The header and two rows.
    expect(grid().getAttribute('aria-rowcount')).toBe('3');
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
    // Grouped, the table is a tree grid (Phase 12).
    const treegrid = () => container.querySelector<HTMLElement>('[role="treegrid"]')!;
    const heads = [...treegrid().querySelectorAll('.cgw-trow-group')];
    // "No Status" and the three options.
    expect(heads).toHaveLength(4);
    expect(heads[1].textContent).toContain('Not started');
    const before = treegrid().querySelectorAll('.cgw-tbody [role="row"]').length;
    await mouse(heads[1].querySelector('.cgw-group-toggle')!, 'click');
    expect(treegrid().querySelectorAll('.cgw-tbody [role="row"]').length).toBeLessThan(before);
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
    // The view made is the one shown, though the host listed it before its change resolved.
    const selected = container.querySelector('[role="tab"][aria-selected="true"]')!;
    expect(selected.textContent).toContain('Board');
  });

  it('selects a view by a mouse click on its tab, and reorders by a drag of it', async () => {
    const { view, host, tasksId } = table(2);
    await mount(view);
    await mouse(container.querySelector('[aria-label="Add a view"]')!, 'click');
    const board = [...document.querySelectorAll('[role="menuitem"]')].find((b) =>
      b.textContent?.includes('Board'),
    )!;
    await mouse(board, 'click');
    const tab = (name: string) =>
      [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) =>
        t.textContent?.includes(name),
      )!;
    expect(tab('Board').getAttribute('aria-selected')).toBe('true');
    // A click: `CgTabs` holds the pointer (on the tab's wrapper) only once a press travels past
    // its drag threshold, so down, up and the click all reach the tab.
    const press = async (target: Element, type: string, x: number) => {
      const init = { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 10 };
      await act(async () => {
        target.dispatchEvent(
          type === 'click'
            ? new MouseEvent(type, init)
            : new PointerEvent(type, { ...init, pointerId: 1 }),
        );
      });
      await flush();
    };
    let wrapper = tab('All tasks').parentElement!;
    expect(wrapper.dataset.tabKey).toBeTruthy();
    await press(tab('All tasks'), 'pointerdown', 10);
    await press(tab('All tasks'), 'pointerup', 11);
    await press(tab('All tasks'), 'click', 11);
    expect(tab('All tasks').getAttribute('aria-selected')).toBe('true');
    expect(tab('Board').getAttribute('aria-selected')).toBe('false');

    // A drag of the Board tab before the first: the views are reordered and the choice stays.
    const upserts = opsOf(host, 'view.upsert').length;
    wrapper = tab('Board').parentElement!;
    await press(tab('Board'), 'pointerdown', 100);
    await press(wrapper, 'pointermove', 60);
    await press(wrapper, 'pointermove', -10);
    await press(wrapper, 'pointerup', -10);
    await press(wrapper, 'click', -10);
    expect(opsOf(host, 'view.upsert')).toHaveLength(upserts + 1);
    expect(host.views(tasksId).map((v) => v.name)).toEqual(['Board', 'All tasks']);
    expect(tab('All tasks').getAttribute('aria-selected')).toBe('true');
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
      (v) => v.getAttribute('aria-description') === 'Edit Notes',
    )!;
    await key(notes, 'Enter');
    const input = notes.querySelector<HTMLTextAreaElement>('textarea')!;
    await type(input, 'Checked with finance');
    await key(input, 'Enter');
    expect(opsOf(host, 'row.update')).toHaveLength(1);
    expect(host.rowRecords.get(row.id)!.values[P.notes]).toBe('Checked with finance');
  });

  // Axe (WCAG 2.5.3, label in name): a value's name holds the text it shows.
  it("names each value by its property and the value's own text", async () => {
    const { host, tasksId } = seed(2);
    const row = host.rowsOf(tasksId)[0];
    await mount(h(RowProperties, { host, rowId: row.id }));
    const value = container.querySelector<HTMLElement>('[aria-description="Edit Priority"]')!;
    const name = value
      .getAttribute('aria-labelledby')!
      .split(' ')
      .map((id) => document.getElementById(id)!.textContent)
      .join(' ');
    expect(value.getAttribute('aria-label')).toBeNull();
    expect(name).toBe(`Priority ${value.textContent}`);
  });

  // A row holding a value of every kind that has a control of its own, and a person.
  async function fullRow(editable = true, language: 'en' | 'ar' = 'en') {
    const s = seed(2);
    const row = s.host.rowsOf(s.tasksId)[0];
    const stored = await s.host.assets.store(
      new File(['%PDF'], 'plan.pdf', { type: 'application/pdf' }),
    );
    const values = {
      ...row.values,
      [P.owner]: [PEOPLE[0].id],
      [P.done]: true,
      [P.site]: 'https://example.com/plan',
      [P.email]: 'mona@example.com',
      [P.phone]: '+20 100 000 0001',
      [P.files]: [stored!.assetId],
      [P.project]: [s.projectRows[0]],
    };
    s.host.rowRecords.set(row.id, { ...row, values });
    await mount(h(RowProperties, { host: s.host, rowId: row.id, editable }), language);
    return { ...s, row, assetId: stored!.assetId };
  }
  const lineOf = (name: string) =>
    [...container.querySelectorAll<HTMLElement>('.cgw-row-prop')].find(
      (line) => line.querySelector('.cgw-row-prop-name [dir="auto"]')!.textContent === name,
    )!;
  const controlsOf = (line: HTMLElement) => [
    ...line.querySelectorAll<HTMLElement>(
      'a[href], button, input, textarea, [tabindex], [role="button"]',
    ),
  ];
  const editOf = (line: HTMLElement) => line.querySelector<HTMLButtonElement>('.cgw-row-prop-edit');
  const frame = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

  // Axe's label-content-name-mismatch (WCAG 2.5.3), found by Phase 17's specs: the initials were
  // text, which Axe counts in a value's visible label though `aria-hidden`, and not in its name.
  it("draws a person's initials by the stylesheet: the value's text is the name's", async () => {
    await fullRow();
    const value = lineOf('Owner').querySelector<HTMLElement>('.cgw-row-prop-value')!;
    const avatar = value.querySelector<HTMLElement>('.cgw-avatar')!;
    expect(avatar.getAttribute('data-initials')).toBe('MA');
    expect(avatar.textContent).toBe('');
    expect(avatar.getAttribute('aria-hidden')).toBe('true');
    expect(value.textContent).toBe('Mona Adel');
    const name = value
      .getAttribute('aria-labelledby')!
      .split(' ')
      .map((id) => document.getElementById(id)!.textContent)
      .join(' ');
    expect(name).toBe('Owner Mona Adel');
  });

  // Axe's nested-interactive (WCAG 4.1.2), found by Phase 17's specs: a value holding a control of
  // its own (a checkbox, a link, a file's or a related row's chip) was a control around it.
  it('nests no control in another, and gives a value with controls of its own an Edit button', async () => {
    const { assetId } = await fullRow();
    for (const line of container.querySelectorAll<HTMLElement>('.cgw-row-prop')) {
      const controls = controlsOf(line);
      for (const control of controls)
        expect(controls.filter((other) => other !== control && control.contains(other))).toEqual(
          [],
        );
    }
    // A checkbox is the value's one control, a stop named by its property.
    const done = lineOf('Done');
    const box = done.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(controlsOf(done)).toEqual([done.querySelector('.cgw-row-prop-name'), box]);
    expect(box.tabIndex).toBe(0);
    expect(box.getAttribute('aria-label')).toBe('Done');
    expect(box.closest('[role="button"], [role="group"]')).toBeNull();
    // A link, a file's and a related row's chips are stops of their own, then the Edit button; the
    // group of them is named by the property.
    const cases: [string, string, string][] = [
      ['Site', 'a', 'https://example.com/plan'],
      ['Email', 'a', 'mona@example.com'],
      ['Phone', 'a', '+20 100 000 0001'],
      ['Files', 'button', 'Open plan.pdf'],
      ['Project', 'button', 'Open '],
    ];
    for (const [name, tag, text] of cases) {
      const line = lineOf(name);
      const own = line.querySelector<HTMLElement>(`.cgw-row-prop-value ${tag}`)!;
      expect(own.tabIndex).toBe(0);
      expect(own.getAttribute('aria-label') ?? own.textContent).toContain(text);
      const edit = editOf(line)!;
      expect(controlsOf(line)).toEqual([line.querySelector('.cgw-row-prop-name'), own, edit]);
      expect(edit.getAttribute('aria-label')).toBe(`Edit ${name}`);
      expect(edit.textContent).toBe('Edit');
      const group = line.querySelector<HTMLElement>('[role="group"]')!;
      expect(document.getElementById(group.getAttribute('aria-labelledby')!)!.textContent).toBe(
        name,
      );
      expect(line.querySelector('[role="button"]')).toBeNull();
    }
    expect(editOf(lineOf('Files'))!.getAttribute('aria-haspopup')).toBe('dialog');
    expect(editOf(lineOf('Site'))!.hasAttribute('aria-haspopup')).toBe(false);
    expect(assetId).toBeTruthy();
  });

  it('edits each such value by its Edit button, its keys or a click beside its controls', async () => {
    const { host, row, assetId, projectRows } = await fullRow();
    const updates = () => opsOf(host, 'row.update').length;
    const valueOf = (name: string) =>
      host.rowRecords.get(row.id)!.values[
        { Done: P.done, Site: P.site, Project: P.project }[name as 'Done']
      ];
    // A checkbox toggles once a click, once by Enter (its own Space is the browser's), and once a
    // click beside it.
    const box = lineOf('Done').querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => box.click());
    expect(updates()).toBe(1);
    expect(valueOf('Done') === true).toBe(false);
    await key(box, 'Enter');
    expect(updates()).toBe(2);
    expect(valueOf('Done') === true).toBe(true);
    await mouse(lineOf('Done').querySelector('.cgw-row-prop-value')!, 'click');
    expect(updates()).toBe(3);
    expect(valueOf('Done') === true).toBe(false);

    // The chips and the link open what they name, and edit nothing.
    await mouse(lineOf('Project').querySelector('.cgw-relation-chip')!, 'click');
    await mouse(lineOf('Files').querySelector('.cgw-file-chip')!, 'click');
    await mouse(lineOf('Site').querySelector('a')!, 'click');
    expect(host.opened).toEqual([
      { kind: 'row', id: projectRows[0] },
      { kind: 'link', id: assetId },
      { kind: 'link', id: 'https://example.com/plan' },
    ]);
    expect(updates()).toBe(3);
    expect(document.querySelector('[role="dialog"], .cgw-inline-editor')).toBeNull();

    // Edit, by a click: the value in place, the button gone while it is edited; a commit is one
    // write and gives the focus back to the button.
    const site = lineOf('Site');
    await mouse(editOf(site)!, 'click');
    const input = site.querySelector<HTMLInputElement>('.cgw-inline-editor')!;
    expect(input).not.toBeNull();
    expect(editOf(site)).toBeNull();
    await type(input, 'https://example.com/other');
    await key(input, 'Enter');
    await frame();
    expect(updates()).toBe(4);
    expect(valueOf('Site')).toBe('https://example.com/other');
    expect(document.activeElement).toBe(editOf(site));
    // By Enter: the picker, named as the value's Edit; Escape gives the focus back.
    const project = lineOf('Project');
    await key(editOf(project)!, 'Enter');
    const picker = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(picker.getAttribute('aria-label')).toBe('Edit Project');
    await key(picker.querySelector('input') ?? picker, 'Escape');
    await frame();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(editOf(project));
    // A click in the value beside its chips edits it too.
    await mouse(project.querySelector('.cgw-row-prop-value')!, 'click');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await key(document.querySelector('[role="dialog"] input') ?? document.body, 'Escape');
    // Delete empties it.
    await key(editOf(site)!, 'Delete');
    expect(updates()).toBe(5);
    expect(valueOf('Site') ?? null).toBeNull();
  });

  it('for a reader: no Edit button, a read-only checkbox, chips that still open', async () => {
    const { host, projectRows } = await fullRow(false);
    expect(container.querySelector('.cgw-row-prop-edit')).toBeNull();
    const box = lineOf('Done').querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.getAttribute('aria-readonly')).toBe('true');
    await act(async () => box.click());
    await key(box, 'Enter');
    await mouse(lineOf('Done').querySelector('.cgw-row-prop-value')!, 'click');
    await mouse(lineOf('Project').querySelector('.cgw-row-prop-value')!, 'click');
    expect(opsOf(host, 'row.update')).toEqual([]);
    expect(box.checked).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await mouse(lineOf('Project').querySelector('.cgw-relation-chip')!, 'click');
    expect(host.opened).toEqual([{ kind: 'row', id: projectRows[0] }]);
  });

  it("says Edit in the page's language, inside the button's name", async () => {
    await fullRow(true, 'ar');
    const edit = editOf(lineOf('Site'))!;
    expect(edit.textContent).toBe('عدّل');
    expect(edit.getAttribute('aria-label')).toBe('عدّل Site');
  });

  // Found by the Phase 4 e2e specs: the click on an option bubbled through React's portal to the
  // value it was opened from, which opened the picker again.
  it('a click on an option chooses it and closes the picker', async () => {
    const { host, tasksId } = seed(2);
    const row = host.rowsOf(tasksId)[0];
    await mount(h(RowProperties, { host, rowId: row.id }));
    const value = container.querySelector<HTMLElement>('[aria-description="Edit Priority"]')!;
    await mouse(value, 'click');
    const high = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
      o.textContent?.includes('High'),
    )!;
    await mouse(high, 'click');
    expect(opsOf(host, 'row.update')).toHaveLength(1);
    expect(document.querySelector('[data-cg-option-picker]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('sets a new relation up before writing it, from "Add a property"', async () => {
    const { host, tasksId } = seed(2);
    const row = host.rowsOf(tasksId)[0];
    await mount(h(RowProperties, { host, rowId: row.id }));
    const add = container.querySelector<HTMLElement>('.cgw-row-props-add')!;
    await mouse(add, 'click');
    const relation = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) =>
      i.textContent?.includes('Relation'),
    )!;
    await mouse(relation, 'click');
    // Nothing is written yet: a relation without its database would be refused.
    expect(opsOf(host, 'db.update')).toHaveLength(0);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe('Relation settings');
    const select = dialog.querySelector<HTMLSelectElement>('select')!;
    await act(async () => {
      select.value = tasksId;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const done = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Done',
    )!;
    await mouse(done, 'click');
    const updates = opsOf(host, 'db.update') as unknown as {
      payload: { properties: { type: string }[] };
    }[];
    expect(updates).toHaveLength(1);
    // The relation and, two-way by default, its reverse in this database.
    expect(updates[0].payload.properties.map((p) => p.type)).toEqual(['relation', 'relation']);
    const relations = host.database(tasksId)!.properties.filter((p) => p.type === 'relation');
    expect(relations.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the table adds a property', () => {
  it('sets a relation and a rollup up before writing them', async () => {
    const { view, host, tasksId } = table(2);
    await mount(view);
    const before = host.database(tasksId)!.properties.length;
    const open = async (type: string) => {
      await mouse(container.querySelector('.cgw-th-add button')!, 'click');
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) =>
        i.textContent?.trim().endsWith(type),
      )!;
      await mouse(item, 'click');
      return document.querySelector<HTMLElement>('[role="dialog"]')!;
    };
    const rollup = await open('Rollup');
    expect(rollup.getAttribute('aria-label')).toBe('Rollup settings');
    const [, property, fn] = [...rollup.querySelectorAll<HTMLSelectElement>('select')];
    await act(async () => {
      property.value = 'title';
      property.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      fn.value = 'count';
      fn.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await mouse(
      [...rollup.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent === 'Done',
      )!,
      'click',
    );
    const made = host.database(tasksId)!.properties;
    expect(made).toHaveLength(before + 1);
    expect(made.at(-1)).toMatchObject({ type: 'rollup', rollup: { fn: 'count' } });
    // Shown in the view, after the last column: named by the property, its type the description.
    const headers = [...container.querySelectorAll('[role="columnheader"]')];
    expect(headers.at(-1)!.getAttribute('aria-label')).toBe('Rollup');
    expect(headers.at(-1)!.getAttribute('aria-description')).toBe('Rollup');
  });
});
