// A database proposal made into the operations that create it, as an inline database under the
// page: its page with the proposed properties, a table view, and its rows. Applied only when the
// person accepts the proposal, through the same host as any database change.
import {
  OPTION_COLOURS,
  TITLE_PROPERTY,
  keysBetween,
  newOp,
  newOptionId,
  newPropertyId,
  parseBoolean,
  parseDateText,
  parseNumberText,
  splitNames,
  uuidv7,
  type DateValue,
  type Operation,
  type PageCreate,
  type PropertyDef,
  type SelectOption,
  type Value,
  type ViewRecord,
} from '@cgw/workspace';
import type { DatabaseProposal, ProposedProperty, ProposedValue } from './answers';
import type { DatabasePlace, MadeDatabase } from '../database/make';
import { emptyTableConfig } from '../database/make';

const asText = (value: ProposedValue): string =>
  value === null ? '' : Array.isArray(value) ? value.join(', ') : String(value);

/** Options of a select or multi-select: the proposed ones, then any a row names, at most 50. */
function optionsOf(property: ProposedProperty, rows: DatabaseProposal['rows']): SelectOption[] {
  const names: string[] = [];
  const add = (name: string) => {
    const trimmed = name.trim();
    if (trimmed && !names.some((n) => n.toLocaleLowerCase() === trimmed.toLocaleLowerCase()))
      names.push(trimmed);
  };
  for (const name of property.options) add(name);
  for (const row of rows) {
    const value = row[property.name];
    if (Array.isArray(value)) value.forEach(add);
    else if (typeof value === 'string')
      (property.type === 'multiSelect' ? splitNames(value) : [value]).forEach(add);
  }
  return names.slice(0, 50).map((name, index) => ({
    id: newOptionId(),
    name,
    colour: OPTION_COLOURS[index % OPTION_COLOURS.length],
  }));
}

function definitionOf(property: ProposedProperty, rows: DatabaseProposal['rows']): PropertyDef {
  const id = newPropertyId();
  switch (property.type) {
    case 'number':
      return {
        id,
        name: property.name,
        type: 'number',
        number: { format: 'number', decimals: null },
      };
    case 'date':
      return { id, name: property.name, type: 'date', date: { includeTime: false } };
    case 'select':
    case 'multiSelect':
      return { id, name: property.name, type: property.type, options: optionsOf(property, rows) };
    default:
      return { id, name: property.name, type: property.type };
  }
}

const optionId = (def: PropertyDef, name: string) =>
  def.options?.find((o) => o.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())?.id;

/** A proposed value as the property's stored value, or undefined (left empty). */
export function valueOf(def: PropertyDef, value: ProposedValue): Value | undefined {
  if (value === null) return undefined;
  switch (def.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : parseNumberText(asText(value));
      return n === undefined || !Number.isFinite(n) ? undefined : n;
    }
    case 'checkbox':
      return typeof value === 'boolean' ? value : parseBoolean(asText(value));
    case 'date': {
      const parsed = parseDateText(asText(value).trim());
      return parsed ? ({ start: parsed.start } satisfies DateValue) : undefined;
    }
    case 'select': {
      const name = Array.isArray(value) ? value[0] : asText(value);
      return name ? optionId(def, name) : undefined;
    }
    case 'multiSelect': {
      const names = Array.isArray(value) ? value : splitNames(asText(value));
      const ids = [
        ...new Set(names.map((n) => optionId(def, n)).filter((id): id is string => !!id)),
      ];
      return ids.length ? ids : undefined;
    }
    default: {
      const text = asText(value).trim();
      return text ? text : undefined;
    }
  }
}

/**
 * The operations that make the proposed database at a place: the first proposed property is the
 * title (each row's title is its value there), the rest keep their types; a table view named in
 * the interface language; the rows in the proposal's order.
 */
export function proposedDatabaseOps(
  proposal: DatabaseProposal,
  place: DatabasePlace,
  names: { table: string },
  { newId = uuidv7, now = new Date().toISOString() } = {},
): MadeDatabase {
  const databaseId = newId();
  const [titleProperty, ...rest] = proposal.properties;
  const defs = rest.map((property) => definitionOf(property, proposal.rows));
  const properties: PropertyDef[] = [
    { id: TITLE_PROPERTY, name: titleProperty.name, type: 'title' },
    ...defs,
  ];
  const page: PageCreate = {
    id: databaseId,
    workspaceId: place.workspaceId,
    sectionId: place.sectionId,
    parentPageId: place.parentPageId,
    orderKey: place.orderKey,
    kind: 'database',
    title: proposal.name,
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
  const view: ViewRecord = {
    id: newId(),
    workspaceId: place.workspaceId,
    databaseId,
    name: names.table,
    type: 'table',
    orderKey: keysBetween(null, null, 1)[0],
    config: emptyTableConfig(),
    version: 1,
    createdAt: now,
  };
  const ops: Operation[] = [
    newOp('page.create', place.workspaceId, databaseId, page),
    newOp('view.upsert', place.workspaceId, view.id, view),
  ];
  const keys = proposal.rows.length ? keysBetween(null, null, proposal.rows.length) : [];
  proposal.rows.forEach((row, index) => {
    const values: Record<string, Value> = {};
    rest.forEach((property, i) => {
      const value = valueOf(defs[i], row[property.name] ?? null);
      if (value !== undefined) values[defs[i].id] = value;
    });
    const id = newId();
    const record: PageCreate = {
      id,
      workspaceId: place.workspaceId,
      sectionId: place.sectionId,
      parentPageId: databaseId,
      orderKey: keys[index],
      kind: 'row',
      title: asText(row[titleProperty.name] ?? null)
        .trim()
        .slice(0, 2000),
      icon: null,
      coverAssetId: null,
      isTemplate: false,
      templateOfPageId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      trashRootId: null,
      row: { values },
    };
    ops.push(newOp('page.create', place.workspaceId, id, record));
  });
  return { databaseId, viewId: view.id, ops };
}
