// A chart view's settings (`ViewConfig.chart`; Phase 12), pure and tested on their own: read
// defensively (a kind this build does not know is a bar, a measure that does not read a count),
// written with the view's `properties` kept to what the chart draws (the title, the group's
// property and the measure's property shown, every other hidden: the view type has no Properties
// menu, and a share link or a site sends only shown properties' values), a new chart's settings,
// and the title a chart says when it has none.
import {
  TITLE_PROPERTY,
  type ChartConfig,
  type ChartKind,
  type ChartMeasure,
  type DatabaseRecord,
  type GroupRule,
  type PropertyDef,
  type ViewConfig,
} from '../../core';
import { isGroupable, liveProperties } from '../../model/properties';
import { measureProperty } from './aggregate';
import type { ChartT } from './words';

/** The kinds a chart view draws, in the order its settings offer them. */
export const CHART_VIEW_KINDS: readonly ChartKind[] = ['bar', 'line', 'pie'];

/** A chart view's settings with their defaults filled in. */
export interface ChartSettingsValue {
  kind: ChartKind;
  measure: ChartMeasure;
  title: string | null;
}

/** The longest title a chart keeps (the block's limit). */
export const TITLE_LIMIT = 200;

/** A measure as stored, read: a sum or an average needs a property id, else it is a count. */
export function readMeasure(value: unknown): ChartMeasure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'count' };
  const { kind, propertyId } = value as Record<string, unknown>;
  if ((kind === 'sum' || kind === 'average') && typeof propertyId === 'string' && propertyId)
    return { kind, propertyId };
  return { kind: 'count' };
}

/** The view's chart settings, whatever a view's config holds (another build's, a hand-made one). */
export function chartOf(config: ViewConfig): ChartSettingsValue {
  const raw: unknown = config.chart;
  const chart = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  const kind = CHART_VIEW_KINDS.includes(chart.kind as ChartKind)
    ? (chart.kind as ChartKind)
    : 'bar';
  const title =
    typeof chart.title === 'string' && chart.title.trim()
      ? chart.title.slice(0, TITLE_LIMIT)
      : null;
  return { kind, measure: readMeasure(chart.measure), title };
}

/** The property a chart's group reads, when it is one rows can be grouped by. */
export function groupProperty(
  database: DatabaseRecord,
  group: GroupRule | null,
): PropertyDef | undefined {
  if (!group) return undefined;
  const def = liveProperties(database).find((p) => p.id === group.propertyId);
  return def && isGroupable(def.type) ? def : undefined;
}

/**
 * The view's `properties` for a chart: the title, the group's property and the measure's property
 * shown (in that order), every other property hidden; widths kept.
 */
export function chartProperties(
  database: DatabaseRecord,
  config: ViewConfig,
): ViewConfig['properties'] {
  const chart = chartOf(config);
  const shown = [TITLE_PROPERTY];
  const group = groupProperty(database, config.group);
  if (group && !shown.includes(group.id)) shown.push(group.id);
  const measured = measureProperty(database, chart.measure);
  if (measured && !shown.includes(measured.id)) shown.push(measured.id);
  return {
    order: shown,
    hidden: database.properties.filter((p) => !shown.includes(p.id)).map((p) => p.id),
    widths: config.properties?.widths ?? {},
  };
}

/**
 * The config with the chart's settings changed (`change` merged into them) and its properties kept
 * to what the chart draws. A change of the group goes through here too (`withGroup` first).
 */
export function withChart(
  database: DatabaseRecord,
  config: ViewConfig,
  change: Partial<ChartConfig> = {},
): ViewConfig {
  const current = chartOf(config);
  const chart: ChartConfig = { ...current, ...change };
  const next: ViewConfig = { ...config, chart };
  return { ...next, properties: chartProperties(database, next) };
}

/** The first property a new chart groups by: a status, then a select, then any groupable one. */
export function defaultChartGroup(database: DatabaseRecord): GroupRule | null {
  const live = liveProperties(database).filter((p) => p.id !== TITLE_PROPERTY);
  const def =
    live.find((p) => p.type === 'status') ??
    live.find((p) => p.type === 'select') ??
    live.find((p) => isGroupable(p.type));
  return def ? { propertyId: def.id } : null;
}

/** The title the chart says when it has none: "Sum of Amount by Status" (the block's words). */
export function chartTitle(
  t: ChartT,
  measure: ChartMeasure,
  group: PropertyDef | undefined,
  measured: PropertyDef | undefined,
): string {
  const kind = measure.kind === 'count' || !measured ? 'count' : measure.kind;
  const values = { group: group?.name ?? '', measure: measured?.name ?? '' };
  return group ? t(`titles.${kind}`, values) : t(`titles.${kind}All`, values);
}
