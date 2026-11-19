// The table's words for a screen reader (`database.grid.*`; Phase 12). They are not in the views'
// catalogue the shell merges at start (`@cgw/database/i18n`): the first table drawn merges them
// into the app's i18next instance, so the initial JavaScript holds none of them, as the chart's
// (`views/chart/words.ts`) and the shell's own sections do.
import type { i18n } from 'i18next';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { gridAr } from '../i18n/grid-ar';
import { gridEn } from '../i18n/grid-en';

/** A key of the table's words, without its `database.grid.` prefix. */
export type GridKey = keyof typeof gridEn;
export type GridT = (key: GridKey, options?: Record<string, unknown>) => string;
type LooseT = (key: string, options?: Record<string, unknown>) => string;

export { gridAr, gridEn };

const added = new WeakSet<i18n>();

/** Merges the table's words into an instance's `database` section, once; later calls do nothing. */
export function addGridWords(instance: i18n) {
  if (added.has(instance)) return;
  added.add(instance);
  instance.addResourceBundle('en', 'translation', { database: { grid: gridEn } }, true, false);
  instance.addResourceBundle('ar', 'translation', { database: { grid: gridAr } }, true, false);
}

/** The table's words in the interface language, merged first (synchronous, idempotent). */
export function useGridT(): GridT {
  const { t, i18n } = useTranslation();
  addGridWords(i18n);
  const loose = t as unknown as LooseT;
  return useCallback<GridT>((key, options) => loose(`database.grid.${key}`, options), [loose]);
}
