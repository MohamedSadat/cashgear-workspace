// Phase 17, M17.5: a unique id in the views. It reads as its row's number with the property's
// prefix, a dash in the cell until the server has given the row one; it is never edited; copied and
// exported as it reads; and the type picker offers it only where the server numbers rows.
import { describe, expect, it } from 'vitest';
import type { RowRecord } from '@cgw/workspace';
import { uniqueIdText, type PropertyDef } from '../core';
import { shownText } from '../clipboard/copy';
import { readCell } from './format';
import { editKind, isAutomaticType, isEditableType, TYPE_GLYPH } from './properties';

const def = (prefix?: string | null): PropertyDef => ({
  id: 'pUid0001',
  name: 'ID',
  type: 'uniqueId',
  ...(prefix === undefined ? {} : { uniqueId: { prefix } }),
});

const row = (number?: number): RowRecord => ({
  id: 'r1',
  workspaceId: 'w',
  sectionId: 's',
  parentPageId: 'd',
  orderKey: 'a1',
  kind: 'row',
  title: 'Row',
  icon: null,
  coverAssetId: null,
  isTemplate: false,
  templateOfPageId: null,
  version: 1,
  createdAt: '2026-11-25T00:00:00Z',
  updatedAt: '2026-11-25T00:00:00Z',
  trashedAt: null,
  trashRootId: null,
  databaseId: 'd',
  values: {},
  versions: {},
  computed: {},
  computedVersion: null,
  createdBy: null,
  updatedBy: null,
  ...(number === undefined ? {} : { number }),
});

describe('a unique id', () => {
  it('reads as its prefix and the row’s number, or nothing until the server gives one', () => {
    expect(uniqueIdText(def('TASK'), 12)).toBe('TASK-12');
    expect(uniqueIdText(def(' TASK '), 12)).toBe('TASK-12');
    expect(uniqueIdText(def(), 12)).toBe('12');
    expect(uniqueIdText(def(''), 3)).toBe('3');
    expect(uniqueIdText(def('TASK'), null)).toBeNull();
    expect(readCell(row(7), def('TASK'))).toBe(7);
    expect(readCell(row(), def('TASK'))).toBeUndefined();
  });

  it('is copied as it reads and is never edited', () => {
    const env = { locale: 'en' } as unknown as Parameters<typeof shownText>[2];
    expect(shownText(def('TASK'), row(7), env)).toBe('TASK-7');
    expect(shownText(def('TASK'), row(), env)).toBe('');
    expect(isEditableType('uniqueId')).toBe(false);
    expect(isAutomaticType('uniqueId')).toBe(true);
    expect(editKind('uniqueId')).toBe('none');
    expect(TYPE_GLYPH.uniqueId).toBeTruthy();
  });
});
