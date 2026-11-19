// A mock OpenID Connect provider for Workspace's single sign-on (Phase 11, M11.3): the server's
// sign-on module, its tests and the browser tests use it in place of a workspace's real provider.
// Plain Node (`node:http`, `node:crypto`), no dependencies.
//
//   node tests/mocks/oidc/server.mjs [--port 4287] [--host 127.0.0.1]
//
// The port also comes from OIDC_MOCK_PORT (or CGW_MOCK_OIDC_PORT, as the other mocks name theirs).
// The issuer is `http://<host>:<port>`: discovery, `/authorize` (the authorisation code flow, PKCE
// with S256 only), `/token` (`client_secret_post` or `client_secret_basic`), `/jwks` and
// `/userinfo`. Its keys are made at start and kept in memory only, never written anywhere: RSA
// 2048 (`rsa-1`, RS256) and P-256 (`ec-1`, ES256), published at `/jwks`, and a rogue key of each
// kind that is never published (the `wrongKey` fault). ID tokens are signed here, by hand.
//
// `/__mock/*` controls it: `reset`, `clients`, `next`, `fault`, `clock`, `requests` (secrets only
// as hashes), `state`, and `dns` (the DNS stand-in for proving a domain). Every route is also
// served under `/realms/<name>/`: a provider of its own, with its own issuer, clients, people
// queued, fault, clock, codes and requests, so tests sharing one running mock never meet each
// other's. README.md beside this file says the rest.

import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
} from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4287;

/** Lifetimes, on the realm's clock. */
export const LIFETIMES = { codeMs: 60_000, idTokenS: 300, accessTokenS: 3600 };

/** The algorithms a client's ID tokens may be signed with (`alg` when it is registered). */
export const ALGS = ['RS256', 'ES256'];

/** What `POST /__mock/fault` takes. Each lasts until it is replaced, cleared or reset. */
export const FAULTS = [
  'wrongKey',
  'algNone',
  'wrongAudience',
  'wrongIssuer',
  'expired',
  'nonce',
  'emailUnverified',
  'noEmail',
  'tokenError',
  'discoveryDown',
];

/** The people the sign-in page offers; `POST /__mock/next` can sign in anyone else. */
export const PEOPLE = [
  { id: 'ada', sub: 'sub-ada', email: 'ada@acme.test', name: 'Ada Lovelace', lang: 'en' },
  { id: 'omar', sub: 'sub-omar', email: 'omar@acme.test', name: 'عمر', lang: 'ar' },
  { id: 'zed', sub: 'sub-zed', email: 'zed@other.test', name: 'Zed', lang: 'en' },
  { id: 'owner', sub: 'sub-owner', email: 'owner@acme.test', name: 'Acme Owner', lang: 'en' },
];

/**
 * The one client the root provider has from the start (and again after a reset), for the dev and
 * e2e stacks' API on 5280. Tests register their own. A fixed value of a mock, as the mock ERP's
 * keys are, not a credential.
 */
export const DEV_CLIENT = {
  clientId: 'cgw-workspace-dev',
  clientSecret: 'mock-oidc-secret',
  redirectUris: [
    'http://127.0.0.1:5280/account/sso/callback',
    'http://localhost:5280/account/sso/callback',
  ],
  alg: 'RS256',
};

const MAX_BODY = 64 * 1024;
const MAX_KEPT = 500;
const MAX_CODES = 10_000;
const MAX_REALMS = 1_000;
const MAX_DNS = 10_000;
const REALM_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** RFC 7636: S256's challenge is 43 base64url characters; a verifier 43 to 128 unreserved ones. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** Values a request's record holds only as their hash. */
const SECRET_FIELDS = new Set([
  'client_secret',
  'code',
  'code_verifier',
  'access_token',
  'refresh_token',
  'id_token_hint',
]);
const ENDPOINTS = {
  '/.well-known/openid-configuration': 'discovery',
  '/authorize': 'authorize',
  '/token': 'token',
  '/jwks': 'jwks',
  '/userinfo': 'userinfo',
};

/** A secret's stand-in in every record: the first 16 hex digits of its SHA-256 (as the mock AI's `keyId`). */
export function hashOf(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

const sha256 = (value) => createHash('sha256').update(value).digest();
const b64url = (value) => Buffer.from(value).toString('base64url');
const random = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** A refusal of a control route or a body, as a status and words. */
class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------------------------
// Keys and tokens

function makeKeys() {
  const pair = (alg) =>
    alg === 'RS256'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keys = {};
  for (const [alg, kid] of [
    ['RS256', 'rsa-1'],
    ['ES256', 'ec-1'],
  ]) {
    const { publicKey, privateKey } = pair(alg);
    keys[alg] = {
      kid,
      privateKey,
      /** Never published: the `wrongKey` fault signs with it under the published `kid`. */
      rogue: pair(alg).privateKey,
      jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg },
    };
  }
  return keys;
}

/** A JWS in compact form. ES256's signature is JOSE's r || s (64 bytes), not DER. */
function signJwt(header, payload, privateKey) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  if (header.alg === 'none') return `${input}.`;
  const key = header.alg === 'ES256' ? { key: privateKey, dsaEncoding: 'ieee-p1363' } : privateKey;
  return `${input}.${b64url(sign('sha256', Buffer.from(input), key))}`;
}

/** The person's claims for the scopes asked, after the fault: in the ID token and at /userinfo. */
function personClaims(person, scopes, fault) {
  const claims = { sub: person.sub };
  if (scopes.includes('email') && fault !== 'noEmail') {
    claims.email = person.email;
    if (fault === 'emailUnverified') claims.email_verified = false;
    else if (person.emailVerified !== null) claims.email_verified = person.emailVerified;
  }
  if (scopes.includes('profile') && person.name) claims.name = person.name;
  return claims;
}

// ---------------------------------------------------------------------------------------------
// Bodies and answers

function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        fail(new Problem(413, 'The body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

const isForm = (req) =>
  /^application\/x-www-form-urlencoded\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''));

/** A parameter given exactly once, else undefined. */
function single(params, name) {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

/** RFC 6749 §3.1: no parameter more than once. */
const repeatedOf = (params) => [...new Set(params.keys())].find((k) => params.getAll(k).length > 1);

/** Parameters as a record holds them: secrets as `sha256:<hashOf>`, a repeated one as a list. */
function scrub(params) {
  const out = Object.create(null);
  for (const [name, value] of params) {
    const shown = SECRET_FIELDS.has(name) ? `sha256:${hashOf(value)}` : value;
    out[name] = Object.hasOwn(out, name) ? [].concat(out[name], shown) : shown;
  }
  return out;
}

/** RFC 6749 §2.3.1: the id and the secret are form-urlencoded, then joined and base64'd. */
function parseBasic(header) {
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(String(header).trim());
  if (!match) return null;
  const text = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  try {
    const decode = (part) => decodeURIComponent(part.replace(/\+/g, ' '));
    return { id: decode(text.slice(0, colon)), secret: decode(text.slice(colon + 1)) };
  } catch {
    return null;
  }
}

function send(res, entry, status, body, headers = {}) {
  if (entry) {
    entry.status = status;
    if (body && typeof body === 'object' && typeof body.error === 'string')
      entry.error = body.error;
  }
  const json = body !== undefined && typeof body === 'object';
  res.writeHead(status, {
    'content-type': json ? 'application/json' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body === undefined ? '' : json ? JSON.stringify(body) : String(body));
}

// ---------------------------------------------------------------------------------------------
// The sign-in page: plain HTML, no script, in English or Arabic by `ui_locales`.

const WORDS = {
  en: {
    title: 'Mock sign-in',
    heading: 'Sign in to the mock provider',
    choose: 'Choose who signs in.',
    hint: 'Sign-in hint from the app:',
    cancel: 'Cancel',
    refused: 'This sign-in cannot start',
    unknownClient: 'This client is not registered with the mock provider.',
    badRedirect: 'This redirect address is not registered for the client.',
    badForm: 'The request is not a form.',
    choosePerson: 'Choose one of the people below.',
  },
  ar: {
    title: 'تسجيل دخول تجريبي',
    heading: 'تسجيل الدخول لدى المزوّد التجريبي',
    choose: 'اختر من يسجّل الدخول.',
    hint: 'تلميح تسجيل الدخول من التطبيق:',
    cancel: 'إلغاء',
    refused: 'تعذّر بدء تسجيل الدخول هذا',
    unknownClient: 'هذا العميل غير مسجّل لدى المزوّد التجريبي.',
    badRedirect: 'عنوان الرجوع هذا غير مسجّل لهذا العميل.',
    badForm: 'الطلب ليس نموذجاً.',
    choosePerson: 'اختر أحد الأشخاص أدناه.',
  },
};

const CSS = [
  ':root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#474747;--line:#767676;--button:#f2f2f2;--focus:#0b57d0}',
  '@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#f0f0f0;--muted:#c8c8c8;--line:#8f8f8f;--button:#242424;--focus:#8ab4f8}}',
  'body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}',
  'main{max-inline-size:32rem;margin-inline:auto;padding-block:2rem;padding-inline:1rem}',
  'h1{font-size:1.5rem;margin-block:0 .5rem}',
  'p{margin-block:0 1rem;color:var(--muted)}',
  'ul{list-style:none;margin-block:0 1rem;margin-inline:0;padding:0;display:grid;gap:.5rem}',
  'button{display:block;inline-size:100%;min-block-size:44px;padding-block:.5rem;padding-inline:1rem;border:1px solid var(--line);border-radius:8px;background:var(--button);color:var(--fg);font:inherit;text-align:start;cursor:pointer}',
  'button:focus-visible{outline:3px solid var(--focus);outline-offset:2px}',
  '.name,.email{display:block}',
  '.email{color:var(--muted);font-size:.875rem}',
  '.cancel{text-align:center}',
].join('\n');

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': `default-src 'none'; style-src 'sha256-${createHash('sha256').update(CSS).digest('base64')}'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const esc = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** `ui_locales`' first language the page has. */
function languageOf(uiLocales) {
  for (const tag of String(uiLocales ?? '').split(' ')) {
    const lang = tag.toLowerCase().split('-')[0];
    if (lang === 'ar' || lang === 'en') return lang;
  }
  return 'en';
}

function htmlPage(lang, body) {
  const words = WORDS[lang];
  return [
    '<!doctype html>',
    `<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(words.title)}</title><style>${CSS}</style></head>`,
    `<body><main>${body}</main></body></html>`,
  ].join('\n');
}

function refusedPage(lang, reason) {
  const words = WORDS[lang];
  return htmlPage(lang, `<h1>${esc(words.refused)}</h1><p>${esc(words[reason])}</p>`);
}

function chooserPage(lang, realm, params, again) {
  const words = WORDS[lang];
  const hidden = [...params]
    .filter(([name]) => name !== 'person' && name !== 'cancel')
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
    .join('');
  const hint = params.get('login_hint');
  const people = PEOPLE.map(
    (p) =>
      `<li><button type="submit" name="person" value="${esc(p.id)}">` +
      `<span class="name"><bdi lang="${p.lang}" dir="${p.lang === 'ar' ? 'rtl' : 'ltr'}">${esc(p.name)}</bdi></span> ` +
      `<span class="email"><bdi dir="ltr">${esc(p.email)}</bdi></span></button></li>`,
  ).join('');
  return htmlPage(
    lang,
    [
      `<h1>${esc(words.heading)}</h1>`,
      `<p>${esc(again ? words.choosePerson : words.choose)}</p>`,
      hint ? `<p>${esc(words.hint)} <bdi dir="ltr">${esc(hint)}</bdi></p>` : '',
      `<form method="post" action="${esc(realm.path)}/authorize">${hidden}`,
      `<ul>${people}</ul>`,
      `<button type="submit" name="cancel" value="1" class="cancel">${esc(words.cancel)}</button>`,
      '</form>',
    ].join(''),
  );
}

// ---------------------------------------------------------------------------------------------
// A realm: one provider's state. The root realm is the issuer `http://<host>:<port>`.

class Realm {
  constructor(mock, name) {
    this.mock = mock;
    this.name = name;
    this.path = name === null ? '' : `/realms/${name}`;
    this.reset();
  }

  get issuer() {
    return this.mock.origin + this.path;
  }

  reset() {
    /** clientId → { clientId, secret (its SHA-256), redirectUris, alg }. */
    this.clients = new Map();
    if (this.name === null) this.register(DEV_CLIENT);
    /** People (or refusals) queued by `/__mock/next`, each taken by one `GET /authorize`. */
    this.next = [];
    this.fault = null;
    this.offsetMs = 0;
    this.codes = new Map();
    this.tokens = new Map();
    this.requests = [];
  }

  now() {
    return Date.now() + this.offsetMs;
  }

  register(body) {
    const { clientId, clientSecret, redirectUris, alg = 'RS256' } = body ?? {};
    const printable = (value, max) =>
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= max &&
      !/[\p{Cc}\p{Cf}]/u.test(value);
    if (!printable(clientId, 200)) throw new Problem(400, 'clientId: 1 to 200 visible characters.');
    if (!printable(clientSecret, 500))
      throw new Problem(400, 'clientSecret: 1 to 500 visible characters.');
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 20)
      throw new Problem(400, 'redirectUris: 1 to 20 absolute addresses.');
    for (const uri of redirectUris) {
      let parsed;
      try {
        parsed = new URL(uri);
      } catch {
        parsed = null;
      }
      if (
        typeof uri !== 'string' ||
        !parsed ||
        !/^https?:$/.test(parsed.protocol) ||
        parsed.hash ||
        uri.length > 2000
      )
        throw new Problem(400, `redirectUris: ${String(uri)} is not an absolute http(s) address.`);
    }
    if (!ALGS.includes(alg)) throw new Problem(400, `alg: one of ${ALGS.join(', ')}.`);
    this.clients.set(clientId, {
      clientId,
      secret: sha256(clientSecret),
      redirectUris: [...redirectUris],
      alg,
    });
    return this.clientDto(this.clients.get(clientId));
  }

  /** A client as the controls show it: never its secret. */
  clientDto(client) {
    return { clientId: client.clientId, redirectUris: [...client.redirectUris], alg: client.alg };
  }

  record(endpoint, req, url) {
    const entry = {
      id: randomUUID(),
      at: new Date(this.now()).toISOString(),
      endpoint,
      method: req.method ?? 'GET',
      /** The headers' names, never their values. */
      headers: Object.keys(req.headers).sort(),
      query: scrub(url.searchParams),
      form: null,
      clientId: null,
      /** `client_secret_post` or `client_secret_basic` at /token. */
      auth: null,
      /** `hashOf` the client secret presented at /token. */
      secretHash: null,
      /** `hashOf` the access token presented at /userinfo. */
      tokenHash: null,
      sub: null,
      status: null,
      error: null,
    };
    this.requests.push(entry);
    if (this.requests.length > MAX_KEPT) this.requests.shift();
    return entry;
  }

  prune() {
    const now = this.now();
    for (const [code, grant] of this.codes)
      if (now > grant.issuedAt + LIFETIMES.codeMs) this.codes.delete(code);
    for (const [token, held] of this.tokens) if (now > held.expiresAt) this.tokens.delete(token);
    while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value);
  }

  state() {
    return {
      issuer: this.issuer,
      clients: [...this.clients.keys()],
      next: this.next.length,
      fault: this.fault,
      offsetMs: this.offsetMs,
      codes: this.codes.size,
      tokens: this.tokens.size,
      requests: this.requests.length,
    };
  }
}

/** What `POST /__mock/next` takes: a person (`email`, and `sub`, `name`, `emailVerified`), or a refusal (`error`). */
function nextPerson(body) {
  if (body.error !== undefined) {
    if (typeof body.error !== 'string' || !/^[a-z_]{1,64}$/.test(body.error))
      throw new Problem(400, 'error: an OAuth error code, such as access_denied.');
    return { error: body.error };
  }
  const { email, sub, name, emailVerified } = body;
  if (typeof email !== 'string' || email.length === 0 || email.length > 320)
    throw new Problem(400, 'email: 1 to 320 characters.');
  if (sub !== undefined && (typeof sub !== 'string' || sub.length === 0 || sub.length > 255))
    throw new Problem(400, 'sub: 1 to 255 characters.');
  if (name !== undefined && name !== null && (typeof name !== 'string' || name.length > 200))
    throw new Problem(400, 'name: at most 200 characters, or null for none.');
  if (emailVerified !== undefined && emailVerified !== null && typeof emailVerified !== 'boolean')
    throw new Problem(400, 'emailVerified: true, false, or null to leave the claim out.');
  const seeded = PEOPLE.find((p) => p.email === email.toLowerCase());
  return {
    // The same email signs in as the same `sub` every time, unless the test names one.
    sub: sub ?? seeded?.sub ?? `sub-${hashOf(email.toLowerCase())}`,
    email,
    name: name !== undefined ? name : (seeded?.name ?? null),
    emailVerified: emailVerified !== undefined ? emailVerified : true,
  };
}

// ---------------------------------------------------------------------------------------------
// The provider

export class MockOidc {
  constructor() {
    /** Set by `startMockOidc` once it listens. */
    this.origin = `http://127.0.0.1:${DEFAULT_PORT}`;
    this.keys = makeKeys();
    /** name → TXT strings: global, whichever realm's route set them. */
    this.dns = new Map();
    this.root = new Realm(this, null);
    this.realms = new Map();
  }

  realm(name) {
    let realm = this.realms.get(name);
    if (!realm) {
      if (this.realms.size >= MAX_REALMS) this.realms.delete(this.realms.keys().next().value);
      realm = new Realm(this, name);
      this.realms.set(name, realm);
    }
    return realm;
  }

  /** Back to the start: every realm forgotten, no DNS record, the root with its one client. Keys stay. */
  reset() {
    this.realms.clear();
    this.dns.clear();
    this.root.reset();
  }

  jwks() {
    return { keys: ALGS.map((alg) => this.keys[alg].jwk) };
  }

  discovery(realm) {
    const issuer = realm.issuer;
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: [...ALGS],
      scopes_supported: ['openid', 'email', 'profile'],
      claims_supported: [
        'iss',
        'sub',
        'aud',
        'exp',
        'iat',
        'auth_time',
        'nonce',
        'at_hash',
        'email',
        'email_verified',
        'name',
      ],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      authorization_response_iss_parameter_supported: true,
      ui_locales_supported: ['en', 'ar'],
    };
  }

  async handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://mock');
    let realm = this.root;
    let path = url.pathname;
    const scoped = /^\/realms\/([^/]*)(\/.*)?$/.exec(path);
    if (scoped) {
      if (!REALM_NAME.test(scoped[1])) return send(res, null, 404, { error: 'not_found' });
      realm = this.realm(scoped[1]);
      path = scoped[2] ?? '/';
    }
    if (path.startsWith('/__mock/'))
      return this.control(realm, req, res, url, path.slice('/__mock/'.length));
    // Browsers ask for it on the sign-in page; a 404 would be logged as a console error.
    if (path === '/favicon.ico') return send(res, null, 204);
    const endpoint = ENDPOINTS[path];
    if (!endpoint) return send(res, null, 404, { error: 'not_found' });
    const entry = realm.record(endpoint, req, url);
    const allowed =
      endpoint === 'token'
        ? ['POST']
        : endpoint === 'jwks' || endpoint === 'discovery'
          ? ['GET']
          : ['GET', 'POST'];
    if (!allowed.includes(req.method))
      return send(res, entry, 405, { error: 'invalid_request' }, { allow: allowed.join(', ') });
    switch (endpoint) {
      case 'discovery':
        if (realm.fault === 'discoveryDown')
          return send(
            res,
            entry,
            503,
            { error: 'temporarily_unavailable', error_description: 'Mock fault: discoveryDown.' },
            { 'retry-after': '1' },
          );
        return send(res, entry, 200, this.discovery(realm));
      case 'jwks':
        return send(res, entry, 200, this.jwks());
      case 'authorize':
        return this.authorize(realm, req, res, url, entry);
      case 'token':
        return this.token(realm, req, res, entry);
      default:
        return this.userinfo(realm, req, res, entry);
    }
  }

  async authorize(realm, req, res, url, entry) {
    let params = url.searchParams;
    if (req.method === 'POST') {
      if (!isForm(req)) {
        entry.error = 'invalid_request';
        return send(res, entry, 400, refusedPage('en', 'badForm'), HTML_HEADERS);
      }
      params = new URLSearchParams(await readBody(req));
      entry.form = scrub(params);
    }
    const lang = languageOf(params.get('ui_locales'));
    // A client or redirect address the mock does not know is never redirected to (RFC 6749 §4.1.2.1).
    const client = realm.clients.get(single(params, 'client_id'));
    if (!client) {
      entry.error = 'unknown_client';
      return send(res, entry, 400, refusedPage(lang, 'unknownClient'), HTML_HEADERS);
    }
    entry.clientId = client.clientId;
    const redirectUri = single(params, 'redirect_uri');
    if (redirectUri === undefined || !client.redirectUris.includes(redirectUri)) {
      entry.error = 'invalid_redirect_uri';
      return send(res, entry, 400, refusedPage(lang, 'badRedirect'), HTML_HEADERS);
    }
    const state = params.get('state');
    const back = (values) => {
      const to = new URL(redirectUri);
      for (const [name, value] of Object.entries(values))
        if (value !== null && value !== undefined) to.searchParams.set(name, value);
      entry.status = 302;
      entry.error = values.error ?? null;
      res.writeHead(302, { location: to.href, 'cache-control': 'no-store' });
      res.end();
    };
    const refuse = (error, description) =>
      back({ error, error_description: description, state, iss: realm.issuer });

    const repeated = repeatedOf(params);
    if (repeated) return refuse('invalid_request', `${repeated} is given more than once.`);
    if (params.get('response_type') !== 'code')
      return refuse('unsupported_response_type', 'Only response_type=code is supported.');
    const mode = params.get('response_mode');
    if (mode !== null && mode !== 'query')
      return refuse('invalid_request', 'Only response_mode=query is supported.');
    const scopes = (params.get('scope') ?? '').split(' ').filter(Boolean);
    if (!scopes.includes('openid')) return refuse('invalid_scope', 'The scope must hold openid.');
    if (params.get('code_challenge_method') !== 'S256')
      return refuse('invalid_request', 'PKCE is required, with code_challenge_method=S256.');
    const challenge = params.get('code_challenge') ?? '';
    if (!CHALLENGE.test(challenge))
      return refuse('invalid_request', 'code_challenge must be 43 base64url characters.');

    let person;
    if (req.method === 'POST') {
      if (params.has('cancel')) return refuse('access_denied', 'The person cancelled the sign-in.');
      const chosen = PEOPLE.find((p) => p.id === params.get('person'));
      if (!chosen) {
        entry.error = 'no_person';
        return send(res, entry, 400, chooserPage(lang, realm, params, true), HTML_HEADERS);
      }
      person = { sub: chosen.sub, email: chosen.email, name: chosen.name, emailVerified: true };
    } else {
      // Only `next` skips the page: `login_hint` is shown on it, and chooses nobody.
      const next = realm.next.shift();
      if (!next)
        return send(res, entry, 200, chooserPage(lang, realm, params, false), HTML_HEADERS);
      if (next.error) return refuse(next.error, 'The mock was told to refuse this sign-in.');
      person = next;
    }
    realm.prune();
    const code = random(32);
    realm.codes.set(code, {
      clientId: client.clientId,
      redirectUri,
      challenge,
      nonce: params.get('nonce'),
      scopes,
      person,
      issuedAt: realm.now(),
    });
    entry.sub = person.sub;
    return back({ code, state, iss: realm.issuer });
  }

  async token(realm, req, res, entry) {
    const refuse = (status, error, description, headers = {}) =>
      send(res, entry, status, { error, error_description: description }, headers);
    if (!isForm(req))
      return refuse(400, 'invalid_request', 'The body must be application/x-www-form-urlencoded.');
    const form = new URLSearchParams(await readBody(req));
    entry.form = scrub(form);
    if (realm.fault === 'tokenError')
      return refuse(400, 'invalid_grant', 'Mock fault: tokenError refuses every exchange.');
    const repeated = repeatedOf(form);
    if (repeated) return refuse(400, 'invalid_request', `${repeated} is given more than once.`);

    const challengeHeader = { 'www-authenticate': 'Basic realm="mock-oidc"' };
    let basic = null;
    if (req.headers.authorization !== undefined) {
      basic = parseBasic(req.headers.authorization);
      if (!basic)
        return refuse(
          401,
          'invalid_client',
          'Authorization is not client_secret_basic.',
          challengeHeader,
        );
    }
    const postSecret = form.get('client_secret');
    if (basic && postSecret !== null)
      return refuse(400, 'invalid_request', 'One client authentication method, not two.');
    if (basic && form.has('client_id') && form.get('client_id') !== basic.id)
      return refuse(400, 'invalid_request', 'client_id differs from the Authorization header.');
    const clientId = basic ? basic.id : form.get('client_id');
    const secret = basic ? basic.secret : postSecret;
    entry.clientId = clientId;
    entry.auth = basic ? 'client_secret_basic' : postSecret !== null ? 'client_secret_post' : null;
    entry.secretHash = secret === null ? null : hashOf(secret);
    if (secret === null)
      return refuse(
        401,
        'invalid_client',
        'Authenticate: client_secret_post or client_secret_basic.',
      );
    const client = realm.clients.get(clientId);
    if (!client || !timingSafeEqual(sha256(secret), client.secret))
      return refuse(
        401,
        'invalid_client',
        'Unknown client, or the wrong secret.',
        basic ? challengeHeader : {},
      );

    if (form.get('grant_type') !== 'authorization_code')
      return refuse(400, 'unsupported_grant_type', 'Only authorization_code is supported.');
    const code = form.get('code') ?? '';
    const grant = realm.codes.get(code);
    // One use: any exchange by an authenticated client that names a code spends it.
    realm.codes.delete(code);
    if (!grant) return refuse(400, 'invalid_grant', 'The code is unknown, or was used already.');
    if (grant.clientId !== client.clientId)
      return refuse(400, 'invalid_grant', 'The code was issued to another client.');
    if (realm.now() > grant.issuedAt + LIFETIMES.codeMs)
      return refuse(400, 'invalid_grant', 'The code has expired (60 s).');
    if (form.get('redirect_uri') !== grant.redirectUri)
      return refuse(400, 'invalid_grant', 'redirect_uri is not the authorisation request’s.');
    const verifier = form.get('code_verifier') ?? '';
    if (!VERIFIER.test(verifier) || b64url(sha256(verifier)) !== grant.challenge)
      return refuse(400, 'invalid_grant', 'code_verifier does not match the code_challenge.');

    realm.prune();
    const fault = realm.fault;
    const claims = personClaims(grant.person, grant.scopes, fault);
    const accessToken = random(32);
    realm.tokens.set(accessToken, {
      claims,
      expiresAt: realm.now() + LIFETIMES.accessTokenS * 1000,
    });
    entry.sub = grant.person.sub;
    return send(
      res,
      entry,
      200,
      {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: LIFETIMES.accessTokenS,
        scope: grant.scopes.join(' '),
        id_token: this.idToken(realm, client, grant, claims, accessToken, fault),
      },
      { pragma: 'no-cache' },
    );
  }

  idToken(realm, client, grant, claims, accessToken, fault) {
    const key = this.keys[client.alg];
    const now = Math.floor(realm.now() / 1000);
    // Expired: issued 15 minutes ago, ended 10 minutes ago, well past any clock skew.
    const iat = fault === 'expired' ? now - 900 : now;
    const payload = {
      iss: fault === 'wrongIssuer' ? `${realm.issuer}/wrong` : realm.issuer,
      sub: claims.sub,
      aud: fault === 'wrongAudience' ? `${client.clientId}-other` : client.clientId,
      exp: iat + LIFETIMES.idTokenS,
      iat,
      auth_time: Math.min(iat, Math.floor(grant.issuedAt / 1000)),
    };
    if (fault === 'nonce') payload.nonce = grant.nonce ? `${grant.nonce}-other` : random(16);
    else if (grant.nonce !== null) payload.nonce = grant.nonce;
    // OpenID Connect Core §3.3.2.11: the left half of the access token's SHA-256.
    payload.at_hash = b64url(sha256(accessToken).subarray(0, 16));
    Object.assign(payload, claims);
    const header =
      fault === 'algNone'
        ? { alg: 'none', typ: 'JWT' }
        : { alg: client.alg, typ: 'JWT', kid: key.kid };
    return signJwt(header, payload, fault === 'wrongKey' ? key.rogue : key.privateKey);
  }

  async userinfo(realm, req, res, entry) {
    let token = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;
    if (!token && req.method === 'POST' && isForm(req)) {
      const form = new URLSearchParams(await readBody(req));
      entry.form = scrub(form);
      token = form.get('access_token');
    }
    entry.tokenHash = token ? hashOf(token) : null;
    const held = token ? realm.tokens.get(token) : undefined;
    if (!held || realm.now() > held.expiresAt)
      return send(
        res,
        entry,
        401,
        {
          error: 'invalid_token',
          error_description: 'No access token, or not one of this provider’s.',
        },
        { 'www-authenticate': 'Bearer error="invalid_token"' },
      );
    entry.sub = held.claims.sub;
    return send(res, entry, 200, held.claims);
  }

  async control(realm, req, res, url, name) {
    const reply = (status, body) => send(res, null, status, body);
    const body = async () => {
      const raw = await readBody(req);
      if (!raw.trim()) return {};
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        value = null;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Problem(400, 'The body must be a JSON object.');
      return value;
    };
    try {
      switch (`${req.method} ${name}`) {
        case 'GET state':
          return reply(200, {
            ...realm.state(),
            ...(realm === this.root ? { realms: this.realms.size, dns: this.dns.size } : {}),
          });
        case 'GET requests': {
          const endpoint = url.searchParams.get('endpoint');
          const clientId = url.searchParams.get('clientId');
          return reply(200, {
            requests: realm.requests.filter(
              (r) =>
                (!endpoint || r.endpoint === endpoint) && (!clientId || r.clientId === clientId),
            ),
          });
        }
        case 'GET clients':
          return reply(200, {
            clients: [...realm.clients.values()].map((c) => realm.clientDto(c)),
          });
        case 'POST clients':
          return reply(201, realm.register(await body()));
        case 'POST next':
          realm.next.push(nextPerson(await body()));
          return reply(204);
        case 'POST fault': {
          const { kind } = await body();
          if (kind !== null && !FAULTS.includes(kind))
            throw new Problem(400, `kind: one of ${FAULTS.join(', ')}, or null to clear it.`);
          realm.fault = kind;
          return reply(204);
        }
        case 'POST clock': {
          const { advanceMs } = await body();
          if (!Number.isFinite(advanceMs)) throw new Problem(400, 'advanceMs: a number.');
          realm.offsetMs += advanceMs;
          return reply(200, { offsetMs: realm.offsetMs });
        }
        case 'POST reset':
          if (realm === this.root) this.reset();
          else realm.reset();
          return reply(204);
        case 'GET dns': {
          const entry = realm.record('dns', req, url);
          const asked = url.searchParams.get('name');
          if (!asked) return send(res, entry, 400, { error: 'name: the record name to look up.' });
          return send(res, entry, 200, { txt: [...(this.dns.get(dnsName(asked)) ?? [])] });
        }
        case 'POST dns': {
          const { name: named, txt } = await body();
          if (typeof named !== 'string' || !dnsName(named) || named.length > 253)
            throw new Problem(400, 'name: a DNS name.');
          const list = txt === null || txt === undefined ? [] : [].concat(txt);
          if (list.length > 20 || list.some((t) => typeof t !== 'string' || t.length > 4096))
            throw new Problem(400, 'txt: a string or up to 20 of them, or null to remove.');
          if (list.length === 0) this.dns.delete(dnsName(named));
          else {
            if (this.dns.size >= MAX_DNS && !this.dns.has(dnsName(named)))
              this.dns.delete(this.dns.keys().next().value);
            this.dns.set(dnsName(named), list);
          }
          return reply(204);
        }
        default:
          return [
            'state',
            'requests',
            'clients',
            'next',
            'fault',
            'clock',
            'reset',
            'dns',
          ].includes(name)
            ? reply(405, { error: 'method' })
            : reply(404, { error: 'unknown' });
      }
    } catch (error) {
      if (error instanceof Problem) return reply(error.status, { error: error.message });
      throw error;
    }
  }
}

/** A DNS name as the stand-in keys it: lower case, no final dot. */
const dnsName = (name) => String(name).trim().toLowerCase().replace(/\.$/, '');

/** Starts the mock; resolves with its issuer, the mock and a `close`. */
export async function startMockOidc({ port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const mock = new MockOidc();
  const server = createServer((req, res) => {
    mock.handle(req, res).catch((error) => {
      if (res.headersSent) return res.end();
      const status = error instanceof Problem ? error.status : 500;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: status === 500 ? 'server_error' : error.message }));
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
    mock,
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const port = Number(
    option('port', process.env.OIDC_MOCK_PORT ?? process.env.CGW_MOCK_OIDC_PORT ?? DEFAULT_PORT),
  );
  const { url, close } = await startMockOidc({ port, host: option('host', '127.0.0.1') });
  const stop = () => void close().then(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  // One line at start, nothing per request: the server's tests do not read the mock's output.
  console.log(`Mock OpenID Connect provider on ${url}`);
}
