// The mock Sheet's workbooks, made by its own xlsx writer (nothing binary is checked in).
import { cellsFromRows, writeXlsx } from './xlsx.mjs';

/** A budget: an English sheet, an Arabic right-to-left one, and a hidden one. */
export function budgetBook() {
  return writeXlsx({
    sheets: [
      {
        name: 'Budget',
        rows: [
          ['Item', 'Q1', 'Q2', 'Approved'],
          ['Rent', 1200, 1250, true],
          ['Travel', 300.5, 280, false],
          ['Software & tools', 99, 120, true],
        ],
      },
      {
        name: 'الميزانية',
        rtl: true,
        rows: [
          ['البند', 'الربع الأول'],
          ['الإيجار', 1200],
        ],
      },
      { name: 'Hidden notes', state: 'hidden', rows: [['Not listed']] },
    ],
  });
}

/** One sheet of 200 rows by 60 columns: its used range is cut to the cell limit. */
export function wideBook() {
  const cells = cellsFromRows(
    Array.from({ length: 200 }, (_, r) => Array.from({ length: 60 }, (_, c) => r * 60 + c)),
  );
  return writeXlsx({ sheets: [{ name: 'Wide', cells }] });
}

/** One empty sheet: its used range is A1. */
export function emptyBook() {
  return writeXlsx({ sheets: [{ name: 'Sheet1', rows: [] }] });
}

export const FIXTURES = { budget: budgetBook, wide: wideBook, empty: emptyBook };
