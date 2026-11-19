// How the ERP compares, matches and orders values (INTEGRATIONS.md, "Queries paged in the ERP's
// database (Phase 12, Track E10)": 0.10.0's answers, as `ConnectorQuery` in UnifiedAPI gives
// them), for the mock's queries. The contract suite has its own copy of these rules
// (tests/contracts/erp/rules.ts), written apart, so each checks the other.
//
// - Text is trimmed as .NET's `string.Trim()` trims (its `char.IsWhiteSpace`, which is not
//   JavaScript's `trim()`: U+0085 is white space there, U+FEFF is not).
// - Ignoring case is .NET's `OrdinalIgnoreCase`: each UTF-16 unit by its simple upper case (one
//   unit to one unit; a letter whose upper case is longer, as `ß`, stays itself), then ordinal.
//   Nothing else is folded: alef forms, hamza, taa marbuta, alef maqsura and yaa, diacritics and
//   tatweel each match and sort only as themselves.

const WHITE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** `text.Trim()` as .NET trims. */
export function trimNet(text) {
  let start = 0;
  let end = text.length;
  while (start < end && WHITE.has(text.charCodeAt(start))) start++;
  while (end > start && WHITE.has(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

const upper = new Map();

/** One UTF-16 unit's simple upper case, as `OrdinalIgnoreCase` takes it. */
function upperUnit(code) {
  if (code < 0x80) return code >= 0x61 && code <= 0x7a ? code - 0x20 : code;
  let mapped = upper.get(code);
  if (mapped === undefined) {
    const up = String.fromCharCode(code).toUpperCase();
    mapped = up.length === 1 ? up.charCodeAt(0) : code;
    upper.set(code, mapped);
  }
  return mapped;
}

/** `text` with each unit in its simple upper case: equal folds are equal ignoring case. */
export function fold(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x61) {
      ascii = false;
      break;
    }
  }
  if (ascii) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) out += String.fromCharCode(upperUnit(text.charCodeAt(i)));
  return out;
}

/** Ordinal order of UTF-16 units, as `string.CompareOrdinal`. */
export const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `OrdinalIgnoreCase`, then ordinal for ties: the ERP's order of text, lookups and dates. */
export function compareText(a, b) {
  return ordinal(fold(a), fold(b)) || ordinal(a, b);
}

/** Whether `text` holds `search` ignoring case (`Contains(search, OrdinalIgnoreCase)`). */
export const containsFolded = (foldedText, foldedSearch) => foldedText.includes(foldedSearch);

const DECIMAL = /^-?(0|[1-9]\d*)(\.(\d+))?$/;

/** A decimal string or number as an exact value: digits as a BigInt at `scale` places. */
function scaled(value, scale) {
  const text = typeof value === 'number' ? String(value) : value;
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace(/^[-+]/, '').split('.');
  const digits = BigInt(whole + fraction.padEnd(scale, '0').slice(0, scale));
  return negative ? -digits : digits;
}

function places(text) {
  const at = text.indexOf('.');
  return at < 0 ? 0 : text.length - at - 1;
}

/** Decimal strings (or numbers) by value. */
export function compareDecimal(a, b) {
  const sa = typeof a === 'number' ? String(a) : a;
  const sb = typeof b === 'number' ? String(b) : b;
  const scale = Math.max(places(sa), places(sb));
  const x = scaled(sa, scale);
  const y = scaled(sb, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

export const isDecimalText = (text) => typeof text === 'string' && DECIMAL.test(text);

/** A decimal string (or number) as a BigInt of its smallest unit at `scale` places. */
export const toUnits = (value, scale) => scaled(String(value), scale);

/** Empty on the wire: null, or a string with nothing in it. */
export const isEmpty = (value) => value === null || value === undefined || value === '';

/**
 * Two wire values of a field in the ERP's ascending order: empty first; booleans, integers and
 * decimals by value; date-times as instants; text, lookups and dates by `compareText`.
 */
export function compareWire(type, a, b) {
  const ae = isEmpty(a);
  const be = isEmpty(b);
  if (ae || be) return ae === be ? 0 : ae ? -1 : 1;
  switch (type) {
    case 'boolean':
      return Number(a) - Number(b);
    case 'integer':
      return a < b ? -1 : a > b ? 1 : 0;
    case 'decimal':
      return compareDecimal(a, b);
    case 'dateTime': {
      const x = Date.parse(a);
      const y = Date.parse(b);
      if (!Number.isNaN(x) && !Number.isNaN(y)) return x < y ? -1 : x > y ? 1 : 0;
      break;
    }
  }
  return compareText(String(a), String(b));
}

/**
 * Whether a record's wire value matches an `equals` value: empty and null alike; booleans,
 * integers and decimals by value; text, lookups, dates and date-times exactly (ordinal).
 */
export function sameWire(type, wire, filter) {
  if (isEmpty(filter)) return isEmpty(wire);
  if (isEmpty(wire)) return false;
  switch (type) {
    case 'boolean':
      return wire === filter;
    case 'integer':
      return Number(wire) === Number(filter);
    case 'decimal':
      return compareDecimal(wire, filter) === 0;
    default:
      return wire === filter;
  }
}

/**
 * A sort key's value made once per record, so a sort of 100,000 records folds each text once
 * (`folder` may cache the folds).
 */
export function sortKeyOf(type, value, folder = fold) {
  if (isEmpty(value)) return { empty: true };
  switch (type) {
    case 'boolean':
      return { n: Number(value) };
    case 'integer':
      return { n: value };
    case 'decimal':
      // Exact at 12 places: wider than any field's scale.
      return { b: scaled(String(value), 12) };
    case 'dateTime': {
      const at = Date.parse(value);
      if (!Number.isNaN(at)) return { n: at };
      break;
    }
  }
  const text = String(value);
  return { f: folder(text), t: text };
}

/** Two keys from `sortKeyOf` of one field, ascending. */
export function compareKeys(x, y) {
  if (x.empty || y.empty) return x.empty === y.empty ? 0 : x.empty ? -1 : 1;
  if (x.n !== undefined) return x.n < y.n ? -1 : x.n > y.n ? 1 : 0;
  if (x.b !== undefined) return x.b < y.b ? -1 : x.b > y.b ? 1 : 0;
  return ordinal(x.f, y.f) || ordinal(x.t, y.t);
}

/** A decimal string at `scale` places from a whole number of the smallest unit (cents). */
export function decimalOf(units, scale) {
  const negative = units < 0n || (typeof units === 'number' && units < 0);
  const digits = String(typeof units === 'bigint' ? (negative ? -units : units) : Math.abs(units));
  if (scale === 0) return `${negative && digits !== '0' ? '-' : ''}${digits}`;
  const padded = digits.padStart(scale + 1, '0');
  const text = `${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
  return negative && /[1-9]/.test(text) ? `-${text}` : text;
}
