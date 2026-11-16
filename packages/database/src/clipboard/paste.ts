// A paste into the table, and a clear of a selection, as plans of what each cell becomes, then as
// operations: one batch through `host.apply` (a `db.update` for options the paste needs, a
// `row.update` per row, a `page.update` per title, a `page.create` per row added). Pure.
//
// Each pasted value is read by its property's rules: first what Excel and Sheet show, by the
// device's locale (read.ts: numbers with its separators, a currency, a percent or an accounting
// negative; its short dates and times; members by email or a unique name; checkbox words), then
// the conversion table's text column (`convertValue` from text; options by name through
// `convertProperty`, which makes the options a paste needs with ids derived from their names, as a
// type change does). A number is read by the locale first (`1,234` is 1.234 on a German device),
// a date by the table first (ISO text), then by the locale. Text that is only whitespace clears a
// cell. What neither reads is refused: the cell keeps its value and is counted. A file or a related
// row has no reading from text, so those are refused unless the paste is of the tab's own copy
// (copy.ts), whose values are converted from their own type instead. Formulas, rollups and the
// created and edited properties hold no value: their cells are left as they were and counted.
//
// The rectangle starts at the selection's first cell. A single value pasted into a selection of
// more than one cell fills it. Rows past the last one shown are added, at most `PASTE_ROW_LIMIT` a
// paste, and none when the view has rows still to load (they would not land where they are
// pasted); the rows left out are counted. Columns past the last one are counted too.
import {
  newOp,
  parseBoolean,
  type Id,
  type Operation,
  type PageCreate,
  type RowRecord,
} from '@cgw/workspace';
import {
  convertProperty,
  convertValue,
  type DatabaseRecord,
  type PropertyDef,
  type PropertyId,
  type Value,
} from '../core';
import type { Person } from '../host';
import { isEditableType } from '../model/properties';
import type { Clip, CopiedCell } from './copy';
import { readPastedCheckbox, readPastedDate, readPastedNumber, readPastedPeople } from './read';
import type { ClipCell } from './tsv';

/** Rows one paste may add after the last row (the person's answer, 2026-11-16). */
export const PASTE_ROW_LIMIT = 1000;

const TEXT_DEF: PropertyDef = { id: '', name: '', type: 'text' };

const isOptionType = (def: PropertyDef) =>
  def.type === 'select' || def.type === 'status' || def.type === 'multiSelect';

export type PasteSource = { kind: 'text'; rows: ClipCell[][] } | { kind: 'clip'; clip: Clip };

export interface PasteInput {
  database: DatabaseRecord;
  /** The table's columns from the rectangle's first column on, in the view's order. */
  columns: readonly PropertyDef[];
  /** The rows from the rectangle's first row on, as the view lists them. */
  rows: readonly RowRecord[];
  source: PasteSource;
  /** The selection's size when it is more than one cell: a single value fills it. */
  fill: { rows: number; cols: number } | null;
  /** Rows a paste past the last one may add (0: none). */
  maxNewRows: number;
  /**
   * What reading pasted text needs beyond the conversion table: the device's locale (its number
   * separators and date order; default `en-US`) and the workspace's people (the person picker's).
   */
  reading?: PasteReading;
}

export interface PasteReading {
  locale: string;
  people: readonly Person[];
}

const DEFAULT_READING: PasteReading = { locale: 'en-US', people: [] };

/** What a paste or a clear writes to a row: values by property (null clears) and the title. */
export interface RowChange {
  values: Record<PropertyId, Value | null>;
  title?: string;
}

export interface CellCounts {
  /** Cells whose value changes (in rows added: cells given a value). */
  changed: number;
  /** Cells that already held what was pasted. */
  unchanged: number;
  /** Values the property's rules could not read: left as they were. */
  refused: number;
  /** Cells of formulas, rollups and the created and edited properties: left as they were. */
  computed: number;
  /** Cells past the last column. */
  outside: number;
  /** Rows past the last row that were not added (over the limit, or rows still to load). */
  rowsLeftOut: number;
}

export interface CellPlan {
  /** Changes to rows that exist, by id: only the cells whose value changes. */
  updates: Map<Id, RowChange>;
  /** What those cells held before (for Undo). */
  before: Map<Id, RowChange>;
  /** Rows to add after the last one. */
  added: { title: string; values: Record<PropertyId, Value> }[];
  /** Properties with options the paste needs (written first, in one `db.update`). */
  defs: PropertyDef[];
  /** The rectangle written: its rows (those that exist, then those added) and columns. */
  size: { rows: number; cols: number };
  counts: CellCounts;
}

type Outcome = { kind: 'set'; value: Value | null } | { kind: 'refused' } | { kind: 'missing' };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const emptyCounts = (): CellCounts => ({
  changed: 0,
  unchanged: 0,
  refused: 0,
  computed: 0,
  outside: 0,
  rowsLeftOut: 0,
});

const isBlank = (value: unknown) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

/** The cell's value from the tab's own copy, by the conversion table from its own type. */
function fromCopy(
  cell: CopiedCell,
  def: PropertyDef,
  sameDatabase: boolean,
): Outcome | { kind: 'text'; text: string } {
  if (isBlank(cell.value)) return { kind: 'set', value: def.type === 'title' ? '' : null };
  if (sameDatabase && cell.def.id === def.id) return { kind: 'set', value: cell.value as Value };
  if (isOptionType(def)) {
    // Options by name (made when missing), from what the value reads as as text.
    const text = convertValue(cell.def, TEXT_DEF, cell.value);
    return typeof text === 'string' ? { kind: 'text', text } : { kind: 'refused' };
  }
  const value = convertValue(cell.def, def, cell.value);
  if (value !== undefined) return { kind: 'set', value };
  // A checkbox's "no" is no value, not a value it cannot read (0, false, an option named No).
  if (def.type === 'checkbox') {
    const text = convertValue(cell.def, TEXT_DEF, cell.value);
    if (typeof text === 'string' && parseBoolean(text) === false)
      return { kind: 'set', value: null };
  }
  return { kind: 'refused' };
}

/** A cell's value from clipboard text: what spreadsheets show (read.ts), then the conversion table. */
function fromText(
  cell: ClipCell,
  def: PropertyDef,
  reading: PasteReading,
): Outcome | { kind: 'text'; text: string } {
  if (def.type === 'title') return { kind: 'set', value: cell.text.trim() === '' ? '' : cell.text };
  if (cell.text.trim() === '') return { kind: 'set', value: null };
  if (isOptionType(def)) return { kind: 'text', text: cell.text };
  const set = (value: Value | null | undefined): Outcome =>
    value === undefined ? { kind: 'refused' } : { kind: 'set', value };
  switch (def.type) {
    case 'number':
      if (cell.number !== undefined && Number.isFinite(cell.number))
        return set(cell.number === 0 ? 0 : cell.number);
      return set(
        readPastedNumber(cell.text, def, reading.locale) ?? convertValue(TEXT_DEF, def, cell.text),
      );
    case 'checkbox': {
      // FALSE, no, 0, لا: unchecked, which is no value.
      const checked = readPastedCheckbox(cell.text);
      return set(checked === undefined ? undefined : checked || null);
    }
    case 'date':
      return set(
        convertValue(TEXT_DEF, def, cell.text) ?? readPastedDate(cell.text, reading.locale),
      );
    case 'person':
      return set(readPastedPeople(cell.text, reading.people));
    default:
      return set(convertValue(TEXT_DEF, def, cell.text));
  }
}

/**
 * Writes outcomes (rows of columns, `missing` where a row has no cell) over rows that exist and
 * rows to add, counting as it goes.
 */
function plan(
  rows: readonly RowRecord[],
  columns: readonly PropertyDef[],
  outcomes: Outcome[][],
  counts: CellCounts,
  defs: PropertyDef[],
): CellPlan {
  const updates = new Map<Id, RowChange>();
  const before = new Map<Id, RowChange>();
  const added: CellPlan['added'] = [];
  outcomes.forEach((line, r) => {
    const row = r < rows.length ? rows[r] : null;
    const fresh = row ? null : { title: '', values: {} as Record<PropertyId, Value> };
    line.forEach((outcome, c) => {
      const def = columns[c];
      if (outcome.kind === 'missing' || !def) return;
      if (outcome.kind === 'refused') {
        counts.refused++;
        return;
      }
      const value = outcome.value;
      if (fresh) {
        if (def.type === 'title') fresh.title = typeof value === 'string' ? value : '';
        else if (value !== null) fresh.values[def.id] = value;
        if (!isBlank(value)) counts.changed++;
        return;
      }
      const old = def.type === 'title' ? row!.title : (row!.values[def.id] ?? null);
      if (same(old, value)) {
        counts.unchanged++;
        return;
      }
      counts.changed++;
      const change = updates.get(row!.id) ?? { values: {} };
      const was = before.get(row!.id) ?? { values: {} };
      if (def.type === 'title') {
        change.title = typeof value === 'string' ? value : '';
        if (was.title === undefined) was.title = row!.title;
      } else {
        change.values[def.id] = value;
        if (!(def.id in was.values)) was.values[def.id] = (old as Value | null) ?? null;
      }
      updates.set(row!.id, change);
      before.set(row!.id, was);
    });
    if (fresh) added.push(fresh);
  });
  return {
    updates,
    before,
    added,
    defs,
    size: { rows: outcomes.length, cols: columns.length },
    counts,
  };
}

/** What a paste writes. */
export function planPaste(input: PasteInput): CellPlan {
  const { database, columns, rows, source, fill } = input;
  const counts = emptyCounts();
  // The pasted cells, as rows; a single one fills a larger selection.
  type Cell = ClipCell | CopiedCell;
  let grid: Cell[][] = source.kind === 'text' ? source.rows : source.clip.cells;
  if (
    fill &&
    fill.rows * fill.cols > 1 &&
    grid.length === 1 &&
    grid[0].length === 1 &&
    fill.rows > 0 &&
    fill.cols > 0
  ) {
    const one = grid[0][0];
    grid = Array.from({ length: fill.rows }, () => Array.from({ length: fill.cols }, () => one));
  }
  const height = grid.length;
  const extra = Math.max(0, height - rows.length);
  const addCount = Math.min(extra, Math.max(0, Math.min(PASTE_ROW_LIMIT, input.maxNewRows)));
  counts.rowsLeftOut = extra - addCount;
  const lines = grid.slice(0, Math.min(height, rows.length + addCount));
  const width = Math.max(0, ...lines.map((line) => line.length));
  const targets = columns.slice(0, width);
  for (const line of lines) counts.outside += Math.max(0, line.length - targets.length);

  const sameDatabase = source.kind === 'clip' && source.clip.databaseId === database.id;
  type Pending = Outcome | { kind: 'text'; text: string };
  const pending: Pending[][] = lines.map((line) =>
    targets.map((def, c): Pending => {
      if (c >= line.length) return { kind: 'missing' };
      if (!isEditableType(def.type)) {
        counts.computed++;
        return { kind: 'missing' };
      }
      const cell = line[c];
      return 'def' in cell
        ? fromCopy(cell, def, sameDatabase)
        : fromText(cell, def, input.reading ?? DEFAULT_READING);
    }),
  );

  // Options by name, a column at a time: the names no option has are made, as a type change
  // makes them (ids derived from the database, the property and the name).
  const defs: PropertyDef[] = [];
  targets.forEach((def, c) => {
    if (!isOptionType(def)) return;
    const at: number[] = [];
    const texts: string[] = [];
    pending.forEach((line, r) => {
      const p = line[c];
      if (p.kind === 'text') {
        at.push(r);
        texts.push(p.text);
      }
    });
    if (!texts.length) return;
    const converted = convertProperty(TEXT_DEF, def, texts, database.id);
    if ((converted.def.options?.length ?? 0) > (def.options?.length ?? 0)) defs.push(converted.def);
    at.forEach((r, i) => {
      const value = converted.values[i];
      pending[r][c] = value === undefined ? { kind: 'refused' } : { kind: 'set', value };
    });
  });

  const outcomes = pending as Outcome[][];
  return plan(rows, targets, outcomes, counts, defs);
}

/** What a clear of cells writes: every value it may hold gone, the title empty. */
export function planClear(rows: readonly RowRecord[], columns: readonly PropertyDef[]): CellPlan {
  const counts = emptyCounts();
  const outcomes = rows.map(() =>
    columns.map((def): Outcome => {
      if (!isEditableType(def.type)) {
        counts.computed++;
        return { kind: 'missing' };
      }
      return { kind: 'set', value: def.type === 'title' ? '' : null };
    }),
  );
  return plan(rows, columns, outcomes, counts, []);
}

/** Where the operations of a plan go, and what a row added starts with. */
export interface CellContext {
  workspaceId: Id;
  databaseId: Id;
  sectionId: Id;
  newId(): Id;
  /** Order keys for the rows added, in order, after every row. */
  orderKeys(count: number): string[];
  /** What a row made in the view starts with (its group's value, its filter's). */
  preset: { title: string; values: Record<PropertyId, Value> };
  /** The time a row added is made at (ISO). */
  now: string;
}

/** A plan as one batch of operations, and the ids of the rows it adds. */
export function planOperations(
  cellPlan: CellPlan,
  ctx: CellContext,
): { ops: Operation[]; created: Id[] } {
  const ops: Operation[] = [];
  if (cellPlan.defs.length)
    ops.push(newOp('db.update', ctx.workspaceId, ctx.databaseId, { properties: cellPlan.defs }));
  for (const [rowId, change] of cellPlan.updates) {
    if (Object.keys(change.values).length)
      ops.push(newOp('row.update', ctx.workspaceId, rowId, { values: change.values }));
    if (change.title !== undefined)
      ops.push(newOp('page.update', ctx.workspaceId, rowId, { title: change.title }));
  }
  const created: Id[] = [];
  const keys = cellPlan.added.length ? ctx.orderKeys(cellPlan.added.length) : [];
  cellPlan.added.forEach((row, i) => {
    const id = ctx.newId();
    created.push(id);
    const record: PageCreate = {
      id,
      workspaceId: ctx.workspaceId,
      sectionId: ctx.sectionId,
      parentPageId: ctx.databaseId,
      orderKey: keys[i],
      kind: 'row',
      title: row.title || ctx.preset.title,
      icon: null,
      coverAssetId: null,
      isTemplate: false,
      templateOfPageId: null,
      version: 1,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      trashedAt: null,
      trashRootId: null,
      row: { values: { ...ctx.preset.values, ...row.values } },
    };
    ops.push(newOp('page.create', ctx.workspaceId, id, record));
  });
  return { ops, created };
}

/** What Undo takes back: each row's cells before and after, and the rows the paste added. */
export interface CellUndo {
  workspaceId: Id;
  rows: Map<Id, { before: RowChange; after: RowChange }>;
  created: Id[];
}

export function undoOf(cellPlan: CellPlan, workspaceId: Id, created: Id[]): CellUndo {
  const rows = new Map<Id, { before: RowChange; after: RowChange }>();
  for (const [id, after] of cellPlan.updates)
    rows.set(id, { before: cellPlan.before.get(id) ?? { values: {} }, after });
  return { workspaceId, rows, created };
}

/**
 * Undo as one batch: each cell that still holds what was written gets its old value back (a cell
 * changed since, here or elsewhere, keeps the newer value), and the rows added go to the trash.
 * `current` reads a row as it is now (null when this device does not have it: its cells are
 * written back as they were).
 */
export function undoOperations(
  undo: CellUndo,
  current: (rowId: Id) => RowRecord | null,
): { ops: Operation[]; kept: number } {
  const ops: Operation[] = [];
  let kept = 0;
  for (const [rowId, { before, after }] of undo.rows) {
    const row = current(rowId);
    if (row?.trashedAt) continue;
    const values: Record<PropertyId, Value | null> = {};
    for (const [id, value] of Object.entries(after.values)) {
      if (row && !same(row.values[id], value)) {
        kept++;
        continue;
      }
      values[id] = before.values[id] ?? null;
    }
    if (Object.keys(values).length)
      ops.push(newOp('row.update', undo.workspaceId, rowId, { values }));
    if (after.title !== undefined && before.title !== undefined) {
      if (row && row.title !== after.title) kept++;
      else ops.push(newOp('page.update', undo.workspaceId, rowId, { title: before.title }));
    }
  }
  for (const id of undo.created) {
    const row = current(id);
    if (row?.trashedAt) continue;
    ops.push(newOp('page.trash', undo.workspaceId, id, {}, row?.version ?? null));
  }
  return { ops, kept };
}
