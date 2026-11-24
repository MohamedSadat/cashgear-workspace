// The form view's strings (`database.form.*`; Phase 16), as the chart's are: not in the views'
// catalogue the shell merges at start, but merged into the app's instance the first time a form
// draws, so the initial JavaScript holds none of them. Its translator is `ft` (model.test.ts holds
// every `t('…')` of this package to `en.ts`).
import type { i18n } from 'i18next';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { formAr } from '../../i18n/form-ar';
import { formEn } from '../../i18n/form-en';

type Strings<T> = { readonly [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** The shape both languages have: the English keys, each holding a string. */
export type FormCatalogue = Strings<typeof formEn>;

type Paths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];
/** A key of the form's words, without its `database.form.` prefix. */
export type FormKey = Paths<typeof formEn> | `answer.problems.${string}`;

export type FormT = (key: FormKey, options?: Record<string, unknown>) => string;
type LooseT = (key: string, options?: Record<string, unknown>) => string;

export { formAr, formEn };

const added = new WeakSet<i18n>();

/** Merges the form's words into an instance's `database` section, once; later calls do nothing. */
export function addFormWords(instance: i18n) {
  if (added.has(instance)) return;
  added.add(instance);
  instance.addResourceBundle('en', 'translation', { database: { form: formEn } }, true, false);
  instance.addResourceBundle('ar', 'translation', { database: { form: formAr } }, true, false);
}

/** The form's strings in the interface language, merged first (synchronous and idempotent). */
export function useFormT(): { ft: FormT; locale: string; rtl: boolean } {
  const { t, i18n } = useTranslation();
  addFormWords(i18n);
  const loose = t as unknown as LooseT;
  const ft = useCallback<FormT>((key, options) => loose(`database.form.${key}`, options), [loose]);
  const locale = i18n.language || 'en';
  return { ft, locale, rtl: i18n.dir?.(locale) === 'rtl' };
}
