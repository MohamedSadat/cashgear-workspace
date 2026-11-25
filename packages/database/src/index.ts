// @cgw/database: the views of a workspace database (Phase 4): the table (and, from the views
// stream, board, list, calendar and gallery), their cells and editors, property menus, the
// filter, sort and group editors, and a row's properties. Given a `DatabaseHost`; it never saves,
// loads or calls the network.
export { DatabaseView, type DatabaseViewProps } from './DatabaseView';
export { RowProperties, type RowPropertiesProps } from './RowProperties';
export type {
  AssetInfo,
  AutomationRun,
  AutomationRunsPage,
  AutomationsHost,
  DatabaseAutomations,
  DatabaseAssets,
  DatabaseHost,
  FormLink,
  FormLinkSettings,
  FormLinkState,
  FormState,
  FormsHost,
  DatabaseRef,
  Person,
  RowGroup,
  RowPlace,
  RowRef,
  RowRequest,
  RowReminder,
  RowRemindersHost,
  RowSnapshot,
  RowSource,
} from './host';
export { createActions, safeKeyBetween, type DatabaseActions, type NewRowInit } from './actions';
export {
  DatabaseContext,
  useDatabaseContext,
  useDatabaseContextValue,
  useRowSource,
  type DatabaseContextValue,
} from './context';
export {
  createDatabaseI18n,
  useDbT,
  ar,
  en,
  type DatabaseCatalogue,
  type DbKey,
  type DbT,
} from './i18n';
export { VIEW_ORDER, VIEW_TYPES, viewType } from './views/registry';
export type { ViewProps, ViewTypeDefinition } from './views/types';
export { GroupLabel, groupText } from './views/GroupLabel';
export { renderCell, OptionChip, PersonChip } from './cells/CellDisplay';
export { useCellEnv, type CellEnv } from './cells/env';
export { InlineEditor, type EditEnd } from './cells/InlineEditor';
export { PickerEditor } from './cells/PickerEditor';
export { CellFlyout } from './cells/CellFlyout';
export { PropertyMenu, type PropertyMenuProps } from './properties/PropertyMenu';
export { valuesForNewRow, groupValue } from './model/newRow';
export { shownProperties, orderedProperties, TYPE_GLYPH } from './model/properties';
export * as viewConfig from './model/viewConfig';

// The views stream: board, list, calendar and gallery, the database templates and the dialog that
// makes a database, row templates, CSV import and export.
export { BoardView } from './views/board/BoardView';
export { ListView } from './views/list/ListView';
export { CalendarView } from './views/calendar/CalendarView';
export { GalleryView } from './views/gallery/GalleryView';
export type { ViewSettingsProps } from './views/types';
export { TemplatePicker, type TemplatePickerProps } from './templates/TemplatePicker';
export {
  TEMPLATE_IDS,
  makeDatabase,
  type DatabasePlace,
  type MadeDatabase,
  type MakeContext,
  type TemplateChoice,
  type TemplateId,
} from './templates/databaseTemplates';
export { createFromTemplate, createTemplate, rowTemplateItems } from './templates/rowTemplates';
export { ImportDialog, type ImportDialogProps } from './csv/ImportDialog';
export { exportView, exportFileName, type ExportResult } from './csv/exportView';
export type { CsvImportRequest, CsvImportResult, WorkbookExportResult } from './host';

// Phase 12: the chart view, and the chart's drawing, settings controls, words and arithmetic, moved
// from the chart block (`@cgw/plugins`), which draws by them too. `ChartDrawing` loads `CgChart`
// on its own, with the first chart drawn.
export { ChartView, CHART_HIDDEN, MEASURE_PAGE } from './views/chart/ChartView';
export { ChartDrawing, type ChartDrawingProps } from './views/chart/drawing';
export {
  ChartControls,
  ChartSelect,
  VIEW_LOOK,
  measurableProperties,
  type ChartControlsLook,
  type ChartControlsProps,
} from './views/chart/ChartControls';
export {
  CHART_VIEW_KINDS,
  TITLE_LIMIT,
  chartOf,
  chartProperties,
  chartTitle,
  defaultChartGroup,
  groupProperty,
  readMeasure,
  withChart,
  type ChartSettingsValue,
} from './views/chart/config';
export {
  GROUPABLE,
  MEASURABLE,
  ROW_CAP,
  measureProperty,
  needsRows,
  nextToLoad,
  numberOf,
  pointsOf,
  totalOf,
  type ChartData,
  type ChartPoint,
} from './views/chart/aggregate';
export {
  addChartWords,
  chartAr,
  chartEn,
  useChartT,
  type ChartCatalogue,
  type ChartKey,
  type ChartT,
} from './views/chart/words';
