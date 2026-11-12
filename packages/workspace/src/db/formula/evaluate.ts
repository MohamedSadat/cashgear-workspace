// The formula evaluator (Phase 4 contracts, section 2), over a tree the checker has marked.
//
// - Empty (null) goes through: arithmetic, number and date functions with an empty argument give
//   empty; text functions read it as ''; `+` joining text writes it as ''; `==` holds between two
//   empties; `<` and the like are false with an empty side; and, or, not, if and ifs read it as
//   false. and, or, if and ifs evaluate only what they need, left to right.
// - Errors: the first error met, left to right, is the result. Division (`/`, `%`, `mod`) by zero
//   is `formula.divideByZero`; a number that is not finite, `round` with more than 15 digits
//   either way, and a date outside years 1 to 9999 are `formula.range`; a unit or pattern that is
//   not one the function takes is `formula.type`.
// - Results: '' and [] are empty, -0 is 0.
// - Numbers are IEEE doubles. `round(n, d)` rounds half away from zero: d is truncated, then
//   sign(n) × floor(|n| × 10^d + 0.5) / 10^d (for d < 0: floor(|n| / 10^-d + 0.5) × 10^-d), with
//   10^k exact. `%` is the remainder with the dividend's sign (JavaScript's and C#'s `%`); `mod` has
//   the divisor's sign. `pow` and `^` are the platform's pow (vectors use exact cases only).
// - Text works on UTF-16 code units. `contains`, `replace` and `replaceAll` match exactly; an
//   empty search changes nothing. `slice` truncates its numbers, counts negative ones from the end
//   and clamps (JavaScript's `slice`). `lower` and `upper` are the default Unicode mappings.
// - Dates are UTC; a date without a time is its midnight. dateAdd and dateSubtract truncate the
//   amount and move start and end: months, quarters and years by calendar months with the day
//   clamped to the month's end; weeks and days by days (a date stays a date); hours and minutes
//   make a date-time. dateBetween(a, b, unit) is a − b in whole units, truncated toward zero, of
//   the starts: months as calendar months (b plus that many months is not after a), quarters and
//   years from those months; the rest from milliseconds. `weekday` is 1 (Monday) to 7 (Sunday).
//   A unit or pattern is checked before an empty date or amount makes the result empty.
//   `toNumber` of a date is its start's Unix milliseconds.
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  addDays,
  addMonths,
  addMs,
  dateDay,
  dateText,
  isDateOnly,
  pointMs,
  weekdayOfDay,
} from '../dates';
import { numberText, parseNumberText } from '../text';
import type { DateValue } from '../types';
import { FORMULA_ERRORS, FormulaError } from './check';
import { DATE_PATTERNS, DATE_UNITS, type DateUnit } from './functions';
import type { FormulaNode, StaticType } from './parser';

export type FormulaValue = number | string | boolean | DateValue | string[] | null;

export interface FormulaEnv {
  /** A property's value as formulas read it, by its static kind; throws a `FormulaError` for an error cell. */
  prop(id: string, type: StaticType): FormulaValue;
}

const fail = (code: string): never => {
  throw new FormulaError(code);
};

function finite(n: number): number {
  if (!Number.isFinite(n)) fail(FORMULA_ERRORS.range);
  return n;
}

const truthy = (value: FormulaValue) => value === true;
const isDate = (value: FormulaValue): value is DateValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Any value as text: `format`. */
export function formatValue(value: FormulaValue): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return numberText(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.join(', ');
  return dateText(value);
}

const text = (value: FormulaValue) => (typeof value === 'string' ? value : formatValue(value));
const num = (value: FormulaValue) => (typeof value === 'number' ? value : null);
const date = (value: FormulaValue) => (isDate(value) ? value : null);

const startMs = (value: DateValue) => pointMs(value.start);

function equal(a: FormulaValue, b: FormulaValue): boolean {
  if (a === null || b === null) return a === b;
  if (isDate(a) && isDate(b))
    return (
      startMs(a) === startMs(b) &&
      (a.end ? (b.end ? pointMs(a.end) === pointMs(b.end) : false) : !b.end)
    );
  return a === b;
}

function compare(a: FormulaValue, b: FormulaValue): number {
  if (isDate(a) && isDate(b)) return startMs(a) - startMs(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const POWERS_OF_TEN = Array.from({ length: 16 }, (_, i) => Number(`1e${i}`));

function round(n: number, digits: number): number {
  const d = Math.trunc(digits);
  if (Math.abs(d) > 15) fail(FORMULA_ERRORS.range);
  const a = Math.abs(n);
  const r =
    d >= 0
      ? Math.floor(a * POWERS_OF_TEN[d] + 0.5) / POWERS_OF_TEN[d]
      : Math.floor(a / POWERS_OF_TEN[-d] + 0.5) * POWERS_OF_TEN[-d];
  return finite(Math.sign(n) * r);
}

function slice(t: string, start: number | null, end: number | null | undefined): string {
  const length = t.length;
  const at = (n: number) => {
    const i = Math.trunc(n);
    return i < 0 ? Math.max(length + i, 0) : Math.min(i, length);
  };
  const from = at(start ?? 0);
  const to = end === null || end === undefined ? length : at(end);
  return from < to ? t.slice(from, to) : '';
}

function replaceFirst(t: string, search: string, by: string): string {
  if (search === '') return t;
  const i = t.indexOf(search);
  return i < 0 ? t : t.slice(0, i) + by + t.slice(i + search.length);
}

function unitOf(value: FormulaValue): DateUnit {
  if (typeof value !== 'string' || !(DATE_UNITS as readonly string[]).includes(value))
    fail(FORMULA_ERRORS.type);
  return value as DateUnit;
}

function shift(value: DateValue, amount: number, unit: DateUnit): DateValue {
  const n = Math.trunc(amount);
  const move = (point: string): string | undefined => {
    switch (unit) {
      case 'years':
        return addMonths(point, n * 12);
      case 'quarters':
        return addMonths(point, n * 3);
      case 'months':
        return addMonths(point, n);
      case 'weeks':
        return addDays(point, n * 7);
      case 'days':
        return addDays(point, n);
      case 'hours':
        return addMs(point, n * HOUR_MS);
      case 'minutes':
        return addMs(point, n * MINUTE_MS);
    }
  };
  const start = move(value.start);
  const end = value.end ? move(value.end) : undefined;
  if (!start || (value.end && !end)) return fail(FORMULA_ERRORS.range);
  return end ? { start, end } : { start };
}

const asInstant = (point: string) => (isDateOnly(point) ? `${point}T00:00:00Z` : point);

/** Whole calendar months from b to a, truncated toward zero. */
function monthsBetween(a: string, b: string): number {
  const ia = asInstant(a);
  const ib = asInstant(b);
  if (pointMs(ia) < pointMs(ib)) return -monthsBetween(b, a);
  let months =
    (Number(ia.slice(0, 4)) - Number(ib.slice(0, 4))) * 12 +
    (Number(ia.slice(5, 7)) - Number(ib.slice(5, 7)));
  if (pointMs(addMonths(ib, months)!) > pointMs(ia)) months -= 1;
  return months;
}

function between(a: DateValue, b: DateValue, unit: DateUnit): number {
  const diff = startMs(a) - startMs(b);
  switch (unit) {
    case 'minutes':
      return Math.trunc(diff / MINUTE_MS);
    case 'hours':
      return Math.trunc(diff / HOUR_MS);
    case 'days':
      return Math.trunc(diff / DAY_MS);
    case 'weeks':
      return Math.trunc(diff / (7 * DAY_MS));
    case 'months':
      return monthsBetween(a.start, b.start);
    case 'quarters':
      return Math.trunc(monthsBetween(a.start, b.start) / 3);
    case 'years':
      return Math.trunc(monthsBetween(a.start, b.start) / 12);
  }
}

function patternOf(value: FormulaValue): string {
  if (typeof value !== 'string' || !(DATE_PATTERNS as readonly string[]).includes(value))
    fail(FORMULA_ERRORS.type);
  return value as string;
}

function formatDate(value: DateValue, pattern: string): string {
  const s = asInstant(value.start);
  const [y, m, d] = [s.slice(0, 4), s.slice(5, 7), s.slice(8, 10)];
  switch (pattern) {
    case 'YYYY-MM-DD HH:mm':
      return `${y}-${m}-${d} ${s.slice(11, 13)}:${s.slice(14, 16)}`;
    case 'DD/MM/YYYY':
      return `${d}/${m}/${y}`;
    case 'MM/DD/YYYY':
      return `${m}/${d}/${y}`;
    default:
      return `${y}-${m}-${d}`;
  }
}

function part(value: DateValue, which: string): number {
  const s = asInstant(value.start);
  switch (which) {
    case 'year':
      return Number(s.slice(0, 4));
    case 'month':
      return Number(s.slice(5, 7));
    case 'day':
      return Number(s.slice(8, 10));
    case 'hour':
      return Number(s.slice(11, 13));
    case 'minute':
      return Number(s.slice(14, 16));
    default:
      return weekdayOfDay(dateDay(s.slice(0, 10)));
  }
}

/** Evaluates a checked tree; throws `FormulaError`. */
export function evaluateTree(node: FormulaNode, env: FormulaEnv): FormulaValue {
  switch (node.kind) {
    case 'number':
      return finite(node.value);
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'prop':
      return env.prop(node.id, node.type ?? 'empty');
    case 'unary': {
      const value = evaluateTree(node.arg, env);
      if (node.op === 'not') return !truthy(value);
      return value === null ? null : finite(-(value as number));
    }
    case 'binary':
      return binary(node, env);
    case 'call':
      return call(node, env);
  }
}

function binary(node: Extract<FormulaNode, { kind: 'binary' }>, env: FormulaEnv): FormulaValue {
  if (node.op === 'and')
    return truthy(evaluateTree(node.left, env)) && truthy(evaluateTree(node.right, env));
  if (node.op === 'or')
    return truthy(evaluateTree(node.left, env)) || truthy(evaluateTree(node.right, env));
  const left = evaluateTree(node.left, env);
  const right = evaluateTree(node.right, env);
  switch (node.op) {
    case '==':
      return equal(left, right);
    case '!=':
      return !equal(left, right);
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (left === null || right === null) return false;
      const c = compare(left, right);
      return node.op === '<' ? c < 0 : node.op === '<=' ? c <= 0 : node.op === '>' ? c > 0 : c >= 0;
    }
    case '+':
      if (node.type === 'text') return formatValue(left) + formatValue(right);
      break;
  }
  const a = num(left);
  const b = num(right);
  if (a === null || b === null) return null;
  switch (node.op) {
    case '+':
      return finite(a + b);
    case '-':
      return finite(a - b);
    case '*':
      return finite(a * b);
    case '/':
      if (b === 0) fail(FORMULA_ERRORS.divideByZero);
      return finite(a / b);
    case '%':
      if (b === 0) fail(FORMULA_ERRORS.divideByZero);
      return finite(a % b);
    default:
      return finite(Math.pow(a, b));
  }
}

function call(node: Extract<FormulaNode, { kind: 'call' }>, env: FormulaEnv): FormulaValue {
  const args = node.args;
  if (node.name === 'if')
    return truthy(evaluateTree(args[0], env))
      ? evaluateTree(args[1], env)
      : evaluateTree(args[2], env);
  if (node.name === 'ifs') {
    for (let i = 0; i + 1 < args.length; i += 2)
      if (truthy(evaluateTree(args[i], env))) return evaluateTree(args[i + 1], env);
    return evaluateTree(args[args.length - 1], env);
  }
  const v = args.map((arg) => evaluateTree(arg, env));
  const isList = (i: number) => args[i].type === 'list' || Array.isArray(v[i]);
  const n0 = num(v[0]);
  const unaryNumber = (fn: (n: number) => number) => (n0 === null ? null : finite(fn(n0)));
  switch (node.name) {
    case 'empty':
      return v[0] === null || v[0] === '' || (Array.isArray(v[0]) && v[0].length === 0);
    case 'length':
      return Array.isArray(v[0]) ? v[0].length : text(v[0]).length;
    case 'concat':
      return v.map(formatValue).join('');
    case 'join': {
      const items: string[] = [];
      for (const value of v.slice(1))
        for (const item of Array.isArray(value) ? value : [value]) {
          const t = formatValue(item);
          if (t !== '') items.push(t);
        }
      return items.join(text(v[0]));
    }
    case 'lower':
      return text(v[0]).toLowerCase();
    case 'upper':
      return text(v[0]).toUpperCase();
    case 'trim':
      return text(v[0]).trim();
    case 'contains':
      if (isList(0)) return Array.isArray(v[0]) && v[0].includes(text(v[1]));
      return text(v[0]).includes(text(v[1]));
    case 'replace':
      return replaceFirst(text(v[0]), text(v[1]), text(v[2]));
    case 'replaceAll': {
      const search = text(v[1]);
      return search === '' ? text(v[0]) : text(v[0]).split(search).join(text(v[2]));
    }
    case 'slice':
      return slice(text(v[0]), num(v[1]), args.length > 2 ? num(v[2]) : undefined);
    case 'format':
      return formatValue(v[0]);
    case 'toNumber': {
      const value = v[0];
      if (typeof value === 'number') return value;
      if (typeof value === 'string') return parseNumberText(value) ?? null;
      if (typeof value === 'boolean') return value ? 1 : 0;
      const d = date(value);
      return d ? startMs(d) : null;
    }
    case 'abs':
      return unaryNumber(Math.abs);
    case 'floor':
      return unaryNumber(Math.floor);
    case 'ceil':
      return unaryNumber(Math.ceil);
    case 'sqrt':
      return unaryNumber(Math.sqrt);
    case 'sign':
      return unaryNumber(Math.sign);
    case 'round': {
      if (n0 === null) return null;
      const digits = args.length > 1 ? num(v[1]) : 0;
      return digits === null ? null : round(n0, digits);
    }
    case 'min':
    case 'max': {
      const numbers = v.filter((value): value is number => typeof value === 'number');
      if (!numbers.length) return null;
      return node.name === 'min' ? Math.min(...numbers) : Math.max(...numbers);
    }
    case 'pow': {
      const b = num(v[1]);
      return n0 === null || b === null ? null : finite(Math.pow(n0, b));
    }
    case 'mod': {
      const b = num(v[1]);
      if (n0 === null || b === null) return null;
      if (b === 0) fail(FORMULA_ERRORS.divideByZero);
      let r = n0 % b;
      if (r !== 0 && r < 0 !== b < 0) r += b;
      return finite(r);
    }
    case 'dateAdd':
    case 'dateSubtract': {
      const d = date(v[0]);
      const amount = num(v[1]);
      const unit = unitOf(v[2]);
      if (!d || amount === null) return null;
      return shift(d, node.name === 'dateAdd' ? amount : -amount, unit);
    }
    case 'dateBetween': {
      const a = date(v[0]);
      const b = date(v[1]);
      const unit = unitOf(v[2]);
      return a && b ? between(a, b, unit) : null;
    }
    case 'formatDate': {
      const pattern = patternOf(v[1]);
      const d = date(v[0]);
      return d ? formatDate(d, pattern) : null;
    }
    case 'year':
    case 'month':
    case 'day':
    case 'hour':
    case 'minute':
    case 'weekday': {
      const d = date(v[0]);
      return d ? part(d, node.name) : null;
    }
    case 'dateStart': {
      const d = date(v[0]);
      return d ? { start: d.start } : null;
    }
    case 'dateEnd': {
      const d = date(v[0]);
      return d ? { start: d.end ?? d.start } : null;
    }
    default:
      return fail(FORMULA_ERRORS.unknownFunction);
  }
}

/** A result as stored: '' and [] are empty, -0 is 0. */
export function finishValue(value: FormulaValue): FormulaValue {
  if (value === '' || (Array.isArray(value) && value.length === 0)) return null;
  if (value === 0) return 0;
  return value;
}
