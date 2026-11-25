// The timeline view's arithmetic, pure and tested on its own (Phase 9): its settings with their
// defaults, a row's bar as the timeline takes it (its start property's start; its end from the end
// property, else the start's own range: the date window's rule, so what a window fetches is what
// is drawn), the values a move or a resize writes (a date stays a date, a date-time keeps its time
// of day), and the window fetched around the days shown.
import { calendarDate, type RowRecord } from '@cgw/workspace';
import type {
  DatabaseRecord,
  DateValue,
  PropertyDef,
  PropertyId,
  TimelineConfig,
  TimelineScale,
  ViewConfig,
} from '../../core';
import { isDateValue, readCell } from '../../model/format';
import { isDateType, liveProperties } from '../../model/properties';
import { addDaysToPoint, dateOfDay, dayNumber, daysInMonth, shiftDays } from '../calendar/dates';
import type { CgTimelineEdge, CgTimelineItem, CgTimelineLink, CgTimelineRange } from '@cashgear/ui';

/** A timeline's settings with their defaults filled in. */
export interface TimelineSettingsValue {
  start: PropertyId | null;
  end: PropertyId | null;
  lane: PropertyId | null;
  scale: TimelineScale;
  undated: boolean;
}

export const SCALES: readonly TimelineScale[] = ['day', 'week', 'month', 'quarter'];

export function timelineOf(config: ViewConfig): TimelineSettingsValue {
  const t: Partial<TimelineConfig> = config.timeline ?? {};
  return {
    start: t.start ?? null,
    end: t.end ?? null,
    lane: t.lane ?? null,
    scale: t.scale && SCALES.includes(t.scale) ? t.scale : 'week',
    undated: t.undated !== false,
  };
}

/** A new timeline's settings: the first date property, by weeks, the undated rows beside. */
export function defaultTimeline(database: DatabaseRecord): TimelineConfig {
  const start = liveProperties(database).find((p) => isDateType(p.type))?.id ?? null;
  return { start, end: null, lane: null, scale: 'week', undated: true };
}

/** What a bar carries: its row, and the values its dates came from. */
export interface TimelineRow {
  row: RowRecord;
  value: DateValue;
  /** The end property's value, when it has one. */
  endValue: DateValue | null;
}

const POINT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?$/;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A stored point as the timeline takes it: a date as it is; an instant as a date and time with no
 * zone on the person's own clock (`offsetMinutes` east of UTC), as the calendar gives its rows.
 */
export function wallPoint(point: string, offsetMinutes: number): string {
  if (point.length <= 10) return point;
  const ms = Date.parse(point) + offsetMinutes * 60_000;
  const d = new Date(ms);
  return `${calendarDate(point, offsetMinutes)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** A select's or a status's option id that the property still has, else null (no lane). */
function laneOf(row: RowRecord, lane: PropertyDef | undefined): string | null | undefined {
  if (!lane) return undefined;
  const value = row.values[lane.id];
  return typeof value === 'string' && (lane.options ?? []).some((o) => o.id === value)
    ? value
    : null;
}

/**
 * The rows as bars, in their order; a row with no start (or met twice) is left out, and with
 * `days` one whose dates do not meet those days (by the date window's rule, on the person's own
 * calendar), so the lines are the rows the days shown hold: the window fetched around them is the
 * rows ready for a scroll, not lines of bars out of sight.
 */
export function timelineItems(
  rows: readonly RowRecord[],
  start: PropertyDef,
  end: PropertyDef | undefined,
  lane: PropertyDef | undefined,
  offsetMinutes: number,
  writable: boolean,
  days?: CgTimelineRange | null,
): CgTimelineItem<TimelineRow>[] {
  const items: CgTimelineItem<TimelineRow>[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const value = readCell(row, start);
    if (!isDateValue(value) || !POINT.test(value.start)) continue;
    const other = end ? readCell(row, end) : undefined;
    const endValue = isDateValue(other) && POINT.test(other.start) ? other : null;
    const last = endValue
      ? endValue.end && POINT.test(endValue.end)
        ? endValue.end
        : endValue.start
      : value.end && POINT.test(value.end)
        ? value.end
        : null;
    if (days) {
      const first = calendarDate(value.start, offsetMinutes);
      const until = last ? calendarDate(last, offsetMinutes) : first;
      if (first > days.to || (until < first ? first : until) < days.from) continue;
    }
    const item: CgTimelineItem<TimelineRow> = {
      key: row.id,
      title: row.title,
      start: wallPoint(value.start, offsetMinutes),
      end: last ? wallPoint(last, offsetMinutes) : null,
      movable: writable,
      resizable: writable,
      data: { row, value, endValue },
    };
    const laneKey = laneOf(row, lane);
    if (laneKey !== undefined) item.lane = laneKey;
    items.push(item);
  }
  return items;
}

/** A row's bar as the timeline takes it (its start, and its end property's value), or null with no start. */
export function barOf(
  row: RowRecord,
  start: PropertyDef,
  end: PropertyDef | undefined,
): TimelineRow | null {
  const value = readCell(row, start);
  if (!isDateValue(value) || !POINT.test(value.start)) return null;
  const other = end ? readCell(row, end) : undefined;
  return { row, value, endValue: isDateValue(other) && POINT.test(other.start) ? other : null };
}

/**
 * Phase 17 (M17.4): the arrows between bars, from each row a bar's Blocked by names to that bar
 * (`from` blocks `to`), only between rows drawn, each once.
 */
export function timelineLinks(
  items: readonly CgTimelineItem<TimelineRow>[],
  blockedBy: PropertyDef | null | undefined,
): CgTimelineLink[] {
  if (!blockedBy) return [];
  const keys = new Set(items.map((i) => i.key));
  const links: CgTimelineLink[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const ids = item.data?.row.values[blockedBy.id];
    if (!Array.isArray(ids)) continue;
    for (const from of ids) {
      const id = `${String(from)}>${item.key}`;
      if (typeof from !== 'string' || from === item.key || !keys.has(from) || seen.has(id))
        continue;
      seen.add(id);
      links.push({ id, from, to: item.key });
    }
  }
  return links;
}

/**
 * Phase 17 (M17.4): the rows a blocker moved by whole days takes along when its database says so:
 * those it blocks (its Blocking), and theirs, each once, of the rows at hand, each moved as a bar's
 * move moves it (its start, and its end property's value). A row with no start is left as it is.
 */
export function dependentMoves(
  row: RowRecord,
  blocking: PropertyDef,
  start: PropertyDef,
  end: PropertyDef | undefined,
  days: number,
  rowOf: (id: string) => RowRecord | null | undefined,
): { row: RowRecord; values: Record<PropertyId, DateValue> }[] {
  if (!days) return [];
  const out: { row: RowRecord; values: Record<PropertyId, DateValue> }[] = [];
  const seen = new Set([row.id]);
  const queue: RowRecord[] = [row];
  while (queue.length) {
    const next = queue.shift()!;
    const ids = next.values[blocking.id];
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      const dependent = rowOf(id);
      if (!dependent || dependent.trashedAt) continue;
      queue.push(dependent);
      const bar = barOf(dependent, start, end);
      if (bar) out.push({ row: dependent, values: movedValues(bar, start, end, 'move', days) });
    }
  }
  return out;
}

/** A value with its end dropped when it is its start. */
const span = (start: string, end: string | null | undefined): DateValue =>
  end && end !== start ? { start, end } : { start };

/**
 * The values a move of `days` by `edge` writes, in one `row.update`: the whole bar shifts the start
 * value (and the end property's, when it gives the end); the start edge moves the start; the end
 * edge moves the end property's value when it gives one, else puts one there (an end property is
 * set), else moves the start's own end. Each point keeps its form.
 */
export function movedValues(
  data: TimelineRow,
  start: PropertyDef,
  end: PropertyDef | undefined,
  edge: CgTimelineEdge,
  days: number,
): Record<PropertyId, DateValue> {
  const { value, endValue } = data;
  const shift = (point: string) => addDaysToPoint(point, days);
  const ended = !!end && !!endValue;
  if (edge === 'move') {
    const out: Record<PropertyId, DateValue> = { [start.id]: shiftDays(value, days) };
    if (end && endValue) out[end.id] = shiftDays(endValue, days);
    return out;
  }
  if (edge === 'start') {
    const next = shift(value.start);
    if (ended) return { [start.id]: value.end ? { start: next, end: value.end } : { start: next } };
    return { [start.id]: span(next, value.end ?? value.start) };
  }
  if (end && endValue)
    return {
      [end.id]: endValue.end
        ? { start: endValue.start, end: shift(endValue.end) }
        : { start: shift(endValue.start) },
    };
  if (end) return { [end.id]: { start: shift(value.end ?? value.start) } };
  return { [start.id]: span(value.start, shift(value.end ?? value.start)) };
}

/** Days a view about 1,200 px wide shows at each zoom, before it says what it shows. */
const ESTIMATE: Readonly<Record<TimelineScale, number>> = {
  day: 30,
  week: 70,
  month: 240,
  quarter: 750,
};

/** The days a timeline first shows (a few days before today), roughly. */
export function firstRange(today: string, scale: TimelineScale): CgTimelineRange {
  const from = dayNumber(today) - 3;
  return { from: dateOfDay(from), to: dateOfDay(from + ESTIMATE[scale]) };
}

/**
 * The days to fetch around those shown: as many again on each side, out to whole months, so a
 * scroll of less than a screen asks nothing new.
 */
export function fetchWindow(range: CgTimelineRange): CgTimelineRange {
  const from = dayNumber(range.from);
  const to = dayNumber(range.to);
  const width = Math.max(1, to - from + 1);
  const first = dateOfDay(from - width);
  const last = dateOfDay(to + width);
  const lastDay = daysInMonth(Number(last.slice(0, 4)), Number(last.slice(5, 7)));
  return { from: `${first.slice(0, 8)}01`, to: `${last.slice(0, 8)}${pad(lastDay)}` };
}

/** Whether a fetched window holds every day shown. */
export const covers = (window: CgTimelineRange, range: CgTimelineRange): boolean =>
  window.from <= range.from && window.to >= range.to;
