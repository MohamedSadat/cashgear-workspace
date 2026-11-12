// Small pieces the board, list, calendar and gallery share: a live region the views speak through
// (moves, drops) without drawing anything, and the stand-in row a new row's title is typed into
// before the row exists (so an abandoned "New" leaves no empty row behind).
import type { RowRecord } from '@cgw/workspace';
import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { DatabaseRecord } from '../../core';

export interface LiveHandle {
  say(text: string): void;
}

/** A polite live region, written to directly (no React state: a drag must not draw anything). */
export const Live = forwardRef<LiveHandle>(function Live(_props, ref) {
  const el = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({
    say(text: string) {
      const node = el.current;
      if (!node) return;
      // The same text twice in a row is still read: clear it first.
      node.textContent = '';
      requestAnimationFrame(() => {
        if (el.current) el.current.textContent = text;
      });
    },
  }));
  return <div ref={el} className="cgw-views-sr" aria-live="polite" aria-atomic="true" />;
});

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
