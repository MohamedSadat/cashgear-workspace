// What a paste reads beyond the conversion table: the text Excel and Sheet put on the clipboard
// on devices in English (US and UK), German and Arabic (Saudi Arabia), each cell through the
// paste's planner with the device's locale, and the readers on their own. Arabic texts with the
// bidirectional marks Intl writes are made by Intl here, as Excel's (which shows Windows' formats)
// would carry them.
import { describe, expect, it } from 'vitest';
import type { PropertyDef, Value } from '../core';
import type { Person } from '../host';
import { P, PEOPLE, seed } from '../testing/fixtures';
import { planPaste, type CellPlan } from './paste';
import {
  dateOrder,
  readPastedCheckbox,
  readPastedDate,
  readPastedNumber,
  readPastedPeople,
} from './read';
import { parseTsv } from './tsv';

/** A date and time on the device's clock, as the instant the paste stores. */
const local = (y: number, m: number, d: number, h: number, min: number, s = 0) => ({
  start: `${new Date(y, m - 1, d, h, min, s).toISOString().slice(0, 19)}Z`,
});

const PERCENT: PropertyDef = {
  id: 'numShare',
  name: 'Share',
  type: 'number',
  number: { format: 'percent', decimals: null },
};
const PLAIN: PropertyDef = {
  id: 'numPlain',
  name: 'Count',
  type: 'number',
  number: { format: 'number', decimals: null },
};
const SAR: PropertyDef = {
  id: 'numSar01',
  name: 'Price',
  type: 'number',
  number: { format: 'currency', decimals: 2, currency: 'SAR' },
};

type Expected = Value | null | 'refused';
/** A cell as one program shows it on one device: the property, the text, what it becomes. */
type Case = [property: string | PropertyDef, text: string, expected: Expected];

const sarText = (n: number) =>
  new Intl.NumberFormat('ar-SA', { style: 'currency', currency: 'SAR' }).format(n);
const arDate = (y: number, m: number, d: number) =>
  new Intl.DateTimeFormat('ar-SA', { calendar: 'gregory' }).format(new Date(y, m - 1, d));

const SHAPES: { name: string; locale: string; cases: Case[] }[] = [
  {
    name: 'Excel, en-US',
    locale: 'en-US',
    cases: [
      [P.amount, '1,234.50', 1234.5],
      [P.amount, '$1,234.50', 1234.5],
      [P.amount, 'USD 1,234.50', 1234.5],
      [P.amount, '($1,234.50)', -1234.5],
      [P.amount, '(1,234.50)', -1234.5],
      [P.amount, '1,234.50-', -1234.5],
      [P.amount, '-$12.00', -12],
      [P.amount, '1.50E+03', 1500],
      [PERCENT, '12.5%', 0.125],
      [PLAIN, '12.5%', 12.5],
      [PERCENT, '0.3', 0.3],
      [PLAIN, '1,23', 'refused'],
      [PLAIN, '$$12', 'refused'],
      [PLAIN, '(12', 'refused'],
      [PLAIN, 'about ten', 'refused'],
      [P.due, '11/16/2026', { start: '2026-11-16' }],
      [P.due, '11/16/26', { start: '2026-11-16' }],
      [P.due, '1/2/30', { start: '1930-01-02' }],
      [P.due, '1/2/29', { start: '2029-01-02' }],
      [P.due, '11/16/2026 2:30 PM', local(2026, 11, 16, 14, 30)],
      [P.due, '11/16/2026 12:05 AM', local(2026, 11, 16, 0, 5)],
      [P.due, '11/16/2026 14:30:15', local(2026, 11, 16, 14, 30, 15)],
      [P.due, '2026-11-16', { start: '2026-11-16' }],
      [P.due, '16/11/2026', 'refused'],
      [P.due, '2/30/2026', 'refused'],
      [P.due, '11/16/2026 13:30 PM', 'refused'],
      [P.due, 'Nov 16, 2026', 'refused'],
      [P.done, 'TRUE', true],
      [P.done, 'FALSE', null],
      [P.done, 'Yes', true],
      [P.done, '0', null],
      [P.owner, 'mona@example.com', [PEOPLE[0].id]],
      [P.owner, 'Omar Farouk', [PEOPLE[2].id]],
    ],
  },
  {
    name: 'Excel, en-GB',
    locale: 'en-GB',
    cases: [
      [P.amount, '£1,234.50', 1234.5],
      [P.amount, '-£5.25', -5.25],
      [P.amount, '€20', 20],
      [P.due, '16/11/2026', { start: '2026-11-16' }],
      [P.due, '16/11/26', { start: '2026-11-16' }],
      [P.due, '16/11/2026 09:05:30', local(2026, 11, 16, 9, 5, 30)],
      [P.due, '11/16/2026', 'refused'],
      [P.done, 'TRUE', true],
    ],
  },
  {
    name: 'Excel, de-DE',
    locale: 'de-DE',
    cases: [
      [P.amount, '1.234,50', 1234.5],
      [P.amount, '1.234,50 €', 1234.5],
      [P.amount, '-1.234,50 €', -1234.5],
      [P.amount, '1.234.567', 1234567],
      // On a German device a comma is the decimal mark: the locale reads before the table.
      [P.amount, '1,234', 1.234],
      // A point not between groups of three is left to the conversion table.
      [P.amount, '1.5', 1.5],
      [PERCENT, '12,5 %', 0.125],
      [PLAIN, '12,5 %', 12.5],
      [P.due, '16.11.2026', { start: '2026-11-16' }],
      [P.due, '16.11.26', { start: '2026-11-16' }],
      [P.due, '16.11.2026 14:30', local(2026, 11, 16, 14, 30)],
      [P.due, '16-11-2026', { start: '2026-11-16' }],
      [P.due, '16.11/2026', 'refused'],
      [P.done, 'WAHR', true],
      [P.done, 'FALSCH', null],
    ],
  },
  {
    name: 'Excel, ar-SA',
    locale: 'ar-SA',
    cases: [
      [P.amount, '١٬٢٣٤٫٥٠', 1234.5],
      [SAR, sarText(1234.5), 1234.5],
      [SAR, sarText(-1234.5), -1234.5],
      [SAR, '١٠٠ ر.س', 100],
      [SAR, 'د.إ ٢٥٫٧٥', 25.75],
      [PERCENT, '١٢٫٥٪', 0.125],
      [PLAIN, '۱۲۳', 123],
      [P.due, arDate(2026, 11, 16), { start: '2026-11-16' }],
      [P.due, '١٦/١١/٢٠٢٦ ٢:٣٠ م', local(2026, 11, 16, 14, 30)],
      [P.due, '١٦/١١/٢٠٢٦ ٩:٠٥ ص', local(2026, 11, 16, 9, 5)],
      // A Hijri date is not read as a Gregorian one: Excel has no dates before 1900.
      [P.due, '١٦/٠٥/١٤٤٨', 'refused'],
      [P.done, 'نعم', true],
      [P.done, 'لا', null],
      [P.done, '١', true],
      [P.owner, 'سارة خالد', [PEOPLE[1].id]],
    ],
  },
  {
    name: 'Sheet, en-US',
    locale: 'en-US',
    cases: [
      [P.amount, '1234.5', 1234.5],
      [P.amount, 'EGP 1,234.50', 1234.5],
      [PLAIN, '25%', 25],
      [PERCENT, '25%', 0.25],
      [P.due, '2026-12-01 09:30', { start: '2026-12-01T09:30:00Z' }],
      [P.due, '12/01/2026', { start: '2026-12-01' }],
      [P.done, 'TRUE', true],
      [P.done, 'FALSE', null],
    ],
  },
  {
    name: 'Sheet, de-DE',
    locale: 'de-DE',
    cases: [
      [P.amount, '1234,5', 1234.5],
      [P.amount, '-0,75', -0.75],
      [P.due, '01.12.2026', { start: '2026-12-01' }],
    ],
  },
];

function written(plan: CellPlan, rowId: string, propertyId: string): Value | null | undefined {
  const change = plan.updates.get(rowId);
  return change && propertyId in change.values ? change.values[propertyId] : undefined;
}

describe('what a paste reads beyond the conversion table', () => {
  const s = seed(1);
  const database = s.host.database(s.tasksId)!;
  // A row holding none of the values (so every reading is a write).
  const row = {
    ...s.host.rowsOf(s.tasksId)[0],
    values: { [P.done]: true } as Record<string, Value>,
  };
  const blank = { ...row, values: {} };
  const defOf = (p: string | PropertyDef) =>
    typeof p === 'string' ? database.properties.find((d) => d.id === p)! : p;

  for (const shape of SHAPES)
    for (const [property, text, expected] of shape.cases) {
      const def = defOf(property);
      it(`${shape.name}: ${def.name} from ${JSON.stringify(text)}`, () => {
        // A checkbox's "no" only shows as a write on a row that was checked.
        const into = def.id === P.done && expected === true ? blank : row;
        const plan = planPaste({
          database,
          columns: [def],
          rows: [into],
          source: {
            kind: 'text',
            rows: parseTsv(`${text}\r\n`).map((r) => r.map((t) => ({ text: t }))),
          },
          fill: null,
          maxNewRows: 0,
          reading: { locale: shape.locale, people: PEOPLE },
        });
        if (expected === 'refused') {
          expect(plan.counts.refused).toBe(1);
          expect(written(plan, into.id, def.id)).toBeUndefined();
        } else {
          expect(plan.counts.refused).toBe(0);
          expect(written(plan, into.id, def.id)).toEqual(expected);
        }
      });
    }

  it('reads a whole German Excel line, every cell by the device’s locale', () => {
    const defs = [P.amount, P.due, P.done, P.owner].map(defOf);
    const plan = planPaste({
      database,
      columns: defs,
      rows: [blank],
      source: {
        kind: 'text',
        rows: parseTsv('-1.234,50 €\t16.11.26 08:00\tWAHR\tomar@example.com\r\n').map((r) =>
          r.map((t) => ({ text: t })),
        ),
      },
      fill: null,
      maxNewRows: 0,
      reading: { locale: 'de-DE', people: PEOPLE },
    });
    expect(plan.counts.refused).toBe(0);
    expect(plan.updates.get(blank.id)!.values).toEqual({
      [P.amount]: -1234.5,
      [P.due]: local(2026, 11, 16, 8, 0),
      [P.done]: true,
      [P.owner]: [PEOPLE[2].id],
    });
  });
});

describe('the readers', () => {
  it('take the date order from the locale', () => {
    expect(dateOrder('en-US')).toEqual(['month', 'day', 'year']);
    expect(dateOrder('en-GB')).toEqual(['day', 'month', 'year']);
    expect(dateOrder('de-DE')).toEqual(['day', 'month', 'year']);
    expect(dateOrder('ar-SA')).toEqual(['day', 'month', 'year']);
  });

  it('read a number only where the locale puts its separators', () => {
    expect(readPastedNumber('1,234,567.89', PLAIN, 'en-US')).toBe(1234567.89);
    expect(readPastedNumber('1,2345', PLAIN, 'en-US')).toBeUndefined();
    expect(readPastedNumber('1.234,5', PLAIN, 'en-US')).toBeUndefined();
    expect(readPastedNumber('.5', PLAIN, 'en-US')).toBe(0.5);
    expect(readPastedNumber('-0', PLAIN, 'en-US')).toBe(0);
    // French groups with a narrow no-break space, as Intl writes them.
    expect(readPastedNumber(new Intl.NumberFormat('fr-FR').format(1234.5), PLAIN, 'fr-FR')).toBe(
      1234.5,
    );
  });

  it('read a person by email in any case, or by a name only one member has', () => {
    const people: Person[] = [
      ...PEOPLE,
      { id: '0190a000-0000-7000-8000-0000000000p4', name: 'Mona Adel', email: 'mona2@example.com' },
    ];
    expect(readPastedPeople('MONA@Example.com', people)).toEqual([PEOPLE[0].id]);
    // Two members are named Mona Adel: the name alone is not read.
    expect(readPastedPeople('Mona Adel', people)).toBeUndefined();
    expect(readPastedPeople('Omar Farouk, sara@example.com', people)).toEqual([
      PEOPLE[2].id,
      PEOPLE[1].id,
    ]);
    expect(readPastedPeople('Omar Farouk, Nobody', people)).toBeUndefined();
    expect(readPastedPeople('Nobody', people)).toBeUndefined();
  });

  it('read checkbox words and nothing else', () => {
    expect(readPastedCheckbox('TRUE')).toBe(true);
    expect(readPastedCheckbox('no')).toBe(false);
    expect(readPastedCheckbox('✓')).toBe(true);
    expect(readPastedCheckbox('maybe')).toBeUndefined();
  });

  it('read a date with a time on the device’s clock, and refuse what does not fit', () => {
    expect(readPastedDate('11/16/2026 2:30 pm', 'en-US')).toEqual(local(2026, 11, 16, 14, 30));
    expect(readPastedDate('11/16/2026 0:30 AM', 'en-US')).toBeUndefined();
    expect(readPastedDate('11/16/1899', 'en-US')).toBeUndefined();
    expect(readPastedDate('11/16', 'en-US')).toBeUndefined();
  });
});
