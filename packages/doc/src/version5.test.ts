// Schema version 5 (Phase 6 contracts, section 2): the `userMention` inline atom, its attribute,
// default and HTML, how it is stored in Yjs, what plain text and Markdown write (`@` and the name
// the writer is given, else `@`), and how the read-only view draws it here and in a build that
// knows only version 4.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Node as PMNode } from '@tiptap/pm/model';
import { fragmentToJSON, writeJSON } from './binding';
import { build, remapRefs, references } from './index';
import { CONTENT } from './names';
import { readOnlyView } from './readonly';
import { documentSchema, knownTypes } from './schema';
import { plainText, toMarkdown } from './text';

const { docOf, paragraph, heading, bullet, userMention, block, text } = build;
const SARA = '01936f6e-0000-7000-8000-0000000000b1';
const OMAR = '01936f6e-0000-7000-8000-0000000000b2';
const names: Record<string, string> = { [SARA]: 'Sara Ali', [OMAR]: 'عمر' };
const userName = (id: string) => names[id];

/** An element as the schema's parse rules read it: only `getAttribute`. */
const elementWith = (attrs: Record<string, string>) =>
  ({ getAttribute: (name: string) => attrs[name] ?? null }) as unknown as HTMLElement;

describe('the version-5 node', () => {
  const schema = documentSchema();

  it('is an inline atom whose one attribute is optional with a default of null', () => {
    const type = schema.nodes.userMention;
    expect(type.spec.group).toBe('inline');
    expect(type.isInline && type.isAtom && type.isLeaf).toBe(true);
    expect(type.create().attrs).toEqual({ userId: null });
    // A text body holds it with text around it, in any text kind, and a table cell does too.
    expect(() =>
      schema
        .nodeFromJSON(
          docOf(
            paragraph('Ask ', userMention(SARA), ' about it'),
            heading(2, userMention(OMAR)),
            bullet([userMention(null)]),
            build.table([[userMention(SARA), 'Owner']]),
          ),
        )
        .check(),
    ).not.toThrow();
    // ProseMirror's own text reads (a table of contents, copied text) see `@`.
    expect(schema.nodeFromJSON(paragraph('Ask ', userMention(SARA))).textContent).toBe('Ask @');
  });

  it('is drawn in HTML as a span with the user id, and read back from it', () => {
    const toDOM = (node: PMNode) => node.type.spec.toDOM!(node);
    expect(toDOM(schema.nodes.userMention.create({ userId: SARA }))).toEqual([
      'span',
      { 'data-user-mention': '', class: 'cgw-user-mention', 'data-userid': SARA },
      '@',
    ]);
    expect(toDOM(schema.nodes.userMention.create())).toEqual([
      'span',
      { 'data-user-mention': '', class: 'cgw-user-mention' },
      '@',
    ]);
    const rules = schema.nodes.userMention.spec.parseDOM!;
    expect(rules.map((r) => r.tag)).toEqual(['span[data-user-mention]']);
    const read = (attrs: Record<string, string>) =>
      schema.nodes.userMention.create(rules[0].getAttrs!(elementWith(attrs)) || null).attrs;
    expect(read({ 'data-user-mention': '', 'data-userid': SARA })).toEqual({ userId: SARA });
    expect(read({ 'data-user-mention': '', 'data-userid': `  ${OMAR} ` })).toEqual({
      userId: OMAR,
    });
    // No id, or a blank one, is a mention of no one.
    for (const bad of [{}, { 'data-userid': '' }, { 'data-userid': '   ' }] as Record<
      string,
      string
    >[])
      expect(read({ 'data-user-mention': '', ...bad }), JSON.stringify(bad)).toEqual({
        userId: null,
      });
  });

  it('is stored in Yjs with its user id, and read back the same', () => {
    const json = docOf(paragraph('Ask ', userMention(SARA), ' and ', userMention(null)));
    const doc = new Y.Doc();
    writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), json);
    // (Yjs writes element names in lower case in its text form.)
    expect(doc.getXmlFragment(CONTENT).toString()).toContain(
      `<usermention userId="${SARA}"></usermention>`,
    );
    const back = fragmentToJSON(doc.getXmlFragment(CONTENT));
    const line = back.content![0].content![0].content!;
    expect(line[1]).toEqual({ type: 'userMention', attrs: { userId: SARA } });
    // A null attribute is not stored: it reads back as absent and takes its default.
    expect(line[3]).toEqual({ type: 'userMention' });
    expect(documentSchema().nodeFromJSON(line[3]).attrs.userId).toBeNull();
  });

  it('writes `@` and the name the writer is given, else `@` alone, in text and Markdown', () => {
    const json = docOf(
      paragraph('Ask ', userMention(SARA), ' about it'),
      paragraph('Unknown ', userMention('01936f6e-0000-7000-8000-0000000000bf'), '.'),
      paragraph('None ', userMention(null), { type: 'userMention' }),
      bullet(['اسأل ', userMention(OMAR)]),
    );
    expect(plainText(json, { userName })).toBe(
      'Ask @Sara Ali about it\nUnknown @.\nNone @@\nاسأل @عمر',
    );
    // As the server's derived text and search write it: `@` alone (names change).
    expect(plainText(json)).toBe('Ask @ about it\nUnknown @.\nNone @@\nاسأل @');
    expect(toMarkdown(json, { userName })).toBe(
      'Ask @Sara Ali about it\n\nUnknown @.\n\nNone @@\n\n- اسأل @عمر\n',
    );
    expect(toMarkdown(json)).toBe('Ask @ about it\n\nUnknown @.\n\nNone @@\n\n- اسأل @\n');
    // A name is the person's own text: Markdown escapes it as it escapes any text.
    expect(toMarkdown(docOf(paragraph(userMention(SARA))), { userName: () => '*Lee* [x]' })).toBe(
      '@\\*Lee\\* \\[x\\]\n',
    );
  });

  it('is kept by the read-only view of this build, and drawn as a placeholder by version 4', () => {
    const json = docOf(
      paragraph('Ask ', userMention(SARA), ' about it'),
      block({ type: 'codeBlock', content: [text('in code '), userMention(SARA)] }),
    );
    const strings = { block: 'Needs a newer version.', inline: '[newer]' };
    // This build: the line as it was; in a code block (only text goes there), its `@`.
    const here = readOnlyView(json, strings);
    expect(here.unknownNodes).toEqual([]);
    expect(here.json.content![0]).toEqual(json.content![0]);
    expect(plainText(here.json)).toBe('Ask @ about it\nin code @');
    // A version-4 build: an inline placeholder where the mention was, the text around it kept.
    const known4 = {
      nodes: new Set([...knownTypes().nodes].filter((n) => n !== 'userMention')),
      marks: knownTypes().marks,
    };
    const older = readOnlyView(json, strings, { known: known4 });
    expect(older.unknownNodes).toEqual(['userMention']);
    expect(plainText(older.json)).toBe(`Ask ${strings.inline} about it\nin code ${strings.inline}`);
    expect(() => documentSchema().nodeFromJSON(older.json).check()).not.toThrow();
  });

  it('points at no page or asset: a copy names the same person', () => {
    const json = docOf(paragraph(userMention(SARA)));
    const map = new Map([[SARA, '01936f6e-0000-7000-8000-0000000000c1']]);
    expect(remapRefs(json, map, map)).toEqual(json);
    expect(references(json)).toEqual({ pages: new Set(), assets: new Set() });
  });
});
