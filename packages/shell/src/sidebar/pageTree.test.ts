// Phase 8, M8.2: the page tree as the library's tree view (Track U4): its rows' levels, names and
// selection, expanding kept on the device, Delete, moving by keys, renaming, the row's menu, and
// the app's shortcuts reaching the window while a row has focus. Component tests in jsdom, with
// `createElement`.
import { afterEach, describe, expect, it } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

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
const { localWorkspace } = await import('../../../workspace/src/testing/syncHarness');
const { createI18n } = await import('../i18n');
const { WorkspaceSession } = await import('../session');
const { PageTree } = await import('./PageTree');
const { expandedKey } = await import('./tree');

const roots: { unmount(): void }[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

async function until(check: () => boolean, what = 'the condition') {
  for (let i = 0; i < 400 && !check(); i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

/** A local workspace (section "Pages": Alpha > Beta, Gamma) and its tree, with a page open. */
async function open(active: 'Gamma' | null = null) {
  const store = new MemoryStore();
  const made = await localWorkspace(store);
  const session = await WorkspaceSession.start(store);
  session.switchTo(made.ws.id);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const errors: unknown[] = [];
  act(() =>
    root.render(
      h(
        I18nextProvider,
        { i18n: createI18n('en') },
        h(PageTree, {
          session,
          activePageId: active ? made.c.id : null,
          onError: (error: unknown) => errors.push(error),
        }),
      ),
    ),
  );
  await until(() => !!row('Gamma'), 'the tree');
  return { session, made, errors };
}

const tree = () => document.querySelector<HTMLElement>('[role="tree"]')!;
const rows = () => [...tree().querySelectorAll<HTMLElement>('[role="treeitem"]')];
const row = (title: string) =>
  rows().find((item) => item.querySelector('.cgw-tree-title')?.textContent === title);
/** A row's name: the text of what `aria-labelledby` names (the library names rows so), what is
 * hidden from assistive technology left out. */
const nameOf = (item: HTMLElement) =>
  (item.getAttribute('aria-labelledby') ?? '')
    .split(' ')
    .map((id) => {
      const copy = document.getElementById(id)?.cloneNode(true) as HTMLElement | undefined;
      copy?.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
      return copy?.textContent ?? '';
    })
    .join(' ')
    .trim();
const press = (target: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  });

describe('the page tree', () => {
  it('draws sections at level 1 and their pages below, named by their titles, the open page selected', async () => {
    await open('Gamma');
    expect(tree().getAttribute('aria-label')).toBe('Pages');
    const section = rows()[0];
    expect(section.getAttribute('aria-level')).toBe('1');
    expect(section.querySelector('.cgw-tree-section-name')!.textContent).toBe('Pages');
    // A heading: always open, no toggle; named by its name alone.
    expect(section.getAttribute('aria-expanded')).toBe('true');
    expect(section.querySelector('[data-cg-tree-row] > button')).toBeNull();
    expect(nameOf(section)).toBe('Pages');
    // A section's own buttons: a database or a page in it.
    expect(
      [...section.querySelectorAll('[data-cg-tree-actions] button')].map((b) =>
        b.getAttribute('aria-label'),
      ),
    ).toEqual(['Add a database in Pages', 'Add a page in Pages']);
    const alpha = row('Alpha')!;
    const gamma = row('Gamma')!;
    expect(alpha.getAttribute('aria-level')).toBe('2');
    expect([alpha.getAttribute('aria-posinset'), alpha.getAttribute('aria-setsize')]).toEqual([
      '1',
      '2',
    ]);
    // The open page: selected, and the current page.
    expect(gamma.getAttribute('aria-selected')).toBe('true');
    expect(gamma.getAttribute('aria-current')).toBe('page');
    expect(alpha.getAttribute('aria-selected')).toBe('false');
    expect(alpha.hasAttribute('aria-current')).toBe(false);
    // Each row is named by its title alone (its toggle and buttons apart).
    expect(nameOf(alpha)).toBe('Alpha');
    expect(nameOf(gamma)).toBe('Gamma');
    expect(alpha.getAttribute('aria-expanded')).toBe('false');
    expect(alpha.querySelector('[data-cg-tree-row] > button')!.getAttribute('aria-label')).toBe(
      'Expand Alpha',
    );
    // A row that does not open has no toggle.
    expect(gamma.hasAttribute('aria-expanded')).toBe(false);
    expect(gamma.querySelector('[data-cg-tree-row] > button')).toBeNull();
    expect(
      [...gamma.querySelectorAll('[data-cg-tree-actions] button')].map((b) =>
        b.getAttribute('aria-label'),
      ),
    ).toEqual(['Page actions', 'Add a page inside']);
  });

  it('opens a row by key, and keeps that on the device', async () => {
    const { session, made } = await open();
    const alpha = row('Alpha')!;
    press(alpha, 'ArrowRight');
    await until(() => !!row('Beta'), 'Beta shown');
    expect(row('Alpha')!.getAttribute('aria-expanded')).toBe('true');
    expect(row('Beta')!.getAttribute('aria-level')).toBe('3');
    await until(() => true);
    expect(await session.store.getPref<string[]>(expandedKey(made.ws.id))).toEqual([made.a.id]);
    press(row('Alpha')!, 'ArrowLeft');
    await until(() => !row('Beta'), 'Beta hidden');
    expect(await session.store.getPref<string[]>(expandedKey(made.ws.id))).toEqual([]);
  });

  it('a section does not fold', async () => {
    await open();
    const section = rows()[0];
    expect(section.getAttribute('aria-expanded')).toBe('true');
    press(section, 'ArrowLeft');
    await until(() => true);
    expect(rows()[0].getAttribute('aria-expanded')).toBe('true');
    expect(row('Gamma')).toBeDefined();
  });

  it('moves a page among its siblings by Alt+Shift and an arrow, and trashes one by Delete', async () => {
    const { session, made } = await open();
    press(row('Alpha')!, 'ArrowDown', { altKey: true, shiftKey: true });
    await until(
      () =>
        session.mirror
          .topPages(made.section.id)
          .map((p) => p.title)
          .join() === 'Gamma,Alpha',
      'Alpha after Gamma',
    );
    press(row('Gamma')!, 'Delete');
    await until(() => !!session.mirror.pages.get(made.c.id)?.trashedAt, 'Gamma trashed');
  });

  it('renames a page in its row: F2, the new title, Enter', async () => {
    const { session, made } = await open();
    press(row('Gamma')!, 'F2');
    const field = () => tree().querySelector<HTMLInputElement>('input[aria-label="Page title"]');
    await until(() => !!field(), 'the rename field');
    expect(field()!.value).toBe('Gamma');
    act(() => {
      field()!.value = 'Gamma 2';
      field()!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    press(field()!, 'Enter');
    await until(() => session.mirror.pages.get(made.c.id)?.title === 'Gamma 2', 'the new title');
  });

  it('opens a page’s actions on the menu key, and hands the app’s shortcuts to the window', async () => {
    await open();
    press(row('Gamma')!, 'F10', { shiftKey: true });
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.getAttribute('aria-label')).toBe('Page actions');
    expect([...menu!.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent)).toContain(
      'Move to trash',
    );
    act(() =>
      (document.querySelector('.cgw-menu-backdrop') as HTMLElement).dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      ),
    );
    const seen: string[] = [];
    const listen = (event: KeyboardEvent) =>
      seen.push(`${event.ctrlKey ? 'Ctrl+' : ''}${event.code}`);
    window.addEventListener('keydown', listen);
    press(row('Gamma')!, 'k', { code: 'KeyK', ctrlKey: true });
    window.removeEventListener('keydown', listen);
    expect(seen).toEqual(['Ctrl+KeyK']);
  });
});
