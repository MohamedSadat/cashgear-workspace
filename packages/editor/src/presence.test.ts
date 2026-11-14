// Presence in the editor (Phase 6, contracts sections 4 and 6): two real editors, each over its own
// Y.Doc, updates exchanged by hand. One editor's selection goes to its host as two relative
// positions (at most every 50 ms, null when it loses focus); the other draws it as a caret with the
// person's name in their colour, and the selection tinted, in the right place in left-to-right and
// right-to-left text, through edits on either side. Cursors are made again only when the host
// says they changed or the document changed under them: never per keystroke, never an embed's
// frame made again.
import { afterAll, describe, expect, it } from 'vitest';
import { installDom } from './testing';

installDom();
const Y = await import('yjs');
const { TextSelection, NodeSelection } = await import('@tiptap/pm/state');
const { documentSchema, writeJSON, CONTENT, build } = await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const blocks = await import('./blocks');
const { presenceColour, presenceKey, LOCAL_DELAY_MS } = await import('./presence');
type EditorHost = import('./host').EditorHost;
type PresenceCursor = import('./host').PresenceCursor;
type BlockEditor = import('./editor').BlockEditor;

const { docOf, paragraph, textBlock } = build;
const opened: { destroy(): void }[] = [];
afterAll(() => {
  for (const editor of opened) editor.destroy();
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, LOCAL_DELAY_MS + 20));

/** A host whose others' cursors the test sets; what the editor told it of its own. */
function presenceHost(extra: EditorHost = {}) {
  let cursors: PresenceCursor[] = [];
  let reads = 0;
  const listeners = new Set<() => void>();
  const told: ({ anchor: string; head: string } | null)[] = [];
  const host: EditorHost = {
    ...extra,
    presence: {
      cursors: () => (reads++, cursors),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setLocal: (cursor) => void told.push(cursor),
    },
  };
  return {
    host,
    told,
    reads: () => reads,
    set(next: PresenceCursor[]) {
      cursors = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

interface Peer {
  doc: InstanceType<typeof Y.Doc>;
  be: BlockEditor;
  outbox: Uint8Array[];
  presence: ReturnType<typeof presenceHost>;
}

function peers(json: import('@cgw/doc').DocJSON, extra: EditorHost = {}): Peer[] {
  const first = new Y.Doc();
  first.clientID = 1;
  writeJSON(first.getXmlFragment(CONTENT), documentSchema(), json);
  const state = Y.encodeStateAsUpdate(first);
  return [0, 1].map((i) => {
    const doc = new Y.Doc();
    doc.clientID = 20 + i;
    Y.applyUpdate(doc, state, 'remote');
    const outbox: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') outbox.push(update);
    });
    const element = document.createElement('div');
    document.body.append(element);
    const presence = presenceHost(extra);
    const be = createBlockEditor({
      element,
      fragment: doc.getXmlFragment(CONTENT),
      host: presence.host,
      schedule: () => {},
    });
    // jsdom focuses only what takes focus.
    be.editor.view.dom.tabIndex = 0;
    opened.push(be);
    return { doc, be, outbox, presence };
  });
}

function exchange(all: Peer[]) {
  for (let round = 0; round < 3; round++)
    for (const from of all) {
      const updates = from.outbox.splice(0);
      for (const to of all)
        if (to !== from) for (const update of updates) Y.applyUpdate(to.doc, update, 'remote');
    }
}

const list = (peer: Peer) => blocks.listBlocks(peer.be.editor.state.doc);
const bodyOf = (peer: Peer, index: number) => blocks.firstBody(list(peer)[index])!;

function selectIn(peer: Peer, index: number, from: number, to = from) {
  const body = bodyOf(peer, index);
  const editor = peer.be.editor;
  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, body.pos + 1 + from, body.pos + 1 + to),
    ),
  );
}

function type(peer: Peer, index: number, offset: number, text: string) {
  const body = bodyOf(peer, index);
  const editor = peer.be.editor;
  const at = body.pos + 1 + offset;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)).insertText(text),
  );
}

/** Sara's cursor at what `from` last told its host. */
function saraFrom(from: Peer, name = 'Sara'): PresenceCursor {
  const cursor = from.presence.told.at(-1)!;
  return {
    key: 'sara:21',
    userId: 'sara',
    name,
    colour: 'var(--cgw-presence-3)',
    anchor: cursor.anchor,
    head: cursor.head,
  };
}

/** Where the other editor draws cursors: the caret's position and the tinted text. */
function drawn(peer: Peer) {
  const view = peer.be.editor.view;
  const set = presenceKey.getState(view.state)!.set;
  const found = set.find();
  const caret = found.find((d) => (d.spec as { key?: string }).key?.startsWith('presence:'));
  const tint = found.find((d) => (d.spec as { presence?: boolean }).presence);
  return {
    caret: caret ? caret.from : null,
    tinted: tint ? view.state.doc.textBetween(tint.from, tint.to) : null,
  };
}

describe('presence cursors', () => {
  it('tell the host this editor’s selection as relative positions, once it settles, and null on blur', async () => {
    const [a] = peers(docOf(paragraph('alpha beta')));
    a.be.editor.view.dom.focus();
    expect(a.be.editor.view.hasFocus()).toBe(true);
    selectIn(a, 0, 1);
    selectIn(a, 0, 2);
    selectIn(a, 0, 3);
    expect(a.presence.told).toEqual([]);
    await settle();
    // One message for the burst.
    expect(a.presence.told).toHaveLength(1);
    const cursor = a.presence.told[0]!;
    expect(cursor.anchor).toBe(cursor.head);
    expect(cursor.anchor.length).toBeLessThanOrEqual(256);
    expect(cursor.anchor).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // The same selection again is not told again; another is.
    selectIn(a, 0, 3);
    await settle();
    expect(a.presence.told).toHaveLength(1);
    selectIn(a, 0, 0, 5);
    await settle();
    expect(a.presence.told).toHaveLength(2);
    expect(a.presence.told[1]!.anchor).not.toBe(a.presence.told[1]!.head);
    a.be.editor.view.dom.blur();
    expect(a.presence.told.at(-1)).toBeNull();
  });

  it('draw the other’s caret with their name and colour, and their selection tinted', async () => {
    const all = peers(docOf(paragraph('alpha beta gamma'), paragraph('second')));
    const [a, b] = all;
    a.be.editor.view.dom.focus();
    selectIn(a, 0, 'alpha '.length, 'alpha beta'.length);
    await settle();
    b.presence.set([saraFrom(a)]);
    await tick();
    const body = bodyOf(b, 0);
    expect(drawn(b)).toEqual({ caret: body.pos + 1 + 10, tinted: 'beta' });
    const caret = b.be.editor.view.dom.querySelector<HTMLElement>('.cgw-presence-caret')!;
    expect(caret.dataset.name).toBe('Sara');
    expect(caret.getAttribute('aria-hidden')).toBe('true');
    expect(caret.style.getPropertyValue('--cgw-presence-colour')).toBe('var(--cgw-presence-3)');
    // The name is drawn by CSS: not text of the page.
    expect(b.be.editor.view.dom.textContent).toBe('alpha beta gammasecond');
    const tint = b.be.editor.view.dom.querySelector<HTMLElement>('.cgw-presence-selection')!;
    expect(tint.textContent).toBe('beta');
  });

  it('keep their place through edits here and on the other client', async () => {
    const all = peers(docOf(paragraph('alpha beta gamma')));
    const [a, b] = all;
    a.be.editor.view.dom.focus();
    selectIn(a, 0, 'alpha beta'.length);
    await settle();
    b.presence.set([saraFrom(a)]);
    await tick();
    const at = () => drawn(b).caret! - (bodyOf(b, 0).pos + 1);
    expect(at()).toBe(10);
    // Typed here before it: mapped.
    type(b, 0, 0, 'Oh, ');
    expect(at()).toBe(14);
    // Typed there before it (the other's own cursor moves with its typing, so it tells again).
    type(a, 0, 0, '1 ');
    exchange(all);
    expect(b.be.editor.state.doc.textContent).toBe('1 Oh, alpha beta gamma');
    expect(at()).toBe(16);
    // A structural change here (a new block above): found again a moment later.
    const editor = b.be.editor;
    editor.view.dispatch(editor.state.tr.insert(0, editor.schema.nodeFromJSON(paragraph('above'))));
    await tick();
    expect(drawn(b).caret! - (bodyOf(b, 1).pos + 1)).toBe(16);
  });

  it('draw the caret in the right place in right-to-left text', async () => {
    const all = peers(docOf(textBlock('paragraph', ['مرحبا بالعالم'], { dir: 'rtl' })));
    const [a, b] = all;
    a.be.editor.view.dom.focus();
    selectIn(a, 0, 'مرحبا'.length);
    await settle();
    b.presence.set([saraFrom(a, 'سارة')]);
    await tick();
    expect(drawn(b).caret).toBe(bodyOf(b, 0).pos + 1 + 'مرحبا'.length);
    const caret = b.be.editor.view.dom.querySelector<HTMLElement>('.cgw-presence-caret')!;
    expect(caret.dataset.name).toBe('سارة');
    // In the line's own order, between the two words, inside the right-to-left body.
    expect(caret.closest('[data-body="textBody"]')!.getAttribute('dir')).toBe('rtl');
    const text = caret.closest('.cgw-text')!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEndBefore(caret);
    expect(range.toString()).toBe('مرحبا');
  });

  it('are made again only when the host says so or the document changes under them', async () => {
    const all = peers(docOf(paragraph('alpha beta')));
    const [a, b] = all;
    a.be.editor.view.dom.focus();
    selectIn(a, 0, 3);
    await settle();
    b.presence.set([saraFrom(a)]);
    await tick();
    const reads = b.presence.reads();
    for (const letter of 'typing') type(b, 0, 10, letter);
    await tick();
    expect(b.presence.reads()).toBe(reads);
    // A change from the other client: once.
    type(a, 0, 0, 'x');
    exchange(all);
    expect(b.presence.reads()).toBe(reads + 1);
  });

  it('leave out a cursor whose positions do not resolve, and refuse a colour that is not one', async () => {
    const [, b] = peers(docOf(paragraph('alpha')));
    b.presence.set([
      { key: 'k', userId: 'u', name: 'X', colour: 'red', anchor: 'AAAA', head: '%%%' },
    ]);
    await tick();
    expect(drawn(b)).toEqual({ caret: null, tinted: null });
    expect(presenceColour('--cgw-presence-2')).toBe('var(--cgw-presence-2)');
    expect(presenceColour('var(--cgw-presence-2)')).toBe('var(--cgw-presence-2)');
    expect(presenceColour('#ff0000')).toBe('#ff0000');
    expect(presenceColour('red; background: url(x)')).toBe('var(--cg-accent)');
  });

  it('outline a block selected whole without making its embed’s frame again', async () => {
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
    const all = peers(docOf(paragraph('above'), build.databaseView('db1')), extra);
    const [a, b] = all;
    await tick();
    expect(mounts).toHaveLength(2);
    const body = bodyOf(a, 1);
    a.be.editor.view.dom.focus();
    a.be.editor.view.dispatch(
      a.be.editor.state.tr.setSelection(NodeSelection.create(a.be.editor.state.doc, body.pos)),
    );
    await settle();
    b.presence.set([saraFrom(a)]);
    await tick();
    const frame = b.be.editor.view.dom.querySelector<HTMLElement>('.is-presence-selected')!;
    expect(frame.dataset.body).toBe('databaseView');
    expect(frame.dataset.presenceName).toBe('Sara');
    b.presence.set([]);
    await tick();
    expect(b.be.editor.view.dom.querySelector('.is-presence-selected')).toBeNull();
    expect(mounts).toHaveLength(2);
    expect(destroys).toBe(0);
  });

  it('follow a new host: its cursors, and this editor’s selection told to it', async () => {
    const all = peers(docOf(paragraph('alpha beta')));
    const [a, b] = all;
    a.be.editor.view.dom.focus();
    selectIn(a, 0, 2);
    await settle();
    const next = presenceHost();
    next.set([saraFrom(a)]);
    b.be.setHost(next.host);
    await tick();
    expect(drawn(b).caret).toBe(bodyOf(b, 0).pos + 1 + 2);
    const other = presenceHost();
    a.be.setHost(other.host);
    await settle();
    expect(other.told).toHaveLength(1);
  });
});
