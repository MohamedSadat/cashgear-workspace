// A CSV import, planned on the device (contract section 2): the file's columns mapped to the
// database's properties (by name at first), every cell read as its property reads text
// (`textToValue`, the text conversion), the options a select, multi-select or status column needs
// added to its property the way the server adds them (`convertProperty`: derived ids), cells that
// cannot be read left empty and listed; or a new database whose properties `inferProperties`
// works out from the file. The operations: a `db.update` for the options (or the database's
// `page.create` and a table view), then a `page.create` of kind `row` per record. Pure.
import {
  keysBetween,
  newOp,
  normaliseText,
  type Id,
  type Operation,
  type PageCreate,
} from '@cgw/workspace';
import { inferProperties, textToValue } from '@cgw/workspace';
import {
  TITLE_PROPERTY,
  convertProperty,
  isEmptyValue,
  type DatabaseRecord,
  type PropertyDef,
  type PropertyId,
  type PropertyType,
  type Value,
  type ViewRecord,
} from '../core';
import { emptyConfig } from '../model/viewConfig';

/** Property types a CSV column can be imported into. */
export const IMPORT_TYPES: readonly PropertyType[] = [
  'text',
  'number',
  'date',
  'checkbox',
  'select',
  'multiSelect',
  'status',
  'url',
  'email',
  'phone',
];

const OPTION_TYPES = new Set<PropertyType>(['select', 'multiSelect', 'status']);
const TEXT: PropertyDef = { id: '', name: '', type: 'text' };

export interface CsvTable {
  /** Column names (from the first record, or made up when it is not a header). */
  header: string[];
  records: string[][];
  width: number;
  /** The file's line number of each record's first line is not kept: records count from 1. */
  firstLine: number;
}

/** A parsed file as a table: its header (or `Column N`) and its records. */
export function csvTable(
  parsed: readonly string[][],
  hasHeader: boolean,
  columnName: (n: number) => string,
): CsvTable {
  const width = Math.max(0, ...parsed.map((r) => r.length));
  const first = hasHeader ? (parsed[0] ?? []) : [];
  const header = Array.from(
    { length: width },
    (_, i) => (first[i] ?? '').trim() || columnName(i + 1),
  );
  return {
    header,
    records: (hasHeader ? parsed.slice(1) : parsed).map((r) => [...r]),
    width,
    firstLine: hasHeader ? 2 : 1,
  };
}

/** The properties a column can be imported into: the title and the stored types that read text. */
export const importTargets = (database: DatabaseRecord): PropertyDef[] =>
  database.properties.filter(
    (p) => !p.trashedAt && (p.id === TITLE_PROPERTY || IMPORT_TYPES.includes(p.type)),
  );

/**
 * Each column's property at first: the one of the same name (ignoring case, accents and spacing),
 * each property once; the first column is the title when no column is named like it.
 */
export function defaultMapping(database: DatabaseRecord, table: CsvTable): (PropertyId | null)[] {
  const targets = importTargets(database);
  const taken = new Set<PropertyId>();
  const mapping = table.header.map((name) => {
    const key = normaliseText(name);
    const def = targets.find((p) => !taken.has(p.id) && normaliseText(p.name) === key);
    if (!def) return null;
    taken.add(def.id);
    return def.id;
  });
  if (!taken.has(TITLE_PROPERTY) && mapping.length && mapping[0] === null)
    mapping[0] = TITLE_PROPERTY;
  return mapping;
}

export interface ImportProblem {
  /** The record's number in the file (the header is line 1 when there is one). */
  line: number;
  column: string;
  text: string;
}

export interface PlannedImport {
  /** Properties that gained options (written by one `db.update` before the rows). */
  changed: PropertyDef[];
  rows: { title: string; values: Record<PropertyId, Value> }[];
  problems: ImportProblem[];
}

/** Every record as a row of `database`, by `mapping` (a property id or null per column). */
export function planImportValues(
  database: DatabaseRecord,
  table: CsvTable,
  mapping: readonly (PropertyId | null)[],
  limit = Number.POSITIVE_INFINITY,
): PlannedImport {
  const records = table.records.slice(0, limit);
  const rows = records.map(() => ({ title: '', values: {} as Record<PropertyId, Value> }));
  const problems: ImportProblem[] = [];
  const changed: PropertyDef[] = [];
  const used = new Set<PropertyId>();
  mapping.forEach((propertyId, col) => {
    if (!propertyId || used.has(propertyId)) return;
    used.add(propertyId);
    const def = database.properties.find((p) => p.id === propertyId);
    if (!def) return;
    const texts = records.map((r) => (r[col] ?? '').trim());
    if (def.id === TITLE_PROPERTY || def.type === 'title') {
      texts.forEach((text, i) => (rows[i].title = text.replace(/[\r\n]+/g, ' ')));
      return;
    }
    let values: (Value | undefined)[];
    if (OPTION_TYPES.has(def.type)) {
      const converted = convertProperty(
        TEXT,
        def,
        texts.map((text) => (text === '' ? undefined : text)),
        database.id,
      );
      if ((converted.def.options?.length ?? 0) > (def.options?.length ?? 0))
        changed.push(converted.def);
      values = converted.values;
    } else values = texts.map((text) => (text === '' ? undefined : textToValue(def, text)));
    values.forEach((value, i) => {
      // A checkbox reads every word: checked is stored, anything else is no value.
      if (def.type === 'checkbox') {
        if (value === true) rows[i].values[def.id] = true;
      } else if (value !== undefined && !isEmptyValue(value)) rows[i].values[def.id] = value;
      else if (texts[i] !== '')
        problems.push({
          line: table.firstLine + i,
          column: table.header[col] ?? '',
          text: texts[i],
        });
    });
  });
  return { changed, rows, problems };
}

/** What the planned rows' operations need from the host. */
export interface ImportContext {
  workspaceId: Id;
  sectionId: Id;
  newId(): Id;
  /** An order key after every row of the database. */
  endKey: string;
  now?: string;
}

/** The rows' `page.create`s (after the `db.update` of the options, when some are new). */
export function importOps(databaseId: Id, planned: PlannedImport, ctx: ImportContext): Operation[] {
  const ops: Operation[] = [];
  if (planned.changed.length)
    ops.push(newOp('db.update', ctx.workspaceId, databaseId, { properties: planned.changed }));
  const n = planned.rows.length;
  const keys = n ? [ctx.endKey, ...keysBetween(ctx.endKey, null, n - 1)] : [];
  const now = ctx.now ?? new Date().toISOString();
  planned.rows.forEach((row, i) => {
    const id = ctx.newId();
    const record: PageCreate = {
      id,
      workspaceId: ctx.workspaceId,
      sectionId: ctx.sectionId,
      parentPageId: databaseId,
      orderKey: keys[i],
      kind: 'row',
      title: row.title,
      icon: null,
      coverAssetId: null,
      isTemplate: false,
      templateOfPageId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      trashRootId: null,
      row: { values: row.values },
    };
    ops.push(newOp('page.create', ctx.workspaceId, id, record));
  });
  return ops;
}

/** The properties of a new database made from the file (the first column is its title). */
export function inferredProperties(table: CsvTable, databaseId: Id): PropertyDef[] {
  return inferProperties(table.header, table.records, { databaseId });
}

/**
 * The operations that make a new database from the file: its page with the properties (options
 * the rows need included), a table view, and the rows.
 */
export function newDatabaseOps(options: {
  table: CsvTable;
  properties: PropertyDef[];
  databaseId: Id;
  title: string;
  viewName: string;
  place: { workspaceId: Id; sectionId: Id; parentPageId: Id | null; orderKey: string };
  newId(): Id;
  now?: string;
}): { ops: Operation[]; viewId: Id; planned: PlannedImport } {
  const { table, databaseId, place } = options;
  const now = options.now ?? new Date().toISOString();
  const draft: DatabaseRecord = {
    id: databaseId,
    workspaceId: place.workspaceId,
    properties: options.properties,
    version: 1,
    rowCount: 0,
    createdAt: now,
  };
  const planned = planImportValues(
    draft,
    table,
    options.properties.map((p) => p.id),
  );
  const properties = options.properties.map((p) => planned.changed.find((c) => c.id === p.id) ?? p);
  const page: PageCreate = {
    id: databaseId,
    workspaceId: place.workspaceId,
    sectionId: place.sectionId,
    parentPageId: place.parentPageId,
    orderKey: place.orderKey,
    kind: 'database',
    title: options.title,
    icon: null,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    trashRootId: null,
    database: { properties },
  };
  const viewId = options.newId();
  const view: ViewRecord = {
    id: viewId,
    workspaceId: place.workspaceId,
    databaseId,
    name: options.viewName,
    type: 'table',
    orderKey: 'a0',
    config: emptyConfig('table'),
    version: 1,
    createdAt: now,
  };
  const rows = importOps(
    databaseId,
    { ...planned, changed: [] },
    {
      workspaceId: place.workspaceId,
      sectionId: place.sectionId,
      newId: options.newId,
      endKey: 'a0',
      now,
    },
  );
  return {
    ops: [
      newOp('page.create', place.workspaceId, databaseId, page),
      newOp('view.upsert', place.workspaceId, viewId, view),
      ...rows,
    ],
    viewId,
    planned,
  };
}

/** A file name without its extension, as a database's title. */
export const titleFromFile = (name: string): string => name.replace(/\.(csv|tsv|txt)$/i, '').trim();
