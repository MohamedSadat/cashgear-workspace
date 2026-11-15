// Props as a block holds them (INTEGRATIONS.md, Plugin blocks): read checks every known prop and
// keeps every unknown one; a write merges over what was read, so a newer build's props survive an
// older build's edit; a block written by a later version is read-only. And the registry's rules.
import { describe, expect, it } from 'vitest';
import {
  CHART_TYPE,
  FIRST_PARTY,
  KANBAN_TYPE,
  chart,
  createRegistry,
  kanban,
  parseProps,
  pluginText,
  readBlock,
  untyped,
  writeProps,
} from './index';

describe('props', () => {
  it('parse as a JSON object, and as an empty one for anything else', () => {
    expect(parseProps('{"a":1,"b":[2]}')).toEqual({ a: 1, b: [2] });
    for (const bad of [null, undefined, '', 'not json', '[1,2]', '7', 'null', '"text"'])
      expect(parseProps(bad as string), String(bad)).toEqual({});
  });

  it('are read by the definition, every value it cannot use taking its default', () => {
    expect(
      readBlock(
        chart,
        JSON.stringify({
          databaseId: 'db1',
          viewId: 7,
          chart: 'radar',
          groupBy: '',
          measure: { kind: 'sum' },
          title: '   ',
        }),
        1,
      ).props,
    ).toEqual({
      databaseId: 'db1',
      viewId: null,
      chart: 'bar',
      groupBy: null,
      measure: { kind: 'count' },
      title: null,
    });
    expect(
      readBlock(chart, '{"chart":"pie","measure":{"kind":"average","propertyId":"num1"}}', 1).props,
    ).toMatchObject({ chart: 'pie', measure: { kind: 'average', propertyId: 'num1' } });
    expect(
      readBlock(
        kanban,
        '{"groupBy":"st","cardProperties":["a","a",3,"b"],"hidden":["","x",null]}',
        1,
      ).props,
    ).toEqual({
      databaseId: null,
      viewId: null,
      groupBy: 'st',
      cardProperties: ['a', 'b'],
      hidden: ['', 'x'],
    });
  });

  it('keep every prop this build does not know through a write', () => {
    const text = JSON.stringify({
      databaseId: 'db1',
      chart: 'bar',
      later: { from: 'v2', list: [1, 2] },
      colour: 'blue',
    });
    const read = readBlock(chart, text, 1);
    const written = writeProps(read.raw, { ...read.props, chart: 'line' });
    const back = JSON.parse(written);
    expect(back).toMatchObject({
      databaseId: 'db1',
      chart: 'line',
      later: { from: 'v2', list: [1, 2] },
      colour: 'blue',
    });
    // A prop set to undefined is removed; others stay where they were.
    expect(JSON.parse(writeProps({ a: 1, b: 2 }, { a: undefined }))).toEqual({ b: 2 });
    expect(Object.keys(JSON.parse(writeProps({ z: 1, a: 2 }, { a: 3 })))).toEqual(['z', 'a']);
  });

  it('of a block written by a later version are read-only', () => {
    expect(readBlock(chart, '{}', 1).newer).toBe(false);
    expect(readBlock(chart, '{}', null).newer).toBe(false);
    expect(readBlock(chart, '{}', 2).newer).toBe(true);
  });
});

describe('the registry', () => {
  it('has the first-party chart, then kanban', () => {
    expect(FIRST_PARTY.list().map((d) => d.type)).toEqual([CHART_TYPE, KANBAN_TYPE]);
    expect(FIRST_PARTY.has('cashgear.chart')).toBe(true);
    expect(FIRST_PARTY.has('vendor.timeline')).toBe(false);
    expect(FIRST_PARTY.get('cashgear.kanban')?.version).toBe(1);
    for (const definition of FIRST_PARTY.list()) {
      expect(definition.slash.label.en).toBeTruthy();
      expect(definition.slash.label.ar).toMatch(/\p{Script=Arabic}/u);
      expect(definition.slash.keywords.join(' ')).toMatch(/\p{Script=Arabic}/u);
    }
  });

  it('refuses a type that is not a dotted name, a version that is not whole, and a repeat', () => {
    const like = (type: string, version = 1) => untyped({ ...chart, type, version });
    expect(() => createRegistry([like('chart')])).toThrow();
    expect(() => createRegistry([like('Cashgear.Chart')])).toThrow();
    expect(() => createRegistry([like('a.b', 0)])).toThrow();
    expect(() => createRegistry([like('a.b', 1.5)])).toThrow();
    expect(() => createRegistry([like('a.b'), like('a.b')])).toThrow();
    expect(createRegistry([like('vendor.thing-2')]).has('vendor.thing-2')).toBe(true);
  });

  it("gives a block's line for copy and export, and nothing for a type it does not have", () => {
    const titles = { db1: 'Tasks' } as Record<string, string>;
    const context = (language: 'en' | 'ar') => ({
      language,
      pageTitle: (id: string) => titles[id],
    });
    expect(pluginText(FIRST_PARTY, CHART_TYPE, '{"databaseId":"db1"}', 1, context('en'))).toBe(
      'Chart: Tasks',
    );
    expect(pluginText(FIRST_PARTY, CHART_TYPE, '{"title":"Q3 sales"}', 1, context('en'))).toBe(
      'Chart: Q3 sales',
    );
    expect(pluginText(FIRST_PARTY, KANBAN_TYPE, '{"databaseId":"db1"}', 1, context('ar'))).toBe(
      'لوحة: Tasks',
    );
    expect(pluginText(FIRST_PARTY, KANBAN_TYPE, null, null, context('en'))).toBe('Board');
    expect(pluginText(FIRST_PARTY, 'vendor.timeline', '{}', 1, context('en'))).toBeUndefined();
  });
});
