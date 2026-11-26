// Dates in a page (schema version 3): the `dateMention` inline atom holds a date as a database's
// date value holds its start (packages/workspace/src/db/types.ts, `DateValue`): a calendar date
// `YYYY-MM-DD`, or a UTC instant `YYYY-MM-DDTHH:mm:ssZ`, with an optional end in the same forms.
// Plain text and Markdown write the stored form, never a local one, so an export reads the same
// everywhere (the server's Markdown writer ports `dateMentionText`).

/** A date value's form: digits only (`[0-9]`, never other scripts' digits), checked as written. */
const DATE_VALUE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)?$/;

/** Whether a value is a date in a form a date mention holds. */
export function isDateValue(value: unknown): value is string {
  return typeof value === 'string' && DATE_VALUE.test(value);
}

/**
 * A date mention's text: its date as stored, then ` → ` and its end when it has a valid one.
 * Nothing when the date itself is missing or not in a date form (the end alone says nothing).
 */
export function dateMentionText(attrs: Record<string, unknown> | null | undefined): string {
  const date = attrs?.date;
  if (!isDateValue(date)) return '';
  const end = attrs?.end;
  return isDateValue(end) ? `${date} → ${end}` : date;
}

/** A calendar date (`YYYY-MM-DD`) in the device's own time zone, `days` after the given time. */
export function localDate(days = 0, now: Date = new Date()): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(day.getFullYear(), 4)}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

// Phase 19: moved from the editor, so the print view and the Word file write a date as the editor
// draws it.

const DAY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** A date value as a Date, and whether it is a calendar date (drawn in UTC) or an instant. */
function parse(value: string): { at: Date; day: boolean } | null {
  const day = DAY.exec(value);
  const at = day
    ? new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])))
    : new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  if (day) at.setUTCFullYear(Number(day[1])); // Years below 100 are not 19xx.
  return { at, day: !!day };
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(locale: string | undefined, day: boolean): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${day}`;
  let made = formats.get(key);
  if (!made) {
    try {
      made = new Intl.DateTimeFormat(
        locale,
        day
          ? { dateStyle: 'medium', timeZone: 'UTC' }
          : { dateStyle: 'medium', timeStyle: 'short' },
      );
    } catch {
      made = new Intl.DateTimeFormat(undefined, day ? { timeZone: 'UTC' } : {});
    }
    formats.set(key, made);
  }
  return made;
}

/**
 * A date mention as the interface language writes it: a calendar date as that day (whatever the
 * device's time zone), an instant in the device's time zone, a span as the language writes a
 * span. Null when the stored date is not a date.
 */
export function formatDateMention(
  attrs: Record<string, unknown>,
  locale: string | undefined,
): string | null {
  if (!isDateValue(attrs.date)) return null;
  const start = parse(attrs.date);
  if (!start) return null;
  const end = isDateValue(attrs.end) ? parse(attrs.end) : null;
  const shown = format(locale, start.day);
  if (!end) return shown.format(start.at);
  if (end.day === start.day && typeof shown.formatRange === 'function')
    return shown.formatRange(start.at, end.at);
  return `${shown.format(start.at)} – ${format(locale, end.day).format(end.at)}`;
}
