// Phase 8: the XML reader (no document type, depth capped) and the Word reader over the fixture
// written as Word's XML (packages/shell/src/exchange/fixtures): headings, marks, lists, tables
// with merged cells, images, links, right to left, and what it counts instead of keeping.
import { describe, expect, it } from 'vitest';
import type { DocJSON } from './binding';
import { DocxError, readDocx, type DocxParts } from './docx';
import { XmlError, decodeEntities, parseXml, textOf } from './xml';
import { wordDocument } from '../../shell/src/exchange/fixtures/fixtures';

describe('the XML reader', () => {
  it('reads elements, attributes, text, CDATA and entities', () => {
    const root = parseXml(
      String.fromCharCode(0xfeff) +
        '<?xml version="1.0"?><!-- a comment --><a x="1 &amp; 2" y=\'q\'><b>t&lt;e&#x41;&#66;</b><![CDATA[<raw>]]><c/></a>',
    );
    expect(root.name).toBe('a');
    expect(root.attrs).toEqual({ x: '1 & 2', y: 'q' });
    expect(textOf(root)).toBe('t<eAB<raw>');
    expect(decodeEntities('&unknown; &#0; &#x110000;')).toBe(
      `&unknown; ${String.fromCharCode(0xfffd)} ${String.fromCharCode(0xfffd)}`,
    );
  });

  it('refuses a document type, so no entity ever expands', () => {
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>')).toThrow(XmlError);
  });

  it('refuses nesting deeper than its limit, and what is not well formed', () => {
    expect(() => parseXml('<a>'.repeat(300) + '</a>'.repeat(300))).toThrow(/deeply/);
    expect(() => parseXml('<a><b></a>')).toThrow(XmlError);
    expect(() => parseXml('<a>')).toThrow(XmlError);
    expect(() => parseXml('<a/><b/>')).toThrow(XmlError);
  });
});

const decode = (files: Record<string, Uint8Array>, path: string) =>
  files[path] ? new TextDecoder().decode(files[path]) : undefined;

function parts(files: Record<string, Uint8Array>): DocxParts {
  return {
    document: decode(files, 'word/document.xml')!,
    styles: decode(files, 'word/styles.xml'),
    numbering: decode(files, 'word/numbering.xml'),
    relationships: decode(files, 'word/_rels/document.xml.rels'),
    headersAndFooters: 1,
  };
}

const bodyOf = (block: DocJSON) => block.content![0];
const kindOf = (block: DocJSON) => {
  const body = bodyOf(block);
  if (body.type !== 'textBody') return body.type;
  return body.attrs?.kind === 'heading'
    ? `heading:${(body.content ?? []).map((n) => n.text).join('')}`
    : String(body.attrs?.kind);
};

describe('the Word reader', () => {
  const fixture = wordDocument();
  const images: string[] = [];
  const read = readDocx(parts(fixture.files), {
    image: (path, alt) => {
      images.push(`${path}|${alt}`);
      return 'asset-1';
    },
  });
  const blocks = read.doc.content!;

  it('reads the blocks in order, the Title paragraph as the page’s title', () => {
    expect(read.title).toBe('Quarterly report');
    expect(blocks.map(kindOf)).toEqual(fixture.expected.blocks);
  });

  it('reads marks, links and a field’s link', () => {
    const marks = (blocks[1].content![0].content ?? []).map((n) => [
      n.text,
      (n.marks ?? []).map((m) =>
        m.type === 'link'
          ? `link:${m.attrs?.href}`
          : m.type === 'highlight'
            ? `highlight:${m.attrs?.token}`
            : m.type,
      ),
    ]);
    expect(marks).toEqual([
      ['Plain, ', []],
      ['bold', ['bold']],
      [', ', []],
      ['italic', ['italic']],
      [', ', []],
      ['underlined', ['underline']],
      [', ', []],
      ['struck', ['strike']],
      [', ', []],
      ['code', ['code']],
      [' and ', []],
      ['marked', ['highlight:yellow']],
      ['. ', []],
      ['A link', ['link:https://example.com/report']],
      ['.', []],
    ]);
    const field = bodyOf(blocks[17]).content!;
    expect(field).toEqual([
      {
        type: 'text',
        text: 'A field link',
        marks: [{ type: 'link', attrs: { href: 'https://example.com/field' } }],
      },
    ]);
  });

  it('reads tracked changes as accepted', () => {
    expect(
      bodyOf(blocks[2])
        .content!.map((n) => n.text)
        .join(''),
    ).toBe('Kept inserted text.');
  });

  it('nests lists by level, keeps a list’s start, and reads Word’s check box', () => {
    const first = blocks[4];
    expect(first.content![1].content![0].attrs?.kind).toBe('bulletItem');
    expect(bodyOf(blocks[6]).attrs?.start).toBe(3);
    expect(bodyOf(blocks[7]).attrs?.start).toBeUndefined();
    expect(bodyOf(blocks[8]).attrs).toMatchObject({ kind: 'checkItem', checked: true });
    expect(bodyOf(blocks[8]).content).toEqual([{ type: 'text', text: 'Done item' }]);
  });

  it('reads a table with its header row and merged cells', () => {
    const table = bodyOf(blocks[11]);
    expect(table.attrs?.headerRow).toBe(true);
    const rows = table.content!.map((row) =>
      row.content!.map(
        (c) =>
          `${(c.content ?? []).map((n) => n.text).join('')}:${c.attrs?.colspan}x${c.attrs?.rowspan}`,
      ),
    );
    expect(rows).toEqual([
      ['Region:1x1', 'Q3:1x1', 'Q4:1x1'],
      ['North:1x2', '10:2x1'],
      ['11:1x1', '12:1x1'],
    ]);
  });

  it('makes images assets with their alt text, and reads right to left and code', () => {
    expect(images).toEqual(['word/media/image1.png|A blue square']);
    expect(bodyOf(blocks[10]).attrs).toEqual({ assetId: 'asset-1', alt: 'A blue square' });
    expect(bodyOf(blocks[13]).content).toEqual([{ type: 'text', text: 'const total = 42;' }]);
    expect(bodyOf(blocks[14]).attrs?.dir).toBe('rtl');
  });

  it('counts what it does not keep', () => {
    expect(read.skipped).toEqual({
      trackedChanges: 2,
      comments: 1,
      footnotes: 1,
      textBoxes: 1,
      pageBreaks: 1,
      equations: 1,
      headersAndFooters: 1,
    });
  });

  it('gives every block a fresh id', () => {
    const ids: string[] = [];
    const walk = (node: DocJSON) => {
      if (node.type === 'block') ids.push(String(node.attrs?.id));
      node.content?.forEach(walk);
    };
    walk(read.doc);
    expect(new Set(ids).size).toBe(ids.length);
    const again = readDocx(parts(fixture.files));
    expect(again.doc.content![0].attrs?.id).not.toBe(blocks[0].attrs?.id);
  });

  it('refuses what is not a Word document', () => {
    expect(() => readDocx({ document: '<x/>' })).toThrow(DocxError);
    expect(() => readDocx({ document: '<!DOCTYPE a><w:document/>' })).toThrow(DocxError);
  });
});
