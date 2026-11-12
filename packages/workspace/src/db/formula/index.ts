// The formula language (Phase 4 contracts, section 2): parser.ts (grammar), check.ts (kinds),
// evaluate.ts (behaviour), functions.ts (the fixed list), names.ts (ids and names), compile.ts
// (a database's formulas in order). `computeRow` (compute.ts) runs them.
export { FORMULA_ERRORS, FormulaError } from './check';
export {
  compileDatabase,
  rollupType,
  typeOfProperty,
  type CompiledDatabase,
  type CompiledFormula,
} from './compile';
export { formatValue, type FormulaValue } from './evaluate';
export {
  DATE_PATTERNS,
  DATE_UNITS,
  FUNCTIONS,
  FUNCTION_BY_NAME,
  argumentKinds,
  type ArgumentKind,
  type DateUnit,
  type FormulaFunction,
} from './functions';
export { formulaToIds, formulaToNames } from './names';
export {
  FormulaSyntaxError,
  parseFormula,
  tokenize,
  type FormulaNode,
  type FormulaType,
  type StaticType,
  type Token,
} from './parser';
