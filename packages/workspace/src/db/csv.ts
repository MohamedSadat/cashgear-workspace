// CSV import and export (Phase 4 contracts, section 2). Shared vectors: db-csv-vectors.json.
//
// Parse (RFC 4180, leniently): a leading BOM is dropped; records end at CRLF, LF or a lone CR;
// the separator is whichever of `,` `;` TAB appears most outside quotes in the first record
// (ties: comma, then semicolon, then tab; none: comma). A field starting with `"` is quoted: `""`
// in it is one quote, separators and line breaks in it are kept as written, and text after its
// closing quote up to the separator is kept too; a quote not at a field's start is a character.
// An unclosed quote runs to the end. Empty lines are skipped; ragged records stay ragged.
//
// Export: UTF-8 with a BOM, every record ending in CRLF, comma-separated; a header of the shown
// properties' names in view order (title first); each value in canonical form (`cellText`); a
// field is quoted (quotes doubled) when it holds a comma, a quote, a CR or an LF.
//
// CSV injection: a header name or a cell that is not a number (text, title, url, email, phone,
// option names, people's names, related rows' titles, file names, formula and rollup text and
// lists) whose text starts with `=`, `+`, `-`, `@`, TAB or CR, after any `'`s, is written with one
// `'` before it, so a spreadsheet shows it as text. Numbers (`-5`) are never prefixed. Import
// (`textToValue` for text-kind properties, header names in `inferProperties`) takes that one `'`
// off again, so export then import gives the same values.
import type { Id } from '../ids';
import type { RowRecord } from '../types';
import { convertValue, isErrorCell } from './convert';
import { parseDateText, dateText, isDateOnly } from './dates';
import { derivedOption, newPropertyId } from './ids';
import { numberText, parseBoolean, parseNumberText } from './text';
import {
  TITLE_PROPERTY,
  type CellValue,
  type DatabaseRecord,
  type DateValue,
  type PropertyDef,
  type PropertyId,
  type Value,
  type ViewConfig,
  type ViewRecord,
} from './types';
import { cellOf } from './values';
import { formulaCell } from './rollup';

/** At most this many rows and bytes (UTF-8) are imported (413 `db.tooLarge` on the server). */
export const CSV_MAX_ROWS = 50_000;
export const CSV_MAX_BYTES = 20 * 1024 * 1024;

const SEPARATORS = [',', ';', '\t'] as const;

function separatorOf(text: string): string {
  const counts = [0, 0, 0];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted) {
      const at = SEPARATORS.indexOf(c as (typeof SEPARATORS)[number]);
      if (at >= 0) counts[at]++;
    }
  }
  let best = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
  return SEPARATORS[best];
}

/** The records of a CSV text, each a list of fields. */
export function parseCsv(input: string): string[][] {
  const text = input.startsWith('\uFEFF') ? input.slice(1) : input;
  const separator = separatorOf(text);
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  /** Something is in the field already, so a quote now is a character. */
  let inField = false;
  /** The record has a character or a separator: it is not an empty line. */
  let any = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' && !inField) {
      inField = any = true;
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] !== '"') {
            i++;
            break;
          }
          i++;
        }
        field += text[i++];
      }
    } else if (c === separator) {
      record.push(field);
      field = '';
      inField = false;
      any = true;
      i++;
    } else if (c === '\r' || c === '\n') {
      record.push(field);
      if (any) records.push(record);
      record = [];
      field = '';
      inField = any = false;
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      inField = any = true;
      i++;
    }
  }
  if (any) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** The UTF-8 size of a text. */
export const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

// ---------------------------------------------------------------------------------------------
// Import

const TEXT_DEF: PropertyDef = { id: '', name: '', type: 'text' };

/** Properties whose CSV cells export guards (their values are read from text by name or as is). */
const TEXT_KINDS = new Set<PropertyDef['type']>([
  'title',
  'text',
  'url',
  'email',
  'phone',
  'select',
  'status',
  'multiSelect',
]);

/**
 * A CSV cell as a value of `def`: the text conversion (convert.ts) of the cell's text, after
 * `unguardCsvText` for text-kind properties (title, text, url, email, phone, select, status,
 * multi-select).
 */
export function textToValue(def: PropertyDef, text: string): Value | undefined {
  return convertValue(TEXT_DEF, def, TEXT_KINDS.has(def.type) ? unguardCsvText(text) : text);
}

const URL_TEXT = /^https?:\/\/\S+$/i;
const EMAIL_TEXT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Properties for a new database from a CSV's header and rows: the first column is the title
 * (named from the header, else `Name`); every other column, by its non-empty cells (trimmed):
 * number if every one reads as a number, checkbox if as a checkbox word, date if as a date (with
 * the time if any has one), url if every one starts with http:// or https:// and has no space,
 * email if every one looks like one, select if it has at most 50 distinct values used at least
 * twice each on average (options in first-seen order, ids from `derivedOption` with
 * `options.databaseId`), else text; a column with no values is text. A column with no name is
 * `Column N` (from 1). Header names and option names have export's guard taken off
 * (`unguardCsvText`); the other types are decided on the cells as written. Property ids are new
 * (`newPropertyId`).
 */
export function inferProperties(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  options: { databaseId?: Id } = {},
): PropertyDef[] {
  const width = Math.max(header.length, ...rows.map((row) => row.length), 1);
  const defs: PropertyDef[] = [];
  for (let col = 0; col < width; col++) {
    const name =
      unguardCsvText((header[col] ?? '').trim()) || (col === 0 ? 'Name' : `Column ${col + 1}`);
    if (col === 0) {
      defs.push({ id: TITLE_PROPERTY, name, type: 'title' });
      continue;
    }
    const id = newPropertyId();
    const cells = rows.map((row) => (row[col] ?? '').trim()).filter((cell) => cell !== '');
    defs.push(inferColumn(id, name, cells, options.databaseId ?? ''));
  }
  return defs;
}

function inferColumn(id: PropertyId, name: string, cells: string[], databaseId: Id): PropertyDef {
  if (!cells.length) return { id, name, type: 'text' };
  if (cells.every((c) => parseNumberText(c) !== undefined))
    return { id, name, type: 'number', number: { format: 'number', decimals: null } };
  if (cells.every((c) => parseBoolean(c) !== undefined)) return { id, name, type: 'checkbox' };
  const dates = cells.map(parseDateText);
  if (dates.every((d) => d !== undefined)) {
    const includeTime = dates.some(
      (d) => !isDateOnly(d!.start) || (!!d!.end && !isDateOnly(d!.end)),
    );
    return { id, name, type: 'date', date: { includeTime } };
  }
  if (cells.every((c) => URL_TEXT.test(c))) return { id, name, type: 'url' };
  if (cells.every((c) => EMAIL_TEXT.test(c))) return { id, name, type: 'email' };
  // Option names are what `textToValue` will look up: the cells' text with export's guard taken off.
  const distinct: string[] = [];
  for (const c of cells.map(unguardCsvText)) if (!distinct.includes(c)) distinct.push(c);
  if (distinct.length <= 50 && cells.length >= 2 * distinct.length) {
    const options: {
      id: string;
      name: string;
      colour: ReturnType<typeof derivedOption>['colour'];
    }[] = [];
    for (const option of distinct) {
      const derived = derivedOption(databaseId, id, option, new Set(options.map((o) => o.id)));
      options.push({ id: derived.id, name: option, colour: derived.colour });
    }
    return { id, name, type: 'select', options };
  }
  return { id, name, type: 'text' };
}

// ---------------------------------------------------------------------------------------------
// Export

/** Names for the ids a CSV writes: people, related rows' titles, files' names. */
export interface CsvLookups {
  people?: Record<Id, string>;
  rows?: Record<Id, string>;
  files?: Record<Id, string>;
  /** This device's formula and rollup results for a row, where it holds the inputs. */
  computed?: (row: RowRecord) => Record<PropertyId, CellValue> | undefined;
}

/**
 * The properties a view shows, in order: the title first, then those `order` names, then the rest
 * in database order; hidden and deleted ones left out.
 */
export function shownProperties(
  database: DatabaseRecord,
  config: Pick<ViewConfig, 'properties'>,
): PropertyDef[] {
  const hidden = new Set(config.properties?.hidden ?? []);
  const live = database.properties.filter((p) => !p.trashedAt);
  const title = live.find((p) => p.type === 'title');
  const shown: PropertyDef[] = title ? [title] : [];
  const add = (def: PropertyDef | undefined) => {
    if (def && !hidden.has(def.id) && !shown.includes(def)) shown.push(def);
  };
  for (const id of config.properties?.order ?? []) add(live.find((p) => p.id === id));
  for (const def of live) add(def);
  return shown;
}

const named = (lookup: Record<Id, string> | undefined, id: string) => lookup?.[id] ?? id;

/**
 * Text a spreadsheet could run as a formula: it starts with `=`, `+`, `-`, `@`, TAB or CR, after
 * any `'`s (those are guarded too, so one `'` taken off on import always gives the text back).
 */
const RISKY = /^'*[=+\-@\t\r]/;

/** A text field as export writes it: one `'` before risky text (CSV injection), else as it is. */
export const guardCsvText = (text: string): string => (RISKY.test(text) ? `'${text}` : text);

/** A text field as import reads it: one leading `'` taken off risky text that has one. */
export const unguardCsvText = (text: string): string =>
  text.startsWith("'") && RISKY.test(text) ? text.slice(1) : text;

/** A cell as CSV writes it (canonical text, unguarded); '' when empty or an error. */
export function cellText(def: PropertyDef, row: RowRecord, lookups: CsvLookups = {}): string {
  return cellParts(def, row, lookups).text;
}

/** A cell's canonical text, and whether the cell is a number (never guarded). */
function cellParts(
  def: PropertyDef,
  row: RowRecord,
  lookups: CsvLookups,
): { text: string; number: boolean } {
  const cell = cellOf(
    def,
    row,
    def.type === 'formula' || def.type === 'rollup' ? lookups.computed?.(row) : undefined,
  );
  return { text: canonical(def, cell, lookups), number: typeof cell === 'number' };
}

function canonical(def: PropertyDef, cell: CellValue, lookups: CsvLookups): string {
  if (cell === null || isErrorCell(cell)) return '';
  const list = (ids: string[], lookup: Record<Id, string> | undefined) =>
    ids.map((id) => named(lookup, id)).join(', ');
  switch (def.type) {
    case 'person':
    case 'createdBy':
    case 'lastEditedBy':
      return list(cell as string[], lookups.people);
    case 'relation':
      return list(cell as string[], lookups.rows);
    case 'files':
      return list(cell as string[], lookups.files);
    case 'select':
    case 'status':
    case 'multiSelect': {
      const names = formulaCell(def, cell);
      return Array.isArray(names) ? names.join(', ') : typeof names === 'string' ? names : '';
    }
  }
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number') return numberText(cell);
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
  if (Array.isArray(cell))
    return cell
      .map(
        (item) => lookups.people?.[item] ?? lookups.rows?.[item] ?? lookups.files?.[item] ?? item,
      )
      .join(', ');
  return dateText(cell as DateValue);
}

const csvField = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/**
 * A view's rows as CSV (the export's bytes are this text in UTF-8): `rows` in the order given,
 * templates and trashed rows left out.
 */
export function rowsToCsv(
  database: DatabaseRecord,
  view: Pick<ViewRecord, 'config'>,
  rows: readonly RowRecord[],
  lookups: CsvLookups = {},
): string {
  const shown = shownProperties(database, view.config);
  const lines = [shown.map((def) => csvField(guardCsvText(def.name))).join(',')];
  for (const row of rows) {
    if (row.isTemplate || row.trashedAt) continue;
    lines.push(
      shown
        .map((def) => {
          const { text, number } = cellParts(def, row, lookups);
          return csvField(number ? text : guardCsvText(text));
        })
        .join(','),
    );
  }
  return `\uFEFF${lines.map((line) => `${line}\r\n`).join('')}`;
}
