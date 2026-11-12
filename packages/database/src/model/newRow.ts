// What a row made in a view starts with, so it shows where it was made: the group's value when it
// is made in a group, and the value each simple condition of the view's filter asks for (an `and`
// filter's conditions on stored properties: "Status is Done" makes it Done).
import type { Id } from '@cgw/workspace';
import {
  TITLE_PROPERTY,
  type DatabaseRecord,
  type FilterCondition,
  type PropertyId,
  type Value,
  type ViewConfig,
} from '../core';
import { propertyOf } from './properties';

export interface NewRowValues {
  title: string;
  values: Record<PropertyId, Value>;
}

/** The value a group key stands for, on the group's property; undefined for "no value". */
export function groupValue(
  database: DatabaseRecord,
  propertyId: PropertyId,
  key: string,
): Value | undefined {
  const def = propertyOf(database, propertyId);
  if (!def || def.trashedAt || key === '') return undefined;
  switch (def.type) {
    case 'select':
    case 'status':
      return key;
    case 'multiSelect':
    case 'person':
      return [key];
    case 'checkbox':
      return key === 'true' ? true : undefined;
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(key) ? { start: key } : undefined;
    default:
      return undefined;
  }
}

function conditionValue(
  database: DatabaseRecord,
  condition: FilterCondition,
  me: Id | null,
): { id: PropertyId; value: Value } | null {
  const def = propertyOf(database, condition.propertyId);
  if (!def || def.trashedAt) return null;
  const { operator, value } = condition;
  const text = typeof value === 'string' ? value : null;
  switch (def.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return text && (operator === 'is' || operator === 'contains' || operator === 'startsWith')
        ? { id: def.id, value: text }
        : null;
    case 'number':
      return operator === 'eq' && typeof value === 'number' ? { id: def.id, value } : null;
    case 'checkbox':
      return operator === 'is' && value === true ? { id: def.id, value: true } : null;
    case 'select':
    case 'status':
      return operator === 'is' && text && def.options?.some((o) => o.id === text)
        ? { id: def.id, value: text }
        : null;
    case 'multiSelect':
      return operator === 'contains' && text && def.options?.some((o) => o.id === text)
        ? { id: def.id, value: [text] }
        : null;
    case 'person': {
      if (operator !== 'contains') return null;
      const person =
        typeof value === 'object' && value !== null && 'me' in value ? me : (text ?? null);
      return person ? { id: def.id, value: [person] } : null;
    }
    case 'date':
      return operator === 'is' && typeof value === 'object' && value !== null && 'date' in value
        ? { id: def.id, value: { start: value.date } }
        : null;
    default:
      return null;
  }
}

export function valuesForNewRow(
  database: DatabaseRecord,
  config: ViewConfig | null,
  groupKey: string | null,
  me: Id | null,
): NewRowValues {
  const out: NewRowValues = { title: '', values: {} };
  if (config?.group && groupKey !== null) {
    const value = groupValue(database, config.group.propertyId, groupKey);
    if (value !== undefined) out.values[config.group.propertyId] = value;
  }
  const filter = config?.filter;
  if (filter && (filter.op === 'and' || filter.children.length === 1)) {
    for (const child of filter.children) {
      if (child.kind !== 'condition') continue;
      const found = conditionValue(database, child, me);
      if (!found) continue;
      if (found.id === TITLE_PROPERTY) {
        if (!out.title && typeof found.value === 'string') out.title = found.value;
      } else if (!(found.id in out.values)) out.values[found.id] = found.value;
    }
  }
  return out;
}
