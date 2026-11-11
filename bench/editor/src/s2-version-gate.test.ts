// Spike S2: an older build meets a newer document.
//   The pass criterion: the old build opens it read-only, and the document's bytes are identical
//   afterwards. The other cases show what happens without the gate, and with an added attribute.
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { installDom } from './dom';

installDom();
const { createSpikeEditor } = await import('./editor');
const { createOps, listBlocks, firstBody, blockText } = await import('./commands');
const { openMode, openReadOnly, stampVersion, PLACEHOLDER } = await import('./gate');

const variant = { content: 'ordered', bodies: 'types' } as const;
const findings: Record<string, unknown> = {};
afterAll(() => {
  mkdirSync('bench/results', { recursive: true });
  writeFileSync('bench/results/s2-version-gate.json', JSON.stringify(findings, null, 2) + '\n');
});

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** A version-2 document holding a block whose body type version 1 does not know. */
function newerDocument() {
  const doc = new Y.Doc();
  const newer = createSpikeEditor({
    doc,
    binding: 'tiptap-ids',
    schema: variant,
    additions: { kinds: ['sheetEmbed'] },
  });
  const ops = createOps(variant);
  const { state } = newer.editor;
  newer.editor.view.dispatch(
    ops.insertBlocks(state, 0, [
      ops.newBlock(state, 'before'),
      state.schema.nodes.block.create(
        { id: null },
        state.schema.nodes.sheetEmbed.create({ data: 'wb-1' }),
      ),
      ops.newBlock(state, 'after'),
    ]),
  );
  stampVersion(doc, 2);
  return { doc, newer };
}

describe('S2: an older build meets a newer document', () => {
  it('with the gate: read-only, nothing pushed, bytes identical', () => {
    const { doc, newer } = newerDocument();
    const bytes = Y.encodeStateAsUpdate(doc);
    const old = new Y.Doc();
    Y.applyUpdate(old, bytes);
    let pushed = 0;
    old.on('update', () => pushed++);
    expect(openMode(old, 1)).toBe('readOnly');
    const view = openReadOnly(old, variant);
    // Try to edit: the view refuses keyboard input, and a command reaches no Yjs document.
    expect(view.isEditable).toBe(false);
    view.commands.insertContentAt(1, 'typed');
    const after = Y.encodeStateAsUpdate(old);
    findings['with the gate'] = {
      mode: 'readOnly',
      updatesPushed: pushed,
      bytesBefore: bytes.length,
      bytesAfter: after.length,
      identical: sameBytes(bytes, after),
      shows: view.getText({ blockSeparator: ' | ' }),
    };
    expect(pushed).toBe(0);
    expect(sameBytes(bytes, after)).toBe(true);
    expect(view.getText()).toContain(PLACEHOLDER);
    view.destroy();
    newer.editor.destroy();
  });

  for (const binding of ['tiptap', 'tiptap-ids', 'upstream'] as const) {
    it(`without the gate (${binding}): what binding the old build does to the newer document`, () => {
      const { doc } = newerDocument();
      const bytes = Y.encodeStateAsUpdate(doc);
      const old = new Y.Doc();
      Y.applyUpdate(old, bytes);
      const updates: Uint8Array[] = [];
      old.on('update', (update: Uint8Array) => updates.push(update));
      const spike = createSpikeEditor({ doc: old, binding, schema: variant });
      // The old build's user types in the first block.
      const body = firstBody(listBlocks(spike.editor.state.doc)[0])!;
      spike.editor.view.dispatch(spike.editor.state.tr.insertText(' edited', body.pos + 1 + 6));
      // What the newer build sees once the old build's updates arrive.
      for (const update of updates) Y.applyUpdate(doc, update);
      const json = doc.getXmlFragment('content').toJSON().toLowerCase();
      findings[`without the gate (${binding})`] = {
        contentErrors: spike.contentErrors.map((e) => e.message),
        updatesPushed: updates.length,
        bytesChanged: !sameBytes(bytes, Y.encodeStateAsUpdate(old)),
        newerStillHasEmbed: json.includes('sheetembed'),
        editReachedYjs: json.includes('edited'),
        oldEditorShows: spike.editor.getText({ blockSeparator: ' | ' }),
      };
      spike.editor.destroy();
    });
  }

  for (const binding of ['tiptap', 'tiptap-ids'] as const) {
    it(`an attribute a newer build added, after an older build edits the block (${binding})`, () => {
      const newDoc = new Y.Doc();
      const oldDoc = new Y.Doc();
      const newer = createSpikeEditor({
        doc: newDoc,
        binding,
        schema: variant,
        additions: { attributes: ['tone'] },
      });
      const older = createSpikeEditor({ doc: oldDoc, binding, schema: variant });
      newDoc.on(
        'update',
        (u: Uint8Array, origin: unknown) => origin !== 'x' && Y.applyUpdate(oldDoc, u, 'x'),
      );
      oldDoc.on(
        'update',
        (u: Uint8Array, origin: unknown) => origin !== 'x' && Y.applyUpdate(newDoc, u, 'x'),
      );
      const ops = createOps(variant);
      const { state } = newer.editor;
      const block = ops.newBlock(state, 'coloured');
      newer.editor.view.dispatch(ops.insertBlocks(state, 0, [block]));
      const bodyPos = firstBody(listBlocks(newer.editor.state.doc)[0])!.pos;
      newer.editor.view.dispatch(
        newer.editor.state.tr.setNodeAttribute(bodyPos, 'tone', 'warning'),
      );
      // The older build types in that paragraph.
      const oldBody = firstBody(listBlocks(older.editor.state.doc)[0])!;
      older.editor.view.dispatch(older.editor.state.tr.insertText('!', oldBody.pos + 1 + 8));
      const tone = firstBody(listBlocks(newer.editor.state.doc)[0])!.node.attrs.tone;
      findings[`added attribute after an older edit (${binding})`] = {
        text: blockText(listBlocks(newer.editor.state.doc)[0].node),
        tone,
      };
      if (binding === 'tiptap-ids') expect(tone).toBe('warning');
      newer.editor.destroy();
      older.editor.destroy();
    });
  }
});
