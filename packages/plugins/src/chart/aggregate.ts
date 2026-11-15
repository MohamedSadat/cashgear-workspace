// What a chart draws, from a database view's rows: one point per group of the group property (in
// the query's group order, with its count from the query itself), measured by a count, a sum or an
// average of a number property; or one number for all rows. Pure: no React, no host.
import type { RowGroup, RowSnapshot } from '@cgw/database';
import { cellValue, type DatabaseRecord, type PropertyDef, type RowRecord } from '@cgw/workspace';
import type { ChartMeasure } from './props';

/** Sums and averages read at most this many rows (counts come from the query, every row). */
export const ROW_CAP = 5000;

/** Property types a sum or an average can read numbers from. */
export const MEASURABLE = ['number', 'formula', 'rollup'] as const;
/** Property types rows can be grouped by (the board's, as `@cgw/database` lists them). */
export const GROUPABLE = [
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
] as const;

export interface ChartPoint {
  /** The group's key (`''` for no value). */
  key: string;
  label: string;
  /** The measure, or null for an average of no numbers. */
  value: number | null;
  /** Rows of the group the query counted. */
  count: number;
}

export interface ChartData {
  points: ChartPoint[];
  /** A sum or average that read only some rows (more than `ROW_CAP`, or still loading). */
  partial: boolean;
}

/** A row's number for the measure: a number cell, or a formula's or rollup's numeric result. */
export function numberOf(database: DatabaseRecord, row: RowRecord, propertyId: string) {
  const cell = cellValue(database, row, propertyId, row.computed);
  return typeof cell === 'number' && Number.isFinite(cell) ? cell : null;
}

function measured(
  database: DatabaseRecord,
  rows: readonly RowRecord[],
  measure: ChartMeasure,
  count: number,
): number | null {
  if (measure.kind === 'count') return count;
  let sum = 0;
  let n = 0;
  for (const row of rows) {
    const value = numberOf(database, row, measure.propertyId);
    if (value === null) continue;
    sum += value;
    n++;
  }
  if (measure.kind === 'sum') return sum;
  return n ? sum / n : null;
}

/** Whether a measure needs the rows themselves (a count needs only the query's counts). */
export const needsRows = (measure: ChartMeasure) => measure.kind !== 'count';

/** The measure's property, when it is one a sum or an average can read. */
export function measureProperty(
  database: DatabaseRecord,
  measure: ChartMeasure,
): PropertyDef | undefined {
  if (measure.kind === 'count') return undefined;
  const def = database.properties.find((p) => p.id === measure.propertyId && !p.trashedAt);
  return def && (MEASURABLE as readonly string[]).includes(def.type) ? def : undefined;
}

/** One point per group, in the query's group order. */
export function pointsOf(
  database: DatabaseRecord,
  groups: readonly RowGroup[],
  measure: ChartMeasure,
  label: (key: string) => string,
): ChartData {
  let partial = false;
  const points = groups.map((group) => {
    if (needsRows(measure) && !group.complete) partial = true;
    return {
      key: group.key,
      label: label(group.key),
      value: measured(database, group.rows, measure, group.count),
      count: group.count,
    };
  });
  return { points, partial };
}

/** One number for every row of the query: a count from the query, or the rows' sum or average. */
export function totalOf(
  database: DatabaseRecord,
  snapshot: RowSnapshot,
  measure: ChartMeasure,
): { value: number | null; partial: boolean } {
  return {
    value: measured(database, snapshot.rows, measure, snapshot.total),
    partial: needsRows(measure) && !snapshot.complete,
  };
}

/** The next group whose rows a sum or average still needs, within the cap; null when none. */
export function nextToLoad(
  snapshot: RowSnapshot,
  measure: ChartMeasure,
): { group?: string } | null {
  if (!needsRows(measure) || snapshot.loading || snapshot.error) return null;
  if (snapshot.rows.length >= ROW_CAP) return null;
  if (snapshot.groups) {
    const group = snapshot.groups.find((g) => !g.complete);
    return group ? { group: group.key } : null;
  }
  return snapshot.complete ? null : {};
}
