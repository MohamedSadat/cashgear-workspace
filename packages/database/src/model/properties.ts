// What each property type is in the views: whether a person edits it, how its cell edits
// (in place or in a picker), what it can be filtered, sorted and grouped by, and the property a
// view shows in which order. Pure: no React, no DOM.
import {
  STORED_TYPES,
  TITLE_PROPERTY,
  type DatabaseRecord,
  type FilterOperator,
  type PropertyDef,
  type PropertyId,
  type PropertyType,
  type ViewConfig,
} from '../core';

/** Every type a person can pick for a new property, in the order the type picker lists them. */
export const PICKABLE_TYPES: readonly PropertyType[] = [
  'text',
  'number',
  'select',
  'multiSelect',
  'status',
  'date',
  'person',
  'files',
  'checkbox',
  'url',
  'email',
  'phone',
  'relation',
  'rollup',
  'formula',
  'createdTime',
  'createdBy',
  'lastEditedTime',
  'lastEditedBy',
];

/** A small glyph per type, drawn beside a property's name (decorative: the name is the label). */
export const TYPE_GLYPH: Record<PropertyType, string> = {
  title: '≡',
  text: '¶',
  number: '#',
  date: '▦',
  checkbox: '☑',
  select: '◉',
  multiSelect: '☰',
  status: '◔',
  person: '☺',
  url: '⛓',
  email: '@',
  phone: '☎',
  files: '⎘',
  relation: '↗',
  formula: 'ƒ',
  rollup: '∑',
  createdTime: '◷',
  createdBy: '☻',
  lastEditedTime: '◶',
  lastEditedBy: '☻',
};

const stored = new Set<PropertyType>(STORED_TYPES);
const computed = new Set<PropertyType>(['formula', 'rollup']);
const automatic = new Set<PropertyType>([
  'createdTime',
  'createdBy',
  'lastEditedTime',
  'lastEditedBy',
]);

/** A value a person writes: the title and the stored types. */
export const isEditableType = (type: PropertyType) => type === 'title' || stored.has(type);
export const isComputedType = (type: PropertyType) => computed.has(type);
export const isAutomaticType = (type: PropertyType) => automatic.has(type);

/** How a cell of the type is edited: typed in place, toggled, or chosen in a picker. */
export type EditKind = 'inline' | 'toggle' | 'picker' | 'none';
export function editKind(type: PropertyType): EditKind {
  switch (type) {
    case 'title':
    case 'text':
    case 'number':
    case 'url':
    case 'email':
    case 'phone':
      return 'inline';
    case 'checkbox':
      return 'toggle';
    case 'date':
    case 'select':
    case 'multiSelect':
    case 'status':
    case 'person':
    case 'files':
    case 'relation':
      return 'picker';
    default:
      return 'none';
  }
}

/** Operators that take no value. */
export const noValue = (op: FilterOperator) => op === 'isEmpty' || op === 'isNotEmpty';

/** Types a table, list or board can be grouped by (db/types.ts, GroupRule). */
export const GROUPABLE_TYPES: readonly PropertyType[] = [
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
];
export const isGroupable = (type: PropertyType) => GROUPABLE_TYPES.includes(type);
export const isDateType = (type: PropertyType) =>
  type === 'date' || type === 'createdTime' || type === 'lastEditedTime';

/** Properties that are not deleted, in database order. */
export const liveProperties = (database: DatabaseRecord) =>
  database.properties.filter((p) => !p.trashedAt);

export const propertyOf = (database: DatabaseRecord, id: PropertyId) =>
  database.properties.find((p) => p.id === id);

/**
 * The properties a view shows, in order (ViewConfig.properties): `order` first, then any not
 * named in it in database order, without hidden or deleted ones. With `titleFirst` (a table, a
 * list) the title is always shown, first.
 */
export function shownProperties(
  database: DatabaseRecord,
  config: ViewConfig,
  titleFirst = true,
): PropertyDef[] {
  const ordered = orderedProperties(database, config);
  const hidden = new Set(config.properties.hidden);
  const shown = ordered.filter((p) => !hidden.has(p.id) || (titleFirst && p.type === 'title'));
  if (!titleFirst) return shown;
  const title = shown.find((p) => p.id === TITLE_PROPERTY);
  return title ? [title, ...shown.filter((p) => p !== title)] : shown;
}

/** Every live property in the view's order, hidden ones included (the properties list). */
export function orderedProperties(database: DatabaseRecord, config: ViewConfig): PropertyDef[] {
  const live = liveProperties(database);
  const byId = new Map(live.map((p) => [p.id, p]));
  const out: PropertyDef[] = [];
  const seen = new Set<PropertyId>();
  for (const id of config.properties.order) {
    const def = byId.get(id);
    if (def && !seen.has(id)) {
      out.push(def);
      seen.add(id);
    }
  }
  for (const def of live) if (!seen.has(def.id)) out.push(def);
  return out;
}

/** A name not yet used in the database: `Text`, then `Text 2`, `Text 3`, ... */
export function uniqueName(database: DatabaseRecord, base: string): string {
  const names = new Set(database.properties.filter((p) => !p.trashedAt).map((p) => p.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** Default widths of a column by type, in CSS pixels. */
export function defaultWidth(def: PropertyDef): number {
  switch (def.type) {
    case 'title':
      return 280;
    case 'checkbox':
      return 100;
    case 'number':
      return 130;
    case 'text':
    case 'relation':
    case 'multiSelect':
    case 'files':
      return 220;
    default:
      return 180;
  }
}

export const MIN_WIDTH = 60;
export const MAX_WIDTH = 1200;
export const clampWidth = (w: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));

export function columnWidth(def: PropertyDef, config: ViewConfig): number {
  const w = config.properties.widths[def.id];
  return typeof w === 'number' && Number.isFinite(w) ? clampWidth(w) : defaultWidth(def);
}
