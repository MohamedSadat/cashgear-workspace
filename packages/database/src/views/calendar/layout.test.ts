// The calendar's arithmetic: week starts by locale, month grids for each first weekday, rows'
// days (date-times in the person's offset), spans cut into weeks and laid in lanes, full days,
// moving values by days and months, and the keyboard between days (RTL).
import { describe, expect, it } from 'vitest';
import type { PropertyDef } from '../../core';
import { rowRecord } from '../../testing/fixtures';
import {
  addDaysToPoint,
  addMonthsToPoint,
  dateOfDay,
  dayNumber,
  shiftDays,
  shiftMonths,
  weekStartOf,
  weekdayOf,
} from './dates';
import {
  calendarItems,
  dayMove,
  hiddenPerDay,
  itemsOn,
  lanesFor,
  layoutWeeks,
  monthGrid,
} from './layout';

const due: PropertyDef = {
  id: 'dateDue1',
  name: 'Due',
  type: 'date',
  date: { includeTime: false },
};
let n = 0;
const row = (values: Record<string, unknown>) =>
  rowRecord(
    `0190a000-0000-7000-8000-${String(++n).padStart(12, '0')}`,
    'db',
    `Row ${n}`,
    `a${n}`,
    values as never,
  );

describe('days and weeks', () => {
  it('numbers days and knows their weekday', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dateOfDay(dayNumber('2026-11-13'))).toBe('2026-11-13');
    expect(weekdayOf(dayNumber('2026-11-13'))).toBe(5); // a Friday
    expect(weekdayOf(dayNumber('2026-11-14'))).toBe(6); // Saturday
    expect(weekdayOf(dayNumber('2026-11-15'))).toBe(7); // Sunday
    expect(Number.isNaN(dayNumber('2026-13'))).toBe(true);
  });

  it('starts the week on Saturday in Arabic and Sunday in English, unless Intl says otherwise', () => {
    expect(weekStartOf('ar')).toBe(6);
    expect(weekStartOf('en')).toBe(7);
    expect(weekStartOf('en-US')).toBe(7);
    // Where Intl knows the region's week, it decides.
    const gb = weekStartOf('en-GB');
    expect([1, 7]).toContain(gb);
    expect(weekStartOf('not a locale!')).toBe(7);
  });

  it('lays a month out from its week start', () => {
    // November 2026 starts on a Sunday and has 30 days.
    const sunday = monthGrid({ year: 2026, month: 11 }, 7);
    expect(dateOfDay(sunday.start)).toBe('2026-11-01');
    expect(sunday.weeks).toBe(5);
    const saturday = monthGrid({ year: 2026, month: 11 }, 6);
    expect(dateOfDay(saturday.start)).toBe('2026-10-31');
    expect(saturday.weeks).toBe(5);
    const monday = monthGrid({ year: 2026, month: 11 }, 1);
    expect(dateOfDay(monday.start)).toBe('2026-10-26');
    expect(monday.weeks).toBe(6);
    expect(dateOfDay(monday.first)).toBe('2026-11-01');
    expect(dateOfDay(monday.last)).toBe('2026-11-30');
    // February 2026 starts on a Sunday and fits four weeks exactly.
    expect(monthGrid({ year: 2026, month: 2 }, 7).weeks).toBe(4);
    expect(monthGrid({ year: 2026, month: 2 }, 6).weeks).toBe(5);
  });
});

describe('rows on the calendar', () => {
  it("places rows by their dates, date-times on the person's own day, and lists rows with no date", () => {
    const a = row({ dateDue1: { start: '2026-11-03' } });
    const b = row({ dateDue1: { start: '2026-11-03T22:30:00Z' } });
    const c = row({});
    const d = row({ dateDue1: { start: '2026-11-10', end: '2026-11-08' } });
    const east = calendarItems([a, b, c, d], due, 180);
    expect(east.items.map((i) => dateOfDay(i.start))).toEqual([
      '2026-11-03',
      '2026-11-04',
      '2026-11-10',
    ]);
    expect(east.items[1].time).toBe('01:30');
    expect(east.items[2].end).toBe(east.items[2].start);
    expect(east.undated).toEqual([c]);
    const west = calendarItems([b], due, -300);
    expect(dateOfDay(west.items[0].start)).toBe('2026-11-03');
    expect(west.items[0].time).toBe('17:30');
    // A row shown in several groups is placed once.
    expect(calendarItems([a, a], due, 0).items).toHaveLength(1);
  });

  it('cuts spans into weeks and lays them in lanes, longer ones first', () => {
    const grid = monthGrid({ year: 2026, month: 11 }, 7); // weeks from Sunday 1 November
    const long = row({ dateDue1: { start: '2026-11-05', end: '2026-11-10' } });
    const one = row({ dateDue1: { start: '2026-11-06' } });
    const two = row({ dateDue1: { start: '2026-11-06' } });
    const later = row({ dateDue1: { start: '2026-11-07' } });
    const { items } = calendarItems([one, two, later, long], due, 0);
    const weeks = layoutWeeks(items, grid);
    const first = weeks[0];
    const piece = (r: typeof long) => first.find((p) => p.item.row === r)!;
    expect(piece(long)).toMatchObject({ col: 4, span: 3, lane: 0, before: false, after: true });
    expect(piece(one)).toMatchObject({ col: 5, span: 1, lane: 1 });
    expect(piece(two)).toMatchObject({ col: 5, span: 1, lane: 2 });
    expect(piece(later)).toMatchObject({ col: 6, span: 1, lane: 1 });
    const second = weeks[1].find((p) => p.item.row === long)!;
    expect(second).toMatchObject({ col: 0, span: 3, lane: 0, before: true, after: false });
    expect(hiddenPerDay(first, 2)).toEqual([0, 0, 0, 0, 0, 1, 0]);
    expect(itemsOn(first, 5).map((i) => i.row)).toEqual([long, one, two]);
    expect(lanesFor(124, 26, 22, 20)).toBe(3);
    expect(lanesFor(40, 26, 22, 20)).toBe(1);
  });

  it('lays out the same rows the same way with a Saturday week start (RTL is the same grid, mirrored)', () => {
    const grid = monthGrid({ year: 2026, month: 11 }, 6); // weeks from Saturday 31 October
    const span = row({ dateDue1: { start: '2026-11-06', end: '2026-11-08' } });
    const weeks = layoutWeeks(calendarItems([span], due, 0).items, grid);
    expect(weeks[0][0]).toMatchObject({ col: 6, span: 1, after: true });
    expect(weeks[1][0]).toMatchObject({ col: 0, span: 2, before: true });
  });
});

describe('moving dates', () => {
  it('moves a date or a span by days, keeping its length', () => {
    expect(shiftDays({ start: '2026-11-30' }, 2)).toEqual({ start: '2026-12-02' });
    expect(shiftDays({ start: '2026-11-03', end: '2026-11-05' }, -3)).toEqual({
      start: '2026-10-31',
      end: '2026-11-02',
    });
    expect(addDaysToPoint('2026-11-03T10:15:00Z', 1)).toMatch(/^2026-11-04T\d{2}:15:00Z$/);
    const kept = shiftDays({ start: '2026-11-03T10:15:00Z', end: '2026-11-03T11:45:00Z' }, 7);
    expect(Date.parse(kept.end!) - Date.parse(kept.start)).toBe(90 * 60_000);
  });

  it('moves by months, the day cut to the month', () => {
    expect(addMonthsToPoint('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsToPoint('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsToPoint('2026-03-15', -3)).toBe('2025-12-15');
    expect(shiftMonths({ start: '2026-01-10', end: '2026-01-31' }, 1)).toEqual({
      start: '2026-02-10',
      end: '2026-02-28',
    });
  });
});

describe('the keyboard on a calendar', () => {
  const day = dayNumber('2026-11-13'); // a Friday

  it('moves by days (mirrored in RTL), weeks, and to the week ends by the week start', () => {
    expect(dayMove(day, 'ArrowRight', false, 7)).toBe(day + 1);
    expect(dayMove(day, 'ArrowRight', true, 6)).toBe(day - 1);
    expect(dayMove(day, 'ArrowLeft', true, 6)).toBe(day + 1);
    expect(dayMove(day, 'ArrowDown', false, 7)).toBe(day + 7);
    expect(dateOfDay(dayMove(day, 'Home', false, 7)!)).toBe('2026-11-08');
    expect(dateOfDay(dayMove(day, 'End', false, 7)!)).toBe('2026-11-14');
    expect(dateOfDay(dayMove(day, 'Home', true, 6)!)).toBe('2026-11-07');
    expect(dateOfDay(dayMove(day, 'End', true, 6)!)).toBe('2026-11-13');
    expect(dayMove(day, 'x', false, 7)).toBeNull();
  });

  it('turns months with PageUp and PageDown, years with Shift', () => {
    expect(dateOfDay(dayMove(dayNumber('2026-01-31'), 'PageDown', false, 7)!)).toBe('2026-02-28');
    expect(dateOfDay(dayMove(day, 'PageUp', false, 7)!)).toBe('2026-10-13');
    expect(dateOfDay(dayMove(day, 'PageDown', false, 7, true)!)).toBe('2027-11-13');
  });
});
