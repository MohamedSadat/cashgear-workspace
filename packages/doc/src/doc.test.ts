import { readFileSync } from 'node:fs';
import { MemoryStore, uuidv7 } from '@cgw/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { fragmentToJSON, writeJSON, type DocJSON } from './binding';
import { build, readableJSON, references, remapRefs, withNewIds } from './index';
import { CONTENT, META, PageDocument, retryPending } from './document';
import { BLOCK_ID } from './ids';
import { SCHEMA_VERSION, documentSchema, knownTypes, safeHref } from './schema';
import { plainText, toMarkdown } from './text';

const {
  docOf,
  heading,
  paragraph,
  bullet,
  numbered,
  todo,
  toggle,
  quote,
  callout,
  divider,
  code,
  text,
  table,
} = build;

describe('schema', () => {
  const schema = documentSchema();

  it('uses * only in content expressions (D3)', () => {
    for (const [name, type] of Object.entries(schema.nodes)) {
      const content = type.spec.content ?? '';
      expect(content, name).not.toMatch(/[+{]/);
    }
    expect(schema.nodes.block.spec.content).toBe('(body | block)*');
    expect(schema.nodes.doc.spec.content).toBe('block*');
    expect(schema.nodes.textBody.spec.group).toBe('body');
  });

  it('gives every attribute a default', () => {
    for (const [name, type] of Object.entries(schema.nodes))
      for (const [attr, spec] of Object.entries(type.spec.attrs ?? {}))
        expect('default' in (spec as object), `${name}.${attr}`).toBe(true);
    for (const [name, type] of Object.entries(schema.marks))
      for (const [attr, spec] of Object.entries(type.spec.attrs ?? {}))
        expect('default' in (spec as object), `${name}.${attr}`).toBe(true);
  });

  it('keeps every node and mark the plan names (none is ever removed)', () => {
    const { nodes, marks } = knownTypes();
    for (const name of [
      'doc',
      'block',
      'textBody',
      'codeBlock',
      'divider',
      'table',
      'tableRow',
      'tableCell',
      'image',
      'file',
      'bookmark',
      'childPage',
      'text',
      'hardBreak',
      'pageMention',
    ])
      expect(nodes.has(name), name).toBe(true);
    for (const name of [
      'bold',
      'italic',
      'underline',
      'strike',
      'code',
      'link',
      'textColour',
      'highlight',
    ])
      expect(marks.has(name), name).toBe(true);
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('allows only safe link schemes', () => {
    for (const ok of [
      'https://example.com',
      'http://x.y',
      'mailto:a@b.c',
      'tel:+20123',
      '#/p/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    ])
      expect(safeHref(ok), ok).toBe(ok);
    for (const bad of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'java\tscript:x',
      'data:text/html,x',
      'vbscript:x',
      '//evil.com',
      'file:///c:/',
      ' javascript:x',
      null,
      3,
    ])
      expect(safeHref(bad), String(bad)).toBeNull();
  });
});

function sample(): DocJSON {
  return docOf(
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
  );
}

describe('text output', () => {
  it('writes plain text, one block per line', () => {
    const lines = plainText(sample()).split('\n');
    expect(lines).toContain('Report');
    expect(lines).toContain('Plain bold and code and a link');
    expect(lines).toContain('Nested');
    expect(lines).toContain('تقرير المبيعات');
    expect(lines).toContain('A\tB');
  });

  it('writes Markdown', () => {
    expect(toMarkdown(sample())).toBe(
      [
        '# Report',
        'Plain **bold** and `code` and [a link](https://example.com)',
        '- One',
        '  - Nested',
        '1. First',
        '2. Second',
        '- [x] Done',
        '- [ ] Open \\*star\\*',
        '- Summary',
        '  Hidden',
        '> Quoted',
        '> 💡 Note',
        '---',
        '```ts\nconst a = 1;\nconst b = 2;\n```',
        '| A | B |\n| --- | --- |\n| 1 | 2 |',
        'تقرير المبيعات',
      ].join('\n\n') + '\n',
    );
  });

  it('names pages and files through the context, never from the document', () => {
    const page = uuidv7();
    const doc = docOf(
      build.childPage(page),
      paragraph('See ', { type: 'pageMention', attrs: { pageId: page } }),
    );
    expect(toMarkdown(doc, { pageTitle: () => 'Plans', pageHref: () => 'plans.md' })).toBe(
      '[Plans](plans.md)\n\nSee [Plans](plans.md)\n',
    );
    expect(plainText(doc, { pageTitle: () => 'Plans' })).toBe('Plans\nSee Plans');
  });
});

describe('content helpers', () => {
  it('give every copied block a new id, and remap references', () => {
    const page = uuidv7();
    const copy = uuidv7();
    const original = docOf(paragraph('a'), build.childPage(page), toggle(['t'], [paragraph('c')]));
    const fresh = withNewIds(original);
    const ids = (d: DocJSON): string[] => [
      ...(d.type === 'block' ? [String(d.attrs?.id)] : []),
      ...(d.content ?? []).flatMap(ids),
    ];
    expect(ids(fresh).every((id) => BLOCK_ID.test(id))).toBe(true);
    expect(ids(fresh).some((id) => ids(original).includes(id))).toBe(false);
    const remapped = remapRefs(fresh, new Map([[page, copy]]));
    expect([...references(remapped).pages]).toEqual([copy]);
  });

  it('draws unknown nodes as a placeholder in a read-only view', () => {
    const doc: DocJSON = {
      type: 'doc',
      content: [
        {
          type: 'block',
          attrs: { id: 'aaaaaaaaaaaa' },
          content: [{ type: 'sheetEmbed', attrs: { workbookId: 'x' } }],
        },
        paragraph('kept'),
      ],
    };
    const readable = readableJSON(doc, knownTypes(), 'Needs a newer version');
    expect(JSON.stringify(readable)).toContain('Needs a newer version');
    expect(JSON.stringify(readable)).not.toContain('sheetEmbed');
    expect(JSON.stringify(readable)).toContain('kept');
  });
});

describe('page document', () => {
  afterEach(() => vi.useRealTimers());

  async function seeded(store: MemoryStore, pageId: string, json: DocJSON) {
    const doc = new Y.Doc();
    writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), json);
    await store.appendDocUpdates(pageId, [
      { updateId: uuidv7(), data: Y.encodeStateAsUpdate(doc) },
    ]);
  }

  it('batches updates for at most 500 ms, saves them, and reopens to the same content', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    const pageId = uuidv7();
    const page = await PageDocument.open(pageId, store);
    await vi.advanceTimersByTimeAsync(600);
    const writes = await store.docLogLength(pageId); // the meta stamp of a new page
    const text = new Y.XmlText();
    page.fragment.insert(0, [text]);
    const states: string[] = [];
    page.onSaveState((s) => states.push(s));
    for (let i = 0; i < 10; i++) {
      text.insert(text.length, 'x');
      await vi.advanceTimersByTimeAsync(60);
    }
    expect(await store.docLogLength(pageId)).toBe(writes + 1); // the 500 ms cap wrote once
    await vi.advanceTimersByTimeAsync(600);
    expect(page.saveState).toBe('saved');
    expect(states).toContain('saving');
    const reopened = await PageDocument.open(pageId, store);
    expect(reopened.fragment.toString()).toBe(page.fragment.toString());
    expect(reopened.doc.getMap(META).get('schemaVersion')).toBe(SCHEMA_VERSION);
    expect(reopened.doc.getMap(META).get('pageId')).toBe(pageId);
  });

  it('keeps an unsaved batch and retries when a write fails', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new MemoryStore();
    const pageId = uuidv7();
    const page = await PageDocument.open(pageId, store);
    await page.flush();
    const append = vi
      .spyOn(store, 'appendDocUpdates')
      .mockRejectedValueOnce(new Error('disk full'));
    page.fragment.insert(0, [new Y.XmlText('kept')]);
    await page.flush();
    expect(page.saveState).toBe('error');
    await vi.advanceTimersByTimeAsync(2000);
    expect(page.saveState).toBe('saved');
    expect(append).toHaveBeenCalledTimes(2);
    expect((await PageDocument.open(pageId, store)).fragment.toString()).toContain('kept');
  });

  it('compacts the local log past the limit and loses nothing', async () => {
    const store = new MemoryStore();
    const pageId = uuidv7();
    const page = await PageDocument.open(pageId, store, { compactAfter: 5 });
    const text = new Y.XmlText();
    page.fragment.insert(0, [text]);
    for (let i = 0; i < 12; i++) {
      text.insert(text.length, String(i % 10));
      await page.flush();
    }
    expect(await store.docLogLength(pageId)).toBeLessThan(6);
    const loaded = await store.loadDoc(pageId);
    expect(loaded.snapshot).not.toBeNull();
    expect((await PageDocument.open(pageId, store)).fragment.toString()).toBe(
      page.fragment.toString(),
    );
  });

  it('sets an update that will not decode aside and opens the rest', async () => {
    const store = new MemoryStore();
    const pageId = uuidv7();
    await seeded(store, pageId, docOf(paragraph('good')));
    await store.appendDocUpdates(pageId, [
      { updateId: uuidv7(), data: new Uint8Array([255, 1, 2, 3]) },
    ]);
    const page = await PageDocument.open(pageId, store);
    expect(page.report.quarantined).toBe(1);
    expect(JSON.stringify(fragmentToJSON(page.fragment))).toContain('good');
    expect(store.corruptUpdates()).toHaveLength(1);
    await page.flush();
    expect(await store.docLogLength(pageId)).toBe(2); // the good update and the meta stamp
  });

  it('opens a newer document read-only and writes nothing to it (D7)', async () => {
    const store = new MemoryStore();
    const pageId = uuidv7();
    const newer = new Y.Doc();
    newer.getMap(META).set('schemaVersion', SCHEMA_VERSION + 1);
    newer.getXmlFragment(CONTENT).insert(0, [new Y.XmlElement('futureBlock')]);
    await store.appendDocUpdates(pageId, [
      { updateId: uuidv7(), data: Y.encodeStateAsUpdate(newer) },
    ]);
    const before = await store.loadDoc(pageId);
    const page = await PageDocument.open(pageId, store);
    expect(page.readOnly).toBe(true);
    expect(page.saveState).toBe('readOnly');
    page.fragment.insert(0, [new Y.XmlText('should not save')]);
    await page.flush();
    const after = await store.loadDoc(pageId);
    expect(after.updates.map((u) => [...u.data])).toEqual(before.updates.map((u) => [...u.data]));
  });

  it('heals the Yjs pending-order case on open (S1 fixture)', () => {
    const updates = (
      JSON.parse(
        readFileSync(
          new URL('../../../bench/editor/fixtures/yjs-pending-order.json', import.meta.url),
          'utf8',
        ),
      ) as string[]
    ).map((b64) => new Uint8Array(Buffer.from(b64, 'base64')));
    const doc = new Y.Doc();
    for (const update of updates) Y.applyUpdate(doc, update);
    expect(retryPending(doc)).toEqual({ before: true, after: false });
  });

  it('round-trips ProseMirror JSON through Yjs', () => {
    const doc = new Y.Doc();
    const json = sample();
    writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), json);
    const back = fragmentToJSON(doc.getXmlFragment(CONTENT));
    expect(toMarkdown(back)).toBe(toMarkdown(json));
  });
});

describe('Markdown in', () => {
  it('reads back what toMarkdown writes', async () => {
    const { parseMarkdown } = await import('./markdown');
    const json = sample();
    const again = parseMarkdown(toMarkdown(json));
    // Toggles and callouts have no Markdown form of their own; the rest round-trips.
    const expected = toMarkdown(json)
      .replace('- Summary\n\n  Hidden', '- Summary\n\n  Hidden')
      .replace('> 💡 Note', '> 💡 Note');
    expect(toMarkdown(again)).toBe(expected);
  });

  it('nests list items by indent and keeps links safe', async () => {
    const { parseMarkdown, looksLikeMarkdown } = await import('./markdown');
    const doc = parseMarkdown(
      '- a\n  - b\n    - c\n- d\n\n[x](javascript:alert(1)) and [y](https://ok.example)',
    );
    expect(toMarkdown(doc)).toBe(
      '- a\n\n  - b\n\n    - c\n\n- d\n\nx and [y](https://ok.example)\n',
    );
    expect(looksLikeMarkdown('# Title\n\ntext')).toBe(true);
    expect(looksLikeMarkdown('Just a sentence, with 2 * 3 in it.')).toBe(false);
    const ids = JSON.stringify(doc).match(/"id":"([0-9A-Za-z]{12})"/g) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
