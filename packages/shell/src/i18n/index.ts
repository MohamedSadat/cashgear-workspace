// i18next with the English and Arabic catalogues (D24). Changing the language changes `lang` and
// `dir` on <html>, which every CashGear control and the editor follow.
import i18next, { type i18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ar } from './ar';
import { directionOf, type Language } from './catalogue';
import { en } from './en';
import type { groupsEn } from '../cloud/groupsWords';
import type { passkeysEn } from '../cloud/passkeysWords';
import type { ssoEn } from '../cloud/ssoWords';
import type { offlineRowsEn } from '../cloud/offlineWords';

export { ar, en };
export { directionOf, flatten, LANGUAGES, type Catalogue, type Language } from './catalogue';

/**
 * The sections screens bring with them when they load (`sections.ts`, Phase 11): typed here as
 * the catalogue's own keys are, merged into the instance by the screen that uses them.
 */
interface Sections {
  groups: typeof groupsEn;
  passkeys: typeof passkeysEn;
  sso: typeof ssoEn;
  offlineRows: typeof offlineRowsEn;
}

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en & Sections };
  }
}

const storageKey = 'cgw-language';

/** The saved choice, else Arabic when the system prefers it, else English. */
export function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'en' || saved === 'ar') return saved;
  } catch {
    // Storage can refuse access; fall through to the system's language.
  }
  return navigator.language.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

export function createI18n(language: Language = initialLanguage()): i18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: false,
    resources: { en: { translation: en }, ar: { translation: ar } },
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  });
  applyLanguage(language);
  return instance;
}

/** Sets `lang` and `dir` on <html> and remembers the choice on this device. */
export function applyLanguage(language: Language) {
  const html = document.documentElement;
  html.lang = language;
  html.dir = directionOf(language);
  try {
    localStorage.setItem(storageKey, language);
  } catch {
    // The choice then lasts until the page closes.
  }
}
