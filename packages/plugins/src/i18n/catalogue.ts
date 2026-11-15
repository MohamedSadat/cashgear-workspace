// The catalogue's shape, from the English one: Arabic must have exactly the same keys.
import type { en } from './en';

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

export type PluginsCatalogue = Widen<typeof en>;

type Paths<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Paths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** A key of the `plugins` section, without its `plugins.` prefix. */
export type PluginKey = Paths<PluginsCatalogue['plugins']>;
