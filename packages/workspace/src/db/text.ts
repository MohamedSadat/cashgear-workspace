// Canonical text forms of database values, shared by conversion, CSV and formulas. The C# port
// must give the same answers (db-convert-vectors.json, db-csv-vectors.json).
//
// - Numbers are written as JavaScript's `String(n)` writes them: the shortest text that reads back
//   as the same double, `1e+21` and `1e-7` from those magnitudes on, `-0` as `0`.
// - `trim` is JavaScript's: it removes TAB, LF, VT, FF, CR, SPACE, U+00A0, U+1680, U+2000 to
//   U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF from both ends (C#'s `Trim()` also
//   removes U+0085 and keeps U+FEFF, so the port uses this set).

/** A number as text: JavaScript's `String(n)`. */
export const numberText = (n: number): string => String(n);

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/** Arabic-Indic and Persian digits as 0-9. */
export const asciiDigits = (text: string): string =>
  text.replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10));

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const GROUPED = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;

/**
 * A number read from text, or undefined: trimmed; Arabic-Indic and Persian digits read as 0-9,
 * `٫` as the decimal point and `٬` as a thousands separator; commas between groups of three digits
 * dropped (`1,234.5`); then a decimal number with an optional sign and exponent. Nothing else: no
 * currency, percent or spaces. A result that is not finite is undefined; `-0` is 0.
 */
export function parseNumberText(text: string): number | undefined {
  let t = asciiDigits(text.trim()).replace(/٫/g, '.').replace(/٬/g, ',');
  if (GROUPED.test(t)) t = t.replace(/,/g, '');
  if (!NUMBER.test(t)) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n)) return undefined;
  return n === 0 ? 0 : n;
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'on', 'checked', 'x', '✓', '✔', 'نعم']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'off', 'unchecked', 'لا']);

/** A checkbox read from text (trimmed, digits as 0-9, lower case), or undefined for any other word. */
export function parseBoolean(text: string): boolean | undefined {
  const t = asciiDigits(text.trim()).toLowerCase();
  if (TRUE_WORDS.has(t)) return true;
  if (FALSE_WORDS.has(t)) return false;
  return undefined;
}

/** Comma-separated names (multi-select from text): each trimmed, empty ones dropped, first of each kept. */
export function splitNames(text: string): string[] {
  const names: string[] = [];
  for (const part of text.split(',')) {
    const name = part.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}
