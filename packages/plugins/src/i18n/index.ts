// The plugins' strings, read through i18next's `useTranslation()` with `plugins.*` keys from the
// shell's instance (which merges this section); `usePluginT` types the keys against this package.
import i18next, { type i18n } from 'i18next';
import { useCallback } from 'react';
import { initReactI18next, useTranslation } from 'react-i18next';
import { ar } from './ar';
import type { PluginKey } from './catalogue';
import { en } from './en';

export { ar, en };
export type { PluginKey, PluginsCatalogue } from './catalogue';

export type PluginT = (key: PluginKey, options?: Record<string, unknown>) => string;
type LooseT = (key: string, options?: Record<string, unknown>) => string;

export function usePluginT(): { t: PluginT; locale: string; rtl: boolean } {
  const { t, i18n } = useTranslation();
  const loose = t as unknown as LooseT;
  const translate = useCallback<PluginT>(
    (key, options) => loose(`plugins.${key}`, options),
    [loose],
  );
  const locale = i18n.language || 'en';
  return { t: translate, locale, rtl: i18n.dir?.(locale) === 'rtl' };
}

/**
 * An i18next instance holding these catalogues and others given (the database views' for a test),
 * for tests and a harness; the shell's instance holds them merged with its own.
 */
export function createPluginsI18n(
  language: 'en' | 'ar' = 'en',
  more: { en?: object; ar?: object } = {},
): i18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: false,
    resources: {
      en: { translation: { ...more.en, ...en } },
      ar: { translation: { ...more.ar, ...ar } },
    },
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  });
  return instance;
}
