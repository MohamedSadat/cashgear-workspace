// Types for large.mjs, the large seed's rule (Phase 12), for the contract suite.

type Value = string | number | boolean | null;

export declare const LARGE_COUNT: number;
export declare const NAMES: readonly string[];
export declare const VENDOR_KINDS: readonly string[];
export declare const CUSTOMER_KINDS: readonly string[];
export declare const ITEM_KINDS: readonly string[];
export declare const PLACES: readonly (readonly [string, string])[];
export declare const STORAGE: readonly (readonly [string, string, string | null])[];
export declare const MAKERS: readonly string[];

export declare function largeVendor(n: number): Record<string, Value> & {
  readonly recId: string;
  readonly vendorAccount: string;
  readonly phone: string | null;
};
export declare function largeCustomer(n: number): Record<string, Value> & {
  readonly recId: string;
  readonly customerAccount: string;
  readonly searchName: string | null;
};
export declare function largeStock(n: number): Record<string, Value> & {
  readonly itemId: string;
  readonly searchName: string | null;
};
export declare function largeRecords(count?: number): {
  readonly vendors: ReturnType<typeof largeVendor>[];
  readonly customers: ReturnType<typeof largeCustomer>[];
  readonly itemsOnHand: ReturnType<typeof largeStock>[];
};
