import type { en } from './en';

/** The shape every catalogue has: the English keys, each holding a string. */
type Strings<T> = { readonly [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
export type DatabaseCatalogue = Strings<typeof en>;

/** Every key under `database`, dotted: `toolbar.filter`, `type.number`, ... */
type Paths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];
export type DbKey = Paths<(typeof en)['database']>;
