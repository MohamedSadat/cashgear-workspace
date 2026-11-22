// The mock ACME server's own test (README.md beside it): the whole HTTP-01 flow as a client makes
// it, every request a JWS signed here with node:crypto, against a stand-in for the Sites process
// that serves the key authorization; the chain read back with X509Certificate; then each refusal,
// the faults and the controls. Everything runs on free ports, in process.

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  X509Certificate,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCsr } from './der.mjs';
import {
  ERRORS,
  TERMS,
  keyAuthorization,
  startMockAcme,
  thumbprint,
  type AcmeAccount,
  type AcmeAuthorization,
  type AcmeChallenge,
  type AcmeDirectory,
  type AcmeOrder,
  type AcmeProblem,
  type MockAcmeErrorType,
  type MockAcmeState,
} from './server.mjs';

const NAME = 'docs.example.localhost';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SLOW = 20_000;

/** What the Sites stand-in answers for a path. */
interface Served {
  readonly status?: number;
  readonly body?: string;
  readonly location?: string;
}

const served = new Map<string, Served>();
const seen: { host: string; path: string }[] = [];
let sites: Server;
let sitesPort: number;
let acme: Awaited<ReturnType<typeof startMockAcme>>;
let directory: AcmeDirectory;
let csrKey: KeyObject;

beforeAll(async () => {
  sites = createServer((req, res) => {
    seen.push({ host: req.headers.host ?? '', path: req.url ?? '' });
    const entry = served.get(req.url ?? '');
    if (!entry) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(entry.status ?? 200, {
      'content-type': 'text/plain',
      ...(entry.location ? { location: entry.location } : {}),
    });
    res.end(entry.body ?? '');
  });
  await new Promise<void>((done) => sites.listen(0, '127.0.0.1', () => done()));
  sitesPort = (sites.address() as AddressInfo).port;
  acme = await startMockAcme({ port: 0, challengePort: sitesPort });
  directory = (await (await fetch(acme.directory)).json()) as AcmeDirectory;
  csrKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
});

afterAll(async () => {
  await acme?.close();
  if (sites) {
    sites.closeAllConnections();
    await new Promise<void>((done) => sites.close(() => done()));
  }
});

// ---------------------------------------------------------------------------------------------
// A client, as the worker will be one

interface Answer<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly body: T;
}

type Header = Record<string, unknown>;

class Client {
  readonly alg: 'ES256' | 'RS256';
  readonly privateKey: KeyObject;
  readonly jwk: JsonWebKey;
  kid: string | null = null;
  nonce: string | null = null;

  constructor(alg: 'ES256' | 'RS256' = 'ES256') {
    const pair =
      alg === 'ES256'
        ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
        : generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.alg = alg;
    this.privateKey = pair.privateKey;
    this.jwk = pair.publicKey.export({ format: 'jwk' });
  }

  async newNonce() {
    const res = await fetch(directory.newNonce, { method: 'HEAD' });
    expect(res.status).toBe(200);
    this.nonce = res.headers.get('replay-nonce');
  }

  /** A flattened JWS over `payload` (null: a POST-as-GET), signed by `key` (the account's). */
  jws(url: string, payload: object | null, header: Header = {}, key = this.privateKey) {
    const protectedHeader = {
      alg: this.alg,
      nonce: this.nonce,
      url,
      ...(this.kid ? { kid: this.kid } : { jwk: this.jwk }),
      ...header,
    };
    const protectedB64 = Buffer.from(JSON.stringify(protectedHeader)).toString('base64url');
    const payloadB64 =
      payload === null ? '' : Buffer.from(JSON.stringify(payload)).toString('base64url');
    const input = Buffer.from(`${protectedB64}.${payloadB64}`);
    const signature =
      this.alg === 'ES256'
        ? sign('sha256', input, { key, dsaEncoding: 'ieee-p1363' })
        : sign('sha256', input, key);
    return JSON.stringify({
      protected: protectedB64,
      payload: payloadB64,
      signature: signature.toString('base64url'),
    });
  }

  async post<T = unknown>(
    url: string,
    payload: object | null = null,
    options: { header?: Header; key?: KeyObject; contentType?: string } = {},
  ): Promise<Answer<T>> {
    if (!this.nonce) await this.newNonce();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': options.contentType ?? 'application/jose+json' },
      body: this.jws(url, payload, options.header, options.key),
    });
    // Every answer to a POST carries a fresh nonce, refusals too.
    const nonce = res.headers.get('replay-nonce');
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(nonce).not.toBe(this.nonce);
    this.nonce = nonce;
    const text = await res.text();
    const json = /json/.test(res.headers.get('content-type') ?? '');
    return {
      status: res.status,
      headers: res.headers,
      text,
      body: (json ? JSON.parse(text) : text) as T,
    };
  }

  async register(): Promise<this> {
    const res = await this.post<AcmeAccount>(directory.newAccount, {
      termsOfServiceAgreed: true,
      contact: ['mailto:ops@example.localhost'],
    });
    expect(res.status).toBe(201);
    this.kid = res.headers.get('location');
    return this;
  }
}

/** RFC 7638, written out here rather than taken from the mock. */
function thumbOf(jwk: JsonWebKey) {
  const canonical =
    jwk.kty === 'EC'
      ? `{"crv":"${jwk.crv}","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`
      : `{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`;
  return createHash('sha256').update(canonical).digest('base64url');
}

function expectProblem(res: Answer<unknown>, type: MockAcmeErrorType, status = ERRORS[type]) {
  expect(res.headers.get('content-type')).toBe('application/problem+json');
  expect(res.status).toBe(status);
  const problem = res.body as AcmeProblem;
  expect(problem.type).toBe(`urn:ietf:params:acme:error:${type}`);
  expect(problem.status).toBe(status);
  expect(problem.detail).toEqual(expect.any(String));
  return problem;
}

async function control(name: string, body: unknown = {}) {
  const res = await fetch(`${acme.url}/__mock/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBeLessThan(300);
  return res;
}

async function state(): Promise<MockAcmeState> {
  return (await (await fetch(`${acme.url}/__mock/state`)).json()) as MockAcmeState;
}

const challengePath = (token: string) => `/.well-known/acme-challenge/${token}`;
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function poll<T extends { status: string }>(client: Client, url: string, until: string[]) {
  for (let i = 0; i < 500; i += 1) {
    const res = await client.post<T>(url);
    expect(res.status).toBe(200);
    if (until.includes(res.body.status)) return res;
    await wait(20);
  }
  throw new Error(`${url} never reached ${until.join(' or ')}.`);
}

async function newOrder(client: Client, names: readonly string[]) {
  const res = await client.post<AcmeOrder>(directory.newOrder, {
    identifiers: names.map((value) => ({ type: 'dns', value })),
  });
  expect(res.status).toBe(201);
  return { url: res.headers.get('location') ?? '', order: res.body };
}

function http01(authz: AcmeAuthorization): AcmeChallenge {
  const challenge = authz.challenges.find((c) => c.type === 'http-01');
  if (!challenge) throw new Error('No http-01 challenge.');
  return challenge;
}

/**
 * For each of the order's authorizations: serve the key authorization (or `serve`'s answer), say
 * the challenge is ready, and wait for the authorization to settle.
 */
async function authorize(client: Client, order: AcmeOrder, serve?: (token: string) => Served) {
  const out: AcmeAuthorization[] = [];
  for (const url of order.authorizations) {
    const challenge = http01((await client.post<AcmeAuthorization>(url)).body);
    served.set(
      challengePath(challenge.token),
      serve ? serve(challenge.token) : { body: `${challenge.token}.${thumbOf(client.jwk)}` },
    );
    expect((await client.post<AcmeChallenge>(challenge.url, {})).status).toBe(200);
    out.push((await poll<AcmeAuthorization>(client, url, ['valid', 'invalid'])).body);
  }
  return out;
}

const csrFor = (names: readonly string[], key = csrKey) =>
  makeCsr({ privateKey: key, commonName: names[0], dnsNames: names }).toString('base64url');

/** An order made, authorized, finalized and issued: its URL, its last state and the chain. */
async function issue(client: Client, names: readonly string[]) {
  const { url, order } = await newOrder(client, names);
  await authorize(client, order);
  expect((await poll<AcmeOrder>(client, url, ['ready'])).body.status).toBe('ready');
  expect((await client.post<AcmeOrder>(order.finalize, { csr: csrFor(names) })).status).toBe(200);
  const done = (await poll<AcmeOrder>(client, url, ['valid', 'invalid'])).body;
  expect(done.status).toBe('valid');
  const cert = await client.post<string>(done.certificate ?? '');
  expect(cert.status).toBe(200);
  return { url, order: done, chain: cert.text };
}

/** A chain's certificates, each as its own PEM. */
const pems = (chain: string) =>
  chain.split(/(?<=-----END CERTIFICATE-----\n)/).filter((part) => part.trim() !== '');

// ---------------------------------------------------------------------------------------------

describe('the mock ACME server', () => {
  it('serves its directory and nonces', async () => {
    expect(directory).toEqual({
      newNonce: `${acme.url}/new-nonce`,
      newAccount: `${acme.url}/new-account`,
      newOrder: `${acme.url}/new-order`,
      revokeCert: `${acme.url}/revoke-cert`,
      keyChange: `${acme.url}/key-change`,
      meta: { termsOfService: TERMS },
    });
    const head = await fetch(directory.newNonce, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('cache-control')).toBe('no-store');
    const get = await fetch(directory.newNonce);
    expect(get.status).toBe(204);
    expect(get.headers.get('cache-control')).toBe('no-store');
    expect(head.headers.get('replay-nonce')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(get.headers.get('replay-nonce')).not.toBe(head.headers.get('replay-nonce'));
    // ACME resources take POST only.
    const wrong = await fetch(directory.newOrder);
    expect(wrong.status).toBe(405);
    expect(((await wrong.json()) as AcmeProblem).type).toBe('urn:ietf:params:acme:error:malformed');
  });

  it('computes the RFC 7638 thumbprint of EC and RSA keys', () => {
    const ec = new Client('ES256').jwk;
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
      format: 'jwk',
    });
    expect(thumbprint(ec)).toBe(thumbOf(ec));
    expect(thumbprint(rsa)).toBe(thumbOf(rsa));
    expect(keyAuthorization('tok', ec)).toBe(`tok.${thumbOf(ec)}`);
  });

  it(
    'issues a certificate through HTTP-01, end to end',
    async () => {
      const client = new Client();

      // The terms first: refused without them, then agreed.
      const refused = await client.post(directory.newAccount, { contact: [] });
      const terms = expectProblem(refused, 'userActionRequired', 403);
      expect(terms.instance).toBe(TERMS);
      expect(refused.headers.get('link')).toContain(`<${TERMS}>;rel="terms-of-service"`);
      expectProblem(
        await client.post(directory.newAccount, { onlyReturnExisting: true }),
        'accountDoesNotExist',
      );
      const made = await client.post<AcmeAccount>(directory.newAccount, {
        termsOfServiceAgreed: true,
        contact: ['mailto:ops@example.localhost'],
      });
      expect(made.status).toBe(201);
      const location = made.headers.get('location') ?? '';
      expect(location).toMatch(new RegExp(`^${acme.url}/acct/[A-Za-z0-9_-]+$`));
      expect(made.body).toEqual({
        status: 'valid',
        contact: ['mailto:ops@example.localhost'],
        orders: `${location}/orders`,
      });
      expect(made.headers.get('link')).toContain(`<${acme.url}/directory>;rel="index"`);
      // The same key again: the same account.
      const again = await client.post<AcmeAccount>(directory.newAccount, {
        termsOfServiceAgreed: true,
      });
      expect(again.status).toBe(200);
      expect(again.headers.get('location')).toBe(location);
      const existing = await client.post(directory.newAccount, { onlyReturnExisting: true });
      expect(existing.status).toBe(200);
      expect(existing.headers.get('location')).toBe(location);
      client.kid = location;

      // The order and its one authorization.
      const { url, order } = await newOrder(client, [NAME]);
      expect(url).toMatch(new RegExp(`^${acme.url}/order/[A-Za-z0-9_-]+$`));
      expect(order.status).toBe('pending');
      expect(order.identifiers).toEqual([{ type: 'dns', value: NAME }]);
      expect(order.authorizations).toHaveLength(1);
      expect(order.finalize).toBe(`${url}/finalize`);
      expect(Date.parse(order.expires)).toBeGreaterThan(Date.now());
      const authz = (await client.post<AcmeAuthorization>(order.authorizations[0])).body;
      expect(authz.status).toBe('pending');
      expect(authz.identifier).toEqual({ type: 'dns', value: NAME });
      expect(authz.challenges).toHaveLength(1);
      const challenge = http01(authz);
      expect(challenge.status).toBe('pending');
      expect(challenge.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(challenge.url).toMatch(new RegExp(`^${acme.url}/chall/[A-Za-z0-9_-]+$`));

      // The key authorization served where the Sites process would serve it, then the challenge.
      served.set(challengePath(challenge.token), {
        body: `${challenge.token}.${thumbOf(client.jwk)}\n`,
      });
      const answered = await client.post<AcmeChallenge>(challenge.url, {});
      expect(answered.status).toBe(200);
      expect(answered.body.status).toBe('processing');
      expect(answered.headers.get('retry-after')).toBe('1');
      expect(answered.headers.get('link')).toContain(`<${order.authorizations[0]}>;rel="up"`);
      const valid = (await poll<AcmeAuthorization>(client, order.authorizations[0], ['valid']))
        .body;
      expect(http01(valid).status).toBe('valid');
      expect(Date.parse(http01(valid).validated ?? '')).toBeGreaterThan(Date.now() - 60_000);
      // Fetched with the name and the challenge port in Host, as a browser would ask for it.
      expect(seen).toContainEqual({
        host: `${NAME}:${sitesPort}`,
        path: challengePath(challenge.token),
      });
      expect((await poll<AcmeOrder>(client, url, ['ready'])).body.status).toBe('ready');

      // Finalized, processing a moment, then valid.
      const finalized = await client.post<AcmeOrder>(order.finalize, { csr: csrFor([NAME]) });
      expect(finalized.status).toBe(200);
      expect(finalized.body.status).toBe('processing');
      expect(finalized.headers.get('retry-after')).toBe('1');
      expect(finalized.headers.get('location')).toBe(url);
      const done = (await poll<AcmeOrder>(client, url, ['valid'])).body;
      expect(done.certificate).toMatch(new RegExp(`^${acme.url}/cert/[A-Za-z0-9_-]+$`));

      // The chain: the leaf, then the CA.
      const cert = await client.post<string>(done.certificate ?? '');
      expect(cert.status).toBe(200);
      expect(cert.headers.get('content-type')).toBe('application/pem-certificate-chain');
      expect(cert.text).not.toContain('\r');
      const [leafPem, caPem, ...more] = pems(cert.text);
      expect(more).toEqual([]);
      expect(caPem).toBe(await (await fetch(`${acme.url}/__mock/ca`)).text());
      const leaf = new X509Certificate(leafPem);
      const ca = new X509Certificate(caPem);
      expect(leaf.subject).toBe(`CN=${NAME}`);
      expect(leaf.subjectAltName).toContain(`DNS:${NAME}`);
      expect(leaf.issuer).toBe(ca.subject);
      expect(leaf.checkIssued(ca)).toBe(true);
      expect(leaf.verify(ca.publicKey)).toBe(true);
      expect(ca.verify(ca.publicKey)).toBe(true);
      expect(ca.ca).toBe(true);
      expect(leaf.ca).toBe(false);
      expect(leaf.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
      expect(leaf.checkHost(NAME)).toBe(NAME);
      // The request's key, verbatim.
      expect(leaf.publicKey.export({ type: 'spki', format: 'der' })).toEqual(
        createPublicKey(csrKey).export({ type: 'spki', format: 'der' }),
      );
      const from = Date.parse(leaf.validFrom);
      const to = Date.parse(leaf.validTo);
      expect(to - from).toBe(90 * DAY + HOUR);
      expect(Math.abs(from - (Date.now() - HOUR))).toBeLessThan(60_000);

      // What the controls saw.
      const now = await state();
      const issued = now.certificates.find((c) => c.url === done.certificate);
      expect(issued).toMatchObject({ order: url, names: [NAME], revoked: false });
      expect(issued?.serial).toBe(leaf.serialNumber);
      expect(Date.parse(issued?.notAfter ?? '')).toBe(to);
      expect(now.orders.find((o) => o.url === url)).toMatchObject({
        status: 'valid',
        names: [NAME],
        account: location,
        certificate: done.certificate,
      });
      expect(now.attempts).toContainEqual(
        expect.objectContaining({
          identifier: NAME,
          token: challenge.token,
          url: `http://${NAME}:${sitesPort}${challengePath(challenge.token)}`,
          host: `${NAME}:${sitesPort}`,
          status: 200,
          outcome: 'valid',
          error: null,
        }),
      );
    },
    SLOW,
  );

  it(
    'takes an RS256 account key too',
    async () => {
      const client = await new Client('RS256').register();
      const { url, order } = await newOrder(client, ['rsa.example.localhost']);
      const [authz] = await authorize(client, order);
      expect(authz.status).toBe('valid');
      expect((await poll<AcmeOrder>(client, url, ['ready'])).body.status).toBe('ready');
    },
    SLOW,
  );

  it('refuses a bad nonce, and a retry with the fresh one works', async () => {
    const client = new Client();
    await client.newNonce();
    client.nonce = 'not-a-nonce-of-the-mock';
    expectProblem(
      await client.post(directory.newAccount, { termsOfServiceAgreed: true }),
      'badNonce',
    );
    // The refusal's own nonce works.
    expect((await client.post(directory.newAccount, { termsOfServiceAgreed: true })).status).toBe(
      201,
    );
    // A nonce is used once.
    const used = client.nonce;
    expect((await client.post(directory.newAccount, { termsOfServiceAgreed: true })).status).toBe(
      200,
    );
    client.nonce = used;
    expectProblem(
      await client.post(directory.newAccount, { termsOfServiceAgreed: true }),
      'badNonce',
    );
    // No nonce at all.
    const none = await client.post(directory.newAccount, {}, { header: { nonce: undefined } });
    expectProblem(none, 'badNonce');
    // The fault: a good nonce refused once, then the retry works.
    await control('fault', { kind: 'badNonce' });
    expectProblem(
      await client.post(directory.newAccount, { termsOfServiceAgreed: true }),
      'badNonce',
    );
    expect((await client.post(directory.newAccount, { termsOfServiceAgreed: true })).status).toBe(
      200,
    );
  });

  it('checks the JWS: content type, alg, url, key and signature', async () => {
    const client = await new Client().register();
    const wrongType = await client.post(
      directory.newOrder,
      {},
      { contentType: 'application/json' },
    );
    expectProblem(wrongType, 'malformed', 415);
    const alg = await client.post(directory.newOrder, {}, { header: { alg: 'HS256' } });
    expect(expectProblem(alg, 'badSignatureAlgorithm').algorithms).toEqual(['ES256', 'RS256']);
    expectProblem(
      await client.post(directory.newOrder, {}, { header: { url: `${acme.url}/new-account` } }),
      'unauthorized',
    );
    expectProblem(
      await client.post(directory.newOrder, {}, { header: { jwk: client.jwk } }),
      'malformed',
    );
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    expectProblem(await client.post(directory.newOrder, {}, { key: other }), 'malformed');
    expectProblem(
      await client.post(directory.newOrder, {}, { header: { kid: `${acme.url}/acct/nobody` } }),
      'accountDoesNotExist',
    );
    // newAccount is signed with the key itself, never kid.
    expectProblem(
      await client.post(directory.newAccount, { termsOfServiceAgreed: true }),
      'malformed',
    );
  });

  it('refuses IP addresses and wildcards', async () => {
    const client = await new Client().register();
    for (const identifier of [
      { type: 'dns', value: `*.${NAME}` },
      { type: 'ip', value: '127.0.0.1' },
      { type: 'dns', value: '127.0.0.1' },
      { type: 'dns', value: 'localhost' },
    ]) {
      const res = await client.post(directory.newOrder, { identifiers: [identifier] });
      expectProblem(res, 'rejectedIdentifier');
    }
    expectProblem(await client.post(directory.newOrder, { identifiers: [] }), 'malformed');
  });

  it(
    'makes the order invalid when the key authorization is wrong',
    async () => {
      const client = await new Client().register();
      const { url, order } = await newOrder(client, ['wrong.example.localhost']);
      const [authz] = await authorize(client, order, (token) => ({
        body: `${token}.not-the-thumbprint`,
      }));
      expect(authz.status).toBe('invalid');
      expect(http01(authz).status).toBe('invalid');
      expect(http01(authz).error?.type).toBe('urn:ietf:params:acme:error:incorrectResponse');
      const invalid = (await client.post<AcmeOrder>(url)).body;
      expect(invalid.status).toBe('invalid');
      expect(invalid.error?.type).toBe('urn:ietf:params:acme:error:incorrectResponse');
      // Finalizing it is refused.
      expectProblem(
        await client.post(order.finalize, { csr: csrFor(['wrong.example.localhost']) }),
        'orderNotReady',
      );
      expect((await state()).attempts).toContainEqual(
        expect.objectContaining({
          identifier: 'wrong.example.localhost',
          token: http01(authz).token,
          status: 200,
          outcome: 'invalid',
          error: 'urn:ietf:params:acme:error:incorrectResponse',
        }),
      );
      // A 404 is incorrectResponse too.
      const missing = await newOrder(client, ['missing.example.localhost']);
      const [none] = await authorize(client, missing.order, () => ({ status: 404 }));
      expect(http01(none).error?.type).toBe('urn:ietf:params:acme:error:incorrectResponse');
    },
    SLOW,
  );

  it(
    'says connection when nothing answers on the challenge port',
    async () => {
      const closed = createServer();
      await new Promise<void>((done) => closed.listen(0, '127.0.0.1', () => done()));
      const port = (closed.address() as AddressInfo).port;
      await new Promise<void>((done) => closed.close(() => done()));
      await control('challenge', { port });
      try {
        const client = await new Client().register();
        const { order } = await newOrder(client, ['nobody.example.localhost']);
        const [authz] = await authorize(client, order);
        expect(http01(authz).error?.type).toBe('urn:ietf:params:acme:error:connection');
        expect((await state()).attempts).toContainEqual(
          expect.objectContaining({
            identifier: 'nobody.example.localhost',
            status: null,
            outcome: 'invalid',
            error: 'urn:ietf:params:acme:error:connection',
          }),
        );
      } finally {
        await control('challenge', { port: sitesPort });
      }
    },
    SLOW,
  );

  it(
    'follows a redirect on the same host, and no other',
    async () => {
      const client = await new Client().register();
      const near = await newOrder(client, ['near.example.localhost']);
      const [moved] = await authorize(client, near.order, (token) => {
        served.set(`/moved/${token}`, { body: `${token}.${thumbOf(client.jwk)}` });
        return { status: 302, location: `/moved/${token}` };
      });
      expect(moved.status).toBe('valid');
      expect((await state()).attempts).toContainEqual(
        expect.objectContaining({ identifier: 'near.example.localhost', redirects: 1 }),
      );
      const far = await newOrder(client, ['far.example.localhost']);
      const [away] = await authorize(client, far.order, (token) => ({
        status: 302,
        location: `http://elsewhere.example.localhost:${sitesPort}/moved/${token}`,
      }));
      expect(away.status).toBe('invalid');
      expect(http01(away).error?.type).toBe('urn:ietf:params:acme:error:connection');
    },
    SLOW,
  );

  it('refuses to finalize an order that is not ready', async () => {
    const client = await new Client().register();
    const { order } = await newOrder(client, ['early.example.localhost']);
    const res = await client.post(order.finalize, { csr: csrFor(['early.example.localhost']) });
    expectProblem(res, 'orderNotReady', 403);
  });

  it(
    'refuses a CSR for another name, or one whose signature does not hold',
    async () => {
      const client = await new Client().register();
      const names = ['csr.example.localhost'];
      const { url, order } = await newOrder(client, names);
      await authorize(client, order);
      await poll<AcmeOrder>(client, url, ['ready']);
      expectProblem(
        await client.post(order.finalize, { csr: csrFor(['other.example.localhost']) }),
        'badCSR',
      );
      expectProblem(
        await client.post(order.finalize, { csr: csrFor([...names, 'more.example.localhost']) }),
        'badCSR',
      );
      const tampered = makeCsr({ privateKey: csrKey, commonName: names[0], dnsNames: names });
      tampered[tampered.length - 1] ^= 0x01;
      expectProblem(
        await client.post(order.finalize, { csr: tampered.toString('base64url') }),
        'badCSR',
      );
      expectProblem(await client.post(order.finalize, { csr: 'AAAA' }), 'badCSR');
      // The account's own key is never a certificate's.
      const own = makeCsr({ privateKey: client.privateKey, commonName: names[0], dnsNames: names });
      expectProblem(
        await client.post(order.finalize, { csr: own.toString('base64url') }),
        'badCSR',
      );
      // Still ready: the right request goes through.
      expect((await client.post<AcmeOrder>(url)).body.status).toBe('ready');
      expect((await client.post<AcmeOrder>(order.finalize, { csr: csrFor(names) })).status).toBe(
        200,
      );
      expect((await poll<AcmeOrder>(client, url, ['valid'])).body.status).toBe('valid');
    },
    SLOW,
  );

  it(
    "keeps one account's objects from another",
    async () => {
      const owner = await new Client().register();
      const other = await new Client().register();
      const { url, order, chain } = await issue(owner, ['mine.example.localhost']);
      expect(pems(chain)).toHaveLength(2);
      expectProblem(await other.post(url), 'unauthorized', 403);
      expectProblem(await other.post(order.authorizations[0]), 'unauthorized', 403);
      const authz = (await owner.post<AcmeAuthorization>(order.authorizations[0])).body;
      expectProblem(await other.post(http01(authz).url), 'unauthorized', 403);
      expectProblem(await other.post(order.certificate ?? ''), 'unauthorized', 403);
      expectProblem(await other.post(owner.kid ?? ''), 'unauthorized', 403);
      expectProblem(
        await other.post(order.finalize, { csr: csrFor(['mine.example.localhost']) }),
        'unauthorized',
        403,
      );
      // POST-as-GET means an empty payload: `{}` to an order is malformed.
      expectProblem(await owner.post(url, {}), 'malformed');
    },
    SLOW,
  );

  it(
    'revokes a certificate for the account that holds it',
    async () => {
      const client = await new Client().register();
      const { chain } = await issue(client, ['revoke.example.localhost']);
      const der = new X509Certificate(pems(chain)[0]).raw.toString('base64url');
      const other = await new Client().register();
      expectProblem(await other.post(directory.revokeCert, { certificate: der }), 'unauthorized');
      expect(
        (await client.post(directory.revokeCert, { certificate: der, reason: 4 })).status,
      ).toBe(200);
      expectProblem(
        await client.post(directory.revokeCert, { certificate: der }),
        'alreadyRevoked',
      );
      expect(
        (await state()).certificates.find((c) => c.names[0] === 'revoke.example.localhost')
          ?.revoked,
      ).toBe(true);
    },
    SLOW,
  );

  it('the rateLimited fault answers 429 with Retry-After once', async () => {
    const client = await new Client().register();
    await control('fault', { kind: 'rateLimited' });
    const limited = await client.post(directory.newOrder, {
      identifiers: [{ type: 'dns', value: 'busy.example.localhost' }],
    });
    expectProblem(limited, 'rateLimited', 429);
    expect(limited.headers.get('retry-after')).toBe('3600');
    expect((await newOrder(client, ['busy.example.localhost'])).order.status).toBe('pending');
  });

  it(
    'the challenge fault fails a validation whatever is served',
    async () => {
      const client = await new Client().register();
      await control('fault', { kind: 'challenge' });
      const { url, order } = await newOrder(client, ['fault.example.localhost']);
      const [authz] = await authorize(client, order);
      expect(authz.status).toBe('invalid');
      expect(http01(authz).error).toMatchObject({
        type: 'urn:ietf:params:acme:error:incorrectResponse',
        detail: 'Mock fault: challenge.',
      });
      expect((await client.post<AcmeOrder>(url)).body.status).toBe('invalid');
      // Used up: the next one passes.
      const next = await newOrder(client, ['fault.example.localhost']);
      expect((await authorize(client, next.order))[0].status).toBe('valid');
    },
    SLOW,
  );

  it('the server fault answers 500 once, with a fresh nonce', async () => {
    const client = await new Client().register();
    await control('fault', { kind: 'server', count: 2 });
    expect((await state()).faults).toEqual({ server: 2 });
    expectProblem(await client.post(client.kid ?? ''), 'serverInternal', 500);
    expectProblem(await client.post(client.kid ?? ''), 'serverInternal', 500);
    expect((await client.post<AcmeAccount>(client.kid ?? '')).body.status).toBe('valid');
    expect((await state()).faults).toEqual({});
  });

  it(
    'takes a shorter lifetime, and a reset forgets everything but the CA',
    async () => {
      const ca = await (await fetch(`${acme.url}/__mock/ca`)).text();
      await control('lifetime', { days: 2 });
      const client = await new Client().register();
      const { chain } = await issue(client, ['short.example.localhost']);
      const leaf = new X509Certificate(pems(chain)[0]);
      expect(Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)).toBe(2 * DAY + HOUR);
      await control('fault', { kind: 'rateLimited', count: 3 });

      const before = await state();
      expect(before.accounts.length).toBeGreaterThan(0);
      expect(before.lifetimeDays).toBe(2);
      await control('reset');
      const after = await state();
      expect(after).toMatchObject({
        lifetimeDays: 90,
        faults: {},
        nonces: 0,
        accounts: [],
        orders: [],
        attempts: [],
        certificates: [],
        challenge: { port: sitesPort, resolve: '127.0.0.1' },
      });
      expect(await (await fetch(`${acme.url}/__mock/ca`)).text()).toBe(ca);
      // The client's nonce went with the reset: badNonce once, then its account is unknown.
      expectProblem(await client.post(client.kid ?? ''), 'badNonce');
      expectProblem(await client.post(client.kid ?? ''), 'accountDoesNotExist');
      // And it starts again.
      client.kid = null;
      await client.register();
      expect(new X509Certificate(pems((await issue(client, [NAME])).chain)[1]).raw).toEqual(
        new X509Certificate(ca).raw,
      );
    },
    SLOW,
  );
});
