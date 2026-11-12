// Changes to a view's configuration, as pure functions: each returns a new `ViewConfig` (or
// filter) and leaves its input alone. The views write the result with one `view.upsert`.
import type {
  DatabaseRecord,
  FilterCondition,
  FilterGroup,
  GroupRule,
  PropertyId,
  SortRule,
  ViewConfig,
  ViewType,
} from '../core';
import { orderedProperties } from './properties';

export function emptyConfig(type: ViewType = 'table'): ViewConfig {
  return {
    filter: null,
    sorts: [],
    group: null,
    properties: { order: [], hidden: [], widths: {} },
    ...(type === 'table' ? { wrap: false } : {}),
  };
}

/** Shows or hides a property in the view. */
export function withHidden(config: ViewConfig, id: PropertyId, hidden: boolean): ViewConfig {
  const rest = config.properties.hidden.filter((h) => h !== id);
  return {
    ...config,
    properties: { ...config.properties, hidden: hidden ? [...rest, id] : rest },
  };
}

/** Hides or shows every property but the title. */
export function withAllHidden(
  config: ViewConfig,
  database: DatabaseRecord,
  hidden: boolean,
): ViewConfig {
  const ids = database.properties.filter((p) => p.type !== 'title').map((p) => p.id);
  return { ...config, properties: { ...config.properties, hidden: hidden ? ids : [] } };
}

/**
 * Moves a property to `toIndex` in the view's full order (hidden ones included), writing the
 * whole order so later properties keep their places.
 */
export function moveProperty(
  config: ViewConfig,
  database: DatabaseRecord,
  id: PropertyId,
  toIndex: number,
): ViewConfig {
  const ids = orderedProperties(database, config).map((p) => p.id);
  const from = ids.indexOf(id);
  if (from < 0) return config;
  ids.splice(from, 1);
  ids.splice(Math.max(0, Math.min(ids.length, toIndex)), 0, id);
  return { ...config, properties: { ...config.properties, order: ids } };
}

/** Puts `id` just before or after `anchor` in the view's order. */
export function placeProperty(
  config: ViewConfig,
  database: DatabaseRecord,
  id: PropertyId,
  anchor: PropertyId,
  side: 'before' | 'after',
): ViewConfig {
  const ids = orderedProperties(database, config)
    .map((p) => p.id)
    .filter((p) => p !== id);
  const at = ids.indexOf(anchor);
  const index = at < 0 ? ids.length : side === 'before' ? at : at + 1;
  ids.splice(index, 0, id);
  return { ...config, properties: { ...config.properties, order: ids } };
}

export function withWidth(config: ViewConfig, id: PropertyId, width: number): ViewConfig {
  return {
    ...config,
    properties: { ...config.properties, widths: { ...config.properties.widths, [id]: width } },
  };
}

/** Sorts by a property: its rule replaced where it was, else added last. */
export function withSort(config: ViewConfig, rule: SortRule): ViewConfig {
  const at = config.sorts.findIndex((s) => s.propertyId === rule.propertyId);
  const sorts = [...config.sorts];
  if (at >= 0) sorts[at] = rule;
  else sorts.push(rule);
  return { ...config, sorts };
}

export function withSorts(config: ViewConfig, sorts: SortRule[]): ViewConfig {
  return { ...config, sorts };
}

export function withGroup(config: ViewConfig, group: GroupRule | null): ViewConfig {
  return { ...config, group };
}

/** Shows or hides one group of the view's grouping. */
export function withGroupHidden(config: ViewConfig, key: string, hidden: boolean): ViewConfig {
  if (!config.group) return config;
  const rest = (config.group.hidden ?? []).filter((k) => k !== key);
  return { ...config, group: { ...config.group, hidden: hidden ? [...rest, key] : rest } };
}

export function withFilter(config: ViewConfig, filter: FilterGroup | null): ViewConfig {
  return { ...config, filter: filter && filter.children.length ? filter : null };
}

/** Adds a condition to the view's filter (its top level, which is `and` when it is new). */
export function withCondition(config: ViewConfig, condition: FilterCondition): ViewConfig {
  const filter = config.filter ?? { kind: 'group', op: 'and', children: [] };
  return { ...config, filter: { ...filter, children: [...filter.children, condition] } };
}

// ---- The filter tree, addressed by paths of child indices from the top group -----------------

export type FilterNode = FilterGroup | FilterCondition;
export type FilterPath = number[];

export function nodeAt(filter: FilterGroup, path: FilterPath): FilterNode | undefined {
  let node: FilterNode = filter;
  for (const index of path) {
    if (node.kind !== 'group') return undefined;
    const next: FilterNode | undefined = node.children[index];
    if (!next) return undefined;
    node = next;
  }
  return node;
}

/** Replaces the node at a path (the empty path is the top group). */
export function replaceAt(filter: FilterGroup, path: FilterPath, node: FilterNode): FilterGroup {
  if (path.length === 0) return node.kind === 'group' ? node : filter;
  const [head, ...rest] = path;
  const children = filter.children.map((child, i) => {
    if (i !== head) return child;
    if (rest.length === 0) return node;
    return child.kind === 'group' ? replaceAt(child, rest, node) : child;
  });
  return { ...filter, children };
}

export function removeAt(filter: FilterGroup, path: FilterPath): FilterGroup {
  if (path.length === 0) return { ...filter, children: [] };
  const [head, ...rest] = path;
  if (rest.length === 0)
    return { ...filter, children: filter.children.filter((_, i) => i !== head) };
  const children = filter.children.map((child, i) =>
    i === head && child.kind === 'group' ? removeAt(child, rest) : child,
  );
  return { ...filter, children };
}

/** Adds a node at the end of the group at a path. */
export function appendAt(filter: FilterGroup, path: FilterPath, node: FilterNode): FilterGroup {
  const group = nodeAt(filter, path);
  if (!group || group.kind !== 'group') return filter;
  return replaceAt(filter, path, { ...group, children: [...group.children, node] });
}

/** Conditions in a filter, at every level. */
export function conditionCount(filter: FilterGroup | null): number {
  if (!filter) return 0;
  let count = 0;
  for (const child of filter.children) count += child.kind === 'group' ? conditionCount(child) : 1;
  return count;
}
