// The timeline view's arithmetic: its settings' defaults, rows as bars (the end property, else the
// start's own range; date-times on the person's clock; lanes), the values a move or a resize writes
// (a date stays a date, a date-time keeps its time), and the window fetched around the days shown.
import { describe, expect, it } from 'vitest';
import type { DatabaseRecord, PropertyDef } from '../../core';
import { emptyConfig } from '../../model/viewConfig';
import { rowRecord } from '../../testing/fixtures';
import {
  covers,
  defaultTimeline,
  dependentMoves,
  fetchWindow,
  firstRange,
  movedValues,
  timelineItems,
  timelineLinks,
  timelineOf,
  wallPoint,
  type TimelineRow,
} from './timeline';

const START: PropertyDef = {
  id: 'dateStrt',
  name: 'Start',
  type: 'date',
  date: { includeTime: false },
};
const END: PropertyDef = {
  id: 'dateEnd1',
  name: 'End',
  type: 'date',
  date: { includeTime: false },
};
const WHEN: PropertyDef = {
  id: 'dateWhen',
  name: 'When',
  type: 'date',
  date: { includeTime: true },
};
const STATUS: PropertyDef = {
  id: 'staStat1',
  name: 'Status',
  type: 'status',
  options: [
    { id: 'stTodo01', name: 'Not started', colour: 'gray', group: 'todo' },
    { id: 'stDone01', name: 'Done', colour: 'green', group: 'complete' },
  ],
};
let n = 0;
const row = (values: Record<string, unknown>, title = `Row ${n + 1}`) =>
  rowRecord(
    `0190a000-0000-7000-8000-${String(++n).padStart(12, '0')}`,
    'db',
    title,
    `a${n}`,
    values as never,
  );

describe('settings', () => {
  it('fills in the defaults: by weeks, the rows with no date beside', () => {
    expect(timelineOf(emptyConfig('timeline'))).toEqual({
      start: null,
      end: null,
      lane: null,
      scale: 'week',
      undated: true,
    });
    expect(
      timelineOf({
        ...emptyConfig('timeline'),
        timeline: { start: 'a', end: 'b', lane: 'c', scale: 'quarter', undated: false },
      }),
    ).toEqual({ start: 'a', end: 'b', lane: 'c', scale: 'quarter', undated: false });
    // A zoom this build does not know is the default.
    expect(
      timelineOf({ ...emptyConfig('timeline'), timeline: { start: 'a', scale: 'year' as never } })
        .scale,
    ).toBe('week');
  });

  it("starts a new timeline on the database's first date property", () => {
    const database = {
      properties: [
        { id: 'title', name: 'Name', type: 'title' },
        { ...START, trashedAt: '2026-11-01T00:00:00Z' },
        END,
      ],
    } as DatabaseRecord;
    expect(defaultTimeline(database)).toMatchObject({
      start: END.id,
      scale: 'week',
      undated: true,
    });
  });
});

describe('rows as bars', () => {
  it("ends a bar at the end property's value, else at the start's own end, and lists no undated row", () => {
    const rows = [
      row({ [START.id]: { start: '2026-11-02', end: '2026-11-04' } }),
      row({ [START.id]: { start: '2026-11-02' }, [END.id]: { start: '2026-11-09' } }),
      row({
        [START.id]: { start: '2026-11-02' },
        [END.id]: { start: '2026-11-09', end: '2026-11-12' },
      }),
      row({}),
    ];
    const own = timelineItems(rows, START, undefined, undefined, 0, true);
    expect(own.map((i) => [i.start, i.end])).toEqual([
      ['2026-11-02', '2026-11-04'],
      ['2026-11-02', null],
      ['2026-11-02', null],
    ]);
    const ended = timelineItems(rows, START, END, undefined, 0, true);
    expect(ended.map((i) => [i.start, i.end])).toEqual([
      ['2026-11-02', '2026-11-04'],
      ['2026-11-02', '2026-11-09'],
      ['2026-11-02', '2026-11-12'],
    ]);
    expect(ended[1].data!.endValue).toEqual({ start: '2026-11-09' });
    expect(ended.every((i) => i.movable && i.resizable)).toBe(true);
    expect(timelineItems(rows, START, END, undefined, 0, false).some((i) => i.movable)).toBe(false);
  });

  it("puts a date-time on the person's own clock, as the calendar does", () => {
    expect(wallPoint('2026-11-02', 180)).toBe('2026-11-02');
    expect(wallPoint('2026-11-02T22:30:00Z', 180)).toBe('2026-11-03T01:30');
    expect(wallPoint('2026-11-02T02:00:00Z', -300)).toBe('2026-11-01T21:00');
    const [item] = timelineItems(
      [row({ [WHEN.id]: { start: '2026-11-02T22:30:00Z', end: '2026-11-03T08:00:00Z' } })],
      WHEN,
      undefined,
      undefined,
      180,
      true,
    );
    expect([item.start, item.end]).toEqual(['2026-11-03T01:30', '2026-11-03T11:00']);
  });

  it('puts rows in lanes by their option, and no lane for none or a deleted option', () => {
    const items = timelineItems(
      [
        row({ [START.id]: { start: '2026-11-02' }, [STATUS.id]: 'stDone01' }),
        row({ [START.id]: { start: '2026-11-02' } }),
        row({ [START.id]: { start: '2026-11-02' }, [STATUS.id]: 'stGone01' }),
      ],
      START,
      undefined,
      STATUS,
      0,
      true,
    );
    expect(items.map((i) => i.lane)).toEqual(['stDone01', null, null]);
    expect(
      'lane' in
        timelineItems(
          [row({ [START.id]: { start: '2026-11-02' } })],
          START,
          undefined,
          undefined,
          0,
          true,
        )[0],
    ).toBe(false);
  });
});

describe('what a move writes', () => {
  const data = (value: TimelineRow['value'], endValue: TimelineRow['endValue'] = null) =>
    ({ row: row({}), value, endValue }) as TimelineRow;

  it("moves a date property's own range, keeping dates dates", () => {
    const d = data({ start: '2026-11-02', end: '2026-11-04' });
    expect(movedValues(d, START, undefined, 'move', 3)).toEqual({
      [START.id]: { start: '2026-11-05', end: '2026-11-07' },
    });
    expect(movedValues(d, START, undefined, 'start', -2)).toEqual({
      [START.id]: { start: '2026-10-31', end: '2026-11-04' },
    });
    expect(movedValues(d, START, undefined, 'end', 5)).toEqual({
      [START.id]: { start: '2026-11-02', end: '2026-11-09' },
    });
    // A one-day row grows an end; an end brought back to the start is dropped.
    expect(movedValues(data({ start: '2026-11-02' }), START, undefined, 'end', 1)).toEqual({
      [START.id]: { start: '2026-11-02', end: '2026-11-03' },
    });
    expect(movedValues(d, START, undefined, 'end', -2)).toEqual({
      [START.id]: { start: '2026-11-02' },
    });
    expect(movedValues(d, START, undefined, 'start', 2)).toEqual({
      [START.id]: { start: '2026-11-04' },
    });
  });

  it('keeps a date-time its time of day', () => {
    const d = data({ start: '2026-11-02T07:30:00Z' });
    const moved = movedValues(d, WHEN, undefined, 'move', 1)[WHEN.id];
    expect(moved.start).toMatch(/^2026-11-03T\d{2}:30:00Z$/);
    expect(new Date(moved.start).getHours()).toBe(new Date('2026-11-02T07:30:00Z').getHours());
  });

  it('moves both properties in one change, and resizes the one at each edge', () => {
    const d = data({ start: '2026-11-02' }, { start: '2026-11-09' });
    expect(movedValues(d, START, END, 'move', 7)).toEqual({
      [START.id]: { start: '2026-11-09' },
      [END.id]: { start: '2026-11-16' },
    });
    expect(movedValues(d, START, END, 'start', 1)).toEqual({ [START.id]: { start: '2026-11-03' } });
    expect(movedValues(d, START, END, 'end', 1)).toEqual({ [END.id]: { start: '2026-11-10' } });
    // An end property's own range: its end moves.
    const ranged = data({ start: '2026-11-02' }, { start: '2026-11-09', end: '2026-11-12' });
    expect(movedValues(ranged, START, END, 'end', -1)).toEqual({
      [END.id]: { start: '2026-11-09', end: '2026-11-11' },
    });
    // No end value yet: the end edge puts one there, from the start's own end.
    expect(movedValues(data({ start: '2026-11-02' }), START, END, 'end', 3)).toEqual({
      [END.id]: { start: '2026-11-05' },
    });
    // No end value: a move or a start edge moves the start's own range.
    expect(
      movedValues(data({ start: '2026-11-02', end: '2026-11-04' }), START, END, 'move', 1),
    ).toEqual({
      [START.id]: { start: '2026-11-03', end: '2026-11-05' },
    });
  });
});

describe('the window fetched', () => {
  it('holds the days shown and as many again on each side, out to whole months', () => {
    expect(fetchWindow({ from: '2026-11-14', to: '2026-12-13' })).toEqual({
      from: '2026-10-01',
      to: '2027-01-31',
    });
    expect(fetchWindow({ from: '2024-02-10', to: '2024-02-10' })).toEqual({
      from: '2024-02-01',
      to: '2024-02-29',
    });
    const window = fetchWindow({ from: '2026-11-14', to: '2026-12-13' });
    expect(covers(window, { from: '2026-11-20', to: '2026-12-20' })).toBe(true);
    expect(covers(window, { from: '2027-01-15', to: '2027-02-14' })).toBe(false);
  });

  it('starts a few days before today', () => {
    expect(firstRange('2026-11-17', 'week')).toEqual({ from: '2026-11-14', to: '2027-01-23' });
  });
});

describe('dependencies (Phase 17, Track U20)', () => {
  const BLOCKED_BY: PropertyDef = {
    id: 'relBlkBy',
    name: 'Blocked by',
    type: 'relation',
    relation: { databaseId: 'db', reversePropertyId: 'relBlkng', role: 'blockedBy' },
  };
  const BLOCKING: PropertyDef = {
    id: 'relBlkng',
    name: 'Blocking',
    type: 'relation',
    relation: { databaseId: 'db', reversePropertyId: 'relBlkBy', role: 'blocking' },
  };

  it('draws an arrow from each blocker drawn to the row it blocks, once', () => {
    const design = row({ [START.id]: { start: '2026-12-01' } }, 'Design');
    const budget = row({ [START.id]: { start: '2026-12-02' } }, 'Budget');
    const away = row({}, 'Not drawn');
    const launch = row(
      {
        [START.id]: { start: '2026-12-10' },
        [BLOCKED_BY.id]: [design.id, budget.id, design.id, away.id, 'nonsense'],
      },
      'Launch',
    );
    const items = timelineItems(
      [design, budget, away, launch],
      START,
      undefined,
      undefined,
      0,
      true,
    );
    expect(timelineLinks(items, BLOCKED_BY)).toEqual([
      { id: `${design.id}>${launch.id}`, from: design.id, to: launch.id },
      { id: `${budget.id}>${launch.id}`, from: budget.id, to: launch.id },
    ]);
    expect(timelineLinks(items, null)).toEqual([]);
  });

  it("moves the rows a blocker blocks, and theirs, each once, as a bar's move moves them", () => {
    const first = row({ [START.id]: { start: '2026-12-01' } }, 'First');
    const second = row(
      { [START.id]: { start: '2026-12-03', end: '2026-12-04' }, [END.id]: { start: '2026-12-05' } },
      'Second',
    );
    const third = row({ [WHEN.id]: { start: '2026-12-08T09:30:00Z' } }, 'Third, no start');
    const fourth = row({ [START.id]: { start: '2026-12-09' } }, 'Fourth');
    first.values[BLOCKING.id] = [second.id, third.id];
    second.values[BLOCKING.id] = [fourth.id, first.id];
    third.values[BLOCKING.id] = [fourth.id];
    const rows = new Map([first, second, third, fourth].map((r) => [r.id, r]));
    const moves = dependentMoves(first, BLOCKING, START, END, 2, (id) => rows.get(id));
    expect(moves.map((m) => [m.row.title, m.values])).toEqual([
      [
        'Second',
        {
          [START.id]: { start: '2026-12-05', end: '2026-12-06' },
          [END.id]: { start: '2026-12-07' },
        },
      ],
      ['Fourth', { [START.id]: { start: '2026-12-11' } }],
    ]);
    expect(dependentMoves(first, BLOCKING, START, END, 0, (id) => rows.get(id))).toEqual([]);
  });
});
