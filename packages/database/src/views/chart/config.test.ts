// A chart view's settings, read defensively (an unknown kind is a bar, a measure that does not read
// a count, a title cut to its limit), written with the properties kept to what the chart draws, a
// new chart's group, and the title from the measure and the group; and the chart's words: the same
// keys and placeholders in both languages, Arabic text in the Arabic, merged into an instance once.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import type { DatabaseRecord, ViewConfig } from '../../core';
import { emptyConfig } from '../../model/viewConfig';
import {
  chartOf,
  chartProperties,
  chartTitle,
  defaultChartGroup,
  groupProperty,
  readMeasure,
  withChart,
} from './config';
import { addChartWords, chartAr, chartEn, type ChartT } from './words';

const database: DatabaseRecord = {
  id: 'db',
  workspaceId: 'ws',
  properties: [
    { id: 'title', name: 'Name', type: 'title' },
    { id: 'notes', name: 'Notes', type: 'text' },
    { id: 'amount', name: 'Amount', type: 'number' },
    { id: 'gone', name: 'Gone', type: 'number', trashedAt: '2026-11-01T00:00:00Z' },
    { id: 'kind', name: 'Kind', type: 'select', options: [] },
    { id: 'status', name: 'Status', type: 'status', options: [] },
  ],
  version: 1,
  rowCount: 0,
  createdAt: '2026-11-01T00:00:00Z',
};
const config = (chart: unknown, group: ViewConfig['group'] = { propertyId: 'status' }) =>
  ({ ...emptyConfig('chart'), group, chart }) as ViewConfig;

describe('a chart view’s settings', () => {
  it('are read whatever the config holds', () => {
    expect(chartOf(emptyConfig('chart'))).toEqual({
      kind: 'bar',
      measure: { kind: 'count' },
      title: null,
    });
    expect(
      chartOf(config({ kind: 'pie', measure: { kind: 'sum', propertyId: 'amount' } })),
    ).toEqual({ kind: 'pie', measure: { kind: 'sum', propertyId: 'amount' }, title: null });
    // A kind this build does not draw (the block's number among them) is a bar.
    expect(chartOf(config({ kind: 'number' })).kind).toBe('bar');
    expect(chartOf(config({ kind: 'radar' })).kind).toBe('bar');
    expect(chartOf(config('bar')).kind).toBe('bar');
    expect(chartOf(config([1, 2])).measure).toEqual({ kind: 'count' });
    // A measure that does not read is a count.
    for (const measure of [
      { kind: 'sum' },
      { kind: 'median', propertyId: 'amount' },
      { kind: 'average', propertyId: '' },
      { kind: 'average', propertyId: 7 },
      'sum',
      null,
    ])
      expect(readMeasure(measure)).toEqual({ kind: 'count' });
    expect(chartOf(config({ title: '   ' })).title).toBeNull();
    expect(chartOf(config({ title: 7 })).title).toBeNull();
    expect(chartOf(config({ title: 'x'.repeat(250) })).title).toHaveLength(200);
  });

  it('keep the properties to the title, the group and the measure', () => {
    const counted = chartProperties(database, config({ measure: { kind: 'count' } }));
    expect(counted.order).toEqual(['title', 'status']);
    expect(counted.hidden).toEqual(['notes', 'amount', 'gone', 'kind']);
    const summed = withChart(database, config({}), {
      measure: { kind: 'sum', propertyId: 'amount' },
    });
    expect(summed.chart).toEqual({
      kind: 'bar',
      measure: { kind: 'sum', propertyId: 'amount' },
      title: null,
    });
    expect(summed.properties.order).toEqual(['title', 'status', 'amount']);
    expect(summed.properties.hidden).toEqual(['notes', 'gone', 'kind']);
    // A measure or a group on a property that is gone, or cannot be read so, shows nothing more.
    const gone = withChart(database, config({}, { propertyId: 'notes' }), {
      measure: { kind: 'sum', propertyId: 'gone' },
    });
    expect(gone.properties.order).toEqual(['title']);
    // No group: only the title.
    expect(chartProperties(database, config({}, null)).order).toEqual(['title']);
    // Column widths are kept.
    const wide = { ...config({}), properties: { order: [], hidden: [], widths: { title: 300 } } };
    expect(chartProperties(database, wide).widths).toEqual({ title: 300 });
  });

  it('start grouped by a status, then a select, then any property rows group by', () => {
    expect(defaultChartGroup(database)).toEqual({ propertyId: 'status' });
    const noStatus = {
      ...database,
      properties: database.properties.filter((p) => p.id !== 'status'),
    };
    expect(defaultChartGroup(noStatus)).toEqual({ propertyId: 'kind' });
    const plain = { ...database, properties: database.properties.slice(0, 3) };
    expect(defaultChartGroup(plain)).toBeNull();
    expect(groupProperty(database, { propertyId: 'notes' })).toBeUndefined();
    expect(groupProperty(database, { propertyId: 'kind' })?.name).toBe('Kind');
  });

  it('say a title from the measure and the group', () => {
    const t: ChartT = (key, options) => `${key}:${JSON.stringify(options)}`;
    const status = database.properties.find((p) => p.id === 'status');
    const amount = database.properties.find((p) => p.id === 'amount');
    expect(chartTitle(t, { kind: 'count' }, status, undefined)).toBe(
      'titles.count:{"group":"Status","measure":""}',
    );
    expect(chartTitle(t, { kind: 'average', propertyId: 'amount' }, status, amount)).toBe(
      'titles.average:{"group":"Status","measure":"Amount"}',
    );
    // A sum of nothing it can read is a count.
    expect(chartTitle(t, { kind: 'sum', propertyId: 'amount' }, undefined, undefined)).toBe(
      'titles.countAll:{"group":"","measure":""}',
    );
  });
});

type Tree = { [key: string]: string | Tree };
const flatten = (tree: Tree, prefix = ''): Map<string, string> =>
  new Map(
    Object.entries(tree).flatMap(([key, value]) =>
      typeof value === 'string'
        ? [[`${prefix}${key}`, value] as const]
        : [...flatten(value, `${prefix}${key}.`)],
    ),
  );
/** i18next's `{{name}}` and the chart library's own `{name}`. */
const placeholders = (text: string) =>
  [...text.matchAll(/\{\{?(\w+)\}\}?/g)].map((m) => m[0]).sort();

describe('the chart’s words', () => {
  const english = flatten(chartEn as Tree);
  const arabic = flatten(chartAr as unknown as Tree);

  it('have the same keys and placeholders in both languages, and Arabic in the Arabic', () => {
    expect([...arabic.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, text] of english) {
      expect(text.trim(), key).not.toBe('');
      expect(placeholders(arabic.get(key)!), key).toEqual(placeholders(text));
      // Placeholders, and the keys' names as the keyboard labels them (the views' rule).
      const words = arabic.get(key)!.replace(/\{\{?\w+\}\}?|\b(?:Enter|Space|Esc)\b/g, '');
      expect(/[A-Za-z]/.test(words), `${key}: ${words}`).toBe(false);
      // Punctuation alone (a template of placeholders) needs no Arabic letter.
      if (/\p{L}/u.test(words))
        expect(/\p{Script=Arabic}/u.test(words), `${key}: ${words}`).toBe(true);
    }
  });

  it('hold every key the chart view and the chart block ask for', () => {
    // The chart's translator is `ct` here and `chartT` in the block (`t` is the views' own).
    const files = [
      ...readdirSync(import.meta.dirname)
        .filter((name) => /\.tsx?$/.test(name) && !name.includes('.test.'))
        .map((name) => join(import.meta.dirname, name)),
      join(import.meta.dirname, '../../../../plugins/src/chart/ChartBlock.tsx'),
    ];
    const missing: string[] = [];
    let asked = 0;
    for (const file of files)
      for (const match of readFileSync(file, 'utf8').matchAll(
        /\b(?:ct|chartT)\(\s*'([a-zA-Z.]+)'/g,
      )) {
        asked++;
        if (!english.has(match[1])) missing.push(`${file}: ${match[1]}`);
      }
    expect(missing).toEqual([]);
    expect(asked).toBeGreaterThan(15);
  });

  it('are merged into an instance’s database section once, beside what it holds', () => {
    const instance = i18next.createInstance();
    void instance.init({
      lng: 'en',
      resources: { en: { translation: { database: { loading: 'Loading…' } } }, ar: {} },
      initAsync: false,
    });
    expect(instance.exists('database.chart.noRows')).toBe(false);
    addChartWords(instance);
    addChartWords(instance);
    expect(instance.t('database.chart.noRows')).toBe('No rows to chart.');
    expect(instance.t('database.loading')).toBe('Loading…');
    expect(instance.getFixedT('ar')('database.chart.noRows')).toBe(chartAr.noRows);
  });
});
