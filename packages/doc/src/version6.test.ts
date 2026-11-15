// Schema version 6 (Phase 7, INTEGRATIONS.md, Plugin blocks): the `pluginBlock` body, its three
// attributes, defaults and HTML, how it is stored in Yjs, what plain text and Markdown write (the
// definition's line only when the writer has one), copies that follow a copied database, and how
// the read-only view draws it here and in a build that knows only version 5.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Node as PMNode } from '@tiptap/pm/model';
import { fragmentToJSON, writeJSON } from './binding';
import { build, remapRefs, references } from './index';
import { CONTENT } from './names';
import { readOnlyView } from './readonly';
import { documentSchema, knownTypes } from './schema';
import { plainText, toMarkdown } from './text';

const { docOf, paragraph, pluginBlock, block } = build;
const DATABASE = '01936f6e-0000-7000-8000-0000000000d1';
const VIEW = '01936f6e-0000-7000-8000-0000000000d2';
const COPY = '01936f6e-0000-7000-8000-0000000000d3';
const COPY_VIEW = '01936f6e-0000-7000-8000-0000000000d4';
const CHART = { databaseId: DATABASE, viewId: VIEW, chart: 'pie', groupBy: 'status' };

const elementWith = (attrs: Record<string, string>) =>
  ({ getAttribute: (name: string) => attrs[name] ?? null }) as unknown as HTMLElement;

describe('the version-6 node', () => {
  const schema = documentSchema();

  it('is an atom body whose three attributes are optional with null defaults', () => {
    const type = schema.nodes.pluginBlock;
    expect(type.spec.group).toBe('body');
    expect(type.isAtom && type.isLeaf && type.isBlock).toBe(true);
    expect(type.create().attrs).toEqual({ type: null, version: null, props: null });
    expect(() =>
      schema
        .nodeFromJSON(
          docOf(
            pluginBlock('cashgear.chart', CHART, 1),
            pluginBlock(null),
            block({ type: 'pluginBlock' }, [paragraph('A child')]),
          ),
        )
        .check(),
    ).not.toThrow();
  });

  it('is drawn in HTML with its attributes, and read back from them', () => {
    const toDOM = (node: PMNode) => node.type.spec.toDOM!(node);
    const props = JSON.stringify(CHART);
    expect(
      toDOM(schema.nodes.pluginBlock.create({ type: 'cashgear.chart', version: 1, props })),
    ).toEqual([
      'div',
      {
        'data-body': 'pluginBlock',
        class: 'cgw-body cgw-pluginBlock',
        'data-type': 'cashgear.chart',
        'data-version': '1',
        'data-props': props,
      },
    ]);
    const rules = schema.nodes.pluginBlock.spec.parseDOM!;
    expect(rules.map((r) => r.tag)).toEqual(['div[data-body="pluginBlock"]']);
    const parsed = (attrs: Record<string, string>) =>
      schema.nodes.pluginBlock.create(rules[0].getAttrs!(elementWith(attrs)) || null).attrs;
    expect(
      parsed({ 'data-type': 'cashgear.kanban', 'data-version': '2', 'data-props': '{"a":1}' }),
    ).toEqual({ type: 'cashgear.kanban', version: 2, props: '{"a":1}' });
    // A version that is not a positive whole number is none.
    for (const bad of ['0', '-1', '1.5', 'two', ''])
      expect(parsed({ 'data-version': bad }).version, bad).toBeNull();
  });

  it('is stored in Yjs with its attributes, and read back the same', () => {
    const json = docOf(pluginBlock('cashgear.chart', CHART, 1), pluginBlock(null));
    const doc = new Y.Doc();
    writeJSON(doc.getXmlFragment(CONTENT), documentSchema(), json);
    expect(doc.getXmlFragment(CONTENT).toString()).toContain('<pluginblock');
    const back = fragmentToJSON(doc.getXmlFragment(CONTENT));
    expect(back.content![0].content![0]).toEqual({
      type: 'pluginBlock',
      attrs: { type: 'cashgear.chart', version: 1, props: JSON.stringify(CHART) },
    });
    // Null attributes are not stored: they read back as absent and take their defaults.
    expect(back.content![1].content![0]).toEqual({ type: 'pluginBlock' });
    expect(documentSchema().nodeFromJSON(back.content![1].content![0]).attrs).toEqual({
      type: null,
      version: null,
      props: null,
    });
  });

  it("writes nothing in text and Markdown, unless the writer has the definition's line", () => {
    const json = docOf(
      paragraph('Before'),
      pluginBlock('cashgear.chart', CHART, 1),
      pluginBlock('vendor.unknown', '{"x":1}', 4),
      paragraph('After'),
    );
    expect(plainText(json)).toBe('Before\nAfter');
    expect(toMarkdown(json)).toBe('Before\n\nAfter\n');
    const seen: unknown[] = [];
    const pluginText = (type: string, props: string | null, version: number | null) => {
      seen.push([type, props, version]);
      return type === 'cashgear.chart' ? '# Chart: *Tasks* by status' : undefined;
    };
    expect(plainText(json, { pluginText })).toBe('Before\n# Chart: *Tasks* by status\nAfter');
    // In Markdown, escaped as the person's text is: it never becomes a heading or emphasis.
    expect(toMarkdown(json, { pluginText })).toBe(
      'Before\n\n\\# Chart: \\*Tasks\\* by status\n\nAfter\n',
    );
    expect(seen).toContainEqual(['cashgear.chart', JSON.stringify(CHART), 1]);
    expect(seen).toContainEqual(['vendor.unknown', '{"x":1}', 4]);
  });

  it('is kept by the read-only view of this build, and drawn as a placeholder by version 5', () => {
    const json = docOf(paragraph('Before'), pluginBlock('cashgear.chart', CHART, 1));
    const strings = { block: 'Needs a newer version.', inline: '[newer]' };
    const here = readOnlyView(json, strings);
    expect(here.unknownNodes).toEqual([]);
    expect(here.json).toEqual(json);
    const known5 = {
      nodes: new Set([...knownTypes().nodes].filter((n) => n !== 'pluginBlock')),
      marks: knownTypes().marks,
    };
    const older = readOnlyView(json, strings, { known: known5 });
    expect(older.unknownNodes).toEqual(['pluginBlock']);
    expect(plainText(older.json)).toBe(`Before\n${strings.block}`);
    expect(() => documentSchema().nodeFromJSON(older.json).check()).not.toThrow();
  });

  it("follows a copied database in a copy's props, and keeps every other prop as it was", () => {
    const props = JSON.stringify({ ...CHART, later: { kept: [1, 2] }, title: 'Q3' });
    const json = docOf(pluginBlock('cashgear.chart', props, 1), pluginBlock('x', 'not json', 1));
    const map = new Map([
      [DATABASE, COPY],
      [VIEW, COPY_VIEW],
    ]);
    const copied = remapRefs(json, map);
    const attrs = copied.content![0].content![0].attrs!;
    expect(JSON.parse(String(attrs.props))).toEqual({
      ...CHART,
      databaseId: COPY,
      viewId: COPY_VIEW,
      later: { kept: [1, 2] },
      title: 'Q3',
    });
    expect(attrs.type).toBe('cashgear.chart');
    expect(attrs.version).toBe(1);
    // Not JSON, or nothing in the map: the props are the same text.
    expect(copied.content![1].content![0].attrs!.props).toBe('not json');
    expect(remapRefs(json, new Map())).toEqual(json);
    // It names no page or asset of its own.
    expect(references(json)).toEqual({ pages: new Set(), assets: new Set() });
  });
});
