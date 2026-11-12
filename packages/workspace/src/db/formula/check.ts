// The formula checker: every node's kind, found before anything is evaluated, so a formula that
// cannot work gives one error code in every row (Phase 4 contracts, section 2).
//
// Kinds: number, text, boolean, date, list (a multi-select's option names, people's, files' and
// related rows' ids, a rollup's original values); `empty` is a formula with no expression, which
// fits anything. Rules, checked left to right, children before the node itself:
//
//   - unary -, and - * / % ^ take numbers; not, and, or take booleans;
//   - + adds numbers, or joins text when either side is text (the other side as `format` writes it);
//   - == != take two of the same kind, not lists; < <= > >= take two numbers, texts or dates;
//   - a call: the function must exist (`formula.unknownFunction`), then its argument count fit
//     (`formula.arity`; `ifs` takes an odd number), then each argument's kind (`formula.type`), a
//     unit or date pattern written as text must be one the function takes (`formula.type`), and
//     `if` / `ifs` values must all be of one kind (`formula.type`);
//   - `prop` names a property that exists and is not deleted (`formula.unknownProperty`); a formula
//     it names that has an error gives that error.
import { FUNCTION_BY_NAME, argumentKinds, type ArgumentKind } from './functions';
import type { FormulaNode, StaticType } from './parser';

export const FORMULA_ERRORS = {
  syntax: 'formula.syntax',
  unknownProperty: 'formula.unknownProperty',
  unknownFunction: 'formula.unknownFunction',
  type: 'formula.type',
  arity: 'formula.arity',
  cycle: 'formula.cycle',
  divideByZero: 'formula.divideByZero',
  range: 'formula.range',
} as const;

export class FormulaError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'FormulaError';
  }
}

/** The kind a property gives formulas, or the error a reference to it gives. */
export type PropertyTypeOf = (id: string) => StaticType | { error: string };

const fits = (type: StaticType, kinds: readonly ArgumentKind[]) =>
  type === 'empty' || kinds.includes('any') || kinds.includes(type);

const typeError = () => new FormulaError(FORMULA_ERRORS.type);

function unify(a: StaticType, b: StaticType): StaticType {
  if (a === 'empty') return b;
  if (b === 'empty' || a === b) return a;
  throw typeError();
}

/** Checks a tree and marks each node's kind; throws `FormulaError`. */
export function checkTree(node: FormulaNode, typeOf: PropertyTypeOf): StaticType {
  const type = check(node, typeOf);
  node.type = type;
  return type;
}

function check(node: FormulaNode, typeOf: PropertyTypeOf): StaticType {
  switch (node.kind) {
    case 'number':
      return 'number';
    case 'string':
      return 'text';
    case 'boolean':
      return 'boolean';
    case 'prop': {
      const type = typeOf(node.id);
      if (typeof type !== 'string') throw new FormulaError(type.error);
      return type;
    }
    case 'unary': {
      const arg = checkTree(node.arg, typeOf);
      if (!fits(arg, [node.op === '-' ? 'number' : 'boolean'])) throw typeError();
      return node.op === '-' ? 'number' : 'boolean';
    }
    case 'binary': {
      const left = checkTree(node.left, typeOf);
      const right = checkTree(node.right, typeOf);
      switch (node.op) {
        case 'and':
        case 'or':
          if (!fits(left, ['boolean']) || !fits(right, ['boolean'])) throw typeError();
          return 'boolean';
        case '==':
        case '!=':
          if (left === 'list' || right === 'list') throw typeError();
          unify(left, right);
          return 'boolean';
        case '<':
        case '<=':
        case '>':
        case '>=': {
          const both = unify(left, right);
          if (both === 'list' || both === 'boolean') throw typeError();
          return 'boolean';
        }
        case '+':
          if (left === 'text' || right === 'text') return 'text';
          if (!fits(left, ['number']) || !fits(right, ['number'])) throw typeError();
          return 'number';
        default:
          if (!fits(left, ['number']) || !fits(right, ['number'])) throw typeError();
          return 'number';
      }
    }
    case 'call': {
      const fn = FUNCTION_BY_NAME.get(node.name);
      if (!fn) throw new FormulaError(FORMULA_ERRORS.unknownFunction);
      const n = node.args.length;
      if (n < fn.min || (fn.max !== null && n > fn.max) || (fn.name === 'ifs' && n % 2 === 0))
        throw new FormulaError(FORMULA_ERRORS.arity);
      const types = node.args.map((arg) => checkTree(arg, typeOf));
      types.forEach((type, i) => {
        const kinds: ArgumentKind[] =
          fn.name === 'ifs' && i === n - 1 ? ['any'] : argumentKinds(fn, i);
        if (!fits(type, kinds)) throw typeError();
      });
      if (fn.choices) {
        const arg = node.args[fn.choices.index];
        if (arg?.kind === 'string' && !fn.choices.values.includes(arg.value)) throw typeError();
      }
      if (fn.name === 'if') return unify(types[1], types[2]);
      if (fn.name === 'ifs') {
        let result: StaticType = types[n - 1];
        for (let i = 1; i < n - 1; i += 2) result = unify(result, types[i]);
        return result;
      }
      return fn.result as StaticType;
    }
  }
}
