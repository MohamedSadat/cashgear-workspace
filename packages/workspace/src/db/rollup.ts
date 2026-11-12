// Rollups (Phase 4 contracts, section 2): a property of the related rows, reduced by a function.
// Shared vectors: db-compute-vectors.json.
//
// The related rows are those the relation's value names that `related` returns, each once, in the
// value's order, leaving out trashed rows and templates. Each one's cell is read as `cellValue`
// reads it (a formula or rollup there: that row's `computed`). A cell is empty when it is null,
// '', [] or an error.
//
//   count            related rows
//   countValues      values: a list cell counts its items, any other non-empty cell one
//   countUnique      distinct values (a list's items each; text exactly, numbers and dates by text)
//   countEmpty       rows whose cell is empty;  countNotEmpty: the others
//   percentEmpty     countEmpty / count, a fraction (0.25), empty with no rows; percentNotEmpty
//   sum              of the numbers, in order; 0 with none
//   average, median, min, max, range (max − min): of the numbers; empty with none
//   earliest, latest the date with the first or last start (date-only at UTC midnight; the first
//                    of equals), as `{ start }`; empty with none
//   checked, unchecked  rows whose cell is true / is not; percentChecked: checked / count
//   showOriginal     every value as formulas read it (option names; ids of people, files, rows),
//                    a scalar as `format` writes it, in order; empty with none
//
// sum to range need a number property (a number, or a number formula or rollup), earliest and
// latest a date one, checked to percentChecked a checkbox one: else `formula.type`. A relation or
// target property that is unknown or deleted is `formula.unknownProperty`; a broken target
// formula gives its error.
import type { Id } from '../ids';
import type { RowRecord } from '../types';
import { pointMs } from './dates';
import { compileDatabase, rollupType, typeOfProperty } from './formula/compile';
import { FORMULA_ERRORS } from './formula/check';
import { formatValue, type FormulaValue } from './formula/evaluate';
import type { StaticType } from './formula/parser';
import { numberText } from './text';
import type { CellValue, DatabaseRecord, DateValue, PropertyDef } from './types';
import { cellOf, isEmptyCell } from './values';

/** The rows of a database by id: its record and those of `rowIds` it has; null when it is not held. */
export type RelatedRows = (
  databaseId: Id,
  rowIds: Id[],
) => { database: DatabaseRecord; rows: RowRecord[] } | null;

const NUMBER_FNS = new Set(['sum', 'average', 'median', 'min', 'max', 'range']);
const DATE_FNS = new Set(['earliest', 'latest']);
const CHECK_FNS = new Set(['checked', 'unchecked', 'percentChecked']);

/** A cell as formulas read it: options by name. */
export function formulaCell(def: PropertyDef, cell: CellValue): CellValue {
  if (cell === null) return null;
  if (def.type === 'select' || def.type === 'status')
    return def.options?.find((o) => o.id === cell)?.name ?? null;
  if (def.type === 'multiSelect' && Array.isArray(cell)) {
    const names = cell
      .map((id) => def.options?.find((o) => o.id === id)?.name ?? '')
      .filter(Boolean);
    return names.length ? names : null;
  }
  return cell;
}

const isDate = (cell: CellValue): cell is DateValue =>
  typeof cell === 'object' && cell !== null && !Array.isArray(cell) && 'start' in cell;

function uniqueKey(cell: CellValue): string {
  if (typeof cell === 'number') return `n:${numberText(cell)}`;
  if (typeof cell === 'boolean') return `b:${cell}`;
  if (typeof cell === 'string') return `t:${cell}`;
  if (isDate(cell)) return `d:${formatValue(cell)}`;
  return '';
}

/** The target property's kind, or its error. */
function targetType(database: DatabaseRecord, def: PropertyDef): StaticType | { error: string } {
  if (def.type === 'formula') {
    const formula = compileDatabase(database).formulas.get(def.id);
    if (!formula) return { error: FORMULA_ERRORS.unknownProperty };
    return formula.error ? { error: formula.error } : (formula.type ?? 'empty');
  }
  if (def.type === 'rollup') return rollupType(def.rollup?.fn);
  return typeOfProperty(def.type);
}

const error = (code: string): CellValue => ({ error: code });

/**
 * A rollup's result on `row`; undefined when the related rows are not held here (`related`
 * returned null), so the caller reads the server's result instead.
 */
export function computeRollup(
  database: DatabaseRecord,
  def: PropertyDef,
  row: RowRecord,
  related: RelatedRows,
): CellValue | undefined {
  const spec = def.rollup;
  const relation = spec && database.properties.find((p) => p.id === spec.relationPropertyId);
  if (
    !spec ||
    !relation ||
    relation.trashedAt ||
    relation.type !== 'relation' ||
    !relation.relation
  )
    return error(FORMULA_ERRORS.unknownProperty);
  const ids = (cellOf(relation, row) as string[] | null) ?? [];
  const got = related(relation.relation.databaseId, ids);
  if (!got) return undefined;
  const target = got.database.properties.find((p) => p.id === spec.targetPropertyId);
  if (!target || target.trashedAt) return error(FORMULA_ERRORS.unknownProperty);
  const kind = targetType(got.database, target);
  if (typeof kind !== 'string') return error(kind.error);
  const fits = (want: StaticType) => kind === want || kind === 'empty';
  if (NUMBER_FNS.has(spec.fn) && !fits('number')) return error(FORMULA_ERRORS.type);
  if (DATE_FNS.has(spec.fn) && !fits('date')) return error(FORMULA_ERRORS.type);
  if (CHECK_FNS.has(spec.fn) && !fits('boolean')) return error(FORMULA_ERRORS.type);

  const byId = new Map(got.rows.map((r) => [r.id, r]));
  const rows: RowRecord[] = [];
  for (const id of new Set(ids)) {
    const r = byId.get(id);
    if (r && !r.trashedAt && !r.isTemplate) rows.push(r);
  }
  const cells = rows.map((r) => cellOf(target, r));
  const count = rows.length;
  const empties = cells.filter(isEmptyCell).length;
  const numbers = cells.filter((c): c is number => typeof c === 'number');
  const fraction = (n: number) => (count ? n / count : null);
  const checked = cells.filter((c) => c === true).length;

  switch (spec.fn) {
    case 'count':
      return count;
    case 'countValues':
      return cells.reduce<number>(
        (n, c) => n + (Array.isArray(c) ? c.length : isEmptyCell(c) ? 0 : 1),
        0,
      );
    case 'countUnique': {
      const keys = new Set<string>();
      for (const c of cells) {
        if (isEmptyCell(c)) continue;
        if (Array.isArray(c)) for (const item of c) keys.add(`s:${item}`);
        else keys.add(uniqueKey(c));
      }
      return keys.size;
    }
    case 'countEmpty':
      return empties;
    case 'countNotEmpty':
      return count - empties;
    case 'percentEmpty':
      return fraction(empties);
    case 'percentNotEmpty':
      return fraction(count - empties);
    case 'sum':
      return finite(numbers.reduce((a, b) => a + b, 0));
    case 'average':
      return numbers.length ? finite(numbers.reduce((a, b) => a + b, 0) / numbers.length) : null;
    case 'median': {
      if (!numbers.length) return null;
      const sorted = [...numbers].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 ? sorted[mid] : finite((sorted[mid - 1] + sorted[mid]) / 2);
    }
    case 'min':
      return numbers.length ? Math.min(...numbers) : null;
    case 'max':
      return numbers.length ? Math.max(...numbers) : null;
    case 'range':
      return numbers.length ? finite(Math.max(...numbers) - Math.min(...numbers)) : null;
    case 'earliest':
    case 'latest': {
      let best: DateValue | null = null;
      for (const c of cells) {
        if (!isDate(c)) continue;
        const better =
          best === null ||
          (spec.fn === 'earliest'
            ? pointMs(c.start) < pointMs(best.start)
            : pointMs(c.start) > pointMs(best.start));
        if (better) best = c;
      }
      return best && { start: best.start };
    }
    case 'checked':
      return checked;
    case 'unchecked':
      return count - checked;
    case 'percentChecked':
      return fraction(checked);
    case 'showOriginal': {
      const items: string[] = [];
      for (const c of cells) {
        if (isEmptyCell(c)) continue;
        const value = formulaCell(target, c) as FormulaValue;
        if (Array.isArray(value)) items.push(...value);
        else if (value !== null) items.push(formatValue(value));
      }
      return items.length ? items : null;
    }
    default:
      return error(FORMULA_ERRORS.unknownFunction);
  }
}

function finite(n: number): CellValue {
  return Number.isFinite(n) ? (n === 0 ? 0 : n) : error(FORMULA_ERRORS.range);
}
