// i18next with the English and Arabic catalogues (D24). Changing the language changes `lang` and
// `dir` on <html>, which every CashGear control and the editor follow.
import i18next, { type i18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ar } from './ar';
import { directionOf, type Language } from './catalogue';
import { en } from './en';

export { ar, en };
export { directionOf, flatten, LANGUAGES, type Catalogue, type Language } from './catalogue';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
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
