// A row's formulas and rollups (Phase 4 contracts, section 2): rollups first, then formulas in
// dependency order. The server keeps its results in `computed` with `computedVersion`; a device
// shows and filters by its own where it holds the inputs. Shared vectors:
// db-formula-vectors.json, db-compute-vectors.json.
import type { RowRecord } from '../types';
import { compileDatabase, type CompiledDatabase } from './formula/compile';
import { FormulaError } from './formula/check';
import { evaluateTree, finishValue, type FormulaValue } from './formula/evaluate';
import type { StaticType } from './formula/parser';
import { computeRollup, formulaCell, type RelatedRows } from './rollup';
import type { CellValue, DatabaseRecord, DateValue, PropertyDef, PropertyId } from './types';
import { DATE_POINT } from './dates';
import { isErrorCell } from './convert';
import { cellOf } from './values';

export type { RelatedRows } from './rollup';

export interface ComputeContext {
  /** The database compiled once for many rows (`compileDatabase`); found from a cache when absent. */
  compiled?: CompiledDatabase;
}

/** A value read by a formula, made to fit its static kind (else empty). */
function fit(value: CellValue, type: StaticType): FormulaValue {
  if (value === null || isErrorCell(value)) return null;
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    case 'text':
      return typeof value === 'string' ? value : null;
    case 'boolean':
      return typeof value === 'boolean' ? value : null;
    case 'list':
      return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : null;
    case 'date': {
      const date = value as DateValue;
      if (typeof value !== 'object' || Array.isArray(value) || !DATE_POINT.test(date.start ?? ''))
        return null;
      return date.end && DATE_POINT.test(date.end)
        ? { start: date.start, end: date.end }
        : { start: date.start };
    }
    default:
      return value as FormulaValue;
  }
}

/**
 * Every formula's and rollup's result on `row`. A rollup whose related rows are not held here is
 * left out (the server's `computed` stands for it, and formulas read that); a formula is always
 * there. Deleted properties compute nothing.
 */
export function computeRow(
  database: DatabaseRecord,
  row: RowRecord,
  related: RelatedRows,
  ctx: ComputeContext = {},
): Record<PropertyId, CellValue> {
  const compiled = ctx.compiled ?? compileDatabase(database);
  const results: Record<PropertyId, CellValue> = {};
  for (const def of compiled.rollups) {
    const value = computeRollup(database, def, row, related);
    if (value !== undefined) results[def.id] = value;
  }
  const read = (def: PropertyDef): CellValue => {
    if (def.type === 'formula') return results[def.id] ?? null;
    if (def.type === 'rollup')
      return def.id in results ? results[def.id] : (row.computed?.[def.id] ?? null);
    return formulaCell(def, cellOf(def, row));
  };
  for (const id of compiled.order) {
    const formula = compiled.formulas.get(id)!;
    if (formula.error) {
      results[id] = { error: formula.error };
      continue;
    }
    if (!formula.tree) {
      results[id] = null;
      continue;
    }
    try {
      const value = evaluateTree(formula.tree, {
        prop: (propId, type) => {
          const value = read(compiled.props.get(propId)!);
          if (isErrorCell(value)) throw new FormulaError(value.error);
          return fit(value, type);
        },
      });
      results[id] = finishValue(value);
    } catch (error) {
      if (!(error instanceof FormulaError)) throw error;
      results[id] = { error: error.code };
    }
  }
  return results;
}

const EXPRESSION = '\u0000expression';

/**
 * An expression evaluated on a row as if it were one more formula property of its database (the
 * formula editor's preview, the shared vectors): its result and kind (null with an error).
 */
export function evaluateFormula(
  database: DatabaseRecord,
  row: RowRecord,
  expression: string,
  related: RelatedRows = () => null,
): { value: CellValue; type: StaticType | null } {
  const withExpression: DatabaseRecord = {
    ...database,
    properties: [
      ...database.properties,
      { id: EXPRESSION, name: '', type: 'formula', formula: { expression } },
    ],
  };
  const compiled = compileDatabase(withExpression);
  const value = computeRow(withExpression, row, related, { compiled })[EXPRESSION];
  return { value, type: compiled.formulas.get(EXPRESSION)!.type };
}

/**
 * An expression checked against a database without a row: its kind, or the error every row would
 * give (`at`: where a syntax error starts).
 */
export function checkFormula(
  database: DatabaseRecord,
  expression: string,
): { type: StaticType } | { error: string; at?: number } {
  const compiled = compileDatabase({
    ...database,
    properties: [
      ...database.properties,
      { id: EXPRESSION, name: '', type: 'formula', formula: { expression } },
    ],
  });
  const formula = compiled.formulas.get(EXPRESSION)!;
  if (formula.error)
    return formula.at === undefined
      ? { error: formula.error }
      : { error: formula.error, at: formula.at };
  return { type: formula.type ?? 'empty' };
}
