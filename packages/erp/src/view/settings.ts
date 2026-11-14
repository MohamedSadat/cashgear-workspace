// An ERP view block's settings read from its attributes, and the query they make against a
// connector's schema. Attributes are JSON text written by any build and any person, so each is
// read leniently: what does not parse is ignored, never thrown. A setting may name a field the
// reader's ERP account cannot see (two people see different fields, INTEGRATIONS.md): it is left
// out of the reader's query, and kept when the reader changes something else.
import {
  LIMITS,
  isDecimal,
  isIsoDate,
  isIsoDateTime,
  type ConnectorSchema,
  type FieldSchema,
  type QueryFilter,
  type QueryRequest,
  type SortKey,
  type WireValue,
} from '../contract';
import type { ErpBlockAttrs } from './host';

/** 50 rows a page unless the block says otherwise (decisions, 2026-11-14). */
export const DEFAULT_PAGE_SIZE = 50;
/** What the page-size picker offers, cut at the connector's `maxPageSize`. */
export const PAGE_SIZES = [10, 25, 50, 100, 200, 500, 1000] as const;

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface ViewSettings {
  /** Null: every field the reader may see. */
  readonly fields: readonly string[] | null;
  readonly search: string;
  readonly equals: Readonly<Record<string, WireValue>>;
  readonly sort: readonly SortKey[];
  /** Null: the default. */
  readonly pageSize: number | null;
}

function json(text: string | null): unknown {
  if (text === null || text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const isWire = (value: unknown): value is WireValue =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

export function readSettings(attrs: ErpBlockAttrs): ViewSettings {
  const fieldsValue = json(attrs.fields);
  const fields = Array.isArray(fieldsValue)
    ? [...new Set(fieldsValue.filter((f): f is string => typeof f === 'string' && NAME.test(f)))]
    : null;

  const filterValue = json(attrs.filter);
  let search = '';
  const equals: Record<string, WireValue> = {};
  if (typeof filterValue === 'object' && filterValue !== null && !Array.isArray(filterValue)) {
    const filter = filterValue as { search?: unknown; equals?: unknown };
    if (typeof filter.search === 'string') search = filter.search;
    if (typeof filter.equals === 'object' && filter.equals !== null) {
      for (const [key, value] of Object.entries(filter.equals as Record<string, unknown>)) {
        if (NAME.test(key) && isWire(value)) equals[key] = value;
      }
    }
  }

  const sortValue = json(attrs.sort);
  const sort: SortKey[] = [];
  if (Array.isArray(sortValue)) {
    for (const item of sortValue) {
      if (typeof item !== 'object' || item === null) continue;
      const { field, direction } = item as { field?: unknown; direction?: unknown };
      if (typeof field !== 'string' || !NAME.test(field)) continue;
      if (direction !== 'asc' && direction !== 'desc') continue;
      if (sort.some((s) => s.field === field)) continue;
      sort.push({ field, direction });
      if (sort.length === LIMITS.maxSort) break;
    }
  }

  const pageSize =
    typeof attrs.pageSize === 'number' && Number.isSafeInteger(attrs.pageSize) && attrs.pageSize > 0
      ? attrs.pageSize
      : null;

  return {
    fields: fields && fields.length ? fields : null,
    search,
    equals,
    sort,
    pageSize,
  };
}

/** The `filter` attribute for a search and conditions: null when there is neither. */
export function filterText(
  search: string,
  equals: Readonly<Record<string, WireValue>>,
): string | null {
  const text = search.trim();
  const hasEquals = Object.keys(equals).length > 0;
  if (!text && !hasEquals) return null;
  const filter: QueryFilter = {
    ...(text ? { search: text } : {}),
    ...(hasEquals ? { equals } : {}),
  };
  return JSON.stringify(filter);
}

export const fieldsText = (fields: readonly string[] | null): string | null =>
  fields && fields.length ? JSON.stringify(fields) : null;

export const sortText = (sort: readonly SortKey[]): string | null =>
  sort.length ? JSON.stringify(sort) : null;

/** What the reader's query is, or why there is none. */
export type QueryPlan =
  | {
      readonly kind: 'query';
      /** Without `cursor`: the key of the query, which a cursor belongs to. */
      readonly request: Omit<QueryRequest, 'cursor'>;
      /** The fields shown, in order. */
      readonly columns: readonly FieldSchema[];
      /** Fields, sorts and conditions of the settings this reader cannot see, left out. */
      readonly hidden: number;
    }
  | { readonly kind: 'noField' }
  | { readonly kind: 'filterDenied' }
  | { readonly kind: 'filterNotFilterable' };

export function planQuery(schema: ConnectorSchema, settings: ViewSettings): QueryPlan {
  const byName = new Map(schema.fields.map((f) => [f.name, f]));
  let hidden = 0;

  for (const name of Object.keys(settings.equals)) {
    const field = byName.get(name);
    // Dropping the condition would show records the view does not mean to show.
    if (!field) return { kind: 'filterDenied' };
    if (!field.filterable) return { kind: 'filterNotFilterable' };
  }

  let columns: FieldSchema[];
  let fields: string[] | undefined;
  if (settings.fields) {
    columns = [];
    for (const name of settings.fields) {
      const field = byName.get(name);
      if (field) columns.push(field);
      else hidden++;
    }
    if (!columns.length) return { kind: 'noField' };
    fields = columns.map((f) => f.name);
  } else {
    columns = [...schema.fields];
  }

  const sort: SortKey[] = [];
  for (const key of settings.sort) {
    const field = byName.get(key.field);
    if (field?.sortable) sort.push(key);
    else hidden++;
  }

  const search = settings.search.trim();
  const filter: QueryFilter = {
    ...(search ? { search } : {}),
    ...(Object.keys(settings.equals).length ? { equals: settings.equals } : {}),
  };
  const pageSize = Math.max(
    1,
    Math.min(settings.pageSize ?? DEFAULT_PAGE_SIZE, schema.maxPageSize),
  );
  return {
    kind: 'query',
    request: {
      filter,
      ...(fields ? { fields } : {}),
      ...(sort.length ? { sort } : {}),
      pageSize,
    },
    columns,
    hidden,
  };
}

/** A field's label in a language. */
export const labelOf = (field: { label: { en: string; ar: string } }, language: 'en' | 'ar') =>
  field.label[language] || field.label.en;

/**
 * What a typed value means for a field, for a condition: the wire value, or undefined when the
 * text is not one (incomplete or wrong).
 */
export function parseConditionValue(field: FieldSchema, raw: string): WireValue | undefined {
  switch (field.type) {
    case 'text':
      return raw === '' ? undefined : raw;
    case 'lookup':
      return raw === '' ? null : raw;
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : raw === '' ? null : undefined;
    case 'integer': {
      if (!/^-?\d+$/.test(raw.trim())) return undefined;
      const n = Number(raw.trim());
      return Number.isSafeInteger(n) ? n : undefined;
    }
    case 'decimal':
      return isDecimal(raw.trim(), field.scale ?? 0) ? raw.trim() : undefined;
    case 'date':
      return isIsoDate(raw) ? raw : undefined;
    case 'dateTime':
      return isIsoDateTime(raw.trim()) ? raw.trim() : undefined;
  }
}

/** A condition's wire value as the text its control shows. */
export function conditionText(value: WireValue): string {
  if (value === null) return '';
  return String(value);
}
