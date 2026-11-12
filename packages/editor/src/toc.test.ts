// The table of contents (schema version 2): inserted from the slash menu's action, drawn as the
// page's headings in plain DOM, kept current as headings change, and only when the page has one.
import { afterAll, describe, expect, it } from 'vitest';
import { installDom } from './testing';

installDom();
const editors: { destroy(): void }[] = [];
afterAll(() => {
  for (const editor of editors) editor.destroy();
});
const Y = await import('yjs');
const { TextSelection } = await import('@tiptap/pm/state');
const { build, documentSchema, writeJSON, CONTENT, toMarkdown, plainText, fragmentToJSON } =
  await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const { actionByName } = await import('./actions');
const blocks = await import('./blocks');
const { tocKey } = await import('./toc');

const { docOf, paragraph, heading, block } = build;
const strings = {
  tocLabel: 'Table of contents',
  tocEmpty: 'No headings yet',
  untitled: 'Untitled',
} as never;

function setup(json = docOf(heading(1, 'Intro'), paragraph('text'), heading(2, 'Details'))) {
  const doc = new Y.Doc();
  writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), json);
  const element = document.createElement('div');
  document.body.append(element);
  const be = createBlockEditor({
    element,
    fragment: doc.getXmlFragment(CONTENT),
    host: { strings },
    schedule: () => {},
  });
  editors.push(be);
  const editor = be.editor;
  const links = () =>
    [...element.querySelectorAll<HTMLAnchorElement>('.cgw-toc-link')].map((a) => [
      a.closest('li')!.dataset.level,
      a.textContent,
    ]);
  const caret = (index: number, offset: number) => {
    const body = blocks.firstBody(blocks.listBlocks(editor.state.doc)[index])!;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, body.pos + 1 + offset)),
    );
  };
  return { doc, be, editor, element, links, caret };
}

describe('table of contents', () => {
  it('is inserted by its block action and lists the headings as links', async () => {
    const { editor, element, links, caret, doc } = setup();
    caret(1, 4);
    await actionByName('tableOfContents')!.apply(editor, {});
    const types = blocks.listBlocks(editor.state.doc).map((b) => b.node.firstChild!.type.name);
    expect(types).toContain('tableOfContents');
    const nav = element.querySelector('nav.cgw-tableOfContents')!;
    expect(nav.getAttribute('aria-label')).toBe('Table of contents');
    expect(links()).toEqual([
      ['1', 'Intro'],
      ['2', 'Details'],
    ]);
    // Saved in the document as an empty atom; Markdown and plain text write nothing for it.
    expect(doc.getXmlFragment(CONTENT).toString()).toContain('<tableofcontents></tableofcontents>');
    const json = fragmentToJSON(doc.getXmlFragment(CONTENT));
    expect(toMarkdown(json)).toBe('# Intro\n\ntext\n\n## Details\n');
    expect(plainText(json)).toBe('Intro\ntext\nDetails');
  });

  it('follows the headings as they are typed, added and turned back into text', () => {
    const { editor, links, caret } = setup(
      docOf(block({ type: 'tableOfContents' }), heading(1, 'One'), paragraph('body')),
    );
    expect(links()).toEqual([['1', 'One']]);
    caret(1, 3);
    editor.view.dispatch(editor.state.tr.insertText('!'));
    expect(links()).toEqual([['1', 'One!']]);
    const body = blocks.listBlocks(editor.state.doc)[2];
    editor.view.dispatch(
      blocks.turnInto(editor.state, body, { kind: 'heading', attrs: { level: 3 } })!,
    );
    expect(links()).toEqual([
      ['1', 'One!'],
      ['3', 'body'],
    ]);
    editor.view.dispatch(
      blocks.turnInto(editor.state, blocks.listBlocks(editor.state.doc)[1], { kind: 'paragraph' })!,
    );
    expect(links()).toEqual([['3', 'body']]);
  });

  it('typing outside a heading leaves the list as it is; a page without one keeps nothing', () => {
    const { editor, caret } = setup(
      docOf(block({ type: 'tableOfContents' }), heading(1, 'One'), paragraph('body')),
    );
    const before = tocKey.getState(editor.state);
    caret(2, 2);
    editor.view.dispatch(editor.state.tr.insertText('typed'));
    expect(tocKey.getState(editor.state)).toBe(before);

    const plain = setup(docOf(heading(1, 'One'), paragraph('body')));
    const empty = tocKey.getState(plain.editor.state);
    expect(empty?.present).toBe(false);
    plain.caret(0, 1);
    plain.editor.view.dispatch(plain.editor.state.tr.insertText('x'));
    plain.editor.view.dispatch(
      plain.editor.state.tr.insert(
        0,
        plain.editor.state.schema.nodes.block.create(
          null,
          plain.editor.state.schema.nodes.textBody.create(),
        ),
      ),
    );
    expect(tocKey.getState(plain.editor.state)).toBe(empty);
  });

  it('a link moves the caret to its heading', () => {
    const { editor, element } = setup(
      docOf(
        block({ type: 'tableOfContents' }),
        paragraph('a'),
        paragraph('b'),
        heading(2, 'Target'),
      ),
    );
    const link = [...element.querySelectorAll<HTMLAnchorElement>('.cgw-toc-link')][0];
    link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const target = blocks.listBlocks(editor.state.doc)[3];
    expect(blocks.currentBlock(editor.state)?.id).toBe(target.id);
    expect(link.dataset.blockId).toBe(target.id);
  });

  it('says so when the page has no headings, and draws in a read-only view too', () => {
    const element = document.createElement('div');
    const be = createBlockEditor({
      element,
      readOnlyContent: docOf(block({ type: 'tableOfContents' }), paragraph('only text')) as never,
      host: { strings },
    });
    editors.push(be);
    const empty = element.querySelector<HTMLElement>('.cgw-toc-empty')!;
    expect(empty.textContent).toBe('No headings yet');
    expect(empty.hidden).toBe(false);
    expect(be.editor.isEditable).toBe(false);
  });
});
