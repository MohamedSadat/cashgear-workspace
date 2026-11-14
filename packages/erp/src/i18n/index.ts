// The ERP views' strings: their own catalogue section (`erp`), which the shell merges into its
// catalogues (`{ ...shellEn, ...erpEn }`), read through i18next's `useTranslation()` with `erp.*`
// keys. `useErpT` types the keys against this package's catalogue.
import i18next, { type i18n } from 'i18next';
import { useCallback } from 'react';
import { initReactI18next, useTranslation } from 'react-i18next';
import type { Language } from '../contract';
import { ar } from './ar';
import type { ErpKey } from './catalogue';
import { en } from './en';

export { ar, en };
export type { ErpCatalogue, ErpKey } from './catalogue';

export type ErpT = (key: ErpKey, options?: Record<string, unknown>) => string;
type LooseT = (key: string, options?: Record<string, unknown>) => string;

export interface ErpStrings {
  t: ErpT;
  /** The interface language, for `Intl` formats. */
  locale: string;
  language: Language;
  rtl: boolean;
}

/** The views' strings in the interface language. */
export function useErpT(): ErpStrings {
  const { t, i18n } = useTranslation();
  const loose = t as unknown as LooseT;
  const translate = useCallback<ErpT>((key, options) => loose(`erp.${key}`, options), [loose]);
  const locale = i18n.language || 'en';
  return {
    t: translate,
    locale,
    language: locale.startsWith('ar') ? 'ar' : 'en',
    rtl: i18n.dir?.(locale) === 'rtl',
  };
}

/** An i18next instance holding only these catalogues, for tests (the shell's merges them). */
export function createErpI18n(language: Language = 'en'): i18n {
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
