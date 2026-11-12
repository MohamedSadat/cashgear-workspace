// Workspace databases (Phase 4): the pure rules both ports keep, held to the C# port by the
// shared vectors in `packages/workspace/vectors/db-*.json`. No React, no DOM.
export * from './types';
export {
  OPTION_COLOURS,
  derivedOption,
  isOptionId,
  isPropertyId,
  newOptionId,
  newPropertyId,
} from './ids';
export { parseBoolean, parseNumberText, splitNames } from './text';
export {
  calendarDate,
  coerceDate,
  parseDatePoint,
  parseDateText,
  relativeDate,
  truncateDate,
} from './dates';
export {
  RELATION_LIMIT,
  canChangeType,
  convertProperty,
  convertValue,
  isOptionType,
} from './convert';
export {
  cellValue,
  coerceValue,
  dateText,
  isEmptyCell,
  isEmptyValue,
  numberText,
  optionIndex,
} from './values';
export {
  DEFAULT_DATE_BY,
  compareRows,
  groupKeys,
  matchesFilter,
  operatorsFor,
  propertyKind,
  queryRows,
  type QueryKind,
  type QueryOptions,
  type QueryResult,
} from './query';
export * from './formula';
export { computeRollup, formulaCell, type RelatedRows } from './rollup';
export { checkFormula, computeRow, evaluateFormula, type ComputeContext } from './compute';
export {
  applyRelationEdit,
  planRelationChange,
  relationTypeChangeEffects,
  type RelationEdit,
  type RelationPairingChange,
  type RowValues,
} from './relations';
export {
  CSV_MAX_BYTES,
  CSV_MAX_ROWS,
  cellText,
  guardCsvText,
  inferProperties,
  parseCsv,
  rowsToCsv,
  shownProperties,
  textToValue,
  unguardCsvText,
  utf8Length,
  type CsvLookups,
} from './csv';
