// What every view type is given by `DatabaseView`, and what a view type is (the registry, in
// `registry.ts`, lists them).
import type { ComponentType } from 'react';
import type { DatabaseRecord, ViewConfig, ViewRecord, ViewType } from '../core';
import type { RowSnapshot, RowSource } from '../host';

export interface ViewProps {
  database: DatabaseRecord;
  view: ViewRecord;
  /** The view's rows (its filter, sorts, group and the toolbar's search). */
  source: RowSource | null;
  snapshot: RowSnapshot;
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
