// "Comment" in the bubble toolbar and the block menu (Phase 6, contracts section 6): offered only
// when the host gives `comments.create`; in the toolbar beside the marks on an editable page, and
// alone on a page this person may comment on but not edit; in the block menu on the whole block.
import { afterAll, describe, expect, it } from 'vitest';
import { installDom } from './testing';

installDom();
const target = globalThis as unknown as Record<string, unknown>;
for (const name of [
  'HTMLButtonElement',
  'HTMLSpanElement',
  'HTMLDivElement',
  'FocusEvent',
  'MouseEvent',
  'PointerEvent',
  'UIEvent',
  'CustomEvent',
  'ResizeObserver',
]) {
  const value = (window as unknown as Record<string, unknown>)[name];
  if (value !== undefined && target[name] === undefined) target[name] = value;
}
target.IS_REACT_ACT_ENVIRONMENT = true;
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

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const Y = await import('yjs');
const { TextSelection } = await import('@tiptap/pm/state');
const { build, documentSchema, writeJSON, CONTENT } = await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const { BubbleToolbar } = await import('./ui/BubbleToolbar');
const { BlockMenu } = await import('./ui/BlockMenu');
type EditorHost = import('./host').EditorHost;
type CommentAnchor = import('./host').CommentAnchor;

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});
const { docOf, paragraph } = build;
const strings = {
  formatting: 'Formatting',
  turnInto: 'Turn into',
  bold: 'Bold',
  blockMenu: 'Block menu',
  duplicate: 'Duplicate',
  moveUp: 'Move up',
  moveDown: 'Move down',
  deleteBlock: 'Delete',
} as never;

async function setup(options: { editable: boolean; comment: boolean }) {
  const doc = new Y.Doc();
  writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), docOf(paragraph('alpha beta')));
  const element = document.createElement('div');
  document.body.append(element);
  const created: CommentAnchor[] = [];
  const host: EditorHost = {
    strings,
    shortcut: (chord) => chord,
    comments: {
      threads: () => [],
      subscribe: () => () => {},
      open: () => {},
      ...(options.comment ? { create: (anchor: CommentAnchor) => void created.push(anchor) } : {}),
    },
  };
  const be = createBlockEditor({
    element,
    fragment: doc.getXmlFragment(CONTENT),
    host,
    editable: options.editable,
  });
  be.editor.view.dom.tabIndex = 0;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement('div', null, [
        createElement(BubbleToolbar, { key: 'b', editor: be, host }),
        createElement(BlockMenu, { key: 'm', editor: be, host }),
      ]),
    ),
  );
  cleanups.push(() => {
    root.unmount();
    be.destroy();
  });
  const editor = be.editor;
  const selectBeta = async () => {
    await act(async () => {
      editor.view.dom.focus();
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2 + 6, 2 + 10)),
      );
    });
  };
  const buttons = () =>
    [...container.querySelectorAll<HTMLButtonElement>('.cgw-bubble button')].map(
      (b) => b.getAttribute('aria-label') ?? '',
    );
  return { be, editor, container, created, selectBeta, buttons };
}

describe('"Comment"', () => {
  it('sits in the bubble toolbar beside the marks, and comments on the selection', async () => {
    const { container, created, selectBeta, buttons } = await setup({
      editable: true,
      comment: true,
    });
    await selectBeta();
    expect(buttons()).toContain('Bold');
    expect(buttons().at(-1)).toBe('Comment');
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Comment"]')!;
    await act(async () => button.click());
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ quote: 'beta' });
    expect(created[0].start).toEqual(expect.any(String));
  });

  it('is alone in the toolbar on a page this person may comment on but not edit', async () => {
    const { selectBeta, buttons, created, container } = await setup({
      editable: false,
      comment: true,
    });
    await selectBeta();
    expect(buttons()).toEqual(['Comment']);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Comment"]')!.click(),
    );
    expect(created[0]).toMatchObject({ quote: 'beta' });
  });

  it('is not offered when the host gives no way to comment', async () => {
    const editable = await setup({ editable: true, comment: false });
    await editable.selectBeta();
    expect(editable.buttons()).toContain('Bold');
    expect(editable.buttons()).not.toContain('Comment');
    const readOnly = await setup({ editable: false, comment: false });
    await readOnly.selectBeta();
    expect(readOnly.buttons()).toEqual([]);
  });

  it('is in the block menu, on the whole block, with its shortcut', async () => {
    const { be, created, container } = await setup({ editable: true, comment: true });
    await act(async () =>
      be.ui.openBlockMenu!(0, { left: 0, right: 10, top: 0, bottom: 10 } as DOMRect),
    );
    const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const comment = items.find((i) => i.textContent?.startsWith('Comment'))!;
    expect(comment.textContent).toBe('CommentMod+Alt+KeyM');
    await act(async () => comment.click());
    const blockId = be.editor.state.doc.firstChild!.attrs.id as string;
    expect(created).toEqual([{ blockId, start: null, end: null, quote: '' }]);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});
