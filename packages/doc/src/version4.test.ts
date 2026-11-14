// Schema version 4 (Phase 5 contracts, section 1): the `sheetEmbed` and `erpView` bodies, their
// attributes, defaults and HTML, how they are stored in Yjs, that text, Markdown and search write
// nothing of them, and that the read-only view keeps them.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Node as PMNode } from '@tiptap/pm/model';
import { fragmentToJSON, writeJSON } from './binding';
import { build, remapRefs, references } from './index';
import { CONTENT } from './names';
import { readOnlyView } from './readonly';
import { ATOM_BODIES, documentSchema } from './schema';
import { plainText, toMarkdown } from './text';

const { docOf, paragraph, bullet, sheetEmbed, erpView } = build;
const WORKBOOK = '01936f6e-0000-7000-8000-0000000000e1';
const LINK = '01936f6e-0000-7000-8000-0000000000e2';
const FILTER = '{"search":"Kit","equals":{"city":"Cairo"}}';
const FIELDS = '["code","name","balance"]';
const SORT = '[{"field":"name","direction":"desc"}]';

const SHEET_ATTRS = ['workbookId', 'sheet', 'range', 'chartId', 'height'];
const ERP_ATTRS = ['linkId', 'connectorId', 'filter', 'fields', 'sort', 'pageSize'];
const nulls = (names: string[]) => Object.fromEntries(names.map((name) => [name, null]));

/** An element as the schema's parse rules read it: only `getAttribute`. */
const elementWith = (attrs: Record<string, string>) =>
  ({ getAttribute: (name: string) => attrs[name] ?? null }) as unknown as HTMLElement;

describe('the version-4 nodes', () => {
  const schema = documentSchema();

  it('are atom bodies, every attribute optional with a default of null', () => {
    for (const [name, attrs] of [
      ['sheetEmbed', SHEET_ATTRS],
      ['erpView', ERP_ATTRS],
    ] as const) {
      const type = schema.nodes[name];
      expect(type.spec.group, name).toBe('body');
      expect(type.isAtom && type.isLeaf, name).toBe(true);
      expect(ATOM_BODIES, name).toContain(name);
      expect(type.create().attrs, name).toEqual(nulls(attrs));
    }
    // A block holds either as its body, with child blocks after it.
    expect(() =>
      schema
        .nodeFromJSON(
          docOf(
            sheetEmbed(WORKBOOK, { sheet: 'Q3', range: 'A1:D20' }, 320),
            erpView(LINK, 'vendors', { filter: FILTER, fields: FIELDS, sort: SORT, pageSize: 50 }),
            bullet(['Item'], [sheetEmbed(null), erpView(null, null)]),
          ),
        )
        .check(),
    ).not.toThrow();
  });

  it('are drawn in HTML as data attributes, and read back from them', () => {
    const toDOM = (node: PMNode) => node.type.spec.toDOM!(node);
    const embed = schema.nodes.sheetEmbed.create({
      workbookId: WORKBOOK,
      sheet: 'المبيعات',
      range: 'A1:D20',
      chartId: null,
      height: 320,
    });
    expect(toDOM(embed)).toEqual([
      'div',
      {
        'data-body': 'sheetEmbed',
        class: 'cgw-body cgw-sheetEmbed',
        'data-workbookid': WORKBOOK,
        'data-sheet': 'المبيعات',
        'data-range': 'A1:D20',
        'data-height': '320',
      },
    ]);
    const erp = schema.nodes.erpView.create({
      linkId: LINK,
      connectorId: 'customers',
      filter: FILTER,
      fields: FIELDS,
      sort: SORT,
      pageSize: 25,
    });
    expect(toDOM(erp)).toEqual([
      'div',
      {
        'data-body': 'erpView',
        class: 'cgw-body cgw-erpView',
        'data-linkid': LINK,
        'data-connectorid': 'customers',
        'data-filter': FILTER,
        'data-fields': FIELDS,
        'data-sort': SORT,
        'data-pagesize': '25',
      },
    ]);
    // Nothing but the body's name when every attribute is null.
    expect(toDOM(schema.nodes.erpView.create())).toEqual([
      'div',
      { 'data-body': 'erpView', class: 'cgw-body cgw-erpView' },
    ]);

    // The attributes a node parsed from such an element has.
    const rule = (name: string) => {
      const type = schema.nodes[name];
      const rules = type.spec.parseDOM!;
      expect(rules.map((r) => r.tag)).toEqual([`div[data-body="${name}"]`]);
      return (attrs: Record<string, string>) =>
        type.create(rules[0].getAttrs!(elementWith(attrs)) || null).attrs;
    };
    const readSheet = rule('sheetEmbed');
    expect(
      readSheet({
        'data-workbookid': WORKBOOK,
        'data-sheet': 'Q3',
        'data-range': 'B2',
        'data-chartid': 'Chart 1',
        'data-height': '240',
      }),
    ).toEqual({ workbookId: WORKBOOK, sheet: 'Q3', range: 'B2', chartId: 'Chart 1', height: 240 });
    // A height that is not a positive number is none at all.
    for (const bad of ['tall', '0', '-5', '', ' ', 'Infinity'])
      expect(readSheet({ 'data-height': bad }), bad).toEqual(nulls(SHEET_ATTRS));
    const readErp = rule('erpView');
    expect(
      readErp({
        'data-linkid': LINK,
        'data-connectorid': 'vendors',
        'data-filter': FILTER,
        'data-fields': FIELDS,
        'data-sort': SORT,
        'data-pagesize': '50',
      }),
    ).toEqual({
      linkId: LINK,
      connectorId: 'vendors',
      filter: FILTER,
      fields: FIELDS,
      sort: SORT,
      pageSize: 50,
    });
    // JSON text is kept as written: the view reads it and ignores what it cannot.
    expect(readErp({ 'data-fields': 'not json', 'data-pagesize': 'many' })).toEqual({
      ...nulls(ERP_ATTRS),
      fields: 'not json',
    });
  });

  it('are stored in Yjs with their attributes, and read back the same', () => {
    const json = docOf(
      sheetEmbed(WORKBOOK, { sheet: 'Q3', range: 'A1:D20' }, 320),
      sheetEmbed(WORKBOOK, { chartId: 'Chart 1' }),
      erpView(LINK, 'vendors', { filter: FILTER, fields: FIELDS, sort: SORT, pageSize: 50 }),
      erpView(LINK, 'customers'),
    );
    const doc = new Y.Doc();
    writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), json);
    const back = fragmentToJSON(doc.getXmlFragment(CONTENT));
    const bodies = back.content!.map((b) => b.content![0]);
    expect(bodies[0]).toEqual({
      type: 'sheetEmbed',
      attrs: { workbookId: WORKBOOK, sheet: 'Q3', range: 'A1:D20', height: 320 },
    });
    // A null attribute is not stored: it reads back as absent and takes its default.
    expect(bodies[1]).toEqual({
      type: 'sheetEmbed',
      attrs: { workbookId: WORKBOOK, chartId: 'Chart 1' },
    });
    expect(documentSchema().nodeFromJSON(bodies[1]).attrs.range).toBeNull();
    expect(bodies[2]).toEqual({
      type: 'erpView',
      attrs: {
        linkId: LINK,
        connectorId: 'vendors',
        filter: FILTER,
        fields: FIELDS,
        sort: SORT,
        pageSize: 50,
      },
    });
    expect(bodies[3]).toEqual({
      type: 'erpView',
      attrs: { linkId: LINK, connectorId: 'customers' },
    });
  });

  it('write nothing in plain text, which search reads, or in Markdown', () => {
    const json = docOf(
      paragraph('Before'),
      sheetEmbed(WORKBOOK, { sheet: 'Q3 *draft*', range: 'A1:D20' }),
      erpView(LINK, 'vendors', { filter: '{"search":"Distinctive Vendor 7731"}', fields: FIELDS }),
      paragraph('After'),
    );
    expect(plainText(json)).toBe('Before\nAfter');
    expect(toMarkdown(json)).toBe('Before\n\nAfter\n');
  });

  it('are kept by the read-only view, with every attribute', () => {
    const json = docOf(
      paragraph('Before'),
      sheetEmbed(WORKBOOK, { range: 'A1' }, 200),
      erpView(LINK, 'vendors', { fields: FIELDS, pageSize: 25 }),
    );
    const view = readOnlyView(json, { block: 'Needs a newer version.' });
    expect(view.unknownNodes).toEqual([]);
    expect(view.json).toEqual(json);
  });

  it('point at no page: a copy keeps the same workbook and link', () => {
    const json = docOf(sheetEmbed(WORKBOOK), erpView(LINK, 'vendors'));
    const map = new Map([
      [WORKBOOK, '01936f6e-0000-7000-8000-0000000000f1'],
      [LINK, '01936f6e-0000-7000-8000-0000000000f2'],
    ]);
    expect(remapRefs(json, map, map)).toEqual(json);
    expect(references(json)).toEqual({ pages: new Set(), assets: new Set() });
  });
});
