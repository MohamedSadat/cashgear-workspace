// What `toMarkdown` writes, shared with the server, whose export ports it to C#
// (server/src/Cgw.Core/Documents/Markdown.cs; its test reads the same file). The documents cover
// every block kind and mark, odd attributes, escapes, nesting, Arabic and English. Checked on
// every run; `CGW_WRITE_VECTORS=1` writes them again.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DocJSON } from './binding';
import * as build from './content';
import { withoutIds } from './content';
import { TEXT_KINDS, knownTypes } from './schema';
import { toMarkdown, type TextContext } from './text';

const file = join(__dirname, '..', 'vectors', 'markdown-vectors.json');

/** A context as data: the functions answer from these maps (undefined when a key is missing). */
interface Context {
  pageTitles?: Record<string, string>;
  pageHrefs?: Record<string, string>;
  assetNames?: Record<string, string>;
  assetHrefs?: Record<string, string>;
  untitled?: string;
}

interface Vector {
  name: string;
  doc: DocJSON;
  context?: Context;
  markdown: string;
}

function contextOf(data: Context | undefined): TextContext {
  const context: TextContext = {};
  if (!data) return context;
  const { pageTitles, pageHrefs, assetNames, assetHrefs, untitled } = data;
  if (pageTitles) context.pageTitle = (id) => pageTitles[id];
  if (pageHrefs) context.pageHref = (id) => pageHrefs[id];
  if (assetNames) context.assetName = (id) => assetNames[id];
  if (assetHrefs) context.assetHref = (id) => assetHrefs[id];
  if (untitled !== undefined) context.untitled = untitled;
  return context;
}

const { docOf, heading, paragraph, bullet, numbered, todo, toggle, quote, callout, divider, code } =
  build;
const { text, table, textBlock, block, bookmark, childPage } = build;

const PLANS = '01936f6e-0000-7000-8000-000000000001';
const EMPTY = '01936f6e-0000-7000-8000-000000000002';
const UNKNOWN_PAGE = '01936f6e-0000-7000-8000-00000000000f';
const REPORT = '01936f6e-0000-7000-8000-0000000000a1';
const PHOTO = '01936f6e-0000-7000-8000-0000000000a2';
const UNKNOWN_ASSET = '01936f6e-0000-7000-8000-0000000000af';

const coloured = (value: string, type: string, token: string): DocJSON => ({
  type: 'text',
  text: value,
  marks: [{ type, attrs: { token } }],
});
const marked = (value: string, ...marks: NonNullable<DocJSON['marks']>): DocJSON => ({
  type: 'text',
  text: value,
  marks,
});
const mention = (pageId: string, blockId: string | null = null): DocJSON => ({
  type: 'pageMention',
  attrs: { pageId, blockId },
});
const hardBreak: DocJSON = { type: 'hardBreak' };
const nbsp = String.fromCharCode(0xa0);
const ideographicSpace = String.fromCharCode(0x3000);

const media: Context = {
  pageTitles: { [PLANS]: 'Plans', [EMPTY]: '' },
  pageHrefs: { [PLANS]: '../Plans/Plans.md' },
  assetNames: { [REPORT]: 'Report "Q3".pdf', [PHOTO]: 'photo.png' },
  assetHrefs: { [REPORT]: 'assets/a1/Report%20Q3.pdf', [PHOTO]: 'assets/a2/photo.png' },
  untitled: 'Untitled',
};

function cases(): Omit<Vector, 'markdown'>[] {
  const list: Omit<Vector, 'markdown'>[] = [
    {
      name: 'every text kind, as the editor makes them',
      doc: docOf(
        heading(1, 'Report'),
        paragraph(
          'Plain ',
          text('bold', 'bold'),
          ' and ',
          text('code', 'code'),
          ' and ',
          text('a link', { type: 'link', href: 'https://example.com' }),
        ),
        bullet(['One'], [bullet(['Nested'])]),
        numbered(['First']),
        numbered(['Second']),
        todo(true, 'Done'),
        todo(false, 'Open *star*'),
        toggle(['Summary'], [paragraph('Hidden')]),
        quote('Quoted'),
        callout('💡', 'info', 'Note'),
        divider(),
        code('ts', 'const a = 1;\nconst b = 2;'),
        table([
          ['A', 'B'],
          ['1', '2'],
        ]),
        paragraph('تقرير المبيعات'),
      ),
    },
    {
      name: 'marks, alone and together',
      doc: docOf(
        paragraph(
          text('italic', 'italic'),
          ' ',
          text('under', 'underline'),
          ' ',
          text('struck', 'strike'),
          ' ',
          text('both', 'bold', 'italic'),
          ' ',
          text(' spaced bold ', 'bold'),
          ' ',
          coloured('red', 'textColour', 'red'),
          ' ',
          coloured('marked', 'highlight', 'yellow'),
        ),
        paragraph(
          text('code `tick`', 'code'),
          ' ',
          text('linked code', 'code', { type: 'link', href: 'https://example.com/x' }),
          ' ',
          text('bold link', 'bold', { type: 'link', href: 'https://example.com/b' }),
          ' ',
          text('link then bold', { type: 'link', href: 'https://example.com/l' }, 'bold'),
        ),
        paragraph(
          text('spaces and parens', {
            type: 'link',
            href: `https://example.com/a b_(c)\td${nbsp}e${ideographicSpace}f`,
          }),
          ' ',
          marked('empty link', { type: 'link', attrs: { href: '' } }),
          ' ',
          marked('no attrs', { type: 'link' }),
          ' ',
          marked('unknown mark', { type: 'sparkle' }),
        ),
        paragraph('Escapes: a*b_c`d[e]f~g<h>i|j\\k'),
        paragraph(text('   ', 'bold'), 'after blank bold'),
      ),
    },
    {
      name: 'line starts that would read as Markdown',
      doc: docOf(
        paragraph('# not a heading'),
        paragraph('###### six'),
        paragraph('- not a list'),
        paragraph('+ plus'),
        paragraph('* star'),
        paragraph('1. not a number'),
        paragraph('12) closing'),
        paragraph('> not a quote'),
        paragraph('--- rule'),
        paragraph('```fence'),
        paragraph('١. أرقام عربية'),
        paragraph('#hashtag'),
        heading(2, '# inside a heading'),
        bullet(['- inside a list']),
      ),
    },
    {
      name: 'heading levels, odd ones included',
      doc: docOf(
        heading(1, 'One'),
        heading(2, 'Two'),
        heading(3, 'Three'),
        textBlock('heading', ['Five'], { level: 5 }),
        textBlock('heading', ['Text two'], { level: '2' }),
        textBlock('heading', ['None'], {}),
        textBlock('heading', ['Zero'], { level: 0 }),
        textBlock('heading', ['Half'], { level: 2.5 }),
        textBlock('heading', ['Junk'], { level: 'x' }),
        heading(1),
      ),
    },
    {
      name: 'lists: numbering, nesting, checks, toggles and breaks',
      doc: docOf(
        numbered(['First']),
        numbered(['Second'], [numbered(['Inner one']), numbered(['Inner two'])]),
        paragraph('Between'),
        numbered(['Again one']),
        textBlock('checkItem', ['Checked as text'], { checked: 'yes' }),
        textBlock('checkItem', ['Checked as zero'], { checked: 0 }),
        textBlock('checkItem', ['No attribute']),
        toggle(['Outer'], [toggle(['Inner'], [paragraph('Deep')])]),
        bullet(['Line one', hardBreak, 'line two'], [bullet(['Child', hardBreak, 'wrapped'])]),
        bullet(['A'], [bullet(['B'], [bullet(['C'], [paragraph('Under C')])])]),
      ),
    },
    {
      name: 'quotes and callouts',
      doc: docOf(
        quote('First line', hardBreak, 'second line'),
        textBlock('callout', ['No icon']),
        callout('⚠️', 'warning', 'Careful', hardBreak, 'really'),
        textBlock('callout', ['Number icon'], { icon: 7 }),
        bullet(['Item'], [quote('Quoted under an item', hardBreak, 'and more')]),
      ),
    },
    {
      name: 'code blocks',
      doc: docOf(
        code(null, 'plain'),
        code('md', 'has ``` inside'),
        code('js', ''),
        block({
          type: 'codeBlock',
          attrs: { language: 'py' },
          content: [text('a = 1'), text('\nb = 2')],
        }),
        bullet(['Item'], [code('sh', 'echo one\necho two')]),
        code('text', '*not* **marks** [x](y)'),
      ),
    },
    {
      name: 'images, files, bookmarks, child pages and mentions',
      context: media,
      doc: docOf(
        block({
          type: 'image',
          attrs: { assetId: PHOTO, alt: 'A *photo*', caption: 'Caption [one]', width: 320 },
        }),
        block({ type: 'image', attrs: { assetId: UNKNOWN_ASSET, alt: null, caption: '' } }),
        block({ type: 'image' }),
        block({ type: 'file', attrs: { assetId: REPORT } }),
        block({ type: 'file', attrs: { assetId: UNKNOWN_ASSET } }),
        bookmark('https://example.com/article?a=1&b=2'),
        block({ type: 'bookmark', attrs: { url: '' } }),
        block({ type: 'bookmark' }),
        childPage(PLANS),
        childPage(EMPTY),
        childPage(UNKNOWN_PAGE),
        paragraph(
          'See ',
          mention(PLANS),
          ', ',
          mention(PLANS, 'Ab3dEf6hIj9L'),
          ', ',
          mention(EMPTY),
          ' and ',
          mention(UNKNOWN_PAGE),
        ),
        code(null, 'mention in code: '),
        block({
          type: 'codeBlock',
          content: [text('see '), mention(PLANS), hardBreak, text('next')],
        }),
      ),
    },
    {
      name: 'files and pages with no context',
      doc: docOf(
        block({ type: 'file', attrs: { assetId: REPORT } }),
        childPage(PLANS),
        paragraph('Mention ', mention(PLANS)),
        block({ type: 'image', attrs: { assetId: PHOTO, alt: 'x' } }),
      ),
    },
    {
      name: 'untitled given, names unknown',
      context: { untitled: 'بدون عنوان' },
      doc: docOf(block({ type: 'file', attrs: { assetId: REPORT } }), childPage(PLANS)),
    },
    {
      name: 'tables',
      doc: docOf(
        table([
          [text('Bold', 'bold'), 'a|b'],
          ['', text('code', 'code')],
        ]),
        table(
          [
            ['no', 'header'],
            ['x', 'y'],
          ],
          false,
        ),
        block({
          type: 'table',
          attrs: { headerRow: true },
          content: [
            { type: 'tableRow', content: [{ type: 'tableCell', content: [text('one')] }] },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [text('two')] },
                { type: 'tableCell', content: [text('three')] },
                {
                  type: 'tableCell',
                  content: [text('line'), hardBreak, text('break')],
                },
              ],
            },
          ],
        }),
        block({ type: 'table', attrs: { headerRow: true }, content: [] }),
        block({ type: 'table', content: [{ type: 'tableRow', content: [] }] }),
        bullet(
          ['Item'],
          [
            table([
              ['h1', 'h2'],
              ['c1', 'c2'],
            ]),
          ],
        ),
        table([
          ['الاسم', 'Name'],
          ['محمد', 'Muhammad'],
        ]),
      ),
    },
    {
      name: 'Arabic and English together',
      doc: docOf(
        textBlock('heading', ['تقرير الربع الثالث'], { level: 1, dir: 'rtl' }),
        textBlock('paragraph', ['هذا ', text('مهم', 'bold'), ' جدًا (very important).'], {
          dir: 'rtl',
          colour: 'blue',
        }),
        bullet(['البند الأول'], [bullet(['بند فرعي'])]),
        numbered(['الأول']),
        numbered(['الثاني']),
        todo(true, 'تم'),
        quote('اقتباس', hardBreak, 'سطر ثانٍ'),
        paragraph(
          text('رابط', { type: 'link', href: 'https://example.com/ar' }),
          ' و',
          text('شيفرة', 'code'),
        ),
        paragraph('English, then العربية, then English again.'),
      ),
    },
    {
      name: 'odd shapes a client must not trip on',
      doc: docOf(
        paragraph(),
        bullet([], [paragraph()]),
        block({ type: 'textBody', attrs: { kind: 'paragraph' }, content: [text('first body')] }, [
          { type: 'textBody', attrs: { kind: 'quote' }, content: [text('second body')] },
        ]),
        {
          type: 'block',
          attrs: { id: null },
          content: [
            { type: 'textBody', attrs: { kind: 'paragraph' }, content: [text('two')] },
            { type: 'divider' },
          ],
        },
        block({ type: 'sheetEmbed', attrs: { workbookId: 'w' } }),
        block({ type: 'databaseView' }),
        block({
          type: 'textBody',
          attrs: { kind: 'unknownKind' },
          content: [text('unknown kind')],
        }),
        block({ type: 'textBody', content: [text('no attrs')] }),
        block({ type: 'textBody', attrs: { kind: 'paragraph' }, content: [{ type: 'text' }] }),
        { type: 'textBody', attrs: { kind: 'paragraph' }, content: [text('not in a block')] },
        { type: 'block', attrs: { id: null } },
      ),
    },
    {
      // Schema version 2: a table of contents is drawn from the page's headings, never written.
      name: 'a table of contents writes nothing',
      doc: docOf(
        block({ type: 'tableOfContents' }),
        heading(1, 'Title'),
        paragraph('After'),
        bullet(['Item'], [block({ type: 'tableOfContents', attrs: {} })]),
        block({ type: 'tableOfContents' }, [paragraph('Child of a table of contents')]),
      ),
    },
    { name: 'an empty document', doc: { type: 'doc', content: [] } },
    { name: 'a document with no content', doc: { type: 'doc' } },
  ];
  return list.map((c) => ({ ...c, doc: withoutIds(c.doc) }));
}

describe('Markdown vectors shared with the server', () => {
  it('cover every node, text kind and mark of the schema', () => {
    const nodes = new Set<string>();
    const marks = new Set<string>();
    const kinds = new Set<string>();
    const walk = (node: DocJSON) => {
      nodes.add(node.type);
      if (node.type === 'textBody') kinds.add(String(node.attrs?.kind ?? 'paragraph'));
      for (const mark of node.marks ?? []) marks.add(mark.type);
      node.content?.forEach(walk);
    };
    cases().forEach((c) => walk(c.doc));
    const known = knownTypes();
    for (const node of known.nodes) expect(nodes, node).toContain(node);
    for (const mark of known.marks) expect(marks, mark).toContain(mark);
    for (const kind of TEXT_KINDS) expect(kinds, kind).toContain(kind);
  });

  it('are what toMarkdown writes', () => {
    const vectors: Vector[] = cases().map((c) => ({
      ...c,
      markdown: toMarkdown(c.doc, contextOf(c.context)),
    }));
    if (process.env.CGW_WRITE_VECTORS === '1')
      writeFileSync(file, JSON.stringify(vectors, null, 2) + '\n');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(vectors)));
  });
});
