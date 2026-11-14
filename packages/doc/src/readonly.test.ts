// The read-only view of a page newer than this build, from the server's derived JSON: every node
// this build does not know is a placeholder in the place it was, nothing is dropped without a
// trace, and the result is always content this build's schema holds.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DocJSON } from './binding';
import { build } from './index';
import { readOnlyView } from './readonly';
import { documentSchema } from './schema';
import { plainText } from './text';

const strings = { block: 'This block needs a newer version.', inline: '[newer]' };
const { docOf, paragraph, text, block, heading, table } = build;

/** The view, checked against this build's schema (Tiptap would show an empty page otherwise). */
function view(json: DocJSON) {
  const result = readOnlyView(json, strings);
  expect(() => documentSchema().nodeFromJSON(result.json).check()).not.toThrow();
  return result;
}

const count = (json: DocJSON, needle: string): number =>
  JSON.stringify(json).split(needle).length - 1;

describe('the read-only view from derived JSON', () => {
  it('shows an unknown body as a placeholder in its block, which keeps its id', () => {
    const doc = docOf(
      paragraph('before'),
      {
        type: 'block',
        attrs: { id: 'Embed0000001' },
        content: [{ type: 'futureBlock', attrs: { workbookId: 'w' } }],
      },
      paragraph('after'),
    );
    const { json, unknownNodes } = view(doc);
    expect(unknownNodes).toEqual(['futureBlock']);
    expect(json.content).toHaveLength(3);
    const placeholder = json.content![1];
    expect(placeholder.attrs).toEqual({ id: 'Embed0000001' });
    expect(placeholder.content![0]).toMatchObject({
      type: 'textBody',
      attrs: { kind: 'callout' },
      content: [{ type: 'text', text: strings.block }],
    });
    expect(plainText(json).split('\n')).toEqual(['before', strings.block, 'after']);
  });

  it('shows an unknown container, then what it held that this build can draw', () => {
    const doc: DocJSON = {
      type: 'doc',
      content: [
        {
          type: 'columnList',
          content: [
            { type: 'column', content: [paragraph('left one'), paragraph('left two')] },
            { type: 'column', content: [heading(2, 'right')] },
          ],
        },
        paragraph('below'),
      ],
    };
    const { json, unknownNodes } = view(doc);
    expect(unknownNodes).toEqual(['column', 'columnList']);
    expect(plainText(json).split('\n')).toEqual([
      strings.block,
      strings.block,
      'left one',
      'left two',
      strings.block,
      'right',
      'below',
    ]);
  });

  it('shows an unknown inline node in its line, and keeps the text around it', () => {
    const doc = docOf(
      paragraph('Ask ', { type: 'futureMention', attrs: { userId: 'u1' } }, ' about it'),
      paragraph(
        'Due ',
        { type: 'equation', attrs: { latex: 'x^2' } },
        { type: 'hardBreak' },
        text('done', 'bold'),
      ),
    );
    const { json, unknownNodes } = view(doc);
    expect(unknownNodes).toEqual(['equation', 'futureMention']);
    expect(plainText(json)).toBe(`Ask ${strings.inline} about it\nDue ${strings.inline}\ndone`);
    expect(JSON.stringify(json)).toContain('"bold"');
  });

  it('leaves out marks it does not know, never their text', () => {
    const doc = docOf(
      paragraph(
        {
          type: 'text',
          text: 'commented',
          marks: [{ type: 'comment', attrs: { id: 'c' } }, { type: 'bold' }],
        },
        { type: 'text', text: ' plain', marks: [{ type: 'sparkle' }] },
      ),
    );
    const { json, unknownMarks, unknownNodes } = view(doc);
    expect(unknownNodes).toEqual([]);
    expect(unknownMarks).toEqual(['comment', 'sparkle']);
    expect(plainText(json)).toBe('commented plain');
    expect(JSON.stringify(json)).toContain('"bold"');
  });

  it('fits unknown things inside tables', () => {
    const grid = table([
      ['A', 'B'],
      ['1', '2'],
    ]);
    const body = grid.content![0];
    body.content!.push({ type: 'tableSummaryRow', content: [] });
    body.content![0].content!.push({ type: 'formulaCell', attrs: { f: '=A1' } });
    body.content![1].content![0].content!.push({ type: 'futureMention' });
    const { json, unknownNodes } = view(docOf(grid));
    expect(unknownNodes).toEqual(['formulaCell', 'futureMention', 'tableSummaryRow']);
    expect(count(json, strings.block)).toBe(2);
    expect(count(json, strings.inline)).toBe(1);
    expect(plainText(json)).toContain('A\tB');
  });

  it('makes odd shapes fit rather than drop them', () => {
    const doc: DocJSON = {
      type: 'doc',
      content: [
        { type: 'textBody', attrs: { kind: 'paragraph' }, content: [text('a body at the top')] },
        text('text at the top'),
        {
          type: 'block',
          attrs: { id: 'Loose0000001' },
          content: [text('text in a block'), { type: 'hardBreak' }],
        },
        block({
          type: 'codeBlock',
          content: [text('code', 'bold'), { type: 'hardBreak' }, text('more')],
        }),
        block({ type: 'textBody', content: [{ type: 'text' }, text('')] }),
        { type: 'tableCell', content: [text('a cell at the top')] },
        { type: 'doc', content: [paragraph('a document inside')] },
        paragraph({ type: 'textBody', content: [text('a body in a line')] }),
      ],
    };
    const { json, unknownNodes } = view(doc);
    expect(unknownNodes).toEqual([]);
    const lines = plainText(json).split('\n');
    for (const line of [
      'a body at the top',
      'text at the top',
      'text in a block',
      'code',
      'more',
      'a cell at the top',
      'a document inside',
      'a body in a line',
    ])
      expect(lines, line).toContain(line);
    expect(JSON.stringify(json)).toContain('Loose0000001');
  });

  it('holds every Markdown vector in this build schema, with every known text kept', () => {
    const vectors = JSON.parse(
      readFileSync(join(__dirname, '..', 'vectors', 'markdown-vectors.json'), 'utf8'),
    ) as { name: string; doc: DocJSON }[];
    for (const vector of vectors) {
      const { json } = view(vector.doc);
      for (const line of plainText(vector.doc).split('\n').filter(Boolean))
        expect(plainText(json), vector.name).toContain(line.split('\t')[0]);
    }
  });

  it('a page entirely made of things this build does not know is still all there', () => {
    const doc: DocJSON = {
      type: 'doc',
      content: Array.from({ length: 5 }, (_, i) => ({
        type: 'block',
        attrs: { id: `Future00000${i}` },
        content: [{ type: `future${i}` }],
      })),
    };
    const { json, unknownNodes } = view(doc);
    expect(unknownNodes).toHaveLength(5);
    expect(count(json, strings.block)).toBe(5);
    expect(view({ type: 'doc' }).json).toEqual({ type: 'doc' });
  });
});
