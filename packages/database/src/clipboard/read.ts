// What a paste reads beyond the conversion table (Phase 8). Excel and Sheet put on the clipboard
// what their cells show, in the language of the device they run on: `1.234,50 €` in German,
// `(1,234.50)` for an accounting negative, `16/11/2026` in British English, `١٦/١١/٢٠٢٦` in
// Arabic. The conversion table (`@cgw/workspace` db/, held to the C# port) reads only canonical
// text, and the server never sees pasted text, so these readings live here, for a paste alone:
//
// - Numbers: the device locale's thousands separator and decimal mark (from
//   `Intl.NumberFormat(locale)`'s parts; `,` and `.` without it), and always `٬` and `٫`;
//   Arabic-Indic and Eastern Arabic-Indic digits; one currency symbol or code before or after
//   (the property's currency and common ones as the locale writes them, `$ € £ ¥ ﷼`, ISO codes,
//   Arabic symbols like `ر.س` and `د.إ`); a minus before or after, or parentheses (accounting); a
//   percent, which is the fraction for a percent-formatted property (`12.5%` is 0.125) and the
//   number as written otherwise (12.5). Separators must sit where the locale puts them (groups of
//   three before the decimal mark), so `1.5` on a German device is left to the conversion table.
// - Dates: the locale's numeric short date (its day, month and year order from
//   `Intl.DateTimeFormat(locale).formatToParts`, Gregorian), separated by `/`, `.` or `-`, a
//   two-digit year by Excel's window (00 to 29 are 2000 to 2029, 30 to 99 are 1930 to 1999), a
//   four-digit one from 1900 (Excel has no dates before; a Hijri year is not read as Gregorian);
//   then an optional time (`h:mm`, `h:mm:ss`, AM or PM, `ص` or `م`) in the device's time zone. A
//   year first reads as year, month, day.
// - People: an exact email of a member (any case), or an exact display name only one member has;
//   several, separated by commas, when each is one of those.
// - Checkboxes: the conversion table's words (TRUE, yes, 1, ✓, نعم and FALSE, no, 0, لا, any
//   case), and Excel's German WAHR and FALSCH.
// What does not fit is not read here; the caller then asks the conversion table, else refuses.
import { parseBoolean } from '@cgw/workspace';
import type { DateValue, PropertyDef } from '../core';
import type { Person } from '../host';

const ch = (...codes: number[]) => String.fromCharCode(...codes);
/** The bidirectional marks Intl and spreadsheets put around numbers, signs and symbols. */
const MARKS = new RegExp(
  `[${ch(0x200e, 0x200f, 0x061c, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069)}]`,
  'g',
);
/** Spaces a number's groups may be written with (a plain, a no-break, a narrow no-break, a thin one). */
const SPACES = ch(0x20, 0xa0, 0x202f, 0x2009);
const MINUSES = ch(0x2d, 0x2212);
const ARABIC_DECIMAL = '٫';
const ARABIC_GROUP = '٬';
const PERCENTS = '%٪';
const FIXED_SYMBOLS = ['$', '€', '£', '¥', '﷼'];
/** Currencies whose symbols, as the device's locale writes them, a pasted number may carry. */
const COMMON = ['USD', 'EUR', 'GBP', 'JPY', 'SAR', 'AED', 'EGP', 'KWD', 'QAR', 'BHD', 'OMR', 'JOD'];
/** An Arabic currency symbol: letters in dotted groups (`ر.س`, `د.إ`, `ج.م.`). */
const ARABIC_SYMBOL = /^\p{Script=Arabic}{1,3}(?:\.\p{Script=Arabic}{1,3})*\.?/u;

const clean = (text: string) => text.replace(MARKS, '');
/** Arabic-Indic and Eastern Arabic-Indic (Persian) digits as 0 to 9. */
const ascii = (text: string) =>
  text.replace(/[٠-٩۰-۹]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
const isSpace = (c: string) => SPACES.includes(c);
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

// ---- Numbers ----------------------------------------------------------------------------------

interface NumberMarks {
  decimals: string[];
  groups: string[];
  /** Currency symbols, longest first. */
  symbols: string[];
  codes: Set<string>;
}

const marksCache = new Map<string, NumberMarks>();

function numberMarks(locale: string, currency: string | undefined): NumberMarks {
  const key = `${locale}|${currency ?? ''}`;
  const cached = marksCache.get(key);
  if (cached) return cached;
  let decimal = '.';
  let group = ',';
  const symbols = new Set(FIXED_SYMBOLS);
  try {
    for (const part of new Intl.NumberFormat(locale).formatToParts(1234567.5)) {
      if (part.type === 'decimal') decimal = clean(part.value);
      if (part.type === 'group') group = clean(part.value);
    }
    for (const code of [...(currency ? [currency.toUpperCase()] : []), ...COMMON])
      for (const display of ['symbol', 'narrowSymbol'] as const) {
        try {
          const parts = new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: code,
            currencyDisplay: display,
          }).formatToParts(1);
          for (const part of parts)
            if (part.type === 'currency') {
              const symbol = clean(part.value).trim();
              if (symbol) symbols.add(symbol);
            }
        } catch {
          // An engine without narrow symbols, or a code it does not know.
        }
      }
  } catch {
    // An unknown locale: `,` and `.`.
  }
  let codes: Set<string>;
  try {
    codes = new Set(Intl.supportedValuesOf('currency'));
  } catch {
    codes = new Set(COMMON);
  }
  if (currency) codes.add(currency.toUpperCase());
  const groups = isSpace(group) || group === '' ? [...SPACES] : [group];
  const made: NumberMarks = {
    decimals: [...new Set([decimal || '.', ARABIC_DECIMAL])],
    groups: [...new Set([...groups, ARABIC_GROUP])],
    symbols: [...symbols].sort((a, b) => b.length - a.length),
    codes,
  };
  marksCache.set(key, made);
  return made;
}

interface Affix {
  minus: number;
  plus: number;
  open: boolean;
  close: boolean;
  percent: number;
  currency: number;
}

/** What surrounds a number (signs, parentheses, a percent, a currency); false when anything else is there. */
function readAffix(text: string, marks: NumberMarks, into: Affix): boolean {
  let s = text;
  while (s.length) {
    const c = s[0];
    let taken = 1;
    if (c === '(') into.open = true;
    else if (c === ')') into.close = true;
    else if (MINUSES.includes(c)) into.minus++;
    else if (c === '+') into.plus++;
    else if (PERCENTS.includes(c)) into.percent++;
    else if (!isSpace(c)) {
      const symbol = marks.symbols.find((sym) => s.startsWith(sym));
      const code = /^[A-Z]{3}/.exec(s)?.[0];
      const arabic = ARABIC_SYMBOL.exec(s)?.[0];
      const found = symbol ?? (code && marks.codes.has(code) ? code : undefined) ?? arabic;
      if (!found) return false;
      into.currency++;
      taken = found.length;
    }
    s = s.slice(taken);
  }
  return true;
}

/** The digits of a number's core, from its separators as the locale places them. */
function readCore(core: string, marks: NumberMarks): string | undefined {
  let at = -1;
  for (let i = 0; i < core.length; i++)
    if (marks.decimals.includes(core[i])) {
      if (at >= 0) return undefined;
      at = i;
    }
  const whole = at < 0 ? core : core.slice(0, at);
  const fraction = at < 0 ? '' : core.slice(at + 1);
  if (!/^\d*$/.test(fraction) || (at >= 0 && fraction === '' && whole === '')) return undefined;
  let digits: string;
  if (/^\d*$/.test(whole)) digits = whole;
  else {
    // Groups of three after the first, one separator throughout (spaces count as one).
    let group: string | null = null;
    const runs: string[] = [];
    let run = '';
    for (const c of whole) {
      if (isDigit(c)) run += c;
      else if (marks.groups.includes(c)) {
        const kind = isSpace(c) ? ' ' : c;
        if (group !== null && group !== kind) return undefined;
        group = kind;
        runs.push(run);
        run = '';
      } else return undefined;
    }
    runs.push(run);
    if (!/^\d{1,3}$/.test(runs[0]) || runs.slice(1).some((r) => !/^\d{3}$/.test(r)))
      return undefined;
    digits = runs.join('');
  }
  return `${digits || '0'}${fraction ? `.${fraction}` : ''}`;
}

/**
 * A number from what a spreadsheet's cell shows, by the device locale; undefined when the text is
 * not one (the caller asks the conversion table then).
 */
export function readPastedNumber(
  input: string,
  def: PropertyDef,
  locale: string,
): number | undefined {
  const text = ascii(clean(input)).trim();
  let first = -1;
  let last = -1;
  for (let i = 0; i < text.length; i++)
    if (isDigit(text[i])) {
      if (first < 0) first = i;
      last = i;
    }
  if (first < 0) return undefined;
  const marks = numberMarks(locale, def.number?.currency ?? undefined);
  // A decimal mark just before the first digit belongs to the number (`.5`).
  if (first > 0 && marks.decimals.includes(text[first - 1])) first--;
  const affix: Affix = { minus: 0, plus: 0, open: false, close: false, percent: 0, currency: 0 };
  if (!readAffix(text.slice(0, first), marks, affix)) return undefined;
  if (!readAffix(text.slice(last + 1), marks, affix)) return undefined;
  if (affix.open !== affix.close || affix.minus + affix.plus > 1) return undefined;
  if (affix.open && affix.minus + affix.plus) return undefined;
  if (affix.percent > 1 || affix.currency > 1 || (affix.percent && affix.currency))
    return undefined;
  const digits = readCore(text.slice(first, last + 1), marks);
  if (digits === undefined) return undefined;
  const negative = affix.minus === 1 || affix.open;
  const scaled = affix.percent && def.number?.format === 'percent' ? `${digits}e-2` : digits;
  const value = Number(`${negative ? '-' : ''}${scaled}`);
  if (!Number.isFinite(value)) return undefined;
  return value === 0 ? 0 : value;
}

// ---- Dates -------------------------------------------------------------------------------------

type Field = 'day' | 'month' | 'year';
const orders = new Map<string, Field[]>();

/** The day, month and year order of the locale's numeric short date (Gregorian). */
export function dateOrder(locale: string): Field[] {
  let order = orders.get(locale);
  if (order) return order;
  order = ['year', 'month', 'day'];
  try {
    const found = new Intl.DateTimeFormat(locale, {
      calendar: 'gregory',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    })
      .formatToParts(new Date(2026, 10, 16))
      .map((p) => p.type)
      .filter((t): t is Field => t === 'day' || t === 'month' || t === 'year');
    if (found.length === 3) order = found;
  } catch {
    // An unknown locale: only a year first is read.
  }
  orders.set(locale, order);
  return order;
}

const DATE =
  /^(\d{1,4})([/.-])(\d{1,2})\2(\d{1,4})\.?(?:(?:[ ,]+|T)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|ص|م)?)?$/i;

const daysIn = (y: number, m: number) =>
  m === 2
    ? y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
      ? 29
      : 28
    : [4, 6, 9, 11].includes(m)
      ? 30
      : 31;
const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** A date (or a date and time) from what a spreadsheet's cell shows, by the device locale. */
export function readPastedDate(input: string, locale: string): DateValue | undefined {
  const text = ascii(clean(input))
    .trim()
    .replace(/[ ]+/g, ' ')
    .replace(new RegExp(`[${SPACES.slice(1)}]`, 'g'), ' ');
  const m = DATE.exec(text);
  if (!m) return undefined;
  const parts = [m[1], m[3], m[4]];
  const order: Field[] = m[1].length === 4 ? ['year', 'month', 'day'] : dateOrder(locale);
  const field = (f: Field) => parts[order.indexOf(f)];
  const yearText = field('year');
  const month = Number(field('month'));
  const day = Number(field('day'));
  let year: number;
  if (yearText.length === 2) {
    const yy = Number(yearText);
    year = yy < 30 ? 2000 + yy : 1900 + yy;
  } else if (yearText.length === 4) year = Number(yearText);
  else return undefined;
  if (field('month').length > 2 || field('day').length > 2) return undefined;
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month))
    return undefined;
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  if (m[5] === undefined) return { start: date };
  let hour = Number(m[5]);
  const minute = Number(m[6]);
  const second = m[7] === undefined ? 0 : Number(m[7]);
  const meridiem = m[8]?.toLowerCase().replace(/\./g, '');
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    const pm = meridiem === 'pm' || meridiem === 'م';
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  // The time as the device's clock shows it, stored as the UTC instant.
  const at = new Date(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(at.getTime())) return undefined;
  return { start: `${at.toISOString().slice(0, 19)}Z` };
}

// ---- People and checkboxes ---------------------------------------------------------------------

/** One person by an exact email (any case) or an exact display name only one member has. */
function personOf(text: string, people: readonly Person[]): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const lower = t.toLowerCase();
  const byEmail = people.find((p) => p.email && p.email.trim().toLowerCase() === lower);
  if (byEmail) return byEmail.id;
  const named = people.filter((p) => p.name.trim() === t);
  return named.length === 1 ? named[0].id : undefined;
}

/** People from text: one, or several separated by commas when each is one. */
export function readPastedPeople(text: string, people: readonly Person[]): string[] | undefined {
  const one = personOf(text, people);
  if (one) return [one];
  const parts = text.split(/[,،;]/).filter((p) => p.trim() !== '');
  if (parts.length < 2) return undefined;
  const ids: string[] = [];
  for (const part of parts) {
    const id = personOf(part, people);
    if (!id) return undefined;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

const EXCEL_WORDS: Record<string, boolean> = { wahr: true, falsch: false };

/** A checkbox from text: the conversion table's words, and Excel's German ones. */
export function readPastedCheckbox(text: string): boolean | undefined {
  const t = clean(text).trim();
  return parseBoolean(t) ?? EXCEL_WORDS[t.toLowerCase()];
}
