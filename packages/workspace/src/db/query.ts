// Filter, sort and group (Phase 4 contracts, section 2): one definition, evaluated by the same
// rules here (full holds) and by the C# port on the server (large databases). Shared vectors:
// db-query-vectors.json.
//
// Each property reads as a kind: text (title, text, url, email, phone), number, date (date,
// created and edited time), checkbox, select, status, list (multi-select, person, relation,
// created and edited by), files; a formula as its checked result (text, number, date, checkbox
// for booleans, list), a rollup by its function (number; earliest and latest: date; showOriginal:
// list). Cells are read as `cellValue` reads them; a cell that does not fit its kind (an error, a
// broken formula) is empty.
//
// Filters (`db/types.ts`, FilterOperator):
//   - A condition is ignored (left out of its group) when its property is unknown, deleted or of
//     no kind, its operator does not fit the kind, or it needs a value and its value does not fit
//     (text: a string or number whose normalised form is not ''; number: a number or numeric text;
//     date: `{ date }`, `{ relative }` or a date string; checkbox: a boolean; select and status: a
//     string; status group: a group name; list: a string, or `{ me: true }` for the asker). A
//     group with nothing left is ignored too; the whole filter ignored matches every row.
//   - text: `normaliseText` of both sides; is, isNot, contains, doesNotContain, startsWith,
//     endsWith on those (an empty cell is ''). number: as doubles; an empty cell passes only ne.
//     date: the calendar date of the start in `ctx.offsetMinutes`, against
//     the value's date (relative ones from `ctx.today`); an empty cell fails all but isEmpty.
//     checkbox: is (an empty formula result is neither). select: is, isNot (an empty cell is not
//     the value); status also `group` (an unknown option has no group).
//     list: contains (one item is the value), doesNotContain. isEmpty / isNotEmpty on every kind
//     but checkbox.
// Sorts: by each rule in turn, then by order key, then id (ordinal). Empty cells sort last in both
//   directions. Text: ordinal (UTF-16) order of the normalised text. Number. Date: the start's
//   milliseconds (a date-only start is its midnight in `ctx.offsetMinutes`). Checkbox: false
//   first. Select: the option's position; status: group (todo, inProgress, complete), then
//   position. Multi-select: the value's option positions in its order, compared item by item (a
//   shorter prefix first). People (person, created and edited by): each person's normalised name
//   from `ctx.people` (else the id), then id, item by item. Files and relation: by count.
//   Formula and rollup results: by kind (number, date, text, boolean, list by count), then within
//   it as above; errors are empty.
// Groups: see `groupKeys` and `queryRows`.
// Search: every word of `normaliseText(search)` starts a word of the normalised title.
import type { Id } from '../ids';
import { normaliseText as normalise, searchTerms } from '../search';
import type { RowRecord } from '../types';
import { isErrorCell } from './convert';
import {
  DATE_POINT,
  calendarDate,
  parseDatePoint,
  pointMs,
  relativeDate,
  truncateDate,
} from './dates';
import { compileDatabase, rollupType } from './formula/compile';
import { parseNumberText } from './text';
import type {
  CellValue,
  DatabaseRecord,
  DateValue,
  FilterCondition,
  FilterGroup,
  FilterOperator,
  FilterValue,
  GroupCount,
  GroupRule,
  PropertyDef,
  PropertyId,
  QueryContext,
  QuerySpec,
  SortRule,
  StatusGroup,
  StatusOption,
} from './types';
import { cellOf, optionIndex } from './values';

/** `normaliseText`, remembered: queries normalise the same cells again and again. */
const normalised = new Map<string, string>();
function normaliseText(text: string): string {
  let result = normalised.get(text);
  if (result === undefined) {
    if (normalised.size >= 50_000) normalised.clear();
    result = normalise(text);
    normalised.set(text, result);
  }
  return result;
}

export type QueryKind =
  'text' | 'number' | 'date' | 'checkbox' | 'select' | 'status' | 'list' | 'files';

export interface QueryOptions {
  /** This device's formula and rollup results for a row (`computeRow`), where it holds the inputs. */
  computed?: (row: RowRecord) => Record<PropertyId, CellValue> | undefined;
  /** Only the rows of this group, as the server's `groupKey` pages one group. */
  groupKey?: string;
}

export interface QueryResult {
  /**
   * The rows in the query's order. Grouped, rows whose every group is hidden are left out (each
   * row is listed once; `groupKeys` says which groups it shows in).
   */
  rows: RowRecord[];
  /** The groups to show, in order, with their counts over the filtered rows; null ungrouped. */
  groups: GroupCount[] | null;
}

const OPERATORS: Record<QueryKind, readonly FilterOperator[]> = {
  text: [
    'is',
    'isNot',
    'contains',
    'doesNotContain',
    'startsWith',
    'endsWith',
    'isEmpty',
    'isNotEmpty',
  ],
  number: ['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'isEmpty', 'isNotEmpty'],
  date: ['is', 'before', 'after', 'onOrBefore', 'onOrAfter', 'isEmpty', 'isNotEmpty'],
  checkbox: ['is'],
  select: ['is', 'isNot', 'isEmpty', 'isNotEmpty'],
  status: ['is', 'isNot', 'isEmpty', 'isNotEmpty', 'group'],
  list: ['contains', 'doesNotContain', 'isEmpty', 'isNotEmpty'],
  files: ['isEmpty', 'isNotEmpty'],
};

/** The operators a kind takes, for the filter editor. */
export const operatorsFor = (kind: QueryKind): readonly FilterOperator[] => OPERATORS[kind];

const STATUS_GROUPS: readonly StatusGroup[] = ['todo', 'inProgress', 'complete'];

/** The kind a property reads as for filters and sorts; null when it has none (a broken formula). */
export function propertyKind(database: DatabaseRecord, def: PropertyDef): QueryKind | null {
  switch (def.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return 'text';
    case 'number':
      return 'number';
    case 'date':
    case 'createdTime':
    case 'lastEditedTime':
      return 'date';
    case 'checkbox':
      return 'checkbox';
    case 'select':
      return 'select';
    case 'status':
      return 'status';
    case 'multiSelect':
    case 'person':
    case 'relation':
    case 'createdBy':
    case 'lastEditedBy':
      return 'list';
    case 'files':
      return 'files';
    case 'rollup': {
      const type = rollupType(def.rollup?.fn);
      return type === 'date' ? 'date' : type === 'list' ? 'list' : 'number';
    }
    case 'formula': {
      const formula = compileDatabase(database).formulas.get(def.id);
      switch (formula?.type) {
        case 'number':
          return 'number';
        case 'text':
          return 'text';
        case 'date':
          return 'date';
        case 'boolean':
          return 'checkbox';
        case 'list':
          return 'list';
        default:
          return null;
      }
    }
    default:
      return null;
  }
}

type Computed = QueryOptions['computed'];

/** A cell made to fit its kind; anything else (an error, a mismatch) is null. */
function cellFor(def: PropertyDef, kind: QueryKind, row: RowRecord, computed: Computed): CellValue {
  const cell =
    def.type === 'formula' || def.type === 'rollup'
      ? cellOf(def, row, computed?.(row))
      : cellOf(def, row);
  if (cell === null || isErrorCell(cell)) return null;
  switch (kind) {
    case 'text':
      return typeof cell === 'string' && cell !== '' ? cell : null;
    case 'number':
      return typeof cell === 'number' && Number.isFinite(cell) ? cell : null;
    case 'checkbox':
      return typeof cell === 'boolean' ? cell : null;
    case 'select':
    case 'status':
      return typeof cell === 'string' ? cell : null;
    case 'date': {
      if (typeof cell !== 'object' || Array.isArray(cell)) return null;
      const start = (cell as DateValue).start;
      return typeof start === 'string' && DATE_POINT.test(start) ? cell : null;
    }
    case 'list':
    case 'files':
      return Array.isArray(cell) && cell.length ? cell : null;
  }
}

// ---------------------------------------------------------------------------------------------
// Filters

const IGNORED = 'ignored';
type Outcome = boolean | typeof IGNORED;

function dateOf(value: FilterValue | undefined, ctx: QueryContext): string | undefined {
  if (typeof value === 'string') {
    const point = parseDatePoint(value);
    return point && calendarDate(point, ctx.offsetMinutes);
  }
  if (typeof value !== 'object' || value === null) return undefined;
  if ('date' in value && typeof value.date === 'string') {
    const point = parseDatePoint(value.date);
    return point && calendarDate(point, ctx.offsetMinutes);
  }
  if ('relative' in value) return relativeDate(ctx.today, value.relative);
  return undefined;
}

function condition(
  database: DatabaseRecord,
  props: ReadonlyMap<PropertyId, PropertyDef>,
  row: RowRecord,
  c: FilterCondition,
  ctx: QueryContext,
  computed: Computed,
): Outcome {
  const def = props.get(c.propertyId);
  if (!def || def.trashedAt) return IGNORED;
  const kind = propertyKind(database, def);
  if (!kind || !OPERATORS[kind].includes(c.operator)) return IGNORED;
  const cell = cellFor(def, kind, row, computed);
  if (c.operator === 'isEmpty') return cell === null;
  if (c.operator === 'isNotEmpty') return cell !== null;
  const value = c.value;
  switch (kind) {
    case 'text': {
      if (typeof value !== 'string' && typeof value !== 'number') return IGNORED;
      const v = normaliseText(String(value));
      if (v === '') return IGNORED;
      const t = cell === null ? '' : normaliseText(cell as string);
      switch (c.operator) {
        case 'is':
          return t === v;
        case 'isNot':
          return t !== v;
        case 'contains':
          return t.includes(v);
        case 'doesNotContain':
          return !t.includes(v);
        case 'startsWith':
          return t.startsWith(v);
        default:
          return t.endsWith(v);
      }
    }
    case 'number': {
      const v =
        typeof value === 'number'
          ? value
          : typeof value === 'string'
            ? parseNumberText(value)
            : undefined;
      if (v === undefined || !Number.isFinite(v)) return IGNORED;
      if (cell === null) return c.operator === 'ne';
      const n = cell as number;
      switch (c.operator) {
        case 'eq':
          return n === v;
        case 'ne':
          return n !== v;
        case 'gt':
          return n > v;
        case 'lt':
          return n < v;
        case 'ge':
          return n >= v;
        default:
          return n <= v;
      }
    }
    case 'date': {
      const v = dateOf(value, ctx);
      if (!v) return IGNORED;
      if (cell === null) return false;
      const d = calendarDate((cell as DateValue).start, ctx.offsetMinutes);
      switch (c.operator) {
        case 'is':
          return d === v;
        case 'before':
          return d < v;
        case 'after':
          return d > v;
        case 'onOrBefore':
          return d <= v;
        default:
          return d >= v;
      }
    }
    case 'checkbox':
      if (typeof value !== 'boolean') return IGNORED;
      return cell === value;
    case 'select':
    case 'status': {
      if (c.operator === 'group') {
        if (typeof value !== 'string' || !(STATUS_GROUPS as readonly string[]).includes(value))
          return IGNORED;
        if (cell === null) return false;
        const option = def.options?.[optionIndex(def, cell as string)] as StatusOption | undefined;
        return (option?.group ?? 'todo') === value;
      }
      if (typeof value !== 'string') return IGNORED;
      return c.operator === 'is' ? cell === value : cell !== value;
    }
    case 'list': {
      let v: Id | null;
      if (typeof value === 'string') v = value;
      else if (typeof value === 'object' && value !== null && 'me' in value && value.me === true)
        v = ctx.me;
      else return IGNORED;
      const has = v !== null && cell !== null && (cell as string[]).includes(v);
      return c.operator === 'contains' ? has : !has;
    }
    default:
      return IGNORED;
  }
}

function evaluate(
  database: DatabaseRecord,
  props: ReadonlyMap<PropertyId, PropertyDef>,
  row: RowRecord,
  node: FilterGroup | FilterCondition,
  ctx: QueryContext,
  computed: Computed,
): Outcome {
  if (node.kind === 'condition') return condition(database, props, row, node, ctx, computed);
  let outcome: Outcome = IGNORED;
  for (const child of node.children ?? []) {
    const result = evaluate(database, props, row, child, ctx, computed);
    if (result === IGNORED) continue;
    if (node.op === 'or') {
      if (result) return true;
      outcome = false;
    } else {
      if (!result) return false;
      outcome = true;
    }
  }
  return outcome;
}

const propsOf = (database: DatabaseRecord) => compileDatabase(database).props;

/** Whether a row passes a filter (null passes every row). */
export function matchesFilter(
  database: DatabaseRecord,
  row: RowRecord,
  filter: FilterGroup | FilterCondition | null | undefined,
  ctx: QueryContext,
  options: Pick<QueryOptions, 'computed'> = {},
): boolean {
  if (!filter) return true;
  return evaluate(database, propsOf(database), row, filter, ctx, options.computed) !== false;
}

// ---------------------------------------------------------------------------------------------
// Sorts

type Key = number | string | Key[];

const compareKey = (a: Key, b: Key): number => {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareKey(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const STATUS_RANK: Record<StatusGroup, number> = { todo: 0, inProgress: 1, complete: 2 };

function personKey(ids: readonly string[], ctx: QueryContext): Key {
  const key: Key[] = [];
  for (const id of ids) key.push(normaliseText(ctx.people?.[id] ?? id), id);
  return key;
}

/** A cell's sort key; null is empty. */
function sortKey(
  def: PropertyDef,
  kind: QueryKind,
  row: RowRecord,
  ctx: QueryContext,
  computed: Computed,
): Key | null {
  const cell = cellFor(def, kind, row, computed);
  if (cell === null) return null;
  if (def.type === 'formula' || def.type === 'rollup') {
    if (typeof cell === 'number') return [0, cell];
    if (typeof cell === 'string') return [2, normaliseText(cell)];
    if (typeof cell === 'boolean') return [3, cell ? 1 : 0];
    if (Array.isArray(cell)) return [4, cell.length];
    return [1, pointMs((cell as DateValue).start, ctx.offsetMinutes)];
  }
  switch (def.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return normaliseText(cell as string);
    case 'number':
      return cell as number;
    case 'date':
    case 'createdTime':
    case 'lastEditedTime':
      return pointMs((cell as DateValue).start, ctx.offsetMinutes);
    case 'checkbox':
      return cell ? 1 : 0;
    case 'select':
      return optionIndex(def, cell as string);
    case 'status': {
      const index = optionIndex(def, cell as string);
      const group = (def.options?.[index] as StatusOption | undefined)?.group ?? 'todo';
      return [STATUS_RANK[group] ?? 0, index];
    }
    case 'multiSelect':
      return (cell as string[]).map((id) => optionIndex(def, id));
    case 'person':
    case 'createdBy':
    case 'lastEditedBy':
      return personKey(cell as string[], ctx);
    case 'files':
    case 'relation':
      return (cell as string[]).length;
    default:
      return null;
  }
}

/**
 * The query's row order: each sort rule in turn (rules on unknown or deleted properties, or on
 * properties of no kind, are skipped), then order key, then id.
 */
export function compareRows(
  database: DatabaseRecord,
  sorts: readonly SortRule[],
  ctx: QueryContext,
  options: Pick<QueryOptions, 'computed'> = {},
): (a: RowRecord, b: RowRecord) => number {
  const props = propsOf(database);
  const rules: { def: PropertyDef; kind: QueryKind; desc: boolean }[] = [];
  for (const sort of sorts) {
    const def = props.get(sort.propertyId);
    if (!def || def.trashedAt) continue;
    const kind = propertyKind(database, def);
    if (kind) rules.push({ def, kind, desc: sort.direction === 'desc' });
  }
  const keys = new Map<RowRecord, (Key | null)[]>();
  const keysOf = (row: RowRecord) => {
    let k = keys.get(row);
    if (!k) {
      k = rules.map((rule) => sortKey(rule.def, rule.kind, row, ctx, options.computed));
      keys.set(row, k);
    }
    return k;
  };
  return (a, b) => {
    const ka = keysOf(a);
    const kb = keysOf(b);
    for (let i = 0; i < rules.length; i++) {
      const x = ka[i];
      const y = kb[i];
      if (x === null || y === null) {
        if (x !== y) return x === null ? 1 : -1;
        continue;
      }
      const c = compareKey(x, y);
      if (c) return rules[i].desc ? -c : c;
    }
    return ordinal(a.orderKey, b.orderKey) || ordinal(a.id, b.id);
  };
}

// ---------------------------------------------------------------------------------------------
// Groups

const GROUPABLE = new Set([
  'select',
  'status',
  'multiSelect',
  'checkbox',
  'person',
  'date',
  'createdTime',
  'lastEditedTime',
  'createdBy',
  'lastEditedBy',
]);

/** The default span of a date group. */
export const DEFAULT_DATE_BY = 'month';

function groupDef(
  database: DatabaseRecord,
  rule: GroupRule | null | undefined,
): PropertyDef | null {
  if (!rule) return null;
  const def = propsOf(database).get(rule.propertyId);
  return def && !def.trashedAt && GROUPABLE.has(def.type) ? def : null;
}

/**
 * The groups a row shows in (never none; `''` is "no value"): the option id (select, status), each
 * option id it holds (multi-select), `true` or `false` (checkbox), each person's id (person,
 * created and edited by), the date's start as a calendar date in `ctx.offsetMinutes` cut by
 * `dateBy` (default month: the first of the month; week: its Monday). Unknown option ids are no
 * value. `['']` for a rule that groups nothing.
 */
export function groupKeys(
  database: DatabaseRecord,
  row: RowRecord,
  rule: GroupRule,
  ctx: QueryContext,
): string[] {
  const def = groupDef(database, rule);
  if (!def) return [''];
  const cell = cellOf(def, row);
  if (cell === null) return [''];
  switch (def.type) {
    case 'checkbox':
      return [cell ? 'true' : 'false'];
    case 'select':
    case 'status':
      return [cell as string];
    case 'multiSelect':
    case 'person':
    case 'createdBy':
    case 'lastEditedBy':
      return [...new Set(cell as string[])];
    default: {
      const start = (cell as DateValue).start;
      return [truncateDate(calendarDate(start, ctx.offsetMinutes), rule.dateBy ?? DEFAULT_DATE_BY)];
    }
  }
}

/**
 * Group order: options in def order (select, status, multi-select), every one listed; checkbox
 * false then true; people by normalised name (from `ctx.people`, else the id), then id; dates
 * ascending; people and dates list only the keys some row has. `''` comes first, always listed
 * (checkbox has none). Then `hidden` keys are dropped, and with `hideEmpty` groups of no rows.
 */
function groupOrder(def: PropertyDef, present: Map<string, number>, ctx: QueryContext): string[] {
  switch (def.type) {
    case 'checkbox':
      return ['false', 'true'];
    case 'select':
    case 'status':
    case 'multiSelect':
      return ['', ...[...new Set((def.options ?? []).map((o) => o.id))]];
    case 'person':
    case 'createdBy':
    case 'lastEditedBy': {
      const ids = [...present.keys()].filter((k) => k !== '');
      const name = (id: string) => normaliseText(ctx.people?.[id] ?? id);
      ids.sort((a, b) => ordinal(name(a), name(b)) || ordinal(a, b));
      return ['', ...ids];
    }
    default:
      return ['', ...[...present.keys()].filter((k) => k !== '').sort(ordinal)];
  }
}

/**
 * Rows of a database as a view shows them: templates and trashed rows never; then the search,
 * the filter, the sorts; then, with a group rule on a groupable property (else it is ignored),
 * the groups and their counts.
 */
export function queryRows(
  database: DatabaseRecord,
  rows: readonly RowRecord[],
  spec: QuerySpec,
  ctx: QueryContext,
  options: QueryOptions = {},
): QueryResult {
  const terms = searchTerms(normaliseText(spec.search ?? ''));
  let result = rows.filter((row) => {
    if (row.isTemplate || row.trashedAt) return false;
    if (terms.length) {
      const words = normaliseText(row.title ?? '').split(' ');
      if (!terms.every((term) => words.some((word) => word.startsWith(term)))) return false;
    }
    return matchesFilter(database, row, spec.filter, ctx, options);
  });
  result.sort(compareRows(database, spec.sorts ?? [], ctx, options));

  const def = groupDef(database, spec.group);
  if (!def || !spec.group) return { rows: result, groups: null };
  const rule = spec.group;
  const keysByRow = new Map<RowRecord, string[]>();
  const counts = new Map<string, number>();
  for (const row of result) {
    const keys = groupKeys(database, row, rule, ctx);
    keysByRow.set(row, keys);
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const hidden = new Set(rule.hidden ?? []);
  const groups: GroupCount[] = [];
  for (const key of groupOrder(def, counts, ctx)) {
    const count = counts.get(key) ?? 0;
    if (hidden.has(key) || (rule.hideEmpty && count === 0)) continue;
    groups.push({ key, count });
  }
  const shown = new Set(groups.map((g) => g.key));
  if (options.groupKey !== undefined) {
    const key = options.groupKey;
    result = result.filter((row) => keysByRow.get(row)!.includes(key));
  } else result = result.filter((row) => keysByRow.get(row)!.some((key) => shown.has(key)));
  return { rows: result, groups };
}
