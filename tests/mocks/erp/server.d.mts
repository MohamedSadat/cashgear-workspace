// Types for server.mjs, for the contract suite and the browser tests.

export interface MockUser {
  readonly id: string;
  readonly key: string;
  readonly company: string;
  readonly displayName: string;
  readonly connectors: readonly string[];
  readonly admin: boolean;
  /** The record rules the ERP applies (Customers' ownership rule: `{createdBy: <the user's id>}`). */
  readonly rules?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** The fields the ERP's field rules keep from the user (Customers' national ID from employees). */
  readonly hidden?: Readonly<Record<string, readonly string[]>>;
  /** Phase 7 (Vendors), Phase 10 (Customers, Items on hand): Edit, or Edit and AdvEdit. */
  readonly edit?: Readonly<Record<string, 'edit' | 'advEdit'>>;
  /** Phase 12: the ERP roles its report pages check. */
  readonly roles?: readonly string[];
  /** Phase 12: whether the Warehouse balance page shows them cost. */
  readonly showCost?: boolean;
}

export declare const USERS: Readonly<
  Record<'alice' | 'bob' | 'carol' | 'dan' | 'erin' | 'gina' | 'faris', MockUser>
>;

/** One row of the mock's audit, per changed field (Phase 7). */
export interface MockAuditRow {
  readonly company: string;
  readonly connector: string;
  readonly recordId: string;
  readonly key: string;
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
  /** The ERP user's id. */
  readonly user: string;
  readonly at: string;
  readonly commitId: string;
  readonly audience: 'workspace';
  readonly workspaceId: string;
  readonly pageId: string;
  readonly blockId: string | null;
}
export declare const COMPANIES: Readonly<
  Record<'Kit' | 'Dot', { readonly name: string; readonly database: string }>
>;
export declare const MARKERS: Readonly<Record<'Kit' | 'Dot', readonly string[]>>;
export declare const CONNECTORS: Readonly<Record<string, { readonly id: string }>>;
/** Phase 12: the report connectors (reports.mjs). */
export declare const REPORTS: Readonly<
  Record<string, { readonly id: string; readonly kind: 'report' }>
>;
export declare const REPORT_IDS: readonly string[];
export declare const LIMITS: {
  readonly ticketMs: number;
  readonly sessionIdleMs: number;
  readonly sessionMaxMs: number;
  readonly maxSort: number;
};
export declare const WORKSPACE_ORIGINS: readonly string[];
export declare const DEFAULT_PORTS: { readonly api: number; readonly client: number };

export interface MockState {
  readonly now: string;
  readonly records: Readonly<
    Record<
      string,
      readonly {
        readonly company: string;
        readonly id: string;
        readonly key: string;
        readonly values: Readonly<Record<string, unknown>>;
      }[]
    >
  >;
  readonly markers: Readonly<Record<string, readonly string[]>>;
  readonly sessions: readonly {
    readonly user: string;
    readonly company: string;
    readonly linkId: string;
    readonly workspaceId: string;
    readonly language: string;
    readonly expiresAt: string;
    readonly maxExpiresAt: string;
    readonly ended: boolean;
    readonly live: boolean;
  }[];
  readonly links: readonly {
    readonly linkId: string;
    readonly company: string;
    readonly companyName: string;
    readonly workspaceId: string;
    readonly workspaceName: string;
    readonly linkedBy: string;
    readonly linkedAt: string;
    readonly revokedAt: string | null;
  }[];
  readonly tickets: { readonly link: number; readonly connect: number };
  readonly workspaceOff: readonly string[];
  readonly limits: {
    readonly ticketsPerMinute: number | null;
    readonly sessionPerMinute: number | null;
  };
}

export declare class MockErp {
  workspaceOrigins: Set<string>;
  clientOrigins: Set<string>;
  readonly workspaceUrl: string;
  reset(options?: {
    kitVendors?: number;
    kitCustomers?: number;
    locks?: boolean;
    /** Phase 12: Kit's records by the large seed's rule (large.mjs), 100,000 a connector. */
    large?: boolean;
  }): void;
  now(): number;
  state(): MockState;
}

export declare function startMockErp(options?: {
  apiPort?: number;
  clientPort?: number;
  host?: string;
  workspaceUrl?: string;
  workspaceOrigins?: readonly string[];
  /** Phase 12: start with the large seed. */
  large?: boolean;
}): Promise<{
  readonly apiUrl: string;
  readonly clientUrl: string;
  readonly mock: MockErp;
  close(): Promise<void>;
}>;
