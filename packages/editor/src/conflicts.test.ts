// Every row of SYNC_DESIGN.md's "Inside a page (Yjs)" table, scripted: two or three real editors,
// each over its own PageDocument, Yjs updates exchanged by hand as the sync engine and the server
// do (each device pushes its own updates to one log; each pulls the others' in order, and
// PageDocument.applyRemote applies them). Each ends in the stated result,
// with the `doc.moveConflict` notice on the move rows. Then the move intent itself, and how well
// the notice matches the typing that moves actually lost, measured on random runs in S1's manner.
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { installDom } from './testing';

installDom();
const { pressKey } = await import('./testing');
const Y = await import('yjs');
const { TextSelection } = await import('@tiptap/pm/state');
const {
  CONTENT,
  LOAD,
  MOVES,
  REMOTE,
  PageDocument,
  build,
  documentSchema,
  fragmentToJSON,
  newDocumentUpdate,
  plainText,
  repairId,
  undoCommand,
} = await import('@cgw/doc');
const { createBlockEditor } = await import('./editor');
const blocks = await import('./blocks');

type DocEvent = import('@cgw/doc').DocEvent;
type DocStore = import('@cgw/doc').DocStore;
type DocJSON = import('@cgw/doc').DocJSON;
type BlockEditor = import('./editor').BlockEditor;

const { docOf, paragraph, bullet } = build;
const PAGE = '01936f6e-0000-7000-8000-00000000c0f1';
const opened: { destroy(): void }[] = [];
afterAll(() => {
  for (const editor of opened) editor.destroy();
});

/** The five things a page's document needs from a store, in memory, with its history. */
function memoryStore(first: Uint8Array) {
  const log: { updateId: string; data: Uint8Array; localSeq: number; seq: number | null }[] = [
    { updateId: 'first', data: first, localSeq: 1, seq: 1 },
  ];
  const history: Uint8Array[] = [];
  const store: DocStore = {
    loadDoc: async () => ({
      snapshot: null,
      snapshotCovers: 0,
      updates: log.map((u) => ({ ...u })),
    }),
    appendDocUpdates: async (_id, updates) =>
      updates.map((u) => {
        log.push({ ...u, localSeq: log.length + 1, seq: null });
        return log.length;
      }),
    compactDoc: async () => {},
    quarantineUpdates: async () => {},
    addHistory: async (pageId, snapshot) => {
      history.push(snapshot);
      return { id: String(history.length), pageId, createdAt: '', sizeBytes: snapshot.length };
    },
  };
  return { store, history };
}

interface Device {
  name: string;
  page: import('@cgw/doc').PageDocument;
  be: BlockEditor;
  tasks: (() => void)[];
  events: DocEvent[];
  history: Uint8Array[];
  /** This device's own updates not yet pushed, and how far into the server's log it has pulled. */
  outbox: Uint8Array[];
  cursor: number;
}

/** The server's log of a page: every device's updates, in the order they were pushed. */
let server: { from: Device; data: Uint8Array }[] = [];

async function devices(json: DocJSON, count = 2): Promise<Device[]> {
  server = [];
  const first = newDocumentUpdate(PAGE, json, 1);
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const { store, history } = memoryStore(first);
      const events: DocEvent[] = [];
      const page = await PageDocument.open(PAGE, store, {
        clientId: 100 + i,
        onEvent: (event) => events.push(event),
        setTimer: () => null,
        clearTimer: () => {},
      });
      const tasks: (() => void)[] = [];
      const be = createBlockEditor({
        element: document.createElement('div'),
        fragment: page.fragment,
        schedule: (task) => tasks.push(task),
      });
      opened.push(be);
      const outbox: Uint8Array[] = [];
      page.doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin !== REMOTE && origin !== LOAD) outbox.push(update);
      });
      return { name: 'ABC'[i], page, be, tasks, events, history, outbox, cursor: 0 };
    }),
  );
}

const runTasks = (device: Device) => {
  while (device.tasks.length) device.tasks.shift()!();
};

function push(device: Device) {
  for (const data of device.outbox.splice(0)) server.push({ from: device, data });
}

/** The others' updates since the last pull, applied as one batch, as the engine does. */
function pull(device: Device) {
  const updates = server
    .slice(device.cursor)
    .filter((u) => u.from !== device)
    .map((u) => u.data);
  device.cursor = server.length;
  if (updates.length) device.page.applyRemote(updates);
  runTasks(device);
}

/** `from` pushes, then `to` pulls. */
function deliver(from: Device, to: Device) {
  push(from);
  pull(to);
}

/** Everyone online until nothing is left to send (the id repair included). */
function settle(all: Device[]) {
  for (let round = 0; round < 4; round++) {
    for (const device of all) push(device);
    for (const device of all) pull(device);
  }
}

const editorOf = (device: Device) => device.be.editor;
const list = (device: Device) => blocks.listBlocks(editorOf(device).state.doc);
const idAt = (device: Device, index: number) => list(device)[index].id!;
const find = (device: Device, id: string) => list(device).find((b) => b.id === id);
const texts = (device: Device) => list(device).map((b) => b.node.firstChild?.textContent ?? '');

function caret(device: Device, id: string, offset: number | 'end' = 0) {
  const editor = editorOf(device);
  const body = blocks.firstBody(find(device, id)!)!;
  const at = offset === 'end' ? body.node.content.size : offset;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, body.pos + 1 + at)),
  );
}

function type(device: Device, id: string, offset: number | 'end', text: string) {
  caret(device, id, offset);
  const editor = editorOf(device);
  editor.view.dispatch(editor.state.tr.insertText(text));
}

const press = (device: Device, key: string) => pressKey(editorOf(device).view, key);

const notices = (device: Device) =>
  device.events.flatMap((e) =>
    e.kind === 'notice' ? [{ code: e.code, blockId: e.blockId, reason: e.reason }] : [],
  );

function converged(all: Device[]) {
  const json = all.map((d) => JSON.stringify(editorOf(d).getJSON()));
  for (const j of json) expect(j).toBe(json[0]);
  const yjs = all.map((d) => JSON.stringify(fragmentToJSON(d.page.fragment)));
  for (const j of yjs) expect(j).toBe(yjs[0]);
  expect(() => editorOf(all[0]).state.doc.check()).not.toThrow();
}

const textOf = (snapshot: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, snapshot);
  return plainText(fragmentToJSON(doc.getXmlFragment(CONTENT)));
};

const three = () => docOf(paragraph('alpha beta'), paragraph('gamma'), paragraph('delta'));

describe('inside a page: every row of the conflict table', () => {
  it('two people type in the same block: both insertions stand', async () => {
    const [a, b] = await devices(three());
    const x = idAt(a, 0);
    type(a, x, 0, '[a]');
    type(b, x, 'end', '[b]');
    settle([a, b]);
    expect(texts(a)[0]).toBe('[a]alpha beta[b]');
    converged([a, b]);
    expect(notices(a)).toEqual([]);
    expect(notices(b)).toEqual([]);
  });

  it('one edits a block, another deletes it: deleted, the edit with it; history has it', async () => {
    const [a, b] = await devices(three());
    const x = idAt(a, 1);
    type(a, x, 'end', ' [a]');
    // The device keeps a history snapshot as it edits (PageDocument's history), here at once.
    await a.page.keepHistory();
    editorOf(b).view.dispatch(blocks.deleteBlock(editorOf(b).state, find(b, x)!));
    settle([a, b]);
    expect(find(a, x)).toBeUndefined();
    expect(texts(a)).toEqual(['alpha beta', 'delta']);
    expect(textOf(a.history[a.history.length - 1])).toContain('gamma [a]');
    converged([a, b]);
    expect(notices(a)).toEqual([]);
  });

  for (const how of ['moves', 'indents'] as const)
    it(`one edits a block while another ${how} it: the edit is lost, and the editor is told`, async () => {
      const [a, b] = await devices(three());
      const x = idAt(a, 1);
      type(a, x, 'end', ' [a]');
      caret(b, x, 0);
      press(b, how === 'moves' ? 'Alt-Shift-ArrowDown' : 'Tab');
      // B recorded the move in the same document.
      expect(b.page.doc.getMap(MOVES).get(x)).toMatchObject({
        parent: how === 'moves' ? null : idAt(b, 0),
      });
      deliver(b, a);
      expect(notices(a)).toEqual([{ code: 'doc.moveConflict', blockId: x, reason: 'editLost' }]);
      settle([a, b]);
      expect(find(a, x)!.node.firstChild!.textContent).toBe('gamma');
      expect(how === 'moves' ? texts(a) : texts(a)).toEqual(
        how === 'moves' ? ['alpha beta', 'delta', 'gamma'] : ['alpha beta', 'gamma', 'delta'],
      );
      if (how === 'indents') expect(find(a, x)!.depth).toBe(1);
      converged([a, b]);
      // The mover lost nothing of its own: no notice there.
      expect(notices(b)).toEqual([]);
    });

  it('one edits a block while another merges it into the block above: the edit is lost', async () => {
    const [a, b] = await devices(three());
    const x = idAt(a, 1);
    type(a, x, 'end', ' [a]');
    caret(b, x, 0);
    press(b, 'Backspace');
    settle([a, b]);
    expect(texts(a)).toEqual(['alpha betagamma', 'delta']);
    expect(find(a, x)).toBeUndefined();
    converged([a, b]);
    // A merge is not a move: the block is gone, not moved, so no move notice.
    expect(notices(a)).toEqual([]);
  });

  it('one edits a block while another moves a different block: both stand', async () => {
    const [a, b] = await devices(three());
    const x = idAt(a, 1);
    const other = idAt(a, 0);
    type(a, x, 'end', ' [a]');
    caret(b, other, 0);
    press(b, 'Alt-Shift-ArrowDown');
    press(b, 'Alt-Shift-ArrowDown');
    settle([a, b]);
    expect(texts(a)).toEqual(['gamma [a]', 'delta', 'alpha beta']);
    converged([a, b]);
    expect(notices(a)).toEqual([]);
    expect(notices(b)).toEqual([]);
  });

  it('one types while another turns the block into another text kind: both stand', async () => {
    const [a, b] = await devices(three());
    const x = idAt(a, 1);
    type(a, x, 3, '[a]');
    editorOf(b).view.dispatch(
      blocks.turnInto(editorOf(b).state, find(b, x)!, { kind: 'heading', attrs: { level: 2 } })!,
    );
    settle([a, b]);
    const body = find(a, x)!.node.firstChild!;
    expect(body.attrs).toMatchObject({ kind: 'heading', level: 2 });
    expect(body.textContent).toBe('gam[a]ma');
    converged([a, b]);
  });

  it('two people move the same block: two copies, the id repaired, and both told', async () => {
    // As S1's scenario: one drags it to the top, the other to the end.
    const [a, b] = await devices(
      docOf(...['b0', 'b1', 'b2', 'b3', 'b4', 'b5'].map((t) => paragraph(t))),
    );
    const x = idAt(a, 2);
    const drag = (device: Device, to: (size: number) => number) => {
      const editor = editorOf(device);
      editor.view.dispatch(
        blocks.moveBlock(editor.state, find(device, x)!, to(editor.state.doc.content.size))!,
      );
    };
    drag(a, () => 0);
    drag(b, (size) => size);
    settle([a, b]);
    expect(texts(a)).toEqual(['b2', 'b0', 'b1', 'b3', 'b4', 'b5', 'b2']);
    const ids = list(a).map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === x || id === repairId(x, 1))).toHaveLength(2);
    converged([a, b]);
    expect(notices(a)).toEqual([{ code: 'doc.moveConflict', blockId: x, reason: 'movedTwice' }]);
    expect(notices(b)).toEqual([{ code: 'doc.moveConflict', blockId: x, reason: 'movedTwice' }]);
  });

  it('two people split the same paragraph: the shared tail appears twice', async () => {
    const [a, b] = await devices(docOf(paragraph('one two three four')));
    const x = idAt(a, 0);
    caret(a, x, 4);
    press(a, 'Enter');
    caret(b, x, 8);
    press(b, 'Enter');
    settle([a, b]);
    const all = texts(a).join('|');
    expect(all.split('three four').length - 1).toBe(2);
    expect(find(a, x)!.node.firstChild!.textContent).toBe('one ');
    converged([a, b]);
  });

  it('two people merge the same block: valid, the schema holds it', async () => {
    const [a, b] = await devices(three());
    const x = idAt(a, 1);
    caret(a, x, 0);
    press(a, 'Backspace');
    caret(b, x, 0);
    press(b, 'Backspace');
    settle([a, b]);
    expect(find(a, x)).toBeUndefined();
    expect(texts(a)[texts(a).length - 1]).toBe('delta');
    converged([a, b]);
    expect(a.be.contentErrors).toEqual([]);
    expect(b.be.contentErrors).toEqual([]);
  });

  it('one formats, another types in the same range: both stand', async () => {
    const [a, b] = await devices(three());
    const x = idAt(a, 0);
    const body = blocks.firstBody(find(a, x)!)!;
    const editor = editorOf(a);
    editor.view.dispatch(
      editor.state.tr.addMark(
        body.pos + 1 + 6,
        body.pos + 1 + 10,
        editor.schema.marks.bold.create(),
      ),
    );
    type(b, x, 8, '[b]');
    settle([a, b]);
    const node = find(a, x)!.node.firstChild!;
    expect(node.textContent).toBe('alpha be[b]ta');
    const bold = [] as string[];
    node.forEach((child) => {
      if (child.marks.some((m) => m.type.name === 'bold')) bold.push(child.text ?? '');
    });
    expect(bold.join('')).toContain('beta'.slice(0, 2));
    expect(bold.join('')).toContain('ta');
    converged([a, b]);
  });

  it("undo reverts only the person's own changes", async () => {
    const [a, b] = await devices(three());
    const x = idAt(a, 0);
    type(a, x, 'end', ' [a]');
    settle([a, b]);
    type(b, x, 0, '[b] ');
    settle([a, b]);
    undoCommand(editorOf(a).state);
    settle([a, b]);
    expect(texts(a)[0]).toBe('[b] alpha beta');
    converged([a, b]);
  });

  it('three devices, one offline: the move notice reaches only the device that lost typing', async () => {
    const [a, b, c] = await devices(
      docOf(bullet(['one'], [bullet(['child'])]), paragraph('two')),
      3,
    );
    const parent = idAt(a, 0);
    const child = idAt(a, 1);
    // C is offline and types in the child; A moves the parent (and the child with it) below "two".
    type(c, child, 'end', ' [c]');
    type(b, idAt(b, 2), 'end', ' [b]');
    deliver(b, a);
    caret(a, parent, 0);
    press(a, 'Alt-Shift-ArrowDown');
    deliver(a, b);
    expect(notices(b)).toEqual([]);
    // C comes back.
    deliver(a, c);
    expect(notices(c)).toEqual([{ code: 'doc.moveConflict', blockId: child, reason: 'editLost' }]);
    settle([a, b, c]);
    expect(texts(a)).toEqual(['two [b]', 'one', 'child']);
    converged([a, b, c]);
  });
});

describe('the move intent', () => {
  it('is written in the same Yjs update as the move, for every way of moving a block', async () => {
    const [a] = await devices(docOf(bullet(['a']), bullet(['b']), bullet(['c']), bullet(['d'])));
    const updates: Uint8Array[] = [];
    a.page.doc.on('update', (update: Uint8Array) => updates.push(update));
    const moves = a.page.doc.getMap(MOVES);
    const keys = () => [...moves.keys()].sort();
    const [ia, ib, ic, id] = list(a).map((b) => b.id!);
    const step = (run: () => void) => {
      updates.length = 0;
      run();
      return updates.length;
    };
    // Each move: one update, holding the content change and the intent.
    expect(step(() => (caret(a, ib, 0), press(a, 'Tab')))).toBe(1);
    expect(keys()).toEqual([ib]);
    expect(moves.get(ib)).toMatchObject({ parent: ia });
    expect(step(() => (caret(a, ib, 0), press(a, 'Shift-Tab')))).toBe(1);
    expect(step(() => (caret(a, id, 0), press(a, 'Alt-Shift-ArrowUp')))).toBe(1);
    const editor = editorOf(a);
    const dragged = find(a, ia)!;
    expect(
      step(() =>
        editor.view.dispatch(
          blocks.moveBlock(editor.state, dragged, editor.state.doc.content.size)!,
        ),
      ),
    ).toBe(1);
    expect(keys()).toEqual([ia, ib, id].sort());
    // The drag's one update holds the intent for the dragged block.
    const intents = Y.decodeUpdate(updates[0]).structs.filter(
      (s) => s instanceof Y.Item && (s.parent as unknown) === MOVES,
    ) as InstanceType<typeof Y.Item>[];
    expect(intents.map((item) => item.parentSub)).toEqual([ia]);
    expect(intents[0].content.getContent()[0]).toMatchObject({ parent: null });
    void ic;
  });

  it('is not written for typing, splitting, duplicating, deleting, a remote change or an undo', async () => {
    const [a, b] = await devices(three());
    const moves = a.page.doc.getMap(MOVES);
    const x = idAt(a, 0);
    type(a, x, 2, 'typed');
    caret(a, x, 3);
    press(a, 'Enter');
    press(a, 'Mod-d');
    editorOf(a).view.dispatch(blocks.deleteBlock(editorOf(a).state, list(a)[2]));
    expect(moves.size).toBe(0);
    // B moves a block; A receives it and writes nothing of its own about it.
    caret(b, idAt(b, 0), 0);
    press(b, 'Alt-Shift-ArrowDown');
    const before = Y.encodeStateVector(a.page.doc);
    deliver(b, a);
    const own = Y.decodeUpdate(Y.encodeStateAsUpdate(a.page.doc, before)).structs.filter(
      (s) => s.id.client === a.page.doc.clientID,
    );
    expect(own).toEqual([]);
    // A moves one, then undoes it: the undo writes no intent.
    caret(a, idAt(a, 1), 0);
    press(a, 'Alt-Shift-ArrowUp');
    const size = moves.size;
    const sv = Y.encodeStateVector(a.page.doc);
    undoCommand(editorOf(a).state);
    const after = Y.decodeUpdate(Y.encodeStateAsUpdate(a.page.doc, sv));
    expect(moves.size).toBe(size);
    expect(after.structs.some((s) => s instanceof Y.Item && (s.parent as unknown) === MOVES)).toBe(
      false,
    );
  });

  it('is kept by a client that does not read it, and by the binding and the schema', async () => {
    const [a] = await devices(three());
    caret(a, idAt(a, 0), 0);
    press(a, 'Alt-Shift-ArrowDown');
    // A Yjs document that never asks for `moves` passes it on whole.
    const old = new Y.Doc();
    Y.applyUpdate(old, Y.encodeStateAsUpdate(a.page.doc));
    const next = new Y.Doc();
    Y.applyUpdate(next, Y.encodeStateAsUpdate(old));
    expect(next.getMap(MOVES).toJSON()).toEqual(a.page.doc.getMap(MOVES).toJSON());
    // The content the schema reads is untouched by it.
    expect(() =>
      documentSchema()
        .nodeFromJSON(fragmentToJSON(next.getXmlFragment(CONTENT)))
        .check(),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Measured in S1's manner: random typing, moves, indents, splits and deletes on three devices
// with offline spells, then: which typed tokens were lost because a block they were in was moved
// by another device, and did the device that typed them get the notice for that block?

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Which Yjs client wrote the first character of each token in a document now. */
function authorsOf(doc: InstanceType<typeof Y.Doc>): Map<string, number> {
  const out = new Map<string, number>();
  const visit = (type: InstanceType<typeof Y.XmlFragment> | InstanceType<typeof Y.XmlElement>) => {
    for (const child of type.toArray()) {
      if (child instanceof Y.XmlText) {
        let text = '';
        const owners: number[] = [];
        for (let item = child._start; item; item = item.right) {
          if (item.deleted || !(item.content instanceof Y.ContentString)) continue;
          const str = item.content.str;
          text += str;
          for (let i = 0; i < str.length; i++) owners.push(item.id.client);
        }
        for (const match of text.matchAll(/\{[^}]+\}/g)) out.set(match[0], owners[match.index!]);
      } else if (child instanceof Y.XmlElement) visit(child);
    }
  };
  visit(doc.getXmlFragment(CONTENT));
  return out;
}

describe('the move notice, measured', () => {
  const results: unknown[] = [];
  afterAll(() => {
    mkdirSync('bench/results', { recursive: true });
    writeFileSync('bench/results/move-notice.json', JSON.stringify(results, null, 2) + '\n');
  });

  for (const seed of [1, 2, 3, 4, 5])
    it(`tells the device whose typing a move lost, never a delete (seed ${seed})`, async () => {
      const random = seeded(seed * 7919);
      const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
      const all = await devices(
        docOf(...Array.from({ length: 10 }, (_, i) => paragraph(`start ${i}`))),
        3,
      );
      const online = all.map(() => true);
      const offlineUntil = all.map(() => 0);
      const typedAt = new Map<string, number>();
      const pattern = new RegExp(`\\{${seed}-\\d+-(\\d)\\}`, 'g');
      /** Each of this device's tokens it still shows, with the blocks around it, innermost first. */
      const tokensOn = (device: Device, index: number) => {
        const out = new Map<string, string[]>();
        const byPos = new Map(list(device).map((b) => [b.pos, b]));
        for (const block of list(device)) {
          let text = '';
          block.node.forEach((child) => {
            if (child.type.name !== 'block') text += child.textContent + ' ';
          });
          for (const match of text.matchAll(pattern)) {
            if (Number(match[1]) !== index) continue;
            const chain: string[] = [];
            for (let b: typeof block | undefined = block; b; b = byPos.get(b.parentPos))
              if (b.id) chain.push(b.id);
            out.set(match[0], chain);
          }
        }
        return out;
      };
      const losses: {
        token: string;
        device: number;
        chain: string[];
        /** What survives of the blocks it was in: the block itself, only a parent, or nothing. */
        survives: 'block' | 'parent' | 'nothing';
        told: boolean;
        /** Whether its characters were still the typist's own in Yjs (no other device's copy). */
        own: boolean;
        stepsSinceTyped: number;
      }[] = [];
      let step = 0;
      /** A pull on the device that typed them is where tokens are lost: watch each one. */
      const watchedPull = (device: Device) => {
        const index = all.indexOf(device);
        const before = tokensOn(device, index);
        const noticesBefore = notices(device).length;
        const authors = authorsOf(device.page.doc);
        pull(device);
        const after = tokensOn(device, index);
        const told = notices(device).slice(noticesBefore);
        const live = new Set(list(device).map((b) => b.id));
        for (const [token, chain] of before) {
          if (after.has(token)) continue;
          losses.push({
            token,
            device: index,
            chain,
            // The block it was typed in lives on under its id: it was moved, not deleted.
            survives: live.has(chain[0])
              ? 'block'
              : chain.some((id) => live.has(id))
                ? 'parent'
                : 'nothing',
            told: told.some((n) => chain.includes(n.blockId)),
            own: authors.get(token) === device.page.doc.clientID,
            stepsSinceTyped: step - (typedAt.get(token) ?? step),
          });
        }
      };
      let ops = 0;
      for (; ops < 300; step++) {
        all.forEach((_, i) => {
          if (!online[i] && step >= offlineUntil[i]) online[i] = true;
          else if (online[i] && random() < 0.02) {
            online[i] = false;
            offlineUntil[i] = step + 10 + Math.floor(random() * 120);
          }
        });
        if (random() < 0.5) {
          const from = all[Math.floor(random() * all.length)];
          const to = all[Math.floor(random() * all.length)];
          if (from !== to && online[all.indexOf(from)] && online[all.indexOf(to)]) {
            push(from);
            watchedPull(to);
          }
          continue;
        }
        const i = Math.floor(random() * all.length);
        const device = all[i];
        const present = list(device).filter(
          (b) => b.id && b.node.firstChild?.type.name === 'textBody',
        );
        if (!present.length) continue;
        const target = pick(present);
        const roll = random();
        ops++;
        if (roll < 0.6) {
          const token = `{${seed}-${ops}-${i}}`;
          typedAt.set(token, step);
          type(device, target.id!, 'end', token);
        } else if (roll < 0.85) {
          caret(device, target.id!, 0);
          press(device, pick(['Alt-Shift-ArrowUp', 'Alt-Shift-ArrowDown', 'Tab', 'Shift-Tab']));
        } else if (roll < 0.95) {
          // Split before a token, never inside one (S1 keeps its tokens whole the same way).
          const text = target.node.firstChild!.textContent;
          caret(device, target.id!, Math.max(0, text.lastIndexOf('{')));
          press(device, 'Enter');
        } else editorOf(device).view.dispatch(blocks.deleteBlock(editorOf(device).state, target));
      }
      for (let round = 0; round < 4; round++) {
        for (const device of all) push(device);
        for (const device of all) watchedPull(device);
      }
      converged(all);
      const moved = losses.filter((l) => l.survives === 'block');
      const ownMoved = moved.filter((l) => l.own);
      const inParent = losses.filter((l) => l.survives === 'parent');
      const deleted = losses.filter((l) => l.survives === 'nothing');
      results.push({
        seed,
        ops,
        tokensTyped: typedAt.size,
        tokensLost: losses.length,
        // The "moved" row: the block it was typed in lives on, without it.
        lostWithAMovedBlock: moved.length,
        toldOfIt: moved.filter((l) => l.told).length,
        // Of those, the ones whose characters were still the typist's own when lost (not a copy
        // another device's move or split had made, which that device is told of instead).
        ownLostWithAMovedBlock: ownMoved.length,
        ownToldOfIt: ownMoved.filter((l) => l.told).length,
        // Its block gone but a parent lives on: a block made inside a moved parent (told), or
        // a block deleted inside one.
        lostInsideALivingParent: inParent.length,
        toldInsideALivingParent: inParent.filter((l) => l.told).length,
        // The "deleted" row: nothing it was in survives. Never a move notice.
        lostWithADeletedBlock: deleted.length,
        toldOfADelete: deleted.filter((l) => l.told).length,
        editLostNotices: all.reduce(
          (n, d) => n + notices(d).filter((x) => x.reason === 'editLost').length,
          0,
        ),
        movedTwiceNotices: all.reduce(
          (n, d) => n + notices(d).filter((x) => x.reason === 'movedTwice').length,
          0,
        ),
        // Steps between typing a token and the pull that lost it: a fixed "edited in the last
        // few seconds" window misses the long ones (offline spells here last 10 to 130 steps).
        stepsSinceTyped: moved.map((l) => l.stepsSinceTyped).sort((x, y) => x - y),
      });
      // A deleted block is never told as a move; nearly every token a move took is told to the
      // device that typed it (the rest: its text was another device's copy by then, or the
      // block's id lives again only after this device's duplicate repair).
      expect(deleted.filter((l) => l.told)).toEqual([]);
      expect(moved.filter((l) => l.told).length).toBeGreaterThanOrEqual(0.9 * moved.length);
      expect(ownMoved.filter((l) => l.told).length).toBeGreaterThanOrEqual(0.9 * ownMoved.length);
    }, 120_000);
});

describe('inside a page: the schema-version-3 nodes', () => {
  const DATABASE = '01936f6e-0000-7000-8000-0000000000d1';
  const [VIEW_A, VIEW_B] = [
    '01936f6e-0000-7000-8000-0000000000da',
    '01936f6e-0000-7000-8000-0000000000db',
  ];
  const { databaseView, dateMention } = build;

  /** Sets attributes of the first body of a block, as the node views do. */
  function setBody(device: Device, id: string, attrs: Record<string, unknown>) {
    const editor = editorOf(device);
    const body = blocks.firstBody(find(device, id)!)!;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(body.pos, undefined, { ...body.node.attrs, ...attrs }),
    );
  }

  it('two point one database view at different views: one wins everywhere, the block kept', async () => {
    const [a, b] = await devices(docOf(paragraph('top'), databaseView(DATABASE, null)));
    const x = idAt(a, 1);
    setBody(a, x, { viewId: VIEW_A });
    setBody(b, x, { viewId: VIEW_B });
    settle([a, b]);
    converged([a, b]);
    const attrs = blocks.firstBody(find(a, x)!)!.node.attrs;
    expect(attrs.databaseId).toBe(DATABASE);
    expect([VIEW_A, VIEW_B]).toContain(attrs.viewId);
    expect(list(a)).toHaveLength(2);
  });

  it('one deletes a database view while another changes it: deleted, the database untouched', async () => {
    const [a, b] = await devices(docOf(paragraph('top'), databaseView(DATABASE, VIEW_A)));
    const x = idAt(a, 1);
    setBody(a, x, { viewId: VIEW_B });
    editorOf(b).view.dispatch(blocks.deleteBlock(editorOf(b).state, find(b, x)!));
    settle([a, b]);
    expect(find(a, x)).toBeUndefined();
    converged([a, b]);
  });

  it('dates put in one line at once both stand; a date changed while another types beside it', async () => {
    const [a, b] = await devices(docOf(paragraph('Due ')));
    const x = idAt(a, 0);
    caret(a, x, 'end');
    editorOf(a).view.dispatch(
      editorOf(a).state.tr.replaceSelectionWith(
        editorOf(a).schema.nodeFromJSON(dateMention('2026-12-01')),
      ),
    );
    caret(b, x, 0);
    editorOf(b).view.dispatch(
      editorOf(b).state.tr.replaceSelectionWith(
        editorOf(b).schema.nodeFromJSON(dateMention('2026-11-30')),
      ),
    );
    settle([a, b]);
    converged([a, b]);
    expect(plainText(fragmentToJSON(a.page.fragment))).toBe('2026-11-30Due 2026-12-01');
    // A changes the second date; B types after it.
    const editor = editorOf(a);
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'dateMention' && node.attrs.date === '2026-12-01') at = pos;
    });
    editor.view.dispatch(editor.state.tr.setNodeMarkup(at, undefined, { date: '2026-12-24' }));
    type(b, x, 'end', ' at noon');
    settle([a, b]);
    converged([a, b]);
    expect(plainText(fragmentToJSON(b.page.fragment))).toBe('2026-11-30Due 2026-12-24 at noon');
  });
});
