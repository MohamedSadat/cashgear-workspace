// A database's formulas, parsed and checked once (cached per `properties` array and version):
// the order they are computed in, each one's kind, and the error a broken one gives.
//
// Formulas reading each other are put in dependency order; every formula in a cycle (a strongly
// connected group of two or more, or one that reads itself) is `formula.cycle`, found before
// kinds are checked; a formula reading a broken one gives that one's error.
import type {
  DatabaseRecord,
  PropertyDef,
  PropertyId,
  PropertyType,
  RollupFunction,
} from '../types';
import { FORMULA_ERRORS, FormulaError, checkTree, type PropertyTypeOf } from './check';
import { FormulaSyntaxError, parseFormula, type FormulaNode, type StaticType } from './parser';

export interface CompiledFormula {
  def: PropertyDef;
  /** Null for an empty expression (it gives empty) and for one that does not parse. */
  tree: FormulaNode | null;
  /** The result's kind; null when the formula has an error. */
  type: StaticType | null;
  error: string | null;
  /** For `formula.syntax`, where the problem starts. */
  at?: number;
}

export interface CompiledDatabase {
  database: DatabaseRecord;
  /** Every property by id, deleted ones included. */
  props: ReadonlyMap<PropertyId, PropertyDef>;
  formulas: ReadonlyMap<PropertyId, CompiledFormula>;
  /** The formulas not deleted, each after every formula it reads. */
  order: PropertyId[];
  /** The rollups not deleted, in database order. */
  rollups: PropertyDef[];
}

/** The kind a rollup gives formulas, filters and sorts. */
export function rollupType(fn: RollupFunction | undefined): StaticType {
  if (fn === 'earliest' || fn === 'latest') return 'date';
  if (fn === 'showOriginal') return 'list';
  return 'number';
}

/** The kind a property of a type gives formulas (formulas: see `CompiledDatabase`). */
export function typeOfProperty(type: PropertyType): StaticType {
  switch (type) {
    case 'number':
      return 'number';
    case 'checkbox':
      return 'boolean';
    case 'date':
    case 'createdTime':
    case 'lastEditedTime':
      return 'date';
    case 'multiSelect':
    case 'person':
    case 'files':
    case 'relation':
    case 'createdBy':
    case 'lastEditedBy':
      return 'list';
    default:
      return 'text';
  }
}

function propsOf(node: FormulaNode, into: Set<string>): Set<string> {
  switch (node.kind) {
    case 'prop':
      into.add(node.id);
      break;
    case 'unary':
      propsOf(node.arg, into);
      break;
    case 'binary':
      propsOf(node.left, into);
      propsOf(node.right, into);
      break;
    case 'call':
      for (const arg of node.args) propsOf(arg, into);
      break;
  }
  return into;
}

const cache = new WeakMap<
  readonly PropertyDef[],
  { version: number; compiled: CompiledDatabase }
>();

export function compileDatabase(database: DatabaseRecord): CompiledDatabase {
  const hit = cache.get(database.properties);
  if (hit && hit.version === database.version && hit.compiled.database.id === database.id)
    return hit.compiled;
  const compiled = compile(database);
  cache.set(database.properties, { version: database.version, compiled });
  return compiled;
}

function compile(database: DatabaseRecord): CompiledDatabase {
  const props = new Map<PropertyId, PropertyDef>();
  for (const def of database.properties) if (!props.has(def.id)) props.set(def.id, def);
  const formulas = new Map<PropertyId, CompiledFormula>();
  const reads = new Map<PropertyId, PropertyId[]>();
  for (const def of props.values()) {
    if (def.type !== 'formula' || def.trashedAt) continue;
    const expression = def.formula?.expression ?? '';
    const compiled: CompiledFormula = { def, tree: null, type: null, error: null };
    if (expression.trim() === '') compiled.type = 'empty';
    else
      try {
        compiled.tree = parseFormula(expression);
      } catch (error) {
        if (!(error instanceof FormulaSyntaxError)) throw error;
        compiled.error = FORMULA_ERRORS.syntax;
        compiled.at = error.at;
      }
    formulas.set(def.id, compiled);
    reads.set(def.id, compiled.tree ? [...propsOf(compiled.tree, new Set())] : []);
  }

  // Tarjan's strongly connected components: each comes out after every one it reads.
  const order: PropertyId[] = [];
  const index = new Map<PropertyId, number>();
  const low = new Map<PropertyId, number>();
  const stack: PropertyId[] = [];
  const onStack = new Set<PropertyId>();
  const visit = (id: PropertyId) => {
    index.set(id, index.size);
    low.set(id, index.get(id)!);
    stack.push(id);
    onStack.add(id);
    for (const next of reads.get(id) ?? []) {
      if (!formulas.has(next)) continue;
      if (!index.has(next)) {
        visit(next);
        low.set(id, Math.min(low.get(id)!, low.get(next)!));
      } else if (onStack.has(next)) low.set(id, Math.min(low.get(id)!, index.get(next)!));
    }
    if (low.get(id) !== index.get(id)) return;
    const group: PropertyId[] = [];
    let member: PropertyId;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      group.push(member);
    } while (member !== id);
    group.reverse();
    const cycle = group.length > 1 || (reads.get(id) ?? []).includes(id);
    for (const m of group) {
      if (cycle) formulas.get(m)!.error = FORMULA_ERRORS.cycle;
      order.push(m);
    }
  };
  for (const id of formulas.keys()) if (!index.has(id)) visit(id);

  const typeOf: PropertyTypeOf = (id) => {
    const def = props.get(id);
    if (!def || def.trashedAt) return { error: FORMULA_ERRORS.unknownProperty };
    if (def.type === 'formula') {
      const formula = formulas.get(id)!;
      return formula.error ? { error: formula.error } : (formula.type ?? 'empty');
    }
    if (def.type === 'rollup') return rollupType(def.rollup?.fn);
    return typeOfProperty(def.type);
  };
  for (const id of order) {
    const formula = formulas.get(id)!;
    if (formula.error || !formula.tree) continue;
    try {
      formula.type = checkTree(formula.tree, typeOf);
    } catch (error) {
      if (!(error instanceof FormulaError)) throw error;
      formula.error = error.code;
    }
  }

  const rollups = [...props.values()].filter((def) => def.type === 'rollup' && !def.trashedAt);
  return { database, props, formulas, order, rollups };
}
