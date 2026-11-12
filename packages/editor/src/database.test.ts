// The database view block (schema version 3): a frame the host draws into, mounted lazily near the
// viewport and unmounted far from it, never mounted again per transaction (D26); a placeholder
// without a host or a database; inserted by "Database" and "Linked view"; an atom like the others
// for the keyboard, the block menu and the clipboard, which keeps it a link to the same database.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { installDom } from './testing';

installDom();
const { pressKey } = await import('./testing');
const editors: { destroy(): void }[] = [];
afterAll(() => {
  for (const editor of editors) editor.destroy();
});
const Y = await import('yjs');
const { NodeSelection, TextSelection } = await import('@tiptap/pm/state');
const { DOMParser: PMDOMParser, DOMSerializer, Slice } = await import('@tiptap/pm/model');
const { build, documentSchema, writeJSON, fragmentToJSON, CONTENT } = await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const { actionByName } = await import('./actions');
const blocks = await import('./blocks');
const { CLIPBOARD_TYPE } = await import('./clipboard');
const { NEAR_MARGIN, FAR_MARGIN } = await import('./nodeviews/database');
type EditorHost = import('./host').EditorHost;
type DatabaseMountOptions = import('./host').DatabaseMountOptions;

const { docOf, paragraph, databaseView, toggle } = build;
const DATABASE = '01936f6e-0000-7000-8000-0000000000d1';
const VIEW = '01936f6e-0000-7000-8000-0000000000d2';
const OTHER_VIEW = '01936f6e-0000-7000-8000-0000000000d3';
const strings = {
  databaseView: 'Database',
  databaseUnavailable: 'Cannot be shown here',
  databaseNotChosen: 'No database chosen',
  databaseChoose: 'Choose a database',
} as never;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A host that draws a database as an input and records every mount and unmount. */
function databaseHost(extra: Partial<NonNullable<EditorHost['databases']>> = {}) {
  const mounts: { element: HTMLElement; options: DatabaseMountOptions }[] = [];
  let unmounts = 0;
  const host: EditorHost = {
    strings,
    databases: {
      mount(element, options) {
        mounts.push({ element, options });
        const input = document.createElement('input');
        input.className = 'cell';
        input.value = `${options.databaseId}:${options.viewId}`;
        element.append(input);
        return () => {
          unmounts++;
          input.remove();
        };
      },
      ...extra,
    },
  };
  return { host, mounts, unmounts: () => unmounts };
}

function setup(
  json = docOf(paragraph('before'), databaseView(DATABASE, VIEW), paragraph('after')),
  host: EditorHost = { strings },
) {
  const doc = new Y.Doc();
  writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), json);
  const element = document.createElement('div');
  document.body.append(element);
  const be = createBlockEditor({
    element,
    fragment: doc.getXmlFragment(CONTENT),
    host,
    schedule: () => {},
  });
  editors.push(be);
  const editor = be.editor;
  const list = () => blocks.listBlocks(editor.state.doc);
  const bodyOf = (index: number) => blocks.firstBody(list()[index])!;
  const caret = (index: number, offset: number) =>
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, bodyOf(index).pos + 1 + offset),
      ),
    );
  const views = () => [...element.querySelectorAll<HTMLElement>('.cgw-databaseView')];
  return { doc, be, editor, element, list, bodyOf, caret, views };
}

describe('the database view block', () => {
  it('draws a placeholder when the host cannot draw databases', async () => {
    const { views } = setup();
    await tick();
    const [view] = views();
    expect(view.dataset.body).toBe('databaseView');
    expect(view.getAttribute('aria-label')).toBe('Database');
    expect(view.querySelector('.cgw-database-placeholder')!.textContent).toBe(
      'Cannot be shown here',
    );
    expect(view.querySelector<HTMLElement>('.cgw-database-frame')!.hidden).toBe(true);
  });

  it('without a database, offers to choose one and then shows it', async () => {
    const { host, mounts } = databaseHost({
      pick: async () => ({ databaseId: DATABASE, viewId: null }),
    });
    const { views, editor, bodyOf } = setup(docOf(paragraph('a'), databaseView(null)), host);
    await tick();
    const placeholder = views()[0].querySelector('.cgw-database-placeholder')!;
    expect(placeholder.textContent).toContain('No database chosen');
    placeholder.querySelector<HTMLButtonElement>('button')!.click();
    await tick();
    await tick();
    expect(bodyOf(1).node.attrs).toEqual({ databaseId: DATABASE, viewId: null });
    expect(mounts).toHaveLength(1);
    expect(mounts[0].options.viewId).toBeNull();
    expect(editor.state.doc.toJSON()).toBeTruthy();
  });

  it("mounts the host's view in its frame once, with its database, view, block and editability", async () => {
    const { host, mounts, unmounts } = databaseHost();
    const { views, list, caret, editor } = setup(undefined, host);
    expect(mounts).toHaveLength(0); // Not before the block is in the page.
    await tick();
    expect(mounts).toHaveLength(1);
    const { element, options } = mounts[0];
    expect(element.classList.contains('cgw-database-frame')).toBe(true);
    expect(views()[0].contains(element)).toBe(true);
    expect(options).toMatchObject({
      databaseId: DATABASE,
      viewId: VIEW,
      blockId: list()[1].id,
      editable: true,
    });
    // Typing elsewhere, many times: the frame is never mounted again (D26).
    caret(0, 6);
    for (let i = 0; i < 50; i++) editor.view.dispatch(editor.state.tr.insertText('x'));
    caret(2, 0);
    editor.view.dispatch(editor.state.tr.insertText('y'));
    await tick();
    expect(mounts).toHaveLength(1);
    expect(unmounts()).toBe(0);
    expect(views()[0].querySelector('input.cell')).not.toBeNull();
  });

  it("mounts again when its block's id changes (ProseMirror keeps the view itself)", async () => {
    const { host, mounts, unmounts } = databaseHost();
    const { editor, list } = setup(undefined, host);
    await tick();
    const first = mounts[0].options.blockId;
    const block = list()[1];
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(block.pos, undefined, { id: 'Repaired0001' }),
    );
    expect(unmounts()).toBe(1);
    expect(mounts.map((m) => m.options.blockId)).toEqual([first, 'Repaired0001']);
  });

  it('mounts again when its view changes, and unmounts when it goes', async () => {
    const { host, mounts, unmounts } = databaseHost();
    const { editor, list, doc } = setup(undefined, host);
    await tick();
    mounts[0].options.setViewId(OTHER_VIEW);
    expect(unmounts()).toBe(1);
    expect(mounts).toHaveLength(2);
    expect(mounts[1].options.viewId).toBe(OTHER_VIEW);
    // Saved like any edit of the page.
    expect(JSON.stringify(fragmentToJSON(doc.getXmlFragment(CONTENT)))).toContain(OTHER_VIEW);
    // Deleting the block only unmounts the frame: the editor never deletes a database.
    const block = list()[1];
    editor.view.dispatch(blocks.deleteBlock(editor.state, block));
    expect(unmounts()).toBe(2);
    expect(JSON.stringify(editor.getJSON())).not.toContain('databaseView');
  });

  it('mounts again with the editability, and read-only content mounts read-only', async () => {
    const { host, mounts, unmounts } = databaseHost();
    const { be } = setup(undefined, host);
    await tick();
    be.editor.setEditable(false);
    expect(unmounts()).toBe(1);
    expect(mounts.map((m) => m.options.editable)).toEqual([true, false]);
    // Not editable: the view cannot point the block elsewhere.
    mounts[1].options.setViewId(OTHER_VIEW);
    expect(mounts).toHaveLength(2);

    const other = databaseHost();
    const element = document.createElement('div');
    document.body.append(element);
    const reader = createBlockEditor({
      element,
      readOnlyContent: docOf(databaseView(DATABASE)) as never,
      host: other.host,
    });
    editors.push(reader);
    await tick();
    expect(other.mounts).toHaveLength(1);
    expect(other.mounts[0].options).toMatchObject({
      databaseId: DATABASE,
      viewId: null,
      editable: false,
    });
  });

  it('follows the host: mounted once it can draw databases, unmounted when it no longer can', async () => {
    const { be, views } = setup();
    await tick();
    expect(views()[0].querySelector('.cgw-database-placeholder')!.textContent).toBe(
      'Cannot be shown here',
    );
    const { host, mounts, unmounts } = databaseHost();
    be.setHost(host);
    expect(mounts).toHaveLength(1);
    // Another host that draws databases (another language, say): not mounted again.
    be.setHost({
      ...host,
      strings: { ...(strings as object), databaseView: 'قاعدة بيانات' } as never,
    });
    expect(mounts).toHaveLength(1);
    expect(views()[0].getAttribute('aria-label')).toBe('قاعدة بيانات');
    be.setHost({ strings });
    expect(unmounts()).toBe(1);
    expect(views()[0].querySelector<HTMLElement>('.cgw-database-placeholder')!.hidden).toBe(false);
  });

  it("keeps the frame's keys and clicks to itself; elsewhere it is an atom like the others", async () => {
    const { host } = databaseHost();
    const { editor, views, bodyOf, list } = setup(undefined, host);
    await tick();
    const body = bodyOf(1);
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, body.pos)),
    );
    // A Backspace typed in the frame's input is the frame's own.
    const input = views()[0].querySelector<HTMLInputElement>('input.cell')!;
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
    );
    expect(list()).toHaveLength(3);
    // With the block selected, Backspace in the editor deletes it, as for an image.
    expect(pressKey(editor.view, 'Backspace')).toBe(true);
    expect(list().map((b) => blocks.firstBody(b)!.node.type.name)).toEqual([
      'textBody',
      'textBody',
    ]);
  });

  it('the block menu works on it: a duplicate is another view of the same database', async () => {
    const { host, mounts } = databaseHost();
    const { editor, list } = setup(undefined, host);
    await tick();
    editor.view.dispatch(blocks.duplicateBlock(editor.state, list()[1]));
    await tick();
    const views = list().filter((b) => blocks.firstBody(b)!.node.type.name === 'databaseView');
    expect(views).toHaveLength(2);
    expect(views[0].id).not.toBe(views[1].id);
    expect(views.map((b) => blocks.firstBody(b)!.node.attrs.databaseId)).toEqual([
      DATABASE,
      DATABASE,
    ]);
    expect(mounts).toHaveLength(2);
    // Moved down past the paragraph: still the same database.
    const moved = blocks.moveSibling(editor.state, list()[1], 1);
    if (moved) editor.view.dispatch(moved);
    expect(
      list()
        .map((b) => blocks.firstBody(b)!.node)
        .filter((n) => n.type.name === 'databaseView')
        .map((n) => n.attrs.databaseId),
    ).toEqual([DATABASE, DATABASE]);
  });

  it('copy and paste keep it a link to the same database, in a new block', async () => {
    const { editor, list, caret, bodyOf } = setup();
    const schema = editor.schema;
    const original = list()[1];
    const slice = editor.state.doc.slice(original.pos, original.pos + original.node.nodeSize);
    // Our own format.
    const data = new Map<string, string>([
      [CLIPBOARD_TYPE, JSON.stringify({ format: 'cgw-slice', version: 1, slice: slice.toJSON() })],
    ]);
    const paste = (types: Map<string, string>) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { files: [], getData: (type: string) => types.get(type) ?? '' },
      });
      return editor.view.someProp('handlePaste', (f) =>
        f(editor.view, event as never, Slice.empty),
      );
    };
    caret(2, 5);
    expect(paste(data)).toBe(true);
    const views = list().filter((b) => blocks.firstBody(b)!.node.type.name === 'databaseView');
    expect(views).toHaveLength(2);
    expect(views[1].id).not.toBe(original.id);
    expect(blocks.firstBody(views[1])!.node.attrs).toEqual({ databaseId: DATABASE, viewId: VIEW });
    // HTML, as another editor or a browser would carry it.
    const holder = document.createElement('div');
    holder.append(DOMSerializer.fromSchema(schema).serializeFragment(slice.content));
    expect(holder.innerHTML).toContain(`data-databaseid="${DATABASE}"`);
    const parsed = PMDOMParser.fromSchema(schema).parse(holder);
    let found: Record<string, unknown> | null = null;
    parsed.descendants((node) => {
      if (node.type.name === 'databaseView') found = node.attrs;
    });
    expect(found).toEqual({ databaseId: DATABASE, viewId: VIEW });
    expect(bodyOf(0).node.type.name).toBe('textBody');
  });
});

describe('"Database" and "Linked view"', () => {
  it('insert a view of the database the host made or picked; nothing when it gives none', async () => {
    const created: string[] = [];
    const { host, mounts } = databaseHost({
      create: async () => {
        created.push('made');
        return { databaseId: DATABASE, viewId: VIEW };
      },
      pick: async () => ({ databaseId: DATABASE, viewId: OTHER_VIEW }),
    });
    const { editor, list, caret } = setup(docOf(paragraph('top'), paragraph('')), host);
    const database = actionByName('database')!;
    const linked = actionByName('linkedView')!;
    expect(database.turnInto || linked.turnInto).toBe(false);
    expect(database.available?.(host)).toBe(true);
    expect(database.available?.({})).toBe(false);
    expect(linked.available?.({ databases: { mount: () => () => {} } })).toBe(false);
    // In an empty paragraph: the block keeps its id and becomes the database view.
    caret(1, 0);
    const emptyId = list()[1].id;
    await database.apply(editor, host);
    expect(created).toEqual(['made']);
    expect(list()[1].id).toBe(emptyId);
    expect(blocks.firstBody(list()[1])!.node.toJSON()).toEqual({
      type: 'databaseView',
      attrs: { databaseId: DATABASE, viewId: VIEW },
    });
    // The caret goes to a new paragraph after it.
    expect(blocks.currentBlock(editor.state)?.pos).toBe(list()[2].pos);
    caret(0, 3);
    await linked.apply(editor, host);
    expect(blocks.firstBody(list()[1])!.node.attrs).toEqual({
      databaseId: DATABASE,
      viewId: OTHER_VIEW,
    });
    await tick();
    expect(mounts.map((m) => m.options.viewId).sort()).toEqual([OTHER_VIEW, VIEW].sort());
    // Cancelled, or no host: nothing is inserted.
    const count = list().length;
    await linked.apply(editor, { databases: { pick: async () => null } });
    await database.apply(editor, {});
    expect(list()).toHaveLength(count);
  });
});

describe('the database view block, lazily', () => {
  class FakeObserver {
    static all: FakeObserver[] = [];
    targets: Element[] = [];
    disconnected = false;
    constructor(
      readonly callback: (entries: { target: Element; isIntersecting: boolean }[]) => void,
      readonly options: { root: Element | null; rootMargin: string },
    ) {
      FakeObserver.all.push(this);
    }
    observe(target: Element) {
      this.targets.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
    fire(isIntersecting: boolean) {
      this.callback(this.targets.map((target) => ({ target, isIntersecting })));
    }
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeObserver.all = [];
  });

  it('mounts when it comes near the scrolled area and unmounts when it is far away', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    document.body.append(scroller);
    const { host, mounts, unmounts } = databaseHost();
    const doc = new Y.Doc();
    writeJSON(
      doc.getXmlFragment(CONTENT),
      documentSchema(),
      docOf(paragraph('a'), toggle(['holder'], [databaseView(DATABASE, VIEW)])),
    );
    const element = document.createElement('div');
    scroller.append(element);
    const be = createBlockEditor({ element, fragment: doc.getXmlFragment(CONTENT), host });
    await tick();
    const near = FakeObserver.all.find((o) => o.options.rootMargin === NEAR_MARGIN)!;
    const far = FakeObserver.all.find((o) => o.options.rootMargin === FAR_MARGIN)!;
    // Watched in the element that scrolls, by its top-level block (content-visibility: auto).
    expect(near.options.root).toBe(scroller);
    const top = be.editor.view.dom.children[1];
    expect(near.targets).toEqual([top]);
    expect(far.targets).toEqual([top]);
    expect(mounts).toHaveLength(0);
    far.fire(false);
    expect(mounts).toHaveLength(0);
    near.fire(true);
    expect(mounts).toHaveLength(1);
    near.fire(true);
    expect(mounts).toHaveLength(1);
    far.fire(false);
    expect(unmounts()).toBe(1);
    near.fire(true);
    expect(mounts).toHaveLength(2);
    be.destroy();
    expect(unmounts()).toBe(2);
    expect(near.disconnected && far.disconnected).toBe(true);
  });
});
