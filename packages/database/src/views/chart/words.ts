// The chart's strings (`database.chart.*`; Phase 12), read by the chart view and the chart block.
// They are not in the views' catalogue the shell merges at start (`@cgw/database/i18n`): the first
// chart drawn merges them into the app's i18next instance, so the initial JavaScript holds none of
// them, as the shell's own sections (`packages/shell/src/i18n/sections.ts`) do.
import type { i18n } from 'i18next';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { chartAr } from '../../i18n/chart-ar';
import { chartEn } from '../../i18n/chart-en';

type Strings<T> = { readonly [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** The shape both languages have: the English keys, each holding a string. */
export type ChartCatalogue = Strings<typeof chartEn>;

type Paths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];
/** A key of the chart's words, without its `database.chart.` prefix. */
export type ChartKey = Paths<typeof chartEn>;

export type ChartT = (key: ChartKey, options?: Record<string, unknown>) => string;
type LooseT = (key: string, options?: Record<string, unknown>) => string;

export { chartAr, chartEn };

const added = new WeakSet<i18n>();

/** Merges the chart's words into an instance's `database` section, once; later calls do nothing. */
export function addChartWords(instance: i18n) {
  if (added.has(instance)) return;
  added.add(instance);
  instance.addResourceBundle('en', 'translation', { database: { chart: chartEn } }, true, false);
  instance.addResourceBundle('ar', 'translation', { database: { chart: chartAr } }, true, false);
}

/**
 * The chart's strings in the interface language, merged into the instance first (synchronous and
 * idempotent, so safe in render).
 */
export function useChartT(): { t: ChartT; locale: string; rtl: boolean } {
  const { t, i18n } = useTranslation();
  addChartWords(i18n);
  const loose = t as unknown as LooseT;
  const translate = useCallback<ChartT>(
    (key, options) => loose(`database.chart.${key}`, options),
    [loose],
  );
  const locale = i18n.language || 'en';
  return { t: translate, locale, rtl: i18n.dir?.(locale) === 'rtl' };
}
