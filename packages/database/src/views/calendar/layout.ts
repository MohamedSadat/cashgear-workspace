// The calendar view's arithmetic, pure and tested on its own: the month's grid of weeks from the
// locale's first weekday, each row's days on the calendar (date-times as the person's own
// calendar dates, a span from its start to its end), the pieces of a span in each week, their
// lanes (longer pieces first, so spans line up), and how many pieces a full day cannot show.
import { calendarDate, type RowRecord } from '@cgw/workspace';
import type { DateValue, PropertyDef } from '../../core';
import { isDateValue, readCell } from '../../model/format';
import { daysInMonth, dayNumber, firstOfMonth, weekdayOf, type Month } from './dates';

/** A row placed on the calendar: its first and last day (day numbers) and its start time. */
export interface CalendarItem {
  row: RowRecord;
  value: DateValue;
  start: number;
  end: number;
  /** `HH:mm` on the person's clock when the start is a date-time, else null. */
  time: string | null;
  /** The row's place in the query's order (ties in a lane go by it). */
  order: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

function localTime(point: string, offsetMinutes: number): string | null {
  if (point.length <= 10) return null;
  const ms = Date.parse(point) + offsetMinutes * 60_000;
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** The rows with a date of `def` as calendar items, and the rows without one. */
export function calendarItems(
  rows: readonly RowRecord[],
  def: PropertyDef,
  offsetMinutes: number,
): { items: CalendarItem[]; undated: RowRecord[] } {
  const items: CalendarItem[] = [];
  const undated: RowRecord[] = [];
  const seen = new Set<string>();
  rows.forEach((row, order) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    const value = readCell(row, def);
    if (!isDateValue(value)) {
      undated.push(row);
      return;
    }
    const start = dayNumber(calendarDate(value.start, offsetMinutes));
    if (Number.isNaN(start)) {
      undated.push(row);
      return;
    }
    const last = value.end ? dayNumber(calendarDate(value.end, offsetMinutes)) : start;
    items.push({
      row,
      value,
      start,
      end: Number.isNaN(last) || last < start ? start : last,
      time: localTime(value.start, offsetMinutes),
      order,
    });
  });
  return { items, undated };
}

export interface MonthGrid {
  /** The day number of the grid's first cell (the week start on or before the 1st). */
  start: number;
  /** Rows of seven days: 4 to 6. */
  weeks: number;
  /** The 1st and the last day of the month itself. */
  first: number;
  last: number;
}

/** The month's grid, its weeks starting on `weekStart` (1 Monday to 7 Sunday). */
export function monthGrid(month: Month, weekStart: number): MonthGrid {
  const first = dayNumber(firstOfMonth(month));
  const lead = (weekdayOf(first) - weekStart + 7) % 7;
  const length = daysInMonth(month.year, month.month);
  return {
    start: first - lead,
    weeks: Math.ceil((lead + length) / 7),
    first,
    last: first + length - 1,
  };
}

/** The piece of an item inside one week. */
export interface Segment {
  item: CalendarItem;
  /** The week's row in the grid. */
  week: number;
  /** The first day's column (0 is the week's first day) and how many days it covers. */
  col: number;
  span: number;
  lane: number;
  /** The item started before this week, or goes on after it. */
  before: boolean;
  after: boolean;
}

/**
 * The pieces of every item in each week of the grid, with their lanes: pieces in order of their
 * first day, longer ones first, then the query's order; each in the first lane free from its
 * first day.
 */
export function layoutWeeks(
  items: readonly CalendarItem[],
  grid: Pick<MonthGrid, 'start' | 'weeks'>,
): Segment[][] {
  const weeks: Segment[][] = [];
  for (let w = 0; w < grid.weeks; w++) {
    const from = grid.start + w * 7;
    const to = from + 6;
    const pieces: Segment[] = [];
    for (const item of items) {
      if (item.start > to || item.end < from) continue;
      const s = Math.max(item.start, from);
      const e = Math.min(item.end, to);
      pieces.push({
        item,
        week: w,
        col: s - from,
        span: e - s + 1,
        lane: 0,
        before: item.start < from,
        after: item.end > to,
      });
    }
    pieces.sort((a, b) => a.col - b.col || b.span - a.span || a.item.order - b.item.order);
    const laneEnds: number[] = [];
    for (const piece of pieces) {
      let lane = laneEnds.findIndex((end) => end < piece.col);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = piece.col + piece.span - 1;
      piece.lane = lane;
    }
    weeks.push(pieces);
  }
  return weeks;
}

/** For each day of a week, how many of its pieces fall in lanes past the `lanes` shown. */
export function hiddenPerDay(pieces: readonly Segment[], lanes: number): number[] {
  const hidden = [0, 0, 0, 0, 0, 0, 0];
  for (const piece of pieces) {
    if (piece.lane < lanes) continue;
    for (let c = piece.col; c < piece.col + piece.span; c++) hidden[c]++;
  }
  return hidden;
}

/** The items on one day, in their lane order (the "+N more" list). */
export function itemsOn(pieces: readonly Segment[], col: number): CalendarItem[] {
  return pieces
    .filter((p) => p.col <= col && col < p.col + p.span)
    .sort((a, b) => a.lane - b.lane)
    .map((p) => p.item);
}

/** How many lanes fit in a week row of `height` pixels. */
export const lanesFor = (height: number, head: number, lane: number, more: number): number =>
  Math.max(1, Math.floor((height - head - more) / lane));

/**
 * The day a key moves the calendar's focus to: a day either way (mirrored in RTL), a week up or
 * down, the week's first or last day, a month back or on (the same day of the month, cut to its
 * length). Null when the key is not a move.
 */
export function dayMove(
  day: number,
  key: string,
  rtl: boolean,
  weekStart: number,
  shift = false,
): number | null {
  switch (key) {
    case 'ArrowLeft':
      return day + (rtl ? 1 : -1);
    case 'ArrowRight':
      return day + (rtl ? -1 : 1);
    case 'ArrowUp':
      return day - 7;
    case 'ArrowDown':
      return day + 7;
    case 'Home':
      return day - ((weekdayOf(day) - weekStart + 7) % 7);
    case 'End':
      return day + (6 - ((weekdayOf(day) - weekStart + 7) % 7));
    case 'PageUp':
    case 'PageDown': {
      const date = new Date(day * 86_400_000);
      const months = (key === 'PageUp' ? -1 : 1) * (shift ? 12 : 1);
      const y = date.getUTCFullYear();
      const m = date.getUTCMonth() + months;
      const target = new Date(Date.UTC(y, m, 1));
      const length = daysInMonth(target.getUTCFullYear(), target.getUTCMonth() + 1);
      return Math.floor(
        Date.UTC(
          target.getUTCFullYear(),
          target.getUTCMonth(),
          Math.min(date.getUTCDate(), length),
        ) / 86_400_000,
      );
    }
    default:
      return null;
  }
}
