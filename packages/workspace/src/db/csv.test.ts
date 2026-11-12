import { describe, expect, it } from 'vitest';
import type { RowRecord } from '../types';
import {
  CSV_MAX_BYTES,
  CSV_MAX_ROWS,
  inferProperties,
  parseCsv,
  rowsToCsv,
  shownProperties,
  textToValue,
  guardCsvText,
  unguardCsvText,
  utf8Length,
} from './csv';
import type { DatabaseRecord } from './types';
import { cellValue } from './values';
import { P, TITLE, database, row } from './vectors/fixtures';

describe('CSV', () => {
  it('reads back what it writes', () => {
    const db = database([
      TITLE,
      P.text,
      P.number,
      P.date,
      P.checkbox,
      P.select,
      P.multi,
      P.url,
    ]) as DatabaseRecord;
    const rows = [
      row(1, {
        title: 'One, "two"',
        values: {
          pText001: 'a\r\nb, "c"',
          pNum0001: 0.1,
          pDate001: { start: '2026-03-01T10:00:00Z', end: '2026-03-02' },
          pChk0001: true,
          pSel0001: 'optLate1',
          pMul0001: ['tagAr001', 'tagRed01'],
          pUrl0001: 'https://a.example/?q=1,2',
        },
      }),
      row(2, { title: 'تقرير', values: { pNum0001: -1e-7 } }),
    ] as RowRecord[];
    const text = rowsToCsv(
      db,
      { config: { properties: { order: [], hidden: [], widths: {} } } as never },
      rows,
    );
    expect(text.startsWith('\uFEFF')).toBe(true);
    const [header, ...records] = parseCsv(text);
    const shown = shownProperties(db, { properties: { order: [], hidden: [], widths: {} } });
    expect(header).toEqual(shown.map((d) => d.name));
    records.forEach((record, i) =>
      shown.forEach((def, col) => {
        const expected = cellValue(db, rows[i], def.id);
        const read =
          def.type === 'title' ? record[col] || null : (textToValue(def, record[col]) ?? null);
        expect(read, `${i} ${def.name}`).toEqual(
          def.type === 'checkbox' ? (expected ? true : null) : expected,
        );
      }),
    );
  });

  it('infers the title from the first column, and new ids for the rest', () => {
    const [header, ...rows] = parseCsv('Name,Amount\na,1\nb,2');
    const defs = inferProperties(header, rows);
    expect(defs[0]).toEqual({ id: 'title', name: 'Name', type: 'title' });
    expect(defs[1].id).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(inferProperties(header, rows)[1].id).not.toBe(defs[1].id);
  });

  it('derives select option ids from the database when it is given', () => {
    const header = ['N', 'S'];
    const rows = [
      ['a', 'x1'],
      ['b', 'x1'],
    ];
    const one = inferProperties(header, rows, { databaseId: 'db' });
    expect(one[1].options).toHaveLength(1);
    expect(one[1].options![0].name).toBe('x1');
  });

  it('guards risky text so a spreadsheet will not run it, and import undoes exactly that', () => {
    const alphabet = ["'", '=', '+', '-', '@', '\t', '\r', 'a', '1', ' '];
    let seed = 3;
    const random = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
    for (let i = 0; i < 3000; i++) {
      const text = Array.from(
        { length: 1 + random(5) },
        () => alphabet[random(alphabet.length)],
      ).join('');
      const guarded = guardCsvText(text);
      expect(unguardCsvText(guarded), JSON.stringify(text)).toBe(text);
      // What is written never starts with a character a spreadsheet reads as a formula.
      expect(/^[=+\-@\t\r]/.test(guarded), JSON.stringify(guarded)).toBe(false);
    }
  });

  it('reads back risky text, numbers and option names after export', () => {
    const db = database([
      TITLE,
      P.text,
      P.number,
      { ...P.select, options: [{ id: 'optMinus', name: '-minus', colour: 'default' }] },
      {
        ...P.multi,
        options: [
          { id: 'optEqual', name: '=eq', colour: 'default' },
          { id: 'optAt0001', name: '@at', colour: 'default' },
        ],
      },
    ]) as DatabaseRecord;
    const rows = [
      row(1, {
        title: "'=already",
        values: {
          pText001: '=HYPERLINK("x")',
          pNum0001: -5,
          pSel0001: 'optMinus',
          pMul0001: ['optEqual', 'optAt0001'],
        },
      }),
      row(2, { title: '@user', values: { pText001: "''-x", pNum0001: -0.5 } }),
    ] as RowRecord[];
    const config = { properties: { order: [], hidden: [], widths: {} } };
    const [, ...records] = parseCsv(rowsToCsv(db, { config } as never, rows));
    const shown = shownProperties(db, config);
    expect(records[0][2]).toBe('-5');
    records.forEach((record, i) =>
      shown.forEach((def, col) =>
        expect(textToValue(def, record[col]) ?? null, `${i} ${def.name}`).toEqual(
          def.type === 'title' ? rows[i].title : cellValue(db, rows[i], def.id),
        ),
      ),
    );
  });

  it('measures what the server limits', () => {
    expect(CSV_MAX_ROWS).toBe(50_000);
    expect(CSV_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(utf8Length('aé😀ب')).toBe(1 + 2 + 4 + 2);
  });
});
