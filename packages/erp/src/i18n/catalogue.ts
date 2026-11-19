import type { en } from './en';
import type { ReportKey } from './reports';

/** The shape every catalogue has: the English keys, each holding a string. */
type Strings<T> = { readonly [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
export type ErpCatalogue = Strings<typeof en>;

/**
 * Every key under `erp`: `connect`, `linkTitle`, ... and (Phase 12) the report words the views
 * bring with them (`reports.ts`).
 */
export type ErpKey = (keyof (typeof en)['erp'] & string) | ReportKey;
