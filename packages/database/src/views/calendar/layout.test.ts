// The calendar's arithmetic: week starts by locale, rows' days (date-times in the person's
// offset), and moving values by days and months. The month's grid, lanes and keys are
// `CgMonthCalendar`'s.
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
import { calendarItems } from './layout';

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
