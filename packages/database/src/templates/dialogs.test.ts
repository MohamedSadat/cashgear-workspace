// The new-database dialog and the CSV import dialog drawn in jsdom: choosing a template and making
// it, and a file read, mapped, previewed and imported into the database.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../testing/dom';

installDom();
const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { createDatabaseI18n } = await import('../i18n');
const { seed, P } = await import('../testing/fixtures');
const { TemplatePicker } = await import('./TemplatePicker');
const { ImportDialog } = await import('../csv/ImportDialog');

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});
afterAll(() => (window as unknown as { close(): void }).close());

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
async function mount(node: ReturnType<typeof h>, language: 'en' | 'ar' = 'en') {
  root = createRoot(container);
  await act(async () =>
    root!.render(h(I18nextProvider, { i18n: createDatabaseI18n(language) }, node)),
  );
  await flush();
}
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')];
const button = (text: string) => buttons().find((b) => b.textContent?.trim() === text)!;
async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await flush();
}

describe('the new-database dialog', () => {
  it('lists an empty database and every template, and makes the one chosen', async () => {
    const { host } = seed(0);
    const created = vi.fn();
    const cancel = vi.fn();
    const place = { workspaceId: 'w', sectionId: 's', parentPageId: null, orderKey: 'a0' };
    await mount(h(TemplatePicker, { host, place, onCreated: created, onCancel: cancel }));
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.value)).toEqual([
      'blank',
      'tasks',
      'projects',
      'readingList',
      'meetingNotes',
      'contacts',
    ]);
    expect(document.body.textContent).toContain('Reading list');
    await click(radios[1]);
    await click(button('Create'));
    expect(created).toHaveBeenCalledTimes(1);
    const made = created.mock.calls[0][0];
    expect(made.title).toBe('Tasks');
    const ops = host.applied.map((op) => op.type);
    expect(ops[0]).toBe('page.create');
    expect(ops.filter((t) => t === 'view.upsert')).toHaveLength(4);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('is in Arabic in Arabic', async () => {
    const { host } = seed(0);
    const place = { workspaceId: 'w', sectionId: 's', parentPageId: null, orderKey: 'a0' };
    await mount(h(TemplatePicker, { host, place, onCreated: vi.fn(), onCancel: vi.fn() }), 'ar');
    expect(document.body.textContent).toContain('قاعدة بيانات جديدة');
    expect(document.body.textContent).toContain('جهات الاتصال');
    expect(button('أنشئ')).toBeTruthy();
  });
});

describe('the CSV import dialog', () => {
  it('reads a file, maps its columns by name, previews it and imports the rows', async () => {
    const { host, tasksId } = seed(2);
    const closed = vi.fn();
    await mount(h(ImportDialog, { host, databaseId: tasksId, onClose: closed }));
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(
      ['Name,Priority,Amount\r\nOne,High,5\r\nTwo,Brand new,x\r\n'],
      'tasks.csv',
      {
        type: 'text/csv',
      },
    );
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    await flush();
    expect(document.body.textContent).toContain('tasks.csv: 2 rows');
    const selects = [...document.querySelectorAll<HTMLSelectElement>('.cgw-csv-table select')];
    expect(selects.map((s) => s.value)).toEqual(['title', P.priority, P.amount]);
    expect(document.querySelectorAll('.cgw-csv-table td[data-problem]')).toHaveLength(1);
    await click(button('Import'));
    await flush();
    expect(document.body.textContent).toContain('Imported rows: 2');
    expect(document.body.textContent).toContain('Row 3, Amount: “x”');
    const types = host.applied.map((op) => op.type);
    expect(types).toEqual(['db.update', 'page.create', 'page.create']);
    expect(host.rowsOf(tasksId).map((r) => r.title)).toEqual(
      expect.arrayContaining(['One', 'Two']),
    );
    await click(button('Done'));
    expect(closed).toHaveBeenCalledWith({ databaseId: tasksId, created: 2 });
  });

  // Chrome on Windows with Excel installed types a .csv as Excel's; some systems type it not at all.
  const csv = (name: string, type: string) =>
    new File(['Name,Priority\r\nOne,High\r\n'], name, { type });
  async function choose(file: File) {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    await flush();
  }
  /** A drop on the picker's box, as a browser sends it (jsdom has no DataTransfer). */
  async function drop(file: File) {
    const zone = document.querySelector('[data-cg-file-picker]')!;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { types: ['Files'], files: [file], dropEffect: 'none' },
      });
      await act(async () => {
        zone.dispatchEvent(event);
      });
    }
    await flush();
    await flush();
  }
  const refused = () => document.querySelector('.cgw-csv-error[role="alert"]')?.textContent;

  it.each([
    ['the type Excel gives it', 'application/vnd.ms-excel'],
    ['no type', ''],
  ])('takes a .csv, .tsv or .txt file by its name, with %s, chosen or dropped', async (_, type) => {
    const { host, tasksId } = seed(1);
    await mount(h(ImportDialog, { host, databaseId: tasksId, onClose: vi.fn() }));
    await choose(csv('chosen.csv', type));
    expect(refused()).toBeUndefined();
    expect(document.body.textContent).toContain('chosen.csv: 1 rows');
    await drop(csv('dropped.TSV', type));
    expect(refused()).toBeUndefined();
    expect(document.body.textContent).toContain('dropped.TSV: 1 rows');
    await drop(csv('notes.txt', type));
    expect(document.body.textContent).toContain('notes.txt: 1 rows');
  });

  it('refuses a file whose name and type are neither CSV nor text, chosen or dropped', async () => {
    const { host, tasksId } = seed(1);
    await mount(h(ImportDialog, { host, databaseId: tasksId, onClose: vi.fn() }));
    await drop(csv('book.xls', 'application/vnd.ms-excel'));
    expect(refused()).toBe('The file could not be read.');
    expect(document.body.textContent).not.toContain('book.xls:');
    await choose(csv('book.xlsx', ''));
    expect(refused()).toBe('The file could not be read.');
    // A file named as CSV is still taken after a refusal.
    await choose(csv('tasks.csv', 'application/vnd.ms-excel'));
    expect(refused()).toBeUndefined();
    expect(document.body.textContent).toContain('tasks.csv: 1 rows');
  });
});
