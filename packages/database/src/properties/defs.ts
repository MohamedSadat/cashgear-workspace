// New property definitions and the shape a property takes on a type change: its id and name
// kept, the settings its new type needs added with their defaults. Pure.
import {
  convertProperty,
  newOptionId,
  newPropertyId,
  type CellValue,
  type DatabaseRecord,
  type PropertyDef,
  type PropertyType,
  type StatusOption,
  type Value,
} from '../core';
import type { RowRecord } from '@cgw/workspace';
import type { DbKey } from '../i18n';
import { cellText, readCell, type TextLookups } from '../model/format';
import { isAutomaticType, isComputedType } from '../model/properties';

const isOptionType = (type: PropertyType) =>
  type === 'select' || type === 'multiSelect' || type === 'status';

/** The three options a new status property starts with, one per group. */
export function defaultStatusOptions(names: {
  todo: string;
  inProgress: string;
  complete: string;
}): StatusOption[] {
  return [
    { id: newOptionId(), name: names.todo, colour: 'gray', group: 'todo' },
    { id: newOptionId(), name: names.inProgress, colour: 'blue', group: 'inProgress' },
    { id: newOptionId(), name: names.complete, colour: 'green', group: 'complete' },
  ];
}

/** A property of `type` with the given name and the settings its type needs. */
export function newPropertyDef(
  type: PropertyType,
  name: string,
  statusNames: { todo: string; inProgress: string; complete: string },
): PropertyDef {
  return shapeForType({ id: newPropertyId(), name, type: 'text' }, type, statusNames);
}

/** The property as `type`: settings of the old type dropped, the new type's defaults added. */
export function shapeForType(
  def: PropertyDef,
  type: PropertyType,
  statusNames: { todo: string; inProgress: string; complete: string },
): PropertyDef {
  const base: PropertyDef = { id: def.id, name: def.name, type };
  if (def.trashedAt !== undefined) base.trashedAt = def.trashedAt;
  switch (type) {
    case 'number':
      return { ...base, number: def.number ?? { format: 'number', decimals: null } };
    case 'date':
    case 'createdTime':
    case 'lastEditedTime':
      return { ...base, date: def.date ?? { includeTime: type !== 'date' } };
    case 'select':
    case 'multiSelect':
      return { ...base, options: isOptionType(def.type) ? (def.options ?? []) : [] };
    case 'status':
      return {
        ...base,
        options: isOptionType(def.type) ? (def.options ?? []) : defaultStatusOptions(statusNames),
      };
    case 'formula':
      return { ...base, formula: def.formula ?? { expression: '' } };
    case 'relation':
      return { ...base, relation: def.relation ?? { databaseId: '', reversePropertyId: null } };
    case 'rollup':
      return def.rollup ? { ...base, rollup: def.rollup } : base;
    default:
      return base;
  }
}

/** The statement the type-change dialog makes about the conversion to `type`. */
export function conversionRule(type: PropertyType): DbKey {
  switch (type) {
    case 'title':
    case 'text':
      return 'convert.toText';
    case 'number':
      return 'convert.toNumber';
    case 'date':
      return 'convert.toDate';
    case 'checkbox':
      return 'convert.toCheckbox';
    case 'select':
    case 'multiSelect':
    case 'status':
      return 'convert.toOptions';
    case 'person':
      return 'convert.toPeople';
    case 'url':
    case 'email':
    case 'phone':
      return 'convert.toLinks';
    case 'relation':
      return 'convert.toRelation';
    case 'files':
      return 'convert.toFiles';
    default:
      return 'convert.toComputed';
  }
}

export interface ConversionPreview {
  converted: number;
  cleared: number;
  unchanged: number;
  /** Up to four rows whose value changes: before and after, as text. */
  examples: { before: string; after: string }[];
}

/** What a type change would do to the rows at hand (the loaded ones), by the conversion table. */
export function previewConversion(
  database: DatabaseRecord,
  from: PropertyDef,
  to: PropertyDef,
  rows: readonly RowRecord[],
  lookups: TextLookups,
): ConversionPreview {
  const stored = !isComputedType(from.type) && !isAutomaticType(from.type) && from.type !== 'title';
  const before: (CellValue | Value | undefined)[] = rows.map((row) =>
    stored ? row.values[from.id] : readCell(row, from),
  );
  const { def, values } = convertProperty(from, to, before, database.id);
  const out: ConversionPreview = { converted: 0, cleared: 0, unchanged: 0, examples: [] };
  before.forEach((value, i) => {
    if (value === undefined || value === null) return;
    const after = values[i];
    const beforeText = cellText(from, value, lookups);
    const afterText = after === undefined ? '' : cellText(def, after, lookups);
    if (after === undefined) out.cleared++;
    else if (JSON.stringify(after) === JSON.stringify(value) && from.type === to.type)
      out.unchanged++;
    else if (beforeText === afterText && JSON.stringify(after) === JSON.stringify(value))
      out.unchanged++;
    else out.converted++;
    if ((after === undefined || beforeText !== afterText) && out.examples.length < 4)
      out.examples.push({ before: beforeText, after: afterText });
  });
  return out;
}
