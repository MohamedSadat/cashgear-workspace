import type { en } from './en';

/** The shape every catalogue has: the English keys, each holding a string. */
type Strings<T> = { readonly [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
export type Catalogue = Strings<typeof en>;

export type Language = 'en' | 'ar';
export const LANGUAGES: readonly Language[] = ['en', 'ar'];

export const directionOf = (language: Language): 'ltr' | 'rtl' =>
  language === 'ar' ? 'rtl' : 'ltr';

/** Every key of a catalogue, dotted, with its text: for tests and for keyword search. */
export function flatten(catalogue: object, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(catalogue)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value as object, path)) out.set(k, v);
  }
  return out;
}
