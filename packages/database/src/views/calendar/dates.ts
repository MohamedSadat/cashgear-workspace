// Calendar arithmetic for the calendar view and the board's date columns: day numbers (days since
// 1970-01-01) of calendar dates, weekdays, months, the week's first day by locale, and moving a
// stored date value by whole days or months. A calendar date (`YYYY-MM-DD`) moves by days; a
// date-time (a UTC instant) moves in the person's own time zone, so it keeps its time of day on
// the clock even across a change to summer time. Pure: no React, no DOM.
import type { DateValue } from '../../core';

const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** The day number of a `YYYY-MM-DD` date (NaN when it is not one). */
export function dayNumber(date: string): number {
  const m = DATE.exec(date);
  if (!m) return Number.NaN;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

/** The `YYYY-MM-DD` date of a day number. */
export function dateOfDay(day: number): string {
  const d = new Date(day * DAY_MS);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 1 Monday to 7 Sunday, of a day number (1970-01-01 was a Thursday). */
export const weekdayOf = (day: number): number => ((((day + 3) % 7) + 7) % 7) + 1;

export const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** A month as year and month (1-12), and moving it. */
export interface Month {
  year: number;
  month: number;
}

export const monthOf = (date: string): Month => ({
  year: Number(date.slice(0, 4)),
  month: Number(date.slice(5, 7)),
});

export function addMonthsTo(month: Month, n: number): Month {
  const total = month.year * 12 + (month.month - 1) + n;
  return { year: Math.floor(total / 12), month: (((total % 12) + 12) % 12) + 1 };
}

export const firstOfMonth = (month: Month): string =>
  `${pad(month.year, 4)}-${pad(month.month)}-01`;

/**
 * The first day of the week, 1 Monday to 7 Sunday: what `Intl` says for the locale where it says
 * (`Intl.Locale#getWeekInfo`, or `weekInfo` in older engines), else Saturday in Arabic and Sunday
 * otherwise.
 */
export function weekStartOf(locale: string): number {
  try {
    const intl = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay?: number };
      weekInfo?: { firstDay?: number };
    };
    const info = intl.getWeekInfo?.() ?? intl.weekInfo;
    const first = info?.firstDay;
    if (typeof first === 'number' && first >= 1 && first <= 7) return first;
  } catch {
    // An engine without week data, or a locale it cannot read: the defaults below.
  }
  return locale.toLowerCase().startsWith('ar') ? 6 : 7;
}

// ---- Moving a stored value ------------------------------------------------------------------

const isDateOnly = (point: string) => point.length === 10;

/** A UTC instant's canonical text (whole seconds). */
const instantText = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/** A point (date or instant) moved by whole days; an instant keeps its local time of day. */
export function addDaysToPoint(point: string, days: number): string {
  if (isDateOnly(point)) return dateOfDay(dayNumber(point) + days);
  const d = new Date(point);
  d.setDate(d.getDate() + days);
  return instantText(d.getTime());
}

/** A point moved by whole months, the day cut to the month's last (Jan 31 + 1 month = Feb 28). */
export function addMonthsToPoint(point: string, months: number): string {
  if (isDateOnly(point)) {
    const target = addMonthsTo(monthOf(point), months);
    const day = Math.min(Number(point.slice(8, 10)), daysInMonth(target.year, target.month));
    return `${firstOfMonth(target).slice(0, 8)}${pad(day)}`;
  }
  const d = new Date(point);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth() + 1)));
  return instantText(d.getTime());
}

/** A date value moved by whole days: its start and end, so it keeps its length and times. */
export function shiftDays(value: DateValue, days: number): DateValue {
  if (days === 0) return value;
  const start = addDaysToPoint(value.start, days);
  return value.end ? { start, end: addDaysToPoint(value.end, days) } : { start };
}

export function shiftMonths(value: DateValue, months: number): DateValue {
  if (months === 0) return value;
  const start = addMonthsToPoint(value.start, months);
  return value.end ? { start, end: addMonthsToPoint(value.end, months) } : { start };
}

/** Whole months from one month to another. */
export const monthsBetween = (from: string, to: string): number =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
  (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));

/** The local `YYYY-MM-DD` of a time (the device's calendar date). */
export function localDate(at: Date = new Date()): string {
  return `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
