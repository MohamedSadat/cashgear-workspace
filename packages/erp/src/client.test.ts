import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { codeForStatus, createErpClient, retryAfterMs } from './client';
import { ErpError, SERVER_ERROR_CODES, type ConnectorSchema, type QueryRequest } from './contract';

const BASE = 'http://127.0.0.1:4282';
const TOKEN = 'tok_' + 'z'.repeat(40);
const TICKET = 'T'.repeat(43);

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch that answers from `reply` and keeps what it was sent. */
function fake(reply: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const call = { url, init };
    sent.push(call);
    return reply(call);
  };
  return { sent, client: createErpClient(BASE, fetchImpl) };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': 'cid-1', ...headers },
  });

const errorBody = (code: string) => ({
  message: 'Refused.',
  correlationId: 'cid-body',
  errors: [{ code, message: 'Refused.' }],
});

const session = {
  token: TOKEN,
  expiresAt: '2026-11-14T10:30:00Z',
  maxExpiresAt: '2026-11-14T20:00:00Z',
  linkId: 'erp-link-1',
  company: 'Kit',
  companyName: 'Kit Trading',
  user: { id: 'u101', displayName: 'Alice Haddad' },
  language: 'en',
};

const schema: ConnectorSchema = {
  id: 'customers',
  schemaVersion: 'customers.1',
  keyField: 'customerAccount',
  idField: 'recId',
  maxPageSize: 500,
  maxRecords: 10000,
  maxCommitRecords: 0,
  fields: [
    {
      name: 'customerAccount',
      label: { en: 'Account', ar: 'الحساب' },
      type: 'text',
      editable: false,
      editReason: 'notEditable',
      filterable: true,
      sortable: true,
    },
    {
      name: 'creditLimit',
      label: { en: 'Credit limit', ar: 'حد الائتمان' },
      type: 'decimal',
      scale: 2,
      editable: false,
      editReason: 'notEditable',
      filterable: false,
      sortable: true,
    },
  ],
  lookups: {},
};

const request: QueryRequest = { filter: { search: 'cairo' }, cursor: null, pageSize: 2 };

/** Every way a call reaches the ERP, with a token where it takes one. */
const calls = {
  redeemLink: (c: ReturnType<typeof createErpClient>) => c.redeemLink(TICKET, 'ws-1', 'Finance'),
  redeem: (c: ReturnType<typeof createErpClient>) => c.redeem(TICKET, 'ws-1'),
  renew: (c: ReturnType<typeof createErpClient>) => c.renew(TOKEN),
  end: (c: ReturnType<typeof createErpClient>) => c.end(TOKEN),
  connectors: (c: ReturnType<typeof createErpClient>) => c.connectors(TOKEN),
  schema: (c: ReturnType<typeof createErpClient>) => c.schema(TOKEN, 'customers'),
  query: (c: ReturnType<typeof createErpClient>) => c.query(TOKEN, 'customers', request),
};

async function failure(promise: Promise<unknown>): Promise<ErpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ErpError);
    const e = error as ErpError;
    expect(e.message).not.toContain(TOKEN);
    expect(JSON.stringify(e)).not.toContain(TOKEN);
    return e;
  }
  throw new Error('Expected the call to fail.');
}

describe('createErpClient', () => {
  it('refuses a base that is not an http address without a query', () => {
    expect(() => createErpClient('ftp://erp')).toThrow(TypeError);
    expect(() => createErpClient('https://erp.example.com/?k=1')).toThrow(TypeError);
    expect(() => createErpClient('https://user:pw@erp.example.com')).toThrow(TypeError);
    expect(createErpClient('https://erp.example.com/api/').apiBase).toBe(
      'https://erp.example.com/api',
    );
  });

  it('sends every call without cookies, redirects, referrer or cache, the token only in its header', async () => {
    const { sent, client } = fake(({ url }) => {
      if (url.endsWith('/Redeem') && url.includes('WorkspaceLink'))
        return json(200, { linkId: 'erp-link-1', company: 'Kit', companyName: 'Kit Trading' });
      if (url.endsWith('Session/Redeem')) return json(200, session);
      if (url.endsWith('/Renew')) return json(200, { expiresAt: '2026-11-14T10:40:00Z' });
      if (url.endsWith('/End')) return new Response(null, { status: 204 });
      if (url.endsWith('/Connectors')) return json(200, { connectors: [] });
      if (url.endsWith('/Schema')) return json(200, schema);
      return json(200, { records: [], nextCursor: null, total: 0 });
    });
    for (const call of Object.values(calls)) await call(client);
    expect(sent.map((s) => `${s.init.method} ${s.url.slice(BASE.length)}`)).toEqual([
      'POST /api/system/WorkspaceLink/Redeem',
      'POST /api/connect/Session/Redeem',
      'POST /api/connect/Session/Renew',
      'POST /api/connect/Session/End',
      'GET /api/connect/Connectors',
      'GET /api/connect/Connectors/customers/Schema',
      'POST /api/connect/Connectors/customers/Query',
    ]);
    for (const { url, init } of sent) {
      expect(init).toMatchObject({
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        mode: 'cors',
      });
      expect(url).not.toContain(TOKEN);
      expect(String(init.body ?? '')).not.toContain(TOKEN);
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      expect(Object.keys(headers).some((h) => /cookie|api-key/i.test(h))).toBe(false);
    }
    const tokens = sent.map((s) => (s.init.headers as Record<string, string>)['X-Connect-Session']);
    expect(tokens).toEqual([undefined, undefined, TOKEN, TOKEN, TOKEN, TOKEN, TOKEN]);
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({
      ticket: TICKET,
      workspaceId: 'ws-1',
      workspaceName: 'Finance',
    });
    expect(JSON.parse(String(sent[1]!.init.body))).toEqual({ ticket: TICKET, workspaceId: 'ws-1' });
    expect(JSON.parse(String(sent[6]!.init.body))).toEqual(request);
  });

  it('sends End with keepalive when asked', async () => {
    const { sent, client } = fake(() => new Response(null, { status: 204 }));
    await client.end(TOKEN, { keepalive: true });
    await client.end(TOKEN);
    expect(sent[0]!.init.keepalive).toBe(true);
    expect(sent[1]!.init.keepalive).toBeUndefined();
  });

  it('refuses to put a token that is not header-safe in a header', async () => {
    const { sent, client } = fake(() => json(200, { connectors: [] }));
    const bad = TOKEN + '\r\nX-Other: 1';
    const e = await failure(client.connectors(bad));
    expect(e.code).toBe('session.expired');
    expect(e.message).not.toContain('X-Other');
    expect(sent).toHaveLength(0);
  });

  it('gives each answer typed', async () => {
    const records = [
      {
        id: '7101',
        key: 'C-1001',
        version: 'AAAAAAAAB9E=',
        values: { customerAccount: 'C-1001', creditLimit: '25000.00' },
      },
    ];
    const { client } = fake(({ url }) => {
      if (url.endsWith('Session/Redeem')) return json(200, session);
      if (url.endsWith('/Connectors'))
        return json(200, {
          connectors: [
            {
              id: 'customers',
              kind: 'entity',
              label: { en: 'Customers', ar: 'العملاء' },
              schemaVersion: 'customers.1',
              access: 'view',
            },
          ],
        });
      if (url.endsWith('/Schema')) return json(200, schema);
      return json(200, { records, nextCursor: 'c2', total: 9 });
    });
    expect(await client.redeem(TICKET, 'ws-1')).toEqual(session);
    expect((await client.connectors(TOKEN)).map((c) => c.id)).toEqual(['customers']);
    expect((await client.schema(TOKEN, 'customers')).keyField).toBe('customerAccount');
    expect(await client.query(TOKEN, 'customers', request, { schema })).toEqual({
      records,
      nextCursor: 'c2',
      total: 9,
    });
  });

  it.each(SERVER_ERROR_CODES.map((code) => [code]))('maps the ERP’s %s', async (code) => {
    const status = { 'ticket.invalid': 401, 'session.expired': 401, 'rate.limited': 429 }[
      code as string
    ];
    const { client } = fake(() => json(status ?? 400, errorBody(code)));
    const e = await failure(calls.query(client));
    expect(e).toMatchObject({ code, status: status ?? 400, correlationId: 'cid-1' });
  });

  it.each([
    [400, 'query', 'request.invalid'],
    [401, 'query', 'session.expired'],
    [401, 'redeem', 'ticket.invalid'],
    [401, 'redeemLink', 'ticket.invalid'],
    [403, 'connectors', 'privilege.denied'],
    [404, 'schema', 'connector.notFound'],
    [404, 'renew', 'server'],
    [413, 'query', 'batch.tooLarge'],
    [429, 'redeem', 'rate.limited'],
    [500, 'query', 'server'],
    [503, 'connectors', 'server'],
    [418, 'query', 'server'],
  ] as const)('reads a bare %i from %s as %s', async (status, call, code) => {
    const { client } = fake(() => new Response('', { status }));
    const e = await failure(calls[call](client));
    expect(e).toMatchObject({ code, status, correlationId: null });
  });

  it('reads statuses by the kind of route', () => {
    expect(codeForStatus(401, 'ticket')).toBe('ticket.invalid');
    expect(codeForStatus(401, 'session')).toBe('session.expired');
    expect(codeForStatus(404, 'connector')).toBe('connector.notFound');
    expect(codeForStatus(404, 'session')).toBe('server');
    expect(codeForStatus(502)).toBe('server');
  });

  it('reads the status when the error body is not the ERP’s, or its code is unknown', async () => {
    let body: unknown = { title: 'Forbidden' };
    const { client } = fake(() => json(403, body));
    expect((await failure(calls.schema(client))).code).toBe('privilege.denied');
    body = errorBody('something.new');
    expect((await failure(calls.schema(client))).code).toBe('privilege.denied');
  });

  it('takes the correlation id from the header, else from the body', async () => {
    const { client } = fake(
      () => new Response(JSON.stringify(errorBody('link.revoked')), { status: 403 }),
    );
    const e = await failure(calls.query(client));
    expect(e).toMatchObject({ code: 'link.revoked', correlationId: 'cid-body' });
  });

  it('keeps Retry-After in seconds or as a date', async () => {
    const { client } = fake(() => json(429, errorBody('rate.limited'), { 'Retry-After': '7' }));
    expect((await failure(calls.redeem(client))).retryAfterMs).toBe(7000);
    expect(retryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', Date.UTC(2026, 0, 1))).toBe(10_000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
  });

  it('never carries the ERP’s message or values into the error', async () => {
    const { client } = fake(() =>
      json(400, {
        message: 'Customer Qorvath Lantern is blocked',
        correlationId: 'x',
        errors: [{ code: 'request.invalid', message: 'Qorvath', key: 'C-1001' }],
      }),
    );
    const e = await failure(calls.query(client));
    expect(e.message).not.toContain('Qorvath');
    expect(JSON.stringify(e)).not.toContain('Qorvath');
  });

  it.each([
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['an empty body', () => new Response('', { status: 200 })],
    ['a session without its maximum', () => json(200, { ...session, maxExpiresAt: undefined })],
  ])('refuses %s as response.invalid', async (_, reply) => {
    const { client } = fake(reply);
    const e = await failure(calls.redeem(client));
    expect(e).toMatchObject({ code: 'response.invalid', status: 200 });
  });

  it('refuses a schema for another connector, and records that break it', async () => {
    let answer: unknown = { ...schema, id: 'vendors' };
    const { client } = fake(() => json(200, answer));
    expect((await failure(calls.schema(client))).code).toBe('response.invalid');
    answer = {
      records: [
        {
          id: '1',
          key: 'C-1',
          version: 'AAAAAAAAB9E=',
          values: { customerAccount: 'C-1', creditLimit: 25000 },
        },
      ],
      nextCursor: null,
      total: 1,
    };
    const e = await failure(client.query(TOKEN, 'customers', request, { schema }));
    expect(e.code).toBe('response.invalid');
    expect(e.message).toContain('$.records[0].values.creditLimit');
    expect(e.message).not.toContain('25000');
    answer = {
      records: [
        { id: '1', key: 'C-1', version: 'AAAAAAAAB9E=', values: {} },
        { id: '2', key: 'C-2', version: 'AAAAAAAAB9E=', values: {} },
        { id: '3', key: 'C-3', version: 'AAAAAAAAB9E=', values: {} },
      ],
      nextCursor: null,
      total: 3,
    };
    expect((await failure(client.query(TOKEN, 'customers', request))).message).toContain(
      'at most 2',
    );
  });

  it('reads no answer as network, and a cancel as aborted', async () => {
    const { client } = fake(() => Promise.reject(new TypeError(`Failed to fetch ${TOKEN}`)));
    const e = await failure(calls.connectors(client));
    expect(e).toMatchObject({ code: 'network', status: null });
    const controller = new AbortController();
    const slow = createErpClient(
      BASE,
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        ),
    );
    const pending = slow.connectors(TOKEN, { signal: controller.signal });
    controller.abort();
    expect((await failure(pending)).code).toBe('aborted');
    controller.abort();
    expect((await failure(slow.connectors(TOKEN, { signal: controller.signal }))).code).toBe(
      'aborted',
    );
  });

  it('gives up on a call that takes too long', async () => {
    const slow = createErpClient(
      BASE,
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('timeout'))),
        ),
      { timeoutMs: 20 },
    );
    expect(await failure(slow.connectors(TOKEN))).toMatchObject({ code: 'network' });
  });

  it('follows no redirect, so the token never reaches where one points', async () => {
    const seen: IncomingHttpHeaders[] = [];
    const target = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"connectors":[]}');
    });
    await new Promise<void>((done) => target.listen(0, '127.0.0.1', done));
    const to = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    const redirecting = createServer((req, res) =>
      res.writeHead(307, { Location: `${to}${req.url}` }).end(),
    );
    await new Promise<void>((done) => redirecting.listen(0, '127.0.0.1', done));
    try {
      const client = createErpClient(
        `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`,
      );
      expect((await failure(client.connectors(TOKEN))).code).toBe('network');
      expect(seen).toHaveLength(0);
    } finally {
      redirecting.close();
      target.close();
    }
  });
});
