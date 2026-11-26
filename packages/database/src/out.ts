// Phase 19: a database block as it leaves the page (`@cgw/database/out`, loaded with the first
// export or print): its view's rows as text, as the view shows them (its filter, sort and shown
// properties, a grouped view's groups in order, each cell as its cell reads), at most `limit` rows;
// a chart view as its points, and its drawing as an SVG (`chartSvg`). Over a `DatabaseHost`, so it
// reads what a view on screen would: the device's rows for a database held in full, the server's
// query when online, the rows on this device offline (said by `localOnly`). Never saves anything.
// After 0.19.0 the rows' cells are turned to text in slices of about 4 ms that give the main thread
// back between them, so a wide view's 1,000 rows never hold it for a frame while someone types.
import type { CgChartActions } from '@cashgear/ui';
import { createElement, type RefObject } from 'react';
import type { Id, PropertyDef, RowRecord } from '@cgw/workspace';
import type { ChartKind, ChartMeasure, DatabaseRecord, ViewRecord } from './core';
import type { DatabaseHost, RowRequest, RowSnapshot } from './host';
import type { CellEnv } from './cells/env';
import { cellText, readCell, type TextLookups } from './model/format';
import { orderedProperties, shownProperties } from './model/properties';
import { groupText } from './views/GroupLabel';
import { MEASURE_PAGE } from './views/chart/ChartView';
import {
  ROW_CAP,
  measureProperty,
  needsRows,
  nextToLoad,
  pointsOf,
  type ChartPoint,
} from './views/chart/aggregate';
import { chartOf, chartTitle, groupProperty } from './views/chart/config';
import type { ChartT } from './views/chart/words';
import { settled } from './csv/exportView';

/** The interface's words a view's text needs: the shell's translator (keys under `database.`). */
export type OutT = (key: string, options?: Record<string, unknown>) => string;

export interface OutOptions {
  /** Rows written at most (1,000 by default, decided with you: then a line saying how many more). */
  limit?: number;
  /** The shell's translator, its keys whole (`database.cell.checked`): not this package's `t`. */
  say: OutT;
  locale: string;
  /** How long cells are turned to text before the main thread is given back (4 ms; tests). */
  sliceMs?: number;
}

export type ViewOut =
  | {
      kind: 'table';
      title: string;
      columns: string[];
      rows: string[][];
      groups?: { name: string; at: number; count: number }[];
      /** Rows the query matches past those written. */
      more: number;
      /** Only the rows on this device were read (offline, or the server unreachable). */
      localOnly: boolean;
    }
  | { kind: 'chart'; title: string; chart: ChartKind; points: ChartPoint[]; localOnly: boolean }
  /** Nothing to write: the database is not on this device, the view has no rows (a form). */
  | { kind: 'none'; reason: 'missing' | 'form' | 'failed' };

export const OUT_LIMIT = 1000;

const SLICE_MS = 4;

/** Each row's cells as text, a slice of about `sliceMs` at a time, the main thread given back between. */
async function rowTexts(
  rows: RowRecord[],
  text: (row: RowRecord) => string[],
  sliceMs: number,
): Promise<string[][]> {
  const out: string[][] = [];
  let started = performance.now();
  for (const row of rows) {
    if (performance.now() - started >= sliceMs) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      started = performance.now();
    }
    out.push(text(row));
  }
  return out;
}

const COUNT: ChartMeasure = { kind: 'count' };

/** Loads a source until it holds `limit` rows, every row, or can load no more. */
async function load(
  source: ReturnType<DatabaseHost['rows']>,
  limit: number,
  next: (snapshot: RowSnapshot) => { group?: string } | null,
): Promise<RowSnapshot> {
  let snapshot = await settled(source);
  for (let guard = 0; guard < 10_000; guard++) {
    if (snapshot.error || snapshot.localOnly || snapshot.rows.length >= limit) break;
    const want = next(snapshot);
    if (!want) break;
    const before = snapshot.rows.length;
    source.loadMore(want.group);
    snapshot = await settled(source);
    if (snapshot.rows.length === before) break;
  }
  return snapshot;
}

function lookupsOf(host: DatabaseHost, say: OutT, locale: string): TextLookups {
  const people = new Map(host.people().map((p) => [p.id, p.name]));
  return {
    locale,
    person: (id) => people.get(id),
    page: (id) => host.pageTitle(id),
    file: (id) => host.assets?.info(id)?.fileName,
    checked: say('database.cell.checked'),
    unchecked: say('database.cell.unchecked'),
  };
}

/** What `groupText` reads of a view's environment: its words, locale and people. */
const envOf = (host: DatabaseHost, say: OutT, locale: string): CellEnv =>
  ({
    t: (key: string, options?: Record<string, unknown>) => say(`database.${key}`, options),
    locale,
    rtl: false,
    people: new Map(host.people().map((p) => [p.id, p])),
  }) as unknown as CellEnv;

/**
 * A row's properties as its page shows them above its body: every property but the title, in its
 * database's first view's order, each as its cell reads.
 */
export function rowProperties(
  host: DatabaseHost,
  row: RowRecord,
  options: Pick<OutOptions, 'say' | 'locale'>,
): { name: string; text: string }[] {
  const database = host.database(row.databaseId);
  if (!database) return [];
  const view = host.views(row.databaseId)[0];
  const defs = view
    ? orderedProperties(database, view.config)
    : database.properties.filter((p) => !p.trashedAt);
  const lookups = lookupsOf(host, options.say, options.locale);
  const shown = (host.page(row.id) as RowRecord | null) ?? row;
  return defs
    .filter((def) => def.type !== 'title')
    .map((def) => ({ name: def.name, text: cellText(def, readCell(shown, def), lookups) }));
}

/** The view a block shows: its own, else the database's first. */
export function blockView(
  host: DatabaseHost,
  databaseId: Id,
  viewId: Id | null,
): ViewRecord | null {
  const views = host.views(databaseId);
  return (viewId ? views.find((v) => v.id === viewId) : undefined) ?? views[0] ?? null;
}

/** A database block's view as text (or a chart's points), as the view on screen shows it. */
export async function viewOut(
  host: DatabaseHost,
  databaseId: Id,
  viewId: Id | null,
  options: OutOptions,
): Promise<ViewOut> {
  const limit = options.limit ?? OUT_LIMIT;
  // The shell's host reads the database's hold and rows first, as a view on screen does.
  const prepare = (host as { prepare?: (id: Id) => Promise<void> }).prepare;
  if (prepare) await prepare.call(host, databaseId).catch(() => undefined);
  const database = host.database(databaseId);
  const view = database ? blockView(host, databaseId, viewId) : null;
  if (!database || !view) return { kind: 'none', reason: 'missing' };
  if (view.type === 'form') return { kind: 'none', reason: 'form' };
  const page = host.page(databaseId);
  const name = [page?.title, view.name].filter((s) => s && s.trim()).join(' · ');
  const env = envOf(host, options.say, options.locale);
  if (view.type === 'chart') return chartOut(host, database, view, options, env);
  const request: RowRequest = {
    viewId: view.id,
    spec: { filter: view.config.filter, sorts: view.config.sorts, group: view.config.group },
    pageSize: Math.min(limit, 500),
  };
  const source = host.rows(databaseId, request);
  try {
    const snapshot = await load(source, limit, (s) => {
      if (s.complete) return null;
      if (s.groups) {
        const group = s.groups.find((g) => !g.complete);
        return group ? { group: group.key } : null;
      }
      return {};
    });
    if (snapshot.error && !snapshot.rows.length) return { kind: 'none', reason: 'failed' };
    const shown = shownProperties(database, view.config);
    const lookups = lookupsOf(host, options.say, options.locale);
    const text = (row: RowRecord) =>
      shown.map((def: PropertyDef) => cellText(def, readCell(row, def), lookups));
    const sliceMs = options.sliceMs ?? SLICE_MS;
    const rows: string[][] = [];
    let groups: { name: string; at: number; count: number }[] | undefined;
    const rule = view.config.group;
    if (snapshot.groups && rule) {
      const def = database.properties.find((p) => p.id === rule.propertyId);
      groups = [];
      for (const group of snapshot.groups) {
        if (rows.length >= limit) break;
        const take = group.rows.filter((r) => !r.isTemplate).slice(0, limit - rows.length);
        groups.push({
          name: groupText(def, rule, group.key, env),
          at: rows.length,
          count: group.count,
        });
        rows.push(...(await rowTexts(take, text, sliceMs)));
      }
    } else
      rows.push(
        ...(await rowTexts(
          snapshot.rows.filter((r) => !r.isTemplate).slice(0, limit),
          text,
          sliceMs,
        )),
      );
    return {
      kind: 'table',
      title: name,
      columns: shown.map((d) => d.name),
      rows,
      ...(groups ? { groups } : {}),
      more: Math.max(0, snapshot.total - rows.length),
      localOnly: snapshot.localOnly || !!snapshot.error,
    };
  } finally {
    source.close();
  }
}

async function chartOut(
  host: DatabaseHost,
  database: DatabaseRecord,
  view: ViewRecord,
  options: OutOptions,
  env: CellEnv,
): Promise<ViewOut> {
  const chart = chartOf(view.config);
  const rule = view.config.group;
  const group = groupProperty(database, rule);
  const measured = measureProperty(database, chart.measure);
  const measure = measured ? chart.measure : COUNT;
  const ct: ChartT = (key, values) => options.say(`database.chart.${key}`, values);
  const title = chart.title ?? chartTitle(ct, measure, group, measured);
  if (!group || !rule)
    return { kind: 'chart', title, chart: chart.kind, points: [], localOnly: false };
  const source = host.rows(database.id, {
    viewId: view.id,
    spec: { filter: view.config.filter, sorts: view.config.sorts, group: rule },
    pageSize: needsRows(measure) ? MEASURE_PAGE : 100,
  });
  try {
    const snapshot = await load(source, ROW_CAP, (s) => nextToLoad(s, measure));
    if (snapshot.error && !snapshot.groups?.length) return { kind: 'none', reason: 'failed' };
    const { points } = pointsOf(database, snapshot.groups ?? [], measure, (key) =>
      groupText(group, rule, key, env),
    );
    const shown = chart.kind === 'pie' ? points.filter((p) => (p.value ?? 0) > 0) : points;
    return {
      kind: 'chart',
      title,
      chart: chart.kind,
      points: shown,
      localOnly: snapshot.localOnly,
    };
  } finally {
    source.close();
  }
}

/**
 * A chart's drawing as an SVG of its own, drawn off screen by the library's chart as a document
 * (no card, its words inside), in the light theme and at a page's width, its styles inlined.
 */
export async function chartSvg(chart: {
  kind: ChartKind;
  points: ChartPoint[];
  title: string;
  locale: string;
  rtl: boolean;
  width?: number;
  height?: number;
}): Promise<string | null> {
  if (!chart.points.length) return null;
  const [{ createRoot }, { default: ChartCanvas }] = await Promise.all([
    import('react-dom/client'),
    import('./views/chart/ChartCanvas'),
  ]);
  const box = document.createElement('div');
  box.dataset.cgTheme = 'light';
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = `position:fixed;inset-inline-start:-20000px;top:0;width:${chart.width ?? 640}px;height:${chart.height ?? 300}px;background:#fff;`;
  document.body.append(box);
  const actions: RefObject<CgChartActions | null> = { current: null };
  const root = createRoot(box);
  try {
    root.render(
      createElement(ChartCanvas, {
        kind: chart.kind,
        points: chart.points,
        name: chart.title,
        locale: chart.locale,
        rtl: chart.rtl,
        strings: {},
        height: chart.height ?? 300,
        printing: true,
        actionsRef: actions,
      }),
    );
    // The chart measures its box, then draws: wait for its SVG, a few frames at most.
    for (let frame = 0; frame < 60; frame++) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      const svg = actions.current?.getSvg() ?? null;
      if (svg && /<(rect|path|circle)\b/.test(svg)) return svg;
    }
    return actions.current?.getSvg() ?? null;
  } finally {
    root.unmount();
    box.remove();
  }
}
