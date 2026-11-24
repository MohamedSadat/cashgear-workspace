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
  | 'lastEditedBy'
  /** Phase 15: a button that starts a rule; it holds no value (`PropertyDef.button`). */
  | 'button';

/**
 * Every property type this build knows, in the order they were added (Phase 4: the first twenty;
 * Phase 15: `button`, the twenty-first). Its length is the `propertyTypes` a `db.update` and a
 * database's `page.create` carry to the server (DECISIONS.md, 2026-11-24): a def from an older
 * build naming a property stored as a type it does not know keeps that type and its settings.
 * A client offers `button` only once its server's `/version` counts it.
 */
export const KNOWN_PROPERTY_TYPES: readonly PropertyType[] = [
  'title',
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
  'formula',
  'rollup',
  'createdTime',
  'createdBy',
  'lastEditedTime',
  'lastEditedBy',
  'button',
];

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
   * Button (Phase 15): the words on it (absent or null: the property's name). The rules it starts
   * are those whose trigger names it (`AutomationTrigger` of kind `button`).
   */
  button?: { label?: string | null };
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

export type ViewType = 'table' | 'board' | 'list' | 'calendar' | 'gallery' | 'timeline' | 'chart';

/**
 * Every view type this build knows, in the order they were added (Phase 9: `timeline`, the sixth;
 * Phase 12: `chart`, the seventh). A type not in it is drawn as a table (never dropped). Its
 * length is the `viewTypes` a `view.upsert` carries to the server (DECISIONS.md, 2026-11-17: an
 * upsert from an older build, which says `table` for a type it does not know, keeps the stored
 * type and the settings that build does not know).
 */
export const KNOWN_VIEW_TYPES: readonly ViewType[] = [
  'table',
  'board',
  'list',
  'calendar',
  'gallery',
  'timeline',
  'chart',
];

/** How a chart view draws its points (Phase 12). */
export type ChartKind = 'bar' | 'line' | 'pie';

/**
 * What a chart measures for each group: a count of its rows, or a sum or an average of a number,
 * formula or rollup property's numbers (the chart block's measure, the same shape).
 */
export type ChartMeasure = { kind: 'count' } | { kind: 'sum' | 'average'; propertyId: PropertyId };

/** A chart view's settings (`ViewConfig.chart`; Phase 12). Its rows are grouped by the view's own `group`. */
export interface ChartConfig {
  /** Default 'bar'. */
  kind?: ChartKind;
  /** Default a count. A sum or an average reads a number, formula or rollup property. */
  measure?: ChartMeasure;
  /** Null or absent: "Count by Status", from the measure and the group (the chart block's words). */
  title?: string | null;
}

/** A timeline's zoom: a fixed width per day for each. */
export type TimelineScale = 'day' | 'week' | 'month' | 'quarter';

/** A timeline view's settings (`ViewConfig.timeline`; Phase 9). */
export interface TimelineConfig {
  /** The date property a row's bar starts at (its value's own range gives the end, below). */
  start: PropertyId | null;
  /** A second date property the bar ends at; absent or null: the start's own range. */
  end?: PropertyId | null;
  /** A select or status property the rows are put in lanes by, in its options' order. */
  lane?: PropertyId | null;
  /** Default `week`. */
  scale?: TimelineScale;
  /** The list of rows with no start beside the timeline; default true. */
  undated?: boolean;
}

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
  /** Timeline: its dates, lanes, zoom and the undated list (Phase 9). */
  timeline?: TimelineConfig;
  /**
   * Chart: its kind, measure and title (Phase 12). Grouped by `group`; its `properties` show the
   * title, the group's and the measure's properties and hide every other.
   */
  chart?: ChartConfig;
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
  /**
   * A board's columns in the order a person dragged them into, by group key (Phase 8): keys named
   * here first, then the rest in the group's own order. Only the board reads it; queries ignore it.
   */
  order?: string[];
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
  /** Only the rows whose dates meet these days (a calendar's or a timeline's; Phase 9). */
  window?: DateWindow | null;
}

/**
 * A date window (Phase 9): the rows whose span meets `[from, to]`, both `YYYY-MM-DD` and
 * inclusive. A row's span starts at `propertyId`'s start and ends at `endPropertyId`'s value (its
 * end, else its start) when that property gives one, else at `propertyId`'s own end, else its
 * start; an end before the start is the start. Each by its calendar date in the query's offset, as
 * the date filters read them. A row with no start is never in a window; a window on a property that
 * is not a date (or not there, or deleted) matches nothing, as does a `from` or `to` that is not a
 * date or a `from` after `to`. An `endPropertyId` that is not a date (or not there, or deleted) is
 * not used. Applied after the search and the filter, before sorts and groups: group counts count
 * the rows in the window. `queryRows` is the rule; db-query-vectors.json holds it for the C# port.
 */
export interface DateWindow {
  propertyId: PropertyId;
  endPropertyId?: PropertyId | null;
  from: string;
  to: string;
}

/** One group's key and how many filtered rows it holds; `''` is the "no value" group. */
export interface GroupCount {
  key: string;
  count: number;
}
