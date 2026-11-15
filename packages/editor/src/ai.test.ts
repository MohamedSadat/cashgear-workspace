import { afterAll, describe, expect, it } from 'vitest';
import { installDom } from './testing';

installDom();
const editors: { destroy(): void }[] = [];
afterAll(() => {
  for (const editor of editors) editor.destroy();
});
const Y = await import('yjs');
const { BLOCK_ID, blockIds, build, documentSchema, writeJSON, CONTENT, undoCommand } =
  await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const blocks = await import('./blocks');
const { insertAiContent, selectionForAi, textOfRange } = await import('./ai');
const { TextSelection } = await import('@tiptap/pm/state');

const { docOf, paragraph, text, heading, userMention } = build;

function setup(json = docOf(heading(1, 'Plan'), paragraph('alpha beta gamma'), paragraph('end'))) {
  const doc = new Y.Doc();
  writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), json);
  const be = createBlockEditor({
    element: document.createElement('div'),
    fragment: doc.getXmlFragment(CONTENT),
    host: { people: { name: () => 'Laila', search: () => [], subscribe: () => () => {} } },
  });
  editors.push(be);
  const editor = be.editor;
  const list = () => blocks.listBlocks(editor.state.doc);
  const texts = () => list().map((b) => b.node.firstChild?.textContent ?? '');
  const select = (blockIndex: number, start: number, end: number) => {
    const body = blocks.firstBody(list()[blockIndex])!;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, body.pos + 1 + start, body.pos + 1 + end),
      ),
    );
  };
  return { doc, be, editor, list, texts, select };
}

describe('AI in the editor', () => {
  it('reads the selection as plain text, people by name', () => {
    const { editor, select, be } = setup(
      docOf(paragraph(text('ask '), userMention('u1'), text(' about it'))),
    );
    select(0, 0, 14);
    expect(selectionForAi(editor, be.host())).toEqual({
      from: 2,
      to: 16,
      text: 'ask @Laila about it',
    });
    select(0, 2, 2);
    expect(selectionForAi(editor)).toBeNull();
  });

  it('replaces a selection that still reads the same, as one edit that undo takes back', () => {
    const { editor, select, texts, list } = setup();
    const ids = blockIds(editor.state.doc);
    select(1, 6, 10);
    const sel = selectionForAi(editor)!;
    expect(sel.text).toBe('beta');
    const result = insertAiContent(
      editor,
      { kind: 'replace', ...sel, expect: sel.text },
      'BETA *now*',
    );
    expect(result).toBe('replaced');
    expect(texts()).toEqual(['Plan', 'alpha BETA now gamma', 'end']);
    // The block keeps its id: the text went in as a paste of one paragraph does.
    expect(list()[1].id).toBe(ids[1]);
    undoCommand(editor.state);
    expect(texts()).toEqual(['Plan', 'alpha beta gamma', 'end']);
  });

  it('puts the answer after the block when the selection changed meanwhile, overwriting nothing', () => {
    const { editor, select, texts } = setup();
    select(1, 6, 10);
    const sel = selectionForAi(editor)!;
    // Someone types inside the range before the proposal is accepted.
    editor.view.dispatch(editor.state.tr.insertText('X', sel.from + 1));
    expect(textOfRange(editor, sel.from, sel.to)).not.toBe('beta');
    const result = insertAiContent(editor, { kind: 'replace', ...sel, expect: sel.text }, 'BETA');
    expect(result).toBe('inserted');
    expect(texts()).toEqual(['Plan', 'alpha bXeta gamma', 'BETA', 'end']);
  });

  it('inserts Markdown as new blocks with fresh ids at the top, after a block and at the end', () => {
    const { editor, texts, list } = setup();
    expect(insertAiContent(editor, { kind: 'top' }, '## Summary\n\nShort.')).toBe('inserted');
    expect(texts().slice(0, 3)).toEqual(['Summary', 'Short.', 'Plan']);
    const after = list()[3].pos + 2;
    insertAiContent(editor, { kind: 'after', pos: after }, '- [ ] call\n- [ ] write');
    expect(texts()).toEqual([
      'Summary',
      'Short.',
      'Plan',
      'alpha beta gamma',
      'call',
      'write',
      'end',
    ]);
    expect(list()[4].node.firstChild!.attrs.kind).toBe('checkItem');
    insertAiContent(editor, { kind: 'end' }, 'Last.');
    expect(texts().at(-1)).toBe('Last.');
    const ids = blockIds(editor.state.doc);
    expect(ids.every((id) => id && BLOCK_ID.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('makes new blocks in one edit that undo takes back, ids and all', () => {
    const { editor, texts } = setup();
    const before = texts();
    insertAiContent(editor, { kind: 'top' }, '## Summary\n\n- [ ] one\n- [ ] two');
    expect(texts()).toEqual(['Summary', 'one', 'two', ...before]);
    expect(undoCommand(editor.state)).toBe(true);
    expect(texts()).toEqual(before);
  });

  it('takes blocks as JSON too, and refuses when the page cannot be edited', () => {
    const { editor, texts } = setup();
    insertAiContent(editor, { kind: 'end' }, [build.todo(false, text('from JSON'))]);
    expect(texts().at(-1)).toBe('from JSON');
    editor.setEditable(false);
    expect(insertAiContent(editor, { kind: 'end' }, 'nothing')).toBe('refused');
    expect(texts().at(-1)).toBe('from JSON');
  });
});
