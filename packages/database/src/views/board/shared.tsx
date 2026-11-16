// The stand-in row the board, list, calendar and gallery type a new row's title into before the
// row exists (so an abandoned "New" leaves no empty row behind). The views speak their moves and
// drops through the library's `CgLiveAnnouncer`, written through its ref (nothing drawn).
import type { RowRecord } from '@cgw/workspace';
import type { DatabaseRecord } from '../../core';

const drafts = new WeakMap<DatabaseRecord, RowRecord>();

/** An empty row of the database, for the title editor of a row not made yet. */
export function draftRow(database: DatabaseRecord): RowRecord {
  let row = drafts.get(database);
  if (!row) {
    row = {
      id: '',
      workspaceId: database.workspaceId,
      sectionId: '',
      parentPageId: database.id,
      orderKey: '',
      kind: 'row',
      title: '',
      icon: null,
      coverAssetId: null,
      isTemplate: false,
      templateOfPageId: null,
      version: 0,
      createdAt: '',
      updatedAt: '',
      trashedAt: null,
      trashRootId: null,
      databaseId: database.id,
      values: {},
      versions: {},
      computed: {},
      computedVersion: null,
      createdBy: null,
      updatedBy: null,
    };
    drafts.set(database, row);
  }
  return row;
}
