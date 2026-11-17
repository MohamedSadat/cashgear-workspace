// What every view type is given by `DatabaseView`, and what a view type is (the registry, in
// `registry.ts`, lists them).
import type { ComponentType } from 'react';
import type { DatabaseRecord, ViewConfig, ViewRecord, ViewType } from '../core';
import type { RowRequest, RowSnapshot, RowSource } from '../host';

export interface ViewProps {
  database: DatabaseRecord;
  view: ViewRecord;
  /**
   * The view's rows (its filter, sorts, group and the toolbar's search). Null for a view type that
   * reads its rows by queries of its own (`ownRows`).
   */
  source: RowSource | null;
  snapshot: RowSnapshot;
  /**
   * The query `DatabaseView` builds for the view (its filter, sorts, group and the toolbar's
   * search): a view type with `ownRows` builds its own queries from it (a date window, the rows
   * with no date). Null while the database or the view is not there.
   */
  request?: RowRequest | null;
  /** Inside a page (its own scroll, a limited height) rather than the database's full page. */
  embedded: boolean;
  /** The toolbar's search is set: an empty result says "no rows match". */
  searching: boolean;
  /**
   * Asks the view to start a new row from the toolbar's New (the table puts the caret in its
   * title); the number changes on each press.
   */
  newRowRequest: number;
  /** Adds a condition on a property to the view's filter and opens the filter editor. */
  requestFilter?(propertyId: string): void;
}

export interface ViewTypeDefinition {
  type: ViewType;
  /** A small decorative glyph beside the view's name. */
  glyph: string;
  /** Draws the view; null while the view type is not built (a placeholder says so). */
  component: ComponentType<ViewProps> | null;
  /** A new view's configuration. */
  defaultConfig(database: DatabaseRecord): ViewConfig;
  /** What the toolbar offers for it. */
  supports: { group: boolean; wrap: boolean; properties: boolean };
  /**
   * The view reads its rows by queries of its own, built from `ViewProps.request` (the calendar's
   * and the timeline's date window and their rows with no date; Phase 9): `DatabaseView` runs
   * none for it, and the view shows its own "rows on this device" and failure notices.
   */
  ownRows?: boolean;
  /**
   * The view type's own layout settings (the calendar's date property, the gallery's picture and
   * card size), shown by the toolbar's Layout button; absent when it has none (views stream).
   */
  settings?: ComponentType<ViewSettingsProps>;
}

/** What a view type's layout settings are given (inside the database's context). */
export interface ViewSettingsProps {
  database: DatabaseRecord;
  view: ViewRecord;
}
