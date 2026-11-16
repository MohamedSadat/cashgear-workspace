// Bulk cell editing in the table (Phase 8, M8.3), drawn in jsdom over the in-memory host: a
// selection by Shift and the arrows (mirrored in RTL), Shift and a click, a pointer drag, whole rows
// by a row's handle and whole columns by Shift and a click on a header, kept while the window
// scrolls; a copy's TSV and HTML; a paste converted cell by cell in one batch, refused and computed
// cells counted, rows added past the last (at most 1,000), a single value filling the selection,
// and Undo; Delete clearing the selection; view only.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDom } from '../testing/dom';

installDom();
const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { DatabaseView } = await import('../DatabaseView');
const { createDatabaseI18n } = await import('../i18n');
const { seed, P } = await import('../testing/fixtures');
const { forgetClip } = await import('../clipboard/copy');
const { formatNumber } = await import('../model/format');
const { toTsv } = await import('../clipboard/tsv');

type Root = ReturnType<typeof createRoot>;
let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  forgetClip();
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
const codes: Record<string, string> = { ' ': 'Space', a: 'KeyA', z: 'KeyZ' };
async function key(target: Element, k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: k,
        code: codes[k] ?? k,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
  await flush();
}
async function mouse(target: Element, type: string, init: MouseEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }),
    );
  });
  await flush();
}
async function pointer(target: Element, type: string, init: PointerEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, ...init }),
    );
  });
  await flush();
}

/** A clipboard for a copy or paste event (jsdom has no `DataTransfer`). */
function clipboard(data: Record<string, string> = {}) {
  const store = new Map(Object.entries(data));
  return {
    store,
    getData: (type: string) => store.get(type) ?? '',
    setData: (type: string, value: string) => void store.set(type, value),
  };
}
async function clip(type: 'copy' | 'paste', data: Record<string, string> = {}) {
  const board = clipboard(data);
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: board });
  await act(async () => {
    grid().dispatchEvent(event);
  });
  await flush();
  return { board, event };
}

/** The cell of a row (by its item's row index, from 0) and a column (by index). */
const cell = (row: number, col: number) =>
  grid().querySelector<HTMLElement>(
    `.cgw-tbody [role="row"][aria-rowindex="${row + 2}"] [data-col="${col}"]`,
  )!;
const selectedCells = () => grid().querySelectorAll('.cgw-tcell.is-selected');
const notice = () => container.querySelector<HTMLElement>('.cgw-db-cell-notice');

function table(rows = 6, options = {}) {
  const s = seed(rows, options);
  // Applied batches: a paste, a clear and an Undo are one `apply` each.
  const batches: string[][] = [];
  const apply = s.host.apply.bind(s.host);
  s.host.apply = async (ops) => {
    batches.push(ops.map((op) => op.type));
    return apply(ops);
  };
  const columns = s.host.database(s.tasksId)!.properties;
  const col = (id: string) => columns.findIndex((p) => p.id === id);
  /** The rows as the table shows them (no sort: by order key). */
  const shown = () =>
    s.host
      .rowsOf(s.tasksId)
      .filter((r) => !r.trashedAt)
      .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
  return {
    ...s,
    batches,
    col,
    shown,
    view: h(DatabaseView, { host: s.host, databaseId: s.tasksId, embedded: false }),
  };
}

describe('a selection of cells', () => {
  it('grows by Shift and the arrows, marked selected for a screen reader, and Escape lets go', async () => {
    const { view } = table(5);
    await mount(view);
    const g = grid();
    expect(g.getAttribute('aria-multiselectable')).toBe('true');
    await key(g, 'ArrowRight', { shiftKey: true });
    await key(g, 'ArrowRight', { shiftKey: true });
    await key(g, 'ArrowDown', { shiftKey: true });
    expect(selectedCells()).toHaveLength(6);
    expect(cell(1, 2).getAttribute('aria-selected')).toBe('true');
    expect(cell(2, 2).getAttribute('aria-selected')).toBe('false');
    // The live region says its size.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(container.textContent).toContain('Selected: 2 rows by 3 columns.');
    await key(g, 'Escape');
    expect(selectedCells()).toHaveLength(0);
  });

  it('follows the reading direction in Arabic: Shift+ArrowLeft takes the next column', async () => {
    const { view } = table(3);
    await mount(view, 'ar');
    const g = grid();
    await key(g, 'ArrowLeft', { shiftKey: true });
    expect(selectedCells()).toHaveLength(2);
    expect(cell(0, 1).classList.contains('is-selected')).toBe(true);
    await key(g, 'ArrowRight', { shiftKey: true });
    await key(g, 'ArrowRight', { shiftKey: true });
    expect(selectedCells()).toHaveLength(0);
  });

  it('is dragged out by the pointer, and Shift and a click extends it', async () => {
    const { view } = table(6);
    await mount(view);
    await mouse(cell(0, 1), 'mousedown');
    await mouse(cell(1, 2), 'mousemove', { buttons: 1 });
    await mouse(cell(2, 3), 'mousemove', { buttons: 1 });
    await mouse(cell(2, 3), 'mouseup');
    expect(selectedCells()).toHaveLength(9);
    await mouse(cell(4, 1), 'mousedown', { shiftKey: true });
    // From the drag's start, (row 0, column 1), to here.
    expect(selectedCells()).toHaveLength(5);
    expect(cell(4, 1).classList.contains('is-selected')).toBe(true);
    expect(cell(0, 2).classList.contains('is-selected')).toBe(false);
  });

  it('takes whole rows by a row’s handle and whole columns by Shift and a click on a header', async () => {
    const { view, host, tasksId } = table(4);
    await mount(view);
    const columns = host.database(tasksId)!.properties.length;
    const handle = cell(1, 0).querySelector('.cgw-db-row-select')!;
    expect(handle.getAttribute('aria-label')).toMatch(/^Select the row /);
    await mouse(handle, 'mousedown');
    await mouse(handle, 'mouseup');
    const row = cell(1, 0).closest('[role="row"]')!;
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(row.querySelectorAll('.is-selected')).toHaveLength(columns);
    // Shift+Space does the same from the keys; Ctrl+Space takes columns.
    await key(grid(), 'Escape');
    const header = grid().querySelectorAll('[role="columnheader"]')[2];
    await pointer(header, 'pointerdown');
    await pointer(header, 'pointerup', { shiftKey: true });
    expect(header.getAttribute('aria-selected')).toBe('true');
    expect(cell(3, 2).classList.contains('is-selected')).toBe(true);
    expect(document.querySelector('[aria-label="Property name"]')).toBeNull();
  });

  it('takes whole rows by Shift+Space, whole columns by Ctrl+Space, everything by Ctrl+A', async () => {
    const { view, host, tasksId } = table(4);
    await mount(view);
    const g = grid();
    const columns = host.database(tasksId)!.properties.length;
    await key(g, 'ArrowDown', { shiftKey: true });
    await key(g, ' ', { shiftKey: true });
    expect(selectedCells()).toHaveLength(2 * columns);
    await key(g, 'Escape');
    await key(g, 'ArrowRight');
    await key(g, ' ', { ctrlKey: true });
    // The column from the first row to the last (four rows).
    expect(selectedCells()).toHaveLength(4);
    expect(grid().querySelectorAll('[role="columnheader"]')[1].getAttribute('aria-selected')).toBe(
      'true',
    );
    await key(g, 'a', { ctrlKey: true });
    expect(selectedCells()).toHaveLength(4 * columns);
  });

  it('stays while the virtual window scrolls away and back', async () => {
    const { view } = table(600);
    await mount(view);
    const g = grid();
    await key(g, 'ArrowDown', { shiftKey: true });
    await key(g, 'ArrowRight', { shiftKey: true });
    expect(selectedCells()).toHaveLength(4);
    const scroll = async (top: number) => {
      await act(async () => {
        g.scrollTop = top;
        g.dispatchEvent(new Event('scroll'));
      });
      await flush();
    };
    await scroll(34 * 400);
    expect(cell(400, 0)).toBeTruthy();
    expect(cell(400, 0).classList.contains('is-selected')).toBe(false);
    await scroll(0);
    expect(selectedCells()).toHaveLength(4);
    // Everything: a row far down is selected as it comes into the window.
    await key(g, 'a', { ctrlKey: true });
    await scroll(34 * 500);
    expect(cell(500, 3).classList.contains('is-selected')).toBe(true);
  });
});

describe('copy', () => {
  it('puts the rectangle on the clipboard as TSV and an HTML table, the values as shown', async () => {
    const { view, host, tasksId, col, shown } = table(4);
    await mount(view);
    const g = grid();
    const amount = col(P.amount);
    for (let i = 0; i < amount; i++) await key(g, 'ArrowRight', { shiftKey: true });
    await key(g, 'ArrowDown', { shiftKey: true });
    const { board, event } = await clip('copy');
    expect(event.defaultPrevented).toBe(true);
    const database = host.database(tasksId)!;
    const defs = database.properties.slice(0, amount + 1);
    const rows = shown().slice(0, 2);
    // Each value as the cell shows it: the currency number with its symbol, options by name.
    const texts = rows.map((r) =>
      defs.map((def) => {
        if (def.id === 'title') return r.title;
        if (def.id === P.amount) return formatNumber(r.values[P.amount] as number, def, 'en');
        const id = r.values[def.id];
        if (Array.isArray(id))
          return id.map((v) => def.options!.find((o) => o.id === v)!.name).join(', ');
        return def.options?.find((o) => o.id === id)?.name ?? '';
      }),
    );
    expect(board.store.get('text/plain')).toBe(toTsv(texts));
    const html = board.store.get('text/html')!;
    expect(html).toContain('<table dir="ltr">');
    expect(html).toContain(
      `<td>${formatNumber(rows[0].values[P.amount] as number, defs[amount], 'en')}</td>`,
    );
  });
});

describe('paste', () => {
  it('converts each value by its property, counts the refused, writes one batch, and Undo takes it back', async () => {
    const { view, host, col, shown, batches } = table(4);
    await mount(view);
    const g = grid();
    const amount = col(P.amount);
    for (let i = 0; i < amount; i++) await key(g, 'ArrowRight');
    const before = shown().map((r) => r.values[P.amount]);
    await clip('paste', { 'text/plain': '1,250.50\r\nabout ten\r\n٤٢\r\n' });
    expect(batches).toEqual([['row.update', 'row.update']]);
    const now = shown();
    expect(now[0].values[P.amount]).toBe(1250.5);
    expect(now[1].values[P.amount]).toBe(before[1]);
    expect(now[2].values[P.amount]).toBe(42);
    expect(notice()!.textContent).toContain('Pasted: 2 cells changed.');
    expect(notice()!.textContent).toContain('left as they were: 1.');
    // What was pasted stays selected.
    expect(selectedCells()).toHaveLength(3);
    const undo = [...notice()!.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!;
    await mouse(undo, 'click');
    expect(batches).toHaveLength(2);
    expect(shown().map((r) => r.values[P.amount])).toEqual(before);
    expect(notice()!.textContent).toContain('Undone');
    expect(host.applied.filter((op) => op.type === 'page.create')).toHaveLength(0);
  });

  it('leaves computed cells as they were and makes the options it needs', async () => {
    const { view, host, tasksId, col, shown, batches } = table(2);
    await mount(view);
    const g = grid();
    // From Priority across Tags to Amount and Double (a formula) as the database orders them.
    const order = host.database(tasksId)!.properties.map((p) => p.id);
    const from = col(P.priority);
    for (let i = 0; i < from; i++) await key(g, 'ArrowRight');
    const cells = order.slice(from, from + 2);
    expect(cells).toEqual([P.priority, P.tags]);
    await clip('paste', { 'text/plain': 'Urgent\tFinance, Brand new\r\n' });
    expect(batches[0][0]).toBe('db.update');
    const database = host.database(tasksId)!;
    const urgent = database.properties
      .find((p) => p.id === P.priority)!
      .options!.find((o) => o.name === 'Urgent')!;
    expect(shown()[0].values[P.priority]).toBe(urgent.id);
    const tags = database.properties.find((p) => p.id === P.tags)!.options!;
    expect(shown()[0].values[P.tags]).toEqual([
      'tgFin001',
      tags.find((o) => o.name === 'Brand new')!.id,
    ]);
    // A paste over a formula column: counted and left.
    const double = col(P.double);
    await key(g, 'Home');
    for (let i = 0; i < double; i++) await key(g, 'ArrowRight');
    await clip('paste', { 'text/plain': '99\r\n' });
    expect(notice()!.textContent).toContain('Computed cells, left as they were: 1.');
  });

  it('adds rows past the last one, at most 1,000 a paste, and Undo puts them in the trash', async () => {
    const { view, host, tasksId, shown, batches } = table(3);
    await mount(view);
    const text = Array.from({ length: 1010 }, (_, i) => `Pasted ${i}`).join('\r\n');
    await clip('paste', { 'text/plain': text });
    expect(batches).toHaveLength(1);
    expect(batches[0].filter((t) => t === 'page.create')).toHaveLength(1000);
    expect(batches[0].filter((t) => t === 'page.update')).toHaveLength(3);
    expect(shown()).toHaveLength(1003);
    expect(shown()[1002].title).toBe('Pasted 1002');
    expect(notice()!.textContent).toContain('Rows added: 1,000.');
    expect(notice()!.textContent).toContain(
      'Rows past the 1,000 new rows a paste may add, left out: 7.',
    );
    await key(grid(), 'z', { ctrlKey: true });
    expect(batches).toHaveLength(2);
    expect(host.rowsOf(tasksId).filter((r) => !r.trashedAt)).toHaveLength(3);
    expect(notice()!.textContent).toContain('the rows added are in the trash');
  });

  it('fills a larger selection with a single value', async () => {
    const { view, col, shown } = table(4);
    await mount(view);
    const g = grid();
    const notes = col(P.notes);
    for (let i = 0; i < notes; i++) await key(g, 'ArrowRight');
    await key(g, 'ArrowDown', { shiftKey: true });
    await key(g, 'ArrowDown', { shiftKey: true });
    await clip('paste', { 'text/plain': 'Same everywhere\r\n' });
    expect(
      shown()
        .slice(0, 3)
        .map((r) => r.values[P.notes]),
    ).toEqual(['Same everywhere', 'Same everywhere', 'Same everywhere']);
    expect(shown()[3].values[P.notes]).not.toBe('Same everywhere');
  });

  it('pastes an HTML table when the clipboard has no text', async () => {
    const { view, shown } = table(2);
    await mount(view);
    await clip('paste', {
      'text/html': '<table><tr><td>From a page</td></tr><tr><td>Second</td></tr></table>',
    });
    expect(shown().map((r) => r.title)).toEqual(['From a page', 'Second']);
  });

  it('pastes the tab’s own copy with its values: a person and a date survive', async () => {
    const { view, col, shown } = table(6);
    await mount(view);
    const g = grid();
    const source = shown().findIndex((r) => r.values[P.owner] && r.values[P.due]);
    const target = shown().findIndex((r, i) => i !== source && !r.values[P.owner]);
    expect(source).toBeGreaterThanOrEqual(0);
    expect(target).toBeGreaterThanOrEqual(0);
    const due = col(P.due);
    const owner = col(P.owner);
    expect(owner).toBe(due + 2);
    const at = async (row: number, column: number) => {
      await key(g, 'Home', { ctrlKey: true });
      await key(g, 'ArrowDown');
      for (let i = 0; i < row; i++) await key(g, 'ArrowDown');
      for (let i = 0; i < column; i++) await key(g, 'ArrowRight');
    };
    await at(source, due);
    for (let i = due; i < owner; i++) await key(g, 'ArrowRight', { shiftKey: true });
    const { board } = await clip('copy');
    const expected = shown()[source];
    await at(target, due);
    await clip('paste', { 'text/plain': board.store.get('text/plain')! });
    expect(shown()[target].values[P.due]).toEqual(expected.values[P.due]);
    expect(shown()[target].values[P.owner]).toEqual(expected.values[P.owner]);
  });
});

describe('Delete', () => {
  it('clears the selection’s cells in one batch, and Ctrl+Z puts them back', async () => {
    const { view, col, shown, batches } = table(3);
    await mount(view);
    const g = grid();
    const amount = col(P.amount);
    for (let i = 0; i < amount; i++) await key(g, 'ArrowRight');
    await key(g, 'ArrowDown', { shiftKey: true });
    await key(g, 'ArrowRight', { shiftKey: true });
    const before = shown().map((r) => [r.values[P.amount], r.values[P.due]]);
    await key(g, 'Delete');
    expect(batches).toHaveLength(1);
    expect(shown()[0].values[P.amount]).toBeUndefined();
    expect(shown()[1].values[P.due]).toBeUndefined();
    expect(notice()!.textContent).toContain('Cleared:');
    await key(g, 'z', { ctrlKey: true });
    expect(shown().map((r) => [r.values[P.amount], r.values[P.due]])).toEqual(before);
  });
});

describe('a view-only database', () => {
  it('pastes and clears nothing, and says so', async () => {
    const { view, host } = table(3, { canEdit: false });
    await mount(view);
    const g = grid();
    await key(g, 'ArrowDown', { shiftKey: true });
    await key(g, 'Delete');
    await clip('paste', { 'text/plain': 'Nope\r\n' });
    expect(host.applied).toHaveLength(0);
    expect(notice()!.textContent).toContain('view only');
    // Copy still works.
    const { board } = await clip('copy');
    expect(board.store.get('text/plain')).toBeTruthy();
  });
});
