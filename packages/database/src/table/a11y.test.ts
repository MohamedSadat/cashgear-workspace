// The table as a screen reader reads it (Phase 12, M12.3), drawn in jsdom over the in-memory host:
// the row count and each row's index from the query's total, as a paged table of hundreds scrolls
// ("load more" standing where the next row will be, the "New" line no row at all); the title as
// each row's header and every other cell a grid cell; headers named by the property alone; a
// grouped table as a tree grid (a group at level 1 with its expanded state and place, its rows at
// level 2 with their place in the group of its count), Left and Right collapsing and expanding a
// group; editing said when it starts, is saved and is cancelled, in English and Arabic; the "New"
// line said when it is reached; nothing drawn while a cell is typed in. And the words it says
// them with: in both languages alike, merged when a table first draws, never in the catalogue the
// shell loads at start.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RowRecord } from '@cgw/workspace';
import i18next from 'i18next';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowSnapshot } from '../host';
import { installDom } from '../testing/dom';

installDom();
const { createElement: h, act, Profiler } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { DatabaseView } = await import('../DatabaseView');
const { createDatabaseI18n, en: catalogueEn } = await import('../i18n');
const { seed, P } = await import('../testing/fixtures');
const { ariaLayout, buildItems } = await import('./items');
const { addGridWords, gridAr, gridEn } = await import('./words');

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
/** The live region writes a frame after it is told. */
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

const grid = () => container.querySelector<HTMLElement>('.cgw-grid')!;
const active = () => {
  const id = grid().getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
};
const rowOf = (el: Element | null) => el?.closest<HTMLElement>('[role="row"]') ?? null;
const said = () =>
  container.querySelector('.cgw-db-table [data-cg-live-announcer]')?.textContent ?? '';
const codes: Record<string, string> = { ' ': 'Space' };
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
async function type(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
  await act(async () => {
    const proto = Object.getPrototypeOf(input);
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const focusGrid = () => act(async () => grid().focus());

function table(rows: number, options = {}) {
  const s = seed(rows, options);
  return { ...s, view: h(DatabaseView, { host: s.host, databaseId: s.tasksId }) };
}

/** The seeded Tasks database, its view grouped by a property. */
async function grouped(rows: number, propertyId: string, options = {}) {
  const s = seed(rows, options);
  const view = s.host.views(s.tasksId)[0];
  await s.host.apply([
    {
      opId: 'g',
      type: 'view.upsert',
      workspaceId: view.workspaceId,
      entityId: s.viewId,
      baseVersion: null,
      createdAt: new Date().toISOString(),
      payload: { ...view, config: { ...view.config, group: { propertyId } } },
    },
  ]);
  return { ...s, view: h(DatabaseView, { host: s.host, databaseId: s.tasksId }) };
}

// ---- The counts, pure ------------------------------------------------------------------------
const fakeRows = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }) as unknown as RowRecord);
const snapshotOf = (over: Partial<RowSnapshot>): RowSnapshot => ({
  rows: [],
  groups: null,
  total: 0,
  complete: true,
  localOnly: false,
  loading: false,
  error: null,
  ...over,
});

describe('what a screen reader counts', () => {
  it('is the header and the query’s total, "load more" at the next row’s place, "New" no row', () => {
    // Three of 1,000 rows loaded.
    const s = snapshotOf({ rows: fakeRows(3, 'r'), total: 1000, complete: false });
    const layout = ariaLayout(buildItems(s, new Set(), true), s);
    expect(layout.rowCount).toBe(1001);
    expect([...layout.rowIndex]).toEqual([2, 3, 4, 5, 0]);
    expect([...layout.level]).toEqual([0, 0, 0, 0, 0]);
    // Every row loaded: the header and the rows, the New line still no row.
    const all = snapshotOf({ rows: fakeRows(3, 'r'), total: 3 });
    const done = ariaLayout(buildItems(all, new Set(), true), all);
    expect(done.rowCount).toBe(4);
    expect([...done.rowIndex]).toEqual([2, 3, 4, 0]);
    // Unknown while the first page loads.
    const loading = snapshotOf({ loading: true, complete: false });
    expect(ariaLayout(buildItems(loading, new Set(), true), loading).rowCount).toBe(-1);
  });

  it('grouped: each group a place, then all of its rows’ places when expanded, loaded or not', () => {
    const a = fakeRows(2, 'a');
    const b = fakeRows(2, 'b');
    const c = fakeRows(4, 'c');
    const s = snapshotOf({
      rows: [...a, ...b, ...c],
      groups: [
        { key: 'A', count: 3, rows: a, complete: false },
        { key: 'B', count: 2, rows: b, complete: true },
        { key: 'C', count: 4, rows: c, complete: true },
      ],
      total: 9,
      complete: false,
    });
    const items = buildItems(s, new Set(['C']), true);
    expect(items.map((i) => i.kind)).toEqual([
      'group',
      'row',
      'row',
      'more',
      'new',
      'group',
      'row',
      'row',
      'new',
      'group',
    ]);
    const layout = ariaLayout(items, s);
    // A at 2, its three rows at 3 to 5 ("load more" at the third's), B after them, C collapsed.
    expect([...layout.rowIndex]).toEqual([2, 3, 4, 5, 0, 6, 7, 8, 0, 9]);
    expect(layout.rowCount).toBe(9);
    expect([...layout.level]).toEqual([1, 2, 2, 2, 0, 1, 2, 2, 0, 1]);
    expect([...layout.posInSet]).toEqual([1, 1, 2, 3, 0, 2, 1, 2, 0, 3]);
    expect([...layout.setSize]).toEqual([3, 3, 3, 3, 0, 3, 2, 2, 0, 3]);
  });
});

// ---- The grid ----------------------------------------------------------------------------------
describe('the grid', () => {
  it('counts the query’s total as a paged table is moved through and scrolled', async () => {
    const { view } = table(300, { pageSize: 50 });
    await mount(view);
    const g = grid();
    expect(g.getAttribute('role')).toBe('grid');
    // The header and the 300 rows the query matches, though 50 are loaded.
    expect(g.getAttribute('aria-rowcount')).toBe('301');
    // Described by its foot: the true total.
    expect(document.getElementById(g.getAttribute('aria-describedby')!)!.textContent).toBe(
      'Rows: 50 of 300',
    );
    expect(rowOf(active())!.getAttribute('aria-rowindex')).toBe('2');
    await key(g, 'ArrowDown');
    expect(rowOf(active())!.getAttribute('aria-rowindex')).toBe('3');
    await key(g, 'PageDown');
    const paged = Number(rowOf(active())!.getAttribute('aria-rowindex'));
    expect(paged).toBeGreaterThan(10);
    // A jump to the end: the New line, which is no row (nothing is the active descendant).
    await focusGrid();
    await key(g, 'ArrowDown', { ctrlKey: true });
    expect(g.hasAttribute('aria-activedescendant')).toBe(false);
    const newLine = g.querySelector('.cgw-trow-new')!;
    expect(newLine.getAttribute('aria-hidden')).toBe('true');
    expect(newLine.querySelector('[role]')).toBeNull();
    await frame();
    expect(said()).toBe('New row: press Enter to add one.');
    // Up: "load more", standing where row 51 will be; up again: row 50.
    await key(g, 'ArrowUp');
    expect(active()!.textContent).toBe('Load more');
    expect(rowOf(active())!.getAttribute('aria-rowindex')).toBe('52');
    await key(g, 'ArrowUp');
    expect(rowOf(active())!.getAttribute('aria-rowindex')).toBe('51');
    expect(active()!.getAttribute('role')).toBe('rowheader');
    expect(g.getAttribute('aria-rowcount')).toBe('301');
    // Scrolled to "load more": the next page comes, each row at its place of the 300.
    await act(async () => {
      g.scrollTop = 34 * 45;
      g.dispatchEvent(new Event('scroll'));
    });
    await flush();
    await vi.waitFor(() => expect(g.querySelector('.cgw-trow-more')).toBeNull());
    expect(document.getElementById(g.getAttribute('aria-describedby')!)!.textContent).toBe(
      'Rows: 100 of 300',
    );
    const drawn = [...g.querySelectorAll<HTMLElement>('.cgw-tbody [role="row"]')];
    expect(drawn.length).toBeGreaterThan(10);
    for (const row of drawn)
      expect(Number(row.getAttribute('aria-rowindex'))).toBe(Number(row.dataset.item) + 2);
    expect(g.getAttribute('aria-rowcount')).toBe('301');
  });

  it('makes the title each row’s header and names the headers by the property alone', async () => {
    const { view, host, tasksId } = table(3);
    await mount(view);
    const g = grid();
    const headers = [...g.querySelectorAll('.cgw-tbody [role="rowheader"]')];
    expect(headers).toHaveLength(3);
    const titles = host
      .rowsOf(tasksId)
      .filter((r) => !r.trashedAt)
      .map((r) => r.title);
    for (const header of headers) {
      // Named by the title alone (not its handle's "Select the row …" or its "Open …").
      const by = header.getAttribute('aria-labelledby')!;
      expect(titles).toContain(document.getElementById(by)!.textContent);
      expect(header.getAttribute('aria-colindex')).toBe('1');
    }
    const row = rowOf(headers[0])!;
    const cells = [...row.querySelectorAll('[role="gridcell"]')];
    expect(cells.length).toBeGreaterThan(3);
    expect(cells.every((c) => Number(c.getAttribute('aria-colindex')) > 1)).toBe(true);
    const columns = [...g.querySelectorAll('[role="columnheader"]')];
    expect(columns.map((c) => c.getAttribute('aria-label')).slice(0, 5)).toEqual([
      'Name',
      'Status',
      'Priority',
      'Tags',
      'Amount',
    ]);
    expect(columns[4].getAttribute('aria-description')).toBe('Number');
    // The header row keeps its index; the rows follow it.
    expect(g.querySelector('.cgw-thead')!.getAttribute('aria-rowindex')).toBe('1');
    expect(g.getAttribute('aria-rowcount')).toBe('4');
  });
});

// ---- A grouped table ---------------------------------------------------------------------------
describe('a grouped table', () => {
  it('is a tree grid: groups at level 1 with their state and place, rows at level 2 in them', async () => {
    const { view, host, tasksId } = await grouped(12, P.status);
    await mount(view);
    const g = grid();
    expect(g.getAttribute('role')).toBe('treegrid');
    const groups = [...g.querySelectorAll<HTMLElement>('.cgw-trow-group')];
    expect(groups).toHaveLength(4);
    const counts: number[] = [];
    groups.forEach((row, i) => {
      expect(row.getAttribute('role')).toBe('row');
      expect(row.getAttribute('aria-level')).toBe('1');
      expect(row.getAttribute('aria-expanded')).toBe('true');
      expect(row.getAttribute('aria-posinset')).toBe(String(i + 1));
      expect(row.getAttribute('aria-setsize')).toBe('4');
      // Named by its group and count, not its toggle's "Collapse …".
      const name = row
        .getAttribute('aria-labelledby')!
        .split(' ')
        .map((id) => document.getElementById(id)!.textContent)
        .join(' ');
      expect(name).toMatch(/Rows: \d+$/);
      expect(name).not.toContain('Collapse');
      counts.push(Number(name.match(/(\d+)$/)![1]));
    });
    expect(counts.reduce((a, b) => a + b, 0)).toBe(
      host.rowsOf(tasksId).filter((r) => !r.trashedAt).length,
    );
    // The header, four groups, twelve rows; the New lines are no rows.
    expect(g.getAttribute('aria-rowcount')).toBe('17');
    expect(g.querySelectorAll('.cgw-trow-new[role]')).toHaveLength(0);
    // Each group's rows: level 2, their place in the group of its count.
    let at = 0;
    for (const row of g.querySelectorAll<HTMLElement>('.cgw-tbody [role="row"]')) {
      if (row.classList.contains('cgw-trow-group')) {
        at = groups.indexOf(row);
        continue;
      }
      expect(row.getAttribute('aria-level')).toBe('2');
      expect(row.getAttribute('aria-setsize')).toBe(String(counts[at]));
      expect(Number(row.getAttribute('aria-posinset'))).toBeLessThanOrEqual(counts[at]);
    }
    const indices = [...g.querySelectorAll('.cgw-tbody [role="row"]')].map((r) =>
      Number(r.getAttribute('aria-rowindex')),
    );
    expect(indices).toEqual(Array.from({ length: 16 }, (_, i) => i + 2));
  });

  it('collapses and expands a group by Left and Right on its header, mirrored in Arabic', async () => {
    for (const language of ['en', 'ar'] as const) {
      const { view } = await grouped(12, P.status);
      await mount(view, language);
      const g = grid();
      // The first group's header is the active descendant: the row itself.
      const head = g.querySelector<HTMLElement>('.cgw-trow-group')!;
      expect(active()).toBe(head);
      const count = Number(g.getAttribute('aria-rowcount'));
      // The first group's rows: its header is at 2, the next group's after them.
      const inGroup =
        Number(g.querySelectorAll('.cgw-trow-group')[1].getAttribute('aria-rowindex')) - 3;
      const back = language === 'ar' ? 'ArrowRight' : 'ArrowLeft';
      const forward = language === 'ar' ? 'ArrowLeft' : 'ArrowRight';
      await key(g, back);
      expect(head.getAttribute('aria-expanded')).toBe('false');
      expect(Number(g.getAttribute('aria-rowcount'))).toBe(count - inGroup);
      await key(g, back);
      expect(head.getAttribute('aria-expanded')).toBe('false');
      await key(g, forward);
      expect(head.getAttribute('aria-expanded')).toBe('true');
      expect(Number(g.getAttribute('aria-rowcount'))).toBe(count);
      await act(async () => root?.unmount());
      root = null;
      container.innerHTML = '';
    }
  });

  it('pages each group: "load more" at its place in the group, the next group after all its rows', async () => {
    // 300 rows in four groups, 30 of each loaded at first.
    const { view } = await grouped(300, P.status, { pageSize: 30 });
    await mount(view);
    const g = grid();
    // The header, four groups and all 300 rows, loaded or not.
    expect(g.getAttribute('aria-rowcount')).toBe('305');
    // "No Status" is empty (its header, then its New line); "Not started" follows it.
    const [empty, head] = [...g.querySelectorAll<HTMLElement>('.cgw-trow-group')];
    expect(empty.getAttribute('aria-rowindex')).toBe('2');
    expect(head.getAttribute('aria-rowindex')).toBe('3');
    const name = head
      .getAttribute('aria-labelledby')!
      .split(' ')
      .map((id) => document.getElementById(id)!.textContent)
      .join(' ');
    expect(name).toContain('Not started');
    const count = Number(name.match(/(\d+)$/)![1]);
    expect(count).toBeGreaterThan(30);
    // Down to its "load more" (after its header and 30 rows), kept drawn as the active line: it
    // stands where the group's 31st row will be.
    for (let i = 0; i < 33; i++) await key(g, 'ArrowDown');
    const more = rowOf(active())!;
    expect(more.classList.contains('cgw-trow-more')).toBe(true);
    expect(more.getAttribute('aria-level')).toBe('2');
    expect(more.getAttribute('aria-posinset')).toBe('31');
    expect(more.getAttribute('aria-setsize')).toBe(String(count));
    expect(more.getAttribute('aria-rowindex')).toBe(String(3 + 31));
    // Past its New line, the next group's header: after every row of "Not started".
    await key(g, 'ArrowDown');
    await key(g, 'ArrowDown');
    const next = active()!;
    expect(next.classList.contains('cgw-trow-group')).toBe(true);
    expect(next.getAttribute('aria-rowindex')).toBe(String(3 + 1 + count));
    expect(next.getAttribute('aria-posinset')).toBe('3');
    expect(g.getAttribute('aria-rowcount')).toBe('305');
  });

  it('keeps the cell selection: a drag over a group’s rows selects them', async () => {
    const { view } = await grouped(12, P.status);
    await mount(view);
    const g = grid();
    const rows = [
      ...g.querySelectorAll<HTMLElement>('.cgw-tbody [role="row"]:not(.cgw-trow-group)'),
    ];
    const first = rows[0].querySelector('[data-col="1"]')!;
    const second = rows[1].querySelector('[data-col="2"]')!;
    await mouse(first, 'mousedown');
    await mouse(second, 'mousemove', { buttons: 1 });
    await mouse(second, 'mouseup');
    expect(g.querySelectorAll('.cgw-tcell.is-selected').length).toBeGreaterThanOrEqual(4);
  });
});

// ---- Editing, said ------------------------------------------------------------------------------
describe('editing, said through the live region', () => {
  it('when it starts, is cancelled and is saved, naming the property and the row', async () => {
    const { view, host, tasksId } = table(3);
    await mount(view);
    const g = grid();
    await focusGrid();
    const title = rowOf(active())!.querySelector('.cgw-title-text')!.textContent!;
    await key(g, 'Enter');
    await frame();
    expect(said()).toBe(`Editing: Name, ${title}.`);
    let input = g.querySelector<HTMLInputElement>('.cgw-inline-editor')!;
    await type(input, 'Thrown away');
    await key(input, 'Escape');
    await frame();
    expect(said()).toBe(`Edit cancelled: Name, ${title}.`);
    await key(g, 'Enter');
    input = g.querySelector<HTMLInputElement>('.cgw-inline-editor')!;
    await type(input, 'Quarter close');
    await key(input, 'Enter');
    await frame();
    // A title is said as it was written.
    expect(said()).toBe('Saved: Name, Quarter close.');

    // A picker: Status, chosen in its flyout.
    await key(g, 'ArrowRight');
    await key(g, 'Enter');
    await frame();
    expect(said()).toBe('Editing: Status, Quarter close.');
    const search = document.querySelector<HTMLInputElement>(
      '[data-cg-option-picker] [role="combobox"]',
    )!;
    await type(search, 'Done');
    await key(search, 'Enter');
    await frame();
    expect(said()).toBe('Saved: Status, Quarter close.');
    // A picker closed with nothing chosen is cancelled.
    await focusGrid();
    await key(g, 'ArrowRight');
    await key(g, 'Enter');
    const priority = document.querySelector<HTMLInputElement>(
      '[data-cg-option-picker] [role="combobox"]',
    )!;
    await key(priority, 'Escape');
    await frame();
    expect(said()).toBe('Edit cancelled: Priority, Quarter close.');
    // A checkbox is saved as it is toggled.
    await focusGrid();
    const done = host.database(tasksId)!.properties.findIndex((p) => p.id === P.done);
    for (let i = 2; i < done; i++) await key(g, 'ArrowRight');
    await key(g, ' ');
    await frame();
    expect(said()).toBe('Saved: Done, Quarter close.');
  });

  it('in Arabic', async () => {
    const { view } = table(2);
    await mount(view, 'ar');
    const g = grid();
    await focusGrid();
    const title = rowOf(active())!.querySelector('.cgw-title-text')!.textContent!;
    await key(g, 'Enter');
    await frame();
    expect(said()).toBe(`تحرير: Name، ${title}.`);
    await key(g.querySelector('.cgw-inline-editor')!, 'Escape');
    await frame();
    expect(said()).toBe(`أُلغي التحرير: Name، ${title}.`);
    await key(g, 'Enter');
    const input = g.querySelector<HTMLInputElement>('.cgw-inline-editor')!;
    await type(input, 'ميزانية الربع');
    await key(input, 'Enter');
    await frame();
    expect(said()).toBe('حُفظ: Name، ميزانية الربع.');
    await key(g, 'ArrowDown', { ctrlKey: true });
    await frame();
    expect(said()).toBe('صف جديد: اضغط Enter لإضافة صف.');
  });

  it('says the New line when it is reached, and Enter there adds a row whose editing is said', async () => {
    const { view, host } = table(2);
    await mount(view);
    const g = grid();
    await focusGrid();
    await key(g, 'ArrowDown');
    await key(g, 'ArrowDown');
    expect(g.hasAttribute('aria-activedescendant')).toBe(false);
    await frame();
    expect(said()).toBe('New row: press Enter to add one.');
    await key(g, 'Enter');
    await vi.waitFor(() =>
      expect(host.applied.filter((op) => op.type === 'page.create')).toHaveLength(1),
    );
    await vi.waitFor(() => expect(g.querySelector('.cgw-inline-editor')).toBeTruthy());
    await frame();
    expect(said()).toBe('Editing: Name, Untitled.');
    expect(g.getAttribute('aria-rowcount')).toBe('4');
  });

  it('draws nothing while a cell is typed in', async () => {
    const { host, tasksId } = seed(40);
    let commits = 0;
    await mount(
      h(
        Profiler,
        { id: 'table', onRender: () => void commits++ },
        h(DatabaseView, { host, databaseId: tasksId }),
      ),
    );
    const g = grid();
    await focusGrid();
    const notes = host.database(tasksId)!.properties.findIndex((p) => p.id === P.notes);
    for (let i = 0; i < notes; i++) await key(g, 'ArrowRight');
    await key(g, 'Enter');
    await frame();
    expect(said()).toBe(
      `Editing: Notes, ${rowOf(active())!.querySelector('.cgw-title-text')!.textContent}.`,
    );
    const input = g.querySelector<HTMLTextAreaElement>('.cgw-inline-editor')!;
    const before = commits;
    for (const text of ['a', 'ab', 'abc', 'abcd', 'abcde']) await type(input, text);
    await flush();
    expect(commits).toBe(before);
  });
});

// ---- The words -----------------------------------------------------------------------------------
describe('the grid’s words', () => {
  const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);

  it('have the same keys and placeholders in both languages, and Arabic in the Arabic', () => {
    expect(Object.keys(gridAr).sort()).toEqual(Object.keys(gridEn).sort());
    for (const [key, text] of Object.entries(gridEn)) {
      const arabic = gridAr[key as keyof typeof gridAr];
      expect(text.trim(), key).not.toBe('');
      expect(placeholders(arabic).sort(), key).toEqual(placeholders(text).sort());
      // Placeholders, and a key's name as the keyboard labels it (the views' rule).
      const words = arabic.replace(/\{\{\w+\}\}|\bEnter\b/g, '');
      expect(/[A-Za-z]/.test(words), `${key}: ${words}`).toBe(false);
      expect(/\p{Script=Arabic}/u.test(words), `${key}: ${words}`).toBe(true);
    }
  });

  it('hold every key the table asks for', () => {
    const missing: string[] = [];
    let asked = 0;
    for (const name of readdirSync(import.meta.dirname).filter((n) => /\.tsx?$/.test(n)))
      if (!name.includes('.test.'))
        for (const match of readFileSync(join(import.meta.dirname, name), 'utf8').matchAll(
          /\bgridT\(\s*'([a-zA-Z]+)'/g,
        )) {
          asked++;
          if (!(match[1] in gridEn)) missing.push(`${name}: ${match[1]}`);
        }
    expect(missing).toEqual([]);
    expect(asked).toBeGreaterThanOrEqual(5);
  });

  it('are merged into an instance’s database section once, and are not in the catalogue loaded at start', () => {
    // The catalogue the shell merges at start names none of them (the tables drawn above have
    // merged them into their instances, which hold that catalogue's objects).
    for (const name of ['en.ts', 'ar.ts', 'views-en.ts', 'views-ar.ts', 'catalogues.ts'])
      expect(readFileSync(join(import.meta.dirname, '../i18n', name), 'utf8'), name).not.toMatch(
        /grid-(en|ar)|\bgrid(En|Ar)\b/,
      );
    expect(catalogueEn.database).toBeTruthy();
    const instance = i18next.createInstance();
    void instance.init({
      lng: 'en',
      resources: { en: { translation: { database: { loading: 'Loading…' } } }, ar: {} },
      initAsync: false,
    });
    expect(instance.exists('database.grid.newRow')).toBe(false);
    addGridWords(instance);
    addGridWords(instance);
    expect(instance.t('database.grid.newRow')).toBe('New row: press Enter to add one.');
    expect(instance.t('database.loading')).toBe('Loading…');
    expect(instance.getFixedT('ar')('database.grid.newRow')).toBe(gridAr.newRow);
  });
});
