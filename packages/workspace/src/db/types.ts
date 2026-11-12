// Workspace databases (DATA_MODEL.md, Databases; Phase 4). The records the stores mirror, the
// values rows hold, and the view, filter, sort and group definitions. The same rules run in
// TypeScript here and in C# on the server (`server/src/Cgw.Core/Databases`), held together by the
// shared vectors in `packages/workspace/vectors/db-*.json`. No React, no DOM.
import type { Id } from '../ids';

/** 8 characters of base 62, unique within its database; `title` is the title property's. */
export type PropertyId = string;
/** 8 characters of base 62, unique within its property. */
export type OptionId = string;

export const TITLE_PROPERTY: PropertyId = 'title';

export type PropertyType =
  | 'title'
  | 'text'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'select'
  | 'multiSelect'
  | 'status'
  | 'person'
  | 'url'
  | 'email'
  | 'phone'
  | 'files'
  | 'relation'
  | 'formula'
  | 'rollup'
  | 'createdTime'
  | 'createdBy'
  | 'lastEditedTime'
  | 'lastEditedBy';

/** Types whose value is stored in `RowRecord.values`. The rest come from the page or `computed`. */
export const STORED_TYPES: readonly PropertyType[] = [
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
];

/** The theme's named colours, as the editor's colour marks use them; `default` is no colour. */
export type OptionColour =
  'default' | 'gray' | 'brown' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'red';

export interface SelectOption {
  id: OptionId;
  name: string;
  colour: OptionColour;
}

export type StatusGroup = 'todo' | 'inProgress' | 'complete';

export interface StatusOption extends SelectOption {
  group: StatusGroup;
}

export type NumberFormat = 'number' | 'integer' | 'percent' | 'currency';

export type RollupFunction =
  | 'count'
  | 'countValues'
  | 'countUnique'
  | 'countEmpty'
  | 'countNotEmpty'
  | 'percentEmpty'
  | 'percentNotEmpty'
  | 'sum'
  | 'average'
  | 'median'
  | 'min'
  | 'max'
  | 'range'
  | 'earliest'
  | 'latest'
  | 'checked'
  | 'unchecked'
  | 'percentChecked'
  | 'showOriginal';

export interface PropertyDef {
  id: PropertyId;
  name: string;
  type: PropertyType;
  /** Select, multi-select and status: the options in their order (status options carry a group). */
  options?: (SelectOption | StatusOption)[];
  /** Number: how it is shown; the value is a plain number either way. */
  number?: { format: NumberFormat; decimals: number | null; currency?: string | null };
  /** Date, created and edited time: shown with the time of day. */
  date?: { includeTime: boolean };
  /** Relation: the database it points into and the property there kept in step with this one. */
  relation?: { databaseId: Id; reversePropertyId: PropertyId | null };
  /** Rollup: a property of the related rows, reduced by a function. */
  rollup?: { relationPropertyId: PropertyId; targetPropertyId: PropertyId; fn: RollupFunction };
  /** Formula: the expression, with properties named by id: `prop("Ab12Cd34")`. */
  formula?: { expression: string };
  /**
   * Set when the property was deleted: it is hidden everywhere and computes nothing, its values
   * stay on the rows, and it can be restored. Never set on the title property.
   */
  trashedAt?: string | null;
}

/** A date, or a span of dates; date-times are UTC instants, dates are calendar dates. */
export interface DateValue {
  /** `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm:ssZ` (UTC) when the property includes the time. */
  start: string;
  end?: string | null;
}

/**
 * A stored value, by type: text, url, email, phone: string; number: number (an IEEE double, as
 * both evaluators use); date: DateValue; checkbox: boolean; select, status: OptionId;
 * multiSelect: OptionId[]; person: user Id[]; files: asset Id[]; relation: row Id[] (at most
 * 1,000). An empty value is absent from `values`, never stored as '' or [].
 */
export type Value = string | number | boolean | DateValue | string[];

/**
 * What a formula or rollup gives, and what any cell reads as for filters, sorts and formulas.
 * `null` is empty; an error says why (`formula.syntax`, `formula.type`, `formula.cycle`, ...).
 */
export type CellValue = null | string | number | boolean | DateValue | string[] | CellError;

export interface CellError {
  error: string;
}

export interface DatabaseRecord {
  /** The database's page id: the database is a page of kind `database`. */
  id: Id;
  workspaceId: Id;
  /** In display order, trashed ones included; exactly one of type `title`, with id `title`. */
  properties: PropertyDef[];
  /** Rises on every change to the properties. */
  version: number;
  /**
   * Rows on the server, not trashed and not templates, as the server last said; a local-only
   * database counts its own. Above `LOCAL_ROW_LIMIT` the server answers this database's queries.
   */
  rowCount: number;
  createdAt: string;
}

/** At or below this many rows a device holds every row and queries locally (DECISIONS.md, Phase 4). */
export const LOCAL_ROW_LIMIT = 5000;

export type ViewType = 'table' | 'board' | 'list' | 'calendar' | 'gallery';

export interface ViewRecord {
  id: Id;
  workspaceId: Id;
  databaseId: Id;
  name: string;
  type: ViewType;
  /** Among the database's views. */
  orderKey: string;
  config: ViewConfig;
  version: number;
  createdAt: string;
}

export interface ViewConfig {
  filter: FilterGroup | null;
  sorts: SortRule[];
  /** A board's columns (required on a board); optional sections in a table or list. */
  group: GroupRule | null;
  /**
   * The properties shown, in order: `order` first, then any not named in it in database order;
   * `hidden` are left out. The title is always shown, first, in a table and a list.
   */
  properties: { order: PropertyId[]; hidden: PropertyId[]; widths: Record<PropertyId, number> };
  /** Calendar: the date property rows are placed by. */
  calendarBy?: PropertyId | null;
  /** Gallery: the card's picture. */
  cover?: { kind: 'none' } | { kind: 'pageCover' } | { kind: 'property'; propertyId: PropertyId };
  cardSize?: 'small' | 'medium' | 'large';
  /** Table: wrap cell text instead of cutting it. */
  wrap?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Filter, sort, group: one definition, evaluated by the same rules on the client and the server

export interface FilterGroup {
  kind: 'group';
  op: 'and' | 'or';
  /** At most two levels of groups. An empty group matches every row. */
  children: (FilterGroup | FilterCondition)[];
}

/**
 * Operators by the type a cell reads as:
 * - text (title, text, url, email, phone, formula text): is, isNot, contains, doesNotContain,
 *   startsWith, endsWith, isEmpty, isNotEmpty; compared as `normaliseText` (search.ts) gives;
 * - number (number, formula and rollup numbers): eq, ne, gt, lt, ge, le, isEmpty, isNotEmpty;
 * - date (date, created and edited time, formula dates): is, before, after, onOrBefore,
 *   onOrAfter, isEmpty, isNotEmpty; by calendar date in the query's offset, a span by its start;
 * - checkbox (and formula booleans): is (value true or false);
 * - select, status: is, isNot, isEmpty, isNotEmpty (an option id the property no longer has is
 *   empty); status also `group` (value a StatusGroup);
 * - multiSelect, person, relation, files, created and edited by: contains, doesNotContain,
 *   isEmpty, isNotEmpty (files: only the last two).
 * A condition on a trashed or unknown property, or whose operator does not fit its type, is
 * ignored (it matches every row): a deleted property never hides rows.
 */
export type FilterOperator =
  | 'is'
  | 'isNot'
  | 'contains'
  | 'doesNotContain'
  | 'startsWith'
  | 'endsWith'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'eq'
  | 'ne'
  | 'gt'
  | 'lt'
  | 'ge'
  | 'le'
  | 'before'
  | 'after'
  | 'onOrBefore'
  | 'onOrAfter'
  | 'group';

export type RelativeDate =
  | 'today'
  | 'tomorrow'
  | 'yesterday'
  | 'oneWeekAgo'
  | 'oneWeekFromNow'
  | 'oneMonthAgo'
  | 'oneMonthFromNow';

export type FilterValue =
  | string
  | number
  | boolean
  | { date: string }
  | { relative: RelativeDate }
  /** person and created/edited by: the person asking. */
  | { me: true };

export interface FilterCondition {
  kind: 'condition';
  propertyId: PropertyId;
  operator: FilterOperator;
  value?: FilterValue;
}

export interface SortRule {
  propertyId: PropertyId;
  direction: 'asc' | 'desc';
}

export interface GroupRule {
  /** select, status, multiSelect, checkbox, person, date, created and edited time and by. */
  propertyId: PropertyId;
  /** Dates: what a group spans. */
  dateBy?: 'day' | 'week' | 'month' | 'year';
  /** Groups with no rows are not shown (a board shows every option by default). */
  hideEmpty?: boolean;
  /** Group keys left out of the view. */
  hidden?: string[];
}

/** What a query is evaluated against that the rows do not hold. */
export interface QueryContext {
  /** The asker's calendar date, `YYYY-MM-DD`, for relative dates. */
  today: string;
  /** The asker's offset from UTC in minutes, for date-times read as calendar dates. */
  offsetMinutes: number;
  /** The person asking, for `{ me: true }`. */
  me: Id | null;
  /** Display names by user id, for sorting and grouping people; ids are used when absent. */
  people?: Record<Id, string>;
}

export interface QuerySpec {
  filter: FilterGroup | null;
  sorts: SortRule[];
  group: GroupRule | null;
  /** Words every row's title must contain, normalised; empty or absent for none. */
  search?: string;
}

/** One group's key and how many filtered rows it holds; `''` is the "no value" group. */
export interface GroupCount {
  key: string;
  count: number;
}
