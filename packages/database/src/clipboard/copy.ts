// What a copy of cells puts on the clipboard: each value as the table shows it (numbers by their
// property's format, dates in the interface language and the person's time zone, options, people,
// related rows and files by name), as tab-separated text and an HTML table. A checkbox is TRUE or
// FALSE, as spreadsheets write and read one.
//
// The tab also keeps the copied values themselves (in memory, never stored): a paste of the same
// text into a table takes them, by the conversion table from their own type, so dates, people and
// related rows (which do not read back from the text shown) survive a copy from one table to
// another, and a select's option keeps its id within its own property.
import type { Id, RowRecord } from '@cgw/workspace';
import type { CellEnv } from '../cells/env';
import { dateText, errorKey } from '../cells/CellDisplay';
import type { CellValue, PropertyDef, Value } from '../core';
import { uniqueIdText } from '../core';
import { formatNumber, isCellError, isDateValue, optionById, readCell } from '../model/format';
import { toHtmlTable, toTsv } from './tsv';

/** A copied cell: its property, its value (as `readCell` reads it) and the text it showed. */
export interface CopiedCell {
  def: PropertyDef;
  value: CellValue | Value | undefined;
  text: string;
}

/** What the tab copied last from a table. */
export interface Clip {
  databaseId: Id;
  /** The text as it was put on the clipboard, line ends made one kind (`clipKey`). */
  key: string;
  cells: CopiedCell[][];
}

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const bool = (value: boolean) => (value ? 'TRUE' : 'FALSE');

/** A cell's text as the table shows it. */
export function shownText(def: PropertyDef, row: RowRecord, env: CellEnv): string {
  if (def.type === 'checkbox') return bool(row.values[def.id] === true);
  if (def.type === 'uniqueId') return uniqueIdText(def, row.number) ?? '';
  const value = readCell(row, def);
  if (value === null || value === undefined) return '';
  switch (def.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return typeof value === 'string' ? value : '';
    case 'number':
      return typeof value === 'number' ? formatNumber(value, def, env.locale) : '';
    case 'date':
    case 'createdTime':
    case 'lastEditedTime':
      return isDateValue(value) ? dateText(value, env) : '';
    case 'select':
    case 'status':
      return optionById(def, value)?.name ?? '';
    case 'multiSelect':
      return ids(value)
        .map((id) => optionById(def, id)?.name)
        .filter((name): name is string => !!name)
        .join(', ');
    case 'person':
    case 'createdBy':
    case 'lastEditedBy':
      return ids(value)
        .map((id) => env.people.get(id)?.name ?? env.t('person.unknown'))
        .join(', ');
    case 'relation':
      return ids(value)
        .map((id) => {
          const title = env.host.pageTitle(id);
          return title || (title === '' ? env.t('untitled') : env.t('relation.unknown'));
        })
        .join(', ');
    case 'files':
      return ids(value)
        .map((id) => env.host.assets?.info(id)?.fileName ?? env.t('files.unknown'))
        .join(', ');
    case 'formula':
    case 'rollup':
      return computedText(def, value as CellValue, env);
    default:
      return '';
  }
}

function computedText(def: PropertyDef, value: CellValue, env: CellEnv): string {
  if (value === null) return '';
  if (isCellError(value)) return env.t(errorKey(value.error));
  if (typeof value === 'number') return formatNumber(value, def, env.locale);
  if (typeof value === 'boolean') return bool(value);
  if (isDateValue(value)) return dateText(value, env);
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').join(', ');
  return typeof value === 'string' ? value : '';
}

/** Clipboard text with its line ends made one kind and the last one dropped (browsers change them). */
export const clipKey = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\n$/, '');

let last: Clip | null = null;

/** The tab's last copy, if `text` is what it put on the clipboard. */
export function clipFor(text: string): Clip | null {
  return last && last.key === clipKey(text) ? last : null;
}

/** Forgets the last copy (tests). */
export function forgetClip() {
  last = null;
}

/**
 * A copy of cells: rows of rows, columns of properties. Gives the clipboard's text and HTML, and
 * keeps the copied values for a paste in this tab.
 */
export function copyCells(
  databaseId: Id,
  rows: readonly RowRecord[],
  defs: readonly PropertyDef[],
  env: CellEnv,
): { text: string; html: string; cells: number } {
  const cells = rows.map((row) =>
    defs.map((def) => ({ def, value: readCell(row, def), text: shownText(def, row, env) })),
  );
  const texts = cells.map((line) => line.map((cell) => cell.text));
  const text = toTsv(texts);
  last = { databaseId, key: clipKey(text), cells };
  return {
    text,
    html: toHtmlTable(texts, env.rtl ? 'rtl' : 'ltr'),
    cells: rows.length * defs.length,
  };
}
