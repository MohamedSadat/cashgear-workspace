// Recurrence (Phase 17, M17.2; DATA_MODEL.md, Automations): the days a repeating row falls on, from
// the series' first day, by a rule of the shape the library's recurrence fields edit (Track U21's
// `CgRecurrenceRule`). Days only: the worker turns a day into its instant at a time of day in the
// workspace's zone. The C# port is server/src/Cgw.Core/Automations/Recurrence.cs, held to this by
// packages/workspace/vectors/db-recurrence-vectors.json (the 31st, 29 February, a weekday's last
// week, a count and an end). No React, no DOM.

export type Weekday =
  'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

export const WEEKDAYS: readonly Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export type WeekOfMonth = 'none' | 'first' | 'second' | 'third' | 'fourth' | 'last';

export interface RecurrenceRule {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  /** Every how many days, weeks, months or years; 1 to 999. Default 1. */
  interval?: number;
  /** Weekly: the days of each week. Daily: only these days. Monthly and yearly on a week: that week's days. */
  weekDays?: Weekday[];
  /** Monthly and yearly on a day: 1 to 31, a shorter month's last day. Default: the first day's. */
  dayOfMonth?: number;
  /** Yearly: 1 to 12. Default: the first day's month. */
  month?: number;
  weekOfMonth?: WeekOfMonth;
  /** Default `noEndDate`. */
  range?: 'noEndDate' | 'occurrenceCount' | 'endByDate';
  /** With `occurrenceCount`: 1 to 10,000, the first day counted. */
  occurrenceCount?: number;
  /** With `endByDate`: the last day one may fall on, inclusive. */
  endDate?: string;
}

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'yearly']);
const WEEKS = new Set<string>(['none', 'first', 'second', 'third', 'fourth', 'last']);
const RANGES = new Set(['noEndDate', 'occurrenceCount', 'endByDate']);
/** Periods walked at most before a rule is taken as reaching no day. */
const PERIODS = 100_000;

const MS = 86_400_000;
/** A UTC day's instant; `setUTCFullYear`, as `Date.UTC` reads years 0 to 99 as 1900 to 1999. */
const utc = (year: number, month0: number, day: number) => {
  const d = new Date(0);
  d.setUTCFullYear(year, month0, day);
  return d.getTime();
};
const civil = (day: string) => utc(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => dayOf(civil(day) + n * MS);
const weekdayOf = (day: string) => new Date(civil(day)).getUTCDay();

/** A `YYYY-MM-DD` day that exists (no 31 April), in the years 1 to 9999 (as C#'s `DateOnly`). */
export const isDay = (value: unknown): value is string =>
  typeof value === 'string' &&
  DAY.test(value) &&
  !value.startsWith('0000') &&
  dayOf(civil(value)) === value;

const whole = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** A rule as it is kept, or null when it is not one (the rule's check says which part). */
export function readRecurrence(value: unknown): RecurrenceRule | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!FREQUENCIES.has(v.frequency as string)) return null;
  const out: RecurrenceRule = { frequency: v.frequency as RecurrenceRule['frequency'] };
  if (v.interval !== undefined) {
    if (!whole(v.interval, 1, 999)) return null;
    out.interval = v.interval;
  }
  if (v.weekDays !== undefined) {
    if (!Array.isArray(v.weekDays) || !v.weekDays.every((d) => WEEKDAYS.includes(d as Weekday)))
      return null;
    out.weekDays = WEEKDAYS.filter((d) => (v.weekDays as string[]).includes(d));
  }
  if (v.dayOfMonth !== undefined) {
    if (!whole(v.dayOfMonth, 1, 31)) return null;
    out.dayOfMonth = v.dayOfMonth;
  }
  if (v.month !== undefined) {
    if (!whole(v.month, 1, 12)) return null;
    out.month = v.month;
  }
  if (v.weekOfMonth !== undefined) {
    if (!WEEKS.has(v.weekOfMonth as string)) return null;
    out.weekOfMonth = v.weekOfMonth as WeekOfMonth;
  }
  if (v.range !== undefined) {
    if (!RANGES.has(v.range as string)) return null;
    out.range = v.range as RecurrenceRule['range'];
  }
  if (out.range === 'occurrenceCount') {
    if (!whole(v.occurrenceCount, 1, 10_000)) return null;
    out.occurrenceCount = v.occurrenceCount;
  }
  if (out.range === 'endByDate') {
    if (!isDay(v.endDate)) return null;
    out.endDate = v.endDate;
  }
  return out;
}

function monthDays(year: number, month: number, first: string, rule: RecurrenceRule): string[] {
  const start = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const last = new Date(utc(year, month, 0)).getUTCDate();
  const week = rule.weekOfMonth ?? 'none';
  if (week === 'none')
    return [addDays(start, Math.min(rule.dayOfMonth ?? +first.slice(8, 10), last) - 1)];
  const days = rule.weekDays?.length
    ? rule.weekDays.map((d) => WEEKDAYS.indexOf(d))
    : [weekdayOf(first)];
  const lastDay = addDays(start, last - 1);
  return days
    .map((day) =>
      week === 'last'
        ? addDays(lastDay, -((weekdayOf(lastDay) - day + 7) % 7))
        : addDays(
            start,
            ((day - weekdayOf(start) + 7) % 7) +
              ['first', 'second', 'third', 'fourth'].indexOf(week) * 7,
          ),
    )
    .sort();
}

/** The days the rule falls on from `first` (the first among them when the rule falls on it), in order. */
function* days(rule: RecurrenceRule, first: string): Generator<string> {
  const interval = rule.interval ?? 1;
  const own = weekdayOf(first);
  const weekDays = rule.weekDays?.length ? rule.weekDays.map((d) => WEEKDAYS.indexOf(d)) : [own];
  let count = 0;
  for (let period = 0; period < PERIODS; period++) {
    let candidates: string[];
    if (rule.frequency === 'daily') {
      const day = addDays(first, period * interval);
      candidates = !rule.weekDays?.length || weekDays.includes(weekdayOf(day)) ? [day] : [];
    } else if (rule.frequency === 'weekly')
      candidates = [...weekDays]
        .sort()
        .map((d) => addDays(first, -own + period * interval * 7 + d));
    else {
      const index =
        +first.slice(0, 4) * 12 +
        +first.slice(5, 7) -
        1 +
        (rule.frequency === 'monthly' ? period * interval : period * interval * 12);
      const year = Math.floor(index / 12);
      if (year > 9999) return;
      const month =
        rule.frequency === 'yearly' ? (rule.month ?? +first.slice(5, 7)) : (index % 12) + 1;
      candidates = monthDays(year, month, first, rule);
    }
    for (const day of candidates) {
      // Past 9999 `toISOString` writes `+010002-…` (cut to `+010002-08`), which sorts before
      // every day: stop there.
      if (day.startsWith('+')) return;
      if (day < first) continue;
      if (rule.range === 'endByDate' && day > rule.endDate!) return;
      if (rule.range === 'occurrenceCount' && count >= rule.occurrenceCount!) return;
      count++;
      yield day;
    }
  }
}

/** The first day the rule falls on after `after` (exclusive), or null when the series has ended. */
export function nextOccurrence(rule: RecurrenceRule, first: string, after: string): string | null {
  for (const day of days(rule, first)) if (day > after) return day;
  return null;
}

/** The days from `from` to `to` (both inclusive), at most `limit`. */
export function occurrencesBetween(
  rule: RecurrenceRule,
  first: string,
  from: string,
  to: string,
  limit = 1000,
): string[] {
  const out: string[] = [];
  for (const day of days(rule, first)) {
    if (day > to || out.length >= limit) break;
    if (day >= from) out.push(day);
  }
  return out;
}
