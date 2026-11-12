// Dates in database values (Phase 4 contracts, section 1): a value's `start` and `end` are each a
// calendar date `YYYY-MM-DD` or a UTC instant `YYYY-MM-DDTHH:mm:ssZ` (whole seconds), years 1 to
// 9999. Calendar arithmetic is done here in whole days and milliseconds (proleptic Gregorian, no
// `Date`), so the C# port can do exactly the same.
import type { DateValue, RelativeDate } from './types';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Days since 1970-01-01 (H. Hinnant's `days_from_civil`). */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Year, month (1-12) and day of a day number (H. Hinnant's `civil_from_days`). */
export function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInMonth = (y: number, m: number): number =>
  m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;

const FIRST_DAY = daysFromCivil(1, 1, 1);
const LAST_DAY = daysFromCivil(9999, 12, 31);
const inRange = (day: number) => day >= FIRST_DAY && day <= LAST_DAY;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `YYYY-MM-DD` of a day number. */
export function dayText(day: number): string {
  const [y, m, d] = civilFromDays(day);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** The canonical instant of a millisecond time, whole seconds (floored); undefined out of range. */
export function instantText(ms: number): string | undefined {
  const day = Math.floor(ms / DAY_MS);
  if (!Number.isFinite(ms) || !inRange(day)) return undefined;
  const rest = Math.floor((ms - day * DAY_MS) / 1000);
  const h = Math.floor(rest / 3600);
  const min = Math.floor((rest % 3600) / 60);
  return `${dayText(day)}T${pad(h)}:${pad(min)}:${pad(rest % 60)}Z`;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*(?:([Zz])|([+-])(\d{2})(?::?(\d{2}))?)?$/;
/** A stored point: canonical forms only (what `parseDatePoint` gives). */
export const DATE_POINT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?$/;

const validDay = (y: number, m: number, d: number) =>
  y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);

/**
 * A date or instant read from text, in canonical form, or undefined. Takes `YYYY-MM-DD`, and
 * `YYYY-MM-DD` then `T` or a space, `HH:mm`, optional `:ss` and a fraction (dropped), then `Z`, an
 * offset (`+03:00`, `+0300`, `+03`) or nothing (UTC). Trimmed first; `t` and `z` in either case.
 */
export function parseDatePoint(text: string): string | undefined {
  const t = text.trim();
  const date = DATE.exec(t);
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    return validDay(y, m, d) ? t : undefined;
  }
  const time = DATE_TIME.exec(t);
  if (!time) return undefined;
  const [y, m, d, h, min] = time.slice(1, 6).map(Number);
  const s = time[6] === undefined ? 0 : Number(time[6]);
  if (!validDay(y, m, d) || h > 23 || min > 59 || s > 59) return undefined;
  let offset = 0;
  if (time[8]) {
    const oh = Number(time[9]);
    const om = time[10] === undefined ? 0 : Number(time[10]);
    if (oh > 23 || om > 59) return undefined;
    offset = (time[8] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  return instantText(
    daysFromCivil(y, m, d) * DAY_MS + ((h * 60 + min) * 60 + s) * 1000 - offset * MINUTE_MS,
  );
}

export const isDateOnly = (point: string): boolean => point.length === 10;

/** The day number of a canonical point's date part (UTC for an instant). */
const pointDay = (point: string) =>
  daysFromCivil(Number(point.slice(0, 4)), Number(point.slice(5, 7)), Number(point.slice(8, 10)));

/** Milliseconds of a canonical point; a date is its midnight `offsetMinutes` east of UTC. */
export function pointMs(point: string, offsetMinutes = 0): number {
  const day = pointDay(point) * DAY_MS;
  if (isDateOnly(point)) return day - offsetMinutes * MINUTE_MS;
  return (
    day +
    Number(point.slice(11, 13)) * HOUR_MS +
    Number(point.slice(14, 16)) * MINUTE_MS +
    Number(point.slice(17, 19)) * 1000
  );
}

/** The calendar date of a canonical point as seen `offsetMinutes` east of UTC. */
export function calendarDate(point: string, offsetMinutes: number): string {
  if (isDateOnly(point)) return point;
  return dayText(Math.floor((pointMs(point) + offsetMinutes * MINUTE_MS) / DAY_MS));
}

/** A date value read from text: a point, or `start → end` (U+2192, spaces around it optional). */
export function parseDateText(text: string): DateValue | undefined {
  const parts = text.split('→');
  if (parts.length > 2) return undefined;
  const start = parseDatePoint(parts[0]);
  if (!start) return undefined;
  if (parts.length === 1) return { start };
  const end = parseDatePoint(parts[1]);
  return end ? { start, end } : undefined;
}

/** A date value as text: its start, or `start → end`. */
export const dateText = (value: DateValue): string =>
  value.end ? `${value.start} → ${value.end}` : value.start;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A date value in canonical form from any JSON shape, or undefined: text as `parseDateText` reads
 * it, or `{ start, end? }` with each part a point; an `end` that is null, absent or `''` is no end;
 * any part that does not read makes the whole undefined. Other keys are dropped.
 */
export function coerceDate(raw: unknown): DateValue | undefined {
  if (typeof raw === 'string') return parseDateText(raw);
  if (!isObject(raw) || typeof raw.start !== 'string') return undefined;
  const start = parseDatePoint(raw.start);
  if (!start) return undefined;
  if (raw.end === undefined || raw.end === null || raw.end === '') return { start };
  if (typeof raw.end !== 'string') return undefined;
  const end = parseDatePoint(raw.end);
  return end ? { start, end } : undefined;
}

/** Days added to a canonical point (an instant keeps its time of day); undefined out of range. */
export function addDays(point: string, days: number): string | undefined {
  if (!isDateOnly(point)) return instantText(pointMs(point) + days * DAY_MS);
  const day = pointDay(point) + days;
  return inRange(day) ? dayText(day) : undefined;
}

/** Calendar months added, the day clamped to the month's last (Jan 31 + 1 month = Feb 28 or 29). */
export function addMonths(point: string, months: number): string | undefined {
  const total = Number(point.slice(0, 4)) * 12 + Number(point.slice(5, 7)) - 1 + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  if (y < 1 || y > 9999) return undefined;
  const d = Math.min(Number(point.slice(8, 10)), daysInMonth(y, m));
  const date = `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
  return isDateOnly(point) ? date : `${date}${point.slice(10)}`;
}

/** Milliseconds added; a date becomes the instant of its UTC midnight first. */
export const addMs = (point: string, ms: number): string | undefined =>
  instantText(pointMs(point) + ms);

/** 1 Monday to 7 Sunday, of a day number. */
export const weekdayOfDay = (day: number): number => ((((day + 3) % 7) + 7) % 7) + 1;

/** The day a `YYYY-MM-DD` date names. */
export const dateDay = (date: string): number => pointDay(date);

/** A relative date from the asker's `today` (`YYYY-MM-DD`); undefined when `today` is not a date. */
export function relativeDate(today: string, relative: RelativeDate): string | undefined {
  if (!DATE.test(today) || !parseDatePoint(today)) return undefined;
  switch (relative) {
    case 'today':
      return today;
    case 'tomorrow':
      return addDays(today, 1);
    case 'yesterday':
      return addDays(today, -1);
    case 'oneWeekAgo':
      return addDays(today, -7);
    case 'oneWeekFromNow':
      return addDays(today, 7);
    case 'oneMonthAgo':
      return addMonths(today, -1);
    case 'oneMonthFromNow':
      return addMonths(today, 1);
    default:
      return undefined;
  }
}

/** A `YYYY-MM-DD` date cut to its day, week (the Monday), month or year (the first day). */
export function truncateDate(date: string, by: 'day' | 'week' | 'month' | 'year'): string {
  switch (by) {
    case 'week': {
      const day = dateDay(date);
      return dayText(day - (weekdayOfDay(day) - 1));
    }
    case 'month':
      return `${date.slice(0, 7)}-01`;
    case 'year':
      return `${date.slice(0, 4)}-01-01`;
    default:
      return date;
  }
}
