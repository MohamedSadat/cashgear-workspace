// The formula language's fixed function list (Phase 4 contracts, section 2): what the formula
// editor lists and what the checker holds calls to. Their behaviour is in evaluate.ts.
import type { FormulaType } from './parser';

export type ArgumentKind = FormulaType | 'any';

export interface FormulaFunction {
  name: string;
  /** Least and most arguments; `max` null takes any number. */
  min: number;
  max: number | null;
  /**
   * The kinds each argument takes, by position; past the end, the last `repeat` entries repeat
   * (`ifs`: condition, value, ...; its last argument, the else, takes any kind).
   */
  args: ArgumentKind[][];
  repeat: number;
  /** The result's kind; `same` is the kind of the value arguments (`if`, `ifs`). */
  result: FormulaType | 'same';
  /** Arguments that, written as text, must be one of these (a unit, a date pattern). */
  choices?: { index: number; values: readonly string[] };
}

export const DATE_UNITS = [
  'years',
  'quarters',
  'months',
  'weeks',
  'days',
  'hours',
  'minutes',
] as const;
export type DateUnit = (typeof DATE_UNITS)[number];
export const DATE_PATTERNS = [
  'YYYY-MM-DD',
  'YYYY-MM-DD HH:mm',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
] as const;

const f = (
  name: string,
  min: number,
  max: number | null,
  args: ArgumentKind[][],
  result: FormulaType | 'same',
  extra: Partial<Pick<FormulaFunction, 'repeat' | 'choices'>> = {},
): FormulaFunction => ({ name, min, max, args, result, repeat: extra.repeat ?? 1, ...extra });

const NUMBER: ArgumentKind[] = ['number'];
const TEXT: ArgumentKind[] = ['text'];
const DATE: ArgumentKind[] = ['date'];
const ANY: ArgumentKind[] = ['any'];
const units = (index: number) => ({ choices: { index, values: DATE_UNITS } });

export const FUNCTIONS: readonly FormulaFunction[] = [
  f('if', 3, 3, [['boolean'], ANY, ANY], 'same'),
  f('ifs', 3, null, [['boolean'], ANY], 'same', { repeat: 2 }),
  f('empty', 1, 1, [ANY], 'boolean'),
  f('length', 1, 1, [['text', 'list']], 'number'),
  f('concat', 1, null, [ANY], 'text'),
  f('join', 2, null, [TEXT, ANY], 'text'),
  f('lower', 1, 1, [TEXT], 'text'),
  f('upper', 1, 1, [TEXT], 'text'),
  f('trim', 1, 1, [TEXT], 'text'),
  f('contains', 2, 2, [['text', 'list'], TEXT], 'boolean'),
  f('replace', 3, 3, [TEXT, TEXT, TEXT], 'text'),
  f('replaceAll', 3, 3, [TEXT, TEXT, TEXT], 'text'),
  f('slice', 2, 3, [TEXT, NUMBER, NUMBER], 'text'),
  f('format', 1, 1, [ANY], 'text'),
  f('toNumber', 1, 1, [['text', 'number', 'boolean', 'date']], 'number'),
  f('abs', 1, 1, [NUMBER], 'number'),
  f('round', 1, 2, [NUMBER, NUMBER], 'number'),
  f('floor', 1, 1, [NUMBER], 'number'),
  f('ceil', 1, 1, [NUMBER], 'number'),
  f('min', 1, null, [NUMBER], 'number'),
  f('max', 1, null, [NUMBER], 'number'),
  f('sqrt', 1, 1, [NUMBER], 'number'),
  f('pow', 2, 2, [NUMBER, NUMBER], 'number'),
  f('mod', 2, 2, [NUMBER, NUMBER], 'number'),
  f('sign', 1, 1, [NUMBER], 'number'),
  f('dateAdd', 3, 3, [DATE, NUMBER, TEXT], 'date', units(2)),
  f('dateSubtract', 3, 3, [DATE, NUMBER, TEXT], 'date', units(2)),
  f('dateBetween', 3, 3, [DATE, DATE, TEXT], 'number', units(2)),
  f('formatDate', 2, 2, [DATE, TEXT], 'text', { choices: { index: 1, values: DATE_PATTERNS } }),
  f('year', 1, 1, [DATE], 'number'),
  f('month', 1, 1, [DATE], 'number'),
  f('day', 1, 1, [DATE], 'number'),
  f('hour', 1, 1, [DATE], 'number'),
  f('minute', 1, 1, [DATE], 'number'),
  f('weekday', 1, 1, [DATE], 'number'),
  f('dateStart', 1, 1, [DATE], 'date'),
  f('dateEnd', 1, 1, [DATE], 'date'),
];

export const FUNCTION_BY_NAME: ReadonlyMap<string, FormulaFunction> = new Map(
  FUNCTIONS.map((fn) => [fn.name, fn]),
);

/** The kinds argument `index` of `fn` takes. */
export function argumentKinds(fn: FormulaFunction, index: number): ArgumentKind[] {
  if (fn.name === 'ifs') return index % 2 === 0 ? ['boolean'] : ANY;
  if (index < fn.args.length) return fn.args[index];
  const from = fn.args.length - fn.repeat;
  return fn.args[from + ((index - fn.args.length) % fn.repeat)];
}
