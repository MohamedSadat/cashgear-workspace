// The JSON answers (action items, a database, ERP changes), read strictly: an answer that breaks
// its shape or its limits is not a proposal, and the person is told so. Nothing here is trusted
// further than its shape: a database's rows become values by the property's type, ERP changes are
// checked again by the block against its schema.
import type { ErpChangeProposal } from '@cgw/erp/ai';
import { AiError } from './types';

type WireValue = ErpChangeProposal['to'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The answer's JSON: a structured answer is plain JSON; a fence around it is tolerated. */
function json(text: string): unknown {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  try {
    return JSON.parse(fenced ? fenced[1] : text);
  } catch {
    throw new AiError('answer.invalid');
  }
}

const invalid = (): never => {
  throw new AiError('answer.invalid');
};

const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string') return invalid();
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return invalid();
  return trimmed;
};

export const MAX_ACTION_ITEMS = 100;

/** `{items: {text}[]}` as the items' texts. */
export function parseActionItems(answer: string): string[] {
  const value = json(answer);
  if (!isObject(value) || !Array.isArray(value.items)) return invalid();
  if (value.items.length > MAX_ACTION_ITEMS) return invalid();
  return value.items.map((item) => (isObject(item) ? text(item.text, 1000) : invalid()));
}

export const DATABASE_PROPERTY_TYPES = [
  'text',
  'number',
  'select',
  'multiSelect',
  'date',
  'checkbox',
  'url',
  'email',
  'phone',
] as const;
export type ProposedPropertyType = (typeof DATABASE_PROPERTY_TYPES)[number];

export interface ProposedProperty {
  name: string;
  type: ProposedPropertyType;
  /** Select and multi-select: the options' names, in order. */
  options: string[];
}

export type ProposedValue = string | number | boolean | string[] | null;

export interface DatabaseProposal {
  name: string;
  /** The first is the title: each row's title is its value there, as text. */
  properties: ProposedProperty[];
  /** Each row's values by property name. */
  rows: Record<string, ProposedValue>[];
}

export const MAX_PROPOSED_PROPERTIES = 20;
export const MAX_PROPOSED_ROWS = 100;
const MAX_OPTIONS = 50;

const proposedValue = (value: unknown): ProposedValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 2000 ? invalid() : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalid();
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value) && value.length <= MAX_OPTIONS)
    return value.map((v) => (typeof v === 'string' && v.length <= 200 ? v : invalid()));
  return invalid();
};

/**
 * `{name, properties: {name, type, options}[], rows: {values}[]}`, each row's `values` in the
 * properties' order, within the limits.
 */
export function parseDatabaseProposal(answer: string): DatabaseProposal {
  const value = json(answer);
  if (!isObject(value) || !Array.isArray(value.properties) || !Array.isArray(value.rows))
    return invalid();
  const name = text(value.name, 200);
  if (!value.properties.length || value.properties.length > MAX_PROPOSED_PROPERTIES)
    return invalid();
  if (value.rows.length > MAX_PROPOSED_ROWS) return invalid();
  const seen = new Set<string>();
  const properties = value.properties.map((property, index): ProposedProperty => {
    if (!isObject(property)) return invalid();
    const propertyName = text(property.name, 100);
    const folded = propertyName.toLocaleLowerCase();
    if (seen.has(folded)) return invalid();
    seen.add(folded);
    // The first is the title, whatever type was named for it.
    const type = index === 0 ? 'text' : property.type;
    if (!(DATABASE_PROPERTY_TYPES as readonly unknown[]).includes(type)) return invalid();
    const options =
      property.options === undefined || property.options === null
        ? []
        : Array.isArray(property.options) && property.options.length <= MAX_OPTIONS
          ? property.options.map((o) => text(o, 100))
          : invalid();
    return { name: propertyName, type: type as ProposedPropertyType, options };
  });
  // A row's values come in the properties' order (the server's structured answer: a JSON schema
  // cannot name keys it does not know); values keyed by name are read too.
  const rows = value.rows.map((row) => {
    const values = isObject(row) ? row.values : undefined;
    const out: Record<string, ProposedValue> = {};
    if (Array.isArray(values)) {
      if (values.length > MAX_PROPOSED_PROPERTIES) return invalid();
      properties.forEach((property, index) => (out[property.name] = proposedValue(values[index])));
    } else if (isObject(values))
      for (const property of properties) out[property.name] = proposedValue(values[property.name]);
    else return invalid();
    return out;
  });
  return { name, properties, rows };
}

export type ProposedErpChange = ErpChangeProposal;

const wire = (value: unknown): WireValue =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value)
    ? (value as WireValue)
    : invalid();

/** `{changes: {id, field, to}[]}`: at most one change a record's field, the last kept. */
export function parseErpChanges(answer: string, maxRecords = 500): ProposedErpChange[] {
  const value = json(answer);
  if (!isObject(value) || !Array.isArray(value.changes)) return invalid();
  if (value.changes.length > maxRecords * 20) return invalid();
  const byKey = new Map<string, ProposedErpChange>();
  for (const change of value.changes) {
    if (!isObject(change)) return invalid();
    const id = text(change.id, 200);
    const field = text(change.field, 200);
    byKey.set(JSON.stringify([id, field]), { id, field, to: wire(change.to) });
  }
  return [...byKey.values()];
}
