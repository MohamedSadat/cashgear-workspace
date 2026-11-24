// The automations' strings (`database.automations.*`; Phase 15), as the chart's are: not in the
// views' catalogue the shell merges at start, but merged into the app's instance the first time
// the rule editor, a run log or a row's runs draw, so the initial JavaScript holds none of them.
import type { i18n } from 'i18next';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { automationsAr } from '../i18n/automations-ar';
import { automationsEn } from '../i18n/automations-en';

type Strings<T> = { readonly [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** The shape both languages have: the English keys, each holding a string. */
export type AutomationsCatalogue = Strings<typeof automationsEn>;

type Paths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];
/** A key of the automations' words, without its `database.automations.` prefix. */
export type AutoKey = Paths<typeof automationsEn>;

export type AutoT = (key: AutoKey, options?: Record<string, unknown>) => string;
type LooseT = (key: string, options?: Record<string, unknown>) => string;

export { automationsAr, automationsEn };

const added = new WeakSet<i18n>();

/** Merges the words into an instance's `database` section, once; later calls do nothing. */
export function addAutomationWords(instance: i18n) {
  if (added.has(instance)) return;
  added.add(instance);
  instance.addResourceBundle(
    'en',
    'translation',
    { database: { automations: automationsEn } },
    true,
    false,
  );
  instance.addResourceBundle(
    'ar',
    'translation',
    { database: { automations: automationsAr } },
    true,
    false,
  );
}

/** The automations' strings in the interface language, merged first (synchronous and idempotent). */
export function useAutoT(): { t: AutoT; locale: string; rtl: boolean } {
  const { t, i18n } = useTranslation();
  addAutomationWords(i18n);
  const loose = t as unknown as LooseT;
  const translate = useCallback<AutoT>(
    (key, options) => loose(`database.automations.${key}`, options),
    [loose],
  );
  const locale = i18n.language || 'en';
  return { t: translate, locale, rtl: i18n.dir?.(locale) === 'rtl' };
}
