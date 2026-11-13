// The views' pure parts: the virtualised window's arithmetic, grid keyboard movement (RTL
// mirrored), view configuration changes, safe links, a new row's presets, the table's items,
// formats, formula suggestions, the type-change preview, and the catalogues.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RowRecord } from '@cgw/workspace';
import type { DatabaseRecord, ViewConfig } from './core';
import type { RowSnapshot } from './host';
import { ar, en } from './i18n';
import { formatDatePart, formatNumber, cellText, type TextLookups } from './model/format';
import { safeEmail, safePhone, safeUrl } from './model/links';
import { valuesForNewRow } from './model/newRow';
import { orderedProperties, shownProperties, uniqueName } from './model/properties';
import {
  appendAt,
  conditionCount,
  emptyConfig,
  moveProperty,
  placeProperty,
  removeAt,
  replaceAt,
  withCondition,
  withHidden,
  withSort,
} from './model/viewConfig';
import { moveIndex } from './pickers/reorder';
import { previewConversion, shapeForType } from './properties/defs';
import { suggestionsAt } from './properties/FormulaEditor';
import { buildItems } from './table/items';
import { navigate, startsTyping, type GridShape } from './table/navigation';
import { columnRange, indexAt, layoutOf, revealScroll, visibleRange } from './table/windowing';
import { P, rowRecord, seed } from './testing/fixtures';

describe('the window', () => {
  const layout = layoutOf(50_000, () => 34);

  it('lays items out at fixed heights and finds the item at an offset', () => {
    expect(layout.total).toBe(50_000 * 34);
    expect(indexAt(layout, 0)).toBe(0);
    expect(indexAt(layout, 33)).toBe(0);
    expect(indexAt(layout, 34)).toBe(1);
    expect(indexAt(layout, 34 * 49_999 + 5)).toBe(49_999);
    expect(indexAt(layout, 1e9)).toBe(49_999);
  });

  it('draws the window and an overscan on each side, never past the ends', () => {
    expect(visibleRange(layout, 0, 600, 8)).toEqual({ start: 0, end: 18 + 8 });
    const middle = visibleRange(layout, 34 * 1000, 600, 8);
    expect(middle).toEqual({ start: 992, end: 1018 + 8 });
    expect(middle.end - middle.start).toBeLessThan(40);
    const end = visibleRange(layout, layout.total - 600, 600, 8);
    expect(end.end).toBe(50_000);
    expect(
      visibleRange(
        layoutOf(0, () => 34),
        0,
        600,
        8,
      ),
    ).toEqual({ start: 0, end: 0 });
  });

  it('handles mixed heights (group headers are taller)', () => {
    const mixed = layoutOf(5, (i) => (i % 2 ? 34 : 42));
    expect([...mixed.offsets]).toEqual([0, 42, 76, 118, 152, 194]);
    expect(indexAt(mixed, 80)).toBe(2);
  });

  it('draws the columns in the horizontal window, the title always', () => {
    const widths = [280, 100, 100, 100, 100, 100, 100];
    // 400 pixels wide at the start: the title, then columns 1 and 2 (and one more).
    expect(columnRange(widths, 0, 400, 1)).toEqual({ start: 1, end: 4 });
    // Scrolled by 250: column 1 is hidden under the sticky title.
    expect(columnRange(widths, 250, 400, 0)).toEqual({ start: 3, end: 5 });
    expect(columnRange(widths, 10_000, 400, 1)).toEqual({ start: 5, end: 7 });
    expect(columnRange([280], 0, 400, 1)).toEqual({ start: 1, end: 1 });
  });

  it('scrolls an item into view only when it is not', () => {
    expect(revealScroll(layout, 5, 0, 600, 0)).toBeNull();
    expect(revealScroll(layout, 100, 0, 600, 0)).toBe(101 * 34 - 600);
    expect(revealScroll(layout, 3, 34 * 10, 600, 0)).toBe(3 * 34);
  });
});

describe('grid keys', () => {
  const shape = (rtl = false): GridShape => ({
    count: 10,
    cols: 4,
    isRow: (i) => i !== 3,
    pageSize: 5,
    rtl,
  });

  it('move by arrows, mirrored in RTL', () => {
    const at = { item: 2, col: 1 };
    expect(navigate(at, { key: 'ArrowRight' }, shape())).toEqual({ item: 2, col: 2 });
    expect(navigate(at, { key: 'ArrowLeft' }, shape())).toEqual({ item: 2, col: 0 });
    expect(navigate(at, { key: 'ArrowLeft' }, shape(true))).toEqual({ item: 2, col: 2 });
    expect(navigate(at, { key: 'ArrowRight' }, shape(true))).toEqual({ item: 2, col: 0 });
    expect(navigate(at, { key: 'ArrowUp' }, shape())).toEqual({ item: 1, col: 1 });
    expect(navigate({ item: 0, col: 1 }, { key: 'ArrowUp' }, shape())).toEqual({
      item: -1,
      col: 1,
    });
    expect(navigate({ item: -1, col: 1 }, { key: 'ArrowUp' }, shape())).toEqual({
      item: -1,
      col: 1,
    });
  });

  it('keep the column through items of one cell', () => {
    expect(navigate({ item: 3, col: 2 }, { key: 'ArrowRight' }, shape())).toEqual({
      item: 3,
      col: 2,
    });
    expect(navigate({ item: 3, col: 2 }, { key: 'ArrowDown' }, shape())).toEqual({
      item: 4,
      col: 2,
    });
  });

  it('Home, End, page keys and Ctrl', () => {
    const at = { item: 4, col: 2 };
    expect(navigate(at, { key: 'Home' }, shape())).toEqual({ item: 4, col: 0 });
    expect(navigate(at, { key: 'End' }, shape())).toEqual({ item: 4, col: 3 });
    expect(navigate(at, { key: 'End', ctrlKey: true }, shape())).toEqual({ item: 9, col: 3 });
    expect(navigate(at, { key: 'PageDown' }, shape())).toEqual({ item: 9, col: 2 });
    expect(navigate(at, { key: 'PageUp' }, shape())).toEqual({ item: -1, col: 2 });
    expect(navigate(at, { key: 'ArrowRight', metaKey: true }, shape())).toEqual({
      item: 4,
      col: 3,
    });
  });

  it('Tab walks cells and leaves the grid at its ends', () => {
    expect(navigate({ item: 0, col: 3 }, { key: 'Tab' }, shape())).toEqual({ item: 1, col: 0 });
    expect(navigate({ item: 1, col: 0 }, { key: 'Tab', shiftKey: true }, shape())).toEqual({
      item: 0,
      col: 3,
    });
    expect(navigate({ item: 9, col: 3 }, { key: 'Tab' }, shape())).toBe('leave');
    expect(navigate({ item: -1, col: 0 }, { key: 'Tab', shiftKey: true }, shape())).toBe('leave');
    expect(navigate({ item: 2, col: 1 }, { key: 'a' }, shape())).toBeNull();
    expect(navigate({ item: 2, col: 1 }, { key: 'ArrowLeft', altKey: true }, shape())).toBeNull();
  });

  it('typing a character starts an edit; shortcuts and IME do not', () => {
    expect(startsTyping({ key: 'a' })).toBe(true);
    expect(startsTyping({ key: 'ب' })).toBe(true);
    expect(startsTyping({ key: 'a', ctrlKey: true })).toBe(false);
    expect(startsTyping({ key: 'Enter' })).toBe(false);
    expect(startsTyping({ key: 'a', isComposing: true })).toBe(false);
  });
});

describe('view configuration', () => {
  const { host, tasksId } = seed(3);
  const database = host.database(tasksId)!;

  it('shows the title first and leaves out hidden and deleted properties', () => {
    let config: ViewConfig = withHidden(emptyConfig(), P.notes, true);
    config = withHidden(config, 'title', true);
    const trashed: DatabaseRecord = {
      ...database,
      properties: database.properties.map((p) =>
        p.id === P.site ? { ...p, trashedAt: '2026-11-01T00:00:00Z' } : p,
      ),
    };
    const shown = shownProperties(trashed, config).map((p) => p.id);
    expect(shown[0]).toBe('title');
    expect(shown).not.toContain(P.notes);
    expect(shown).not.toContain(P.site);
    expect(orderedProperties(trashed, config).map((p) => p.id)).toContain(P.notes);
  });

  it('moves and places properties in the view order', () => {
    const moved = moveProperty(emptyConfig(), database, P.amount, 1);
    expect(
      shownProperties(database, moved)
        .map((p) => p.id)
        .slice(0, 3),
    ).toEqual(['title', P.amount, P.status]);
    const placed = placeProperty(emptyConfig(), database, P.notes, P.status, 'before');
    expect(
      shownProperties(database, placed)
        .map((p) => p.id)
        .slice(0, 3),
    ).toEqual(['title', P.notes, P.status]);
  });

  it('adds sorts and filter conditions; edits the filter tree by path', () => {
    const sorted = withSort(withSort(emptyConfig(), { propertyId: P.amount, direction: 'asc' }), {
      propertyId: P.amount,
      direction: 'desc',
    });
    expect(sorted.sorts).toEqual([{ propertyId: P.amount, direction: 'desc' }]);
    const filtered = withCondition(emptyConfig(), {
      kind: 'condition',
      propertyId: P.done,
      operator: 'is',
      value: true,
    });
    let filter = filtered.filter!;
    filter = appendAt(filter, [], { kind: 'group', op: 'or', children: [] });
    filter = appendAt(filter, [1], { kind: 'condition', propertyId: P.notes, operator: 'isEmpty' });
    expect(conditionCount(filter)).toBe(2);
    filter = replaceAt(filter, [1, 0], {
      kind: 'condition',
      propertyId: P.notes,
      operator: 'isNotEmpty',
    });
    expect((filter.children[1] as typeof filter).children[0]).toMatchObject({
      operator: 'isNotEmpty',
    });
    filter = removeAt(filter, [0]);
    expect(filter.children).toHaveLength(1);
  });

  it('names a new property after its type, numbered when taken', () => {
    expect(uniqueName(database, 'Notes')).toBe('Notes 2');
    expect(uniqueName(database, 'Text')).toBe('Text');
  });
});

describe('links', () => {
  it('pass only the allowed schemes', () => {
    expect(safeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeUrl('example.com/x')).toBe('https://example.com/x');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('java\tscript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,<b>')).toBeNull();
    expect(safeUrl('not a link')).toBeNull();
    expect(safeEmail('a@b.co')).toBe('mailto:a@b.co');
    expect(safeEmail('a@b')).toBeNull();
    expect(safeEmail('javascript:a@b.co')).toBeNull();
    expect(safePhone('+20 (100) 123-4567')).toBe('tel:+201001234567');
    expect(safePhone('٠١٠٠١٢٣٤٥٦٧')).toBe('tel:01001234567');
    expect(safePhone('call me')).toBeNull();
  });
});

describe('a new row', () => {
  const { host, tasksId } = seed(1);
  const database = host.database(tasksId)!;

  it('takes its group and its filter values', () => {
    const config: ViewConfig = {
      ...emptyConfig(),
      group: { propertyId: P.status },
      filter: {
        kind: 'group',
        op: 'and',
        children: [
          { kind: 'condition', propertyId: P.priority, operator: 'is', value: 'prHigh01' },
          { kind: 'condition', propertyId: P.owner, operator: 'contains', value: { me: true } },
          { kind: 'condition', propertyId: 'title', operator: 'startsWith', value: 'Q4' },
          { kind: 'condition', propertyId: P.amount, operator: 'gt', value: 5 },
        ],
      },
    };
    expect(valuesForNewRow(database, config, 'stDone01', 'me-id')).toEqual({
      title: 'Q4',
      values: { [P.status]: 'stDone01', [P.priority]: 'prHigh01', [P.owner]: ['me-id'] },
    });
    expect(valuesForNewRow(database, config, '', null).values[P.status]).toBeUndefined();
  });

  it('takes nothing from an "or" filter', () => {
    const config: ViewConfig = {
      ...emptyConfig(),
      filter: {
        kind: 'group',
        op: 'or',
        children: [
          { kind: 'condition', propertyId: P.done, operator: 'is', value: true },
          { kind: 'condition', propertyId: P.done, operator: 'is', value: false },
        ],
      },
    };
    expect(valuesForNewRow(database, config, null, null).values).toEqual({});
  });
});

describe('table items', () => {
  const row = (id: string) => rowRecord(id, 'db', id, 'a0', {});
  const snapshot = (over: Partial<RowSnapshot>): RowSnapshot => ({
    rows: [],
    groups: null,
    total: 0,
    complete: true,
    localOnly: false,
    loading: false,
    error: null,
    ...over,
  });

  it('list rows, then "load more" while incomplete, then "New" when the person may add', () => {
    const items = buildItems(
      snapshot({ rows: [row('a'), row('b')], complete: false }),
      new Set(),
      true,
    );
    expect(items.map((i) => i.kind)).toEqual(['row', 'row', 'more', 'new']);
    expect(buildItems(snapshot({ rows: [row('a')] }), new Set(), false).map((i) => i.kind)).toEqual(
      ['row'],
    );
  });

  it('group rows under headers, collapsed groups hiding theirs', () => {
    const groups = [
      { key: 'x', count: 2, rows: [row('a'), row('b')], complete: true },
      { key: '', count: 1, rows: [row('c')], complete: false },
    ];
    const items = buildItems(snapshot({ groups, rows: [] }), new Set(['x']), true);
    expect(items.map((i) => i.kind)).toEqual(['group', 'group', 'row', 'more', 'new']);
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });
});

describe('formats', () => {
  it('write numbers by their property format', () => {
    const def = { id: 'n', name: 'n', type: 'number' as const };
    expect(formatNumber(1234.5, def, 'en')).toBe('1,234.5');
    expect(
      formatNumber(0.25, { ...def, number: { format: 'percent', decimals: null } }, 'en'),
    ).toBe('25%');
    expect(formatNumber(3.7, { ...def, number: { format: 'integer', decimals: null } }, 'en')).toBe(
      '4',
    );
    expect(
      formatNumber(
        5,
        { ...def, number: { format: 'currency', decimals: 2, currency: 'USD' } },
        'en',
      ),
    ).toBe('$5.00');
    expect(
      formatNumber(
        5,
        { ...def, number: { format: 'currency', decimals: 0, currency: '???' } },
        'en',
      ),
    ).toBe('5');
  });

  it('write calendar dates without moving them across time zones', () => {
    expect(formatDatePart('2026-03-01', 'en-US')).toBe('Mar 1, 2026');
  });
});

describe('formula suggestions', () => {
  it('offer functions for a word and properties inside prop("', () => {
    const fns = suggestionsAt('date', 4, ['Due']);
    expect(fns.map((s) => s.label)).toEqual([
      'dateAdd',
      'dateSubtract',
      'dateBetween',
      'dateStart',
      'dateEnd',
    ]);
    expect(fns[0]).toMatchObject({ insert: 'dateAdd(', from: 0 });
    const props = suggestionsAt('1 + prop("Am', 12, ['Amount', 'Title', 'Ama"zing']);
    expect(props.map((s) => s.label)).toEqual(['Amount', 'Ama"zing']);
    expect(props[0]).toMatchObject({ insert: 'Amount")', from: 10 });
    expect(props[1].insert).toBe('Ama\\"zing")');
    expect(suggestionsAt('1 + 2', 5, [])).toEqual([]);
  });
});

describe('the type change preview', () => {
  const lookups: TextLookups = {
    locale: 'en',
    person: () => undefined,
    page: () => undefined,
    file: () => undefined,
    checked: 'Checked',
    unchecked: 'Not checked',
  };
  const database: DatabaseRecord = {
    id: 'db',
    workspaceId: 'w',
    properties: [
      { id: 'title', name: 'Name', type: 'title' },
      { id: 'txtNotes', name: 'Notes', type: 'text' },
    ],
    version: 1,
    rowCount: 3,
    createdAt: '2026-11-01T00:00:00Z',
  };
  const rows: RowRecord[] = [
    rowRecord('a', 'db', 'a', 'a0', { txtNotes: '12' }),
    rowRecord('b', 'db', 'b', 'a1', { txtNotes: 'twelve' }),
    rowRecord('c', 'db', 'c', 'a2', {}),
  ];

  it('counts converted and cleared values and shows examples', () => {
    const from = database.properties[1];
    const to = shapeForType(from, 'number', { todo: 'a', inProgress: 'b', complete: 'c' });
    const preview = previewConversion(database, from, to, rows, lookups);
    expect(preview).toMatchObject({ converted: 1, cleared: 1, unchanged: 0 });
    // A value that reads the same after is not an example; a cleared one is.
    expect(preview.examples).toEqual([{ before: 'twelve', after: '' }]);
  });

  it('makes options from text for a select', () => {
    const from = database.properties[1];
    const to = shapeForType(from, 'select', { todo: 'a', inProgress: 'b', complete: 'c' });
    expect(to.options).toEqual([]);
    const preview = previewConversion(database, from, to, rows, lookups);
    expect(preview.converted).toBe(2);
    expect(cellText(from, 'x', lookups)).toBe('x');
  });
});

describe('reorder', () => {
  it('moves an id to an index of the list without it', () => {
    expect(moveIndex(['a', 'b', 'c', 'd'], 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveIndex(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
  });
});

describe('the catalogues', () => {
  const keys = (object: object, prefix = ''): string[] =>
    Object.entries(object).flatMap(([k, v]) =>
      typeof v === 'string' ? [`${prefix}${k}`] : keys(v as object, `${prefix}${k}.`),
    );
  const english = keys(en.database);
  const arabic = keys(ar.database);

  it('have the same keys, every one with text, Arabic in Arabic', () => {
    expect(arabic.sort()).toEqual(english.slice().sort());
    const flat = (object: object): string[] =>
      Object.values(object).flatMap((v) => (typeof v === 'string' ? [v] : flat(v as object)));
    expect(flat(en.database).every((s) => s.length > 0)).toBe(true);
    const arabicText = flat(ar.database).filter((s) =>
      /\p{L}/u.test(s.replace(/\{\{\w+\}\}|prop\("[^"]*"\)/g, '')),
    );
    expect(arabicText.every((s) => /[؀-ۿ]/.test(s))).toBe(true);
  });

  it('hold every key the code asks for', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')) files.push(path);
      }
    };
    walk(join(import.meta.dirname));
    const known = new Set(english);
    const missing: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\bt\(\s*'([a-zA-Z.]+)'/g))
        if (!known.has(match[1])) missing.push(`${file}: ${match[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it('are the package entry `./i18n`, which imports no package (React, i18next, the views)', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { exports: Record<string, string> };
    const entry = join(import.meta.dirname, '..', manifest.exports['./i18n']);
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const [, from] of readFileSync(file, 'utf8').matchAll(/\bfrom\s+'([^']+)'/g)) {
        expect(from.startsWith('./'), `${file} imports ${from}`).toBe(true);
        walk(join(file, '..', `${from}.ts`));
      }
    };
    walk(entry);
    expect([...seen].map((f) => f.split(/[\\/]/).pop()).sort()).toEqual([
      'ar.ts',
      'catalogue.ts',
      'catalogues.ts',
      'en.ts',
      'views-ar.ts',
      'views-en.ts',
    ]);
  });
});
