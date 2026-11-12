// A new database as operations: an inline one (the editor's "Database": its page under the page
// holding the block, its first table view, three empty rows) and the place a new one goes. The
// templates' databases are made by `@cgw/database` (`TemplatePicker`); this is the plain one.
import {
  TITLE_PROPERTY,
  keysBetween,
  newOp,
  uuidv7,
  type Id,
  type Operation,
  type PageCreate,
  type ViewConfig,
  type ViewRecord,
} from '@cgw/workspace';

/** What stands for a database without an icon of its own (the sidebar, menus, the palette). */
export const DATABASE_GLYPH = '▦';

/** A page's icon as lists draw it: its own, else a database's glyph or a page's. */
export const pageGlyph = (page: { icon: string | null; kind: string } | undefined | null) =>
  page?.icon ?? (page?.kind === 'database' ? DATABASE_GLYPH : '📄');

/** Where a new database page goes. */
export interface DatabasePlace {
  workspaceId: Id;
  sectionId: Id;
  /** The page holding it (an inline database's), or null at the top of the section. */
  parentPageId: Id | null;
  orderKey: string;
}

/** The names a new database starts with, in the interface language. */
export interface DatabaseNames {
  /** The title property's. */
  title: string;
  /** The first view's. */
  table: string;
}

export const emptyTableConfig = (): ViewConfig => ({
  filter: null,
  sorts: [],
  group: null,
  properties: { order: [], hidden: [], widths: {} },
});

export interface MadeDatabase {
  databaseId: Id;
  viewId: Id;
  ops: Operation[];
}

/** `count` empty rows at the end of a database's rows (after `after`, the last key, if any). */
export function emptyRowsOps(
  database: { id: Id; workspaceId: Id; sectionId: Id },
  count: number,
  { after = null as string | null, newId = uuidv7, now = new Date().toISOString() } = {},
): Operation[] {
  return keysBetween(after, null, count).map((orderKey) => {
    const id = newId();
    const row: PageCreate = {
      id,
      workspaceId: database.workspaceId,
      sectionId: database.sectionId,
      parentPageId: database.id,
      orderKey,
      kind: 'row',
      title: '',
      icon: null,
      coverAssetId: null,
      isTemplate: false,
      templateOfPageId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      trashRootId: null,
      row: { values: {} },
    };
    return newOp('page.create', database.workspaceId, id, row);
  });
}

/** The operations that make an empty database at a place, with a table view and `rows` rows. */
export function newDatabaseOps(
  place: DatabasePlace,
  names: DatabaseNames,
  { rows = 3, newId = uuidv7, now = new Date().toISOString() } = {},
): MadeDatabase {
  const databaseId = newId();
  const page: PageCreate = {
    id: databaseId,
    workspaceId: place.workspaceId,
    sectionId: place.sectionId,
    parentPageId: place.parentPageId,
    orderKey: place.orderKey,
    kind: 'database',
    title: '',
    icon: null,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    trashRootId: null,
    database: { properties: [{ id: TITLE_PROPERTY, name: names.title, type: 'title' }] },
  };
  const view: ViewRecord = {
    id: newId(),
    workspaceId: place.workspaceId,
    databaseId,
    name: names.table,
    type: 'table',
    orderKey: keysBetween(null, null, 1)[0],
    config: emptyTableConfig(),
    version: 1,
    createdAt: now,
  };
  const ops: Operation[] = [
    newOp('page.create', place.workspaceId, databaseId, page),
    newOp('view.upsert', place.workspaceId, view.id, view),
  ];
  if (rows > 0)
    ops.push(
      ...emptyRowsOps(
        { id: databaseId, workspaceId: place.workspaceId, sectionId: place.sectionId },
        rows,
        {
          newId,
          now,
        },
      ),
    );
  return { databaseId, viewId: view.id, ops };
}
