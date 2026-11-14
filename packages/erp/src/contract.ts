// erp-connect.1 (INTEGRATIONS.md, "Contract `erp-connect.1`"): what Cash Gear Workspace and Cash
// Gear ERP exchange, and a guard for every answer. Each `parse…` returns its input typed, or
// throws an `ErpContractError` naming the first path that breaks the contract. Properties the
// contract does not name are ignored, so the ERP can add some without breaking older clients,
// except in a record's `values`, which hold exactly the fields asked for. An optional property
// that is `null` counts as absent, as System.Text.Json writes nulls unless told not to.
//
// No error says what a value was, only what it should have been: an answer may hold the session
// token or ERP data, and neither goes into an error, a log or a report.

export const ERP_CONNECT_CONTRACT = 'erp-connect.1';

// ---------------------------------------------------------------------------------------------
// Routes and headers

/** Routes, module first as the ERP's are. They match without regard to case. */
export const ROUTES = {
  /** The ERP client, with an ERP admin's API key: `{url}` to open in Workspace. */
  linkCreateTicket: 'api/system/WorkspaceLink/CreateTicket',
  /** Workspace's browser, anonymous, from an allow-listed Origin. */
  linkRedeem: 'api/system/WorkspaceLink/Redeem',
  /** The ERP client, with an ERP admin's API key. */
  linkRevoke: 'api/system/WorkspaceLink/Revoke',
  /** The ERP client, with the user's API key: a ticket for a live link. */
  connectCreateTicket: 'api/system/WorkspaceConnect/CreateTicket',
  redeem: 'api/connect/Session/Redeem',
  renew: 'api/connect/Session/Renew',
  end: 'api/connect/Session/End',
  connectors: 'api/connect/Connectors',
} as const;

/** A connector's own route: `api/connect/Connectors/{id}/Schema`, `Query` or `Commit`. */
export function connectorRoute(id: string, name: 'Schema' | 'Query' | 'Commit'): string {
  return `${ROUTES.connectors}/${encodeURIComponent(id)}/${name}`;
}

/** `api/connect/Connectors/{id}/CommitStatus/{commitId}` (Phase 7). */
export function commitStatusRoute(id: string, commitId: string): string {
  return `${ROUTES.connectors}/${encodeURIComponent(id)}/CommitStatus/${encodeURIComponent(commitId)}`;
}

/** The session token's only place: never `Authorization`, a URL or a body after Redeem. */
export const SESSION_HEADER = 'X-Connect-Session';
/** The ERP client's API key, on the ERP client's own routes only. Workspace never holds one. */
export const API_KEY_HEADER = 'X-API-Key';
/** On every response; an error body repeats it as `correlationId`. */
export const CORRELATION_HEADER = 'X-Correlation-Id';
/** With 429 and 503, in seconds. */
export const RETRY_AFTER_HEADER = 'Retry-After';

/** The pop-up's message to its opener (INTEGRATIONS.md, "A user's session"). */
export const CONNECT_MESSAGE_TYPE = 'cgw-erp-connect';
/** The desktop's return from the system browser: `cashgear-workspace://erp#ticket=…&state=…`. */
export const DEEP_LINK_PREFIX = 'cashgear-workspace://erp';

/** Lifetimes and sizes the contract fixes. */
export const LIMITS = {
  /** Link and connect tickets: one use, 120 seconds. */
  ticketMs: 120_000,
  /** A session ends 30 minutes after Redeem or the last Renew... */
  sessionIdleMs: 30 * 60_000,
  /** ...and 10 hours after Redeem whatever happens. */
  sessionMaxMs: 10 * 60 * 60_000,
  /** At most three sort keys in a query. */
  maxSort: 3,
} as const;

// ---------------------------------------------------------------------------------------------
// Values

export type Language = 'en' | 'ar';

/** Text in both of the ERP's languages. */
export interface Localized {
  readonly en: string;
  readonly ar: string;
}

/**
 * A field's value on the wire, as `vendors.1` sends it: decimals as strings (`-?digits[.digits]`),
 * dates `YYYY-MM-DD`, date-times ISO 8601 with an offset, empty as `null`.
 */
export type WireValue = string | number | boolean | null;

/** 256 random bits in base64url: a link or connect ticket. */
const TICKET = /^[A-Za-z0-9_-]{43}$/;
/** 128 random bits in base64url: the pop-up's state. */
const STATE = /^[A-Za-z0-9_-]{22}$/;
/** An opaque token that can travel in a header (RFC 7235's token68), of 128 bits at least. */
const TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
/** A connector's id, used in a route. */
const CONNECTOR_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** A field's or lookup's name: an identifier, so it can never be `__proto__` or the like. */
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Canonical base64, as a SQL Server `rowversion` travels. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isTicket(value: unknown): value is string {
  return typeof value === 'string' && TICKET.test(value);
}

export function isState(value: unknown): value is string {
  return typeof value === 'string' && STATE.test(value);
}

/** Whether `value` can be a session token: header-safe, 22 to 4,096 characters. */
export function isToken(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length >= 22 && value.length <= 4096 && TOKEN.test(value)
  );
}

/** An ISO 8601 instant with a zone: `2026-11-14T10:00:05Z` or with `+02:00`. */
export function isIsoDateTime(text: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/.test(text) &&
    !Number.isNaN(Date.parse(text))
  );
}

/** A calendar date that exists, `YYYY-MM-DD`. */
export function isIsoDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  date.setUTCFullYear(y);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** A decimal string with at most `scale` digits after the point: `15000.00`, `-3`, `0.5`. */
export function isDecimal(text: string, scale: number): boolean {
  const m = /^-?(0|[1-9]\d*)(\.(\d+))?$/.exec(text);
  return m !== null && (m[3]?.length ?? 0) <= scale;
}

/** A record version: canonical base64 of at least one byte. */
export function isVersion(text: string): boolean {
  return text.length > 0 && BASE64.test(text);
}

// ---------------------------------------------------------------------------------------------
// Links (INTEGRATIONS.md, "Linking a workspace to a company")

/** `WorkspaceLink/CreateTicket`'s answer: Workspace's page with the ticket in its fragment. */
export interface LinkCreateTicketResponse {
  /** `…/#/erp-link/<ticket>`. */
  readonly url: string;
}

export interface LinkRedeemRequest {
  readonly ticket: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
}

/** The link the ERP recorded, or the live one the company and workspace already have. */
export interface LinkRedeemResponse {
  /** The ERP's own link id. */
  readonly linkId: string;
  readonly company: string;
  readonly companyName: string;
}

export interface LinkRevokeRequest {
  readonly linkId: string;
}

// ---------------------------------------------------------------------------------------------
// A user's session

/** `WorkspaceConnect/CreateTicket`, sent by the ERP client with the user's API key. */
export interface ConnectCreateTicketRequest {
  readonly workspaceId: string;
  /** The ERP's link id. */
  readonly linkId: string;
  /** The session's language; `en` when absent. */
  readonly language?: Language;
}

export interface ConnectCreateTicketResponse {
  readonly ticket: string;
}

export interface SessionRedeemRequest {
  readonly ticket: string;
  readonly workspaceId: string;
}

export interface ConnectSession {
  /** Opaque; kept in memory only and sent back only as `X-Connect-Session`. */
  readonly token: string;
  /** The idle expiry, never past `maxExpiresAt`. */
  readonly expiresAt: string;
  /** Ten hours after Redeem. */
  readonly maxExpiresAt: string;
  /** The ERP's link id. */
  readonly linkId: string;
  readonly company: string;
  readonly companyName: string;
  readonly user: { readonly id: string; readonly displayName: string };
  readonly language: Language;
}

export interface RenewResponse {
  readonly expiresAt: string;
}

// `Session/End` answers 204 with no body.

// ---------------------------------------------------------------------------------------------
// Connectors

export const CONNECTOR_KINDS = ['entity', 'report'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export const ACCESS_LEVELS = ['view', 'edit'] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

export interface ConnectorSummary {
  /** `vendors`, `customers`, `itemsOnHand`. */
  readonly id: string;
  readonly kind: ConnectorKind;
  readonly label: Localized;
  /** `vendors.1`. */
  readonly schemaVersion: string;
  /** Already resolved for this user; `view` for every connector until Phase 7. */
  readonly access: Access;
}

export interface ConnectorsResponse {
  /** Only those the user may view. */
  readonly connectors: readonly ConnectorSummary[];
}

export const FIELD_TYPES = [
  'text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'dateTime',
  'lookup',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const EDIT_REASONS = ['notEditable', 'needsEdit', 'needsAdvEdit'] as const;
export type EditReason = (typeof EDIT_REASONS)[number];

export interface FieldSchema {
  readonly name: string;
  readonly label: Localized;
  readonly type: FieldType;
  readonly editable: boolean;
  /** Why a read-only field is read-only; never on an editable one. */
  readonly editReason?: EditReason;
  readonly required?: boolean;
  readonly maxLength?: number;
  /** A decimal string for a decimal, a number for an integer, `YYYY-MM-DD` for a date. */
  readonly min?: number | string;
  readonly max?: number | string;
  /** Digits after the point; on every decimal. */
  readonly scale?: number;
  /** The list in `lookups` a lookup field's codes come from. */
  readonly lookup?: string;
  /** `equals` may name it. */
  readonly filterable: boolean;
  /** `sort` may name it. */
  readonly sortable: boolean;
}

export interface LookupItem {
  readonly code: string;
  /** The ERP keeps one description per item. */
  readonly label: string;
  /** `false` for an item records may still hold but nothing may choose. */
  readonly active?: boolean;
}

/** A report's parameter (a later release). */
export interface ReportParameter {
  readonly name: string;
  readonly label: Localized;
  readonly type: string;
  readonly required: boolean;
}

export interface ConnectorSchema {
  readonly id: string;
  readonly schemaVersion: string;
  /** The business key, a read-only text or integer field whose value is each record's `key`. */
  readonly keyField: string;
  /** The surrogate id, which travels only as each record's `id`, never in `values`. */
  readonly idField: string | null;
  readonly maxPageSize: number;
  readonly maxRecords: number;
  readonly maxCommitRecords: number;
  /** Only the fields this user may see, in the ERP's order. */
  readonly fields: readonly FieldSchema[];
  readonly lookups: Readonly<Record<string, readonly LookupItem[]>>;
  readonly parameters?: readonly ReportParameter[];
}

// ---------------------------------------------------------------------------------------------
// Query

export interface QueryFilter {
  /** What the ERP's own list of the entity searches, ignoring case. */
  readonly search?: string;
  /** Filterable fields only, else 400 `request.invalid`. */
  readonly equals?: Readonly<Record<string, WireValue>>;
}

export interface SortKey {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

export interface QueryRequest {
  readonly filter: QueryFilter;
  /** Reports only. */
  readonly parameters?: Readonly<Record<string, unknown>>;
  /** A subset of the schema's fields; absent, every one. */
  readonly fields?: readonly string[];
  /** At most three, sortable fields only. */
  readonly sort?: readonly SortKey[];
  /** From the last answer of the same query; null for the first page. */
  readonly cursor: string | null;
  /** 1 to the schema's `maxPageSize`. */
  readonly pageSize: number;
}

export interface ErpRecord {
  readonly id: string;
  readonly key: string;
  readonly version: string;
  /** Exactly the fields asked for (every schema field when none were), and nothing else. */
  readonly values: Readonly<Record<string, WireValue>>;
}

export interface QueryResponse {
  readonly records: readonly ErpRecord[];
  /** Null on the last page. */
  readonly nextCursor: string | null;
  /** Every match, whatever the cursor. */
  readonly total: number;
}

/** Phase 7: a commit of changed fields, as `vendors.1`'s. */
export interface CommitRequest {
  readonly commitId: string;
  readonly schemaVersion: string;
  readonly dryRun: boolean;
  readonly records: readonly {
    readonly id: string;
    readonly key: string;
    readonly version: string;
    readonly changes: Readonly<Record<string, { readonly from: unknown; readonly to: unknown }>>;
  }[];
}

// ---------------------------------------------------------------------------------------------
// Errors

/** The codes the ERP answers with (INTEGRATIONS.md, erp-connect.1's rules). */
export const SERVER_ERROR_CODES = [
  'ticket.invalid',
  'session.expired',
  'origin.denied',
  'privilege.denied',
  'link.revoked',
  'connector.notFound',
  'request.invalid',
  'schema.changed',
  'batch.tooLarge',
  'rate.limited',
  // Phase 7's commit codes, as vendors.1's.
  'required',
  'maxLength',
  'type',
  'range',
  'scale',
  'lookup.notFound',
  'field.readOnly',
  'record.notFound',
  'record.locked',
  'version.missing',
  'version.conflict',
  'company.mismatch',
  'commit.reused',
] as const;
export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

/** The client's own codes, for what no ERP code says. */
export const CLIENT_ERROR_CODES = [
  /** An answer that breaks the contract. */
  'response.invalid',
  /** No answer: offline, refused, a redirect, or too slow. */
  'network',
  /** The caller cancelled. */
  'aborted',
  /** A failure the ERP gave no code for (a 500, a 503). */
  'server',
  /** No session for this link in this tab. */
  'session.none',
  /** The ERP client's page could not be opened (a pop-up blocker). */
  'connect.blocked',
  /** The person closed the ERP client's page without connecting. */
  'connect.cancelled',
] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

export type ErpErrorCode = ServerErrorCode | ClientErrorCode;

export function isServerErrorCode(code: unknown): code is ServerErrorCode {
  return typeof code === 'string' && (SERVER_ERROR_CODES as readonly string[]).includes(code);
}

/** One error in an error body: a field error has `id`, `key` and `field`; a batch error none. */
export interface ApiError {
  readonly id?: string;
  readonly key?: string;
  readonly field?: string;
  readonly code: string;
  /** In the session's language; only a fallback, as Workspace words errors by code. */
  readonly message: string;
}

export interface ErrorBody {
  readonly message: string;
  readonly correlationId: string;
  readonly errors: readonly ApiError[];
}

/**
 * What went wrong with a call to the ERP, in a form the interface can word. It holds no token, no
 * ERP value and no message from the ERP: only the code, the status and the correlation id that
 * finds the request in the ERP's log.
 */
export class ErpError extends Error {
  readonly code: ErpErrorCode;
  /** The HTTP status, or null when there was no answer. */
  readonly status: number | null;
  readonly correlationId: string | null;
  /** How long `Retry-After` asked to wait, with a 429 or 503. */
  readonly retryAfterMs: number | null;

  constructor(
    code: ErpErrorCode,
    details: {
      readonly status?: number | null;
      readonly correlationId?: string | null;
      readonly retryAfterMs?: number | null;
      /** What broke, for a developer: a path and what was expected, never a value. */
      readonly detail?: string;
    } = {},
  ) {
    const status = details.status ?? null;
    super(
      `Cash Gear ERP: ${code}${status === null ? '' : ` (${status})`}${
        details.detail ? `: ${details.detail}` : ''
      }`,
    );
    this.name = 'ErpError';
    this.code = code;
    this.status = status;
    this.correlationId = details.correlationId ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

/** An answer that breaks the contract, at `path`. */
export class ErpContractError extends Error {
  readonly path: string;
  readonly expected: string;

  constructor(path: string, expected: string, got: unknown) {
    super(`${path}: expected ${expected}, got ${describe(got)}`);
    this.name = 'ErpContractError';
    this.path = path;
    this.expected = expected;
  }
}

/** What kind of thing `value` is, never what it holds. */
function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'string') return `a string of ${value.length} characters`;
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

// ---------------------------------------------------------------------------------------------
// Guards

type Obj = Readonly<Record<string, unknown>>;

function object(value: unknown, path: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ErpContractError(path, 'an object', value);
  }
  return value as Obj;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new ErpContractError(path, 'an array', value);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ErpContractError(path, 'a string', value);
  return value;
}

function nonEmpty(value: unknown, path: string): string {
  const text = string(value, path);
  if (text.length === 0) throw new ErpContractError(path, 'a non-empty string', value);
  return text;
}

function matching(pattern: RegExp, expected: string) {
  return (value: unknown, path: string): string => {
    const text = string(value, path);
    if (!pattern.test(text)) throw new ErpContractError(path, expected, value);
    return text;
  };
}

const connectorId = matching(CONNECTOR_ID, 'a connector id');
const name = matching(NAME, 'a name');

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ErpContractError(path, 'true or false', value);
  return value;
}

function integer(value: unknown, path: string, min = Number.MIN_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new ErpContractError(path, `a whole number from ${min}`, value);
  }
  return value;
}

function oneOf<T extends string>(list: readonly T[], value: unknown, path: string): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) {
    throw new ErpContractError(path, `one of ${list.join(', ')}`, value);
  }
  return value as T;
}

function optional<T>(
  o: Obj,
  key: string,
  path: string,
  read: (value: unknown, path: string) => T,
): T | undefined {
  return o[key] === undefined || o[key] === null ? undefined : read(o[key], `${path}.${key}`);
}

function spread<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function dateTime(value: unknown, path: string): string {
  const text = string(value, path);
  if (!isIsoDateTime(text)) {
    throw new ErpContractError(path, 'an ISO 8601 date and time with a zone', value);
  }
  return text;
}

function language(value: unknown, path: string): Language {
  return oneOf(['en', 'ar'] as const, value, path);
}

function localized(value: unknown, path: string): Localized {
  const o = object(value, path);
  return { en: nonEmpty(o.en, `${path}.en`), ar: nonEmpty(o.ar, `${path}.ar`) };
}

function wireValue(value: unknown, path: string): WireValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new ErpContractError(path, 'a string, number, boolean or null', value);
}

function ticket(value: unknown, path: string): string {
  if (!isTicket(value)) {
    throw new ErpContractError(path, '256 bits in base64url (43 characters)', value);
  }
  return value;
}

// Links

export function parseLinkCreateTicket(
  value: unknown,
  path = '$',
): LinkCreateTicketResponse & { readonly ticket: string } {
  const o = object(value, path);
  const url = nonEmpty(o.url, `${path}.url`);
  const m = /#\/erp-link\/([^/?#]*)$/.exec(url);
  if (!m || !/^https?:\/\/[^/?#]+\/?#/.test(url)) {
    throw new ErpContractError(
      `${path}.url`,
      "Workspace's address ending in #/erp-link/<ticket>",
      url,
    );
  }
  return { url, ticket: ticket(m[1], `${path}.url#ticket`) };
}

export function parseLinkRedeem(value: unknown, path = '$'): LinkRedeemResponse {
  const o = object(value, path);
  return {
    linkId: nonEmpty(o.linkId, `${path}.linkId`),
    company: nonEmpty(o.company, `${path}.company`),
    companyName: nonEmpty(o.companyName, `${path}.companyName`),
  };
}

// A user's session

export function parseConnectCreateTicket(value: unknown, path = '$'): ConnectCreateTicketResponse {
  const o = object(value, path);
  return { ticket: ticket(o.ticket, `${path}.ticket`) };
}

export function parseConnectSession(value: unknown, path = '$'): ConnectSession {
  const o = object(value, path);
  if (!isToken(o.token)) {
    throw new ErpContractError(`${path}.token`, 'an opaque header-safe token', o.token);
  }
  const expiresAt = dateTime(o.expiresAt, `${path}.expiresAt`);
  const maxExpiresAt = dateTime(o.maxExpiresAt, `${path}.maxExpiresAt`);
  if (Date.parse(expiresAt) > Date.parse(maxExpiresAt)) {
    throw new ErpContractError(`${path}.expiresAt`, 'no later than maxExpiresAt', expiresAt);
  }
  const user = object(o.user, `${path}.user`);
  return {
    token: o.token,
    expiresAt,
    maxExpiresAt,
    linkId: nonEmpty(o.linkId, `${path}.linkId`),
    company: nonEmpty(o.company, `${path}.company`),
    companyName: nonEmpty(o.companyName, `${path}.companyName`),
    user: {
      id: nonEmpty(user.id, `${path}.user.id`),
      displayName: string(user.displayName, `${path}.user.displayName`),
    },
    language: language(o.language, `${path}.language`),
  };
}

export function parseRenew(value: unknown, path = '$'): RenewResponse {
  const o = object(value, path);
  return { expiresAt: dateTime(o.expiresAt, `${path}.expiresAt`) };
}

// Connectors

function connectorSummary(value: unknown, path: string): ConnectorSummary {
  const o = object(value, path);
  return {
    id: connectorId(o.id, `${path}.id`),
    kind: oneOf(CONNECTOR_KINDS, o.kind, `${path}.kind`),
    label: localized(o.label, `${path}.label`),
    schemaVersion: nonEmpty(o.schemaVersion, `${path}.schemaVersion`),
    access: oneOf(ACCESS_LEVELS, o.access, `${path}.access`),
  };
}

export function parseConnectors(value: unknown, path = '$'): ConnectorsResponse {
  const o = object(value, path);
  const connectors = array(o.connectors, `${path}.connectors`).map((v, i) =>
    connectorSummary(v, `${path}.connectors[${i}]`),
  );
  if (new Set(connectors.map((c) => c.id)).size !== connectors.length) {
    throw new ErpContractError(`${path}.connectors`, 'unique ids', o.connectors);
  }
  return { connectors };
}

function bound(value: unknown, path: string, type: FieldType): number | string {
  if (type === 'decimal') {
    const text = string(value, path);
    if (!isDecimal(text, 28)) throw new ErpContractError(path, 'a decimal string', value);
    return text;
  }
  if (type === 'integer') return integer(value, path);
  if (type === 'date') {
    const text = string(value, path);
    if (!isIsoDate(text)) throw new ErpContractError(path, 'a date, YYYY-MM-DD', value);
    return text;
  }
  throw new ErpContractError(path, 'no bound on a field of this type', value);
}

function field(value: unknown, path: string, lookups: Obj): FieldSchema {
  const o = object(value, path);
  const type = oneOf(FIELD_TYPES, o.type, `${path}.type`);
  const editable = boolean(o.editable, `${path}.editable`);
  const editReason = optional(o, 'editReason', path, (v, p) => oneOf(EDIT_REASONS, v, p));
  if (editable && editReason !== undefined) {
    throw new ErpContractError(`${path}.editReason`, 'nothing on an editable field', editReason);
  }
  if (!editable && editReason === undefined) {
    throw new ErpContractError(`${path}.editReason`, 'a reason on a read-only field', undefined);
  }
  const scale = optional(o, 'scale', path, (v, p) => integer(v, p, 0));
  if (type === 'decimal' && scale === undefined) {
    throw new ErpContractError(`${path}.scale`, 'a scale on a decimal field', undefined);
  }
  const lookup = optional(o, 'lookup', path, name);
  if (type === 'lookup' && (lookup === undefined || lookups[lookup] === undefined)) {
    throw new ErpContractError(`${path}.lookup`, 'the name of a list in lookups', lookup);
  }
  return {
    name: name(o.name, `${path}.name`),
    label: localized(o.label, `${path}.label`),
    type,
    editable,
    ...spread('editReason', editReason),
    ...spread('required', optional(o, 'required', path, boolean)),
    ...spread(
      'maxLength',
      optional(o, 'maxLength', path, (v, p) => integer(v, p, 1)),
    ),
    ...spread(
      'min',
      optional(o, 'min', path, (v, p) => bound(v, p, type)),
    ),
    ...spread(
      'max',
      optional(o, 'max', path, (v, p) => bound(v, p, type)),
    ),
    ...spread('scale', scale),
    ...spread('lookup', lookup),
    filterable: boolean(o.filterable, `${path}.filterable`),
    sortable: boolean(o.sortable, `${path}.sortable`),
  };
}

function lookupItem(value: unknown, path: string): LookupItem {
  const o = object(value, path);
  return {
    code: nonEmpty(o.code, `${path}.code`),
    label: string(o.label, `${path}.label`),
    ...spread('active', optional(o, 'active', path, boolean)),
  };
}

function parameter(value: unknown, path: string): ReportParameter {
  const o = object(value, path);
  return {
    name: name(o.name, `${path}.name`),
    label: localized(o.label, `${path}.label`),
    type: nonEmpty(o.type, `${path}.type`),
    required: boolean(o.required, `${path}.required`),
  };
}

export function parseSchema(value: unknown, path = '$'): ConnectorSchema {
  const o = object(value, path);
  const lookupsObj = object(o.lookups, `${path}.lookups`);
  const lookups: Record<string, readonly LookupItem[]> = {};
  for (const [list, items] of Object.entries(lookupsObj)) {
    const at = `${path}.lookups.${list}`;
    name(list, at);
    const read = array(items, at).map((v, i) => lookupItem(v, `${at}[${i}]`));
    if (new Set(read.map((item) => item.code)).size !== read.length) {
      throw new ErpContractError(at, 'unique codes', items);
    }
    lookups[list] = read;
  }
  const fields = array(o.fields, `${path}.fields`).map((v, i) =>
    field(v, `${path}.fields[${i}]`, lookupsObj),
  );
  if (fields.length === 0) throw new ErpContractError(`${path}.fields`, 'at least one field', []);
  const names = new Set(fields.map((f) => f.name));
  if (names.size !== fields.length) {
    throw new ErpContractError(`${path}.fields`, 'unique names', o.fields);
  }
  const keyField = nonEmpty(o.keyField, `${path}.keyField`);
  const key = fields.find((f) => f.name === keyField);
  if (!key || key.editable || (key.type !== 'text' && key.type !== 'integer')) {
    throw new ErpContractError(`${path}.keyField`, 'a read-only text or integer field', keyField);
  }
  const idField = o.idField === null ? null : nonEmpty(o.idField, `${path}.idField`);
  if (idField !== null && names.has(idField)) {
    throw new ErpContractError(`${path}.idField`, 'a field not sent in values', idField);
  }
  const parameters = optional(o, 'parameters', path, (v, p) =>
    array(v, p).map((item, i) => parameter(item, `${p}[${i}]`)),
  );
  return {
    id: connectorId(o.id, `${path}.id`),
    schemaVersion: nonEmpty(o.schemaVersion, `${path}.schemaVersion`),
    keyField,
    idField,
    maxPageSize: integer(o.maxPageSize, `${path}.maxPageSize`, 1),
    maxRecords: integer(o.maxRecords, `${path}.maxRecords`, 1),
    maxCommitRecords: integer(o.maxCommitRecords, `${path}.maxCommitRecords`, 0),
    fields,
    lookups,
    ...spread('parameters', parameters),
  };
}

// Query

/** Why `value` is not a valid wire value for `f`, or null when it is. Not business rules. */
export function valueProblem(f: FieldSchema, value: WireValue): string | null {
  if (value === null) return null;
  switch (f.type) {
    case 'text':
      return typeof value === 'string' ? null : 'not text';
    case 'lookup':
      return typeof value === 'string' ? null : 'not a code';
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value) ? null : 'not a whole number';
    case 'decimal':
      return typeof value === 'string' && isDecimal(value, f.scale ?? 0)
        ? null
        : `not a decimal string at scale ${f.scale ?? 0}`;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'not true or false';
    case 'date':
      return typeof value === 'string' && isIsoDate(value) ? null : 'not YYYY-MM-DD';
    case 'dateTime':
      return typeof value === 'string' && isIsoDateTime(value) ? null : 'not ISO 8601 with a zone';
  }
}

/**
 * A record's values against the schema: exactly the fields asked for (every schema field when
 * `fields` is absent), each in its wire format, and the key field, when sent, equal to the
 * record's key. Returns the problems found, each naming a field, never a value.
 */
export function recordProblems(
  schema: ConnectorSchema,
  record: Pick<ErpRecord, 'key' | 'values'>,
  fields?: readonly string[],
): string[] {
  return problemsOf(schema, record, fields).map(({ field, problem }) => `${field}: ${problem}`);
}

function problemsOf(
  schema: ConnectorSchema,
  record: Pick<ErpRecord, 'key' | 'values'>,
  fields: readonly string[] | undefined,
): { field: string; problem: string }[] {
  const problems: { field: string; problem: string }[] = [];
  const byName = new Map(schema.fields.map((f) => [f.name, f]));
  const wanted = fields ?? schema.fields.map((f) => f.name);
  const wantedSet = new Set(wanted);
  for (const key of Object.keys(record.values)) {
    if (!wantedSet.has(key)) {
      problems.push({
        field: key,
        problem: byName.has(key) ? 'not asked for' : 'not in the schema',
      });
    }
  }
  for (const fieldName of wanted) {
    const f = byName.get(fieldName);
    if (!f) {
      problems.push({ field: fieldName, problem: 'not in the schema' });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(record.values, fieldName)) {
      problems.push({ field: fieldName, problem: 'missing' });
      continue;
    }
    const problem = valueProblem(f, record.values[fieldName]!);
    if (problem) problems.push({ field: fieldName, problem });
  }
  if (wantedSet.has(schema.keyField) && byName.has(schema.keyField)) {
    const key = record.values[schema.keyField];
    if (key === undefined || key === null || String(key) !== record.key) {
      problems.push({ field: schema.keyField, problem: "differs from the record's key" });
    }
  }
  return problems;
}

function erpRecord(value: unknown, path: string): ErpRecord {
  const o = object(value, path);
  const values = object(o.values, `${path}.values`);
  for (const [key, v] of Object.entries(values)) wireValue(v, `${path}.values.${key}`);
  const version = string(o.version, `${path}.version`);
  if (!isVersion(version)) throw new ErpContractError(`${path}.version`, 'base64', version);
  return {
    id: nonEmpty(o.id, `${path}.id`),
    key: nonEmpty(o.key, `${path}.key`),
    version,
    values: values as Readonly<Record<string, WireValue>>,
  };
}

/** What a query's answer is checked against, when the caller knows it. */
export interface QueryContext {
  /** The connector's schema: every record's values are checked against it. */
  readonly schema?: ConnectorSchema;
  /** The request's `fields`. */
  readonly fields?: readonly string[];
  /** The request's `pageSize`: no more records than that. */
  readonly pageSize?: number;
}

export function parseQueryResponse(
  value: unknown,
  context: QueryContext = {},
  path = '$',
): QueryResponse {
  const o = object(value, path);
  const records = array(o.records, `${path}.records`).map((v, i) =>
    erpRecord(v, `${path}.records[${i}]`),
  );
  if (new Set(records.map((r) => r.id)).size !== records.length) {
    throw new ErpContractError(`${path}.records`, 'unique ids', o.records);
  }
  if (context.pageSize !== undefined && records.length > context.pageSize) {
    throw new ErpContractError(`${path}.records`, `at most ${context.pageSize}`, o.records);
  }
  const { schema } = context;
  if (schema) {
    records.forEach((record, i) => {
      const found = problemsOf(schema, record, context.fields)[0];
      if (found) {
        throw new ErpContractError(
          `${path}.records[${i}].values.${found.field}`,
          `what the schema allows (${found.problem})`,
          record.values[found.field],
        );
      }
    });
  }
  const nextCursor = o.nextCursor === null ? null : nonEmpty(o.nextCursor, `${path}.nextCursor`);
  const total = integer(o.total, `${path}.total`, 0);
  if (total < records.length) {
    throw new ErpContractError(`${path}.total`, 'at least the records sent', total);
  }
  return { records, nextCursor, total };
}

// Errors

function apiError(value: unknown, path: string): ApiError {
  const o = object(value, path);
  return {
    ...spread('id', optional(o, 'id', path, nonEmpty)),
    ...spread('key', optional(o, 'key', path, string)),
    ...spread('field', optional(o, 'field', path, nonEmpty)),
    code: nonEmpty(o.code, `${path}.code`),
    message: string(o.message, `${path}.message`),
  };
}

export function parseErrorBody(value: unknown, path = '$'): ErrorBody {
  const o = object(value, path);
  return {
    message: string(o.message, `${path}.message`),
    correlationId: nonEmpty(o.correlationId, `${path}.correlationId`),
    errors: array(o.errors, `${path}.errors`).map((v, i) => apiError(v, `${path}.errors[${i}]`)),
  };
}

// The pop-up's message

/**
 * The ticket in a `cgw-erp-connect` message with the expected state, or null for anything else.
 * The caller has checked where the message came from.
 */
export function readConnectMessage(data: unknown, state: string): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const o = data as Obj;
  if (o.type !== CONNECT_MESSAGE_TYPE || o.state !== state || !isTicket(o.ticket)) return null;
  return o.ticket;
}
