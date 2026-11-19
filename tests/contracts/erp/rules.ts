// The suite's own reading of how the ERP searches, matches and orders (INTEGRATIONS.md, "Queries
// paged in the ERP's database (Phase 12, Track E10)": 0.10.0's answers). Written apart from the
// mock's (tests/mocks/erp/rules.mjs), so the suite checks the mock as it checks UnifiedAPI: every
// page a server answers must be exactly what these rules make of the same records.

import type { FieldType, SortKey, WireValue } from '../../../packages/erp/src/index';

/** .NET's `char.IsWhiteSpace`, which `string.Trim()` removes from both ends (by code, not as text). */
const SPACE_CODES = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

export function dotnetTrim(text: string): string {
  let from = 0;
  let to = text.length;
  while (from < to && SPACE_CODES.has(text.charCodeAt(from))) from++;
  while (to > from && SPACE_CODES.has(text.charCodeAt(to - 1))) to--;
  return text.slice(from, to);
}

/**
 * `OrdinalIgnoreCase`'s view of a string: every UTF-16 unit mapped to its simple upper case when
 * that is one unit, else kept. Nothing more is folded (no Arabic letter forms, no diacritics).
 */
const uppers = new Map<string, string>();

export function upperInvariant(text: string): string {
  let known = uppers.get(text);
  if (known === undefined) {
    const units: string[] = [];
    for (const unit of text.split('')) {
      const up = unit.toUpperCase();
      units.push(up.length === 1 ? up : unit);
    }
    known = units.join('');
    if (uppers.size > 1_000_000) uppers.clear();
    uppers.set(text, known);
  }
  return known;
}

function ordinal(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Text, lookups and dates: ignoring case first, then exactly. */
export function textOrder(a: string, b: string): number {
  const folded = ordinal(upperInvariant(a), upperInvariant(b));
  return folded !== 0 ? folded : ordinal(a, b);
}

function decimalParts(value: string | number): { sign: bigint; digits: bigint; scale: number } {
  const text = String(value);
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace(/^[-+]/, '').split('.');
  return {
    sign: negative ? -1n : 1n,
    digits: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

/** Decimals by value, whatever their places. */
export function decimalOrder(a: string | number, b: string | number): number {
  const x = decimalParts(a);
  const y = decimalParts(b);
  const scale = Math.max(x.scale, y.scale);
  const xv = x.sign * x.digits * 10n ** BigInt(scale - x.scale);
  const yv = y.sign * y.digits * 10n ** BigInt(scale - y.scale);
  return xv === yv ? 0 : xv < yv ? -1 : 1;
}

const blank = (value: WireValue | undefined): boolean =>
  value === null || value === undefined || value === '';

/** One field's values, ascending: empty first. */
export function valueOrder(type: FieldType, a: WireValue | undefined, b: WireValue | undefined) {
  if (blank(a) && blank(b)) return 0;
  if (blank(a)) return -1;
  if (blank(b)) return 1;
  switch (type) {
    case 'boolean':
      return a === b ? 0 : a ? 1 : -1;
    case 'integer':
      return Math.sign(Number(a) - Number(b));
    case 'decimal':
      return decimalOrder(a as string, b as string);
    case 'dateTime':
      return Math.sign(Date.parse(String(a)) - Date.parse(String(b)));
    default:
      return textOrder(String(a), String(b));
  }
}

/** Whether a record's value is what `equals` asks for. */
export function equalsMatch(
  type: FieldType,
  value: WireValue | undefined,
  wanted: WireValue,
): boolean {
  if (blank(wanted)) return blank(value);
  if (blank(value)) return false;
  if (type === 'decimal') return decimalOrder(value as string, wanted as string) === 0;
  if (type === 'integer') return Number(value) === Number(wanted);
  return value === wanted;
}

/** Whether any of `texts` holds `search`, ignoring case. */
export function searchMatch(texts: readonly (string | null | undefined)[], search: string) {
  const wanted = upperInvariant(search);
  return texts.some((t) => typeof t === 'string' && upperInvariant(t).includes(wanted));
}

const foldedTexts = new WeakMap<object, string[]>();

/** A record's searched texts in upper case, made once. */
function uppersOf(record: RefRecord): string[] {
  let texts = foldedTexts.get(record);
  if (!texts) {
    texts = record.searchTexts
      .filter((t): t is string => typeof t === 'string')
      .map(upperInvariant);
    foldedTexts.set(record, texts);
  }
  return texts;
}

/** A record as the suite's reference holds it: its values and its place in the connector's order. */
export interface RefRecord {
  readonly id: string;
  readonly key: string;
  readonly values: Readonly<Record<string, WireValue>>;
  /** The texts the ERP's own list searches, sent or not. */
  readonly searchTexts: readonly (string | null)[];
  /** Its position in the connector's own order (the order with no sort). */
  readonly rank: number;
}

/**
 * What a query must answer from `records`: searched, matched, then ordered by `sort` with ties
 * in the connector's own order (`rank`). `types` gives each field's type.
 */
export function reference(
  records: readonly RefRecord[],
  types: Readonly<Record<string, FieldType>>,
  query: {
    readonly search?: string;
    readonly equals?: Readonly<Record<string, WireValue>>;
    readonly sort?: readonly SortKey[];
  },
): RefRecord[] {
  const search = query.search === undefined ? '' : dotnetTrim(query.search);
  const equals = Object.entries(query.equals ?? {});
  const sort = query.sort ?? [];
  const upper = upperInvariant(search);
  const found = records.filter(
    (r) =>
      (search === '' || uppersOf(r).some((t) => t.includes(upper))) &&
      equals.every(([name, wanted]) => equalsMatch(types[name]!, r.values[name], wanted)),
  );
  // Each record's sort values made comparable once (a decimal's exact value, a text's upper case),
  // as `valueOrder` orders them, so 100,000 records sort in a moment.
  const keyed = found.map((record) => ({
    record,
    keys: sort.map(({ field }) => orderKey(types[field]!, record.values[field])),
  }));
  keyed.sort((a, b) => {
    for (let i = 0; i < sort.length; i++) {
      const order = keyOrder(a.keys[i]!, b.keys[i]!);
      if (order !== 0) return sort[i]!.direction === 'desc' ? -order : order;
    }
    return a.record.rank - b.record.rank;
  });
  return keyed.map((k) => k.record);
}

type OrderKey =
  | { readonly kind: 'empty' }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'exact'; readonly value: bigint }
  | { readonly kind: 'text'; readonly upper: string; readonly text: string };

/** A value as `valueOrder` compares it, made once. */
function orderKey(type: FieldType, value: WireValue | undefined): OrderKey {
  if (blank(value)) return { kind: 'empty' };
  switch (type) {
    case 'boolean':
      return { kind: 'number', value: value ? 1 : 0 };
    case 'integer':
      return { kind: 'number', value: Number(value) };
    case 'decimal': {
      const { sign, digits, scale } = decimalParts(value as string);
      return { kind: 'exact', value: sign * digits * 10n ** BigInt(12 - scale) };
    }
    case 'dateTime':
      return { kind: 'number', value: Date.parse(String(value)) };
    default:
      return { kind: 'text', upper: upperInvariant(String(value)), text: String(value) };
  }
}

function keyOrder(a: OrderKey, b: OrderKey): number {
  if (a.kind === 'empty' || b.kind === 'empty') {
    return a.kind === b.kind ? 0 : a.kind === 'empty' ? -1 : 1;
  }
  if (a.kind === 'text' && b.kind === 'text')
    return ordinal(a.upper, b.upper) || ordinal(a.text, b.text);
  const x = (a as { value: number | bigint }).value;
  const y = (b as { value: number | bigint }).value;
  return x === y ? 0 : x < y ? -1 : 1;
}
