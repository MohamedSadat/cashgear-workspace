import { describe, expect, it } from 'vitest';
import {
  addMonths,
  calendarDate,
  civilFromDays,
  coerceDate,
  daysFromCivil,
  instantText,
  parseDatePoint,
  pointMs,
  relativeDate,
  truncateDate,
  weekdayOfDay,
} from './dates';
import { parseNumberText, numberText, splitNames } from './text';
import { cellValue, coerceValue, isEmptyCell, isEmptyValue, optionIndex } from './values';
import { P, TITLE, database, row, rowId } from './vectors/fixtures';
import type { RowRecord } from '../types';
import type { DatabaseRecord } from './types';

describe('calendar arithmetic', () => {
  it('agrees with Date on every 37th day from year 1 to 9999', () => {
    // One expect at the end: an expect per day took 7 s under a full run, past the timeout.
    const wrong: string[] = [];
    for (let day = daysFromCivil(1, 1, 1); day <= daysFromCivil(9999, 12, 31); day += 37) {
      const d = new Date(day * 86_400_000);
      const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
      const civil = civilFromDays(day);
      if (civil[0] !== y || civil[1] !== m || civil[2] !== dd) wrong.push(`civil ${day}`);
      if (daysFromCivil(y, m, dd) !== day) wrong.push(`days ${y}-${m}-${dd}`);
      if (weekdayOfDay(day) !== ((d.getUTCDay() + 6) % 7) + 1) wrong.push(`weekday ${day}`);
    }
    expect(wrong).toEqual([]);
  });

  it('writes instants as Date does, in whole seconds', () => {
    for (const ms of [0, 1_769_817_600_000, 1_769_817_600_999, -1, 253402300799000])
      expect(instantText(ms)).toBe(
        new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
      );
    expect(instantText(253402300800000)).toBeUndefined();
    expect(instantText(Number.NaN)).toBeUndefined();
  });

  it('reads points back to the same milliseconds', () => {
    for (const text of ['2026-03-01T10:15:30Z', '1999-12-31T23:59:59Z', '0001-01-01T00:00:00Z']) {
      const point = parseDatePoint(text)!;
      expect(instantText(pointMs(point))).toBe(point);
    }
    expect(pointMs('2026-03-01', 180)).toBe(pointMs('2026-02-28T21:00:00Z'));
  });

  it('reads calendar dates at an offset', () => {
    expect(calendarDate('2026-03-01T22:30:00Z', 90)).toBe('2026-03-02');
    expect(calendarDate('2026-03-01T00:30:00Z', -60)).toBe('2026-02-28');
    expect(calendarDate('2026-03-01', -600)).toBe('2026-03-01');
  });

  it('moves by months, clamping the day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-03-31T10:00:00Z', -1)).toBe('2026-02-28T10:00:00Z');
    expect(addMonths('2026-01-15', -12 * 2026)).toBeUndefined();
  });

  it('finds relative dates and cuts dates into groups', () => {
    expect(relativeDate('2026-12-31', 'tomorrow')).toBe('2027-01-01');
    expect(relativeDate('2026-03-31', 'oneMonthFromNow')).toBe('2026-04-30');
    expect(relativeDate('not a date', 'today')).toBeUndefined();
    expect(truncateDate('2026-03-01', 'week')).toBe('2026-02-23');
    expect(truncateDate('2026-03-02', 'week')).toBe('2026-03-02');
    expect(truncateDate('2026-03-17', 'month')).toBe('2026-03-01');
    expect(truncateDate('2026-03-17', 'year')).toBe('2026-01-01');
  });

  it('coerces date objects and text alike', () => {
    expect(coerceDate('2026-03-01 → 2026-03-02')).toEqual(
      coerceDate({ start: '2026-03-01', end: '2026-03-02' }),
    );
    expect(coerceDate({ start: '2026-03-01', end: 5 })).toBeUndefined();
    expect(coerceDate({ start: '2026-03-01', end: '' })).toEqual({ start: '2026-03-01' });
    expect(coerceDate([])).toBeUndefined();
  });
});

describe('number text', () => {
  it('reads back every number it writes', () => {
    let seed = 11;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < 2000; i++) {
      const n = (random() - 0.5) * 10 ** Math.floor(random() * 40 - 20);
      expect(parseNumberText(numberText(n))).toBe(n === 0 ? 0 : n);
    }
  });

  it('splits names once each', () => {
    expect(splitNames(' a, b ,,a, c ')).toEqual(['a', 'b', 'c']);
  });
});

describe('coercion', () => {
  it('keeps the first 1,000 related rows', () => {
    const ids = Array.from({ length: 1005 }, (_, i) => rowId(i + 1));
    expect(coerceValue(P.relation, ids)).toEqual(ids.slice(0, 1000));
  });

  it('is idempotent: a coerced value coerces to itself', () => {
    const raws: [typeof P.text, unknown][] = [
      [P.text, ' x '],
      [P.number, '1,234'],
      [P.date, '2026-03-01T10:00:00+03:00'],
      [P.checkbox, 'yes'],
      [P.select, 'Done'],
      [P.multi, 'Red, Blue'],
      [P.person, ['a', 'a', 'b']],
      [P.url, ' https://x '],
    ];
    for (const [def, raw] of raws) {
      const once = coerceValue(def, raw);
      expect(once, def.type).toBeDefined();
      expect(coerceValue(def, once), def.type).toEqual(once);
    }
  });

  it('says what is empty', () => {
    for (const empty of [undefined, null, '', '  ', []]) expect(isEmptyValue(empty)).toBe(true);
    for (const value of [0, false, 'a', ['a'], { start: '2026-01-01' }])
      expect(isEmptyValue(value)).toBe(false);
    expect(isEmptyCell({ error: 'formula.type' })).toBe(true);
    expect(isEmptyCell(false)).toBe(false);
  });
});

describe('cells', () => {
  const db = database([TITLE, P.select, P.date]) as DatabaseRecord;
  const r = (values: RowRecord['values']) => row(1, { values }) as RowRecord;

  it('finds option positions, and notices options added or replaced', () => {
    const def = { ...P.select, options: [...P.select.options!] };
    expect(optionIndex(def, 'optLate1')).toBe(2);
    expect(optionIndex(def, 'optNew01')).toBe(-1);
    def.options.push({ id: 'optNew01', name: 'New', colour: 'default' });
    expect(optionIndex(def, 'optNew01')).toBe(4);
  });

  it('read a stored date that is not canonical as empty', () => {
    expect(cellValue(db, r({ pDate001: { start: '2026-3-1' } }), 'pDate001')).toBeNull();
    expect(cellValue(db, r({ pDate001: { start: '2026-03-01', end: 'x' } }), 'pDate001')).toEqual({
      start: '2026-03-01',
    });
    expect(cellValue(db, r({ pDate001: ['2026-03-01'] }), 'pDate001')).toBeNull();
  });
});
