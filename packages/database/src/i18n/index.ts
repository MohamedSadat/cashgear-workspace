// The views' strings: their own catalogue section (`database`), which the shell merges into its
// catalogues (`{ ...shellEn, ...databaseEn }`), read through i18next's `useTranslation()` with
// `database.*` keys. `useDbT` types the keys against this package's catalogue, so a missing key
// fails the typecheck here whether or not the shell has merged the section yet.
import i18next, { type i18n } from 'i18next';
import { useCallback } from 'react';
import { initReactI18next, useTranslation } from 'react-i18next';
import { ar } from './ar';
import type { DbKey } from './catalogue';
import { en } from './en';

export { ar, en };
export type { DatabaseCatalogue, DbKey } from './catalogue';

export type DbT = (key: DbKey, options?: Record<string, unknown>) => string;
type LooseT = (key: string, options?: Record<string, unknown>) => string;

export interface DbStrings {
  t: DbT;
  /** The interface language, for `Intl` formats. */
  locale: string;
  /** The direction the views are drawn in (the nearest `dir`, as every CashGear control reads it). */
  rtl: boolean;
}

/** The views' strings in the interface language. */
export function useDbT(): DbStrings {
  const { t, i18n } = useTranslation();
  const loose = t as unknown as LooseT;
  const translate = useCallback<DbT>((key, options) => loose(`database.${key}`, options), [loose]);
  const locale = i18n.language || 'en';
  return { t: translate, locale, rtl: i18n.dir?.(locale) === 'rtl' };
}

/**
 * An i18next instance holding only these catalogues, for tests and the browser harness (the
 * shell's instance holds them merged with its own).
 */
export function createDatabaseI18n(language: 'en' | 'ar' = 'en'): i18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: false,
    resources: { en: { translation: en }, ar: { translation: ar } },
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  });
  return instance;
}
