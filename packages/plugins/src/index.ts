// @cgw/plugins: plugin blocks (Phase 7, INTEGRATIONS.md, Plugin blocks). The definitions and the
// registry are small and carry no view: each definition's view loads with the first block of its
// type on screen (`./view` mounts it into a block's frame; `./i18n` has the catalogues alone).
// Given a host; never saves, loads or calls the network (lint).
import { chart } from './chart/definition';
import { kanban } from './kanban/definition';
import { readBlock } from './props';
import { createRegistry, untyped, type PluginRegistry } from './registry';
import type { Language } from './types';

export type {
  BlockDefinition,
  Language,
  Localized,
  PlainTextContext,
  PluginData,
  PluginFrame,
  PluginFrameOptions,
  PluginViewProps,
  PropSchema,
} from './types';
export { createRegistry, untyped, type PluginRegistry } from './registry';
export {
  parseProps,
  readBlock,
  readOneOf,
  readString,
  readStrings,
  writeProps,
  type ReadBlock,
} from './props';
export { chart, kanban };
export {
  CHART_KINDS,
  CHART_TYPE,
  CHART_VERSION,
  DEFAULT_CHART,
  type ChartKind,
  type ChartMeasure,
  type ChartProps,
} from './chart/props';
export { KANBAN_TYPE, KANBAN_VERSION, type KanbanProps } from './kanban/props';

/** The first-party definitions, compiled into the app: chart, then kanban (decisions, 2026-11-15). */
export const FIRST_PARTY: PluginRegistry = createRegistry([untyped(chart), untyped(kanban)]);

/**
 * A plugin block's line for copy and export (`@cgw/doc`'s `TextContext.pluginText`): the
 * definition's `toPlainText`, or undefined for a type the registry does not have.
 */
export function pluginText(
  registry: PluginRegistry,
  type: string,
  props: string | null,
  version: number | null,
  context: { language: Language; pageTitle?(pageId: string): string | undefined },
): string | undefined {
  const definition = registry.get(type);
  if (!definition) return undefined;
  return definition.toPlainText(readBlock(definition, props, version).props, context);
}
