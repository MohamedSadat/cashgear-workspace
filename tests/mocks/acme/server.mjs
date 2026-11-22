// A mock ACME server (RFC 8555) for custom domains on published sites: the server's worker gets its
// TLS certificates from it in tests, by the HTTP-01 challenge. Plain Node (`node:http`,
// `node:crypto`), no dependencies; der.mjs beside it reads requests and writes certificates.
//
//   node tests/mocks/acme/server.mjs [--port 4289] [--host 127.0.0.1] [--challenge-port 80]
//     [--resolve 127.0.0.1]
//
// The port also comes from ACME_MOCK_PORT. The directory is `http://<host>:<port>/directory`. Every
// POST is a flattened JWS (ES256 or RS256), checked as RFC 8555 section 6 says: nonce, url, jwk or
// kid, signature. A challenge is checked by fetching `/.well-known/acme-challenge/<token>` from
// `--resolve` at `--challenge-port`, whatever the name resolves to, with the name in `Host`. The
// CA's key and certificate are made at start and kept in memory only, never written anywhere.
// `/__mock/*` controls it: `state`, `reset`, `fault`, `lifetime`, `challenge`, `ca`. README.md
// beside this file says the rest.

import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createServer, request } from 'node:http';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DerError, issueCertificate, makeCa, parseCsr } from './der.mjs';

export const DEFAULT_PORT = 4289;

/** The terms a new account must agree to (`termsOfServiceAgreed: true`). */
export const TERMS = 'https://acme.test/terms';

/** The JWS algorithms an account key may sign with. */
export const ALGS = ['ES256', 'RS256'];

/** What `POST /__mock/fault` takes. Each is used up by `count` requests (1 by default). */
export const FAULTS = ['challenge', 'rateLimited', 'badNonce', 'server'];

/** A certificate's days, until `POST /__mock/lifetime` or a reset changes it. */
export const LIFETIME_DAYS = 90;

/** Each error type the mock answers, and its status (`urn:ietf:params:acme:error:<type>`). */
export const ERRORS = {
  malformed: 400,
  unauthorized: 403,
  accountDoesNotExist: 400,
  badNonce: 400,
  badSignatureAlgorithm: 400,
  badPublicKey: 400,
  invalidContact: 400,
  rejectedIdentifier: 400,
  badCSR: 400,
  orderNotReady: 403,
  alreadyRevoked: 400,
  badRevocationReason: 400,
  rateLimited: 429,
  incorrectResponse: 403,
  connection: 400,
  serverInternal: 500,
  userActionRequired: 403,
};

const ERROR_PREFIX = 'urn:ietf:params:acme:error:';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ORDER_DAYS = 7;
const MAX_BODY = 64 * 1024;
const MAX_NONCES = 10_000;
const MAX_ATTEMPTS = 500;
const MAX_NAMES = 100;
const CHALLENGE_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;
const MAX_CHALLENGE_BODY = 8 * 1024;
const VALIDATE_DELAY_MS = 5;
const ISSUE_DELAY_MS = 10;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const B64URL = /^[A-Za-z0-9_-]*$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
/** RFC 5280's reason codes Let's Encrypt takes. */
const REASONS = [0, 1, 3, 4, 5];

const newId = () => randomBytes(9).toString('base64url');

/**
 * RFC 7638: SHA-256 over the key's required members in lexical order, base64url. The key
 * authorization of a token is `token + '.' + thumbprint(accountKey)`.
 */
export function thumbprint(jwk) {
  const members =
    jwk.kty === 'EC'
      ? { crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y }
      : { e: jwk.e, kty: 'RSA', n: jwk.n };
  return createHash('sha256').update(JSON.stringify(members)).digest('base64url');
}

export const keyAuthorization = (token, jwk) => `${token}.${thumbprint(jwk)}`;

/** An ACME refusal: answered as `application/problem+json` with a fresh nonce. */
class AcmeProblem extends Error {
  constructor(type, detail, { status, headers = {}, extra = {} } = {}) {
    super(detail);
    this.type = type;
    this.detail = detail;
    this.status = status ?? ERRORS[type] ?? 400;
    this.headers = headers;
    this.extra = extra;
  }
}

const refuse = (type, detail, options) => new AcmeProblem(type, detail, options);

/** A refusal of a control route, as a status and words. */
class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req, tooLarge) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        fail(tooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function send(res, status, body, headers = {}) {
  const json = body !== undefined && typeof body === 'object';
  res.writeHead(status, {
    'content-type': json ? 'application/json' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body === undefined ? '' : json ? JSON.stringify(body) : String(body));
}

/** The account key's public members only, and the KeyObject that checks its signatures. */
function accountKey(jwk, alg) {
  if (!isObject(jwk)) throw refuse('malformed', 'jwk: a JSON Web Key object.');
  if (['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'].some((member) => member in jwk))
    throw refuse('malformed', 'jwk: the public key only, never a private member.');
  let members;
  if (alg === 'ES256') {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256')
      throw refuse('badPublicKey', 'ES256 is signed by an EC P-256 key (kty EC, crv P-256).');
    members = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  } else {
    if (jwk.kty !== 'RSA') throw refuse('badPublicKey', 'RS256 is signed by an RSA key.');
    members = { kty: 'RSA', n: jwk.n, e: jwk.e };
  }
  let key;
  try {
    key = createPublicKey({ key: members, format: 'jwk' });
  } catch {
    throw refuse('malformed', 'jwk: not a valid key.');
  }
  if (alg === 'RS256' && key.asymmetricKeyDetails.modulusLength < 2048)
    throw refuse('badPublicKey', 'An RSA account key has 2048 bits at least.');
  return { jwk: members, key };
}

/** Why a newOrder identifier is refused, or null. */
function refusalOf({ type, value }) {
  if (type === 'ip') return `${value}: the mock issues for DNS names, not IP addresses.`;
  if (type !== 'dns') return `${type}: only dns identifiers.`;
  const name = value.toLowerCase();
  if (name.startsWith('*.'))
    return `${value}: a wildcard needs dns-01, which the mock never offers.`;
  if (IPV4.test(name) || name.includes(':')) return `${value}: an IP address is not a DNS name.`;
  const labels = name.split('.');
  if (
    name.length > 253 ||
    labels.length < 2 ||
    !labels.every((label) => LABEL.test(label)) ||
    /^\d+$/.test(labels[labels.length - 1])
  )
    return `${value}: not a DNS name of two labels or more.`;
  return null;
}

/** One GET of a challenge URL, through `address:port` with the URL's host in `Host`. */
function getOnce(address, port, target, signal) {
  return new Promise((done, fail) => {
    const req = request(
      {
        host: address,
        port,
        method: 'GET',
        path: target.pathname + target.search,
        headers: { host: target.host, 'user-agent': 'cgw-mock-acme', accept: '*/*' },
        agent: false,
        signal,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size <= MAX_CHALLENGE_BODY) chunks.push(chunk);
        });
        res.on('end', () =>
          done({
            status: res.statusCode ?? 0,
            location: res.headers.location ?? null,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', fail);
      },
    );
    req.on('error', fail);
    req.end();
  });
}

/** Each ACME route and the method answering it; `:id` is the object's. */
const ROUTES = [
  [/^\/new-account$/, 'onNewAccount'],
  [/^\/new-order$/, 'onNewOrder'],
  [/^\/revoke-cert$/, 'onRevokeCert'],
  [/^\/key-change$/, 'onKeyChange'],
  [/^\/acct\/([A-Za-z0-9_-]+)$/, 'onAccount'],
  [/^\/acct\/([A-Za-z0-9_-]+)\/orders$/, 'onAccountOrders'],
  [/^\/order\/([A-Za-z0-9_-]+)$/, 'onOrder'],
  [/^\/order\/([A-Za-z0-9_-]+)\/finalize$/, 'onFinalize'],
  [/^\/authz\/([A-Za-z0-9_-]+)$/, 'onAuthz'],
  [/^\/chall\/([A-Za-z0-9_-]+)$/, 'onChallenge'],
  [/^\/cert\/([A-Za-z0-9_-]+)$/, 'onCertificate'],
];

function routeOf(path) {
  for (const [pattern, handler] of ROUTES) {
    const match = pattern.exec(path);
    if (match) return { handler, id: match[1] ?? null };
  }
  return null;
}

/** A POST-as-GET: the payload is the empty string. */
function asGet(jws) {
  if (jws.payload !== null)
    throw refuse('malformed', 'This resource takes POST-as-GET: an empty payload ("").');
}

// ---------------------------------------------------------------------------------------------
// The server

export class MockAcme {
  constructor({ challengePort = 80, resolve = '127.0.0.1' } = {}) {
    /** Set by `startMockAcme` once it listens. */
    this.origin = `http://127.0.0.1:${DEFAULT_PORT}`;
    /** The CA: its key in memory only, kept by a reset. */
    this.ca = makeCa();
    /** Where a challenge is fetched from, whatever its name resolves to. */
    this.target = { port: challengePort, resolve };
    this.timers = new Set();
    this.aborts = new Set();
    this.generation = 0;
    this.reset();
  }

  /** Everything forgotten but the CA and the challenge target: nonces, accounts, orders, faults. */
  reset() {
    this.cancelPending();
    this.generation += 1;
    this.nonces = new Set();
    this.accounts = new Map();
    this.byThumbprint = new Map();
    this.orders = new Map();
    this.authzs = new Map();
    this.challenges = new Map();
    this.certs = new Map();
    this.attempts = [];
    this.faults = {};
    this.lifetimeDays = LIFETIME_DAYS;
  }

  /** Validations and issues not yet done are dropped (on a reset or close). */
  cancelPending() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const controller of this.aborts) controller.abort();
    this.aborts.clear();
  }

  later(ms, work) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      work();
    }, ms);
    this.timers.add(timer);
  }

  url(path) {
    return `${this.origin}${path}`;
  }

  takeFault(kind) {
    if (!(this.faults[kind] > 0)) return false;
    this.faults[kind] -= 1;
    if (this.faults[kind] === 0) delete this.faults[kind];
    return true;
  }

  nonce() {
    const value = randomBytes(16).toString('base64url');
    this.nonces.add(value);
    if (this.nonces.size > MAX_NONCES) this.nonces.delete(this.nonces.values().next().value);
    return value;
  }

  directory() {
    return {
      newNonce: this.url('/new-nonce'),
      newAccount: this.url('/new-account'),
      newOrder: this.url('/new-order'),
      revokeCert: this.url('/revoke-cert'),
      keyChange: this.url('/key-change'),
      meta: { termsOfService: TERMS },
    };
  }

  /** An ACME answer: a fresh nonce, the directory as `index`, never cached. */
  answer(res, status, body, headers = {}) {
    const { link, ...rest } = headers;
    const out = {
      'cache-control': 'no-store',
      'replay-nonce': this.nonce(),
      link: [`<${this.url('/directory')}>;rel="index"`, ...[].concat(link ?? [])],
    };
    if (body !== undefined && typeof body === 'object') out['content-type'] = 'application/json';
    Object.assign(out, rest);
    res.writeHead(status, out);
    res.end(body === undefined ? '' : typeof body === 'object' ? JSON.stringify(body) : body);
  }

  problem(res, error) {
    const body = {
      type: ERROR_PREFIX + error.type,
      detail: error.detail,
      status: error.status,
      ...error.extra,
    };
    return this.answer(res, error.status, body, {
      'content-type': 'application/problem+json',
      ...error.headers,
    });
  }

  async handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://mock');
    const path = url.pathname;
    if (path.startsWith('/__mock/')) return this.control(req, res, path.slice('/__mock/'.length));
    if (path === '/directory') {
      if (req.method === 'GET' || req.method === 'HEAD') return send(res, 200, this.directory());
      return send(res, 405, { error: 'method' }, { allow: 'GET, HEAD' });
    }
    if (path === '/new-nonce') {
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return send(res, 405, { error: 'method' }, { allow: 'GET, HEAD' });
      // RFC 8555 7.2: 200 to HEAD, 204 to GET.
      res.writeHead(req.method === 'HEAD' ? 200 : 204, {
        'replay-nonce': this.nonce(),
        'cache-control': 'no-store',
        link: `<${this.url('/directory')}>;rel="index"`,
      });
      return res.end();
    }
    const route = routeOf(path);
    if (!route)
      return this.problem(res, refuse('malformed', `No such resource: ${path}.`, { status: 404 }));
    if (req.method !== 'POST')
      return this.problem(
        res,
        refuse('malformed', 'ACME resources take POST (or POST-as-GET) only.', {
          status: 405,
          headers: { allow: 'POST' },
        }),
      );
    try {
      if (this.takeFault('server')) throw refuse('serverInternal', 'Mock fault: server.');
      const jws = await this.readJws(req, route);
      const result = await this[route.handler](jws, route.id);
      return this.answer(res, result.status ?? 200, result.body, result.headers);
    } catch (error) {
      if (error instanceof AcmeProblem) return this.problem(res, error);
      return this.problem(res, refuse('serverInternal', String(error?.message ?? error)));
    }
  }

  /** RFC 8555 6.2 to 6.5: the JWS checked, its nonce spent, its payload read. */
  async readJws(req, route) {
    const type = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (type !== 'application/jose+json')
      throw refuse('malformed', 'Content-Type must be application/jose+json.', { status: 415 });
    const raw = await readBody(req, () =>
      refuse('malformed', 'The body is too large.', { status: 413 }),
    );
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (!isObject(body)) throw refuse('malformed', 'The body must be a flattened JWS JSON object.');
    if ('header' in body || 'signatures' in body)
      throw refuse('malformed', 'Only the flattened JWS JSON form, with no unprotected header.');
    const { protected: protectedB64, payload: payloadB64, signature: signatureB64 } = body;
    if (
      ![protectedB64, payloadB64, signatureB64].every(
        (s) => typeof s === 'string' && B64URL.test(s),
      )
    )
      throw refuse('malformed', 'protected, payload and signature must be base64url strings.');
    let header;
    try {
      header = JSON.parse(Buffer.from(protectedB64, 'base64url').toString('utf8'));
    } catch {
      header = null;
    }
    if (!isObject(header)) throw refuse('malformed', 'The protected header is not a JSON object.');

    // The nonce is spent by any request naming it, refused or not.
    const known = typeof header.nonce === 'string' && this.nonces.delete(header.nonce);
    if (this.takeFault('badNonce')) throw refuse('badNonce', 'Mock fault: badNonce.');
    if (!known)
      throw refuse(
        'badNonce',
        typeof header.nonce === 'string'
          ? 'The nonce is unknown, or was used already.'
          : 'The protected header has no nonce.',
      );
    if (!ALGS.includes(header.alg))
      throw refuse('badSignatureAlgorithm', `alg: one of ${ALGS.join(', ')}.`, {
        extra: { algorithms: [...ALGS] },
      });
    const requested = this.url(req.url ?? '/');
    if (header.url !== requested)
      throw refuse(
        'unauthorized',
        `url: the header names ${String(header.url)}, not ${requested}.`,
      );

    const hasJwk = header.jwk !== undefined;
    const hasKid = header.kid !== undefined;
    if (hasJwk === hasKid)
      throw refuse('malformed', 'The protected header holds jwk or kid: one of them, not both.');
    let account = null;
    let jwk;
    let key;
    if (route.handler === 'onNewAccount') {
      if (!hasJwk) throw refuse('malformed', 'newAccount is signed with jwk, not kid.');
      ({ jwk, key } = accountKey(header.jwk, header.alg));
    } else {
      if (!hasKid) throw refuse('malformed', 'Every request but newAccount is signed with kid.');
      account = this.accountOf(header.kid);
      ({ jwk, key } = accountKey(account.jwk, header.alg));
    }
    const signature = Buffer.from(signatureB64, 'base64url');
    const input = Buffer.from(`${protectedB64}.${payloadB64}`, 'ascii');
    let holds;
    try {
      holds =
        header.alg === 'ES256'
          ? signature.length === 64 &&
            verify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, signature)
          : verify('sha256', input, key, signature);
    } catch {
      holds = false;
    }
    if (!holds) throw refuse('malformed', 'The JWS signature does not verify.');
    if (account && account.status !== 'valid')
      throw refuse('unauthorized', `The account is ${account.status}.`);

    let payload = null;
    if (payloadB64 !== '') {
      try {
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      } catch {
        payload = undefined;
      }
      if (!isObject(payload)) throw refuse('malformed', 'The payload is not a JSON object.');
    }
    return { header, jwk, account, payload };
  }

  accountOf(kid) {
    const prefix = this.url('/acct/');
    const id = typeof kid === 'string' && kid.startsWith(prefix) ? kid.slice(prefix.length) : null;
    const account = id === null ? undefined : this.accounts.get(id);
    if (!account) throw refuse('accountDoesNotExist', `kid: no account ${String(kid)}.`);
    return account;
  }

  owned(map, id, account, what) {
    const item = map.get(id);
    if (!item) throw refuse('malformed', `No such ${what}.`, { status: 404 });
    if (item.account !== account.id)
      throw refuse('unauthorized', `This ${what} belongs to another account.`);
    return item;
  }

  // -------------------------------------------------------------------------------------------
  // What the client sees

  accountDto(account) {
    return {
      status: account.status,
      contact: [...account.contact],
      orders: this.url(`/acct/${account.id}/orders`),
    };
  }

  orderDto(order) {
    return {
      status: order.status,
      expires: order.expires,
      identifiers: order.names.map((value) => ({ type: 'dns', value })),
      authorizations: order.authzs.map((id) => this.url(`/authz/${id}`)),
      finalize: this.url(`/order/${order.id}/finalize`),
      ...(order.certificate ? { certificate: this.url(`/cert/${order.certificate}`) } : {}),
      ...(order.error ? { error: order.error } : {}),
    };
  }

  authzDto(authz) {
    return {
      status: authz.status,
      identifier: { type: 'dns', value: authz.name },
      expires: authz.expires,
      challenges: authz.challenges.map((id) => this.challengeDto(this.challenges.get(id))),
    };
  }

  challengeDto(challenge) {
    return {
      type: challenge.type,
      url: this.url(`/chall/${challenge.id}`),
      token: challenge.token,
      status: challenge.status,
      ...(challenge.validated ? { validated: challenge.validated } : {}),
      ...(challenge.error ? { error: challenge.error } : {}),
    };
  }

  /** `Retry-After: 1` while the server is still working on it. */
  retry(busy) {
    return busy ? { 'retry-after': '1' } : {};
  }

  // -------------------------------------------------------------------------------------------
  // Routes

  onNewAccount(jws) {
    const payload = jws.payload;
    if (!payload) throw refuse('malformed', 'newAccount takes a JSON object.');
    const print = thumbprint(jws.jwk);
    const existing = this.byThumbprint.get(print);
    if (existing) {
      if (existing.status !== 'valid')
        throw refuse('unauthorized', `The account of this key is ${existing.status}.`);
      return { status: 200, body: this.accountDto(existing), headers: { location: existing.url } };
    }
    if (payload.onlyReturnExisting === true)
      throw refuse('accountDoesNotExist', 'No account has this key.');
    if (payload.termsOfServiceAgreed !== true)
      throw refuse('userActionRequired', `Agree to the terms of service (${TERMS}).`, {
        headers: { link: `<${TERMS}>;rel="terms-of-service"` },
        extra: { instance: TERMS },
      });
    const contact = this.contactOf(payload.contact);
    const id = newId();
    const account = {
      id,
      url: this.url(`/acct/${id}`),
      jwk: jws.jwk,
      thumbprint: print,
      contact,
      status: 'valid',
      orders: [],
      createdAt: new Date().toISOString(),
    };
    this.accounts.set(id, account);
    this.byThumbprint.set(print, account);
    return { status: 201, body: this.accountDto(account), headers: { location: account.url } };
  }

  contactOf(contact) {
    if (contact === undefined) return [];
    if (
      !Array.isArray(contact) ||
      contact.length > 10 ||
      !contact.every((c) => typeof c === 'string' && /^mailto:[^\s,]+@[^\s,]+$/.test(c))
    )
      throw refuse('invalidContact', 'contact: up to 10 mailto: addresses.');
    return [...contact];
  }

  onAccount(jws, id) {
    if (id !== jws.account.id) throw refuse('unauthorized', 'This is another account.');
    const account = jws.account;
    if (jws.payload) {
      if (jws.payload.contact !== undefined) account.contact = this.contactOf(jws.payload.contact);
      if (jws.payload.status === 'deactivated') account.status = 'deactivated';
      else if (jws.payload.status !== undefined)
        throw refuse('malformed', 'status: only "deactivated".');
    }
    return { body: this.accountDto(account), headers: { location: account.url } };
  }

  onAccountOrders(jws, id) {
    asGet(jws);
    if (id !== jws.account.id) throw refuse('unauthorized', 'This is another account.');
    return { body: { orders: jws.account.orders.map((o) => this.url(`/order/${o}`)) } };
  }

  onNewOrder(jws) {
    if (this.takeFault('rateLimited'))
      throw refuse('rateLimited', 'Mock fault: rateLimited.', {
        headers: { 'retry-after': '3600' },
      });
    const payload = jws.payload;
    if (!payload) throw refuse('malformed', 'newOrder takes {identifiers}.');
    if (payload.notBefore !== undefined || payload.notAfter !== undefined)
      throw refuse('malformed', 'notBefore and notAfter are not supported.');
    const list = payload.identifiers;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_NAMES)
      throw refuse('malformed', `identifiers: 1 to ${MAX_NAMES} of {type: "dns", value}.`);
    const names = [];
    for (const item of list) {
      if (!isObject(item) || typeof item.type !== 'string' || typeof item.value !== 'string')
        throw refuse('malformed', 'Each identifier is {type, value}.');
      const reason = refusalOf(item);
      if (reason) throw refuse('rejectedIdentifier', reason);
      const value = item.value.toLowerCase();
      if (!names.includes(value)) names.push(value);
    }
    const account = jws.account;
    const expires = new Date(Date.now() + ORDER_DAYS * DAY).toISOString();
    const order = {
      id: newId(),
      account: account.id,
      status: 'pending',
      expires,
      names,
      authzs: [],
      certificate: null,
      error: null,
    };
    for (const value of names) {
      const authz = {
        id: newId(),
        account: account.id,
        order: order.id,
        name: value,
        status: 'pending',
        expires,
        challenges: [],
      };
      const challenge = {
        id: newId(),
        account: account.id,
        authz: authz.id,
        type: 'http-01',
        token: randomBytes(32).toString('base64url'),
        status: 'pending',
        validated: null,
        error: null,
      };
      authz.challenges.push(challenge.id);
      order.authzs.push(authz.id);
      this.authzs.set(authz.id, authz);
      this.challenges.set(challenge.id, challenge);
    }
    this.orders.set(order.id, order);
    account.orders.push(order.id);
    return {
      status: 201,
      body: this.orderDto(order),
      headers: { location: this.url(`/order/${order.id}`) },
    };
  }

  onOrder(jws, id) {
    asGet(jws);
    const order = this.owned(this.orders, id, jws.account, 'order');
    return {
      body: this.orderDto(order),
      headers: { location: this.url(`/order/${id}`), ...this.retry(order.status === 'processing') },
    };
  }

  onAuthz(jws, id) {
    asGet(jws);
    const authz = this.owned(this.authzs, id, jws.account, 'authorization');
    const busy = authz.challenges.some((c) => this.challenges.get(c).status === 'processing');
    return { body: this.authzDto(authz), headers: this.retry(busy) };
  }

  onChallenge(jws, id) {
    const challenge = this.owned(this.challenges, id, jws.account, 'challenge');
    const authz = this.authzs.get(challenge.authz);
    // RFC 8555 7.5.1: `{}` says the response is in place; POST-as-GET only reads.
    if (jws.payload && challenge.status === 'pending' && authz.status === 'pending') {
      challenge.status = 'processing';
      this.later(VALIDATE_DELAY_MS, () =>
        this.validate(challenge).catch((error) => {
          challenge.status = 'invalid';
          challenge.error = {
            type: `${ERROR_PREFIX}serverInternal`,
            detail: String(error?.message ?? error),
            status: 500,
          };
        }),
      );
    }
    return {
      body: this.challengeDto(challenge),
      headers: {
        link: `<${this.url(`/authz/${authz.id}`)}>;rel="up"`,
        ...this.retry(challenge.status === 'processing'),
      },
    };
  }

  onFinalize(jws, id) {
    const order = this.owned(this.orders, id, jws.account, 'order');
    if (!jws.payload || typeof jws.payload.csr !== 'string')
      throw refuse('malformed', 'finalize takes {csr}: the request as DER, base64url.');
    if (order.status !== 'ready')
      throw refuse('orderNotReady', `The order is ${order.status}, not ready.`);
    if (!B64URL.test(jws.payload.csr) || jws.payload.csr === '')
      throw refuse('badCSR', 'csr: base64url without padding.');
    let csr;
    try {
      csr = parseCsr(Buffer.from(jws.payload.csr, 'base64url'));
    } catch (error) {
      // DerError for what the reader refuses; anything else is a request it could not walk.
      const why = error instanceof DerError ? error.message : 'not a PKCS #10 request.';
      throw refuse('badCSR', `The CSR cannot be read: ${why}`);
    }
    if (!csr.publicKey) throw refuse('badCSR', 'The CSR has no public key the mock can read.');
    if (!csr.signatureValid)
      throw refuse(
        'badCSR',
        'The CSR signature does not verify (RSA PKCS #1 v1.5 or ECDSA P-256, with SHA-256).',
      );
    if (
      csr.publicKey.asymmetricKeyType === 'rsa' &&
      csr.publicKey.asymmetricKeyDetails.modulusLength < 2048
    )
      throw refuse('badCSR', 'An RSA key has 2048 bits at least.');
    if (thumbprint(csr.publicKey.export({ format: 'jwk' })) === jws.account.thumbprint)
      throw refuse('badCSR', 'The certificate key must not be the account key.');
    if (csr.otherNames > 0) throw refuse('badCSR', 'The CSR names something other than DNS names.');
    const asked = new Set(
      (csr.dnsNames.length > 0 ? csr.dnsNames : csr.commonName ? [csr.commonName] : []).map((n) =>
        n.toLowerCase(),
      ),
    );
    if (asked.size !== order.names.length || order.names.some((n) => !asked.has(n)))
      throw refuse(
        'badCSR',
        `The CSR names ${[...asked].join(', ') || 'nothing'}; the order is for ${order.names.join(', ')}.`,
      );
    if (csr.commonName && !asked.has(csr.commonName.toLowerCase()))
      throw refuse('badCSR', 'The CSR common name is not one of its names.');
    order.status = 'processing';
    const gen = this.generation;
    this.later(ISSUE_DELAY_MS, () => {
      if (gen === this.generation) this.issue(order, csr);
    });
    return {
      body: this.orderDto(order),
      headers: { location: this.url(`/order/${order.id}`), ...this.retry(true) },
    };
  }

  onCertificate(jws, id) {
    asGet(jws);
    const cert = this.owned(this.certs, id, jws.account, 'certificate');
    return { body: cert.chain, headers: { 'content-type': 'application/pem-certificate-chain' } };
  }

  onRevokeCert(jws) {
    const payload = jws.payload;
    if (!payload || typeof payload.certificate !== 'string' || !B64URL.test(payload.certificate))
      throw refuse('malformed', 'revokeCert takes {certificate}: DER, base64url.');
    const der = Buffer.from(payload.certificate, 'base64url');
    const cert = [...this.certs.values()].find((c) => c.der.equals(der));
    if (!cert)
      throw refuse('malformed', 'The mock did not issue this certificate.', { status: 404 });
    if (cert.account !== jws.account.id)
      throw refuse('unauthorized', 'The certificate belongs to another account.');
    if (payload.reason !== undefined && !REASONS.includes(payload.reason))
      throw refuse('badRevocationReason', `reason: one of ${REASONS.join(', ')}.`);
    if (cert.revoked) throw refuse('alreadyRevoked', 'The certificate is revoked already.');
    cert.revoked = true;
    cert.reason = payload.reason ?? 0;
    return { status: 200 };
  }

  onKeyChange() {
    throw refuse('malformed', 'The mock does not take key changes (RFC 8555 7.3.5).');
  }

  // -------------------------------------------------------------------------------------------
  // Validation and issue

  /** RFC 8555 8.3: the body at the challenge URL, trimmed, is the key authorization. */
  async validate(challenge) {
    const gen = this.generation;
    const authz = this.authzs.get(challenge.authz);
    const order = this.orders.get(authz.order);
    const account = this.accounts.get(challenge.account);
    const forced = this.takeFault('challenge');
    const seen = await this.fetchChallenge(authz.name, challenge.token);
    if (gen !== this.generation) return;
    let error = seen.error;
    if (!error && seen.status !== 200)
      error = { type: 'incorrectResponse', detail: `${seen.url} answered ${seen.status}.` };
    if (!error && seen.body.trim() !== `${challenge.token}.${account.thumbprint}`)
      error = {
        type: 'incorrectResponse',
        detail: `${seen.url} did not answer the key authorization.`,
      };
    if (forced) error = { type: 'incorrectResponse', detail: 'Mock fault: challenge.' };
    this.attempts.push({
      at: new Date().toISOString(),
      identifier: authz.name,
      token: challenge.token,
      url: seen.url,
      host: seen.host,
      status: seen.status,
      redirects: seen.redirects,
      outcome: error ? 'invalid' : 'valid',
      error: error ? ERROR_PREFIX + error.type : null,
      detail: error?.detail ?? null,
    });
    if (this.attempts.length > MAX_ATTEMPTS) this.attempts.shift();
    if (error) {
      const problem = {
        type: ERROR_PREFIX + error.type,
        detail: error.detail,
        status: ERRORS[error.type],
      };
      challenge.status = 'invalid';
      challenge.error = problem;
      authz.status = 'invalid';
      if (order.status === 'pending' || order.status === 'ready') {
        order.status = 'invalid';
        order.error = { ...problem, detail: `${authz.name}: ${error.detail}` };
      }
      return;
    }
    challenge.status = 'valid';
    challenge.validated = new Date().toISOString();
    authz.status = 'valid';
    if (
      order.status === 'pending' &&
      order.authzs.every((id) => this.authzs.get(id).status === 'valid')
    )
      order.status = 'ready';
  }

  /** The challenge URL fetched, redirects followed on the same host only (3 at most). */
  async fetchChallenge(name, token) {
    const { port, resolve: address } = this.target;
    const host = port === 80 ? name : `${name}:${port}`;
    const url = `http://${host}/.well-known/acme-challenge/${token}`;
    const seen = { url, host, status: null, redirects: 0, body: '', error: null };
    const controller = new AbortController();
    this.aborts.add(controller);
    const timer = setTimeout(() => controller.abort(), CHALLENGE_TIMEOUT_MS);
    try {
      let target = new URL(url);
      for (;;) {
        const got = await getOnce(address, port, target, controller.signal);
        seen.status = got.status;
        if (!REDIRECTS.has(got.status) || !got.location) {
          seen.body = got.body;
          break;
        }
        let next = null;
        try {
          next = new URL(got.location, target);
        } catch {
          next = null;
        }
        if (!next || next.protocol !== 'http:' || next.host !== host) {
          seen.error = {
            type: 'connection',
            detail: `A redirect to ${got.location} leaves http://${host}.`,
          };
          break;
        }
        if (seen.redirects >= MAX_REDIRECTS) {
          seen.error = { type: 'connection', detail: `More than ${MAX_REDIRECTS} redirects.` };
          break;
        }
        seen.redirects += 1;
        target = next;
      }
    } catch (error) {
      seen.error = {
        type: 'connection',
        detail: controller.signal.aborted
          ? `No answer from ${url} within ${CHALLENGE_TIMEOUT_MS / 1000} s.`
          : `${url}: ${error?.code ?? error?.message ?? String(error)}.`,
      };
    } finally {
      clearTimeout(timer);
      this.aborts.delete(controller);
    }
    return seen;
  }

  issue(order, csr) {
    try {
      const now = Date.now();
      const notBefore = new Date(Math.floor((now - HOUR) / 1000) * 1000);
      const notAfter = new Date(Math.floor((now + this.lifetimeDays * DAY) / 1000) * 1000);
      const issued = issueCertificate({
        ca: this.ca,
        spki: csr.spki,
        names: order.names,
        commonName: csr.commonName ? csr.commonName.toLowerCase() : order.names[0],
        notBefore,
        notAfter,
      });
      const cert = {
        id: newId(),
        account: order.account,
        order: order.id,
        names: [...order.names],
        serial: issued.serial,
        notBefore: notBefore.toISOString(),
        notAfter: notAfter.toISOString(),
        der: issued.der,
        chain: issued.pem + this.ca.pem,
        revoked: false,
        reason: null,
      };
      this.certs.set(cert.id, cert);
      order.certificate = cert.id;
      order.status = 'valid';
    } catch (error) {
      order.status = 'invalid';
      order.error = {
        type: `${ERROR_PREFIX}serverInternal`,
        detail: `The certificate could not be made: ${error?.message ?? error}`,
        status: 500,
      };
    }
  }

  // -------------------------------------------------------------------------------------------
  // Controls

  state() {
    return {
      directory: this.url('/directory'),
      challenge: { ...this.target },
      lifetimeDays: this.lifetimeDays,
      faults: { ...this.faults },
      nonces: this.nonces.size,
      accounts: [...this.accounts.values()].map((a) => ({
        url: a.url,
        status: a.status,
        contact: [...a.contact],
        thumbprint: a.thumbprint,
        orders: a.orders.length,
        createdAt: a.createdAt,
      })),
      orders: [...this.orders.values()].map((o) => ({
        url: this.url(`/order/${o.id}`),
        account: this.url(`/acct/${o.account}`),
        status: o.status,
        names: [...o.names],
        authorizations: o.authzs.map((id) => {
          const authz = this.authzs.get(id);
          return { url: this.url(`/authz/${id}`), name: authz.name, status: authz.status };
        }),
        certificate: o.certificate ? this.url(`/cert/${o.certificate}`) : null,
        error: o.error,
      })),
      attempts: this.attempts.map((a) => ({ ...a })),
      certificates: [...this.certs.values()].map((c) => ({
        url: this.url(`/cert/${c.id}`),
        order: this.url(`/order/${c.order}`),
        names: [...c.names],
        serial: c.serial,
        notBefore: c.notBefore,
        notAfter: c.notAfter,
        revoked: c.revoked,
      })),
    };
  }

  async control(req, res, name) {
    const reply = (status, body, headers) => send(res, status, body, headers);
    const body = async () => {
      const raw = await readBody(req, () => new Problem(413, 'The body is too large.'));
      if (!raw.trim()) return {};
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        value = null;
      }
      if (!isObject(value)) throw new Problem(400, 'The body must be a JSON object.');
      return value;
    };
    try {
      switch (`${req.method} ${name}`) {
        case 'GET state':
          return reply(200, this.state());
        case 'POST reset':
          this.reset();
          return reply(204);
        case 'POST fault': {
          const { kind, count = 1 } = await body();
          if (kind === null) {
            this.faults = {};
            return reply(204);
          }
          if (!FAULTS.includes(kind))
            throw new Problem(400, `kind: one of ${FAULTS.join(', ')}, or null to clear them.`);
          if (!Number.isInteger(count) || count < 0 || count > 1000)
            throw new Problem(400, 'count: 0 (to clear it) to 1000.');
          if (count === 0) delete this.faults[kind];
          else this.faults[kind] = count;
          return reply(204);
        }
        case 'POST lifetime': {
          const { days } = await body();
          if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0 || days > 3650)
            throw new Problem(400, 'days: a number above 0, at most 3650.');
          this.lifetimeDays = days;
          return reply(200, { days });
        }
        case 'POST challenge': {
          const { port, resolve } = await body();
          if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
            throw new Problem(400, 'port: 1 to 65535.');
          if (resolve !== undefined && (typeof resolve !== 'string' || resolve.length === 0))
            throw new Problem(400, 'resolve: the address challenges are fetched from.');
          if (port !== undefined) this.target.port = port;
          if (resolve !== undefined) this.target.resolve = resolve;
          return reply(200, { ...this.target });
        }
        case 'GET ca':
          return reply(200, this.ca.pem, { 'content-type': 'application/x-pem-file' });
        default:
          return ['state', 'reset', 'fault', 'lifetime', 'challenge', 'ca'].includes(name)
            ? reply(405, { error: 'method' })
            : reply(404, { error: 'unknown' });
      }
    } catch (error) {
      if (error instanceof Problem) return reply(error.status, { error: error.message });
      throw error;
    }
  }
}

/** Starts the mock; resolves with its base URL, its directory, the mock and a `close`. */
export async function startMockAcme({
  port = DEFAULT_PORT,
  host = '127.0.0.1',
  challengePort = 80,
  resolve = '127.0.0.1',
} = {}) {
  const mock = new MockAcme({ challengePort, resolve });
  const server = createServer((req, res) => {
    mock.handle(req, res).catch((error) => {
      if (res.headersSent) return res.end();
      send(
        res,
        500,
        {
          type: `${ERROR_PREFIX}serverInternal`,
          detail: String(error?.message ?? error),
          status: 500,
        },
        { 'content-type': 'application/problem+json' },
      );
    });
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, done);
  });
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  mock.origin = `http://${host.includes(':') ? `[${host}]` : host}:${bound}`;
  return {
    url: mock.origin,
    directory: `${mock.origin}/directory`,
    mock,
    close: () =>
      new Promise((done) => {
        mock.cancelPending();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const { directory, mock, close } = await startMockAcme({
    port: Number(option('port', process.env.ACME_MOCK_PORT ?? DEFAULT_PORT)),
    host: option('host', '127.0.0.1'),
    challengePort: Number(option('challenge-port', 80)),
    resolve: option('resolve', '127.0.0.1'),
  });
  const stop = () => void close().then(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  // One line at start, nothing per request: a parent process may never read the output.
  console.log(
    `Mock ACME server on ${directory} (challenges from ${mock.target.resolve}:${mock.target.port})`,
  );
}
