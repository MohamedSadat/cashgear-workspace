// Comments in the page (Phase 6, contracts sections 3 and 6): the anchor rule as a pure function,
// then real editors, each over its own Y.Doc, updates exchanged by hand: a thread made on a
// selection in one editor is found in both, and stays on its block when the block moves (by
// keyboard and by the handle's drag), when text before, inside and after its range changes (here
// and on the other client), and after a split (on the block that keeps the id); it is reported
// `missing` once its block is deleted. Its highlight, marker and keys; no embed frame made again.
import { afterAll, describe, expect, it } from 'vitest';
import { installDom, pressKey } from './testing';

installDom();
const Y = await import('yjs');
const { TextSelection, NodeSelection } = await import('@tiptap/pm/state');
const { documentSchema, writeJSON, CONTENT, build, relativePosition, absolutePosition } =
  await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const blocks = await import('./blocks');
const comments = await import('./comments');
type EditorHost = import('./host').EditorHost;
type CommentAnchor = import('./host').CommentAnchor;
type CommentThreadAnchor = import('./host').CommentThreadAnchor;
type BlockEditor = import('./editor').BlockEditor;
type PMNode = import('@tiptap/pm/model').Node;

const { docOf, paragraph, heading, bullet } = build;
const opened: { destroy(): void }[] = [];
afterAll(() => {
  for (const editor of opened) editor.destroy();
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A host whose threads the test sets; what the editor asked of it. */
function commentHost(extra: EditorHost = {}) {
  let threads: CommentThreadAnchor[] = [];
  const listeners = new Set<() => void>();
  const created: CommentAnchor[] = [];
  const openedThreads: string[] = [];
  const host: EditorHost = {
    ...extra,
    comments: {
      threads: () => threads,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      create: (anchor) => void created.push(anchor),
      open: (id) => void openedThreads.push(id),
    },
  };
  return {
    host,
    created,
    opened: openedThreads,
    set(next: CommentThreadAnchor[]) {
      threads = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

interface Peer {
  doc: InstanceType<typeof Y.Doc>;
  be: BlockEditor;
  outbox: Uint8Array[];
  comments: ReturnType<typeof commentHost>;
}

/** Editors over copies of one document, each its own Yjs client. */
function peers(json: import('@cgw/doc').DocJSON, count = 2, extra: EditorHost = {}): Peer[] {
  const first = new Y.Doc();
  first.clientID = 1;
  writeJSON(first.getXmlFragment(CONTENT), documentSchema(), json);
  const state = Y.encodeStateAsUpdate(first);
  return Array.from({ length: count }, (_, i) => {
    const doc = new Y.Doc();
    doc.clientID = 10 + i;
    Y.applyUpdate(doc, state, 'remote');
    const outbox: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') outbox.push(update);
    });
    // A frame of its own, which the block handle is drawn in.
    const frame = document.createElement('div');
    const element = document.createElement('div');
    frame.append(element);
    document.body.append(frame);
    const host = commentHost(extra);
    const be = createBlockEditor({
      element,
      fragment: doc.getXmlFragment(CONTENT),
      host: host.host,
      schedule: () => {},
    });
    opened.push(be);
    return { doc, be, outbox, comments: host };
  });
}

/** Every client's updates to every other, until none are left. */
function exchange(all: Peer[]) {
  for (let round = 0; round < 3; round++)
    for (const from of all) {
      const updates = from.outbox.splice(0);
      for (const to of all)
        if (to !== from) for (const update of updates) Y.applyUpdate(to.doc, update, 'remote');
    }
}

const stateOf = (peer: Peer) => peer.be.editor.state;
const list = (peer: Peer) => blocks.listBlocks(stateOf(peer).doc);
const find = (peer: Peer, id: string) => list(peer).find((b) => b.id === id);
const bodyOf = (peer: Peer, id: string) => blocks.firstBody(find(peer, id)!)!;
const texts = (peer: Peer) => list(peer).map((b) => b.node.firstChild?.textContent ?? '');

/** Selects `text` (its first occurrence) in the block's body. */
function select(peer: Peer, id: string, text: string) {
  const body = bodyOf(peer, id);
  const at = body.node.textContent.indexOf(text);
  expect(at, text).toBeGreaterThanOrEqual(0);
  const editor = peer.be.editor;
  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, body.pos + 1 + at, body.pos + 1 + at + text.length),
    ),
  );
}

/** Types at an offset in the block's body (or at its end). */
function type(peer: Peer, id: string, offset: number | 'end', text: string) {
  const body = bodyOf(peer, id);
  const at = body.pos + 1 + (offset === 'end' ? body.node.content.size : offset);
  const editor = peer.be.editor;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)).insertText(text),
  );
}

function caret(peer: Peer, id: string, offset: number) {
  const body = bodyOf(peer, id);
  const editor = peer.be.editor;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, body.pos + 1 + offset)),
  );
}

/** The thread as each editor finds it now: how, the text it covers, and the block it is on. */
function where(peer: Peer, threadId: string) {
  const state = stateOf(peer);
  const found = comments.commentsKey.getState(state)!.resolved.find((r) => r.threadId === threadId);
  if (!found) return null;
  const block = found.block === null ? null : (state.doc.nodeAt(found.block) as PMNode);
  return {
    found: found.found,
    text: found.from !== null ? state.doc.textBetween(found.from, found.to!) : null,
    blockId: (block?.attrs.id as string | undefined) ?? null,
  };
}

/** Makes a thread from the selection in `maker`, as the host would, and gives it to everyone. */
async function thread(all: Peer[], maker: Peer, id = 't1') {
  expect(pressKey(maker.be.editor.view, 'Ctrl-Alt-m')).toBe(true);
  const anchor = maker.comments.created.at(-1)!;
  const made: CommentThreadAnchor = { id, ...anchor, active: false };
  for (const peer of all) peer.comments.set([...peer.comments.host.comments!.threads(), made]);
  await tick();
  return made;
}

describe('the anchor rule (contracts section 3), as a pure function', () => {
  const schema = documentSchema();
  const doc = schema.nodeFromJSON(
    docOf(
      { ...paragraph('one two one two'), attrs: { id: 'Block0000001' } },
      { ...paragraph('other'), attrs: { id: 'Block0000002' } },
      { type: 'block', attrs: { id: 'Image0000001' }, content: [{ type: 'image' }] },
    ),
  );
  const blockMap = comments.blockPositions(doc);
  // Block0000001's text starts at 2; "one two one two" is 2..17.
  const at = (positions: Record<string, number>) => ({
    doc,
    blocks: blockMap,
    position: (encoded: string) => positions[encoded] ?? null,
  });
  const base = { id: 't', blockId: 'Block0000001', start: 's', end: 'e', quote: 'two' };

  it('finds the range when both ends land inside the block, in order', () => {
    expect(comments.resolveAnchor(base, at({ s: 6, e: 9 }))).toEqual({
      threadId: 't',
      found: 'range',
      from: 6,
      to: 9,
      block: 0,
    });
  });

  it('falls back to the quote nearest the old place when the ends do not', () => {
    // Ends gone (the block was moved, so written anew): the first occurrence.
    expect(comments.resolveAnchor(base, at({}))).toMatchObject({ found: 'quote', from: 6, to: 9 });
    // Out of order, or collapsed (the range's text was deleted): the quote, nearest where the
    // start landed.
    expect(comments.resolveAnchor(base, at({ s: 14, e: 14 }))).toMatchObject({
      found: 'quote',
      from: 14,
      to: 17,
    });
    // In another block: not this thread's range.
    expect(comments.resolveAnchor(base, at({ s: 20, e: 23 }))).toMatchObject({
      found: 'quote',
      from: 6,
      to: 9,
    });
    // Where it was last found here wins over the first occurrence.
    expect(comments.resolveAnchor(base, { ...at({}), lastOffset: () => 11 })).toMatchObject({
      found: 'quote',
      from: 14,
      to: 17,
    });
  });

  it('falls back to the whole block when the quote is empty or not in its text', () => {
    for (const thread of [
      { ...base, quote: '' },
      { ...base, quote: 'three' },
      { ...base, start: null, end: null, quote: '' },
    ])
      expect(comments.resolveAnchor(thread, at({})), thread.quote).toEqual({
        threadId: 't',
        found: 'block',
        from: null,
        to: null,
        block: 0,
      });
    // An atom block holds no text: always the whole block.
    expect(
      comments.resolveAnchor(
        { ...base, blockId: 'Image0000001', quote: 'two' },
        at({ s: 1, e: 2 }),
      ),
    ).toMatchObject({ found: 'block', block: 28 });
  });

  it('reports a thread whose block is gone as missing', () => {
    expect(
      comments.resolveAnchor({ ...base, blockId: 'GoneGoneGone' }, at({ s: 6, e: 9 })),
    ).toEqual({ threadId: 't', found: 'missing', from: null, to: null, block: null });
  });

  it('reads a person mentioned in the block as `@` and their name', () => {
    const named = schema.nodeFromJSON(
      docOf({
        ...paragraph('Ask ', build.userMention('u1'), ' now'),
        attrs: { id: 'Block0000003' },
      }),
    );
    const leafText = comments.leafTextFor({
      people: { name: () => 'Sara', search: () => [], subscribe: () => () => {} },
    });
    const found = comments.resolveAnchor(
      { id: 't', blockId: 'Block0000003', start: null, end: null, quote: '@Sara now' },
      { doc: named, blocks: comments.blockPositions(named), position: () => null, leafText },
    );
    expect(found).toMatchObject({ found: 'quote' });
    expect(named.textBetween(found.from!, found.to!, '', () => '@')).toBe('@ now');
  });
});

describe('a thread in real editors over Yjs', () => {
  const three = () =>
    docOf(paragraph('alpha beta gamma'), paragraph('second line'), paragraph('third'));

  it('is made from the selection, with its quote, and found as a range in both editors', async () => {
    const all = peers(three());
    const [a, b] = all;
    const x = list(a)[0].id!;
    select(a, x, 'beta');
    const made = await thread(all, a);
    expect(made).toMatchObject({ blockId: x, quote: 'beta' });
    expect(made.start).toEqual(expect.any(String));
    expect(made.end).toEqual(expect.any(String));
    for (const peer of all)
      expect(where(peer, 't1')).toEqual({ found: 'range', text: 'beta', blockId: x });
    // Drawn as a highlight with a marker at its end.
    const dom = a.be.editor.view.dom;
    expect(dom.querySelector('.cgw-commented')!.textContent).toBe('beta');
    expect(dom.querySelector('.cgw-commented-pin')!.getAttribute('aria-label')).toBe(
      'Open the comment',
    );
    expect(b.be.anchorsInOrder()).toEqual([
      { threadId: 't1', found: 'range', pos: bodyOf(b, x).pos + 1 + 6 },
    ]);
  });

  it('keeps its text as text changes before, inside and after it, here and on the other client', async () => {
    const all = peers(three());
    const [a, b] = all;
    const x = list(a)[0].id!;
    select(a, x, 'beta');
    await thread(all, a);
    // Before, here: mapped as typed, and the same when found again.
    type(a, x, 0, 'Oh, ');
    expect(where(a, 't1')).toMatchObject({ found: 'range', text: 'beta' });
    // At either edge: outside it.
    type(a, x, 'Oh, alpha '.length, '[');
    type(a, x, 'Oh, alpha [beta'.length, ']');
    expect(where(a, 't1')).toMatchObject({ found: 'range', text: 'beta' });
    // Inside: it grows.
    type(a, x, 'Oh, alpha [be'.length, 'TT');
    expect(where(a, 't1')).toMatchObject({ found: 'range', text: 'beTTta' });
    // After.
    type(a, x, 'end', ' and more');
    exchange(all);
    expect(texts(b)[0]).toBe('Oh, alpha [beTTta] gamma and more');
    for (const peer of all)
      expect(where(peer, 't1')).toMatchObject({ found: 'range', text: 'beTTta' });
    // On the other client: before, inside and after, then delivered here.
    type(b, x, 0, '1 ');
    type(b, x, '1 Oh, alpha [beT'.length, 'U');
    type(b, x, 'end', '!');
    exchange(all);
    expect(texts(a)[0]).toBe('1 Oh, alpha [beTUTta] gamma and more!');
    for (const peer of all)
      expect(where(peer, 't1')).toMatchObject({ found: 'range', text: 'beTUTta' });
    // Part of it deleted: what is left; all of it: the quote is not there, so the whole block.
    const body = bodyOf(b, x);
    const from = body.pos + 1 + '1 Oh, alpha [be'.length;
    b.be.editor.view.dispatch(b.be.editor.state.tr.delete(from, from + 3));
    exchange(all);
    for (const peer of all)
      expect(where(peer, 't1')).toMatchObject({ found: 'range', text: 'beta' });
    const left = bodyOf(a, x).pos + 1 + '1 Oh, alpha ['.length;
    a.be.editor.view.dispatch(a.be.editor.state.tr.delete(left, left + 4));
    await tick();
    exchange(all);
    await tick();
    for (const peer of all)
      expect(where(peer, 't1')).toEqual({ found: 'block', text: null, blockId: x });
  });

  it('follows its block when the block is moved by keyboard, here and on the other client', async () => {
    const all = peers(three());
    const [a, b] = all;
    const x = list(a)[0].id!;
    select(a, x, 'beta');
    await thread(all, a);
    caret(a, x, 0);
    pressKey(a.be.editor.view, 'Alt-Shift-ArrowDown');
    pressKey(a.be.editor.view, 'Alt-Shift-ArrowDown');
    expect(list(a).map((block) => block.id)[2]).toBe(x);
    // The move is more than typing: found again once the binding has written it.
    await tick();
    exchange(all);
    await tick();
    for (const peer of all) {
      const found = where(peer, 't1')!;
      expect(['range', 'quote']).toContain(found.found);
      expect(found).toMatchObject({ text: 'beta', blockId: x });
    }
    expect(b.be.anchorsInOrder()[0].pos).toBe(bodyOf(b, x).pos + 1 + 6);
  });

  it('follows its block when the block is moved by the handle’s drag', async () => {
    const all = peers(three());
    const [a] = all;
    const x = list(a)[0].id!;
    select(a, x, 'gamma');
    await thread(all, a);
    const view = a.be.editor.view;
    const mine = view.dom.parentElement!.parentElement!.querySelector<HTMLElement>('.cgw-handle')!;
    mine.dataset.pos = String(find(a, x)!.pos);
    const data = {
      types: [] as string[],
      values: {} as Record<string, string>,
      setData(kind: string, value: string) {
        this.types.push(kind);
        this.values[kind] = value;
      },
      getData(kind: string) {
        return this.values[kind] ?? '';
      },
      setDragImage() {},
      effectAllowed: '',
      dropEffect: '',
    };
    const fire = (target: EventTarget, name: string, extra: Record<string, unknown>) => {
      const event = new Event(name, { bubbles: true, cancelable: true });
      for (const [key, value] of Object.entries(extra))
        Object.defineProperty(event, key, { value });
      target.dispatchEvent(event);
    };
    // Dropped on the last block's lower half: after it.
    const last = view.nodeDOM(list(a)[2].pos) as HTMLElement;
    fire(mine, 'dragstart', { dataTransfer: data });
    fire(last.firstElementChild!, 'dragover', { dataTransfer: data, clientX: 0, clientY: 1 });
    fire(last.firstElementChild!, 'drop', { clientX: 0, clientY: 1 });
    fire(mine, 'dragend', {});
    expect(texts(a)).toEqual(['second line', 'third', 'alpha beta gamma']);
    await tick();
    exchange(all);
    await tick();
    for (const peer of all) {
      const found = where(peer, 't1')!;
      expect(['range', 'quote']).toContain(found.found);
      expect(found).toMatchObject({ text: 'gamma', blockId: x });
    }
  });

  it('stays on the block that keeps the id when the block is split', async () => {
    const all = peers(three());
    const [a, b] = all;
    const x = list(a)[0].id!;
    select(a, x, 'alpha');
    await thread(all, a, 'first');
    select(a, x, 'gamma');
    await thread(all, a, 'last');
    caret(a, x, 'alpha beta '.length);
    pressKey(a.be.editor.view, 'Enter');
    expect(texts(a).slice(0, 2)).toEqual(['alpha beta ', 'gamma']);
    await tick();
    exchange(all);
    await tick();
    for (const peer of [a, b]) {
      expect(where(peer, 'first')).toEqual({ found: 'range', text: 'alpha', blockId: x });
      // Its text went to the new block, which has another id: the thread stays on its block.
      expect(where(peer, 'last')).toEqual({ found: 'block', text: null, blockId: x });
    }
  });

  it('is missing once its block is deleted, here and on the other client, and listed last', async () => {
    const all = peers(three());
    const [a, b] = all;
    const x = list(a)[0].id!;
    const y = list(a)[1].id!;
    select(a, y, 'line');
    await thread(all, a, 'kept');
    select(a, x, 'beta');
    await thread(all, a, 'gone');
    b.be.editor.view.dispatch(blocks.deleteBlock(stateOf(b), find(b, x)!));
    await tick();
    exchange(all);
    await tick();
    for (const peer of all) {
      expect(where(peer, 'gone')).toEqual({ found: 'missing', text: null, blockId: null });
      expect(peer.be.anchorsInOrder()).toEqual([
        { threadId: 'kept', found: 'range', pos: expect.any(Number) },
        { threadId: 'gone', found: 'missing', pos: null },
      ]);
      expect(peer.be.scrollToThread('gone')).toBe(false);
      expect(peer.be.scrollToThread('kept')).toBe(true);
    }
  });

  it('lists threads in the order the page reads', async () => {
    const all = peers(three(), 1);
    const [a] = all;
    const [x, y, z] = list(a).map((block) => block.id!);
    select(a, z, 'third');
    await thread(all, a, 'c');
    select(a, x, 'gamma');
    await thread(all, a, 'b');
    select(a, x, 'alpha');
    await thread(all, a, 'a');
    a.be.editor.view.dispatch(
      a.be.editor.state.tr.setSelection(NodeSelection.create(stateOf(a).doc, find(a, y)!.pos)),
    );
    await thread(all, a, 'block');
    expect(a.comments.created.at(-1)).toEqual({ blockId: y, start: null, end: null, quote: '' });
    expect(a.be.anchorsInOrder().map((t) => [t.threadId, t.found])).toEqual([
      ['a', 'range'],
      ['b', 'range'],
      ['block', 'block'],
      ['c', 'range'],
    ]);
  });
});

describe('the Comment action', () => {
  it('makes a whole-block anchor on a caret, an atom block and a block selection', async () => {
    const all = peers(docOf(paragraph('one'), build.divider(), paragraph('two')), 1);
    const [a] = all;
    const [x, divider] = list(a).map((block) => block.id!);
    caret(a, x, 1);
    expect(comments.commentAnchorFor(stateOf(a), a.comments.host)).toEqual({
      blockId: x,
      start: null,
      end: null,
      quote: '',
    });
    const body = blocks.firstBody(find(a, divider)!)!;
    a.be.editor.view.dispatch(
      a.be.editor.state.tr.setSelection(NodeSelection.create(stateOf(a).doc, body.pos)),
    );
    expect(pressKey(a.be.editor.view, 'Ctrl-Alt-m')).toBe(true);
    expect(a.comments.created.at(-1)).toEqual({
      blockId: divider,
      start: null,
      end: null,
      quote: '',
    });
    a.comments.set([{ id: 'd', ...a.comments.created.at(-1)!, active: true }]);
    await tick();
    // The block is tinted and has a marker; the marker opens the thread.
    const dom = a.be.editor.view.dom;
    expect(dom.querySelector('.cgw-divider.is-commented.is-comment-active')).not.toBeNull();
    const pin = dom.querySelector<HTMLButtonElement>('.cgw-commented-pin.is-active')!;
    expect(pin.parentElement!.matches('[data-block]')).toBe(true);
    pin.click();
    expect(a.comments.opened).toEqual(['d']);
  });

  it('takes the selection’s first block only, and its first line of text', async () => {
    const all = peers(docOf(paragraph('first part'), bullet(['second part'])), 1);
    const [a] = all;
    const [x] = list(a).map((block) => block.id!);
    const doc = stateOf(a).doc;
    const from = bodyOf(a, x).pos + 1 + 'first '.length;
    const to = doc.content.size - 3;
    a.be.editor.view.dispatch(
      a.be.editor.state.tr.setSelection(TextSelection.create(doc, from, to)),
    );
    const anchor = comments.commentAnchorFor(stateOf(a), a.comments.host)!;
    expect(anchor).toMatchObject({ blockId: x, quote: 'part' });
  });

  it('keeps the quote to 1,000 characters', () => {
    const long = 'x'.repeat(1500);
    const [a] = peers(docOf(paragraph(long)), 1);
    const x = list(a)[0].id!;
    select(a, x, long);
    expect(comments.commentAnchorFor(stateOf(a), a.comments.host)!.quote).toHaveLength(
      comments.QUOTE_MAX,
    );
  });

  it('is not offered when the host gives no way to comment', () => {
    const all = peers(docOf(paragraph('one')), 1, {});
    const [a] = all;
    const x = list(a)[0].id!;
    delete (a.comments.host.comments as { create?: unknown }).create;
    select(a, x, 'one');
    expect(pressKey(a.be.editor.view, 'Ctrl-Alt-m')).toBe(false);
    // Ctrl+Alt+Shift+M is the shell's (show or hide the comments), not this.
    expect(pressKey(a.be.editor.view, 'Ctrl-Alt-Shift-m')).toBe(false);
  });

  it('opens a thread when its highlight is clicked', async () => {
    const all = peers(docOf(heading(1, 'A title here')), 1);
    const [a] = all;
    const x = list(a)[0].id!;
    select(a, x, 'title');
    await thread(all, a, 'h');
    const view = a.be.editor.view;
    const span = view.dom.querySelector('.cgw-commented')!;
    const pos = bodyOf(a, x).pos + 1 + 4;
    view.someProp('handleClick', (f) => f(view, pos, { target: span } as unknown as MouseEvent));
    expect(a.comments.opened).toEqual(['h']);
    // Not elsewhere in the line.
    view.someProp('handleClick', (f) =>
      f(view, pos - 2, { target: view.dom.querySelector('h1') } as unknown as MouseEvent),
    );
    expect(a.comments.opened).toEqual(['h']);
  });
});

describe('what comments never do', () => {
  it('are not found again per keystroke, and change nothing in the document', async () => {
    const all = peers(docOf(paragraph('alpha beta')), 1);
    const [a] = all;
    const x = list(a)[0].id!;
    select(a, x, 'beta');
    await thread(all, a);
    let reads = 0;
    const host = a.comments.host.comments!;
    const threads = host.threads;
    host.threads = () => (reads++, threads());
    const before = JSON.stringify(a.doc.getXmlFragment(CONTENT).toJSON());
    for (const letter of 'typing') type(a, x, 'end', letter);
    await tick();
    expect(reads).toBe(0);
    expect(where(a, 't1')).toMatchObject({ found: 'range', text: 'beta' });
    // The anchor lives in the host's records, not in the page.
    expect(JSON.stringify(a.doc.getXmlFragment(CONTENT).toJSON())).toBe(
      before.replace('alpha beta', 'alpha betatyping'),
    );
  });

  it('never make an embed’s frame again when a thread appears on its block', async () => {
    const mounts: unknown[] = [];
    let destroys = 0;
    const extra: EditorHost = {
      databases: {
        mount: (_element, options) => {
          mounts.push(options);
          return () => void destroys++;
        },
      },
    };
    const all = peers(docOf(paragraph('above'), build.databaseView('db1')), 1, extra);
    const [a] = all;
    await tick();
    expect(mounts).toHaveLength(1);
    const id = list(a)[1].id!;
    a.comments.set([{ id: 'e', blockId: id, start: null, end: null, quote: '', active: false }]);
    await tick();
    expect(where(a, 'e')).toEqual({ found: 'block', text: null, blockId: id });
    expect(a.be.editor.view.dom.querySelector('.cgw-databaseView.is-commented')).not.toBeNull();
    a.comments.set([{ id: 'e', blockId: id, start: null, end: null, quote: '', active: true }]);
    await tick();
    a.comments.set([]);
    await tick();
    type(a, list(a)[0].id!, 'end', ' and more');
    expect(mounts).toHaveLength(1);
    expect(destroys).toBe(0);
  });
});

describe('relative positions through the binding', () => {
  it('stick to the character after (a start) or before (an end)', () => {
    const [a] = peers(docOf(paragraph('abcd')), 1);
    const x = list(a)[0].id!;
    const pos = bodyOf(a, x).pos + 1 + 2;
    const state = stateOf(a);
    const after = relativePosition(state, pos, 0)!;
    const before = relativePosition(state, pos, -1)!;
    type(a, x, 2, 'XY');
    const now = stateOf(a);
    expect(absolutePosition(now, after)).toBe(pos + 2);
    expect(absolutePosition(now, before)).toBe(pos);
  });
});
