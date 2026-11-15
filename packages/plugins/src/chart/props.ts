// The chart's props (`cashgear.chart`, version 1; INTEGRATIONS.md, Plugin blocks): which database
// and view, the chart's kind, the property its rows are grouped by, what is measured, a title.
import { readOneOf, readString } from '../props';
import type { PropSchema } from '../types';

export const CHART_TYPE = 'cashgear.chart';
export const CHART_VERSION = 1;

export const CHART_KINDS = ['bar', 'line', 'pie', 'number'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export type ChartMeasure =
  { readonly kind: 'count' } | { readonly kind: 'sum' | 'average'; readonly propertyId: string };

export interface ChartProps {
  readonly databaseId: string | null;
  /** Null: the database's first view. Its filter decides which rows are counted. */
  readonly viewId: string | null;
  readonly chart: ChartKind;
  /** A groupable property (select, status, checkbox, person, a date); null for a number alone. */
  readonly groupBy: string | null;
  readonly measure: ChartMeasure;
  /** Null: "Count by Status", from the measure and the group. */
  readonly title: string | null;
}

export const DEFAULT_CHART: ChartProps = {
  databaseId: null,
  viewId: null,
  chart: 'bar',
  groupBy: null,
  measure: { kind: 'count' },
  title: null,
};

function readMeasure(value: unknown): ChartMeasure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'count' };
  const { kind, propertyId } = value as Record<string, unknown>;
  if ((kind === 'sum' || kind === 'average') && typeof propertyId === 'string' && propertyId)
    return { kind, propertyId };
  return { kind: 'count' };
}

export const chartProps: PropSchema<ChartProps> = {
  read: (raw) => ({
    databaseId: readString(raw.databaseId),
    viewId: readString(raw.viewId),
    chart: readOneOf(raw.chart, CHART_KINDS, 'bar'),
    groupBy: readString(raw.groupBy),
    measure: readMeasure(raw.measure),
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.slice(0, 200) : null,
  }),
};
