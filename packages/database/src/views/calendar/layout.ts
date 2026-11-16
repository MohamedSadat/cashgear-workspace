// The calendar view's arithmetic, pure and tested on its own: each row's days on the calendar
// (date-times as the person's own calendar dates, a span from its start to its end), and the rows
// with no date. `CgMonthCalendar` lays the month out (weeks, lanes, "+N more") and its keys.
import { calendarDate, type RowRecord } from '@cgw/workspace';
import type { DateValue, PropertyDef } from '../../core';
import { isDateValue, readCell } from '../../model/format';
import { dayNumber } from './dates';

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
