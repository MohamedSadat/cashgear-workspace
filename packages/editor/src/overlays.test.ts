// The editor's overlays on `@cashgear/ui` (Phase 8, Track U1 to U3). The slash and "@" menus are
// CgCommandMenu at the caret: the editor keeps the focus and hands the menu its arrows, Enter and
// Tab (Home and End stay the text's), and names the active option by `aria-activedescendant`. The
// block handle's button and drop line are CgDragHandle and CgDropIndicator, moved by a pointer
// drag (cgTrackDrag) that Escape ends without a move. The touch toolbar is a docked
// CgSelectionToolbar whose presses leave the focus in the editor.
import { afterEach, describe, expect, it } from 'vitest';
import { installDom, pressKey } from './testing';

installDom();
const target = globalThis as unknown as Record<string, unknown>;
for (const name of [
  'HTMLButtonElement',
  'HTMLSpanElement',
  'HTMLDivElement',
  'SVGElement',
  'FocusEvent',
  'MouseEvent',
  'PointerEvent',
  'UIEvent',
  'CustomEvent',
]) {
  const value = (window as unknown as Record<string, unknown>)[name];
  if (value !== undefined && target[name] === undefined) target[name] = value;
}
target.IS_REACT_ACT_ENVIRONMENT = true;
// What jsdom lacks: CSS.escape (the menu scrolls its active option into view), layout, media.
target.CSS ??= { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) };
const rangeProto = window.Range.prototype as unknown as Record<string, unknown>;
rangeProto.getClientRects ??= () => [];
rangeProto.getBoundingClientRect ??= () => ({
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  width: 0,
  height: 0,
});
const elementProto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
elementProto.scrollIntoView ??= () => {};
let touch = false;
target.matchMedia = () => ({
  matches: touch,
  addEventListener: () => {},
  removeEventListener: () => {},
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const Y = await import('yjs');
const { TextSelection } = await import('@tiptap/pm/state');
const { build, documentSchema, writeJSON, CONTENT } = await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const { EditorOverlays } = await import('./ui/EditorOverlays');
const blocks = await import('./blocks');
type EditorHost = import('./host').EditorHost;
type SlashItem = import('./host').SlashItem;

const { docOf, paragraph } = build;
const strings = {
  commandMenu: 'Commands',
  noCommands: 'No matching commands',
  pagePicker: 'Link to a page',
  noPages: 'No matching pages',
  mentionPages: 'Pages',
  mentionDates: 'Date',
  dateToday: 'Today',
  dateTomorrow: 'Tomorrow',
  datePick: 'Pick a date',
  dragHandle: 'Drag to move, click for the block menu',
  formatting: 'Formatting',
  touchToolbar: 'Block tools',
  insertBlock: 'Insert a block',
  bold: 'Bold',
  italic: 'Italic',
  moveUp: 'Move up',
  moveDown: 'Move down',
  indent: 'Indent',
  outdent: 'Outdent',
  blockMenu: 'Block menu',
  turnInto: 'Turn into',
  duplicate: 'Duplicate',
  deleteBlock: 'Delete',
  untitled: 'Untitled',
} as never;

const COMMANDS: SlashItem[] = [
  { id: 'block.heading1', label: 'Heading 1', glyph: 'heading-1', group: 'Basic blocks' },
  { id: 'block.heading2', label: 'Heading 2', glyph: 'heading-2', group: 'Basic blocks' },
  { id: 'block.plugin:chart', label: 'Chart', glyph: '▥', group: 'Insert' },
];

const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await act(async () => cleanup());
  touch = false;
});

async function setup(texts = ['alpha', 'beta', 'gamma']) {
  const ran: string[] = [];
  const pageId = '01936f6e-0000-7000-8000-0000000000c1';
  const host: EditorHost = {
    strings,
    shortcut: (chord) => chord,
    slash: {
      list: (query) => COMMANDS.filter((c) => c.label.toLowerCase().includes(query.toLowerCase())),
      run: (id) => void ran.push(id),
    },
    pages: {
      title: () => 'Notes',
      icon: () => null,
      exists: () => true,
      open: () => {},
      create: async () => null,
      search: (query) =>
        'notes'.startsWith(query.toLowerCase()) ? [{ id: pageId, title: 'Notes', icon: '📝' }] : [],
      subscribe: () => () => {},
    },
  };
  const doc = new Y.Doc();
  writeJSON(
    doc.getXmlFragment(CONTENT),
    documentSchema(),
    docOf(...texts.map((text) => paragraph(text))),
  );
  // The editor's frame, as BlockEditorView draws it: the handle is placed in it.
  const frame = document.createElement('div');
  frame.className = 'cgw-editor-frame';
  const element = document.createElement('div');
  const overlays = document.createElement('div');
  frame.append(element, overlays);
  document.body.append(frame);
  const be = createBlockEditor({
    element,
    fragment: doc.getXmlFragment(CONTENT),
    host,
    schedule: () => {},
  });
  be.editor.view.dom.tabIndex = 0;
  const root = createRoot(overlays);
  await act(async () => root.render(createElement(EditorOverlays, { editor: be, host })));
  cleanups.push(() => {
    root.unmount();
    be.destroy();
    frame.remove();
  });
  const editor = be.editor;
  const view = editor.view;
  /** The caret at the end of a block's text, the editor focused. */
  const end = async (index = 0) => {
    await act(async () => {
      view.dom.focus();
      const body = blocks.firstBody(blocks.listBlocks(editor.state.doc)[index])!;
      view.dispatch(
        editor.state.tr.setSelection(
          TextSelection.create(editor.state.doc, body.pos + 1 + body.node.content.size),
        ),
      );
    });
  };
  /** Types as a browser would, through ProseMirror's text input. */
  const type = async (text: string) => {
    await act(async () => {
      for (const char of text) {
        const { from, to } = editor.state.selection;
        const handled = view.someProp('handleTextInput', (f) =>
          f(view, from, to, char, () => editor.state.tr.insertText(char, from, to)),
        );
        if (!handled) view.dispatch(editor.state.tr.insertText(char, from, to));
      }
    });
  };
  const press = async (key: string) => {
    let used = false;
    await act(async () => {
      used = pressKey(view, key);
    });
    return used;
  };
  const texts_ = () =>
    blocks.listBlocks(editor.state.doc).map((b) => b.node.firstChild?.textContent ?? '');
  return { be, editor, view, frame, ran, end, type, press, texts: texts_, pageId };
}

const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const activeOption = () => options().find((o) => o.getAttribute('aria-selected') === 'true');

describe('the slash menu', () => {
  it('is a named list at the caret, driven by the editor’s keys while the editor keeps focus', async () => {
    const { view, end, type, press, ran, texts } = await setup();
    await end(0);
    await type(' /hea');
    expect(listbox()?.getAttribute('aria-label')).toBe('Commands');
    expect(options().map((o) => o.textContent)).toEqual(['Heading 1', 'Heading 2']);
    // Block icons are CgIcon's drawings.
    expect(options()[0].querySelector('svg')).not.toBeNull();
    expect(activeOption()?.textContent).toBe('Heading 1');
    expect(view.dom.getAttribute('aria-activedescendant')).toBe(activeOption()!.id);
    expect(await press('ArrowDown')).toBe(true);
    expect(activeOption()?.textContent).toBe('Heading 2');
    expect(view.dom.getAttribute('aria-activedescendant')).toBe(activeOption()!.id);
    // Home and End stay the text's.
    expect(await press('Home')).toBe(false);
    expect(activeOption()?.textContent).toBe('Heading 2');
    expect(await press('Enter')).toBe(true);
    expect(ran).toEqual(['block.heading2']);
    // The `/query` is gone, and so is the menu.
    expect(texts()[0]).toBe('alpha ');
    expect(listbox()).toBeNull();
    expect(view.dom.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('chooses with Tab, wraps with the arrows, draws an emoji as given, and Escape closes it', async () => {
    const { view, end, type, press, ran, texts } = await setup();
    await end(1);
    await type(' /');
    expect(options()).toHaveLength(3);
    expect(options()[2].textContent).toBe('▥Chart');
    expect(await press('ArrowUp')).toBe(true);
    expect(activeOption()?.textContent).toBe('▥Chart');
    expect(await press('Tab')).toBe(true);
    expect(ran).toEqual(['block.plugin:chart']);
    await type('/zz');
    expect(listbox()).toBeNull();
    expect(document.body.textContent).toContain('No matching commands');
    // Escape closes it and leaves what was typed.
    expect(await press('Escape')).toBe(true);
    expect(texts()[1]).toBe('beta /zz');
    expect(document.body.textContent).not.toContain('No matching commands');
    expect(view.dom.hasAttribute('aria-activedescendant')).toBe(false);
  });
});

describe('the "@" menu', () => {
  it('lists pages and dates at the caret and puts the chosen page in', async () => {
    const { editor, end, type, press, pageId } = await setup();
    await end(0);
    await type(' @not');
    expect(listbox()?.getAttribute('aria-label')).toBe('Link to a page');
    expect(activeOption()?.textContent).toBe('📝Notes');
    expect(await press('Enter')).toBe(true);
    const inline: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'pageMention') inline.push(node.attrs.pageId as string);
    });
    expect(inline).toEqual([pageId]);
    expect(listbox()).toBeNull();
  });
});

describe('the block handle', () => {
  const fire = (on: EventTarget, name: string, extra: Record<string, unknown> = {}) => {
    const event = new Event(name, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ pointerId: 1, button: 0, ...extra }))
      Object.defineProperty(event, key, { value });
    on.dispatchEvent(event);
  };
  const frameTick = () => new Promise<void>((resolve) => setTimeout(resolve, 40));

  it('draws the library’s handle and drop line; a drag shows the line, Escape ends it, a release moves', async () => {
    const { view, frame, texts, be } = await setup();
    const handle = frame.querySelector<HTMLElement>('.cgw-handle')!;
    expect(handle.getAttribute('aria-hidden')).toBe('true');
    const button = handle.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe(strings['dragHandle' as never]);
    expect(button.tabIndex).toBe(-1);
    const line = frame.querySelector<HTMLElement>('[data-cg-drop-indicator]')!;
    expect(line.hidden).toBe(true);
    expect(be.ui.dropIndicator).toBeTruthy();

    const first = blocks.listBlocks(view.state.doc)[0];
    const last = view.nodeDOM(blocks.listBlocks(view.state.doc)[2].pos) as HTMLElement;
    const root = document as unknown as { elementFromPoint?: () => Element };
    root.elementFromPoint = () => last.firstElementChild!;
    try {
      handle.dataset.pos = String(first.pos);
      fire(button, 'pointerdown', { clientX: 0, clientY: 0 });
      fire(window, 'pointermove', { clientX: 0, clientY: 10 });
      await act(frameTick);
      expect(line.hidden).toBe(false);
      expect(frame.classList.contains('is-dragging-block')).toBe(true);
      expect(document.querySelector('.cgw-block-ghost')?.textContent).toBe('alpha');
      // Escape: no move, the line and the copy gone.
      fire(window, 'keydown', { key: 'Escape' });
      expect(line.hidden).toBe(true);
      expect(document.querySelector('.cgw-block-ghost')).toBeNull();
      fire(window, 'pointerup', { clientX: 0, clientY: 10 });
      expect(texts()).toEqual(['alpha', 'beta', 'gamma']);

      fire(button, 'pointerdown', { clientX: 0, clientY: 0 });
      fire(window, 'pointermove', { clientX: 0, clientY: 10 });
      fire(window, 'pointerup', { clientX: 0, clientY: 10 });
      expect(texts()).toEqual(['beta', 'gamma', 'alpha']);
      expect(frame.classList.contains('is-dragging-block')).toBe(false);
    } finally {
      delete root.elementFromPoint;
    }
  });

  it('opens the block menu on a click, and keeps the editor’s focus on a press', async () => {
    const { view, frame, end } = await setup();
    await end(1);
    const handle = frame.querySelector<HTMLElement>('.cgw-handle')!;
    handle.dataset.pos = String(blocks.listBlocks(view.state.doc)[1].pos);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    handle.querySelector('button')!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await act(async () => handle.querySelector('button')!.click());
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Block menu');
  });
});

describe('the touch toolbar', () => {
  it('is a docked, named toolbar whose tools act on the caret’s block and keep the focus', async () => {
    touch = true;
    const { view, end, texts } = await setup(['alpha', 'beta', 'gammas']);
    await end(2);
    const bar = document.querySelector<HTMLElement>('[data-cg-selection-toolbar="docked"]')!;
    expect(bar.classList.contains('cgw-touchbar')).toBe(true);
    const toolbar = bar.querySelector('[role="toolbar"]')!;
    expect(toolbar.getAttribute('aria-label')).toBe('Block tools');
    const tool = (name: string) =>
      bar.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
    expect([...bar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual([
      'Insert a block',
      'Bold',
      'Italic',
      'Move up',
      'Move down',
      'Indent',
      'Outdent',
      'Block menu',
      'Done editing',
    ]);
    // Indent and Outdent have the library's right-to-left drawings too.
    for (const name of ['Indent', 'Outdent'])
      expect(tool(name).querySelector('svg [data-cg-icon-rtl]'), name).not.toBeNull();
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    tool('Move up').dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await act(async () => tool('Move up').click());
    expect(texts()).toEqual(['alpha', 'gammas', 'beta']);
    expect(document.activeElement).toBe(view.dom);
    expect(tool('Bold').getAttribute('aria-pressed')).toBe('false');
    await act(async () => tool('Bold').click());
    expect(tool('Bold').getAttribute('aria-pressed')).toBe('true');
    // Insert opens the slash menu at the caret, as typing ` /` would.
    await act(async () => tool('Insert a block').click());
    expect(listbox()?.getAttribute('aria-label')).toBe('Commands');
    expect(texts()[1]).toBe('gammas /');
  });

  it('leaves the editor on Done editing, and is gone with its focus', async () => {
    touch = true;
    const { view, end } = await setup();
    await end(1);
    const done = () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Done editing"]');
    expect(done()?.classList.contains('cgw-touchbar-done')).toBe(true);
    await act(async () => done()!.click());
    expect(document.activeElement).not.toBe(view.dom);
    expect(document.getSelection()?.rangeCount).toBe(0);
    expect(document.querySelector('[data-cg-selection-toolbar="docked"]')).toBeNull();
  });

  it('sits at the visual viewport’s foot, followed as it moves', async () => {
    touch = true;
    const listeners: Record<string, (() => void)[]> = {};
    const viewport = {
      height: 400,
      offsetTop: 0,
      addEventListener: (name: string, listener: () => void) =>
        (listeners[name] ??= []).push(listener),
      removeEventListener: (name: string, listener: () => void) =>
        (listeners[name] = (listeners[name] ?? []).filter((l) => l !== listener)),
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    cleanups.push(() => void delete (window as { visualViewport?: unknown }).visualViewport);
    const { end } = await setup();
    await end(1);
    const bar = () => document.querySelector<HTMLElement>('[data-cg-selection-toolbar="docked"]')!;
    expect(bar().style.insetBlockStart).toBe('400px');
    expect(bar().style.insetBlockEnd).toBe('auto');
    expect(bar().style.transform).toBe('translateY(-100%)');
    // Safari scrolls the caret into view by moving the visual viewport down the layout viewport.
    viewport.offsetTop = 180;
    await act(async () => listeners.scroll?.forEach((listener) => listener()));
    expect(bar().style.insetBlockStart).toBe('580px');
  });
});
