import { afterAll, describe, expect, it } from 'vitest';
import { installDom } from './testing';

installDom();
const { pressKey } = await import('./testing');
const editors: { destroy(): void }[] = [];
afterAll(() => {
  for (const editor of editors) editor.destroy();
  (window as unknown as { close(): void }).close();
});
const Y = await import('yjs');
const { TextSelection } = await import('@tiptap/pm/state');
const { BLOCK_ID, blockIds, build, documentSchema, writeJSON, CONTENT, undoCommand } =
  await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const blocks = await import('./blocks');

const { docOf, paragraph, bullet, toggle, heading, code } = build;

function setup(json = docOf(paragraph('alpha beta'), paragraph('gamma'))) {
  const doc = new Y.Doc();
  writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), json);
  const tasks: (() => void)[] = [];
  const be = createBlockEditor({
    element: document.createElement('div'),
    fragment: doc.getXmlFragment(CONTENT),
    schedule: (task) => tasks.push(task),
  });
  const editor = be.editor;
  const list = () => blocks.listBlocks(editor.state.doc);
  const text = (b: { node: { firstChild: { textContent: string } | null } }) =>
    b.node.firstChild?.textContent ?? '';
  const caret = (blockIndex: number, offset: number) => {
    const body = blocks.firstBody(list()[blockIndex])!;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, body.pos + 1 + offset)),
    );
  };
  const press = (key: string) => {
    editors.push(be);
    return pressKey(editor.view, key);
  };
  return { doc, be, editor, list, text, caret, press, tasks };
}

describe('block ids in the editor', () => {
  it('mint for new blocks; the half with the text keeps the id on Enter', () => {
    const { editor, list, text, caret, press } = setup();
    const before = blockIds(editor.state.doc);
    expect(before.every((id) => id && BLOCK_ID.test(id))).toBe(true);
    caret(0, 6);
    press('Enter');
    expect(list().map(text)).toEqual(['alpha ', 'beta', 'gamma']);
    expect(list()[0].id).toBe(before[0]);
    expect(list()[1].id).toMatch(BLOCK_ID);
    expect(new Set(blockIds(editor.state.doc)).size).toBe(3);
    // Enter at the start: an empty block above; the text keeps its id.
    caret(2, 0);
    press('Enter');
    expect(list().map(text)).toEqual(['alpha ', 'beta', '', 'gamma']);
    expect(list()[3].id).toBe(before[1]);
  });

  it('merge on Backspace keeps the id of the block merged into', () => {
    const { editor, list, text, caret, press } = setup();
    const [first] = blockIds(editor.state.doc);
    caret(1, 0);
    press('Backspace');
    expect(list().map(text)).toEqual(['alpha betagamma']);
    expect(list()[0].id).toBe(first);
  });

  it('indent, outdent and move keep every id; outdent keeps the order on screen', () => {
    const { editor, list, text, caret, press } = setup(
      docOf(bullet(['a']), bullet(['b']), bullet(['c']), bullet(['d'])),
    );
    const ids = blockIds(editor.state.doc);
    caret(1, 0);
    press('Tab');
    caret(2, 0);
    press('Tab');
    caret(3, 0);
    press('Tab');
    // a > (b, c, d)
    expect(list().map((b) => [b.node.firstChild!.textContent, b.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 1],
      ['d', 1],
    ]);
    caret(2, 0);
    press('Shift-Tab');
    // a > b, then c > d: c moved out and took d with it.
    expect(list().map((b) => [text(b), b.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 0],
      ['d', 1],
    ]);
    caret(2, 0);
    press('Alt-Shift-ArrowUp');
    expect(list().map(text)).toEqual(['c', 'd', 'a', 'b']);
    expect(new Set(blockIds(editor.state.doc))).toEqual(new Set(ids));
  });

  it('duplicate mints new ids for the copy and its children', () => {
    const { editor, list, caret, press } = setup(
      docOf(toggle(['t'], [paragraph('inside')]), paragraph('after')),
    );
    caret(0, 0);
    press('Mod-d');
    const ids = blockIds(editor.state.doc);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(list().map((b) => b.node.firstChild!.textContent)).toEqual([
      't',
      'inside',
      't',
      'inside',
      'after',
    ]);
  });

  it('turn into keeps the id, the text and the children; code keeps the text', () => {
    const { editor, list } = setup(
      docOf(bullet(['one', ' ', build.text('two', 'bold')], [paragraph('child')])),
    );
    const [id] = blockIds(editor.state.doc);
    editor.view.dispatch(
      blocks.turnInto(editor.state, list()[0], { kind: 'heading', attrs: { level: 2 } })!,
    );
    let first = list()[0];
    expect(first.id).toBe(id);
    expect(first.node.firstChild!.attrs).toMatchObject({ kind: 'heading', level: 2 });
    expect(first.node.firstChild!.textContent).toBe('one two');
    expect(list()).toHaveLength(2);
    editor.view.dispatch(blocks.turnInto(editor.state, list()[0], 'codeBlock')!);
    first = list()[0];
    expect(first.id).toBe(id);
    expect(first.node.firstChild!.type.name).toBe('codeBlock');
    expect(first.node.firstChild!.textContent).toBe('one two');
    editor.view.dispatch(blocks.turnInto(editor.state, list()[0], { kind: 'paragraph' })!);
    expect(list()[0].node.firstChild!.attrs.kind).toBe('paragraph');
  });

  it('Enter on an empty list item turns it into a paragraph; Backspace on a heading too', () => {
    const { editor, list, caret, press } = setup(docOf(bullet(['']), heading(1, 'Title')));
    caret(0, 0);
    press('Enter');
    expect(list()[0].node.firstChild!.attrs.kind).toBe('paragraph');
    caret(1, 0);
    press('Backspace');
    expect(list()[1].node.firstChild!.attrs.kind).toBe('paragraph');
    expect(editor.state.doc.childCount).toBe(2);
  });

  it('writes local edits to Yjs and undoes them through Yjs', () => {
    const { doc, editor, caret } = setup();
    caret(1, 5);
    editor.view.dispatch(editor.state.tr.insertText('!'));
    expect(doc.getXmlFragment(CONTENT).toString()).toContain('gamma!');
    undoCommand(editor.state);
    expect(doc.getXmlFragment(CONTENT).toString()).not.toContain('gamma!');
  });

  it('a code block keeps Enter as a new line', () => {
    const { editor, list, press } = setup(docOf(code('js', 'a')));
    const body = blocks.firstBody(list()[0])!;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, body.pos + 2)),
    );
    press('Enter');
    editor.view.dispatch(editor.state.tr.insertText('b'));
    expect(list()).toHaveLength(1);
  });
});

describe('two editors on one document', () => {
  it('converge, and a remote change never mints an id', () => {
    const left = setup();
    const right = setup(docOf());
    // Connect: everything left has goes right, then both ways.
    Y.applyUpdate(right.doc, Y.encodeStateAsUpdate(left.doc), 'remote');
    left.doc.on(
      'update',
      (u: Uint8Array, origin: unknown) =>
        origin !== 'remote' && Y.applyUpdate(right.doc, u, 'remote'),
    );
    right.doc.on(
      'update',
      (u: Uint8Array, origin: unknown) =>
        origin !== 'remote' && Y.applyUpdate(left.doc, u, 'remote'),
    );
    expect(blockIds(right.editor.state.doc)).toEqual(blockIds(left.editor.state.doc));
    expect(right.be.stats.minted).toBe(0);
    left.caret(0, 5);
    left.press('Enter');
    right.caret(1, 5);
    right.editor.view.dispatch(right.editor.state.tr.insertText('!'));
    for (const task of [...left.tasks, ...right.tasks]) task();
    expect(right.editor.getJSON()).toEqual(left.editor.getJSON());
    expect(new Set(blockIds(left.editor.state.doc)).size).toBe(3);
    expect(right.be.stats.minted).toBe(0);
  });
});

describe('Markdown shortcuts as typed', () => {
  const typeText = (view: import('@tiptap/pm/view').EditorView, text: string) => {
    for (const ch of text) {
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (f) =>
        f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
    }
  };

  it('turn a paragraph into each kind, keeping its id, and --- into a divider', () => {
    for (const [typed, kind] of [
      ['# ', 'heading'],
      ['- ', 'bulletItem'],
      ['1. ', 'numberedItem'],
      ['[] ', 'checkItem'],
      ['> ', 'quote'],
    ] as const) {
      const { editor, list, caret } = setup(docOf(paragraph('')));
      const [id] = blockIds(editor.state.doc);
      caret(0, 0);
      typeText(editor.view, typed + 'x');
      expect(list()[0].node.firstChild!.attrs.kind, typed).toBe(kind);
      expect(list()[0].node.firstChild!.textContent).toBe('x');
      expect(list()[0].id).toBe(id);
    }
    const { editor, list, caret } = setup(docOf(paragraph('')));
    caret(0, 0);
    typeText(editor.view, '---');
    expect(list()[0].node.firstChild!.type.name).toBe('divider');
    expect(list()).toHaveLength(2);
    typeText(editor.view, 'after');
    expect(list()[1].node.firstChild!.textContent).toBe('after');
  });

  it('keep the caret in a block moved by Alt+Shift+Up', () => {
    const { editor, list, caret, press } = setup(docOf(paragraph('one'), paragraph('two')));
    caret(1, 2);
    press('Alt-Shift-ArrowUp');
    expect(list().map((b) => b.node.firstChild!.textContent)).toEqual(['two', 'one']);
    editor.view.dispatch(editor.state.tr.insertText('!'));
    expect(list()[0].node.firstChild!.textContent).toBe('tw!o');
  });
});
