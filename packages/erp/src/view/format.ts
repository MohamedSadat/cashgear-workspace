// How an ERP value reads in the interface language. Decimals arrive as strings and stay strings:
// their digits are grouped as the language groups them, never turned into a binary float. Dates
// are calendar dates; a date-time is shown at the ERP's own clock with its offset, as sent, not
// moved into the reader's time zone. A lookup shows its item's label. Formatters are cached.
import type { ConnectorSchema, FieldSchema, WireValue } from '../contract';

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function numberFormat(locale: string): Intl.NumberFormat {
  const key = `n|${locale}`;
  let format = cache.get(key) as Intl.NumberFormat | undefined;
  if (!format)
    cache.set(key, (format = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })));
  return format;
}

function dateFormat(locale: string, time: boolean): Intl.DateTimeFormat {
  const key = `d|${locale}|${time}`;
  let format = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      ...(time ? { timeStyle: 'short' } : {}),
      timeZone: 'UTC',
    });
    cache.set(key, format);
  }
  return format;
}

/** The language's digits and decimal separator, from `Intl` itself. */
function symbols(locale: string): { digits: string[]; decimal: string } {
  const format = numberFormat(locale);
  const digits = Array.from({ length: 10 }, (_, d) => format.format(d));
  const decimal =
    new Intl.NumberFormat(locale, { minimumFractionDigits: 1 })
      .formatToParts(1.5)
      .find((part) => part.type === 'decimal')?.value ?? '.';
  return { digits, decimal };
}

/** A decimal string (`-15000.50`) grouped and written in the language's digits, every digit kept. */
export function formatDecimal(text: string, locale: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return text;
  const [, sign, whole, fraction] = m;
  const format = numberFormat(locale);
  const negative = sign === '-' && /[1-9]/.test(`${whole}${fraction ?? ''}`);
  const grouped = format.format(BigInt(whole!));
  // The sign and its place (and any direction mark) as the language writes a negative number.
  const head = format
    .formatToParts(negative ? -1n : 1n)
    .map((part) => (part.type === 'integer' ? grouped : part.value))
    .join('');
  if (!fraction) return head;
  const { digits, decimal } = symbols(locale);
  const tail = [...fraction].map((d) => digits[Number(d)]).join('');
  // The fraction goes right after the digits, before anything the language writes after them.
  const at = head.lastIndexOf(grouped) + grouped.length;
  return `${head.slice(0, at)}${decimal}${tail}${head.slice(at)}`;
}

export function formatInteger(value: number, locale: string): string {
  return numberFormat(locale).format(value);
}

/** `YYYY-MM-DD` as the language writes a date. */
export function formatDate(text: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return text;
  const date = new Date(Date.UTC(2000, Number(m[2]) - 1, Number(m[3])));
  date.setUTCFullYear(Number(m[1]));
  return dateFormat(locale, false).format(date);
}

/**
 * A date-time with its offset, at the ERP's clock: the date and time as the language writes
 * them, and the offset as sent (`UTC+02:00`, or `UTC` for `Z`).
 */
export function formatDateTime(text: string, locale: string): { when: string; offset: string } {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      text,
    );
  if (!m) return { when: text, offset: '' };
  const date = new Date(
    Date.UTC(2000, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)),
  );
  date.setUTCFullYear(Number(m[1]));
  const zone = m[7]!;
  return {
    when: dateFormat(locale, true).format(date),
    offset: zone === 'Z' ? 'UTC' : `UTC${zone}`,
  };
}

/** What a cell shows, by its field's type. Strings for every kind but a date-time. */
export type CellText =
  | { readonly kind: 'empty' }
  | { readonly kind: 'text'; readonly text: string; readonly numeric?: boolean }
  | { readonly kind: 'dateTime'; readonly when: string; readonly offset: string }
  | { readonly kind: 'boolean'; readonly value: boolean };

export function cellText(
  field: FieldSchema,
  value: WireValue | undefined,
  schema: ConnectorSchema,
  locale: string,
): CellText {
  if (value === null || value === undefined) return { kind: 'empty' };
  switch (field.type) {
    case 'decimal':
      return { kind: 'text', text: formatDecimal(String(value), locale), numeric: true };
    case 'integer':
      return typeof value === 'number'
        ? { kind: 'text', text: formatInteger(value, locale), numeric: true }
        : { kind: 'text', text: String(value), numeric: true };
    case 'boolean':
      return typeof value === 'boolean'
        ? { kind: 'boolean', value }
        : { kind: 'text', text: String(value) };
    case 'date':
      return { kind: 'text', text: formatDate(String(value), locale) };
    case 'dateTime':
      return { kind: 'dateTime', ...formatDateTime(String(value), locale) };
    case 'lookup': {
      const items = field.lookup ? schema.lookups[field.lookup] : undefined;
      const item = items?.find((i) => i.code === value);
      return { kind: 'text', text: item?.label || String(value) };
    }
    case 'text':
      return { kind: 'text', text: String(value) };
  }
}
