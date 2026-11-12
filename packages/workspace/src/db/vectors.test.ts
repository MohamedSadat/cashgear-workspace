// The shared vectors (packages/workspace/vectors/db-*.json), the contract with the C# port. The
// cases and their hand-written expectations are in ./vectors/*.cases.ts; this test checks each
// JSON file holds exactly those cases (rewrite them with `DB_VECTORS_WRITE=1`, then Prettier), and
// that the implementation gives every expected answer read from the JSON.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RowRecord } from '../types';
import { convertProperty, convertValue } from './convert';
import { computeRow, evaluateFormula } from './compute';
import { inferProperties, parseCsv, rowsToCsv, textToValue } from './csv';
import { FORMULA_ERRORS } from './formula/check';
import { FUNCTIONS } from './formula/functions';
import { formulaToIds, formulaToNames } from './formula/names';
import { derivedOption } from './ids';
import { queryRows } from './query';
import { applyRelationEdit, planRelationChange, relationTypeChangeEffects } from './relations';
import { parseBoolean, parseNumberText, numberText } from './text';
import { parseDateText } from './dates';
import type { DatabaseRecord, PropertyDef } from './types';
import { cellValue, coerceValue } from './values';
import { computeVectors, type ComputeSuite } from './vectors/compute.cases';
import { convertVectors, type ConvertCase } from './vectors/convert.cases';
import { csvVectors, type CsvCase } from './vectors/csv.cases';
import { formulaVectors, type FormulaSuite } from './vectors/formula.cases';
import { queryVectors, type QuerySuite } from './vectors/query.cases';

const WRITE = process.env.DB_VECTORS_WRITE === '1';
const file = (name: string) => new URL(`../../vectors/${name}`, import.meta.url);

/** JSON with invisible format characters escaped, so the files read the same in any editor. */
const toJson = (value: unknown) =>
  JSON.stringify(value, null, 2).replace(
    /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  ) + '\n';

function vectors<T>(name: string, cases: T): T {
  if (WRITE) writeFileSync(file(name), toJson(cases));
  const onDisk = JSON.parse(readFileSync(file(name), 'utf8')) as T;
  it(`${name} holds the cases as written`, () => {
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(cases)));
  });
  return onDisk;
}

/** What the vectors write for no value. */
const json = (value: unknown) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const asRow = (row: unknown) => row as RowRecord;
const asDb = (db: unknown) =>
  ({ workspaceId: '', rowCount: 0, createdAt: '', ...(db as object) }) as DatabaseRecord;

describe('db-convert-vectors.json', () => {
  for (const c of vectors<ConvertCase[]>('db-convert-vectors.json', convertVectors)) {
    it(`${c.kind}: ${c.name}`, () => {
      const x = c as Record<string, unknown>;
      switch (c.kind) {
        case 'coerce':
          return expect(json(coerceValue(x.def as PropertyDef, x.raw))).toEqual(x.expected);
        case 'convert':
          return expect(
            json(convertValue(x.from as PropertyDef, x.to as PropertyDef, x.value as never)),
          ).toEqual(x.expected);
        case 'convertProperty': {
          const result = convertProperty(
            x.from as PropertyDef,
            x.to as PropertyDef,
            x.values as never[],
            x.databaseId as string,
          );
          return expect(json({ def: result.def, values: result.values.map(json) })).toEqual(
            x.expected,
          );
        }
        case 'derivedOption':
          return expect(
            derivedOption(
              x.databaseId as string,
              x.propertyId as string,
              x.optionName as string,
              new Set(x.taken as string[]),
            ),
          ).toEqual(x.expected);
        case 'numberText':
          return expect(numberText(x.value as number)).toBe(x.expected);
        case 'parseNumber':
          return expect(json(parseNumberText(x.text as string))).toEqual(x.expected);
        case 'parseBoolean':
          return expect(json(parseBoolean(x.text as string))).toEqual(x.expected);
        case 'parseDate':
          return expect(json(parseDateText(x.text as string))).toEqual(x.expected);
        case 'cells':
          for (const one of x.cases as Record<string, unknown>[])
            expect(
              json(
                cellValue(
                  asDb(x.database),
                  asRow(one.row),
                  one.propertyId as string,
                  (one.computed as never) ?? undefined,
                ),
              ),
              one.name as string,
            ).toEqual(one.expected);
          return;
        default:
          throw new Error(`Unknown case ${c.kind}`);
      }
    });
  }
});

describe('db-query-vectors.json', () => {
  for (const suite of vectors<QuerySuite[]>('db-query-vectors.json', queryVectors))
    describe(suite.name, () => {
      for (const c of suite.cases)
        it(c.name, () => {
          const result = queryRows(asDb(suite.database), suite.rows.map(asRow), c.spec, c.ctx, {
            groupKey: c.groupKey,
          });
          expect({ rows: result.rows.map((r) => r.id), groups: result.groups }).toEqual(c.expected);
        });
    });
});

describe('db-formula-vectors.json', () => {
  for (const suite of vectors<FormulaSuite[]>('db-formula-vectors.json', formulaVectors))
    describe(`${suite.kind}: ${suite.name}`, () => {
      for (const c of suite.cases)
        it(c.expression || '(empty)', () => {
          const db = asDb(suite.database);
          if (suite.kind === 'toNames')
            return expect(formulaToNames(db, c.expression)).toBe(c.expected);
          if (suite.kind === 'toIds')
            return expect(formulaToIds(db, c.expression)).toBe(c.expected);
          expect(json(evaluateFormula(db, asRow(suite.row), c.expression))).toEqual(c.expected);
        });
    });
});

describe('db-compute-vectors.json', () => {
  for (const suite of vectors<ComputeSuite[]>('db-compute-vectors.json', computeVectors))
    describe(`${suite.kind}: ${suite.name}`, () => {
      if (suite.kind === 'computeRow') {
        const related = (databaseId: string, rowIds: string[]) => {
          const held = suite.held.find((d) => d.id === databaseId);
          if (!held) return null;
          return {
            database: asDb(held),
            rows: suite.rows
              .filter((r) => r.databaseId === databaseId && rowIds.includes(r.id))
              .map(asRow),
          };
        };
        for (const c of suite.cases)
          it(c.name, () => {
            expect(json(computeRow(asDb(suite.database), asRow(c.row), related))).toEqual(
              c.expected,
            );
          });
      } else if (suite.kind === 'relationChange') {
        for (const c of suite.cases)
          it(c.name, () => {
            expect(planRelationChange(asDb(suite.database), c.before, c.after)).toEqual(c.expected);
          });
      } else if (suite.kind === 'relationTypeChange') {
        for (const c of suite.cases)
          it(c.name, () => {
            expect(
              relationTypeChangeEffects(
                asDb(suite.database),
                c.before,
                c.after,
                c.target && asDb(c.target),
              ),
            ).toEqual(c.expected);
          });
      } else {
        for (const c of suite.cases)
          it(c.name, () => {
            expect(json(applyRelationEdit(c.current ?? undefined, c.edit))).toEqual(c.expected);
          });
      }
    });
});

describe('db-csv-vectors.json', () => {
  for (const c of vectors<CsvCase[]>('db-csv-vectors.json', csvVectors))
    it(`${c.kind}: ${c.name}`, () => {
      switch (c.kind) {
        case 'parse':
          return expect(parseCsv(c.text)).toEqual(c.expected);
        case 'infer': {
          const [header, ...rest] = [c.header, ...c.rows];
          const defs = inferProperties(header, rest);
          return expect(
            defs.map((d) => ({
              name: d.name,
              type: d.type,
              ...(d.options ? { options: d.options.map((o) => o.name) } : {}),
              ...(d.date ? { includeTime: d.date.includeTime } : {}),
            })),
          ).toEqual(c.expected);
        }
        case 'textToValue':
          return expect(json(textToValue(c.def, c.text))).toEqual(c.expected);
        case 'export':
          return expect(
            rowsToCsv(asDb(c.database), c.view as never, c.rows.map(asRow), c.lookups),
          ).toBe(c.expected);
      }
    });
});

describe('the vectors cover', () => {
  const text = (name: string) => readFileSync(file(name), 'utf8');
  it('every filter operator and sort direction', () => {
    const query = text('db-query-vectors.json');
    for (const op of [
      'is',
      'isNot',
      'contains',
      'doesNotContain',
      'startsWith',
      'endsWith',
      'isEmpty',
      'isNotEmpty',
      'eq',
      'ne',
      'gt',
      'lt',
      'ge',
      'le',
      'before',
      'after',
      'onOrBefore',
      'onOrAfter',
      'group',
    ])
      expect(query, op).toContain(`"operator": "${op}"`);
    for (const relative of [
      'today',
      'tomorrow',
      'yesterday',
      'oneWeekAgo',
      'oneWeekFromNow',
      'oneMonthAgo',
      'oneMonthFromNow',
    ])
      expect(query, relative).toContain(`"relative": "${relative}"`);
    for (const by of ['day', 'week', 'year']) expect(query, by).toContain(`"dateBy": "${by}"`);
    expect(query).toContain('"direction": "desc"');
    expect(query).toContain('"hideEmpty": true');
  });

  it('every rollup function', () => {
    const compute = text('db-compute-vectors.json');
    for (const fn of [
      'count',
      'countValues',
      'countUnique',
      'countEmpty',
      'countNotEmpty',
      'percentEmpty',
      'percentNotEmpty',
      'sum',
      'average',
      'median',
      'min',
      'max',
      'range',
      'earliest',
      'latest',
      'checked',
      'unchecked',
      'percentChecked',
      'showOriginal',
    ])
      expect(compute, fn).toContain(`"fn": "${fn}"`);
  });

  it('every formula function and error code', () => {
    const expressions = formulaVectors.flatMap((s) => s.cases.map((c) => c.expression)).join('\n');
    for (const fn of FUNCTIONS)
      expect(expressions, fn.name).toMatch(new RegExp(`\\b${fn.name}\\(`));
    const formulas = text('db-formula-vectors.json');
    for (const code of Object.values(FORMULA_ERRORS)) expect(formulas, code).toContain(`"${code}"`);
  });

  it('every property type, coerced and converted', () => {
    const types = [
      'title',
      'text',
      'number',
      'date',
      'checkbox',
      'select',
      'multiSelect',
      'status',
      'person',
      'url',
      'email',
      'phone',
      'files',
      'relation',
      'formula',
      'rollup',
      'createdTime',
      'createdBy',
      'lastEditedTime',
      'lastEditedBy',
    ];
    const coerced = new Set(
      convertVectors.filter((c) => c.kind === 'coerce').map((c) => (c.def as PropertyDef).type),
    );
    const converted = new Set(
      convertVectors
        .filter((c) => c.kind === 'convert')
        .flatMap((c) => [(c.from as PropertyDef).type, (c.to as PropertyDef).type]),
    );
    for (const type of types) {
      expect(coerced.has(type as PropertyDef['type']), type).toBe(true);
      expect(converted.has(type as PropertyDef['type']), type).toBe(true);
    }
  });
});
