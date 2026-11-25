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
  uniqueIdText,
} from './values';
export {
  DEFAULT_DATE_BY,
  MAX_TREE_DEPTH,
  compareRows,
  groupKeys,
  inWindow,
  matchesFilter,
  operatorsFor,
  propertyKind,
  queryRows,
  windowSpan,
  type QueryKind,
  type QueryOptions,
  type QueryResult,
  type TreeLine,
} from './query';
// Phase 17: a database's tasks (sub-items, dependencies).
export { dependencyLoop, roleDef } from './dependencies';
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
// Phase 15: a database's rules. Only their types here: the rules' code is its own entry,
// `@cgw/workspace/automations`, imported by the screens that edit rules (loaded on demand) and the
// planner's lazy import, so the app's initial JavaScript holds none of it.
export type {
  AutomationRecord,
  AutomationStep,
  AutomationTrigger,
  BranchPath,
  RowChange,
  StepKind,
  StepValue,
  TriggerKind,
  TriggerValue,
  WaitFor,
} from './automations';
// Phase 17: a repeating row's repetition (its arithmetic is the rules' entry's too).
export type { RecurrenceRule, Weekday, WeekOfMonth } from './recurrence';
// Phase 16: a form view's questions. Only their types here: the rules' code is its own entry,
// `@cgw/workspace/forms`, imported by the form view (loaded with it).
export type {
  FormAnswer,
  FormCheck,
  FormConfig,
  FormLanguage,
  FormMode,
  FormPage,
  FormProblem,
  FormQuestion,
  ProblemReason,
  StoredForm,
} from './forms';
