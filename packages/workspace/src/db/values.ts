// Values and cells (Phase 4 contracts, sections 1 and 2): coercion of anything written to a
// property, emptiness, and what a cell reads as for display, filters, sorts, groups and formulas.
import { DATE_POINT, coerceDate, dateText, parseDatePoint } from './dates';
import { RELATION_LIMIT, isErrorCell, jsonSource, toTarget } from './convert';
import { numberText, splitNames } from './text';
import type {
  CellValue,
  DatabaseRecord,
  DateValue,
  OptionId,
  PropertyDef,
  PropertyId,
  SelectOption,
  Value,
} from './types';
import type { RowRecord } from '../types';

export { numberText } from './text';
export { dateText } from './dates';

/** No value: absent, null, whitespace-only text, an empty list. */
export function isEmptyValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

function optionOf(options: readonly SelectOption[], raw: unknown): OptionId | undefined {
  let name: string | undefined;
  if (typeof raw === 'string') {
    if (options.some((o) => o.id === raw)) return raw;
    name = raw.trim();
  } else if (typeof raw === 'number' && Number.isFinite(raw)) name = numberText(raw);
  else if (typeof raw === 'boolean') name = String(raw);
  else {
    const date = coerceDate(raw);
    if (date) name = dateText(date);
  }
  return name === undefined ? undefined : options.find((o) => o.name === name)?.id;
}

function uniqueIds(list: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const id of list)
    if (typeof id === 'string' && id.trim() !== '' && !ids.includes(id)) ids.push(id);
  return ids;
}

/**
 * Any JSON written to a property, as its type's value; undefined is no value (the write clears
 * it). Every write is coerced, on the client and on the server, so an edit made before a type
 * change lands as the converted value.
 *
 * - select, status: an option id of the def, else the option whose name is the trimmed text (or a
 *   number's, checkbox's or date's text); from a list, the first that is one. Else nothing.
 * - multi-select: each element of a list as above; a text that is not an option id is split on
 *   commas first. Unknown ones are dropped; duplicates too.
 * - person, files, relation: a list (or one id) of non-empty strings, duplicates dropped; a
 *   relation keeps its first 1,000.
 * - formula, rollup, created and edited time and by: nothing (they store no value).
 * - the rest: the value's shape read as text, number, checkbox or date (a list as its elements
 *   joined with ", "), then written by the conversion table (convert.ts).
 */
export function coerceValue(def: PropertyDef, raw: unknown): Value | undefined {
  if (raw === null || raw === undefined) return undefined;
  const options = def.options ?? [];
  switch (def.type) {
    case 'select':
    case 'status': {
      for (const candidate of Array.isArray(raw) ? raw : [raw]) {
        const id = optionOf(options, candidate);
        if (id !== undefined) return id;
      }
      return undefined;
    }
    case 'multiSelect': {
      const parts: unknown[] = Array.isArray(raw)
        ? raw
        : typeof raw === 'string' && !options.some((o) => o.id === raw)
          ? splitNames(raw)
          : [raw];
      const ids = uniqueIds(parts.map((part) => optionOf(options, part)));
      return ids.length ? ids : undefined;
    }
    case 'person':
    case 'files':
    case 'relation': {
      const ids = uniqueIds(typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []);
      if (def.type === 'relation') ids.splice(RELATION_LIMIT);
      return ids.length ? ids : undefined;
    }
    case 'formula':
    case 'rollup':
    case 'createdTime':
    case 'createdBy':
    case 'lastEditedTime':
    case 'lastEditedBy':
      return undefined;
    default: {
      const s = jsonSource(raw);
      return s && toTarget(def, s);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Cells

const optionIndexes = new WeakMap<
  readonly SelectOption[],
  { length: number; index: Map<OptionId, number> }
>();

/** Where an option id sits in its def, or -1 when the def no longer has it (it reads as empty). */
export function optionIndex(def: PropertyDef, id: OptionId): number {
  const options = def.options;
  if (!options) return -1;
  let cached = optionIndexes.get(options);
  if (!cached || cached.length !== options.length) {
    const index = new Map<OptionId, number>();
    options.forEach((o, i) => index.has(o.id) || index.set(o.id, i));
    cached = { length: options.length, index };
    optionIndexes.set(options, cached);
  }
  return cached.index.get(id) ?? -1;
}

const instantCell = (iso: string | null | undefined): DateValue | null => {
  const start = iso ? parseDatePoint(iso) : undefined;
  return start ? { start } : null;
};

const stringList = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  const list = value.filter((v): v is string => typeof v === 'string' && v !== '');
  return list.length ? list : null;
};

/**
 * What a cell of `def` reads as on `row` (the def found already; `cellValue` finds it). Empty is
 * null; a value whose shape does not fit the type reads as empty.
 */
export function cellOf(
  def: PropertyDef,
  row: RowRecord,
  computed?: Record<PropertyId, CellValue>,
): CellValue {
  if (def.trashedAt) return null;
  const value: unknown = row.values?.[def.id];
  switch (def.type) {
    case 'title':
      return row.title ? row.title : null;
    case 'createdTime':
      return instantCell(row.createdAt);
    case 'lastEditedTime':
      return instantCell(row.updatedAt);
    case 'createdBy':
      return row.createdBy ? [row.createdBy] : null;
    case 'lastEditedBy':
      return row.updatedBy ? [row.updatedBy] : null;
    case 'formula':
    case 'rollup': {
      if (computed && Object.prototype.hasOwnProperty.call(computed, def.id))
        return computed[def.id] ?? null;
      return row.computed?.[def.id] ?? null;
    }
    case 'checkbox':
      return value === true;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return typeof value === 'string' && value !== '' ? value : null;
    case 'date': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
      const date = value as DateValue;
      if (typeof date.start !== 'string' || !DATE_POINT.test(date.start)) return null;
      if (date.end && DATE_POINT.test(date.end)) return { start: date.start, end: date.end };
      return { start: date.start };
    }
    case 'select':
    case 'status':
      return typeof value === 'string' && optionIndex(def, value) >= 0 ? value : null;
    case 'multiSelect': {
      const list = stringList(value)?.filter((id) => optionIndex(def, id) >= 0);
      return list?.length ? [...new Set(list)] : null;
    }
    case 'person':
    case 'files':
    case 'relation':
      return stringList(value);
    default:
      return null;
  }
}

/**
 * What a cell reads as: the title and created and edited time and by from the row's page fields;
 * stored values, with option ids the def no longer has as empty; formula and rollup results from
 * `computed` (this device's, where it holds the inputs) when it has the property, else the
 * server's (`row.computed`). Unknown and deleted properties read as empty. Checkboxes are always
 * true or false.
 */
export function cellValue(
  database: DatabaseRecord,
  row: RowRecord,
  propertyId: PropertyId,
  computed?: Record<PropertyId, CellValue>,
): CellValue {
  const def = database.properties.find((p) => p.id === propertyId);
  return def ? cellOf(def, row, computed) : null;
}

/** Whether a cell reads as empty: null, `''`, `[]` or an error. */
export const isEmptyCell = (cell: CellValue): boolean =>
  cell === null || cell === '' || (Array.isArray(cell) && cell.length === 0) || isErrorCell(cell);
