// The formula language's lexer and parser (Phase 4 contracts, section 2). A formula is stored
// with properties named by id, `prop("Ab12Cd34")`; the editor shows names (names.ts).
//
// Grammar, by precedence from low to high:
//
//   or      := and (('or' | '||') and)*
//   and     := not (('and' | '&&') not)*
//   not     := ('not' | '!') not | compare
//   compare := add (('==' | '!=' | '<' | '<=' | '>' | '>=') add)*
//   add     := mul (('+' | '-') mul)*
//   mul     := unary (('*' | '/' | '%') unary)*
//   unary   := '-' unary | power
//   power   := primary ('^' unary)?           (right-associative: 2^3^2 is 2^(3^2))
//   primary := number | string | 'true' | 'false' | 'prop' '(' string ')'
//            | name '(' (or (',' or)*)? ')' | '(' or ')'
//
// Numbers are `\d+(\.\d+)?([eE][+-]?\d+)?`; strings are in double quotes with `\"` and `\\` the
// only escapes; names are `[A-Za-z_][A-Za-z0-9_]*` and case matters; white space is JavaScript's
// `\s`. Anything else is `formula.syntax`.

export const SYNTAX = 'formula.syntax';

export class FormulaSyntaxError extends Error {
  readonly code = SYNTAX;
  constructor(
    /** Where in the expression (a UTF-16 offset) the problem starts. */
    readonly at: number,
    message: string,
  ) {
    super(message);
    this.name = 'FormulaSyntaxError';
  }
}

export interface Token {
  kind: 'number' | 'string' | 'name' | 'op' | 'end';
  /** The source text of the token. */
  text: string;
  /** A string's value (escapes read) or a number's. */
  value?: string | number;
  start: number;
  end: number;
}

const OPERATORS = [
  '||',
  '&&',
  '==',
  '!=',
  '<=',
  '>=',
  '!',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '(',
  ')',
  ',',
];
const NUMBER = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const SPACE = /\s/;

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (SPACE.test(c)) {
      i++;
      continue;
    }
    if (c >= '0' && c <= '9') {
      NUMBER.lastIndex = i;
      const text = NUMBER.exec(source)![0];
      tokens.push({ kind: 'number', text, value: Number(text), start: i, end: i + text.length });
      i += text.length;
      continue;
    }
    if (c === '"') {
      let value = '';
      let j = i + 1;
      for (;;) {
        if (j >= source.length) throw new FormulaSyntaxError(i, 'The text is not closed');
        const d = source[j];
        if (d === '"') break;
        if (d === '\\') {
          const next = source[j + 1];
          if (next !== '"' && next !== '\\') throw new FormulaSyntaxError(j, 'Unknown escape');
          value += next;
          j += 2;
          continue;
        }
        value += d;
        j++;
      }
      tokens.push({ kind: 'string', text: source.slice(i, j + 1), value, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    NAME.lastIndex = i;
    const name = NAME.exec(source);
    if (name) {
      const text = name[0];
      tokens.push({ kind: 'name', text, start: i, end: i + text.length });
      i += text.length;
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (!op) throw new FormulaSyntaxError(i, `Unexpected ${c}`);
    tokens.push({ kind: 'op', text: op, start: i, end: i + op.length });
    i += op.length;
  }
  tokens.push({ kind: 'end', text: '', start: source.length, end: source.length });
  return tokens;
}

export type BinaryOp =
  'or' | 'and' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%' | '^';

/** The static kind a node was found to have (check.ts); `empty` fits anything. */
export type FormulaType = 'number' | 'text' | 'boolean' | 'date' | 'list';
export type StaticType = FormulaType | 'empty';

interface At {
  start: number;
  end: number;
  /** Set by the checker. */
  type?: StaticType;
}

export type FormulaNode =
  | (At & { kind: 'number'; value: number })
  | (At & { kind: 'string'; value: string })
  | (At & { kind: 'boolean'; value: boolean })
  | (At & { kind: 'prop'; id: string })
  | (At & { kind: 'call'; name: string; args: FormulaNode[] })
  | (At & { kind: 'unary'; op: '-' | 'not'; arg: FormulaNode })
  | (At & { kind: 'binary'; op: BinaryOp; left: FormulaNode; right: FormulaNode });

const KEYWORDS = new Set(['true', 'false', 'and', 'or', 'not']);

/** The tree of an expression; throws `FormulaSyntaxError`. */
export function parseFormula(source: string): FormulaNode {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (...ops: string[]) => peek().kind === 'op' && ops.includes(peek().text);
  const isWord = (...words: string[]) => peek().kind === 'name' && words.includes(peek().text);
  const fail = (token: Token = peek()): never => {
    throw new FormulaSyntaxError(
      token.start,
      token.kind === 'end' ? 'The formula ends too soon' : `Unexpected ${token.text}`,
    );
  };
  const expect = (op: string) => {
    if (!isOp(op)) fail();
    return tokens[pos++];
  };
  const binary = (op: BinaryOp, left: FormulaNode, right: FormulaNode): FormulaNode => ({
    kind: 'binary',
    op,
    left,
    right,
    start: left.start,
    end: right.end,
  });

  function or(): FormulaNode {
    let left = and();
    while (isOp('||') || isWord('or')) {
      pos++;
      left = binary('or', left, and());
    }
    return left;
  }
  function and(): FormulaNode {
    let left = not();
    while (isOp('&&') || isWord('and')) {
      pos++;
      left = binary('and', left, not());
    }
    return left;
  }
  function not(): FormulaNode {
    if (isOp('!') || isWord('not')) {
      const start = tokens[pos++].start;
      const arg = not();
      return { kind: 'unary', op: 'not', arg, start, end: arg.end };
    }
    return compare();
  }
  function compare(): FormulaNode {
    let left = add();
    while (isOp('==', '!=', '<', '<=', '>', '>=')) {
      const op = tokens[pos++].text as BinaryOp;
      left = binary(op, left, add());
    }
    return left;
  }
  function add(): FormulaNode {
    let left = mul();
    while (isOp('+', '-')) {
      const op = tokens[pos++].text as BinaryOp;
      left = binary(op, left, mul());
    }
    return left;
  }
  function mul(): FormulaNode {
    let left = unary();
    while (isOp('*', '/', '%')) {
      const op = tokens[pos++].text as BinaryOp;
      left = binary(op, left, unary());
    }
    return left;
  }
  function unary(): FormulaNode {
    if (isOp('-')) {
      const start = tokens[pos++].start;
      const arg = unary();
      return { kind: 'unary', op: '-', arg, start, end: arg.end };
    }
    return power();
  }
  function power(): FormulaNode {
    const base = primary();
    if (!isOp('^')) return base;
    pos++;
    return binary('^', base, unary());
  }
  function primary(): FormulaNode {
    const token = peek();
    if (token.kind === 'number') {
      pos++;
      return { kind: 'number', value: token.value as number, start: token.start, end: token.end };
    }
    if (token.kind === 'string') {
      pos++;
      return { kind: 'string', value: token.value as string, start: token.start, end: token.end };
    }
    if (isOp('(')) {
      pos++;
      const inner = or();
      const close = expect(')');
      return { ...inner, start: token.start, end: close.end };
    }
    if (token.kind !== 'name') return fail();
    if (token.text === 'true' || token.text === 'false') {
      pos++;
      return { kind: 'boolean', value: token.text === 'true', start: token.start, end: token.end };
    }
    if (KEYWORDS.has(token.text)) return fail();
    pos++;
    if (!isOp('(')) return fail();
    pos++;
    if (token.text === 'prop') {
      const id = peek();
      if (id.kind !== 'string') return fail(id);
      pos++;
      const close = expect(')');
      return { kind: 'prop', id: id.value as string, start: token.start, end: close.end };
    }
    const args: FormulaNode[] = [];
    if (!isOp(')')) {
      args.push(or());
      while (isOp(',')) {
        pos++;
        args.push(or());
      }
    }
    const close = expect(')');
    return { kind: 'call', name: token.text, args, start: token.start, end: close.end };
  }

  const tree = or();
  if (peek().kind !== 'end') fail();
  return tree;
}
