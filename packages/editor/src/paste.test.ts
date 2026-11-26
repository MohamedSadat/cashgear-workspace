// Pasting blocks (ARCHITECTURE.md, Clipboard): whole blocks go beside the block holding the caret,
// never inside it, however many there are, by our own format, HTML or Markdown; and every pasted
// block has a new id, minted once by the editor that pasted, never by one the paste reached.
import { afterAll, describe, expect, it } from 'vitest';
import { installDom } from './testing';

installDom();
const editors: { destroy(): void }[] = [];
afterAll(() => {
  for (const editor of editors) editor.destroy();
});
const Y = await import('yjs');
const { NodeSelection, TextSelection } = await import('@tiptap/pm/state');
const { DOMSerializer } = await import('@tiptap/pm/model');
const { BLOCK_ID, CONTENT, blockIds, build, documentSchema, fragmentToJSON, writeJSON } =
  await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const blocks = await import('./blocks');
const { blockSelectionKey } = await import('./blockSelection');
const { CLIPBOARD_TYPE } = await import('./clipboard');

type DocJSON = import('@cgw/doc').DocJSON;
type EditorHost = import('./host').EditorHost;
type Editor = import('@tiptap/core').Editor;
type PMNode = import('@tiptap/pm/model').Node;

const { docOf, paragraph, heading, bullet, toggle, divider } = build;

function open(doc: InstanceType<typeof Y.Doc>, host: EditorHost = {}) {
  const tasks: (() => void)[] = [];
  const element = document.createElement('div');
  document.body.append(element);
  const be = createBlockEditor({
    element,
    fragment: doc.getXmlFragment(CONTENT),
    host,
    schedule: (task) => tasks.push(task),
  });
  editors.push(be);
  return { be, editor: be.editor, tasks };
}

function setup(json: DocJSON = docOf(paragraph('alpha'), paragraph('omega')), host?: EditorHost) {
  const doc = new Y.Doc();
  writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), json);
  const { be, editor } = open(doc, host);
  const list = () => blocks.listBlocks(editor.state.doc);
  const caret = (blockIndex: number, offset: number) => {
    const body = blocks.firstBody(list()[blockIndex])!;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, body.pos + 1 + offset)),
    );
  };
  return { doc, be, editor, list, caret };
}

/**
 * The top-level blocks as text: a block holding blocks as `text[children]`, one with no body or a
 * body that is not its first child as `<no body>`, one with more bodies as `text+N`.
 */
function shape(node: PMNode): string[] {
  const out: string[] = [];
  node.forEach((child) => {
    if (child.type.name !== 'block') return;
    const body = child.firstChild && blocks.isBody(child.firstChild) ? child.firstChild : null;
    let text = body ? body.textContent || `<${body.type.name}>` : '<no body>';
    const nested: string[] = [];
    let bodies = 0;
    child.forEach((grandchild) => {
      if (blocks.isBody(grandchild)) bodies++;
      else nested.push(...shape(child.type.create(null, grandchild)));
    });
    if (bodies > 1) text += `+${bodies - 1}`;
    out.push(nested.length ? `${text}[${nested.join(', ')}]` : text);
  });
  return out;
}

/** What the clipboard holds after a copy: every type the editor wrote. */
type Clip = Map<string, string>;

function clipboardEvent(type: 'copy' | 'paste', clip: Clip) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: [],
      clearData: () => clip.clear(),
      setData: (kind: string, value: string) => clip.set(kind, value),
      getData: (kind: string) => clip.get(kind) ?? '',
    },
  });
  return event;
}

/** Selects top-level blocks `from` to `to` as Esc and Shift+Arrow do, and copies them. */
function copyBlocks(editor: Editor, from: number, to: number): Clip {
  const top = blocks.listBlocks(editor.state.doc).filter((b) => b.parentPos < 0);
  const tr = editor.state.tr.setMeta(blockSelectionKey, {
    anchor: top[from].pos,
    head: top[to].pos,
  });
  editor.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, top[to].pos)));
  const clip: Clip = new Map();
  editor.view.dom.dispatchEvent(clipboardEvent('copy', clip));
  editor.view.dispatch(editor.state.tr.setMeta(blockSelectionKey, 'clear'));
  return clip;
}

/** A paste as the browser delivers it: ProseMirror reads the HTML, then our handler runs. */
function paste(editor: Editor, clip: Clip): void {
  editor.view.dom.dispatchEvent(clipboardEvent('paste', clip));
}

/** The HTML the editor writes for these blocks, as another tab or a browser would carry it. */
function htmlOf(editor: Editor, json: DocJSON): string {
  const node = editor.schema.nodeFromJSON(json);
  const holder = document.createElement('div');
  holder.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(node.content));
  return holder.innerHTML;
}

function lines(n: number, prefix = 'line') {
  return Array.from({ length: n }, (_, i) => paragraph(`${prefix} ${i}`));
}

/** The text body the caret is in, by its block's text. */
const caretText = (editor: Editor) => editor.state.selection.$from.parent.textContent;

describe('pasting many blocks', () => {
  it('a copy of 1,500 blocks pastes whole, beside the others, each with a new id', () => {
    const source = setup(docOf(...lines(1500)));
    const sourceIds = new Set(blockIds(source.editor.state.doc));
    const clip = copyBlocks(source.editor, 0, 1499);
    expect(clip.get(CLIPBOARD_TYPE)).toBeTruthy();
    expect(clip.get('text/html')).toBeTruthy();

    const { doc, editor, list, caret } = setup();
    const [alpha, omega] = blockIds(editor.state.doc);
    caret(1, 5);
    paste(editor, clip);
    const top = shape(editor.state.doc);
    expect(top).toHaveLength(1502);
    expect(top.slice(0, 4)).toEqual(['alpha', 'omega', 'line 0', 'line 1']);
    expect(top[1501]).toBe('line 1499');
    expect(list()).toHaveLength(1502); // nothing nested
    const ids = blockIds(editor.state.doc);
    expect(ids.slice(0, 2)).toEqual([alpha, omega]);
    expect(ids.every((id) => id && BLOCK_ID.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(1502);
    expect(ids.some((id) => sourceIds.has(id!))).toBe(false);
    expect(caretText(editor)).toBe('line 1499');
    // Written through to Yjs, as the page saves it.
    expect(fragmentToJSON(doc.getXmlFragment(CONTENT)).content).toHaveLength(1502);
  }, 60_000);

  it('HTML of 1,500 blocks pastes whole, its first line joining the text at the caret', () => {
    const { editor, list, caret } = setup();
    caret(1, 5);
    paste(editor, new Map([['text/html', htmlOf(editor, docOf(...lines(1500)))]]));
    const top = shape(editor.state.doc);
    expect(top).toHaveLength(1501);
    expect(top.slice(0, 3)).toEqual(['alpha', 'omegaline 0', 'line 1']);
    expect(top[1500]).toBe('line 1499');
    expect(list()).toHaveLength(1501);
    expect(new Set(blockIds(editor.state.doc)).size).toBe(1501);
  }, 60_000);
});

describe('pasting blocks at the caret', () => {
  const three = () => docOf(heading(1, 'one'), bullet(['two']), paragraph('three'));
  /** Our own format (blocks copied), Markdown, and HTML that starts with a closed block. */
  const clips = (): [string, (editor: Editor) => Clip][] => [
    ['our own format', () => copyBlocks(setup(three()).editor, 0, 2)],
    ['Markdown', () => new Map([['text/plain', '# one\n\n- two\n\nthree']])],
    [
      'HTML starting with a divider',
      (editor) => new Map([['text/html', htmlOf(editor, docOf(divider(), ...three().content!))]]),
    ],
  ];
  const pasted = (name: string) =>
    name.startsWith('HTML') ? ['<divider>', 'one', 'two', 'three'] : ['one', 'two', 'three'];

  for (const [name, clipOf] of clips()) {
    it(`at the end of the page's last block: after it, not inside it (${name})`, () => {
      const { editor, list, caret } = setup();
      const ids = blockIds(editor.state.doc);
      caret(1, 5);
      paste(editor, clipOf(editor));
      expect(shape(editor.state.doc)).toEqual(['alpha', 'omega', ...pasted(name)]);
      expect(list().every((b) => b.parentPos < 0)).toBe(true);
      expect(blockIds(editor.state.doc).slice(0, 2)).toEqual(ids);
      expect(caretText(editor)).toBe('three');
    });

    it(`in an empty last block: in its place, each block with its body (${name})`, () => {
      const { editor, caret } = setup(docOf(paragraph('alpha'), paragraph('')));
      caret(1, 0);
      paste(editor, clipOf(editor));
      expect(shape(editor.state.doc)).toEqual(['alpha', ...pasted(name)]);
      editor.state.doc.forEach((block) => expect(blocks.isBody(block.firstChild!)).toBe(true));
    });
  }

  it('at the start of a block they go above it; in its middle its tail follows them', () => {
    const { editor, list, caret } = setup(docOf(paragraph('alpha'), heading(2, 'omega')));
    const omega = list()[1].id;
    caret(1, 0);
    paste(editor, copyBlocks(setup(three()).editor, 0, 2));
    expect(shape(editor.state.doc)).toEqual(['alpha', 'one', 'two', 'three', 'omega']);
    expect(list()[4].id).toBe(omega);

    caret(4, 2);
    paste(editor, copyBlocks(setup(docOf(paragraph('x'), paragraph('y'))).editor, 0, 1));
    expect(shape(editor.state.doc)).toEqual([
      'alpha',
      'one',
      'two',
      'three',
      'om',
      'x',
      'y',
      'ega',
    ]);
    // The head keeps the id; the tail is a new block of the same kind.
    expect(list()[4].id).toBe(omega);
    expect(list()[7].id).not.toBe(omega);
    expect(list()[7].id).toMatch(BLOCK_ID);
    expect(blocks.textKind(list()[7])).toBe('heading');
    expect(blocks.firstBody(list()[7])!.node.attrs.level).toBe(2);
    expect(caretText(editor)).toBe('y');
  });

  it('under a block whose children show they go first among them, as Enter puts a block', () => {
    const json = () =>
      docOf(bullet(['parent'], [bullet(['child'])]), toggle(['shut'], [paragraph('inside')]));
    let shut = '';
    const { editor, list, caret } = setup(json(), {
      toggles: { isOpen: (id) => id !== shut, flip: () => {}, subscribe: () => () => {} },
    });
    shut = list()[2].id!;
    caret(0, 6);
    paste(editor, copyBlocks(setup(docOf(paragraph('x'), paragraph('y'))).editor, 0, 1));
    expect(shape(editor.state.doc)).toEqual(['parent[x, y, child]', 'shut[inside]']);
    // A closed toggle: after it, where Enter would put the next block.
    caret(4, 4);
    paste(editor, copyBlocks(setup(docOf(paragraph('z'))).editor, 0, 0));
    expect(shape(editor.state.doc)).toEqual(['parent[x, y, child]', 'shut[inside]', 'z']);
  });

  it('a selected block is replaced; a text selection is replaced across blocks', () => {
    const { editor, list } = setup(
      docOf(paragraph('alpha'), paragraph('beta'), paragraph('omega')),
    );
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, list()[1].pos)),
    );
    paste(editor, copyBlocks(setup(docOf(paragraph('x'), paragraph('y'))).editor, 0, 1));
    expect(shape(editor.state.doc)).toEqual(['alpha', 'x', 'y', 'omega']);
    // From "al|pha" to "om|ega": the text between goes, the blocks go in its place.
    const from = blocks.firstBody(list()[0])!.pos + 3;
    const to = blocks.firstBody(list()[3])!.pos + 3;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
    );
    paste(editor, copyBlocks(setup(docOf(paragraph('p'), paragraph('q'))).editor, 0, 1));
    expect(shape(editor.state.doc)).toEqual(['al', 'p', 'q', 'ega']);
  });

  it('in code, copied blocks go in as their text', () => {
    const { editor, list } = setup(docOf(paragraph('alpha'), build.code(null, 'let a;')));
    const body = blocks.firstBody(list()[1])!;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, body.pos + 7)),
    );
    paste(editor, copyBlocks(setup(docOf(paragraph('x'), paragraph('y'))).editor, 0, 1));
    expect(list()).toHaveLength(2);
    expect(blocks.firstBody(list()[1])!.node.textContent).toBe('let a;x\n\ny');
  });
});

describe('pasted blocks and their ids', () => {
  it('are new at every paste, minted by the editor that pasted, never by one the paste reached', () => {
    // Two devices on one page: each change reaches the other as a remote one.
    const a = new Y.Doc();
    writeJSON(a.getXmlFragment(CONTENT), documentSchema(), docOf(paragraph('alpha')));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    a.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'b') Y.applyUpdate(b, update, 'a');
    });
    b.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'a') Y.applyUpdate(a, update, 'b');
    });
    const here = open(a);
    const there = open(b);
    const source = setup(docOf(paragraph('x'), paragraph('y'), paragraph('z')));
    const sourceIds = blockIds(source.editor.state.doc);
    const clip = copyBlocks(source.editor, 0, 2);
    const body = blocks.firstBody(blocks.listBlocks(here.editor.state.doc)[0])!;
    here.editor.view.dispatch(
      here.editor.state.tr.setSelection(
        TextSelection.create(here.editor.state.doc, body.pos + 1 + 5),
      ),
    );
    const mintedThere = there.be.stats.minted;
    paste(here.editor, clip);
    paste(here.editor, clip);
    for (const task of there.tasks.splice(0)) task();

    const ids = blockIds(here.editor.state.doc);
    expect(shape(here.editor.state.doc)).toEqual(['alpha', 'x', 'y', 'z', 'x', 'y', 'z']);
    expect(new Set(ids).size).toBe(7);
    expect(ids.every((id) => id && BLOCK_ID.test(id))).toBe(true);
    expect(ids.some((id) => sourceIds.includes(id))).toBe(false);
    // The other device shows the same blocks with the same ids, and minted none for them.
    expect(blockIds(there.editor.state.doc)).toEqual(ids);
    expect(shape(there.editor.state.doc)).toEqual(shape(here.editor.state.doc));
    expect(there.be.stats.minted).toBe(mintedThere);
    expect(there.be.stats.localDuplicates).toBe(0);
  });
});
