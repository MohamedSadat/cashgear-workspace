// Phase 8, M8.4: the import panel in English and Arabic: what to import and where, a Word file
// chosen and imported, the report of what was made and skipped, a refusal said plainly, and a
// stop that keeps nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { installDom } from '../../../../database/src/testing/dom';

installDom();
Object.assign(globalThis, {
  location: window.location,
  history: window.history,
  EventTarget: window.EventTarget,
});
const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { MemoryStore } = await import('@cgw/workspace');
const { localWorkspace } = await import('../../../../workspace/src/testing/syncHarness');
const { createI18n } = await import('../../i18n');
const { WorkspaceSession } = await import('../../session');
const { ImportPanel, sectionsForNewPages } = await import('./ImportPanel');
const { treeRows } = await import('../../sidebar/tree');
const { PageTree } = await import('../../sidebar/PageTree');
const { manyPages, notionExport, wordDocument } = await import('../fixtures/fixtures');
// The panel loads the runner when an import starts: loaded here first, as Vitest is slow to.
await import('./run');

const roots: { unmount(): void }[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

async function until(check: () => boolean, what = 'the condition') {
  for (let i = 0; i < 600 && !check(); i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

async function open(
  language: 'en' | 'ar' = 'en',
  store = new MemoryStore(),
  before?: (session: import('../../session').WorkspaceSession) => Promise<unknown>,
  /** The sidebar's page tree drawn beside the panel. */
  withTree = false,
) {
  const made = await localWorkspace(store);
  const session = await WorkspaceSession.start(store);
  session.switchTo(made.ws.id);
  await before?.(session);
  let closed = false;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const i18n = createI18n(language);
  act(() =>
    root.render(
      h(
        I18nextProvider,
        { i18n },
        withTree ? h(PageTree, { session, activePageId: null, onError: () => undefined }) : null,
        h(ImportPanel, { session, onClose: () => (closed = true), runOptions: { inline: true } }),
      ),
    ),
  );
  return { session, made, closed: () => closed };
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const button = (name: string) =>
  [...dialog().querySelectorAll('button')].find((b) => b.textContent === name)!;

/** The file input behind a picker (the library's file picker): the file's, or the folder's. */
const fileInput = (picker: 'file' | 'folder') =>
  dialog().querySelector<HTMLInputElement>(
    picker === 'file'
      ? '.cgw-import-file input[type="file"]'
      : '[data-cg-file-picker]:not(.cgw-import-file) input[type="file"]',
  )!;

function choose(picker: 'file' | 'folder', file: File) {
  const input = fileInput(picker);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  act(() => void input.dispatchEvent(new Event('change', { bubbles: true })));
}

const fileOf = (bytes: Uint8Array, name: string) =>
  new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'application/octet-stream' });

describe('the import panel', () => {
  it('shows what was made: the import’s top page expanded in the sidebar, the report open', async () => {
    const { session } = await open('en', new MemoryStore(), undefined, true);
    const row = (title: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="tree"] [role="treeitem"]')].find(
        (item) => item.querySelector('.cgw-tree-title')?.textContent === title,
      );
    await until(() => !!row('Alpha'), 'the tree');
    act(() => dialog().querySelector<HTMLInputElement>('input[value="notion"]')!.click());
    const fixture = notionExport();
    choose('file', fileOf(fixture.bytes, fixture.name));
    await until(() => !!dialog().querySelector('[data-testid="import-report"]'), 'the report');
    await until(() => row('Home')?.getAttribute('aria-expanded') === 'true', 'Home expanded');
    // Its pages and database show under it; the report is still open over Settings.
    for (const title of ['Projects', 'Meeting notes', 'Tasks'])
      expect(row(title), title).toBeDefined();
    expect(dialog().querySelector('[data-testid="import-report"]')).not.toBeNull();
    // Kept in the tree's own state, as ArrowRight would leave it.
    const ws = session.workspaceId!;
    const home = [...session.mirror.pages.values()].find((p) => p.title === 'Home')!;
    await until(() => true, 'a tick');
    expect(await session.store.getPref<string[]>(`tree/expanded/${ws}`)).toContain(home.id);
  });

  it('offers the sections the sidebar offers a new page in, and imports into the one chosen', async () => {
    const { session, made } = await open('en', new MemoryStore(), (s) => s.createSection('Second'));
    const ws = made.ws.id;
    const sidebar = treeRows(session.mirror, ws, new Set()).flatMap((row) =>
      row.kind === 'section' ? [row.section.id] : [],
    );
    expect(sectionsForNewPages(session).map((s) => s.id)).toEqual(sidebar);
    const select = dialog().querySelector<HTMLSelectElement>('select')!;
    expect([...select.options].map((o) => o.value)).toEqual(sidebar);
    expect([...select.labels].map((label) => label.textContent).join()).toContain('Section');
    const second = session.mirror.sectionsOf(ws).find((s) => s.name === 'Second')!;
    act(() => {
      select.value = second.id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => dialog().querySelector<HTMLInputElement>('input[value="word"]')!.click());
    const fixture = wordDocument();
    choose('file', fileOf(fixture.bytes, fixture.name));
    await until(() => !!dialog().querySelector('[data-testid="import-report"]'), 'the report');
    expect(session.mirror.topPages(second.id).map((p) => p.title)).toEqual(['Quarterly report']);
  });

  it('offers what to import, a folder for Markdown, and says where it goes', async () => {
    await open();
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById('cgw-dialog-title')!.textContent).toBe('Import pages');
    const radios = [...dialog().querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.value)).toEqual(['markdown', 'notion', 'word']);
    expect(radios[0].checked).toBe(true);
    expect(button('Choose a folder…')).toBeDefined();
    // The library's file picker asks the browser for a folder.
    expect(fileInput('folder').hasAttribute('webkitdirectory')).toBe(true);
    expect(dialog().textContent).toContain('one new page at the end of this section');
    expect(dialog().textContent).toContain('2,000 pages and 500 MB');
    act(() => radios[2].click());
    expect(button('Choose a folder…')).toBeUndefined();
    // The library's file picker: its button names it, and its dialog takes Word files.
    expect(button('Choose a file…')).toBeDefined();
    expect(fileInput('file').accept).toContain('.docx');
  });

  it('imports a Word file and shows what was made and what was skipped', async () => {
    const { session } = await open();
    act(() => dialog().querySelector<HTMLInputElement>('input[value="word"]')!.click());
    const fixture = wordDocument();
    choose('file', fileOf(fixture.bytes, fixture.name));
    await until(() => !!dialog().querySelector('[data-testid="import-report"]'), 'the report');
    const report = dialog().querySelector('[data-testid="import-report"]')!;
    expect(report.textContent).toContain('Pages: 1');
    expect(report.textContent).toContain('Images: 1');
    const skipped = [...report.querySelectorAll('[data-code]')].map((li) =>
      li.getAttribute('data-code'),
    );
    expect(skipped).toEqual(expect.arrayContaining(['trackedChanges', 'comments', 'textBoxes']));
    expect(report.querySelector('[data-code="comments"]')!.textContent).toBe('Comments: 1');
    expect([...session.mirror.pages.values()].some((p) => p.title === 'Quarterly report')).toBe(
      true,
    );
    expect(button('Open the imported page')).toBeDefined();
  });

  it('says plainly why nothing was imported, in Arabic too, right to left', async () => {
    await open('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.getElementById('cgw-dialog-title')!.textContent).toBe('استيراد صفحات');
    choose('file', fileOf(manyPages(2001), 'كثير.zip'));
    await until(() => !!dialog().querySelector('[role="alert"]'), 'the refusal');
    // In Arabic digits, as the interface writes numbers.
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain(
      (2002).toLocaleString('ar'),
    );
    expect(button('حاول مرة أخرى')).toBeDefined();
    act(() => button('حاول مرة أخرى').click());
    expect(dialog().querySelectorAll('input[type="radio"]')).toHaveLength(3);
  });

  it('stops when asked and keeps nothing', async () => {
    // The pages' documents wait until the test lets them through, so Stop lands mid-import.
    const store = new MemoryStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const append = store.appendDocUpdates.bind(store);
    store.appendDocUpdates = async (pageId, updates) => {
      await gate;
      return append(pageId, updates);
    };
    const { session, made } = await open('en', store);
    const pagesBefore = session.mirror.pages.size;
    choose('file', fileOf(manyPages(600), 'Many.zip'));
    await until(() => /Writing the pages/.test(dialog().textContent ?? ''), 'the writing');
    expect(dialog().querySelector('[role="progressbar"]')!.getAttribute('aria-label')).toBe(
      'Import progress',
    );
    act(() => button('Stop').click());
    expect(dialog().textContent).toContain('Stopping, and removing what was made');
    release();
    await until(() => !!dialog().querySelector('[role="alert"]'), 'the stop');
    expect(dialog().querySelector('[role="alert"]')!.textContent).toBe(
      'The import was stopped. Nothing was kept.',
    );
    expect(session.mirror.pages.size).toBe(pagesBefore);
    expect(session.mirror.topPages(made.section.id).map((p) => p.title)).toEqual([
      'Alpha',
      'Gamma',
    ]);
  }, 30_000);
});
