// A mock of Cash Gear ERP for Workspace (erp-connect.1, docs/INTEGRATIONS.md, "Cash Gear ERP"):
// its API, with every route of the contract and the link routes, and its client's two pages, the
// connect page Workspace opens in a pop-up and the "Link Cash Gear Workspace" page. Plain Node,
// no dependencies. The contract suite (tests/contracts/erp) proves it behaves as the contract
// says; the browser tests and `pnpm dev:web` against a local API use it in place of the ERP.
//
//   node tests/mocks/erp/server.mjs [--port 4282] [--client-port 4284] [--host 127.0.0.1]
//                                   [--workspace-url http://127.0.0.1:5273]
//
// Ports also come from CGW_MOCK_ERP_PORT and CGW_MOCK_ERP_CLIENT_PORT. `/__mock/*` on the API
// resets it, moves its clock, injects faults, makes tickets without the pop-up, revokes links,
// turns Workspace off for a company, sets rate limits and shows its state (never a token).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** Sorted keys at every level, so equal queries hash equally whatever their key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

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

/** Two wire values of one field in the ERP's order; nulls first, as SQL Server sorts them. */
function compareValues(type, a, b) {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  switch (type) {
    case 'decimal':
      return compareDecimal(a, b);
    case 'integer':
      return a - b;
    case 'boolean':
      return Number(a) - Number(b);
    case 'dateTime':
      return Date.parse(a) - Date.parse(b);
    case 'date':
      return a < b ? -1 : a > b ? 1 : 0;
    default:
      return a.localeCompare(b, 'en', { sensitivity: 'base' });
  }
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
    this.records = seedRecords();
    this.reset();
  }

  /** Back to the start: tickets, sessions, links, clock, faults, limits and switches. */
  reset() {
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

  /** The fields `user` may see of `connector`, in the ERP's order. */
  fieldsFor(user, connector) {
    const hidden = new Set(user.hidden?.[connector.id] ?? []);
    return connector.fields.filter((f) => !hidden.has(f.name));
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
    if (fault) {
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
    if (method('api/connect/Connectors', 'GET')) return this.connectors(this.session(ctx));
    const at = /^api\/connect\/connectors\/([^/]+)\/(schema|query|commit)$/.exec(lower);
    if (at) {
      const id = ctx.path.split('/')[3];
      const wanted = at[2] === 'schema' ? 'GET' : 'POST';
      if (req.method !== wanted) refuse(405, 'request.invalid', `Use ${wanted}.`);
      const session = this.session(ctx);
      const connector = this.connectorFor(session, id);
      if (at[2] === 'schema') return this.schema(session, connector);
      if (at[2] === 'query') return this.query(ctx, session, connector);
      // Phase 7: no one has Edit on any connector yet.
      refuse(403, 'privilege.denied');
    }
    const status = /^api\/connect\/connectors\/([^/]+)\/commitstatus\/([^/]+)$/.exec(lower);
    if (status) {
      if (req.method !== 'GET') refuse(405, 'request.invalid', 'Use GET.');
      const session = this.session(ctx);
      this.connectorFor(session, ctx.path.split('/')[3]);
      const commitId = ctx.path.split('/')[5];
      if (!UUID.test(commitId)) refuse(400, 'request.invalid', 'commitId must be a UUID.');
      return new Reply(200, { status: 'unknown' });
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

  connectors(session) {
    const user = session.userInfo;
    return new Reply(200, {
      connectors: CONNECTOR_IDS.filter((id) => user.connectors.includes(id)).map((id) => {
        const c = CONNECTORS[id];
        // Until Phase 7, every connector is read-only for everyone (agreed with Track E).
        return { id, kind: c.kind, label: c.label, schemaVersion: c.schemaVersion, access: 'view' };
      }),
    });
  }

  /** The connector named in the route (else 404), which the user may view (else 403). */
  connectorFor(session, id) {
    const connector = Object.hasOwn(CONNECTORS, id) ? CONNECTORS[id] : undefined;
    if (!connector) refuse(404, 'connector.notFound');
    if (!session.userInfo.connectors.includes(id)) refuse(403, 'privilege.denied');
    return connector;
  }

  schema(session, connector) {
    const user = session.userInfo;
    const fields = this.fieldsFor(user, connector).map((f) => {
      const out = {
        name: f.name,
        label: f.label,
        type: f.type,
        editable: false,
        editReason: 'notEditable',
      };
      for (const key of ['required', 'maxLength', 'min', 'max', 'scale', 'lookup']) {
        if (f[key] !== undefined) out[key] = f[key];
      }
      out.filterable = f.filterable;
      out.sortable = f.sortable;
      return out;
    });
    const lists = lookups(user.company);
    const used = Object.fromEntries(
      fields.filter((f) => f.lookup).map((f) => [f.lookup, lists[f.lookup]]),
    );
    return new Reply(200, {
      id: connector.id,
      schemaVersion: connector.schemaVersion,
      keyField: connector.keyField,
      idField: connector.idField,
      maxPageSize: connector.maxPageSize,
      maxRecords: connector.maxRecords,
      maxCommitRecords: connector.maxCommitRecords,
      fields,
      lookups: used,
    });
  }

  query(ctx, session, connector) {
    const user = session.userInfo;
    const fields = this.fieldsFor(user, connector);
    const byName = new Map(fields.map((f) => [f.name, f]));
    const q = readQuery(ctx.body, connector, byName);

    const search = q.search?.toLowerCase() ?? '';
    const searched = [
      ...connector.fields.filter((f) => f.search).map((f) => f.name),
      ...connector.searchAlso,
    ];
    let rows = this.rowsFor(user, connector).filter((row) => {
      if (
        search &&
        !searched.some((name) =>
          String(row[name] ?? '')
            .toLowerCase()
            .includes(search),
        )
      )
        return false;
      return Object.entries(q.equals).every(([name, value]) => (row[name] ?? null) === value);
    });
    if (q.sort.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const { field, direction } of q.sort) {
          const order = compareValues(byName.get(field).type, a[field] ?? null, b[field] ?? null);
          if (order !== 0) return direction === 'desc' ? -order : order;
        }
        return 0;
      });
    }

    // The cursor is an offset tied to its query's filter, sort and fields (agreed with Track
    // E): another query's cursor is refused.
    const hash = sha256(
      canonical({
        k: this.cursorKey,
        connector: connector.id,
        search: q.search ?? null,
        equals: q.equals,
        sort: q.sort,
        fields: q.fields,
      }),
    ).slice(0, 24);
    let offset = 0;
    if (q.cursor !== null) {
      let read;
      try {
        read = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
      } catch {
        read = null;
      }
      if (!isObject(read) || read.q !== hash || !Number.isSafeInteger(read.o) || read.o < 0) {
        refuse(400, 'request.invalid', 'The cursor is not one of this query’s.');
      }
      offset = read.o;
    }
    const page = rows.slice(offset, offset + q.pageSize);
    const next = offset + page.length;
    const names = q.fields ?? fields.map((f) => f.name);
    return new Reply(200, {
      records: page.map((row) => ({
        id: row.id,
        key: String(row[connector.keyField]),
        version: row.version,
        values: Object.fromEntries(names.map((name) => [name, row[name] ?? null])),
      })),
      nextCursor:
        next < rows.length
          ? Buffer.from(JSON.stringify({ o: next, q: hash })).toString('base64url')
          : null,
      total: rows.length,
    });
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
        this.reset();
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

/** A query's body, checked as the ERP checks it: anything wrong is 400 `request.invalid`. */
function readQuery(body, connector, byName) {
  const no = (why) => refuse(400, 'request.invalid', why);
  if (!isObject(body)) no('A JSON body is required.');
  const filter = body.filter;
  if (!isObject(filter)) no('filter must be an object.');
  for (const key of Object.keys(filter)) {
    if (key !== 'search' && key !== 'equals') no(`filter cannot have ${key}.`);
  }
  let search;
  if (filter.search !== undefined && filter.search !== null) {
    if (typeof filter.search !== 'string' || filter.search.length > 200) {
      no('filter.search must be text of at most 200 characters.');
    }
    search = filter.search === '' ? undefined : filter.search;
  }
  const equals = {};
  if (filter.equals !== undefined && filter.equals !== null) {
    if (!isObject(filter.equals)) no('filter.equals must be an object.');
    for (const [name, value] of Object.entries(filter.equals)) {
      const field = byName.get(name);
      if (!field || !field.filterable) no(`filter.equals cannot use ${name}.`);
      const problem = valueProblem(field, value);
      if (problem) no(`filter.equals.${name} must be ${problem}.`);
      equals[name] = value === '' ? null : value;
    }
  }
  if (body.parameters !== undefined && body.parameters !== null && connector.kind === 'entity') {
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
  return { search, equals, fields, sort, cursor: body.cursor, pageSize: body.pageSize };
}

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
} = {}) {
  const mock = new MockErp({ workspaceUrl, workspaceOrigins });
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
  });
  console.log(`Mock Cash Gear ERP: API ${apiUrl}, client ${clientUrl}`);
}
