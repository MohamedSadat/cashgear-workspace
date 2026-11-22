// The mock OpenID Connect provider's own test (README.md beside it): discovery, the code flow with
// PKCE, ID tokens that verify with node:crypto against its JWKS (RS256, and ES256 in JOSE form),
// the code's rules, client authentication, the sign-in page, the controls, and each fault doing
// what its name says. Each case runs in a realm of its own on one mock, as the server's tests do.

import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
  type JsonWebKey,
} from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEV_CLIENT,
  FAULTS,
  LIFETIMES,
  PEOPLE,
  hashOf,
  startMockOidc,
  type MockOidcAlg,
  type MockOidcFault,
  type MockOidcNext,
  type MockOidcRequest,
} from './server.mjs';

const REDIRECT = 'http://127.0.0.1:5280/account/sso/callback';

let mock: Awaited<ReturnType<typeof startMockOidc>>;
beforeAll(async () => {
  mock = await startMockOidc({ port: 0 });
});
afterAll(async () => {
  await mock?.close();
});

type Json = Record<string, unknown>;
const b64url = (bytes: Buffer) => bytes.toString('base64url');
const fromB64url = (text: string) => Buffer.from(text, 'base64url');
const nowS = () => Math.floor(Date.now() / 1000);

interface Provider {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

function control(issuer: string, name: string, body: unknown) {
  return fetch(`${issuer}/__mock/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A provider of its own: a fresh realm with a client registered (a secret that needs encoding). */
async function provider(alg: MockOidcAlg = 'RS256'): Promise<Provider> {
  const issuer = `${mock.url}/realms/${randomUUID()}`;
  const client = {
    clientId: `cgw-${randomUUID()}`,
    clientSecret: `s3cret+/:% ${randomUUID()}`,
    redirectUris: [REDIRECT],
    alg,
  };
  const res = await control(issuer, 'clients', client);
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ clientId: client.clientId, redirectUris: [REDIRECT], alg });
  return { issuer, clientId: client.clientId, clientSecret: client.clientSecret };
}

async function discovery(issuer: string): Promise<Json> {
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  expect(res.status).toBe(200);
  return (await res.json()) as Json;
}

function start(p: Provider, extra: Record<string, string> = {}) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = randomUUID();
  const nonce = randomUUID();
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: REDIRECT,
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    response_mode: 'query',
    login_hint: 'ada@acme.test',
    ...extra,
  });
  return { verifier, state, nonce, query };
}

/** GET /authorize without following its redirect. */
function authorize(p: Provider, query: URLSearchParams) {
  return fetch(`${p.issuer}/authorize?${query}`, { redirect: 'manual' });
}

/** Where a redirect sends the browser back: the registered address, with its parameters. */
function callback(res: Response) {
  expect(res.status).toBe(302);
  const to = new URL(res.headers.get('location') ?? '');
  expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
  return to.searchParams;
}

const basicOf = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

/** POST /token, the client authenticated by post or basic. */
function exchange(p: Provider, form: Record<string, string>, how: 'post' | 'basic' = 'post') {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT,
    ...form,
  });
  if (how === 'basic') headers.authorization = basicOf(p.clientId, p.clientSecret);
  else {
    body.set('client_id', p.clientId);
    body.set('client_secret', p.clientSecret);
  }
  return fetch(`${p.issuer}/token`, { method: 'POST', headers, body });
}

/** `next` (if given), then authorize and exchange: the token endpoint's answer. */
async function signIn(p: Provider, next?: MockOidcNext, how: 'post' | 'basic' = 'post') {
  if (next) expect((await control(p.issuer, 'next', next)).status).toBe(204);
  const started = start(p);
  const back = callback(await authorize(p, started.query));
  expect(back.get('state')).toBe(started.state);
  expect(back.get('iss')).toBe(p.issuer);
  const code = back.get('code') ?? '';
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const res = await exchange(p, { code, code_verifier: started.verifier }, how);
  return { res, started, code };
}

async function tokens(p: Provider, next: MockOidcNext = { email: 'ada@acme.test' }) {
  const { res, started, code } = await signIn(p, next);
  expect(res.status).toBe(200);
  const body = (await res.json()) as Json;
  return { body, started, code, idToken: String(body.id_token) };
}

/** The ID token's parts, and its signature checked with node:crypto against the JWKS by `kid`. */
async function check(issuer: string, token: string) {
  const parts = token.split('.');
  expect(parts).toHaveLength(3);
  const [h, p, s] = parts;
  const header = JSON.parse(fromB64url(h).toString('utf8')) as Json;
  const payload = JSON.parse(fromB64url(p).toString('utf8')) as Json;
  const signature = fromB64url(s);
  const jwksUri = String((await discovery(issuer)).jwks_uri);
  const jwks = (await (await fetch(jwksUri)).json()) as { keys: (JsonWebKey & { kid: string })[] };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  let valid = false;
  if (jwk && (header.alg === 'RS256' || header.alg === 'ES256')) {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const data = Buffer.from(`${h}.${p}`);
    valid =
      header.alg === 'RS256'
        ? verify('sha256', data, key, signature)
        : verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  }
  return { header, payload, signature, valid, raw: parts };
}

async function requests(issuer: string, endpoint?: string): Promise<MockOidcRequest[]> {
  const res = await fetch(`${issuer}/__mock/requests${endpoint ? `?endpoint=${endpoint}` : ''}`);
  return ((await res.json()) as { requests: MockOidcRequest[] }).requests;
}

describe('discovery and keys', () => {
  it('publishes the discovery document the server reads', async () => {
    const doc = await discovery(mock.url);
    expect(doc).toMatchObject({
      issuer: mock.url,
      authorization_endpoint: `${mock.url}/authorize`,
      token_endpoint: `${mock.url}/token`,
      userinfo_endpoint: `${mock.url}/userinfo`,
      jwks_uri: `${mock.url}/jwks`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      id_token_signing_alg_values_supported: ['RS256', 'ES256'],
    });
    expect(mock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const realm = `${mock.url}/realms/r-${randomUUID()}`;
    expect((await discovery(realm)).issuer).toBe(realm);
  });

  it('publishes the two public keys and nothing private', async () => {
    const { keys } = (await (await fetch(`${mock.url}/jwks`)).json()) as { keys: Json[] };
    expect(keys.map((k) => [k.kid, k.kty, k.alg, k.use])).toEqual([
      ['rsa-1', 'RSA', 'RS256', 'sig'],
      ['ec-1', 'EC', 'ES256', 'sig'],
    ]);
    expect(fromB64url(String(keys[0].n))).toHaveLength(256);
    expect(keys[1].crv).toBe('P-256');
    for (const key of keys)
      for (const part of ['d', 'p', 'q', 'dp', 'dq', 'qi']) expect(key).not.toHaveProperty(part);
  });

  it('has the dev stack’s client from the start, never showing a secret', async () => {
    const res = await fetch(`${mock.url}/__mock/clients`);
    const body = (await res.json()) as { clients: Json[] };
    expect(body.clients).toContainEqual({
      clientId: DEV_CLIENT.clientId,
      redirectUris: DEV_CLIENT.redirectUris,
      alg: 'RS256',
    });
    expect(JSON.stringify(body)).not.toContain(DEV_CLIENT.clientSecret);
  });
});

describe('the code flow', () => {
  it('signs an RS256 ID token that verifies against the JWKS', async () => {
    const p = await provider('RS256');
    const { body, started, idToken } = await tokens(p);
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: LIFETIMES.accessTokenS });
    const { header, payload, valid } = await check(p.issuer, idToken);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'rsa-1' });
    expect(valid).toBe(true);
    expect(payload).toMatchObject({
      iss: p.issuer,
      aud: p.clientId,
      sub: 'sub-ada',
      nonce: started.nonce,
      email: 'ada@acme.test',
      email_verified: true,
      name: 'Ada Lovelace',
    });
    const iat = Number(payload.iat);
    expect(Math.abs(iat - nowS())).toBeLessThanOrEqual(2);
    expect(Number(payload.exp) - iat).toBe(LIFETIMES.idTokenS);
    const atHash = b64url(
      createHash('sha256').update(String(body.access_token)).digest().subarray(0, 16),
    );
    expect(payload.at_hash).toBe(atHash);

    const info = await fetch(`${p.issuer}/userinfo`, {
      headers: { authorization: `Bearer ${String(body.access_token)}` },
    });
    expect(info.status).toBe(200);
    expect(await info.json()).toEqual({
      sub: 'sub-ada',
      email: 'ada@acme.test',
      email_verified: true,
      name: 'Ada Lovelace',
    });
    const refused = await fetch(`${p.issuer}/userinfo`, { headers: { authorization: 'Bearer x' } });
    expect(refused.status).toBe(401);
  });

  it('signs ES256 in JOSE form (r || s, 64 bytes), not DER', async () => {
    const p = await provider('ES256');
    const { idToken } = await tokens(p);
    const { header, signature, valid, payload } = await check(p.issuer, idToken);
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'ec-1' });
    expect(signature).toHaveLength(64);
    expect(valid).toBe(true);
    expect(payload.iss).toBe(p.issuer);
  });

  it('authenticates the client by client_secret_basic, its parts form-encoded', async () => {
    const p = await provider();
    const { res } = await signIn(p, { email: 'ada@acme.test' }, 'basic');
    expect(res.status).toBe(200);
    const [token] = await requests(p.issuer, 'token');
    expect(token).toMatchObject({
      auth: 'client_secret_basic',
      clientId: p.clientId,
      secretHash: hashOf(p.clientSecret),
      status: 200,
    });
  });

  it('records what it was sent, secrets only as hashes', async () => {
    const p = await provider();
    const { res, started, code } = await signIn(p, { email: 'ada@acme.test' });
    const { access_token: accessToken } = (await res.json()) as { access_token: string };
    await fetch(`${p.issuer}/userinfo`, { headers: { authorization: `Bearer ${accessToken}` } });
    const all = await requests(p.issuer);
    expect(all.map((r) => r.endpoint)).toEqual(['authorize', 'token', 'userinfo']);
    const [auth, token, info] = all;
    expect(auth.query).toMatchObject({
      client_id: p.clientId,
      code_challenge_method: 'S256',
      login_hint: 'ada@acme.test',
      nonce: started.nonce,
      state: started.state,
    });
    expect(token.form).toMatchObject({
      client_secret: `sha256:${hashOf(p.clientSecret)}`,
      code: `sha256:${hashOf(code)}`,
      code_verifier: `sha256:${hashOf(started.verifier)}`,
    });
    expect(token).toMatchObject({ auth: 'client_secret_post', secretHash: hashOf(p.clientSecret) });
    expect(info.tokenHash).toBe(hashOf(accessToken));
    expect(info.headers).toContain('authorization');
    const text = JSON.stringify(all);
    for (const secret of [p.clientSecret, code, started.verifier, accessToken])
      expect(text).not.toContain(secret);
  });

  it('shows the seeded people without next; login_hint chooses nobody', async () => {
    const p = await provider();
    const started = start(p);
    const res = await authorize(p, started.query);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    const html = await res.text();
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).not.toContain('<script');
    for (const person of PEOPLE)
      expect(html).toContain(`<button type="submit" name="person" value="${person.id}">`);
    expect(html).toContain('<bdi lang="ar" dir="rtl">عمر</bdi>');
    expect(html).toContain('<bdi dir="ltr">omar@acme.test</bdi>');
    expect(html).toContain(`<form method="post" action="${new URL(p.issuer).pathname}/authorize">`);
    expect(html).toContain(`<input type="hidden" name="state" value="${started.state}">`);

    // The browser posts the form back with the chosen person.
    const form = new URLSearchParams(started.query);
    form.set('person', 'omar');
    const chosen = await fetch(`${p.issuer}/authorize`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    const back = callback(chosen);
    expect(back.get('state')).toBe(started.state);
    const exchanged = await exchange(p, {
      code: back.get('code') ?? '',
      code_verifier: started.verifier,
    });
    const { payload, valid } = await check(
      p.issuer,
      String(((await exchanged.json()) as Json).id_token),
    );
    expect(valid).toBe(true);
    expect(payload).toMatchObject({ sub: 'sub-omar', email: 'omar@acme.test', name: 'عمر' });
  });

  it('answers Cancel with access_denied, and speaks Arabic for ui_locales=ar', async () => {
    const p = await provider();
    const started = start(p, { ui_locales: 'ar-SA en' });
    const page = await authorize(p, started.query);
    const html = await page.text();
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('<bdi lang="en" dir="ltr">Ada Lovelace</bdi>');
    const form = new URLSearchParams(started.query);
    form.set('cancel', '1');
    const back = callback(
      await fetch(`${p.issuer}/authorize`, { method: 'POST', body: form, redirect: 'manual' }),
    );
    expect(back.get('error')).toBe('access_denied');
    expect(back.get('state')).toBe(started.state);
    expect(back.get('code')).toBeNull();
  });

  it('signs in whoever next names, the same email as the same sub', async () => {
    const p = await provider();
    const first = await check(
      p.issuer,
      (await tokens(p, { email: 'New.Person@Example.test' })).idToken,
    );
    expect(first.payload).toMatchObject({
      sub: `sub-${hashOf('new.person@example.test')}`,
      email: 'New.Person@Example.test',
      email_verified: true,
    });
    expect(first.payload).not.toHaveProperty('name');
    const again = await check(
      p.issuer,
      (await tokens(p, { email: 'new.person@example.test' })).idToken,
    );
    expect(again.payload.sub).toBe(first.payload.sub);

    const named = await check(
      p.issuer,
      (await tokens(p, { email: 'x@acme.test', sub: 'given', name: 'X', emailVerified: null }))
        .idToken,
    );
    expect(named.payload).toMatchObject({ sub: 'given', name: 'X', email: 'x@acme.test' });
    expect(named.payload).not.toHaveProperty('email_verified');

    expect((await control(p.issuer, 'next', { error: 'access_denied' })).status).toBe(204);
    const back = callback(await authorize(p, start(p).query));
    expect(back.get('error')).toBe('access_denied');
  });

  it('puts email only in the email scope, and name only in profile', async () => {
    const p = await provider();
    await control(p.issuer, 'next', { email: 'ada@acme.test' });
    const started = start(p, { scope: 'openid' });
    const back = callback(await authorize(p, started.query));
    const res = await exchange(p, {
      code: back.get('code') ?? '',
      code_verifier: started.verifier,
    });
    const { payload } = await check(p.issuer, String(((await res.json()) as Json).id_token));
    expect(payload.sub).toBe('sub-ada');
    for (const claim of ['email', 'email_verified', 'name'])
      expect(payload).not.toHaveProperty(claim);
  });
});

describe('codes', () => {
  async function code(p: Provider) {
    await control(p.issuer, 'next', { email: 'ada@acme.test' });
    const started = start(p);
    const back = callback(await authorize(p, started.query));
    return { code: back.get('code') ?? '', verifier: started.verifier };
  }
  const errorOf = async (res: Response) => ({
    status: res.status,
    ...((await res.json()) as Json),
  });

  it('is used once', async () => {
    const p = await provider();
    const c = await code(p);
    expect((await exchange(p, { code: c.code, code_verifier: c.verifier })).status).toBe(200);
    expect(
      await errorOf(await exchange(p, { code: c.code, code_verifier: c.verifier })),
    ).toMatchObject({
      status: 400,
      error: 'invalid_grant',
    });
  });

  it('is bound to its client, its redirect address and its PKCE challenge', async () => {
    const p = await provider();
    const other = { ...p, clientId: `other-${randomUUID()}`, clientSecret: 'other-secret' };
    await control(p.issuer, 'clients', {
      clientId: other.clientId,
      clientSecret: other.clientSecret,
      redirectUris: [REDIRECT],
    });
    const byOther = await code(p);
    expect(
      await errorOf(await exchange(other, { code: byOther.code, code_verifier: byOther.verifier })),
    ).toMatchObject({ status: 400, error: 'invalid_grant' });

    const elsewhere = await code(p);
    expect(
      await errorOf(
        await exchange(p, {
          code: elsewhere.code,
          code_verifier: elsewhere.verifier,
          redirect_uri: 'http://127.0.0.1:5280/elsewhere',
        }),
      ),
    ).toMatchObject({ status: 400, error: 'invalid_grant' });

    const wrongVerifier = await code(p);
    expect(
      await errorOf(
        await exchange(p, { code: wrongVerifier.code, code_verifier: b64url(randomBytes(32)) }),
      ),
    ).toMatchObject({ status: 400, error: 'invalid_grant' });
    const noVerifier = await code(p);
    expect(await errorOf(await exchange(p, { code: noVerifier.code }))).toMatchObject({
      error: 'invalid_grant',
    });
  });

  it('lasts 60 seconds', async () => {
    const p = await provider();
    const late = await code(p);
    const moved = await control(p.issuer, 'clock', { advanceMs: LIFETIMES.codeMs + 1000 });
    expect(await moved.json()).toEqual({ offsetMs: LIFETIMES.codeMs + 1000 });
    expect(
      await errorOf(await exchange(p, { code: late.code, code_verifier: late.verifier })),
    ).toMatchObject({ status: 400, error: 'invalid_grant' });
    const inTime = await code(p);
    await control(p.issuer, 'clock', { advanceMs: LIFETIMES.codeMs - 5000 });
    expect((await exchange(p, { code: inTime.code, code_verifier: inTime.verifier })).status).toBe(
      200,
    );
  });
});

describe('client authentication at /token', () => {
  const post = (p: Provider, form: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${p.issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'x', ...form }),
    });

  it('refuses a wrong secret, an unknown client, none, and two methods at once', async () => {
    const p = await provider();
    const wrong = await post(p, {}, { authorization: basicOf(p.clientId, 'wrong') });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toMatch(/^Basic /);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_client' });
    const unknown = await post(p, { client_id: 'nobody', client_secret: 'x' });
    expect(unknown.status).toBe(401);
    expect((await post(p, { client_id: p.clientId })).status).toBe(401);
    const both = await post(
      p,
      { client_secret: p.clientSecret },
      { authorization: basicOf(p.clientId, p.clientSecret) },
    );
    expect(both.status).toBe(400);
    expect(await both.json()).toMatchObject({ error: 'invalid_request' });
    // Basic's parts are form-encoded (RFC 6749 §2.3.1): a secret sent as it is, holding '+' and
    // '%', does not decode to itself.
    const raw = await post(
      p,
      {},
      {
        authorization: `Basic ${Buffer.from(`${p.clientId}:${p.clientSecret}`).toString('base64')}`,
      },
    );
    expect(raw.status).toBe(401);
    const grant = await post(p, {
      grant_type: 'password',
      client_id: p.clientId,
      client_secret: p.clientSecret,
    });
    expect(await grant.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });
});

describe('authorize refusals', () => {
  it('never redirects for an unknown client or an address not registered', async () => {
    const p = await provider();
    const unknown = await authorize(p, start(p, { client_id: 'nobody' }).query);
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get('location')).toBeNull();
    expect(await unknown.text()).toContain('This client is not registered');
    const elsewhere = await authorize(p, start(p, { redirect_uri: 'http://evil.test/cb' }).query);
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.headers.get('location')).toBeNull();
  });

  it('sends the other mistakes back to the client as OAuth errors', async () => {
    const p = await provider();
    const cases: [Record<string, string>, string][] = [
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ scope: 'email profile' }, 'invalid_scope'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ response_mode: 'form_post' }, 'invalid_request'],
    ];
    for (const [extra, error] of cases) {
      const started = start(p, extra);
      const back = callback(await authorize(p, started.query));
      expect(back.get('error'), JSON.stringify(extra)).toBe(error);
      expect(back.get('state')).toBe(started.state);
    }
    const twice = start(p);
    twice.query.append('nonce', 'again');
    expect(callback(await authorize(p, twice.query)).get('error')).toBe('invalid_request');
  });
});

describe('faults', () => {
  /** What each fault does to a sign-in; every fault the mock has is here. */
  const expectations: Record<MockOidcFault, (p: Provider) => Promise<void>> = {
    async wrongKey(p) {
      // A published kid, and a signature no published key made: RS256 here, ES256 in another realm.
      const rsa = await check(p.issuer, (await tokens(p)).idToken);
      expect(rsa.header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'rsa-1' });
      expect(rsa.valid).toBe(false);
      const q = await provider('ES256');
      await control(q.issuer, 'fault', { kind: 'wrongKey' });
      const ec = await check(q.issuer, (await tokens(q)).idToken);
      expect(ec.header).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'ec-1' });
      expect(ec.signature).toHaveLength(64);
      expect(ec.valid).toBe(false);
    },
    async algNone(p) {
      const { header, raw, payload } = await check(p.issuer, (await tokens(p)).idToken);
      expect(header).toEqual({ alg: 'none', typ: 'JWT' });
      expect(raw[2]).toBe('');
      expect(payload.iss).toBe(p.issuer);
    },
    async wrongAudience(p) {
      const { payload, valid } = await check(p.issuer, (await tokens(p)).idToken);
      expect(valid).toBe(true);
      expect(payload.aud).toBe(`${p.clientId}-other`);
    },
    async wrongIssuer(p) {
      const { payload, valid } = await check(p.issuer, (await tokens(p)).idToken);
      expect(valid).toBe(true);
      expect(payload.iss).not.toBe(p.issuer);
      expect(payload.iss).toBe(`${p.issuer}/wrong`);
    },
    async expired(p) {
      const { payload, valid } = await check(p.issuer, (await tokens(p)).idToken);
      expect(valid).toBe(true);
      // Past any clock skew a validator allows (the server allows 2 minutes).
      expect(Number(payload.exp)).toBeLessThan(nowS() - 300);
    },
    async nonce(p) {
      const { idToken, started } = await tokens(p);
      const { payload, valid } = await check(p.issuer, idToken);
      expect(valid).toBe(true);
      expect(payload.nonce).toEqual(expect.any(String));
      expect(payload.nonce).not.toBe(started.nonce);
    },
    async emailUnverified(p) {
      const { payload, valid } = await check(p.issuer, (await tokens(p)).idToken);
      expect(valid).toBe(true);
      expect(payload).toMatchObject({ email: 'ada@acme.test', email_verified: false });
    },
    async noEmail(p) {
      const { payload, valid } = await check(p.issuer, (await tokens(p)).idToken);
      expect(valid).toBe(true);
      expect(payload).not.toHaveProperty('email');
      expect(payload).not.toHaveProperty('email_verified');
      expect(payload.sub).toBe('sub-ada');
    },
    async tokenError(p) {
      const { res } = await signIn(p, { email: 'ada@acme.test' });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
    },
    async discoveryDown(p) {
      const res = await fetch(`${p.issuer}/.well-known/openid-configuration`);
      expect(res.status).toBe(503);
      expect((await fetch(`${p.issuer}/jwks`)).status).toBe(200);
    },
  };

  it('covers every fault', () => {
    expect(Object.keys(expectations).sort()).toEqual([...FAULTS].sort());
  });

  for (const kind of FAULTS)
    it(`${kind} does what its name says`, async () => {
      const p = await provider();
      expect((await control(p.issuer, 'fault', { kind })).status).toBe(204);
      await expectations[kind](p);
    });

  it('stays until cleared or reset, in its own realm only', async () => {
    const p = await provider();
    const audience = async (q: Provider) =>
      (await check(q.issuer, (await tokens(q)).idToken)).payload.aud;
    await control(p.issuer, 'fault', { kind: 'wrongAudience' });
    expect(await audience(p)).toBe(`${p.clientId}-other`);
    expect(await audience(p)).toBe(`${p.clientId}-other`);
    const neighbour = await provider();
    expect(await audience(neighbour)).toBe(neighbour.clientId);
    expect((await discovery(mock.url)).issuer).toBe(mock.url);

    await control(p.issuer, 'fault', { kind: null });
    expect(await audience(p)).toBe(p.clientId);

    await control(p.issuer, 'fault', { kind: 'wrongAudience' });
    expect((await control(p.issuer, 'reset', {})).status).toBe(204);
    const state = (await (await fetch(`${p.issuer}/__mock/state`)).json()) as Json;
    expect(state).toMatchObject({ fault: null, clients: [], next: 0, requests: 0 });
    expect(await audience(neighbour)).toBe(neighbour.clientId);
  });

  it('refuses a fault it does not know', async () => {
    const res = await control(`${mock.url}/realms/${randomUUID()}`, 'fault', { kind: 'wrong' });
    expect(res.status).toBe(400);
  });
});

describe('the DNS stand-in', () => {
  it('answers what was set, by name in any case, and records the lookup', async () => {
    const name = `_cashgear-workspace.${randomUUID()}.Acme.test.`;
    const lookup = async (n: string) =>
      (await (await fetch(`${mock.url}/__mock/dns?name=${encodeURIComponent(n)}`)).json()) as Json;
    expect(await lookup(name)).toEqual({ txt: [], addresses: [] });
    expect(
      (await control(mock.url, 'dns', { name, txt: ['cgw-verify=abc', 'other'] })).status,
    ).toBe(204);
    expect(await lookup(name.toLowerCase().replace(/\.$/, ''))).toEqual({
      txt: ['cgw-verify=abc', 'other'],
      addresses: [],
    });
    await control(mock.url, 'dns', { name, txt: null });
    expect(await lookup(name)).toEqual({ txt: [], addresses: [] });
    const asked = (await requests(mock.url, 'dns')).filter((r) => r.query.name === name);
    expect(asked).toHaveLength(2);
    expect((await fetch(`${mock.url}/__mock/dns`)).status).toBe(400);
  });

  it('keeps a name’s addresses beside its records, each part set alone (Phase 14)', async () => {
    const name = `docs.${randomUUID()}.example.test`;
    const lookup = async () =>
      (await (await fetch(`${mock.url}/__mock/dns?name=${name}`)).json()) as Json;
    expect(
      (await control(mock.url, 'dns', { name, addresses: ['203.0.113.5', '2001:db8::5'] })).status,
    ).toBe(204);
    await control(mock.url, 'dns', { name, txt: 'cgw-verify=xyz' });
    expect(await lookup()).toEqual({
      txt: ['cgw-verify=xyz'],
      addresses: ['203.0.113.5', '2001:db8::5'],
    });
    expect((await control(mock.url, 'dns', { name, addresses: 'not an address' })).status).toBe(
      400,
    );
    await control(mock.url, 'dns', { name, addresses: null });
    expect(await lookup()).toEqual({ txt: ['cgw-verify=xyz'], addresses: [] });
  });
});

describe('the controls', () => {
  it('refuses what is not JSON, a bad client and an unknown route', async () => {
    const realm = `${mock.url}/realms/${randomUUID()}`;
    const notJson = await fetch(`${realm}/__mock/next`, { method: 'POST', body: '{' });
    expect(notJson.status).toBe(400);
    expect((await control(realm, 'next', {})).status).toBe(400);
    expect(
      (await control(realm, 'clients', { clientId: 'x', clientSecret: 's', redirectUris: ['/cb'] }))
        .status,
    ).toBe(400);
    expect(
      (
        await control(realm, 'clients', {
          clientId: 'x',
          clientSecret: 's',
          redirectUris: [REDIRECT],
          alg: 'HS256',
        })
      ).status,
    ).toBe(400);
    expect((await control(realm, 'nothing', {})).status).toBe(404);
    expect((await fetch(`${realm}/__mock/reset`)).status).toBe(405);
    expect((await fetch(`${mock.url}/realms/bad.name/jwks`)).status).toBe(404);
  });
});
