// Spike S1's scenarios: each pass criterion as a small, exact case, for every binding.
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';
import { installDom } from './dom';

installDom();
const { Network } = await import('./network');
const { createOps, listBlocks, firstBody, blockText, seeded } = await import('./commands');
const { blockIds, repairId, BLOCK_ID } = await import('./ids');

type Binding = 'tiptap' | 'tiptap-ids' | 'upstream';
const BINDINGS: Binding[] = ['tiptap', 'tiptap-ids', 'upstream'];
const findings: Record<string, unknown> = {};
afterAll(() => {
  mkdirSync('bench/results', { recursive: true });
  writeFileSync('bench/results/s1-scenarios.json', JSON.stringify(findings, null, 2) + '\n');
});

function setup(binding: Binding, texts: string[], bodies: 'types' | 'kind' = 'types', clients = 2) {
  const net = new Network(clients, binding, { content: 'ordered', bodies });
  const ops = createOps({ content: 'ordered', bodies });
  const editor = net.clients[0].spike.editor;
  editor.view.dispatch(
    ops.insertBlocks(
      editor.state,
      0,
      texts.map((text) => ops.newBlock(editor.state, text)),
    ),
  );
  net.quiesce(seeded(1));
  return { net, ops, editors: net.clients.map((c) => c.spike.editor) };
}

const textsById = (doc: Parameters<typeof listBlocks>[0]) =>
  Object.fromEntries(listBlocks(doc).map((b) => [b.id, blockText(b.node)]));

describe('S1: ids on one client', () => {
  it('mints on create, keeps the id on the half with the text, new ids on paste and duplicate', () => {
    const { net, ops, editors } = setup('tiptap-ids', ['alpha beta', 'gamma']);
    const [a] = editors;
    const before = blockIds(a.state.doc);
    expect(before.every((id) => id && BLOCK_ID.test(id))).toBe(true);
    // Split in the middle: the first half keeps the id.
    let first = listBlocks(a.state.doc)[0];
    a.view.dispatch(ops.split(a.state, first, 6)!);
    let blocks = listBlocks(a.state.doc);
    expect(blocks[0].id).toBe(before[0]);
    expect(blockText(blocks[0].node)).toBe('alpha ');
    expect(blockText(blocks[1].node)).toBe('beta');
    // Enter at the start: the empty block goes above, the text keeps its id.
    first = listBlocks(a.state.doc)[2];
    a.view.dispatch(ops.split(a.state, first, 0)!);
    blocks = listBlocks(a.state.doc);
    expect(blocks[3].id).toBe(before[1]);
    expect(blockText(blocks[3].node)).toBe('gamma');
    // Duplicate: fresh ids; move: same id.
    a.view.dispatch(ops.duplicate(a.state, blocks[3]));
    const afterDuplicate = blockIds(a.state.doc);
    expect(new Set(afterDuplicate).size).toBe(afterDuplicate.length);
    const moving = listBlocks(a.state.doc)[3];
    a.view.dispatch(ops.move(a.state, moving, 0)!);
    expect(listBlocks(a.state.doc)[0].id).toBe(before[1]);
    expect(net.clients[0].spike.stats.localDuplicates).toBe(0);
    net.destroy();
  });
});

describe('S1: two clients', () => {
  for (const binding of BINDINGS) {
    it(`${binding}: two concurrent moves of one block are repaired the same way everywhere`, () => {
      const { net, ops, editors } = setup(binding, ['b0', 'b1', 'b2', 'b3', 'b4', 'b5']);
      const [a, b] = editors;
      const id = listBlocks(a.state.doc)[2].id!;
      a.view.dispatch(ops.move(a.state, listBlocks(a.state.doc)[2], 0)!);
      const end = b.state.doc.content.size;
      b.view.dispatch(ops.move(b.state, listBlocks(b.state.doc)[2], end)!);
      net.quiesce(seeded(2));
      const ids = blockIds(a.state.doc);
      expect(JSON.stringify(a.getJSON())).toBe(JSON.stringify(b.getJSON()));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids[0]).toBe(id);
      expect(ids[ids.length - 1]).toBe(repairId(id, 1));
      expect(net.clients[0].spike.fragment.toJSON()).toBe(net.clients[1].spike.fragment.toJSON());
      findings[`${binding}: concurrent moves`] = {
        blocks: ids.length,
        copies: listBlocks(a.state.doc).filter((x) => blockText(x.node) === 'b2').length,
        texts: listBlocks(a.state.doc).map((x) => blockText(x.node)),
      };
      net.destroy();
    });

    it(`${binding}: a move does not disturb a peer typing in a block it did not move`, () => {
      const texts = Array.from({ length: 8 }, (_, i) => `block ${i}`);
      const { net, ops, editors } = setup(binding, texts);
      const [a, b] = editors;
      const neighbour = listBlocks(b.state.doc)[4];
      const end = a.state.doc.content.size;
      a.view.dispatch(ops.move(a.state, listBlocks(a.state.doc)[1], end)!);
      const body = firstBody(neighbour)!;
      b.view.dispatch(b.state.tr.insertText('[peer]', body.pos + 1 + 5));
      const bytesBefore = net.clients[0].bytesSent;
      net.quiesce(seeded(3));
      const texts2 = textsById(a.state.doc);
      const kept = texts2[neighbour.id!] === 'block[peer] 4';
      findings[`${binding}: move beside a peer typing`] = {
        neighbourText: texts2[neighbour.id!],
        kept,
        moveUpdateBytes: bytesBefore,
      };
      expect(JSON.stringify(a.getJSON())).toBe(JSON.stringify(b.getJSON()));
      if (binding !== 'upstream') expect(kept).toBe(true);
      net.destroy();
    });

    it(`${binding}: no caret jump when a peer types earlier in the same paragraph`, () => {
      const { net, editors } = setup(binding, ['abcdefghij', 'second']);
      const [a, b] = editors;
      // A is focused, with the caret between f and g.
      Object.defineProperty(a.view, 'hasFocus', { value: () => true });
      const body = firstBody(listBlocks(a.state.doc)[0])!;
      a.view.dispatch(a.state.tr.setSelection(TextSelection.create(a.state.doc, body.pos + 1 + 6)));
      a.view.dispatch(a.state.tr.insertText('', body.pos + 1 + 6)); // a local transaction, as typing makes
      const bBody = firstBody(listBlocks(b.state.doc)[0])!;
      b.view.dispatch(b.state.tr.insertText('XYZ', bBody.pos + 1 + 2));
      net.quiesce(seeded(4));
      const head = a.state.selection.head;
      const around = a.state.doc.textBetween(head - 1, head + 1);
      findings[`${binding}: caret after a peer types before it`] = {
        text: blockText(listBlocks(a.state.doc)[0].node),
        around,
      };
      expect(around).toBe('fg');
      net.destroy();
    });

    it(`${binding}: two clients split one paragraph`, () => {
      const { net, ops, editors } = setup(binding, ['one two three four']);
      const [a, b] = editors;
      a.view.dispatch(ops.split(a.state, listBlocks(a.state.doc)[0], 4)!);
      b.view.dispatch(ops.split(b.state, listBlocks(b.state.doc)[0], 8)!);
      net.quiesce(seeded(5));
      const result = listBlocks(a.state.doc).map((x) => blockText(x.node));
      findings[`${binding}: concurrent splits`] = result;
      expect(JSON.stringify(a.getJSON())).toBe(JSON.stringify(b.getJSON()));
      net.destroy();
    });
  }

  for (const bodies of ['types', 'kind'] as const) {
    it(`tiptap-ids, ${bodies}: turn into while a peer types in the block`, () => {
      const { net, ops, editors } = setup('tiptap-ids', ['heading soon'], bodies);
      const [a, b] = editors;
      a.view.dispatch(ops.convert(a.state, listBlocks(a.state.doc)[0], 'heading')!);
      const body = firstBody(listBlocks(b.state.doc)[0])!;
      b.view.dispatch(b.state.tr.insertText('[peer]', body.pos + 1 + 7));
      net.quiesce(seeded(6));
      const text = blockText(listBlocks(a.state.doc)[0].node);
      const bodiesLeft = listBlocks(a.state.doc)[0].node.childCount;
      findings[`convert beside a peer typing (${bodies})`] = { text, bodies: bodiesLeft };
      expect(JSON.stringify(a.getJSON())).toBe(JSON.stringify(b.getJSON()));
      if (bodies === 'kind') expect(text).toBe('heading[peer] soon');
      net.destroy();
    });
  }
});
