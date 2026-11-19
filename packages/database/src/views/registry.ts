// The view types a database can be shown as: table, board, list, calendar, gallery, (Phase 9)
// timeline and (Phase 12) chart. Each sets its `component` and, where it differs, its default
// configuration and what its toolbar offers; the calendar and the timeline read their rows by
// queries of their own (a date window: `ownRows`).
import { TITLE_PROPERTY, type DatabaseRecord, type ViewType } from '../core';
import { isDateType, isGroupable, liveProperties } from '../model/properties';
import { emptyConfig } from '../model/viewConfig';
import { TableView } from '../table/TableView';
import { BoardView } from './board/BoardView';
import { ChartSettings } from './chart/ChartSettings';
import { ChartView } from './chart/ChartView';
import { defaultChartGroup, withChart } from './chart/config';
import { CalendarSettings } from './calendar/CalendarSettings';
import { CalendarView } from './calendar/CalendarView';
import { GallerySettings } from './gallery/GallerySettings';
import { GalleryView } from './gallery/GalleryView';
import { ListView } from './list/ListView';
import { TimelineSettings } from './timeline/TimelineSettings';
import { TimelineView, defaultTimeline } from './timeline/TimelineView';
import type { ViewTypeDefinition } from './types';

/**
 * A board, list, calendar or gallery starts with only the title shown (properties are turned on
 * in the view's Properties); ones added later show (views stream).
 */
function titleOnly(database: DatabaseRecord) {
  return {
    order: [],
    hidden: database.properties.filter((p) => p.id !== TITLE_PROPERTY).map((p) => p.id),
    widths: {},
  };
}

/** The first property a board can be grouped by (status, then select, then any groupable). */
function boardGroup(database: DatabaseRecord) {
  const live = liveProperties(database);
  const def =
    live.find((p) => p.type === 'status') ??
    live.find((p) => p.type === 'select') ??
    live.find((p) => isGroupable(p.type) && p.id !== TITLE_PROPERTY);
  return def ? { propertyId: def.id } : null;
}

export const VIEW_TYPES: Record<ViewType, ViewTypeDefinition> = {
  table: {
    type: 'table',
    glyph: '▦',
    component: TableView,
    defaultConfig: () => emptyConfig('table'),
    supports: { group: true, wrap: true, properties: true },
  },
  // ui-views: the board view (columns by its group, cards dragged between them).
  board: {
    type: 'board',
    glyph: '▥',
    component: BoardView,
    defaultConfig: (database) => ({
      ...emptyConfig('board'),
      group: boardGroup(database),
      properties: titleOnly(database),
    }),
    supports: { group: true, wrap: false, properties: true },
  },
  // ui-views: the list view.
  list: {
    type: 'list',
    glyph: '☰',
    component: ListView,
    defaultConfig: (database) => ({ ...emptyConfig('list'), properties: titleOnly(database) }),
    supports: { group: true, wrap: false, properties: true },
  },
  // ui-views: the calendar view (rows placed by `calendarBy`).
  calendar: {
    type: 'calendar',
    glyph: '▣',
    component: CalendarView,
    settings: CalendarSettings,
    defaultConfig: (database) => ({
      ...emptyConfig('calendar'),
      calendarBy: liveProperties(database).find((p) => isDateType(p.type))?.id ?? null,
      properties: titleOnly(database),
    }),
    supports: { group: false, wrap: false, properties: true },
    ownRows: true,
  },
  // ui-views: the gallery view (cards with a cover).
  gallery: {
    type: 'gallery',
    glyph: '▩',
    component: GalleryView,
    settings: GallerySettings,
    defaultConfig: (database) => ({
      ...emptyConfig('gallery'),
      cover: { kind: 'pageCover' },
      cardSize: 'medium',
      properties: titleOnly(database),
    }),
    supports: { group: false, wrap: false, properties: true },
  },
  // Phase 9: a line per row, its bar across its dates; lanes, zoom, the rows with no date beside.
  timeline: {
    type: 'timeline',
    glyph: '▤',
    component: TimelineView,
    settings: TimelineSettings,
    defaultConfig: (database) => {
      const timeline = defaultTimeline(database);
      return {
        ...emptyConfig('timeline'),
        // Earliest first: the bars fall away down the lines.
        sorts: timeline.start ? [{ propertyId: timeline.start, direction: 'asc' }] : [],
        properties: titleOnly(database),
        timeline,
      };
    },
    supports: { group: false, wrap: false, properties: false },
    ownRows: true,
  },
  // Phase 12: the view's groups as bars, a line or a pie, by a count, a sum or an average. Its
  // group is the toolbar's; its properties follow the group and the measure (no Properties menu).
  chart: {
    type: 'chart',
    glyph: '▟',
    component: ChartView,
    settings: ChartSettings,
    defaultConfig: (database) =>
      withChart(
        database,
        { ...emptyConfig('chart'), group: defaultChartGroup(database) },
        { kind: 'bar', measure: { kind: 'count' }, title: null },
      ),
    supports: { group: true, wrap: false, properties: false },
    ownErrors: true,
  },
};

export const VIEW_ORDER: readonly ViewType[] = [
  'table',
  'board',
  'list',
  'calendar',
  'gallery',
  'timeline',
  'chart',
];

export const viewType = (type: ViewType): ViewTypeDefinition =>
  VIEW_TYPES[type] ?? VIEW_TYPES.table;
