// Markdown in, Phase 8: what an import reads beyond what a paste did (hard breaks, `===`
// headings, numbered lists' starts, bookmarks), and with an import's options: links and images
// resolved by the import, a line that is only a link as a child page, a database or a file,
// Notion's HTML (`<aside>`, `<details>`, `<br>`), front matter and equations; nesting capped so a
// hostile file cannot run the reader out of stack.
import { describe, expect, it } from 'vitest';
import type { DocJSON } from './binding';
import { MAX_NESTING, parseMarkdown, type MarkdownInOptions, type MarkdownNote } from './markdown';
import { toMarkdown } from './text';

const bodies = (doc: DocJSON) => (doc.content ?? []).map((block) => block.content![0]);
const kinds = (doc: DocJSON) =>
  bodies(doc).map((b) => (b.type === 'textBody' ? String(b.attrs?.kind) : b.type));
const texts = (node: DocJSON): string =>
  (node.content ?? [])
    .map((n) => (n.type === 'text' ? n.text : n.type === 'hardBreak' ? '\n' : texts(n)))
    .join('');

function ids(doc: DocJSON): string[] {
  const out: string[] = [];
  const walk = (node: DocJSON) => {
    if (node.type === 'block') out.push(String(node.attrs?.id));
    node.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

function depthOf(node: DocJSON): number {
  const blocks = (node.content ?? []).filter((c) => c.type === 'block');
  return blocks.length ? 1 + Math.max(...blocks.map(depthOf)) : 0;
}

describe('Markdown in, as a paste reads it', () => {
  it('reads hard breaks, === headings, a numbered list’s start and bookmarks', () => {
    const doc = parseMarkdown(
      [
        'Line one  ',
        'line two\\',
        'line three',
        '',
        'Title',
        '===',
        '',
        '3. Third',
        '4. Fourth',
        '',
        '5. Fifth, after a blank line',
        '',
        '- Item  ',
        '  continued',
        '',
        '<https://example.com/a>',
        '',
        'See <https://example.com/b> here.',
      ].join('\n'),
    );
    expect(kinds(doc)).toEqual([
      'paragraph',
      'heading',
      'numberedItem',
      'numberedItem',
      'numberedItem',
      'bulletItem',
      'bookmark',
      'paragraph',
    ]);
    const [para, heading, third, fourth, fifth, item, bookmark, inline] = bodies(doc);
    expect(texts(para)).toBe('Line one\nline two\nline three');
    expect(heading.attrs).toMatchObject({ kind: 'heading', level: 1 });
    expect(third.attrs?.start).toBe(3);
    expect(fourth.attrs?.start).toBeUndefined();
    expect(fifth.attrs?.start).toBeUndefined();
    expect(texts(item)).toBe('Item\ncontinued');
    expect(bookmark.attrs).toEqual({ url: 'https://example.com/a' });
    expect(inline.content![1]).toMatchObject({
      text: 'https://example.com/b',
      marks: [{ type: 'link', attrs: { href: 'https://example.com/b' } }],
    });
  });

  it('takes a backslash off any punctuation, and off toMarkdown’s guard of a number', () => {
    const doc = parseMarkdown('\\1. not a list\n\n\\# not a heading \\(really\\)');
    expect(kinds(doc)).toEqual(['paragraph', 'paragraph']);
    expect(texts(bodies(doc)[0])).toBe('1. not a list');
    expect(texts(bodies(doc)[1])).toBe('# not a heading (really)');
  });

  it('keeps an image as text without an import, as before', () => {
    const doc = parseMarkdown('![alt](https://example.com/x.png)');
    expect(texts(bodies(doc)[0])).toBe('!alt');
  });
});

describe('Markdown in, as an import reads it', () => {
  function withOptions(extra: Partial<MarkdownInOptions> = {}) {
    const notes: [MarkdownNote, string | undefined][] = [];
    const options: MarkdownInOptions = {
      link: (href, text, alone) => {
        if (href === 'Child.md') return alone ? { childPage: 'child-id' } : { mention: 'child-id' };
        if (href === 'Other.md')
          return text === 'Other' ? { mention: 'other-id' } : { page: 'other-id' };
        if (href === 'Tasks.csv') return { databaseView: 'db-id' };
        if (href === 'files/report.pdf') return { file: 'asset-pdf' };
        if (href === '[[Wiki]]') return { mention: 'wiki-id' };
        if (href === 'gone.md') return null;
        return { href };
      },
      image: (src) => (src === 'images/a.png' ? 'asset-a' : null),
      wikiLinks: true,
      note: (what, detail) => notes.push([what, detail]),
      ...extra,
    };
    return { options, notes };
  }

  it('resolves links: child pages, mentions, page links, databases, files and plain links', () => {
    const { options } = withOptions();
    const doc = parseMarkdown(
      [
        '[Child](Child.md)',
        '',
        '[Tasks](Tasks.csv)',
        '',
        '[The report](files/report.pdf)',
        '',
        'See [Other](Other.md), [the other one](Other.md), [Child](Child.md), [[Wiki]], [gone](gone.md) and [web](https://example.com).',
        '',
        'Attached: [report](files/report.pdf) here.',
      ].join('\n'),
      options,
    );
    expect(kinds(doc)).toEqual([
      'childPage',
      'databaseView',
      'file',
      'paragraph',
      'paragraph',
      'file',
    ]);
    const [child, database, file, line] = bodies(doc);
    expect(child.attrs).toEqual({ pageId: 'child-id' });
    expect(database.attrs).toEqual({ databaseId: 'db-id', viewId: null });
    expect(file.attrs).toEqual({ assetId: 'asset-pdf' });
    const nodes = line.content!;
    expect(nodes.filter((n) => n.type === 'pageMention').map((n) => n.attrs?.pageId)).toEqual([
      'other-id',
      'child-id',
      'wiki-id',
    ]);
    const marks = nodes.flatMap((n) => n.marks ?? []).filter((m) => m.type === 'link');
    expect(marks.map((m) => m.attrs?.href)).toEqual(['#/p/other-id', 'https://example.com']);
    // A link the import cannot follow keeps its text.
    expect(texts(line)).toContain('gone');
  });

  it('makes images assets, and says what it could not bring', () => {
    const { options, notes } = withOptions();
    const doc = parseMarkdown(
      [
        '![A](images/a.png)',
        '',
        'Text ![B](images/a.png) after',
        '',
        '![Web](https://example.com/w.png)',
        '',
        '![Lost](lost.png)',
      ].join('\n'),
      options,
    );
    expect(kinds(doc)).toEqual(['image', 'paragraph', 'image', 'paragraph', 'paragraph']);
    expect(bodies(doc)[0].attrs).toEqual({ assetId: 'asset-a', alt: 'A' });
    expect(texts(bodies(doc)[1])).toBe('Text  after');
    expect(bodies(doc)[3].content![0].marks?.[0]).toEqual({
      type: 'link',
      attrs: { href: 'https://example.com/w.png' },
    });
    expect(texts(bodies(doc)[4])).toBe('Lost');
    expect(notes).toEqual([
      ['externalImage', 'https://example.com/w.png'],
      ['missingImage', 'lost.png'],
    ]);
  });

  it('reads Notion’s HTML: callouts, toggles, line breaks and marks', () => {
    const { options, notes } = withOptions();
    const doc = parseMarkdown(
      [
        '<aside>',
        '💡 Remember this.',
        '',
        'And this too.',
        '</aside>',
        '',
        '<details>',
        '<summary>More</summary>',
        'Hidden text.',
        '</details>',
        '',
        'A<br>B <b>bold</b> <span>plain</span>',
        '',
        '> 🔥 A callout as this app writes one',
        '',
        '<!-- a comment',
        'over two lines -->',
        '',
        '$$',
        'x^2',
        '$$',
      ].join('\n'),
      options,
    );
    expect(kinds(doc)).toEqual(['callout', 'toggle', 'paragraph', 'callout', 'codeBlock']);
    const [callout, toggle, line, quoted, equation] = bodies(doc);
    expect(callout.attrs).toMatchObject({ kind: 'callout', icon: '💡' });
    expect(texts(callout)).toBe('Remember this.');
    expect(texts(doc.content![0].content![1].content![0])).toBe('And this too.');
    expect(texts(toggle)).toBe('More');
    expect(texts(doc.content![1].content![1].content![0])).toBe('Hidden text.');
    expect(line.content).toEqual([
      { type: 'text', text: 'A' },
      { type: 'hardBreak' },
      { type: 'text', text: 'B ' },
      { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' plain' },
    ]);
    expect(quoted.attrs).toMatchObject({ kind: 'callout', icon: '🔥' });
    expect(equation.attrs?.language).toBe('latex');
    expect(texts(equation)).toBe('x^2');
    expect(notes.map((n) => n[0])).toEqual(['html', 'html', 'equation']);
  });

  it('takes front matter out and says so', () => {
    const { options, notes } = withOptions();
    const doc = parseMarkdown('---\ntitle: X\ntags: [a]\n---\nBody', options);
    expect(kinds(doc)).toEqual(['paragraph']);
    expect(notes).toEqual([['frontMatter', undefined]]);
    // Without an import a rule is still a rule.
    expect(kinds(parseMarkdown('---\ntitle: X\n---\nBody'))).toContain('divider');
  });

  it('caps nesting: a hostile file nests at most so deep and never runs out of stack', () => {
    const { options, notes } = withOptions();
    const list = Array.from({ length: 200 }, (_, i) => `${'  '.repeat(i)}- level ${i}`).join('\n');
    const asides = `${'<aside>\n'.repeat(30)}inside\n${'</aside>\n'.repeat(30)}`;
    const marks = `${'*_'.repeat(5000)}x${'_*'.repeat(5000)}`;
    const links = `${'['.repeat(3000)}x${'](a)'.repeat(3000)}`;
    const doc = parseMarkdown(`${list}\n\n${asides}\n\n${marks}\n\n${links}`, options);
    expect(depthOf(doc)).toBeLessThanOrEqual(MAX_NESTING + 1);
    expect(notes.some((n) => n[0] === 'tooDeep')).toBe(true);
    expect(JSON.stringify(doc)).toContain('level 199');
    expect(JSON.stringify(doc)).toContain('inside');
  });

  it('gives every block a fresh id, and writes back as Markdown', () => {
    const { options } = withOptions();
    const doc = parseMarkdown('# A\n\n- b\n  - c\n\n| x | y |\n| --- | --- |\n| 1 | 2 |', options);
    const all = ids(doc);
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((id) => /^[0-9A-Za-z]{12}$/.test(id))).toBe(true);
    expect(toMarkdown(doc)).toBe('# A\n\n- b\n\n  - c\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n');
  });
});
