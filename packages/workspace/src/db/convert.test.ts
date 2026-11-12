import { describe, expect, it } from 'vitest';
import { canChangeType, convertProperty, convertValue } from './convert';
import { STORED_TYPES, type PropertyDef, type PropertyType, type Value } from './types';
import { coerceValue } from './values';
import {
  ALICE,
  DB,
  MULTI_OPTIONS,
  P,
  SELECT_OPTIONS,
  TITLE,
  prop,
  rowId,
} from './vectors/fixtures';

/** One value of each stored type, and one def of each type to convert to. */
const SAMPLES: Record<string, { def: PropertyDef; value: Value }> = {
  text: { def: P.text, value: 'Done' },
  number: { def: P.number, value: 5 },
  date: { def: P.date, value: { start: '2026-03-01' } },
  checkbox: { def: P.checkbox, value: true },
  select: { def: P.select, value: 'optDone1' },
  multiSelect: { def: P.multi, value: ['tagRed01'] },
  status: { def: P.status, value: 'staDone1' },
  person: { def: P.person, value: [ALICE] },
  url: { def: P.url, value: 'https://a.example' },
  email: { def: P.email, value: 'a@b.co' },
  phone: { def: P.phone, value: '123' },
  files: { def: P.files, value: ['asset-1'] },
  relation: { def: P.relation, value: [rowId(1)] },
};

describe('the conversion table', () => {
  it('has a stated result for every pair of stored types, and it is a value of the new type', () => {
    for (const from of STORED_TYPES)
      for (const to of STORED_TYPES) {
        const source = SAMPLES[from];
        const target = { ...SAMPLES[to].def, id: source.def.id };
        const converted = convertValue(source.def, target, source.value);
        // Whatever a conversion gives, writing it again keeps it: it is already of the new type.
        if (converted !== undefined)
          expect(coerceValue(target, converted), `${from} → ${to}`).toEqual(converted);
        if (from === to) expect(converted, `${from} → ${to}`).toEqual(source.value);
      }
  });

  it('never lets the title change type', () => {
    expect(canChangeType('title', 'text')).toBe(false);
    expect(canChangeType('text', 'title')).toBe(false);
    expect(canChangeType('title', 'title')).toBe(true);
    expect(canChangeType('text', 'formula')).toBe(true);
    expect(() => convertProperty(TITLE, { ...TITLE, type: 'text' }, [], DB)).toThrow();
  });

  it('gives nothing for a type that stores nothing', () => {
    const computedTypes: PropertyType[] = [
      'formula',
      'rollup',
      'createdTime',
      'createdBy',
      'lastEditedTime',
      'lastEditedBy',
    ];
    for (const type of computedTypes)
      for (const from of STORED_TYPES)
        expect(
          convertValue(SAMPLES[from].def, prop('pX000001', type), SAMPLES[from].value),
        ).toBeUndefined();
  });

  it('round-trips options through text by name', () => {
    const text = convertProperty(P.select, prop('pSel0001', 'text'), ['optDone1', 'optLate1'], DB);
    expect(text.values).toEqual(['Done', 'متأخر']);
    const back = convertProperty(prop('pSel0001', 'text'), { ...P.select }, text.values, DB);
    expect(back.values).toEqual(['optDone1', 'optLate1']);
    expect(back.def.options).toEqual(SELECT_OPTIONS);
  });

  it('makes the same options on every device for the same values, wherever they start', () => {
    const values = ['b', 'a', 'b', 'c'];
    const one = convertProperty(P.text, prop('pText001', 'multiSelect'), values, DB);
    const other = convertProperty(P.text, prop('pText001', 'multiSelect'), values.slice(0, 2), DB);
    expect(other.def.options).toEqual(one.def.options!.slice(0, 2));
    expect(other.values).toEqual(one.values.slice(0, 2));
  });

  it('copies the old options when going between option types, the given ones first', () => {
    const given = { id: 'tagNew01', name: 'New', colour: 'blue' as const };
    const result = convertProperty(
      P.multi,
      prop('pMul0001', 'select', { options: [given] }),
      [['tagBlue1']],
      DB,
    );
    expect(result.def.options).toEqual([given, ...MULTI_OPTIONS]);
    expect(result.values).toEqual(['tagBlue1']);
  });
});
