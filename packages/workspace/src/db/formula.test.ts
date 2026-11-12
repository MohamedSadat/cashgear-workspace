import { describe, expect, it } from 'vitest';
import type { RowRecord } from '../types';
import { checkFormula, computeRow, evaluateFormula } from './compute';
import { FUNCTIONS, FUNCTION_BY_NAME, argumentKinds } from './formula/functions';
import { formulaToIds, formulaToNames } from './formula/names';
import { FormulaSyntaxError, parseFormula, tokenize } from './formula/parser';
import { compileDatabase } from './formula/compile';
import type { DatabaseRecord } from './types';
import { P, TITLE, database, prop, row } from './vectors/fixtures';

const DB_ = database([TITLE, P.number, P.text]) as DatabaseRecord;
const ROW = row(1, { values: { pNum0001: 2, pText001: 'x' } }) as RowRecord;

describe('the parser', () => {
  it('says where a syntax error starts', () => {
    const at = (source: string) => {
      try {
        parseFormula(source);
        return -1;
      } catch (error) {
        return (error as FormulaSyntaxError).at;
      }
    };
    expect(at('1 + ')).toBe(4);
    expect(at('1 + @')).toBe(4);
    expect(at('"abc')).toBe(0);
    expect(at('abs(1')).toBe(5);
    expect(at('"a\\q"')).toBe(2);
    expect(checkFormula(DB_, '(1 +')).toEqual({ error: 'formula.syntax', at: 4 });
  });

  it('keeps token positions for rewriting', () => {
    const tokens = tokenize('prop("Ab12Cd34") + 1');
    expect(tokens.map((t) => [t.kind, t.start, t.end])).toEqual([
      ['name', 0, 4],
      ['op', 4, 5],
      ['string', 5, 15],
      ['op', 15, 16],
      ['op', 17, 18],
      ['number', 19, 20],
      ['end', 20, 20],
    ]);
  });

  it('binds by the stated precedence', () => {
    const value = (source: string) => evaluateFormula(DB_, ROW, source).value;
    expect(value('1 + 2 * 3 ^ 2')).toBe(19);
    expect(value('not 1 < 2 or true')).toBe(true);
    expect(value('1 < 2 and 2 < 1 or 3 > 2')).toBe(true);
    expect(value('-3 ^ 2 * 2')).toBe(-18);
  });
});

describe('names and ids', () => {
  it('round-trip every property name', () => {
    const named = database([
      TITLE,
      prop('pA000001', 'number', {}, 'Price (USD)'),
      prop('pB000001', 'number', {}, 'a "quoted" \\ name'),
      prop('pC000001', 'number', {}, 'السعر'),
    ]) as DatabaseRecord;
    const stored = 'prop("pA000001") * prop("pB000001") + prop("pC000001") + length(prop("title"))';
    const shown = formulaToNames(named, stored);
    expect(shown).toBe(
      'prop("Price (USD)") * prop("a \\"quoted\\" \\\\ name") + prop("السعر") + length(prop("Name"))',
    );
    expect(formulaToIds(named, shown)).toBe(stored);
  });
});

describe('the function list', () => {
  it('holds each function once, with sane arities and argument kinds', () => {
    expect(new Set(FUNCTIONS.map((f) => f.name)).size).toBe(FUNCTIONS.length);
    for (const fn of FUNCTIONS) {
      expect(fn.min).toBeGreaterThanOrEqual(1);
      if (fn.max !== null) expect(fn.max).toBeGreaterThanOrEqual(fn.min);
      for (let i = 0; i < (fn.max ?? fn.min + 4); i++)
        expect(argumentKinds(fn, i).length).toBeGreaterThan(0);
    }
    expect(FUNCTION_BY_NAME.get('ifs')!.max).toBeNull();
    expect(argumentKinds(FUNCTION_BY_NAME.get('join')!, 5)).toEqual(['any']);
  });

  it('is what the evaluator runs: every function evaluates and gives its stated kind', () => {
    const withAll = database([
      TITLE,
      P.number,
      P.text,
      prop('pD000001', 'date', {}, 'Due'),
      prop(
        'pL000001',
        'multiSelect',
        { options: [{ id: 'o1', name: 'A', colour: 'red' }] },
        'Tags',
      ),
    ]) as DatabaseRecord;
    const r = row(1, {
      values: { pD000001: { start: '2026-01-31' }, pL000001: ['o1'] },
    }) as RowRecord;
    const sample = (kinds: readonly string[]) => {
      const kind = kinds.includes('any') ? 'number' : kinds[0];
      return {
        number: '2',
        text: '"days"',
        boolean: 'true',
        date: 'prop("pD000001")',
        list: 'prop("pL000001")',
      }[kind]!;
    };
    for (const fn of FUNCTIONS) {
      const count = fn.name === 'ifs' ? 3 : fn.min;
      const args = Array.from({ length: count }, (_, i) => {
        if (fn.choices?.index === i) return `"${fn.choices.values[0]}"`;
        return sample(fn.name === 'ifs' && i === count - 1 ? ['any'] : argumentKinds(fn, i));
      });
      const { value, type } = evaluateFormula(withAll, r, `${fn.name}(${args.join(', ')})`);
      expect(value, fn.name).not.toEqual({ error: 'formula.unknownFunction' });
      expect(
        value && typeof value === 'object' && 'error' in value ? value : null,
        fn.name,
      ).toBeNull();
      expect(type, fn.name).toBe(fn.result === 'same' ? 'number' : fn.result);
    }
  });
});

describe('computing', () => {
  it('compiles a database once per version of its properties', () => {
    const db = database([
      TITLE,
      P.number,
      prop('pF000001', 'formula', { formula: { expression: 'prop("pNum0001") + 1' } }),
    ]) as DatabaseRecord;
    const compiled = compileDatabase(db);
    expect(compileDatabase(db)).toBe(compiled);
    expect(compileDatabase({ ...db, version: 2 })).not.toBe(compiled);
    expect(computeRow(db, ROW, () => null, { compiled })).toEqual({ pF000001: 3 });
  });

  it('gives a cycle to every formula in it and only to them', () => {
    const f = (id: string, expression: string) => prop(id, 'formula', { formula: { expression } });
    const db = database([
      TITLE,
      f('fA000001', 'prop("fB000001")'),
      f('fB000001', 'prop("fC000001")'),
      f('fC000001', 'prop("fA000001")'),
      f('fD000001', '1'),
      f('fE000001', 'prop("fD000001") + prop("fA000001")'),
    ]) as DatabaseRecord;
    const result = computeRow(db, ROW, () => null);
    expect(result).toEqual({
      fA000001: { error: 'formula.cycle' },
      fB000001: { error: 'formula.cycle' },
      fC000001: { error: 'formula.cycle' },
      fD000001: 1,
      fE000001: { error: 'formula.cycle' },
    });
    expect(compileDatabase(db).order.indexOf('fD000001')).toBeLessThan(
      compileDatabase(db).order.indexOf('fE000001'),
    );
  });
});
