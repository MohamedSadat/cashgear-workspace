// Schema version 4's frame blocks: the workbook (`sheetEmbed`) and the ERP view (`erpView`), by the
// database view's rules (nodeviews/frame.ts): a frame mounted lazily near the viewport, destroyed
// far from it keeping its height, mounted again only when its key changes (the workbook or link,
// the block id, the editability), with any other change of its attributes sent to `update`; a
// placeholder without a host, with "Choose a workbook" and "New workbook" when it has none; and
// "Workbook", "Existing workbook" and "ERP data" in the slash menu.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { installDom } from './testing';

installDom();
const editors: { destroy(): void }[] = [];
afterAll(() => {
  for (const editor of editors) editor.destroy();
});
const Y = await import('yjs');
const { TextSelection } = await import('@tiptap/pm/state');
const { documentSchema, writeJSON, CONTENT, build } = await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const { actionByName } = await import('./actions');
const blocks = await import('./blocks');
const { NEAR_MARGIN, FAR_MARGIN } = await import('./nodeviews/frame');
type EditorHost = import('./host').EditorHost;
type SheetMountOptions = import('./host').SheetMountOptions;
type ErpMountOptions = import('./host').ErpMountOptions;

const { docOf, paragraph } = build;
const WORKBOOK = '01936f6e-0000-7000-8000-0000000000e1';
const OTHER = '01936f6e-0000-7000-8000-0000000000e2';
const LINK = '01936f6e-0000-7000-8000-0000000000e3';
const strings = {
  sheetEmbed: 'Workbook',
  sheetNotChosen: 'No workbook chosen.',
  sheetChoose: 'Choose a workbook',
  sheetCreate: 'New workbook',
  sheetUnavailable: 'Cannot be shown here',
  erpView: 'ERP data',
  erpNotChosen: 'No ERP data chosen.',
  erpUnavailable: 'ERP data cannot be shown here',
} as never;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const sheetEmbed = (attrs: Record<string, unknown> = {}) => ({
  type: 'sheetEmbed',
  attrs: { workbookId: WORKBOOK, sheet: null, range: null, chartId: null, height: null, ...attrs },
});
const erpView = (attrs: Record<string, unknown> = {}) => ({
  type: 'erpView',
  attrs: {
    linkId: null,
    connectorId: null,
    filter: null,
    fields: null,
    sort: null,
    pageSize: null,
    ...attrs,
  },
});
const block = (body: object) => build.block(body as never);

/** Frames that record every mount, update and destroy. */
function frames<Options>() {
  const mounts: { element: HTMLElement; options: Options }[] = [];
  const updates: Options[] = [];
  let destroys = 0;
  const mount = (element: HTMLElement, options: Options) => {
    mounts.push({ element, options });
    const input = document.createElement('input');
    input.className = 'cell';
    element.append(input);
    return {
      update: (next: Options) => void updates.push(next),
      destroy: () => {
        destroys++;
        input.remove();
      },
    };
  };
  return { mount, mounts, updates, destroys: () => destroys };
}

function setup(content: object[], host: EditorHost = { strings }) {
  const doc = new Y.Doc();
  writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), {
    type: 'doc',
    content: content.map((c) => ('type' in c && c.type === 'block' ? c : block(c))),
  } as never);
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
  const view = (name: string) => element.querySelector<HTMLElement>(`[data-body="${name}"]`)!;
  return { doc, be, editor, element, list, bodyOf, caret, view };
}

describe('the workbook block', () => {
  it('draws a placeholder without a host that draws workbooks', async () => {
    const { view } = setup([paragraph('a'), sheetEmbed()]);
    await tick();
    const dom = view('sheetEmbed');
    expect(dom.getAttribute('aria-label')).toBe('Workbook');
    expect(dom.getAttribute('role')).toBe('group');
    expect(dom.querySelector('.cgw-embed-placeholder')!.textContent).toBe('Cannot be shown here');
    expect(dom.querySelector<HTMLElement>('.cgw-embed-frame')!.hidden).toBe(true);
  });

  it('without a workbook, offers to choose one or make one, and then shows it', async () => {
    const drawn = frames<SheetMountOptions>();
    const host: EditorHost = {
      strings,
      workbooks: {
        mount: drawn.mount,
        pick: async () => ({ workbookId: WORKBOOK, sheet: 'Budget', range: 'A1:D20' }),
        create: async () => ({ workbookId: OTHER }),
      },
    };
    const { view, bodyOf } = setup([paragraph('a'), sheetEmbed({ workbookId: null })], host);
    await tick();
    const placeholder = view('sheetEmbed').querySelector('.cgw-embed-placeholder')!;
    expect(placeholder.textContent).toContain('No workbook chosen.');
    const buttons = [...placeholder.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Choose a workbook', 'New workbook']);
    buttons[0].click();
    await tick();
    await tick();
    expect(bodyOf(1).node.attrs).toEqual({
      workbookId: WORKBOOK,
      sheet: 'Budget',
      range: 'A1:D20',
      chartId: null,
      height: null,
    });
    expect(drawn.mounts).toHaveLength(1);
    expect(drawn.mounts[0].options).toMatchObject({
      workbookId: WORKBOOK,
      sheet: 'Budget',
      range: 'A1:D20',
      chartId: null,
      height: null,
      editable: true,
    });
  });

  it('offers nothing to choose when the page is read-only', async () => {
    const host: EditorHost = {
      strings,
      workbooks: { pick: async () => null, create: async () => null },
    };
    const { view, be } = setup([sheetEmbed({ workbookId: null })], host);
    be.editor.setEditable(false);
    await tick();
    expect(view('sheetEmbed').querySelectorAll('button')).toHaveLength(0);
  });

  it('mounts once; a view or height change goes to update, never a new frame', async () => {
    const drawn = frames<SheetMountOptions>();
    const { list, caret, editor, view } = setup(
      [paragraph('before'), sheetEmbed(), paragraph('')],
      {
        strings,
        workbooks: { mount: drawn.mount },
      },
    );
    expect(drawn.mounts).toHaveLength(0); // Not before the block is in the page.
    await tick();
    expect(drawn.mounts).toHaveLength(1);
    const { element, options } = drawn.mounts[0];
    expect(element.classList.contains('cgw-embed-frame')).toBe(true);
    expect(view('sheetEmbed').contains(element)).toBe(true);
    expect(options).toMatchObject({ workbookId: WORKBOOK, blockId: list()[1].id, editable: true });
    // Typing elsewhere: nothing is mounted or updated.
    caret(0, 6);
    for (let i = 0; i < 20; i++) editor.view.dispatch(editor.state.tr.insertText('x'));
    expect(drawn.mounts).toHaveLength(1);
    expect(drawn.updates).toHaveLength(0);
    // The frame changes the view and the height, as ordinary edits.
    options.setAttrs({ sheet: 'Budget', range: 'B2:C9' });
    options.setAttrs({ height: 300 });
    expect(drawn.mounts).toHaveLength(1);
    expect(drawn.destroys()).toBe(0);
    expect(drawn.updates.map((u) => [u.sheet, u.range, u.height])).toEqual([
      ['Budget', 'B2:C9', null],
      ['Budget', 'B2:C9', 300],
    ]);
    expect(blocks.firstBody(list()[1])!.node.attrs).toMatchObject({ range: 'B2:C9', height: 300 });
    // The input the frame drew is still there: the same frame.
    expect(view('sheetEmbed').querySelector('input.cell')).not.toBeNull();
  });

  it('mounts again for another workbook, block id or editability; removing it only destroys', async () => {
    const drawn = frames<SheetMountOptions>();
    const { list, editor, be } = setup([paragraph('a'), sheetEmbed()], {
      strings,
      workbooks: { mount: drawn.mount },
    });
    await tick();
    const pos = blocks.firstBody(list()[1])!.pos;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, {
        ...editor.state.doc.nodeAt(pos)!.attrs,
        workbookId: OTHER,
      }),
    );
    expect(drawn.destroys()).toBe(1);
    expect(drawn.mounts.map((m) => m.options.workbookId)).toEqual([WORKBOOK, OTHER]);
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(list()[1].pos, undefined, { id: 'Repaired0001' }),
    );
    expect(drawn.mounts.at(-1)!.options.blockId).toBe('Repaired0001');
    be.editor.setEditable(false);
    expect(drawn.mounts.at(-1)!.options.editable).toBe(false);
    // Read-only: the frame cannot change the block.
    drawn.mounts.at(-1)!.options.setAttrs({ range: 'A1' });
    expect(blocks.firstBody(list()[1])!.node.attrs.range).toBeNull();
    be.editor.setEditable(true);
    const before = drawn.destroys();
    editor.view.dispatch(blocks.deleteBlock(editor.state, list()[1]));
    expect(drawn.destroys()).toBe(before + 1);
    expect(JSON.stringify(editor.getJSON())).not.toContain('sheetEmbed');
  });

  it('keeps its frame to itself: keys typed in it never reach the editor', async () => {
    const drawn = frames<SheetMountOptions>();
    const { list, view } = setup([paragraph('a'), sheetEmbed()], {
      strings,
      workbooks: { mount: drawn.mount },
    });
    await tick();
    const input = view('sheetEmbed').querySelector<HTMLInputElement>('input.cell')!;
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
    );
    expect(list()).toHaveLength(2);
  });
});

describe('the ERP view block', () => {
  it('says what it is without a host; mounted even with no link, as its pickers are its own', async () => {
    const none = setup([erpView(), erpView({ linkId: LINK })]);
    await tick();
    const placeholders = [...none.element.querySelectorAll('.cgw-erpView .cgw-embed-placeholder')];
    expect(placeholders.map((p) => p.textContent)).toEqual([
      'No ERP data chosen.',
      'ERP data cannot be shown here',
    ]);

    const drawn = frames<ErpMountOptions>();
    const { view } = setup([erpView()], { strings, erp: { mount: drawn.mount } });
    await tick();
    expect(view('erpView').getAttribute('aria-label')).toBe('ERP data');
    expect(drawn.mounts).toHaveLength(1);
    expect(drawn.mounts[0].options).toMatchObject({ linkId: null, connectorId: null });
  });

  it('sends its settings to update and mounts again for another link', async () => {
    const drawn = frames<ErpMountOptions>();
    const { list } = setup([erpView({ linkId: LINK })], { strings, erp: { mount: drawn.mount } });
    await tick();
    const { options } = drawn.mounts[0];
    options.setAttrs({ connectorId: 'vendors', fields: '["name"]', pageSize: 25 });
    expect(drawn.mounts).toHaveLength(1);
    expect(drawn.updates.at(-1)).toMatchObject({
      linkId: LINK,
      connectorId: 'vendors',
      fields: '["name"]',
      pageSize: 25,
    });
    options.setAttrs({ linkId: OTHER });
    expect(drawn.destroys()).toBe(1);
    expect(drawn.mounts.map((m) => m.options.linkId)).toEqual([LINK, OTHER]);
    expect(blocks.firstBody(list()[0])!.node.attrs.connectorId).toBe('vendors');
  });
});

describe('"Workbook", "Existing workbook" and "ERP data"', () => {
  it('insert the workbook the host made or picked, and an empty ERP view', async () => {
    const drawn = frames<SheetMountOptions>();
    const host: EditorHost = {
      strings,
      workbooks: {
        mount: drawn.mount,
        create: async () => ({ workbookId: OTHER }),
        pick: async () => ({ workbookId: WORKBOOK, sheet: 'Budget', chartId: 'Chart 1' }),
      },
      erp: { mount: frames<ErpMountOptions>().mount },
    };
    const { editor, list, caret } = setup([paragraph('top'), paragraph('')], host);
    const made = actionByName('workbook')!;
    const existing = actionByName('existingWorkbook')!;
    const erp = actionByName('erpData')!;
    expect([made, existing, erp].some((a) => a.turnInto)).toBe(false);
    expect(made.available?.(host)).toBe(true);
    expect(made.available?.({})).toBe(false);
    expect(existing.available?.({ workbooks: { create: async () => null } })).toBe(false);
    expect(erp.available?.({})).toBe(false);
    expect(erp.available?.(host)).toBe(true);
    caret(1, 0);
    const emptyId = list()[1].id;
    await made.apply(editor, host);
    expect(list()[1].id).toBe(emptyId);
    expect(blocks.firstBody(list()[1])!.node.toJSON()).toEqual(sheetEmbed({ workbookId: OTHER }));
    caret(0, 3);
    await existing.apply(editor, host);
    expect(blocks.firstBody(list()[1])!.node.attrs).toEqual({
      workbookId: WORKBOOK,
      sheet: 'Budget',
      range: null,
      chartId: 'Chart 1',
      height: null,
    });
    caret(0, 3);
    await erp.apply(editor, host);
    expect(blocks.firstBody(list()[1])!.node.toJSON()).toEqual(erpView());
    // Cancelled: nothing is inserted.
    const count = list().length;
    await existing.apply(editor, { workbooks: { pick: async () => null } });
    await made.apply(editor, {});
    expect(list()).toHaveLength(count);
  });
});

describe('frame blocks, lazily', () => {
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

  it('mounts a workbook near the scrolled area, destroys it far away keeping its height', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    document.body.append(scroller);
    const drawn = frames<SheetMountOptions>();
    const doc = new Y.Doc();
    writeJSON(
      doc.getXmlFragment(CONTENT),
      documentSchema(),
      docOf(paragraph('a'), block(sheetEmbed()) as never),
    );
    const element = document.createElement('div');
    scroller.append(element);
    const be = createBlockEditor({
      element,
      fragment: doc.getXmlFragment(CONTENT),
      host: { strings, workbooks: { mount: drawn.mount } },
    });
    await tick();
    const near = FakeObserver.all.find((o) => o.options.rootMargin === NEAR_MARGIN)!;
    const far = FakeObserver.all.find((o) => o.options.rootMargin === FAR_MARGIN)!;
    expect(near.options.root).toBe(scroller);
    expect(drawn.mounts).toHaveLength(0);
    near.fire(true);
    expect(drawn.mounts).toHaveLength(1);
    const frame = drawn.mounts[0].element;
    frame.getBoundingClientRect = () => ({ height: 312.4 }) as DOMRect;
    far.fire(false);
    expect(drawn.destroys()).toBe(1);
    expect(frame.style.minBlockSize).toBe('312px');
    near.fire(true);
    expect(drawn.mounts).toHaveLength(2);
    be.destroy();
    expect(drawn.destroys()).toBe(2);
    expect(near.disconnected && far.disconnected).toBe(true);
  });
});
