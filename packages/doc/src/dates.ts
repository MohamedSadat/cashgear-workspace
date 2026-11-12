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
