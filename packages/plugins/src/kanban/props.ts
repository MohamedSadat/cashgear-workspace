// The kanban's props (`cashgear.kanban`, version 1; INTEGRATIONS.md, Plugin blocks): which database
// and view, the select or status property its columns are, the properties on its cards, and the
// columns it hides.
import { readString, readStrings } from '../props';
import type { PropSchema } from '../types';

export const KANBAN_TYPE = 'cashgear.kanban';
export const KANBAN_VERSION = 1;

export interface KanbanProps {
  readonly databaseId: string | null;
  /** Null: the database's first view. Its filter and sorts decide which cards show, in what order. */
  readonly viewId: string | null;
  /** A select or status property; null: the database's first one. */
  readonly groupBy: string | null;
  /** Shown on the cards under the title, in this order. */
  readonly cardProperties: readonly string[];
  /** Column keys left out (the board's "Hide group"). */
  readonly hidden: readonly string[];
}

export const kanbanProps: PropSchema<KanbanProps> = {
  read: (raw) => ({
    databaseId: readString(raw.databaseId),
    viewId: readString(raw.viewId),
    groupBy: readString(raw.groupBy),
    cardProperties: readStrings(raw.cardProperties, 20),
    // `''` is the "no value" column's key, and may be hidden too.
    hidden: Array.isArray(raw.hidden)
      ? [...new Set(raw.hidden.filter((v): v is string => typeof v === 'string'))].slice(0, 200)
      : [],
  }),
};
