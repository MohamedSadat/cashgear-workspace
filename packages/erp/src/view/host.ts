// What the shell gives the ERP views. The views never call Workspace's API, never touch a store
// and keep what the ERP answers in React state only: everything they need comes through these.
import type { Language, LinkRedeemResponse } from '../contract';
import type { ErpSessions } from '../session';

/**
 * An ERP view block's settings (document schema 4, `erpView`), as `@cgw/editor` defines them:
 * which link and connector, and what the person typed or picked, never ERP data. `filter`,
 * `fields` and `sort` are JSON text (`{search?, equals?}`, `string[]`, `{field, direction}[]`).
 */
export interface ErpBlockAttrs {
  /** Workspace's `ErpLinks` id. */
  linkId: string | null;
  connectorId: string | null;
  filter: string | null;
  fields: string | null;
  sort: string | null;
  /** Rows a page; null: 50. */
  pageSize: number | null;
}

/** A Workspace link to an ERP company, as Workspace's API lists it (`ErpLink`). */
export interface ErpLinkInfo {
  /** Workspace's `ErpLinks` id, which blocks name. */
  readonly id: string;
  /** The ERP's own link id. */
  readonly erpLinkId: string;
  readonly workspaceId: string;
  readonly company: string;
  readonly companyName: string;
  readonly linkedBy: { readonly id: string; readonly name: string } | null;
  readonly linkedAt: string;
}

export type ErpLinksState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly links: readonly ErpLinkInfo[] }
  | { readonly status: 'failed' };

/**
 * Whether ERP data can be used here at all: signed in, in a workspace kept on the account
 * (decisions, 2026-11-14: in a local workspace the block says to sign in and nothing is made).
 */
export type ErpAvailability =
  | 'ready'
  /** The app is still asking the server who is signed in. */
  | 'checking'
  | 'signedOut'
  | 'localWorkspace'
  | 'noWorkspace';

/** The tab's connection to ERP data: the same for every block of the workspace. */
export interface ErpConnection {
  availability(): ErpAvailability;
  /** Whether the device has a network now. */
  online(): boolean;
  /** The workspace's links, as last read. Pure and stable between changes. */
  links(): ErpLinksState;
  /** Reads the links from Workspace's API unless they are read already. */
  loadLinks(): void;
  /** Reads the links again (a block names one this tab does not know yet); not too often. */
  reloadLinks(): void;
  /** Hears every change of the above. */
  subscribe(listener: () => void): () => void;
  /** What connecting opens: a pop-up (the web) or the system browser (the desktop). */
  readonly connectKind: 'popup' | 'browser';
}

/** What the views use of the tab's `ErpSessions`. */
export type ErpSessionsApi = Pick<
  ErpSessions,
  | 'state'
  | 'session'
  | 'error'
  | 'subscribe'
  | 'connect'
  | 'cancel'
  | 'disconnect'
  | 'connectors'
  | 'schema'
  | 'query'
>;

/** What an ERP view block is given (`ErpView`). */
export interface ErpViewHost {
  /** The block's settings. */
  readonly attrs: ErpBlockAttrs;
  /** Whether the page may be changed here: the settings controls show only then. */
  readonly editable: boolean;
  /** Changes the block's settings as an ordinary edit of the page; nothing when not editable. */
  setAttrs(attrs: Partial<ErpBlockAttrs>): void;
  /** The tab's connection: links, online state, availability. */
  readonly connection: ErpConnection;
  /** The tab's ERP sessions, one per link, in memory only. */
  readonly sessions: ErpSessionsApi;
}

/** A workspace the person may link: one they own or administer, kept on their account. */
export interface LinkableWorkspace {
  readonly id: string;
  readonly name: string;
}

/** Why Workspace's API refused to record a link. */
export type RecordLinkFailure =
  | 'forbidden'
  | 'invalid'
  | 'network'
  /** The workspace still has an earlier link to that company, which the ERP has ended. */
  | 'stale'
  | 'failed';

export class RecordLinkError extends Error {
  constructor(readonly code: RecordLinkFailure) {
    super(`The link could not be recorded: ${code}`);
    this.name = 'RecordLinkError';
  }
}

/** What the link screen (`#/erp-link/{ticket}`) is given. */
export interface ErpLinkScreenHost {
  /** The ticket read from the address, held in memory; null when there is none any more. */
  readonly ticket: string | null;
  /** Who is signed in: undefined while the app asks the server. */
  readonly signedIn: boolean | undefined;
  readonly online: boolean;
  /** Opens the sign-in (leaving the page in a browser). */
  signIn(): void;
  /** The workspaces the person owns or administers, on their account. */
  readonly workspaces: readonly LinkableWorkspace[];
  /** `WorkspaceLink/Redeem` at the ERP: once per ticket, which is then forgotten. */
  redeem(ticket: string, workspace: LinkableWorkspace): Promise<LinkRedeemResponse>;
  /**
   * Records the link at Workspace (`createErpLink`): `created`, or `exists` when the workspace
   * has that company's link already. Throws a `RecordLinkError`.
   */
  record(workspace: LinkableWorkspace, link: LinkRedeemResponse): Promise<'created' | 'exists'>;
  /** The ticket was sent or given up: it is dropped from memory. */
  forgetTicket(): void;
  /** Opens the workspace's settings (after linking). */
  openSettings(workspaceId: string): void;
  /** Leaves the screen without linking. */
  close(): void;
}

/** What the settings section ("Cash Gear ERP") is given. */
export interface ErpSettingsHost {
  /** Owners and admins may unlink; the server checks it again. */
  readonly canManage: boolean;
  readonly connection: ErpConnection;
  /** The tab's sessions, to show and end each link's; null before any was made. */
  readonly sessions: ErpSessionsApi | null;
  /** `deleteErpLink`. */
  unlink(link: ErpLinkInfo): Promise<void>;
  /** Opens Cash Gear ERP's client, where links are made. */
  openErp?(): void;
}

export type { Language };
