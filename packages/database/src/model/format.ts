// How values read in the interface language: numbers by their property's format, dates as
// calendar dates (date-times in the person's own time zone), options by name, people by name.
// `Intl` formatters are cached: a table draws thousands of cells while it scrolls.
import type { RowRecord } from '@cgw/workspace';
import type { CellValue, DateValue, PropertyDef, SelectOption, StatusOption, Value } from '../core';

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    try {
      format = new Intl.NumberFormat(locale, options);
    } catch {
      // An unknown currency code: the number without it.
      format = new Intl.NumberFormat(locale, { maximumFractionDigits: 20 });
    }
    numberFormats.set(key, format);
  }
  return format;
}

function dateFormat(locale: string, time: boolean, utc: boolean): Intl.DateTimeFormat {
  const key = `${locale}|${time}|${utc}`;
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      ...(time ? { timeStyle: 'short' } : {}),
      ...(utc ? { timeZone: 'UTC' } : {}),
    });
    dateFormats.set(key, format);
  }
  return format;
}

/** A number as its property shows it (format, decimals, currency). */
export function formatNumber(value: number, def: PropertyDef | undefined, locale: string): string {
  if (!Number.isFinite(value)) return String(value);
  const config = def?.number;
  const decimals = config?.decimals ?? null;
  const digits =
    decimals === null ? {} : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  switch (config?.format) {
    case 'integer':
      return numberFormat(locale, { maximumFractionDigits: 0 }).format(value);
    case 'percent':
      // The value is the fraction: 0.25 is 25%.
      return numberFormat(locale, {
        style: 'percent',
        ...(decimals === null ? { maximumFractionDigits: 2 } : digits),
      }).format(value);
    case 'currency':
      return numberFormat(locale, {
        style: 'currency',
        currency: (config.currency || 'USD').toUpperCase(),
        ...digits,
      }).format(value);
    default:
      return numberFormat(
        locale,
        decimals === null ? { maximumFractionDigits: 10 } : digits,
      ).format(value);
  }
}

/** True when a date string is a UTC instant (`YYYY-MM-DDTHH:mm:ssZ`), not a calendar date. */
export const isInstant = (text: string) => text.length > 10;

/** One end of a date value: a calendar date as itself, an instant in the local time zone. */
export function formatDatePart(text: string, locale: string): string {
  if (isInstant(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? text : dateFormat(locale, true, false).format(date);
  }
  const [y, m, d] = text.split('-').map(Number);
  if (!y || !m || !d) return text;
  return dateFormat(locale, false, true).format(new Date(Date.UTC(y, m - 1, d)));
}

/** A date or a span, with the range glyph between its ends. */
export function formatDate(value: DateValue, locale: string, rangeJoin = ' → '): string {
  const start = formatDatePart(value.start, locale);
  return value.end ? `${start}${rangeJoin}${formatDatePart(value.end, locale)}` : start;
}

export const isDateValue = (value: unknown): value is DateValue =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as DateValue).start === 'string';

export const isCellError = (value: unknown): value is { error: string } =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { error?: unknown }).error === 'string';

/** A property's options, or none. */
export const optionsOf = (def: PropertyDef): (SelectOption | StatusOption)[] => def.options ?? [];

export function optionById(def: PropertyDef, id: unknown): SelectOption | StatusOption | undefined {
  if (typeof id !== 'string') return undefined;
  return def.options?.find((o) => o.id === id);
}

/**
 * What a row holds for a property, as the cell draws it: stored values, the title, the page's
 * created and edited time and by, and formula and rollup results (`computed`).
 */
export function readCell(row: RowRecord, def: PropertyDef): CellValue | Value | undefined {
  switch (def.type) {
    case 'title':
      return row.title || undefined;
    case 'createdTime':
      return row.createdAt ? { start: row.createdAt } : undefined;
    case 'lastEditedTime':
      return row.updatedAt ? { start: row.updatedAt } : undefined;
    case 'createdBy':
      return row.createdBy ? [row.createdBy] : undefined;
    case 'lastEditedBy':
      return row.updatedBy ? [row.updatedBy] : undefined;
    case 'formula':
    case 'rollup':
      return row.computed?.[def.id] ?? null;
    default:
      return row.values[def.id];
  }
}

/** Lookups a cell's text needs beyond the row: people's names, related rows' titles, files. */
export interface TextLookups {
  locale: string;
  person(id: string): string | undefined;
  page(id: string): string | undefined;
  file(id: string): string | undefined;
  checked: string;
  unchecked: string;
}

/** A cell as plain text: for previews, accessible names and examples. */
export function cellText(
  def: PropertyDef,
  value: CellValue | Value | undefined,
  lookups: TextLookups,
): string {
  if (value === undefined || value === null) return '';
  switch (def.type) {
    case 'number':
      return typeof value === 'number' ? formatNumber(value, def, lookups.locale) : String(value);
    case 'checkbox':
      return value === true ? lookups.checked : lookups.unchecked;
    case 'select':
    case 'status':
      return optionById(def, value)?.name ?? '';
    case 'multiSelect':
      return Array.isArray(value)
        ? value
            .map((id) => optionById(def, id)?.name)
            .filter(Boolean)
            .join(', ')
        : '';
    case 'person':
    case 'createdBy':
    case 'lastEditedBy':
      return Array.isArray(value) ? value.map((id) => lookups.person(id) ?? id).join(', ') : '';
    case 'relation':
      return Array.isArray(value) ? value.map((id) => lookups.page(id) ?? '').join(', ') : '';
    case 'files':
      return Array.isArray(value) ? value.map((id) => lookups.file(id) ?? '').join(', ') : '';
    default:
      return valueText(value, lookups);
  }
}

/** Any value read on its own (formula and rollup results, stored text). */
export function valueText(value: CellValue | Value, lookups: TextLookups): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return formatNumber(value, undefined, lookups.locale);
  if (typeof value === 'boolean') return value ? lookups.checked : lookups.unchecked;
  if (Array.isArray(value)) return value.join(', ');
  if (isDateValue(value)) return formatDate(value, lookups.locale);
  if (isCellError(value)) return '';
  return '';
}
