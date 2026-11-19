// Words a screen loaded on demand brings with it (Phase 11): a section of the catalogue kept beside
// the screen, merged into the app's i18next instance the first time the screen draws, so the
// initial JavaScript holds none of it (Phase 1's 350 kB budget; 0.10.0's was 345.7 kB). The
// section's keys are typed as the shell's own are (`index.ts` names each section in its
// `CustomTypeOptions`), so `t('groups.title')` checks; only a screen that called `useSection` for
// it may use them. `sections.test.ts` holds each section's two languages to the shell catalogues'
// rules.
import type { i18n } from 'i18next';
import { useTranslation } from 'react-i18next';

/** The shape every language of a section has: the English keys, each holding a string. */
export type Strings<T> = { readonly [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };

export interface Section<E extends object = object> {
  /** The top-level key the words sit under, as `groups` in `t('groups.title')`. */
  readonly name: string;
  readonly en: E;
  readonly ar: Strings<E>;
}

export const section = <E extends object>(name: string, en: E, ar: Strings<E>): Section<E> => ({
  name,
  en,
  ar,
});

const added = new WeakMap<i18n, Set<string>>();

/** Merges the section's words into the instance, once; later calls do nothing. */
export function addSection(instance: i18n, words: Section) {
  let names = added.get(instance);
  if (!names) added.set(instance, (names = new Set()));
  if (names.has(words.name)) return;
  names.add(words.name);
  instance.addResourceBundle('en', 'translation', { [words.name]: words.en }, true, false);
  instance.addResourceBundle('ar', 'translation', { [words.name]: words.ar }, true, false);
}

/**
 * The section's words in the app's instance before this render reads them: call it at the top of
 * the screen that uses them (synchronous and idempotent, so safe in render).
 */
export function useSection(words: Section) {
  const { i18n } = useTranslation();
  addSection(i18n, words);
}
