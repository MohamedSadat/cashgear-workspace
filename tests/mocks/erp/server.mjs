// A mock of Cash Gear ERP for Workspace (erp-connect.1, docs/INTEGRATIONS.md, "Cash Gear ERP"):
// its API, with every route of the contract and the link routes, and its client's two pages, the
// connect page Workspace opens in a pop-up and the "Link Cash Gear Workspace" page. Plain Node,
// no dependencies. The contract suite (tests/contracts/erp) proves it behaves as the contract
// says; the browser tests and `pnpm dev:web` against a local API use it in place of the ERP.
//
//   node tests/mocks/erp/server.mjs [--port 4282] [--client-port 4284] [--host 127.0.0.1]
//                                   [--workspace-url http://127.0.0.1:5273] [--large]
//
// Ports also come from CGW_MOCK_ERP_PORT and CGW_MOCK_ERP_CLIENT_PORT. `/__mock/*` on the API
// resets it, moves its clock, injects faults, makes tickets without the pop-up, revokes links,
// turns Workspace off for a company, sets rate limits and shows its state (never a token).
//
// Phase 12 (INTEGRATIONS.md, "Queries paged in the ERP's database" and "Reports"): queries
// search, match and order by 0.10.0's rules (rules.mjs), page by a keyset cursor and read at
// most `maxRecords` records through their cursors; `--large` (or `reset {large: true}`) seeds
// 100,000 records a connector by the rule in large.mjs; three report connectors (reports.mjs),
// listed only when `Connectors?kinds=` names reports.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORTS,
  REPORT_IDS,
  STOCK_PLACES_CAP,
  datesIn,
  runReport,
  seedLedgers,
} from './reports.mjs';
import {
  compareKeys,
  decimalOf,
  fold,
  isDecimalText,
  sameWire,
  sortKeyOf,
  toUnits,
  trimNet,
} from './rules.mjs';
import {
  COMPANIES,
  CONNECTORS,
  CONNECTOR_IDS,
  MARKERS,
  USERS,
  lookups,
  seedRecords,
} from './seed.mjs';

export { COMPANIES, CONNECTORS, MARKERS, USERS } from './seed.mjs';
export { REPORTS, REPORT_IDS } from './reports.mjs';

/** The contract's lifetimes and sizes. */
export const LIMITS = {
  ticketMs: 120_000,
  sessionIdleMs: 30 * 60_000,
  sessionMaxMs: 10 * 60 * 60_000,
  maxSort: 3,
};

/** Workspace's origins: development and preview on both hosts, and the desktop's. */
export const WORKSPACE_ORIGINS = [
  'http://127.0.0.1:5273',
  'http://127.0.0.1:4273',
  'http://localhost:5273',
  'http://localhost:4273',
  'tauri://localhost',
  'http://tauri.localhost',
];

export const DEFAULT_PORTS = { api: 4282, client: 4284 };

const MAX_BODY = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Workspace block id: 12 characters of base 62. */
const BLOCK = /^[0-9A-Za-z]{12}$/;

// ---------------------------------------------------------------------------------------------
// Messages in the session's language: the ERP's fallback text, as Workspace words errors by code.

const TEXT = {
  en: {
    'ticket.invalid': 'This link has expired or has already been used. Connect again.',
    'session.expired': 'Your Cash Gear ERP session has ended. Connect again to continue.',
    'origin.denied': 'This site cannot connect to Cash Gear ERP.',
    'privilege.denied': 'You do not have the privilege for this.',
    'link.revoked': 'This workspace is no longer linked to Cash Gear ERP.',
    'connector.notFound': 'Cash Gear ERP has no such list.',
    'request.invalid': 'The request is not valid.',
    'rate.limited': 'Too many requests. Try again in a moment.',
    'batch.tooLarge': 'Too many records at once.',
    'schema.changed': 'The fields of this list have changed. Read it again.',
    'commit.reused': 'This commit id was used for other changes.',
    commit: 'Some changes cannot be saved.',
    conflict: 'Records were changed since they were read.',
    required: 'A value is required.',
    maxLength: 'The text is too long.',
    type: 'The value is not of this field’s type.',
    range: 'The value is out of range.',
    scale: 'The value has too many decimals.',
    'lookup.notFound': 'The code is not an active choice.',
    'field.readOnly': 'This field cannot be changed.',
    'record.notFound': 'The record does not exist.',
    'record.locked': 'The record is locked.',
    'version.missing': 'The record’s version is missing.',
    shared: 'Every record of one key must get the same value for this field.',
  },
  ar: {
    'ticket.invalid': 'انتهت صلاحية هذا الرابط أو استخدم من قبل. اتصل من جديد.',
    'session.expired': 'انتهت جلسة Cash Gear ERP. اتصل من جديد للمتابعة.',
    'origin.denied': 'لا يمكن لهذا الموقع الاتصال بـ Cash Gear ERP.',
    'privilege.denied': 'ليست لديك صلاحية لذلك.',
    'link.revoked': 'لم تعد مساحة العمل هذه مرتبطة بـ Cash Gear ERP.',
    'connector.notFound': 'لا توجد هذه القائمة في Cash Gear ERP.',
    'request.invalid': 'الطلب غير صالح.',
    'rate.limited': 'طلبات كثيرة. حاول مرة أخرى بعد قليل.',
    'batch.tooLarge': 'سجلات كثيرة في مرة واحدة.',
    'schema.changed': 'تغيّرت حقول هذه القائمة. اقرأها من جديد.',
    'commit.reused': 'استُخدم معرّف الاعتماد هذا لتغييرات أخرى.',
    commit: 'لا يمكن حفظ بعض التغييرات.',
    conflict: 'تغيّرت سجلات بعد قراءتها.',
    required: 'القيمة مطلوبة.',
    maxLength: 'النص أطول من المسموح.',
    type: 'القيمة ليست من نوع هذا الحقل.',
    range: 'القيمة خارج النطاق.',
    scale: 'أرقام عشرية كثيرة.',
    'lookup.notFound': 'الرمز ليس اختيارًا نشطًا.',
    'field.readOnly': 'لا يمكن تغيير هذا الحقل.',
    'record.notFound': 'السجل غير موجود.',
    'record.locked': 'السجل مقفل.',
    'version.missing': 'إصدار السجل غير موجود.',
    shared: 'يجب أن تأخذ سجلات المفتاح الواحد القيمة نفسها لهذا الحقل.',
  },
};

// ---------------------------------------------------------------------------------------------
// Helpers

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isWire = (v) =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v));
const DECIMAL = /^-?(0|[1-9]\d*)(\.(\d+))?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date that exists, `YYYY-MM-DD`. */
function isDate(text) {
  if (typeof text !== 'string' || !DATE.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const at = new Date(Date.UTC(2000, m - 1, d));
  at.setUTCFullYear(y);
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/** A connector of either kind, by id: an entity (seed.mjs) or a report (reports.mjs). */
const connectorById = (id) =>
  typeof id !== 'string'
    ? undefined
    : Object.hasOwn(CONNECTORS, id)
      ? CONNECTORS[id]
      : Object.hasOwn(REPORTS, id)
        ? REPORTS[id]
        : undefined;

/**
 * A connector's own order, which is also its order with no sort and its ties' order: Vendors by
 * record id, Customers by account (the seed's accounts order alike by the database's collation and
 * ordinal), Items on hand by item, site, warehouse and location (ordinal), and each report's.
 * Each part is `{field, as, desc?}`: `number`, `ordinal` (null as ''), or a field type.
 */
const OWN_ORDER = {
  vendors: [{ field: 'id', as: 'number' }],
  customers: [{ field: 'customerAccount', as: 'ordinal' }],
  itemsOnHand: ['itemId', 'siteId', 'warehouseId', 'locationId'].map((field) => ({
    field,
    as: 'ordinal',
  })),
  apAging: [
    { field: 'balance', as: 'decimal', desc: true },
    { field: 'vendorName', as: 'text' },
    { field: 'vendorAccount', as: 'ordinal' },
  ],
  stockBalance: ['itemId', 'siteId', 'warehouseId', 'locationId'].map((field) => ({
    field,
    as: 'ordinal',
  })),
  trialBalance: [
    { field: 'balance', as: 'decimal', desc: true },
    { field: 'accountId', as: 'ordinal' },
  ],
};

function ownKeyOf(part, value) {
  if (part.as === 'number') return { n: Number(value) };
  if (part.as === 'ordinal') return { f: '', t: value ?? '' };
  return sortKeyOf(part.as, value);
}

/** Orders two prepared entries: the query's sort keys, then the connector's own order. */
function compareEntries(a, b, sort, own) {
  for (let i = 0; i < sort.length; i++) {
    const order = compareKeys(a.sort[i], b.sort[i]);
    if (order !== 0) return sort[i].direction === 'desc' ? -order : order;
  }
  for (let i = 0; i < own.length; i++) {
    const order = compareKeys(a.own[i], b.own[i]);
    if (order !== 0) return own[i].desc ? -order : order;
  }
  return 0;
}

/** Sorted keys at every level, so equal queries hash equally whatever their key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * A version for a record whose table has no rowversion (Phase 10, Customers and Items on hand): 8
 * bytes of the SHA-256 of the values the user sees, in base64, as `ConnectorRules.ContentVersion`
 * makes it. Any change to one of them, by anyone, makes another.
 */
const contentVersion = (values) =>
  createHash('sha256').update(canonical(values)).digest().subarray(0, 8).toString('base64');

/** `""` and `null` are one value for text and lookups, as the ERP takes them. */
const blank = (value) => (value === '' || value === undefined ? null : value);

function compareDecimal(a, b) {
  const sa = a.startsWith('-') ? -1 : 1;
  const sb = b.startsWith('-') ? -1 : 1;
  const [ai, af = ''] = a.replace('-', '').split('.');
  const [bi, bf = ''] = b.replace('-', '').split('.');
  const width = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(width, '0')) * BigInt(sa);
  const y = BigInt(bi + bf.padEnd(width, '0')) * BigInt(sb);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Why `value` cannot be compared with `field`'s values, or null. */
function valueProblem(field, value) {
  if (!isWire(value)) return 'a value';
  if (value === null) return null;
  switch (field.type) {
    case 'text':
    case 'lookup':
      return typeof value === 'string' ? null : 'text';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'true or false';
    case 'integer':
      return Number.isSafeInteger(value) ? null : 'a whole number';
    case 'decimal':
      return typeof value === 'string' && DECIMAL.test(value) ? null : 'a decimal string';
    case 'date':
      return typeof value === 'string' && DATE.test(value) ? null : 'YYYY-MM-DD';
    default:
      return typeof value === 'string' ? null : 'text';
  }
}

class Reply {
  constructor(status, body, headers = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

class Refusal extends Error {
  constructor(status, code, why) {
    super(why ?? code);
    this.status = status;
    this.code = code;
    this.why = why;
  }
}

const refuse = (status, code, why) => {
  throw new Refusal(status, code, why);
};

// ---------------------------------------------------------------------------------------------
// The mock

export class MockErp {
  /**
   * @param {{ workspaceOrigins?: string[], clientOrigins?: string[], workspaceUrl?: string }} options
   */
  constructor({
    workspaceOrigins = WORKSPACE_ORIGINS,
    clientOrigins = [],
    workspaceUrl = 'http://127.0.0.1:5273',
  } = {}) {
    this.workspaceOrigins = new Set(workspaceOrigins);
    this.clientOrigins = new Set(clientOrigins);
    this.workspaceUrl = workspaceUrl.replace(/\/+$/, '');
    this.reset();
  }

  /**
   * Back to the start: records, tickets, sessions, links, clock, faults, limits, switches, and
   * Phase 7's stored commits and audit.
   */
  reset(options = {}) {
    this.records = seedRecords(options);
    // Phase 12: the reports' ledgers, always from the usual seed's records (with the large seed,
    // AP aging finds none of its vendors), and the stock report's cap.
    this.ledgers = seedLedgers(options.large ? seedRecords() : this.records);
    this.reportLimits = { stockPlaces: STOCK_PLACES_CAP };
    /** Rises with every write, so a cached query of the records before it is not used. */
    this.dataVersion = (this.dataVersion ?? 0) + 1;
    this.queryCache = new Map();
    this.foldCache = new Map();
    // Versions after the seed's: one 8-byte counter, as SQL Server's `rowversion` is (Vendors';
    // the others' are made from their values).
    this.version = Object.values(this.records)
      .flat()
      .reduce((max, row) => {
        if (typeof row.version !== 'string') return max;
        const n = Buffer.from(row.version, 'base64').readBigUInt64BE();
        return n > max ? n : max;
      }, 0n);
    /** `${company}|${commitId}` → { hash, body }. */
    this.commits = new Map();
    /** One row per changed field, as the ERP's audit holds them. */
    this.audit = [];
    this.offsetMs = 0;
    this.tickets = new Map();
    this.sessions = new Map();
    this.links = new Map();
    this.faults = [];
    this.workspaceOff = new Set();
    // Rate limits per client address over fixed one-minute windows of the mock's clock: off
    // until `/__mock/limits` sets them, so the browser tests can open as many sessions as they
    // like.
    this.limits = { ticketsPerMinute: null, sessionPerMinute: null };
    this.windows = new Map();
    this.cursorKey = randomBytes(16).toString('hex');
  }

  now() {
    return Date.now() + this.offsetMs;
  }

  nextVersion() {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(++this.version);
    return bytes.toString('base64');
  }

  userByKey(key) {
    if (typeof key !== 'string') return null;
    const entry = Object.entries(USERS).find(([, u]) => u.key === key);
    return entry ? { name: entry[0], ...entry[1] } : null;
  }

  userByName(name) {
    return typeof name === 'string' && Object.hasOwn(USERS, name) ? { name, ...USERS[name] } : null;
  }

  /** A link that is live for `company` (and `workspaceId`, when given), or null. */
  liveLink(linkId, company, workspaceId) {
    const link = typeof linkId === 'string' ? this.links.get(linkId) : undefined;
    if (!link || link.revokedAt !== null || link.company !== company) return null;
    if (this.workspaceOff.has(company)) return null;
    if (workspaceId !== undefined && link.workspaceId !== workspaceId) return null;
    return link;
  }

  /**
   * The fields `user` may see of `connector`, in the ERP's order: without those its field rules
   * keep from them (Customers' national ID from employees; Phase 12, stock balance's cost from
   * those the Warehouse balance page does not show it to).
   */
  fieldsFor(user, connector) {
    const hidden = new Set(user.hidden?.[connector.id] ?? []);
    if (!user.showCost) for (const name of connector.costFields ?? []) hidden.add(name);
    return connector.fields.filter((f) => !hidden.has(f.name));
  }

  /** Whether `user` may view `connector`: an entity they hold, or a report one of their roles takes. */
  canView(user, connector) {
    if (connector.kind === 'report') {
      return (user.roles ?? []).some((role) => connector.roles.includes(role));
    }
    return user.connectors.includes(connector.id);
  }

  /**
   * A record's version as a user reads it: Vendors' rowversion, else the hash of the values the
   * user sees (`names`), so two users seeing different fields read different versions.
   */
  versionOf(connector, row, names) {
    if (connector.versions === 'rowversion') return row.version;
    return contentVersion(Object.fromEntries(names.map((n) => [n, row[n] ?? null])));
  }

  /** The records `user` may see of `connector`: their company's, under their record rules. */
  rowsFor(user, connector) {
    const rule = user.rules?.[connector.id];
    return this.records[connector.id].filter(
      (row) =>
        row.company === user.company &&
        (!rule || Object.entries(rule).every(([name, value]) => row[name] === value)),
    );
  }

  // -------------------------------------------------------------------------------------------
  // HTTP

  /** Which origins may read a route's answers, and which headers they may send. */
  cors(lower) {
    if (lower.startsWith('api/connect/') || lower === 'api/system/workspacelink/redeem') {
      return { origins: this.workspaceOrigins, headers: 'Content-Type, X-Connect-Session' };
    }
    if (lower.startsWith('api/system/')) {
      return { origins: this.clientOrigins, headers: 'Content-Type, X-API-Key' };
    }
    if (lower.startsWith('__mock/')) {
      return {
        origins: new Set([...this.workspaceOrigins, ...this.clientOrigins]),
        headers: 'Content-Type',
      };
    }
    return null;
  }

  async handle(req, res) {
    const correlationId = randomUUID();
    const url = new URL(req.url ?? '/', 'http://mock');
    let path;
    try {
      path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
    } catch {
      path = url.pathname.replace(/^\/+|\/+$/g, '');
    }
    const lower = path.toLowerCase();
    const origin = req.headers.origin;
    const cors = this.cors(lower);
    const corsAllowed = cors !== null && typeof origin === 'string' && cors.origins.has(origin);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Correlation-Id', correlationId);
    res.setHeader('Vary', 'Origin');
    if (corsAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Expose-Headers', 'X-Correlation-Id, Retry-After');
    }
    if (req.method === 'OPTIONS') {
      if (corsAllowed) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        res.setHeader('Access-Control-Allow-Headers', cors.headers);
        res.setHeader('Access-Control-Max-Age', '600');
      }
      res.writeHead(204).end();
      return;
    }
    const ctx = { req, res, url, path, lower, origin, correlationId, language: 'en' };
    try {
      ctx.body = await readBody(req);
    } catch (error) {
      return send(res, this.fail(ctx, error.status ?? 400, 'request.invalid', error.message));
    }
    if (lower.startsWith('__mock/')) return send(res, this.control(ctx));

    const fault = this.takeFault(path);
    // `drop: 'after'`: the route runs and its answer is lost, as a commit that went through.
    const dropAfter = fault?.drop === 'after';
    if (fault && !dropAfter) {
      if (fault.drop) return void req.socket.destroy();
      const headers =
        fault.retryAfter === undefined ? {} : { 'Retry-After': String(fault.retryAfter) };
      if (fault.body !== undefined) {
        return send(res, new Reply(fault.status ?? 200, fault.body, headers));
      }
      const status = fault.status ?? 500;
      const reply = fault.code
        ? this.fail(ctx, status, fault.code)
        : new Reply(status, { message: `Injected ${status}.`, correlationId, errors: [] });
      Object.assign(reply.headers, headers);
      return send(res, reply);
    }

    const limited = this.rateLimit(ctx);
    if (limited) return send(res, limited);
    let reply;
    try {
      reply = this.route(ctx);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      reply = this.fail(ctx, error.status, error.code, error.why);
    }
    if (dropAfter) return void req.socket.destroy();
    send(res, reply);
  }

  fail(ctx, status, code, why) {
    const table = TEXT[ctx.language] ?? TEXT.en;
    const message = why ?? table[code] ?? code;
    return new Reply(status, {
      message,
      correlationId: ctx.correlationId,
      errors: [{ code, message }],
    });
  }

  takeFault(path) {
    // `match` is a regular expression over the path without its leading slash, ignoring case:
    // anchor it (`Connectors$`), since `Connectors` matches every connector route.
    const index = this.faults.findIndex((f) => f.pattern.test(path));
    if (index < 0) return null;
    const fault = this.faults[index];
    if (fault.times > 0 && --fault.times === 0) this.faults.splice(index, 1);
    return fault;
  }

  /**
   * A 429 once a client address has made more ticket and redeem requests, or more Renew and End
   * requests, this minute than `limits` allows: before the route runs, so a refused Redeem
   * leaves its ticket usable.
   */
  rateLimit(ctx) {
    const policy = {
      'api/system/workspacelink/createticket': 'ticketsPerMinute',
      'api/system/workspacelink/redeem': 'ticketsPerMinute',
      'api/system/workspaceconnect/createticket': 'ticketsPerMinute',
      'api/connect/session/redeem': 'ticketsPerMinute',
      'api/connect/session/renew': 'sessionPerMinute',
      'api/connect/session/end': 'sessionPerMinute',
    }[ctx.lower];
    const limit = policy ? this.limits[policy] : null;
    if (!Number.isSafeInteger(limit)) return null;
    const now = this.now();
    const window = Math.floor(now / 60_000);
    const key = `${policy}|${ctx.req.socket.remoteAddress ?? ''}`;
    const counted = this.windows.get(key);
    const count = counted?.window === window ? counted.count + 1 : 1;
    this.windows.set(key, { window, count });
    if (count <= limit) return null;
    const reply = this.fail(ctx, 429, 'rate.limited');
    reply.headers['Retry-After'] = String(
      Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000)),
    );
    return reply;
  }

  route(ctx) {
    const { req, lower } = ctx;
    const method = (route, wanted) => {
      if (lower !== route.toLowerCase()) return false;
      if (req.method !== wanted) refuse(405, 'request.invalid', `Use ${wanted}.`);
      return true;
    };
    if (method('api/system/WorkspaceLink/CreateTicket', 'POST')) return this.linkTicket(ctx);
    if (method('api/system/WorkspaceLink/Redeem', 'POST')) return this.linkRedeem(ctx);
    if (method('api/system/WorkspaceLink/Revoke', 'POST')) return this.linkRevoke(ctx);
    if (method('api/system/WorkspaceConnect/CreateTicket', 'POST')) return this.connectTicket(ctx);
    if (method('api/connect/Session/Redeem', 'POST')) return this.redeem(ctx);
    if (method('api/connect/Session/Renew', 'POST')) return this.renew(this.session(ctx));
    if (method('api/connect/Session/End', 'POST')) return this.end(this.session(ctx));
    if (method('api/connect/Connectors', 'GET')) return this.connectors(ctx, this.session(ctx));
    const at = /^api\/connect\/connectors\/([^/]+)\/(schema|query|commit)$/.exec(lower);
    if (at) {
      const id = ctx.path.split('/')[3];
      const wanted = at[2] === 'schema' ? 'GET' : 'POST';
      if (req.method !== wanted) refuse(405, 'request.invalid', `Use ${wanted}.`);
      const session = this.session(ctx);
      const connector = this.connectorFor(session, id);
      if (at[2] === 'schema') return this.schema(session, connector);
      if (at[2] === 'query') return this.query(ctx, session, connector);
      return this.commit(ctx, session, connector);
    }
    const status = /^api\/connect\/connectors\/([^/]+)\/commitstatus\/([^/]+)$/.exec(lower);
    if (status) {
      if (req.method !== 'GET') refuse(405, 'request.invalid', 'Use GET.');
      const session = this.session(ctx);
      this.connectorFor(session, ctx.path.split('/')[3]);
      const commitId = ctx.path.split('/')[5];
      if (!UUID.test(commitId)) refuse(400, 'request.invalid', 'commitId must be a UUID.');
      // A refused commit and a dry run store nothing, and another company's id is not this one's.
      const stored = this.commits.get(`${session.company}|${commitId.toLowerCase()}`);
      return new Reply(
        200,
        stored ? { status: 'committed', ...stored.body } : { status: 'unknown' },
      );
    }
    return new Reply(404, { message: 'Not found.', correlationId: ctx.correlationId, errors: [] });
  }

  // -------------------------------------------------------------------------------------------
  // The ERP client's routes, with an API key

  /** The API key's user, or null: the API-key handler then answers 401 with no body. */
  caller(ctx) {
    return this.userByKey(ctx.req.headers['x-api-key']);
  }

  linkTicket(ctx) {
    const user = this.caller(ctx);
    if (!user) return new Reply(401, null);
    if (!user.admin) refuse(403, 'privilege.denied');
    if (this.workspaceOff.has(user.company)) refuse(403, 'privilege.denied', 'Workspace is off.');
    const body = isObject(ctx.body) ? ctx.body : {};
    // The mock's own extension: its link page names the Workspace it opens, from the list.
    let base = this.workspaceUrl;
    if (body.workspaceUrl !== undefined && body.workspaceUrl !== null) {
      if (!this.workspaceOrigins.has(body.workspaceUrl)) {
        refuse(400, 'request.invalid', 'workspaceUrl must be one of Workspace’s origins.');
      }
      base = body.workspaceUrl;
    }
    const ticket = this.makeTicket({ kind: 'link', user: user.name, company: user.company });
    return new Reply(200, { url: `${base}/#/erp-link/${ticket}` });
  }

  linkRedeem(ctx) {
    // The Origin is checked before the ticket is looked at, so a refused site cannot use it up.
    if (!this.workspaceOrigins.has(ctx.origin)) refuse(403, 'origin.denied');
    const body = ctx.body;
    if (
      !isObject(body) ||
      typeof body.ticket !== 'string' ||
      !nonEmptyId(body.workspaceId) ||
      typeof body.workspaceName !== 'string' ||
      body.workspaceName.length > 200
    ) {
      refuse(400, 'request.invalid', 'ticket, workspaceId and workspaceName are required.');
    }
    const ticket = this.takeTicket(body.ticket, 'link');
    if (!ticket) refuse(401, 'ticket.invalid');
    if (this.workspaceOff.has(ticket.company)) refuse(403, 'link.revoked');
    const company = ticket.company;
    let link = [...this.links.values()].find(
      (l) => l.company === company && l.workspaceId === body.workspaceId && l.revokedAt === null,
    );
    if (!link) {
      link = {
        linkId: randomUUID(),
        company,
        workspaceId: body.workspaceId,
        workspaceName: body.workspaceName,
        linkedBy: ticket.user,
        linkedAt: iso(this.now()),
        revokedAt: null,
      };
      this.links.set(link.linkId, link);
    }
    return new Reply(200, {
      linkId: link.linkId,
      company,
      companyName: COMPANIES[company].name,
    });
  }

  linkRevoke(ctx) {
    const user = this.caller(ctx);
    if (!user) return new Reply(401, null);
    if (!user.admin) refuse(403, 'privilege.denied');
    const linkId = isObject(ctx.body) ? ctx.body.linkId : undefined;
    const link = typeof linkId === 'string' ? this.links.get(linkId) : undefined;
    if (!link || link.company !== user.company) refuse(400, 'request.invalid', 'Unknown link.');
    link.revokedAt ??= iso(this.now());
    return new Reply(204, null);
  }

  connectTicket(ctx) {
    const user = this.caller(ctx);
    if (!user) return new Reply(401, null);
    return new Reply(200, { ticket: this.connectTicketFor(user, ctx.body) });
  }

  connectTicketFor(user, body) {
    if (!isObject(body) || !nonEmptyId(body.workspaceId) || typeof body.linkId !== 'string') {
      refuse(400, 'request.invalid', 'workspaceId and linkId are required.');
    }
    const language = body.language ?? 'en';
    if (language !== 'en' && language !== 'ar') {
      refuse(400, 'request.invalid', 'language must be "en" or "ar".');
    }
    if (!this.liveLink(body.linkId, user.company, body.workspaceId)) refuse(403, 'link.revoked');
    return this.makeTicket({
      kind: 'connect',
      user: user.name,
      company: user.company,
      linkId: body.linkId,
      workspaceId: body.workspaceId,
      language,
    });
  }

  makeTicket(values) {
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(sha256(ticket), {
      ...values,
      expiresAt: this.now() + LIMITS.ticketMs,
      used: false,
    });
    return ticket;
  }

  /** The ticket of that kind if it is unused and unexpired, marked used in the same step. */
  takeTicket(value, kind) {
    if (typeof value !== 'string' || value.length === 0) return null;
    const row = this.tickets.get(sha256(value));
    if (!row || row.kind !== kind || row.used || this.now() >= row.expiresAt) return null;
    row.used = true;
    return row;
  }

  // -------------------------------------------------------------------------------------------
  // Sessions

  redeem(ctx) {
    if (!this.workspaceOrigins.has(ctx.origin)) refuse(403, 'origin.denied');
    const body = ctx.body;
    if (!isObject(body) || typeof body.ticket !== 'string' || !nonEmptyId(body.workspaceId)) {
      refuse(400, 'request.invalid', 'ticket and workspaceId are required.');
    }
    const ticket = this.takeTicket(body.ticket, 'connect');
    // Unknown, used, expired and another workspace's tickets get the same answer; the last is
    // used up too (agreed with Track E, 2026-11-14).
    if (!ticket || ticket.workspaceId !== body.workspaceId) refuse(401, 'ticket.invalid');
    if (!this.liveLink(ticket.linkId, ticket.company, ticket.workspaceId)) {
      refuse(403, 'link.revoked');
    }
    const user = this.userByName(ticket.user);
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const session = {
      user: user.name,
      company: ticket.company,
      linkId: ticket.linkId,
      workspaceId: ticket.workspaceId,
      language: ticket.language,
      expiresAt: Math.min(now + LIMITS.sessionIdleMs, now + LIMITS.sessionMaxMs),
      maxExpiresAt: now + LIMITS.sessionMaxMs,
      ended: false,
    };
    this.sessions.set(sha256(token), session);
    return new Reply(200, {
      token,
      expiresAt: iso(session.expiresAt),
      maxExpiresAt: iso(session.maxExpiresAt),
      linkId: session.linkId,
      company: session.company,
      companyName: COMPANIES[session.company].name,
      user: { id: user.id, displayName: user.displayName },
      language: session.language,
    });
  }

  /**
   * The live session for `X-Connect-Session` (else 401 `session.expired`) whose link is still
   * live (else 403 `link.revoked`): the ERP checks its link on every request.
   */
  session(ctx) {
    const token = ctx.req.headers['x-connect-session'];
    const session = typeof token === 'string' ? this.sessions.get(sha256(token)) : undefined;
    const now = this.now();
    if (!session || session.ended || now >= session.expiresAt || now >= session.maxExpiresAt) {
      refuse(401, 'session.expired');
    }
    ctx.language = session.language;
    if (!this.liveLink(session.linkId, session.company, session.workspaceId)) {
      refuse(403, 'link.revoked');
    }
    return { ...session, row: session, userInfo: this.userByName(session.user) };
  }

  renew(session) {
    const row = session.row;
    row.expiresAt = Math.min(this.now() + LIMITS.sessionIdleMs, row.maxExpiresAt);
    return new Reply(200, { expiresAt: iso(row.expiresAt) });
  }

  end(session) {
    session.row.ended = true;
    return new Reply(204, null);
  }

  // -------------------------------------------------------------------------------------------
  // Connectors

  /**
   * The connectors the user may view, of the kinds `?kinds=` names (Phase 12): without it, the
   * entities only, as before 0.12.0, so an older build is never shown a report. Kinds the ERP
   * does not know are left out of the list asked for.
   */
  connectors(ctx, session) {
    const user = session.userInfo;
    const asked = ctx.url.searchParams.get('kinds');
    const kinds = new Set(
      asked === null || asked.trim() === '' ? ['entity'] : asked.split(',').map((k) => k.trim()),
    );
    return new Reply(200, {
      connectors: [...CONNECTOR_IDS, ...REPORT_IDS]
        .map(connectorById)
        .filter((c) => kinds.has(c.kind) && this.canView(user, c))
        .map((c) => {
          const access = this.grant(user, c) ? 'edit' : 'view';
          return {
            id: c.id,
            kind: c.kind,
            label: c.label,
            schemaVersion: c.schemaVersion,
            access,
          };
        }),
    });
  }

  /**
   * The user's privilege to change `connector`'s records: `edit`, `advEdit` (Edit and AdvEdit),
   * or null. Only a connector with fields anyone may edit can be granted (Phase 7: Vendors;
   * Phase 10: Customers and Items on hand too).
   */
  grant(user, connector) {
    if (connector.maxCommitRecords === 0 || !connector.fields.some((f) => f.edit)) return null;
    return user.edit?.[connector.id] ?? null;
  }

  /** Whether `user` may change `field`, and why not (INTEGRATIONS.md, an editable schema). */
  fieldEdit(user, connector, field) {
    const grant = this.grant(user, connector);
    if (!field.edit) return { editable: false, editReason: 'notEditable' };
    if (!grant) return { editable: false, editReason: 'needsEdit' };
    if (field.edit === 'advEdit' && grant !== 'advEdit') {
      return { editable: false, editReason: 'needsAdvEdit' };
    }
    return { editable: true };
  }

  /** The connector named in the route (else 404), which the user may view (else 403). */
  connectorFor(session, id) {
    const connector = connectorById(id);
    if (!connector) refuse(404, 'connector.notFound');
    if (!this.canView(session.userInfo, connector)) refuse(403, 'privilege.denied');
    return connector;
  }

  schema(session, connector) {
    const user = session.userInfo;
    const fields = this.fieldsFor(user, connector).map((f) => {
      const out = {
        name: f.name,
        label: f.label,
        type: f.type,
        ...this.fieldEdit(user, connector, f),
      };
      for (const key of [
        'required',
        'maxLength',
        'min',
        'max',
        'scale',
        'lookup',
        'scope',
        'total',
      ]) {
        if (f[key] !== undefined) out[key] = f[key];
      }
      out.filterable = f.filterable;
      out.sortable = f.sortable;
      return out;
    });
    const lists = lookups(user.company);
    const parameters = connector.parameters ?? [];
    const used = Object.fromEntries(
      [...fields, ...parameters].filter((f) => f.lookup).map((f) => [f.lookup, lists[f.lookup]]),
    );
    return new Reply(200, {
      id: connector.id,
      // Phase 12: a report says so; an entity's schema is as before 0.12.0.
      ...(connector.kind === 'report' ? { kind: 'report' } : {}),
      schemaVersion: connector.schemaVersion,
      keyField: connector.keyField,
      idField: connector.idField,
      maxPageSize: connector.maxPageSize,
      maxRecords: connector.maxRecords,
      maxCommitRecords: connector.maxCommitRecords,
      fields,
      lookups: used,
      ...(connector.kind === 'report'
        ? {
            parameters: parameters.map((p) => ({
              name: p.name,
              label: p.label,
              type: p.type,
              required: p.required,
              ...(p.options ? { options: p.options } : {}),
              ...(p.lookup ? { lookup: p.lookup } : {}),
              default: p.default ?? null,
            })),
          }
        : {}),
    });
  }

  /** `text` folded as `OrdinalIgnoreCase` compares it, each text once (100,000 records). */
  folded(text) {
    let out = this.foldCache.get(text);
    if (out === undefined) {
      if (this.foldCache.size > 2_000_000) this.foldCache.clear();
      out = fold(text);
      this.foldCache.set(text, out);
    }
    return out;
  }

  /**
   * A report's parameters as the ERP reads them (Phase 12, INTEGRATIONS.md, "Reports"): each
   * absent (or null) one takes its default (a date's `today` and `monthStart` in the company's time
   * zone, now), and every wrong one is an error of its own, `field: "parameters.<name>"`.
   */
  reportParameters(ctx, user, connector, raw) {
    if (raw === undefined || raw === null) {
      refuse(400, 'request.invalid', 'A report takes parameters: {} for every default.');
    }
    if (!isObject(raw)) refuse(400, 'request.invalid', 'parameters must be an object.');
    const known = new Map(connector.parameters.map((p) => [p.name, p]));
    const errors = [];
    const wrong = (name, code) => errors.push({ field: `parameters.${name}`, code });
    for (const name of Object.keys(raw)) if (!known.has(name)) wrong(name, 'request.invalid');
    const { today, monthStart } = datesIn(COMPANIES[user.company].timeZone, this.now());
    const lists = lookups(user.company);
    const out = {};
    for (const p of connector.parameters) {
      let value = Object.hasOwn(raw, p.name) ? raw[p.name] : undefined;
      if (p.type === 'lookup' && value === '') value = null;
      if (value === undefined || value === null) {
        const fallback =
          p.default === 'today' && p.type === 'date'
            ? today
            : p.default === 'monthStart' && p.type === 'date'
              ? monthStart
              : (p.default ?? null);
        if (fallback === null && p.required) wrong(p.name, 'required');
        out[p.name] = fallback;
        continue;
      }
      let problem = null;
      if (p.type === 'date') {
        if (!isDate(value)) problem = 'type';
        else if (value < '1900-01-01' || value > '9999-12-31') problem = 'range';
      } else if (p.type === 'choice') {
        if (typeof value !== 'string' || !p.options.some((o) => o.value === value))
          problem = 'type';
      } else if (p.type === 'lookup') {
        if (typeof value !== 'string') problem = 'type';
        else {
          const item = (lists[p.lookup] ?? []).find((i) => i.code === value);
          if (!item || item.active === false) problem = 'lookup.notFound';
        }
      } else if (typeof value !== 'boolean') problem = 'type';
      if (problem) wrong(p.name, problem);
      out[p.name] = value;
    }
    // A period whose start is after its end.
    const failed = new Set(errors.map((e) => e.field));
    for (const p of connector.parameters) {
      if (p.type !== 'date' || !p.after) continue;
      const from = out[p.after];
      if (failed.has(`parameters.${p.name}`) || failed.has(`parameters.${p.after}`)) continue;
      if (from !== null && out[p.name] !== null && out[p.name] < from) wrong(p.name, 'range');
    }
    if (errors.length) {
      const table = TEXT[ctx.language] ?? TEXT.en;
      return new Reply(400, {
        message: table['request.invalid'],
        correlationId: ctx.correlationId,
        errors: errors.map((e) => ({ ...e, message: table[e.code] ?? e.code })),
      });
    }
    return out;
  }

  /**
   * The rows a query runs over, flat (`{id, company, ...values}`), in the connector's own order:
   * an entity's the user may see, or a report's computed for its parameters (with its labels and
   * whether a limit cut it).
   */
  sourceRows(user, connector, params) {
    if (connector.kind !== 'report') {
      // An entity's rows in their own order, made once a write.
      const key = `${this.dataVersion}|${connector.id}|${user.name}`;
      if (this.ownRows?.key !== key) {
        const own = OWN_ORDER[connector.id];
        const rows = this.rowsFor(user, connector)
          .map((row) => ({ row, own: own.map((part) => ownKeyOf(part, row[part.field] ?? null)) }))
          .sort((a, b) => compareEntries(a, b, [], own))
          .map((e) => e.row);
        this.ownRows = { key, rows, keys: new Map(), texts: new Map() };
      }
      return { rows: this.ownRows.rows, keys: this.ownRows.keys, texts: this.ownRows.texts };
    }
    const made = runReport(connector.id, {
      ledgers: this.ledgers,
      records: this.records,
      company: user.company,
      params,
      limits: this.reportLimits,
    });
    return {
      rows: made.rows.map((r) => ({ id: r.id, company: user.company, ...r.values })),
      labels: made.labels,
      partial: made.partial,
    };
  }

  /**
   * Every match of a query, prepared and in order: searched, matched and sorted by 0.10.0's rules
   * (rules.mjs), ties in the connector's own order. Kept until the next write, so a query's later
   * pages, as a sort of 100,000 records, are read from it.
   */
  matches(user, connector, fields, q, params) {
    const key = canonical({
      v: this.dataVersion,
      c: connector.id,
      u: user.name,
      s: q.search ?? null,
      e: q.equals,
      o: q.sort,
      p: params,
    });
    const cached = this.queryCache.get(key);
    if (cached) {
      this.queryCache.delete(key);
      this.queryCache.set(key, cached);
      return cached;
    }
    const byName = new Map(fields.map((f) => [f.name, f]));
    const source = this.sourceRows(user, connector, params);
    const search = q.search === undefined ? null : this.folded(q.search);
    // What the ERP's own list searches, of the fields this user sees (the customer list searches
    // the national ID only where it shows it), and what it searches that is never sent.
    const searched = [
      ...fields.filter((f) => f.search).map((f) => f.name),
      ...(connector.searchAlso ?? []),
    ];
    const equals = Object.entries(q.equals);
    const sortTypes = q.sort.map((k) => byName.get(k.field).type);
    const folder = (text) => this.folded(text);
    // An entity's sort keys by field, made once a write for every query sorting by it.
    const keysOf = (field, type) => {
      if (!source.keys) return null;
      let keys = source.keys.get(field);
      if (!keys) {
        keys = source.rows.map((row) => sortKeyOf(type, row[field] ?? null, folder));
        source.keys.set(field, keys);
      }
      return keys;
    };
    const sortKeys = q.sort.map((k, i) => keysOf(k.field, sortTypes[i]));
    // Each row's searched texts, folded, made once a write for every search.
    let texts = null;
    if (search !== null && source.texts) {
      const named = searched.join(',');
      texts = source.texts.get(named);
      if (!texts) {
        texts = source.rows.map((row) =>
          searched
            .map((name) => row[name])
            .filter((value) => typeof value === 'string')
            .map((value) => this.folded(value)),
        );
        source.texts.set(named, texts);
      }
    }
    const list = [];
    // The source is in the connector's own order: a row's place in it (`rank`) breaks ties, as
    // its own order would (`compareEntries` with own keys, which a cursor's position uses).
    source.rows.forEach((row, rank) => {
      if (
        search !== null &&
        !(texts
          ? texts[rank].some((text) => text.includes(search))
          : searched.some((name) => {
              const value = row[name];
              return typeof value === 'string' && this.folded(value).includes(search);
            }))
      )
        return;
      if (
        !equals.every(([name, value]) => sameWire(byName.get(name).type, row[name] ?? null, value))
      )
        return;
      list.push({
        row,
        rank,
        sort: q.sort.map(
          (k, i) => sortKeys[i]?.[rank] ?? sortKeyOf(sortTypes[i], row[k.field] ?? null, folder),
        ),
      });
    });
    const directions = q.sort.map((k) => (k.direction === 'desc' ? -1 : 1));
    list.sort((a, b) => {
      for (let i = 0; i < directions.length; i++) {
        const order = compareKeys(a.sort[i], b.sort[i]);
        if (order !== 0) return order * directions[i];
      }
      return a.rank - b.rank;
    });
    const made = { list, labels: source.labels, partial: source.partial };
    this.queryCache.set(key, made);
    while (this.queryCache.size > 6) this.queryCache.delete(this.queryCache.keys().next().value);
    return made;
  }

  query(ctx, session, connector) {
    const user = session.userInfo;
    const fields = this.fieldsFor(user, connector);
    const byName = new Map(fields.map((f) => [f.name, f]));
    const q = readQuery(ctx.body, connector, byName);
    let params = null;
    if (connector.kind === 'report') {
      params = this.reportParameters(ctx, user, connector, q.parameters);
      if (params instanceof Reply) return params;
    }
    const { list, labels, partial } = this.matches(user, connector, fields, q, params);
    const own = OWN_ORDER[connector.id];

    // The cursor is a keyset (the last record's sort values and own order), bound to its query's
    // filter, sort, fields and a report's parameters (agreed with Track E; Phase 12): a record
    // written between two pages neither repeats nor pushes another off a page, and another
    // query's cursor is refused. It counts what was read, so a query reads at most `maxRecords`.
    const hash = sha256(
      canonical({
        k: this.cursorKey,
        connector: connector.id,
        search: q.search ?? null,
        equals: q.equals,
        sort: q.sort,
        fields: q.fields,
        parameters: params,
      }),
    ).slice(0, 24);
    let start = 0;
    let read = 0;
    if (q.cursor !== null) {
      const at = readCursor(q.cursor);
      if (!at || at.q !== hash)
        refuse(400, 'request.invalid', 'The cursor is not one of this query’s.');
      if (at.n >= connector.maxRecords) {
        refuse(400, 'request.invalid', `A query reads at most ${connector.maxRecords} records.`);
      }
      read = at.n;
      const last = {
        sort: q.sort.map((k, i) => sortKeyOf(byName.get(k.field).type, at.s[i] ?? null)),
        own: own.map((part, i) => ownKeyOf(part, at.o[i] ?? null)),
      };
      // The first record after the last one read, in the query's order.
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const entry = list[mid];
        const at = {
          sort: entry.sort,
          own: own.map((part) => ownKeyOf(part, entry.row[part.field] ?? null)),
        };
        if (compareEntries(at, last, q.sort, own) <= 0) lo = mid + 1;
        else hi = mid;
      }
      start = lo;
    }
    const take = Math.min(q.pageSize, connector.maxRecords - read);
    const page = list.slice(start, start + take);
    const more = start + page.length < list.length && read + page.length < connector.maxRecords;
    const lastRow = page.at(-1)?.row;
    const names = q.fields ?? fields.map((f) => f.name);
    // A version is of every field the user sees, whichever the query asked for.
    const seen = fields.map((f) => f.name);
    const keyOf = (row) => String(row[connector.keyField]);
    const answer = {
      records: page.map(({ row }) => ({
        id: row.id,
        key: keyOf(row),
        version: this.versionOf(connector, row, seen),
        values: Object.fromEntries(names.map((name) => [name, row[name] ?? null])),
      })),
      nextCursor:
        more && lastRow
          ? writeCursor({
              q: hash,
              n: read + page.length,
              s: q.sort.map((k) => lastRow[k.field] ?? null),
              o: own.map((part) => lastRow[part.field] ?? null),
            })
          : null,
      total: list.length,
    };
    if (connector.kind === 'report') {
      // Each summed field of the answer's over every match, whatever the cursor.
      const totals = {};
      for (const name of names) {
        const f = byName.get(name);
        if (f.total !== 'sum') continue;
        let sum = 0n;
        for (const { row } of list) {
          const value = row[name];
          if (value === null || value === undefined) continue;
          sum += f.type === 'integer' ? BigInt(value) : toUnits(value, f.scale);
        }
        totals[name] = f.type === 'integer' ? Number(sum) : decimalOf(sum, f.scale);
      }
      answer.totals = totals;
      if (labels) answer.labels = labels;
      if (partial) answer.partial = true;
    }
    return new Reply(200, answer);
  }

  // -------------------------------------------------------------------------------------------
  // Commit (Phase 7, INTEGRATIONS.md, "`Commit` and `CommitStatus`"): every check in the
  // contract's order, the first that fails answering, and nothing written unless all pass.
  // Phase 10 ("Customers and Items on hand editable"): the same path for Customers and Items on
  // hand, with versions made from the values the user sees, the customer list's ownership rule,
  // and an item's shared name and group written once for every row of the item.

  commit(ctx, session, connector) {
    const user = session.userInfo;
    const grant = this.grant(user, connector);
    // 3. The connector's Edit privilege, dry runs included.
    if (!grant) refuse(403, 'privilege.denied');
    // 4. The request's shape.
    const body = ctx.body;
    const no = (why) => refuse(400, 'request.invalid', why);
    if (!isObject(body)) no('A JSON body is required.');
    if (typeof body.commitId !== 'string' || !UUID.test(body.commitId)) {
      no('commitId must be a UUID.');
    }
    if (typeof body.schemaVersion !== 'string' || body.schemaVersion === '') {
      no('schemaVersion is required.');
    }
    if (typeof body.dryRun !== 'boolean') no('dryRun must be true or false.');
    const source = body.source;
    if (
      !isObject(source) ||
      source.workspaceId !== session.workspaceId ||
      typeof source.pageId !== 'string' ||
      !UUID.test(source.pageId) ||
      !(
        source.blockId === null ||
        (typeof source.blockId === 'string' && BLOCK.test(source.blockId))
      )
    ) {
      no('source must name this session’s workspace, a page and a block.');
    }
    if (!Array.isArray(body.records) || body.records.length === 0) no('records must list one.');
    const seen = new Set();
    for (const record of body.records) {
      if (
        !isObject(record) ||
        typeof record.id !== 'string' ||
        record.id === '' ||
        typeof record.key !== 'string' ||
        typeof record.version !== 'string' ||
        !isObject(record.changes) ||
        Object.keys(record.changes).length === 0
      ) {
        no('Each record has an id, a key, a version and changes.');
      }
      if (seen.has(record.id)) no('A record is listed twice.');
      seen.add(record.id);
      for (const change of Object.values(record.changes)) {
        if (!isObject(change) || !('to' in change) || !isWire(change.to)) {
          no('Each change has a `to`.');
        }
        if ('from' in change && !isWire(change.from)) no('`from` is a value.');
      }
    }
    // 4, Phase 10: the records of one key carry the same `to` for each shared field they change.
    const mismatched = sharedMismatches(connector, body.records);
    if (mismatched.length) {
      const table = TEXT[ctx.language] ?? TEXT.en;
      return new Reply(400, {
        message: table['request.invalid'],
        correlationId: ctx.correlationId,
        errors: mismatched.map((e) => ({ ...e, code: 'request.invalid', message: table.shared })),
      });
    }
    // 5. Size.
    if (body.records.length > connector.maxCommitRecords) refuse(413, 'batch.tooLarge');
    // 6. A commit already stored under this id.
    const key = `${session.company}|${body.commitId.toLowerCase()}`;
    const hash = sha256(
      canonical({
        schemaVersion: body.schemaVersion,
        source,
        records: [...body.records]
          .map((r) => ({
            id: r.id,
            key: r.key,
            version: r.version,
            changes: Object.fromEntries(
              Object.entries(r.changes).map(([f, c]) => [f, { from: c.from ?? null, to: c.to }]),
            ),
          }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      }),
    );
    if (!body.dryRun && this.commits.has(key)) {
      const stored = this.commits.get(key);
      if (stored.hash === hash) return new Reply(200, stored.body);
      refuse(400, 'commit.reused');
    }
    // 7. The schema.
    if (body.schemaVersion !== connector.schemaVersion) refuse(400, 'schema.changed');
    // 8. Every record and field, every error listed. A record the user may not see (another's
    // customer under the ownership rule), or not of the key it was sent with, is not found.
    const visible = new Map(this.fieldsFor(user, connector).map((f) => [f.name, f]));
    const rows = this.rowsFor(user, connector);
    const lists = lookups(user.company);
    const keyOf = (row) => String(row[connector.keyField]);
    const errors = [];
    const found = [];
    for (const record of body.records) {
      const at = { id: record.id, key: record.key };
      const row = rows.find((r) => r.id === record.id);
      if (!row || keyOf(row) !== record.key) {
        errors.push({ ...at, code: 'record.notFound' });
        continue;
      }
      if (record.version === '') {
        errors.push({ ...at, code: 'version.missing' });
        continue;
      }
      if (row.locked) {
        errors.push({ ...at, code: 'record.locked' });
        continue;
      }
      found.push({ record, row });
      for (const [name, change] of Object.entries(record.changes)) {
        const field = visible.get(name);
        const problem = field
          ? this.changeProblem(user, connector, field, change.to, lists)
          : 'field.readOnly';
        if (problem) errors.push({ ...at, field: name, code: problem });
      }
    }
    if (errors.length) {
      const table = TEXT[ctx.language] ?? TEXT.en;
      return new Reply(400, {
        message: table.commit,
        correlationId: ctx.correlationId,
        errors: errors.map((e) => ({ ...e, message: table[e.code] ?? e.code })),
      });
    }
    // 9. Versions, every conflict listed: Vendors' rowversion, or the values the user sees read
    // again now (a stock movement on an item's row is a conflict whose `fields` may be empty).
    const names = [...visible.keys()];
    const valuesOf = (row) => Object.fromEntries(names.map((n) => [n, row[n] ?? null]));
    const versionOf = (row) => this.versionOf(connector, row, names);
    const conflicts = found
      .filter(({ record, row }) => record.version !== versionOf(row))
      .map(({ record, row }) => ({
        id: row.id,
        key: keyOf(row),
        version: versionOf(row),
        values: valuesOf(row),
        fields: Object.entries(record.changes)
          .filter(([name, change]) => blank(row[name]) !== blank(change.from))
          .map(([name]) => name),
        modifiedBy: connector.stamps === false ? null : (row.modifiedBy ?? null),
        modifiedAt: connector.stamps === false ? null : (row.modifiedDate ?? null),
      }));
    if (conflicts.length) {
      const table = TEXT[ctx.language] ?? TEXT.en;
      return new Reply(409, {
        message: table.conflict,
        correlationId: ctx.correlationId,
        conflicts,
      });
    }
    // 10. Written in one step, with the modified stamps, the audit and the stored commit. A shared
    // field (an item's name and group, in InvTable) is written once a key, so every row of that
    // key changes with it, and the answer holds each of them the user may see.
    const now = this.now();
    const at = iso(now);
    const all = this.records[connector.id];
    const shared = new Set(connector.fields.filter((f) => f.scope === 'key').map((f) => f.name));
    /** Each row touched, by id: its original and its next state. */
    const touched = new Map();
    const touch = (row) => {
      let entry = touched.get(row.id);
      if (!entry) touched.set(row.id, (entry = { row, next: { ...row } }));
      return entry.next;
    };
    /** Per key, its shared fields' new values and the first record that changes each. */
    const keyed = new Map();
    for (const { record, row } of found) {
      const next = touch(row);
      for (const [name, change] of Object.entries(record.changes)) {
        const field = visible.get(name);
        const to =
          (field.type === 'text' || field.type === 'lookup') && change.to === '' ? null : change.to;
        next[name] = to;
        if (!shared.has(name)) continue;
        const of = keyed.get(keyOf(row)) ?? new Map();
        if (!of.has(name)) of.set(name, { to, row });
        keyed.set(keyOf(row), of);
      }
      if (!body.dryRun) {
        if (connector.versions === 'rowversion') next.version = this.nextVersion();
        if (connector.stamps !== false) {
          next.modifiedBy = user.displayName;
          next.modifiedDate = at;
        }
      }
    }
    for (const row of all) {
      if (row.company !== session.company) continue;
      const of = keyed.get(keyOf(row));
      if (!of) continue;
      const next = touch(row);
      for (const [name, { to }] of of) next[name] = to;
    }
    const sent = new Set(found.map(({ row }) => row.id));
    const answered = [
      ...found.map(({ row }) => touched.get(row.id)),
      // The other rows of a changed key that this user may see, in the connector's order.
      ...rows
        .filter((row) => !sent.has(row.id) && touched.has(row.id))
        .map((r) => touched.get(r.id)),
    ];
    const response = {
      commitId: body.commitId,
      dryRun: body.dryRun,
      committedAt: body.dryRun ? null : at,
      records: answered.map(({ row, next }) => ({
        id: next.id,
        key: keyOf(next),
        // A dry run writes nothing: each version is as it is now.
        version: body.dryRun ? versionOf(row) : versionOf(next),
        values: valuesOf(next),
      })),
    };
    if (body.dryRun) return new Reply(200, response);
    for (const { row, next } of touched.values()) all[all.indexOf(row)] = next;
    this.dataVersion++;
    const audit = (row, name, before, after) =>
      this.audit.push({
        company: session.company,
        connector: connector.id,
        recordId: row.id,
        key: keyOf(row),
        field: name,
        before,
        after,
        user: user.id,
        at,
        commitId: body.commitId.toLowerCase(),
        audience: 'workspace',
        workspaceId: source.workspaceId,
        pageId: source.pageId,
        blockId: source.blockId,
      });
    for (const { record, row } of found) {
      const next = touched.get(row.id).next;
      for (const name of Object.keys(record.changes)) {
        // A shared field's one row per key is the first record's that changes it.
        if (shared.has(name)) continue;
        audit(row, name, row[name] ?? null, next[name] ?? null);
      }
    }
    for (const of of keyed.values()) {
      for (const [name, { to, row }] of of) audit(row, name, row[name] ?? null, to ?? null);
    }
    this.commits.set(key, { hash, body: response });
    return new Reply(200, response);
  }

  /** What is wrong with a change to `field` for `user`, as the ERP checks it, or null. */
  changeProblem(user, connector, field, value, lists) {
    const edit = this.fieldEdit(user, connector, field);
    if (!edit.editable)
      return edit.editReason === 'needsAdvEdit' ? 'privilege.denied' : 'field.readOnly';
    const empty = value === null || value === '';
    if (empty) return field.required ? 'required' : null;
    if (valueProblem(field, value)) return 'type';
    if (field.type === 'decimal') {
      const digits = DECIMAL.exec(value)?.[3]?.length ?? 0;
      if (digits > (field.scale ?? 0)) return 'scale';
      if (field.min !== undefined && compareDecimal(value, field.min) < 0) return 'range';
      if (field.max !== undefined && compareDecimal(value, field.max) > 0) return 'range';
    }
    if (field.type === 'integer') {
      if (field.min !== undefined && value < field.min) return 'range';
      if (field.max !== undefined && value > field.max) return 'range';
    }
    if (
      field.maxLength !== undefined &&
      typeof value === 'string' &&
      value.length > field.maxLength
    ) {
      return 'maxLength';
    }
    if (field.type === 'lookup') {
      const item = (lists[field.lookup] ?? []).find((i) => i.code === value);
      if (!item || item.active === false) return 'lookup.notFound';
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // /__mock/*: test controls

  control(ctx) {
    const route = ctx.lower.slice('__mock/'.length);
    const body = isObject(ctx.body) ? ctx.body : {};
    const ok = (value) => new Reply(value === undefined ? 204 : 200, value ?? null);
    const bad = (why) =>
      new Reply(400, { message: why, correlationId: ctx.correlationId, errors: [] });
    const attempt = (make) => {
      try {
        return ok(make());
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        return this.fail(ctx, error.status, error.code, error.why);
      }
    };
    switch (route) {
      case 'reset':
        // For Phase 7's review bench: `kitVendors`, more of Kit's vendors than the seed's 150;
        // `locks: false`, no record locked (every change of 500 valid). Phase 10's:
        // `kitCustomers`, more of Kit's customers than the seed's 240.
        this.reset({
          ...(Number.isInteger(body.kitVendors) && body.kitVendors >= 7 && body.kitVendors <= 5000
            ? { kitVendors: body.kitVendors }
            : {}),
          ...(Number.isInteger(body.kitCustomers) &&
          body.kitCustomers >= 6 &&
          body.kitCustomers <= 5000
            ? { kitCustomers: body.kitCustomers }
            : {}),
          ...(body.locks === false ? { locks: false } : {}),
          // Phase 12: Kit's records of every connector by the large seed's rule (large.mjs).
          ...(body.large === true ? { large: true } : {}),
        });
        return ok();
      case 'clock':
        if (Number.isFinite(body.advanceMs)) this.offsetMs += body.advanceMs;
        if (typeof body.set === 'string') this.offsetMs = Date.parse(body.set) - Date.now();
        return ok({ now: iso(this.now()) });
      case 'fault': {
        if (body.clear === true) {
          this.faults = [];
          return ok();
        }
        if (typeof body.match !== 'string' || body.match.length === 0) {
          return bad('match is required.');
        }
        let pattern;
        try {
          pattern = new RegExp(body.match, 'i');
        } catch {
          return bad('match must be a regular expression.');
        }
        const times = Number.isSafeInteger(body.times) && body.times >= 0 ? body.times : 1;
        this.faults.push({ ...body, pattern, times });
        return ok();
      }
      case 'connect-ticket': {
        const user = this.userByName(body.user);
        if (!user) return bad('Unknown user.');
        return attempt(() => ({ ticket: this.connectTicketFor(user, body) }));
      }
      case 'link-ticket': {
        const user = this.userByName(body.user);
        if (!user) return bad('Unknown user.');
        if (!user.admin) return this.fail(ctx, 403, 'privilege.denied');
        const ticket = this.makeTicket({ kind: 'link', user: user.name, company: user.company });
        return ok({ ticket, url: `${this.workspaceUrl}/#/erp-link/${ticket}` });
      }
      case 'revoke-link': {
        const link = typeof body.linkId === 'string' ? this.links.get(body.linkId) : undefined;
        if (!link) return bad('Unknown link.');
        link.revokedAt ??= iso(this.now());
        return ok();
      }
      case 'workspace': {
        if (!Object.hasOwn(COMPANIES, body.company) || typeof body.enabled !== 'boolean') {
          return bad('company and enabled are required.');
        }
        if (body.enabled) this.workspaceOff.delete(body.company);
        else this.workspaceOff.add(body.company);
        return ok();
      }
      case 'limits': {
        for (const name of ['ticketsPerMinute', 'sessionPerMinute']) {
          if (!(name in body)) continue;
          const value = body[name];
          if (value !== null && !(Number.isSafeInteger(value) && value >= 0)) {
            return bad(`${name} must be a whole number or null.`);
          }
          this.limits[name] = value;
        }
        this.windows.clear();
        return ok({ ...this.limits });
      }
      case 'state':
        return ok(this.state());
      case 'edit-record': {
        // Another ERP user changes a record behind the page's back: new values, so a new version,
        // and new stamps where the table has them. Phase 10: `id` names one of a key's records
        // (an item's stock at one place: a posting moves its quantity); a shared field (the
        // item's name or group) changes on every record of its key, as InvTable holds it once.
        const connector = Object.hasOwn(CONNECTORS, body.connector)
          ? CONNECTORS[body.connector]
          : undefined;
        if (!connector || !Object.hasOwn(COMPANIES, body.company) || !isObject(body.values)) {
          return bad('connector, company, key or id, and values are required.');
        }
        const table = this.records[connector.id];
        const target = table.find(
          (row) =>
            row.company === body.company &&
            (typeof body.id === 'string'
              ? row.id === body.id
              : String(row[connector.keyField]) === body.key),
        );
        if (!target) return bad('No such record.');
        const names = new Set(connector.fields.map((f) => f.name));
        for (const name of Object.keys(body.values)) {
          if (!names.has(name)) return bad(`No field ${name}.`);
        }
        const shared = new Set(
          connector.fields.filter((f) => f.scope === 'key').map((f) => f.name),
        );
        const sharedValues = Object.fromEntries(
          Object.entries(body.values).filter(([name]) => shared.has(name)),
        );
        const key = String(target[connector.keyField]);
        let edited = target;
        for (let i = 0; i < table.length; i++) {
          const row = table[i];
          if (row === target) {
            edited = table[i] = {
              ...row,
              ...body.values,
              ...(connector.versions === 'rowversion' ? { version: this.nextVersion() } : {}),
              ...(connector.stamps === false
                ? {}
                : {
                    modifiedBy: typeof body.by === 'string' ? body.by : 'Another ERP user',
                    modifiedDate: iso(this.now()),
                  }),
            };
          } else if (
            row.company === body.company &&
            String(row[connector.keyField]) === key &&
            Object.keys(sharedValues).length
          ) {
            table[i] = { ...row, ...sharedValues };
          }
        }
        this.dataVersion++;
        return ok({
          id: edited.id,
          version: this.versionOf(connector, edited, [...names]),
        });
      }
      case 'audit':
        return ok({ audit: this.audit, commits: this.commits.size });
      case 'cursor': {
        // Phase 12: a cursor of the mock's own moved to `read` records, so a test can send one
        // past `maxRecords`, which the mock never gives.
        const at = typeof body.cursor === 'string' ? readCursor(body.cursor) : null;
        if (!at || !Number.isSafeInteger(body.read) || body.read < 0) {
          return bad('cursor (one the mock gave) and read are required.');
        }
        return ok({ cursor: writeCursor({ ...at, n: body.read }) });
      }
      case 'add-record': {
        // Phase 12: a record written in the ERP between two pages of a query (a new vendor,
        // customer or item's place), with the given values over an existing record's.
        const connector = Object.hasOwn(CONNECTORS, body.connector)
          ? CONNECTORS[body.connector]
          : undefined;
        if (!connector || !Object.hasOwn(COMPANIES, body.company) || !isObject(body.values)) {
          return bad('connector, company and values are required.');
        }
        const table = this.records[connector.id];
        const like = table.find((row) => row.company === body.company);
        if (!like) return bad('The company has no record to start from.');
        const row = { ...like, ...body.values, company: body.company };
        if (connector.id === 'itemsOnHand') {
          row.id = [row.itemId, row.siteId ?? '', row.warehouseId ?? '', row.locationId ?? ''].join(
            '|',
          );
        } else {
          const top = table.reduce((max, r) => Math.max(max, Number(r.id)), 0);
          row.id = String(top + 1);
          row[connector.idField] = row.id;
        }
        if (connector.versions === 'rowversion') row.version = this.nextVersion();
        if (table.some((r) => r.company === row.company && r.id === row.id)) {
          return bad('A record with that id exists.');
        }
        table.push(row);
        this.dataVersion++;
        return ok({ id: row.id, key: String(row[connector.keyField]) });
      }
      case 'report-limits':
        // Phase 12: the stock report's cap on places (200,000 at the ERP), to make it partial.
        if ('stockPlaces' in body) {
          if (!Number.isSafeInteger(body.stockPlaces) || body.stockPlaces < 0) {
            return bad('stockPlaces must be a whole number.');
          }
          this.reportLimits.stockPlaces = body.stockPlaces;
          this.dataVersion++;
        }
        return ok({ ...this.reportLimits });
      default:
        return new Reply(404, {
          message: 'Not found.',
          correlationId: ctx.correlationId,
          errors: [],
        });
    }
  }

  /** What the mock holds, for tests: every record, the sessions and links; never a token. */
  state() {
    const records = {};
    for (const id of CONNECTOR_IDS) {
      const connector = CONNECTORS[id];
      records[id] = this.records[id].map((row) => ({
        company: row.company,
        id: row.id,
        key: String(row[connector.keyField]),
        values: Object.fromEntries(connector.fields.map((f) => [f.name, row[f.name] ?? null])),
      }));
    }
    const now = this.now();
    return {
      now: iso(now),
      records,
      markers: MARKERS,
      sessions: [...this.sessions.values()].map((s) => ({
        user: s.user,
        company: s.company,
        linkId: s.linkId,
        workspaceId: s.workspaceId,
        language: s.language,
        expiresAt: iso(s.expiresAt),
        maxExpiresAt: iso(s.maxExpiresAt),
        ended: s.ended,
        live:
          !s.ended &&
          now < s.expiresAt &&
          now < s.maxExpiresAt &&
          this.liveLink(s.linkId, s.company, s.workspaceId) !== null,
      })),
      links: [...this.links.values()].map((l) => ({
        ...l,
        companyName: COMPANIES[l.company].name,
      })),
      tickets: {
        link: [...this.tickets.values()].filter((t) => t.kind === 'link').length,
        connect: [...this.tickets.values()].filter((t) => t.kind === 'connect').length,
      },
      workspaceOff: [...this.workspaceOff],
      limits: { ...this.limits },
    };
  }
}

function nonEmptyId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 100;
}

/**
 * Phase 10's addition to check 4: each record of a key that changes a shared field (`scope:
 * 'key'`), when the records of that key give it different values; `id`, `key` and `field` of each.
 */
function sharedMismatches(connector, records) {
  const errors = [];
  for (const { name } of connector.fields.filter((f) => f.scope === 'key')) {
    const byKey = new Map();
    for (const record of records) {
      if (!Object.hasOwn(record.changes, name)) continue;
      byKey.set(record.key, [...(byKey.get(record.key) ?? []), record]);
    }
    for (const list of byKey.values()) {
      const first = blank(list[0].changes[name].to);
      if (list.every((r) => blank(r.changes[name].to) === first)) continue;
      for (const r of list) errors.push({ id: r.id, key: r.key, field: name });
    }
  }
  return errors;
}

/** A query's body, checked as the ERP checks it: anything wrong is 400 `request.invalid`. */
function readQuery(body, connector, byName) {
  const no = (why) => refuse(400, 'request.invalid', why);
  if (!isObject(body)) no('A JSON body is required.');
  const filter = body.filter;
  if (!isObject(filter)) no('filter must be an object.');
  for (const key of Object.keys(filter)) {
    if (key !== 'search' && key !== 'equals') no(`filter cannot have ${key}.`);
  }
  // Phase 12: as 0.10.0's ConnectorQuery reads them. The search is trimmed as .NET trims, then at
  // most 200 characters; nothing left is no search.
  let search;
  if (filter.search !== undefined && filter.search !== null) {
    if (typeof filter.search !== 'string') no('filter.search must be text.');
    const trimmed = trimNet(filter.search);
    if (trimmed.length > 200) no('filter.search must be at most 200 characters.');
    search = trimmed === '' ? undefined : trimmed;
  }
  const equals = {};
  if (filter.equals !== undefined && filter.equals !== null) {
    if (!isObject(filter.equals)) no('filter.equals must be an object.');
    for (const [name, value] of Object.entries(filter.equals)) {
      const field = byName.get(name);
      if (!field || !field.filterable) no(`filter.equals cannot use ${name}.`);
      const problem = filterProblem(field, value);
      if (problem) no(`filter.equals.${name} must be ${problem}.`);
      equals[name] = value;
    }
  }
  // An entity takes no parameters (an empty object is none, as 0.10.0 reads it); a report's are
  // read with its schema (`reportParameters`).
  if (
    connector.kind !== 'report' &&
    body.parameters !== undefined &&
    body.parameters !== null &&
    !(isObject(body.parameters) && Object.keys(body.parameters).length === 0)
  ) {
    no('Only reports take parameters.');
  }
  let fields = null;
  if (body.fields !== undefined && body.fields !== null) {
    if (!Array.isArray(body.fields) || body.fields.length === 0) {
      no('fields must list at least one field.');
    }
    for (const name of body.fields) {
      if (typeof name !== 'string' || !byName.has(name)) no(`fields cannot name ${String(name)}.`);
    }
    if (new Set(body.fields).size !== body.fields.length) no('fields names a field twice.');
    fields = body.fields;
  }
  let sort = [];
  if (body.sort !== undefined && body.sort !== null) {
    if (!Array.isArray(body.sort) || body.sort.length > LIMITS.maxSort) {
      no(`sort must list at most ${LIMITS.maxSort} fields.`);
    }
    for (const key of body.sort) {
      if (!isObject(key) || !byName.get(key.field)?.sortable) no('sort names a field it cannot.');
      if (key.direction !== 'asc' && key.direction !== 'desc') no('direction is asc or desc.');
    }
    if (new Set(body.sort.map((k) => k.field)).size !== body.sort.length) {
      no('sort names a field twice.');
    }
    sort = body.sort.map((k) => ({ field: k.field, direction: k.direction }));
  }
  if (!('cursor' in body) || (body.cursor !== null && typeof body.cursor !== 'string')) {
    no('cursor must be null or the last answer’s.');
  }
  if (
    !Number.isSafeInteger(body.pageSize) ||
    body.pageSize < 1 ||
    body.pageSize > connector.maxPageSize
  ) {
    no(`pageSize must be 1 to ${connector.maxPageSize}.`);
  }
  return {
    search,
    equals,
    fields,
    sort,
    cursor: body.cursor,
    pageSize: body.pageSize,
    parameters: body.parameters,
  };
}

/**
 * Why an `equals` value cannot be compared with a field's values, as 0.10.0 checks it, or null: a
 * boolean, a whole number, a decimal as a number or text, or text for the rest; null (and "")
 * match an empty value.
 */
function filterProblem(field, value) {
  if (value === null) return null;
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'true, false or null';
    case 'integer':
      return Number.isSafeInteger(value) ? null : 'a whole number or null';
    case 'decimal':
      return (typeof value === 'number' && Number.isFinite(value)) ||
        value === '' ||
        isDecimalText(value)
        ? null
        : 'a number, a decimal in text, or null';
    default:
      return typeof value === 'string' ? null : 'text or null';
  }
}

/** A cursor's parts, or null for anything that is not one the mock wrote. */
function readCursor(cursor) {
  let read;
  try {
    read = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    !isObject(read) ||
    typeof read.q !== 'string' ||
    !Number.isSafeInteger(read.n) ||
    read.n < 0 ||
    !Array.isArray(read.s) ||
    !Array.isArray(read.o)
  )
    return null;
  return read;
}

const writeCursor = (parts) => Buffer.from(JSON.stringify(parts)).toString('base64url');

function readBody(req) {
  return new Promise((done, failed) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        failed(Object.assign(new Error('The request is too large.'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return done(undefined);
      try {
        done(JSON.parse(raw));
      } catch {
        failed(new Error('The body is not JSON.'));
      }
    });
    req.on('error', failed);
  });
}

function send(res, reply) {
  if (res.destroyed) return;
  for (const [name, value] of Object.entries(reply.headers)) res.setHeader(name, value);
  if (reply.body === null || reply.status === 204) {
    res.writeHead(reply.status).end();
    return;
  }
  const json = JSON.stringify(reply.body);
  res.writeHead(reply.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

// ---------------------------------------------------------------------------------------------
// The ERP client's pages

const PAGE_STYLE = `
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #1d232b; }
  main { max-width: 30rem; margin: 3rem auto; padding: 1.5rem; background: #fff;
         border: 1px solid #d9dde3; border-radius: 8px; }
  h1 { font-size: 1.2rem; margin: 0 0 1rem; }
  label { display: block; margin: .75rem 0 .25rem; }
  select, button { font: inherit; padding: .35rem .6rem; }
  button { margin-top: 1rem; }
  #status { margin-top: 1rem; min-height: 1.5em; }
  #status[data-state="error"] { color: #b42318; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  td, th { text-align: start; padding: .25rem; border-bottom: 1px solid #eee; font-size: .9rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #15181d; color: #e6e9ee; }
    main { background: #1d2127; border-color: #333a44; }
  }`;

function page(title, config, bodyHtml, script) {
  // The configuration goes into a script, so `<` is escaped to keep it there.
  const data = JSON.stringify(config).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
${bodyHtml}
</main>
<script>
const CONFIG = ${data};
${script}
</script>
</body>
</html>`;
}

const userOptions = (names) =>
  names
    .map(
      (name) =>
        `<option value="${name}">${name} (${USERS[name].displayName}, ${USERS[name].company})</option>`,
    )
    .join('');

function connectPage(apiUrl, origins) {
  const users = Object.fromEntries(Object.entries(USERS).map(([name, u]) => [name, u.key]));
  return page(
    'Connect Cash Gear Workspace',
    { api: apiUrl, users, origins },
    `<h1>Connect Cash Gear Workspace</h1>
<p>Cash Gear Workspace asks to show ERP data to you, as yourself. You are signed in to the mock ERP as:</p>
<label for="user">User</label>
<select id="user">${userOptions(Object.keys(USERS))}</select>
<label for="language">Language</label>
<select id="language"><option value="en">English</option><option value="ar">العربية</option></select>
<p id="details"></p>
<button id="connect" type="button">Connect</button>
<div id="status" role="status"></div>`,
    `
const params = new URLSearchParams(location.search);
const workspace = params.get('workspace') || '';
const link = params.get('link') || '';
const state = params.get('state') || '';
const back = params.get('return') || '';
const status = document.getElementById('status');
const show = (text, kind, code) => {
  status.textContent = text;
  status.dataset.state = kind;
  if (code) status.dataset.code = code; else delete status.dataset.code;
};
document.getElementById('details').textContent = 'Workspace ' + workspace + ', link ' + link + '.';
const valid = workspace && link && /^[A-Za-z0-9_-]{22}$/.test(state) && (back === 'web' || back === 'desktop');
if (!valid) show('This connect link is not complete.', 'error', 'request.invalid');
document.getElementById('connect').disabled = !valid;
document.getElementById('connect').addEventListener('click', async () => {
  const user = document.getElementById('user').value;
  const language = document.getElementById('language').value;
  show('Connecting…', 'busy');
  let response;
  try {
    response = await fetch(CONFIG.api + '/api/system/WorkspaceConnect/CreateTicket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': CONFIG.users[user] },
      body: JSON.stringify({ workspaceId: workspace, linkId: link, language }),
    });
  } catch {
    show('The mock ERP cannot be reached.', 'error', 'network');
    return;
  }
  const answer = await response.json().catch(() => null);
  if (!response.ok) {
    const code = answer && answer.errors && answer.errors[0] ? answer.errors[0].code : String(response.status);
    show('Refused: ' + code, 'error', code);
    return;
  }
  const message = { type: 'cgw-erp-connect', ticket: answer.ticket, state };
  if (back === 'desktop') {
    show('Opening Cash Gear Workspace…', 'done');
    location.href = 'cashgear-workspace://erp#ticket=' + answer.ticket + '&state=' + state;
    return;
  }
  if (!window.opener) {
    show('No Cash Gear Workspace window to return to.', 'error', 'opener');
    return;
  }
  // Each origin on the list is named in turn: the browser delivers to the opener's own only.
  for (const origin of CONFIG.origins) window.opener.postMessage(message, origin);
  show('Connected. You can close this window.', 'done');
  window.close();
});`,
  );
}

function linkPage(apiUrl, workspaceOrigins) {
  const admins = Object.keys(USERS).filter((name) => USERS[name].admin);
  const users = Object.fromEntries(admins.map((name) => [name, USERS[name].key]));
  return page(
    'Link Cash Gear Workspace',
    {
      api: apiUrl,
      users,
      companies: Object.fromEntries(admins.map((n) => [n, USERS[n].company])),
      workspaces: workspaceOrigins,
    },
    `<h1>Link Cash Gear Workspace</h1>
<p>An ERP admin links a workspace to this company. Workspace then asks which workspace.</p>
<label for="admin">ERP admin</label>
<select id="admin">${userOptions(admins)}</select>
<label for="workspace">Cash Gear Workspace</label>
<select id="workspace"></select>
<button id="link" type="button">Link Cash Gear Workspace</button>
<div id="status" role="status"></div>
<table><thead><tr><th>Workspace</th><th>Linked</th><th></th></tr></thead><tbody id="links"></tbody></table>`,
    `
const params = new URLSearchParams(location.search);
const status = document.getElementById('status');
const show = (text, kind) => { status.textContent = text; status.dataset.state = kind; };
const select = document.getElementById('workspace');
for (const origin of CONFIG.workspaces) {
  const option = document.createElement('option');
  option.value = origin;
  option.textContent = origin;
  select.append(option);
}
if (CONFIG.workspaces.includes(params.get('workspace'))) select.value = params.get('workspace');
const admin = () => document.getElementById('admin').value;
async function list() {
  const body = document.getElementById('links');
  body.replaceChildren();
  const state = await fetch(CONFIG.api + '/__mock/state').then((r) => r.json()).catch(() => null);
  if (!state) return;
  for (const link of state.links) {
    if (link.company !== CONFIG.companies[admin()] || link.revokedAt) continue;
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = link.workspaceName + ' (' + link.workspaceId + ')';
    const at = document.createElement('td');
    at.textContent = link.linkedAt;
    const cell = document.createElement('td');
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.textContent = 'Revoke';
    revoke.dataset.linkId = link.linkId;
    revoke.addEventListener('click', async () => {
      const response = await fetch(CONFIG.api + '/api/system/WorkspaceLink/Revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': CONFIG.users[admin()] },
        body: JSON.stringify({ linkId: link.linkId }),
      });
      show(response.ok ? 'Revoked.' : 'Refused: ' + response.status, response.ok ? 'done' : 'error');
      list();
    });
    cell.append(revoke);
    row.append(name, at, cell);
    body.append(row);
  }
}
document.getElementById('admin').addEventListener('change', list);
document.getElementById('link').addEventListener('click', async () => {
  const response = await fetch(CONFIG.api + '/api/system/WorkspaceLink/CreateTicket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': CONFIG.users[admin()] },
    body: JSON.stringify({ workspaceUrl: select.value }),
  }).catch(() => null);
  const answer = response ? await response.json().catch(() => null) : null;
  if (!response || !response.ok || !answer) {
    show('Refused: ' + (response ? response.status : 'no answer'), 'error');
    return;
  }
  show('Opening Cash Gear Workspace…', 'done');
  location.assign(answer.url);
});
list();`,
  );
}

function indexPage() {
  return page(
    'Mock Cash Gear ERP',
    {},
    `<h1>Mock Cash Gear ERP</h1>
<p><a href="/link">Link Cash Gear Workspace</a> (an ERP admin's page).</p>
<p>Workspace opens <code>/workspace-connect</code> itself to connect a user.</p>`,
    '',
  );
}

function clientHandler(mock, apiUrl) {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://client');
    res.setHeader('Cache-Control', 'no-store');
    // The connect page keeps its opener: never `Cross-Origin-Opener-Policy: same-origin` here.
    const html = (body) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    if (req.method !== 'GET') return void res.writeHead(405).end();
    if (url.pathname === '/') return html(indexPage());
    if (url.pathname === '/workspace-connect') {
      return html(connectPage(apiUrl, [...mock.workspaceOrigins]));
    }
    if (url.pathname === '/link') return html(linkPage(apiUrl, [...mock.workspaceOrigins]));
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.');
  };
}

// ---------------------------------------------------------------------------------------------
// Starting

function listen(server, port, host) {
  return new Promise((done, failed) => {
    server.once('error', failed);
    server.listen(port, host, () => {
      server.off('error', failed);
      done(server.address().port);
    });
  });
}

/**
 * Starts the API and the client (port 0 picks a free one). Resolves once both listen, with
 * their addresses, the mock and `close`.
 */
export async function startMockErp({
  apiPort = 0,
  clientPort = 0,
  host = '127.0.0.1',
  workspaceUrl,
  workspaceOrigins,
  large = false,
} = {}) {
  const mock = new MockErp({ workspaceUrl, workspaceOrigins });
  if (large) mock.reset({ large: true });
  const api = createServer((req, res) => {
    mock.handle(req, res).catch((error) => {
      if (res.headersSent) return void res.destroy();
      send(
        res,
        new Reply(500, {
          message: String(error?.message ?? error),
          correlationId: randomUUID(),
          errors: [],
        }),
      );
    });
  });
  const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
  const apiUrl = `http://${shown}:${await listen(api, apiPort, host)}`;
  const client = createServer(clientHandler(mock, apiUrl));
  const clientListening = await listen(client, clientPort, host);
  const clientUrl = `http://${shown}:${clientListening}`;
  mock.clientOrigins = new Set([
    clientUrl,
    `http://127.0.0.1:${clientListening}`,
    `http://localhost:${clientListening}`,
  ]);
  const close = (server) =>
    new Promise((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  return {
    apiUrl,
    clientUrl,
    mock,
    close: async () => {
      await Promise.all([close(api), close(client)]);
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const { apiUrl, clientUrl } = await startMockErp({
    apiPort: Number(option('port', process.env.CGW_MOCK_ERP_PORT ?? DEFAULT_PORTS.api)),
    clientPort: Number(
      option('client-port', process.env.CGW_MOCK_ERP_CLIENT_PORT ?? DEFAULT_PORTS.client),
    ),
    host: option('host', '127.0.0.1'),
    workspaceUrl: option('workspace-url', 'http://127.0.0.1:5273'),
    large: args.includes('--large'),
  });
  console.log(`Mock Cash Gear ERP: API ${apiUrl}, client ${clientUrl}`);
}
