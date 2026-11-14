// The erp-connect.1 contract suite (docs/INTEGRATIONS.md, "Contract `erp-connect.1`"; how to run
// it against a real ERP: README.md here). Against the mock it runs in `pnpm test`.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ErpContractError,
  ErpError,
  LIMITS,
  ROUTES,
  connectorRoute,
  commitStatusRoute,
  createErpClient,
  parseConnectSession,
  parseConnectors,
  parseErrorBody,
  parseLinkRedeem,
  parseQueryResponse,
  parseRenew,
  parseSchema,
  recordProblems,
  type ConnectSession,
  type ConnectorSchema,
  type ErpRecord,
  type FieldSchema,
  type QueryResponse,
  type WireValue,
} from '../../../packages/erp/src/index';
import {
  CONNECTORS,
  KEYS,
  ORIGIN,
  WORKSPACE,
  advance,
  baseUrl,
  code,
  connectTicket,
  control,
  createConnectTicket,
  freshWorkspace,
  has,
  lacks,
  linkTicket,
  makeLink,
  mockClientUrl,
  mockState,
  onMock,
  openSession,
  query,
  rateLimits,
  redeem,
  redeemLink,
  refused,
  resetMock,
  schemaOf,
  send,
  sharedLink,
  sharedSession,
  startServer,
  stopServer,
  type Answer,
} from './harness';

const MINUTE = 60_000;
const mockOnly = it.skipIf(!onMock);

// A real server's rate limits make the suite wait out 429s, a minute at a time.
if (!onMock) vi.setConfig({ testTimeout: 10 * MINUTE, hookTimeout: 10 * MINUTE });

beforeAll(startServer);
afterAll(stopServer);
beforeEach(resetMock);

/** Every page of a query, up to `maxPages`. */
async function allPages(
  token: string,
  id: string,
  request: Parameters<typeof query>[2],
  maxPages = 60,
): Promise<{ pages: QueryResponse[]; records: ErpRecord[] }> {
  const pages: QueryResponse[] = [];
  let cursor: string | null = null;
  do {
    const answer = await query(token, id, { ...request, cursor });
    expect(answer.status).toBe(200);
    const page = parseQueryResponse(answer.json, { pageSize: request.pageSize });
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null && pages.length < maxPages);
  return { pages, records: pages.flatMap((p) => p.records) };
}

const sortable = (schema: ConnectorSchema) =>
  schema.fields.find(
    (f) => f.sortable && ['decimal', 'integer', 'date', 'dateTime'].includes(f.type),
  );

function compare(f: FieldSchema, a: WireValue, b: WireValue): number {
  if (f.type === 'decimal') return Number(a) - Number(b);
  if (f.type === 'integer') return (a as number) - (b as number);
  return Date.parse(String(a)) - Date.parse(String(b));
}

// ---------------------------------------------------------------------------------------------

describe('links', () => {
  it.skipIf(lacks('admin', 'full'))('makes link tickets for ERP admins only', async () => {
    expect((await send('POST', ROUTES.linkCreateTicket, { body: {} })).status).toBe(401);
    expect(
      (await send('POST', ROUTES.linkCreateTicket, { apiKey: 'not-a-key', body: {} })).status,
    ).toBe(401);
    refused(
      await send('POST', ROUTES.linkCreateTicket, { apiKey: KEYS.full, body: {} }),
      403,
      'privilege.denied',
    );
    expect(await linkTicket()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.skipIf(lacks('admin'))('checks the Origin before the ticket', async () => {
    const ticket = await linkTicket();
    refused(await redeemLink(ticket, WORKSPACE, 'https://evil.example'), 403, 'origin.denied');
    refused(await redeemLink(ticket, WORKSPACE, null), 403, 'origin.denied');
    const answer = await redeemLink(ticket);
    expect(answer.status).toBe(200);
    const link = parseLinkRedeem(answer.json);
    if (onMock) expect(link).toMatchObject({ company: 'Kit', companyName: 'Kit Trading' });
  });

  it.skipIf(lacks('admin'))('takes a link ticket once', async () => {
    const ticket = await linkTicket();
    expect((await redeemLink(ticket, freshWorkspace())).status).toBe(200);
    refused(await redeemLink(ticket, freshWorkspace()), 401, 'ticket.invalid');
    refused(await redeemLink('A'.repeat(43)), 401, 'ticket.invalid');
    refused(
      await send('POST', ROUTES.linkRedeem, { body: { ticket: await linkTicket() } }),
      400,
      'request.invalid',
    );
  });

  mockOnly('lets a link ticket expire after 120 seconds', async () => {
    const ticket = await linkTicket();
    await advance(LIMITS.ticketMs + 1000);
    refused(await redeemLink(ticket), 401, 'ticket.invalid');
  });

  it.skipIf(lacks('admin', 'full'))('takes no connect ticket as a link ticket', async () => {
    const ticket = await connectTicket('full', (await sharedLink()).linkId);
    refused(await redeemLink(ticket, freshWorkspace()), 401, 'ticket.invalid');
  });

  it.skipIf(lacks('admin'))('answers the live link a company and workspace have', async () => {
    const workspaceId = freshWorkspace();
    const first = await makeLink('admin', workspaceId);
    const again = await makeLink('admin', workspaceId);
    expect(again.linkId).toBe(first.linkId);
    expect((await makeLink('admin', freshWorkspace())).linkId).not.toBe(first.linkId);
  });

  it.skipIf(lacks('admin', 'full'))('revokes for ERP admins only, twice as once', async () => {
    const link = await makeLink('admin', freshWorkspace());
    const revoke = (apiKey: string | undefined, linkId: string) =>
      send('POST', ROUTES.linkRevoke, { apiKey, body: { linkId } });
    expect((await revoke(undefined, link.linkId)).status).toBe(401);
    refused(await revoke(KEYS.full, link.linkId), 403, 'privilege.denied');
    refused(await revoke(KEYS.admin, 'no-such-link'), 400, 'request.invalid');
    expect((await revoke(KEYS.admin, link.linkId)).status).toBe(204);
    expect((await revoke(KEYS.admin, link.linkId)).status).toBe(204);
  });

  it.skipIf(lacks('admin', 'other'))('revokes only the admin’s own company’s links', async () => {
    const theirs = await makeLink('other', freshWorkspace());
    refused(
      await send('POST', ROUTES.linkRevoke, {
        apiKey: KEYS.admin,
        body: { linkId: theirs.linkId },
      }),
      400,
      'request.invalid',
    );
  });

  it.skipIf(lacks('admin', 'full'))(
    'ends every session of a revoked link, and only those',
    async () => {
      const workspaceId = freshWorkspace();
      const link = await makeLink('admin', workspaceId);
      const session = await openSession('full', { linkId: link.linkId, workspaceId });
      const other = await sharedSession('full');
      const ticket = await connectTicket('full', link.linkId, { workspaceId });
      expect(
        (
          await send('POST', ROUTES.linkRevoke, {
            apiKey: KEYS.admin,
            body: { linkId: link.linkId },
          })
        ).status,
      ).toBe(204);
      refused(
        await send('GET', ROUTES.connectors, { session: session.token }),
        403,
        'link.revoked',
      );
      refused(await send('POST', ROUTES.renew, { session: session.token }), 403, 'link.revoked');
      refused(await query(session.token, CONNECTORS[0]!, {}), 403, 'link.revoked');
      refused(await createConnectTicket('full', link.linkId, { workspaceId }), 403, 'link.revoked');
      refused(await redeem(ticket, workspaceId), 403, 'link.revoked');
      expect((await send('GET', ROUTES.connectors, { session: other.token })).status).toBe(200);
    },
  );
});

describe('connect tickets', () => {
  it.skipIf(lacks('admin', 'full'))('are made for a live link of the user’s company', async () => {
    const link = await sharedLink();
    const without = await send('POST', ROUTES.connectCreateTicket, {
      body: { workspaceId: WORKSPACE, linkId: link.linkId },
    });
    expect(without.status).toBe(401);
    expect(await connectTicket('full', link.linkId)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    refused(await createConnectTicket('full', 'no-such-link'), 403, 'link.revoked');
    refused(
      await createConnectTicket('full', link.linkId, { workspaceId: freshWorkspace() }),
      403,
      'link.revoked',
    );
    refused(
      await send('POST', ROUTES.connectCreateTicket, {
        apiKey: KEYS.full,
        body: { workspaceId: WORKSPACE, linkId: link.linkId, language: 'fr' },
      }),
      400,
      'request.invalid',
    );
  });

  it.skipIf(lacks('admin', 'full', 'other'))('are refused for another company’s link', async () => {
    const theirs = await sharedLink('other');
    refused(await createConnectTicket('full', theirs.linkId), 403, 'link.revoked');
  });

  mockOnly('are refused, as are sessions, when Workspace is off for the company', async () => {
    const link = await sharedLink();
    const session = await openSession('full');
    const ticket = await connectTicket('full', link.linkId);
    await control('workspace', { company: 'Kit', enabled: false });
    refused(await createConnectTicket('full', link.linkId), 403, 'link.revoked');
    refused(await redeem(ticket), 403, 'link.revoked');
    refused(await send('GET', ROUTES.connectors, { session: session.token }), 403, 'link.revoked');
    await control('workspace', { company: 'Kit', enabled: true });
    expect((await send('GET', ROUTES.connectors, { session: session.token })).status).toBe(200);
  });
});

describe('sessions', () => {
  it.skipIf(lacks('admin', 'full'))(
    'are redeemed from an allowed Origin, checked before the ticket',
    async () => {
      const link = await sharedLink();
      const ticket = await connectTicket('full', link.linkId);
      refused(await redeem(ticket, WORKSPACE, 'https://evil.example'), 403, 'origin.denied');
      refused(await redeem(ticket, WORKSPACE, null), 403, 'origin.denied');
      const answer = await redeem(ticket);
      expect(answer.status).toBe(200);
      const session = parseConnectSession(answer.json);
      expect(session.linkId).toBe(link.linkId);
      expect(session.company).toBe(link.company);
      expect(session.companyName).toBe(link.companyName);
      expect(session.language).toBe('en');
      // Ten hours after Redeem, and 30 minutes idle: 9.5 hours apart whatever the clocks say.
      const apart = Date.parse(session.maxExpiresAt) - Date.parse(session.expiresAt);
      expect(Math.abs(apart - (LIMITS.sessionMaxMs - LIMITS.sessionIdleMs))).toBeLessThan(MINUTE);
      if (onMock) {
        expect(Math.abs(Date.parse(session.expiresAt) - Date.now() - 30 * MINUTE)).toBeLessThan(
          5000,
        );
      }
    },
  );

  it.skipIf(lacks('admin', 'full'))('take the ticket’s language', async () => {
    const session = await openSession('full', { language: 'ar' });
    expect(session.language).toBe('ar');
  });

  it.skipIf(lacks('admin', 'full', 'limited'))(
    'belong to the user the ticket was made for',
    async () => {
      const alice = await sharedSession('full');
      const bob = await sharedSession('limited');
      expect(alice.user.id).not.toBe(bob.user.id);
      expect(alice.company).toBe(bob.company);
      if (onMock) {
        expect(alice.user).toEqual({ id: 'u101', displayName: 'Alice Haddad' });
        expect(bob.user).toEqual({ id: 'u102', displayName: 'Bob Mansour' });
      }
    },
  );

  it.skipIf(lacks('admin', 'full'))('take a ticket once', async () => {
    const ticket = await connectTicket('full', (await sharedLink()).linkId);
    expect((await redeem(ticket)).status).toBe(200);
    refused(await redeem(ticket), 401, 'ticket.invalid');
    refused(await redeem('B'.repeat(43)), 401, 'ticket.invalid');
    refused(await redeem(await linkTicket()), 401, 'ticket.invalid');
    refused(
      await send('POST', ROUTES.redeem, { body: { workspaceId: WORKSPACE } }),
      400,
      'request.invalid',
    );
  });

  it.skipIf(lacks('admin', 'full'))(
    'are refused for another workspace, using the ticket up',
    async () => {
      const ticket = await connectTicket('full', (await sharedLink()).linkId);
      refused(await redeem(ticket, freshWorkspace()), 401, 'ticket.invalid');
      refused(await redeem(ticket), 401, 'ticket.invalid');
    },
  );

  mockOnly('let a ticket expire after 120 seconds', async () => {
    const ticket = await connectTicket('full', (await sharedLink()).linkId);
    await advance(LIMITS.ticketMs - 5000);
    const early = await connectTicket('full', (await sharedLink()).linkId);
    await advance(6000);
    refused(await redeem(ticket), 401, 'ticket.invalid');
    expect((await redeem(early)).status).toBe(200);
  });

  it.skipIf(lacks('admin', 'full'))(
    'take only their token, and only in X-Connect-Session',
    async () => {
      const ticket = await connectTicket('full', (await sharedLink()).linkId);
      for (const session of [undefined, '', ticket, 'not-a-session-token-at-all-000000']) {
        refused(await send('GET', ROUTES.connectors, { session }), 401, 'session.expired');
        refused(await send('POST', ROUTES.renew, { session }), 401, 'session.expired');
        refused(await send('POST', ROUTES.end, { session }), 401, 'session.expired');
      }
      const { token } = await sharedSession('full');
      refused(
        await send('GET', ROUTES.connectors, { headers: { Authorization: `Bearer ${token}` } }),
        401,
        'session.expired',
      );
    },
  );

  it.skipIf(lacks('admin', 'full'))('renew, never past their maximum', async () => {
    const session = await openSession('full');
    if (onMock) await advance(10 * MINUTE);
    const answer = await send('POST', ROUTES.renew, { session: session.token });
    expect(answer.status).toBe(200);
    const { expiresAt } = parseRenew(answer.json);
    expect(Date.parse(expiresAt)).toBeGreaterThanOrEqual(Date.parse(session.expiresAt));
    expect(Date.parse(expiresAt)).toBeLessThanOrEqual(Date.parse(session.maxExpiresAt));
    if (onMock) {
      const moved = Date.parse(expiresAt) - Date.parse(session.expiresAt);
      expect(Math.abs(moved - 10 * MINUTE)).toBeLessThan(5000);
    }
  });

  mockOnly('end 30 minutes after the last Renew', async () => {
    const session = await openSession('full');
    await advance(29 * MINUTE);
    expect((await send('GET', ROUTES.connectors, { session: session.token })).status).toBe(200);
    await advance(2 * MINUTE);
    refused(
      await send('GET', ROUTES.connectors, { session: session.token }),
      401,
      'session.expired',
    );
    refused(await send('POST', ROUTES.renew, { session: session.token }), 401, 'session.expired');
  });

  mockOnly('end ten hours after Redeem however often they renew', async () => {
    const session = await openSession('full');
    const max = Date.parse(session.maxExpiresAt);
    for (let elapsed = 0; elapsed < 10 * 60 * MINUTE - 25 * MINUTE; elapsed += 25 * MINUTE) {
      await advance(25 * MINUTE);
      const answer = await send('POST', ROUTES.renew, { session: session.token });
      expect(answer.status).toBe(200);
      expect(Date.parse(parseRenew(answer.json).expiresAt)).toBeLessThanOrEqual(max);
    }
    await advance(26 * MINUTE);
    refused(await send('POST', ROUTES.renew, { session: session.token }), 401, 'session.expired');
  });

  it.skipIf(lacks('admin', 'full'))('end at once', async () => {
    const session = await openSession('full');
    const end = await send('POST', ROUTES.end, { session: session.token });
    expect(end.status).toBe(204);
    expect(end.json).toBeNull();
    refused(
      await send('GET', ROUTES.connectors, { session: session.token }),
      401,
      'session.expired',
    );
    refused(await send('POST', ROUTES.renew, { session: session.token }), 401, 'session.expired');
    refused(await send('POST', ROUTES.end, { session: session.token }), 401, 'session.expired');
  });
});

describe('connectors', () => {
  it.skipIf(lacks('admin', 'full', 'limited', 'none'))(
    'lists those the user may view',
    async () => {
      const list = async (role: 'full' | 'limited' | 'none') => {
        const answer = await send('GET', ROUTES.connectors, {
          session: (await sharedSession(role)).token,
        });
        expect(answer.status).toBe(200);
        return parseConnectors(answer.json).connectors;
      };
      const full = await list('full');
      expect(full.map((c) => c.id)).toEqual(expect.arrayContaining(CONNECTORS));
      // Read-only until Phase 7 (agreed with Track E).
      for (const c of full) expect(c.access).toBe('view');
      const limited = (await list('limited')).map((c) => c.id);
      expect(full.map((c) => c.id)).toEqual(expect.arrayContaining(limited));
      if (has('itemsOnHand')) expect(limited).not.toContain('itemsOnHand');
      expect(await list('none')).toEqual([]);
      if (onMock) {
        expect(full.map((c) => [c.id, c.schemaVersion])).toEqual([
          ['vendors', 'vendors.1'],
          ['customers', 'customers.1'],
          ['itemsOnHand', 'itemsOnHand.1'],
        ]);
        expect(limited).toEqual(['vendors', 'customers']);
      }
    },
  );

  describe.each(CONNECTORS.map((id) => [id]))('%s', (id) => {
    it.skipIf(lacks('admin', 'full'))('has a schema the contract allows, read-only', async () => {
      const schema = await schemaOf((await sharedSession('full')).token, id);
      expect(schema.id).toBe(id);
      for (const f of schema.fields) {
        expect(f, f.name).toMatchObject({ editable: false, editReason: 'notEditable' });
      }
      expect(schema.fields.some((f) => f.name === schema.keyField)).toBe(true);
    });

    it.skipIf(lacks('admin', 'full'))('answers a first page in the schema’s values', async () => {
      const { token } = await sharedSession('full');
      const schema = await schemaOf(token, id);
      const answer = await query(token, id, { pageSize: 25 });
      expect(answer.status).toBe(200);
      const page = parseQueryResponse(answer.json, { schema, pageSize: 25 });
      expect(page.records.length).toBe(Math.min(25, page.total));
      expect(page.nextCursor === null).toBe(page.total <= 25);
      for (const record of page.records) {
        expect(recordProblems(schema, record), record.id).toEqual([]);
        if (schema.idField !== null) expect(record.values).not.toHaveProperty(schema.idField);
      }
    });
  });

  it.skipIf(lacks('admin', 'full', 'none', 'limited'))(
    'refuses connectors the user may not view',
    async () => {
      const id = CONNECTORS[0]!;
      const none = (await sharedSession('none')).token;
      refused(
        await send('GET', connectorRoute(id, 'Schema'), { session: none }),
        403,
        'privilege.denied',
      );
      refused(await query(none, id, {}), 403, 'privilege.denied');
      if (has('itemsOnHand')) {
        const limited = (await sharedSession('limited')).token;
        refused(
          await send('GET', connectorRoute('itemsOnHand', 'Schema'), { session: limited }),
          403,
          'privilege.denied',
        );
      }
      const full = (await sharedSession('full')).token;
      refused(
        await send('GET', connectorRoute('noSuchConnector', 'Schema'), { session: full }),
        404,
        'connector.notFound',
      );
      refused(await query(full, 'noSuchConnector', {}), 404, 'connector.notFound');
    },
  );

  mockOnly('keeps fields from users who may not see them', async () => {
    const alice = await schemaOf((await sharedSession('full')).token, 'customers');
    const bob = await schemaOf((await sharedSession('limited')).token, 'customers');
    expect(alice.fields.map((f) => f.name)).toContain('creditLimit');
    expect(bob.fields.map((f) => f.name)).not.toContain('creditLimit');
    const answer = await query((await sharedSession('limited')).token, 'customers', {});
    for (const record of parseQueryResponse(answer.json, { schema: bob }).records) {
      expect(record.values).not.toHaveProperty('creditLimit');
    }
    refused(
      await query((await sharedSession('limited')).token, 'customers', { fields: ['creditLimit'] }),
      400,
      'request.invalid',
    );
  });
});

describe('queries', () => {
  const id = CONNECTORS[0]!;
  let token = '';
  let schema: ConnectorSchema;

  beforeEach(async () => {
    if (lacks('admin', 'full')) return;
    token = (await sharedSession('full')).token;
    schema = await schemaOf(token, id);
  });

  it.skipIf(lacks('admin', 'full'))('send exactly the fields asked for', async () => {
    const other = schema.fields.find((f) => f.name !== schema.keyField)!;
    const fields = [other.name, schema.keyField];
    const answer = await query(token, id, { fields, pageSize: 10 });
    expect(answer.status).toBe(200);
    const page = parseQueryResponse(answer.json, { schema, fields });
    for (const record of page.records) {
      expect(Object.keys(record.values).sort()).toEqual([...fields].sort());
      expect(recordProblems(schema, record, fields)).toEqual([]);
    }
    refused(await query(token, id, { fields: ['noSuchField'] }), 400, 'request.invalid');
  });

  it.skipIf(lacks('admin', 'full'))('page by cursor, counting every match', async () => {
    const first = parseQueryResponse((await query(token, id, { pageSize: 1 })).json);
    const pageSize = Math.min(schema.maxPageSize, Math.max(1, Math.ceil(first.total / 4)));
    const { pages, records } = await allPages(token, id, { pageSize });
    for (const page of pages) expect(page.total).toBe(first.total);
    expect(new Set(records.map((r) => r.id)).size).toBe(records.length);
    if (pages.at(-1)!.nextCursor === null) expect(records.length).toBe(first.total);
    if (onMock) expect(pages.length).toBeGreaterThanOrEqual(4);
  });

  it.skipIf(lacks('admin', 'full'))('refuse another query’s cursor', async () => {
    const key = schema.fields.find((f) => f.name === schema.keyField)!;
    const sortBy = key.sortable ? key : schema.fields.find((f) => f.sortable);
    const page = parseQueryResponse((await query(token, id, { pageSize: 2 })).json);
    if (page.nextCursor === null) return;
    const cursor = page.nextCursor;
    expect((await query(token, id, { pageSize: 2, cursor })).status).toBe(200);
    if (sortBy) {
      refused(
        await query(token, id, {
          pageSize: 2,
          cursor,
          sort: [{ field: sortBy.name, direction: 'desc' }],
        }),
        400,
        'request.invalid',
      );
    }
    refused(
      await query(token, id, { pageSize: 2, cursor, fields: [schema.keyField] }),
      400,
      'request.invalid',
    );
    refused(
      await query(token, id, { pageSize: 2, cursor, filter: { search: 'a' } }),
      400,
      'request.invalid',
    );
    refused(
      await query(token, id, { pageSize: 2, cursor: 'not-a-cursor' }),
      400,
      'request.invalid',
    );
  });

  it.skipIf(lacks('admin', 'full'))('sort by sortable fields, up to three', async () => {
    const f = sortable(schema);
    if (!f) return;
    for (const direction of ['asc', 'desc'] as const) {
      const { records } = await allPages(
        token,
        id,
        { pageSize: 40, sort: [{ field: f.name, direction }] },
        3,
      );
      const values = records.map((r) => r.values[f.name]!).filter((v) => v !== null);
      for (let i = 1; i < values.length; i++) {
        const order = compare(f, values[i - 1]!, values[i]!);
        expect(
          direction === 'asc' ? order <= 0 : order >= 0,
          `${f.name} ${direction} at ${i}`,
        ).toBe(true);
      }
    }
    const four = Array.from({ length: 4 }, () => ({ field: f.name, direction: 'asc' as const }));
    refused(await query(token, id, { sort: four }), 400, 'request.invalid');
    const unsortable = schema.fields.find((x) => !x.sortable);
    if (unsortable) {
      refused(
        await query(token, id, { sort: [{ field: unsortable.name, direction: 'asc' }] }),
        400,
        'request.invalid',
      );
    }
    refused(
      await send('POST', connectorRoute(id, 'Query'), {
        session: token,
        body: { filter: {}, cursor: null, pageSize: 5, sort: [{ field: f.name, direction: 'up' }] },
      }),
      400,
      'request.invalid',
    );
  });

  it.skipIf(lacks('admin', 'full'))('filter by equals on filterable fields only', async () => {
    const filterable = schema.fields.find(
      (f) =>
        f.filterable && (f.type === 'lookup' || f.type === 'boolean') && f.name !== schema.keyField,
    );
    const all = parseQueryResponse((await query(token, id, { pageSize: 50 })).json);
    if (filterable) {
      const value = all.records.map((r) => r.values[filterable.name]).find((v) => v !== null);
      if (value !== undefined) {
        const answer = await query(token, id, { filter: { equals: { [filterable.name]: value } } });
        expect(answer.status).toBe(200);
        const page = parseQueryResponse(answer.json, { schema });
        expect(page.total).toBeGreaterThan(0);
        expect(page.total).toBeLessThanOrEqual(all.total);
        for (const record of page.records) expect(record.values[filterable.name]).toBe(value);
      }
    }
    const not = schema.fields.find((f) => !f.filterable);
    if (not) {
      refused(
        await query(token, id, { filter: { equals: { [not.name]: 'x' } } }),
        400,
        'request.invalid',
      );
    }
    refused(
      await query(token, id, { filter: { equals: { noSuchField: 'x' } } }),
      400,
      'request.invalid',
    );
  });

  it.skipIf(lacks('admin', 'full'))(
    'search what the ERP’s list searches, ignoring case',
    async () => {
      const all = parseQueryResponse((await query(token, id, { pageSize: 5 })).json);
      const target = all.records[0];
      if (!target) return;
      const text = target.key.slice(0, Math.max(2, target.key.length - 1));
      for (const search of [text.toLowerCase(), text.toUpperCase()]) {
        const found = await allPages(token, id, { pageSize: 100, filter: { search } }, 20);
        expect(found.records.map((r) => r.id)).toContain(target.id);
        expect(found.pages[0]!.total).toBeLessThanOrEqual(all.total);
      }
    },
  );

  mockOnly('search by name and by what is never sent', async () => {
    const byName = parseQueryResponse(
      (await query(token, 'vendors', { filter: { search: 'qORVATH lantern' } })).json,
    );
    expect(byName.records.map((r) => r.key)).toEqual(['V-1001']);
    // The Vendors list searches the phone, which Query never sends.
    const byPhone = parseQueryResponse(
      (await query(token, 'vendors', { filter: { search: '0223456789' } })).json,
    );
    expect(byPhone.records.map((r) => r.key)).toEqual(['V-1003']);
    expect(byPhone.records[0]!.values).not.toHaveProperty('phone');
  });

  it.skipIf(lacks('admin', 'full'))('refuse a request out of shape', async () => {
    const route = connectorRoute(id, 'Query');
    for (const body of [
      undefined,
      { filter: {}, cursor: null, pageSize: 0 },
      { filter: {}, cursor: null, pageSize: schema.maxPageSize + 1 },
      { filter: {}, cursor: null, pageSize: 2.5 },
      { filter: 'all', cursor: null, pageSize: 5 },
      { filter: { equals: [] }, cursor: null, pageSize: 5 },
    ]) {
      refused(await send('POST', route, { session: token, body }), 400, 'request.invalid');
    }
    refused(
      await send('POST', route, { session: token, raw: '{not json' }),
      400,
      'request.invalid',
    );
  });

  it.skipIf(lacks('admin', 'full', 'limited') || !has('customers'))(
    'apply the ERP’s record rules: two users see different customers',
    async () => {
      const limited = (await sharedSession('limited')).token;
      const pageSize = Math.min(500, (await schemaOf(token, 'customers')).maxPageSize);
      const full = await allPages(token, 'customers', { pageSize }, 4);
      const mine = await allPages(limited, 'customers', { pageSize }, 4);
      expect(mine.pages[0]!.total).toBeLessThan(full.pages[0]!.total);
      if (full.pages.at(-1)!.nextCursor === null) {
        const ids = new Set(full.records.map((r) => r.id));
        for (const record of mine.records) expect(ids.has(record.id), record.id).toBe(true);
      }
      if (onMock) {
        expect(mine.records.length).toBeGreaterThan(0);
        for (const record of mine.records) expect(record.values.salesperson).toBe('S-BOB');
      }
    },
  );

  it.skipIf(lacks('admin', 'full', 'other'))('never answer another company’s records', async () => {
    const theirs = await openSession('other');
    expect(theirs.company).not.toBe((await sharedSession('full')).company);
    const ours = await allPages(token, id, { pageSize: 200 }, 10);
    const other = await allPages(theirs.token, id, { pageSize: 200 }, 10);
    const ids = new Set(ours.records.map((r) => r.id));
    for (const record of other.records) expect(ids.has(record.id), record.id).toBe(false);
    if (onMock) {
      const state = await mockState();
      const dotWords = state.markers.Dot!;
      const text = JSON.stringify(ours.records);
      for (const word of dotWords) expect(text).not.toContain(word);
      // Both companies have a V-1001, which each sees as its own.
      expect(ours.records.find((r) => r.key === 'V-1001')?.values.vendorName).toBe(
        'Qorvath Lantern Trading',
      );
      expect(other.records.find((r) => r.key === 'V-1001')?.values.vendorName).toBe(
        'Ferrowyn Dot Foods',
      );
    }
  });

  mockOnly('refuse Commit until Phase 7, and know no commit', async () => {
    refused(
      await send('POST', connectorRoute(id, 'Commit'), {
        session: token,
        body: {
          commitId: crypto.randomUUID(),
          schemaVersion: schema.schemaVersion,
          dryRun: true,
          records: [],
        },
      }),
      403,
      'privilege.denied',
    );
    const status = await send('GET', commitStatusRoute(id, crypto.randomUUID()), {
      session: token,
    });
    expect(status.status).toBe(200);
    expect(status.json).toEqual({ status: 'unknown' });
    refused(
      await send('GET', commitStatusRoute(id, 'not-a-uuid'), { session: token }),
      400,
      'request.invalid',
    );
  });
});

describe('CORS', () => {
  // A preflight names the method of the route it is for, as a browser's does: a server may
  // match it to that route alone.
  const preflight = (route: string, method: string, origin: string, headers: string) =>
    send('OPTIONS', route, {
      origin,
      headers: {
        'Access-Control-Request-Method': method,
        'Access-Control-Request-Headers': headers,
      },
    });

  it('allows Workspace’s origins only, without credentials', async () => {
    for (const [route, method] of [
      [ROUTES.redeem, 'POST'],
      [ROUTES.renew, 'POST'],
      [ROUTES.connectors, 'GET'],
      [connectorRoute(CONNECTORS[0]!, 'Query'), 'POST'],
      [ROUTES.linkRedeem, 'POST'],
    ] as const) {
      const ok = await preflight(route, method, ORIGIN, 'content-type,x-connect-session');
      expect(ok.status).toBeLessThan(300);
      expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
      expect(ok.headers.get('Access-Control-Allow-Methods') ?? '').toContain(method);
      expect((ok.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase()).toMatch(
        /x-connect-session/,
      );
      expect(ok.headers.get('Access-Control-Allow-Credentials')).not.toBe('true');
      const evil = await preflight(
        route,
        method,
        'https://evil.example',
        'content-type,x-connect-session',
      );
      expect(evil.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.example');
      expect(evil.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
    }
  });

  it.skipIf(lacks('admin', 'full'))('exposes the correlation id and Retry-After', async () => {
    const answer = await send('GET', ROUTES.connectors, {
      session: (await sharedSession('full')).token,
    });
    expect(answer.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const exposed = (answer.headers.get('Access-Control-Expose-Headers') ?? '').toLowerCase();
    expect(exposed).toContain('x-correlation-id');
    expect(exposed).toContain('retry-after');
  });
});

describe('the client against the server', () => {
  /** Node's fetch sends no Origin: this one sends Workspace's, as a browser would. */
  const browserFetch = (input: string, init: RequestInit) =>
    fetch(input, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Origin: ORIGIN },
    });

  it.skipIf(lacks('admin', 'full'))('connects, reads every connector and ends', async () => {
    const client = createErpClient(baseUrl(), browserFetch);
    const link = await sharedLink();
    const session = await client.redeem(await connectTicket('full', link.linkId), WORKSPACE);
    expect(session.linkId).toBe(link.linkId);
    const connectors = await client.connectors(session.token);
    for (const { id } of connectors) {
      const schema = await client.schema(session.token, id);
      const page = await client.query(
        session.token,
        id,
        { filter: {}, cursor: null, pageSize: 20 },
        { schema },
      );
      expect(page.records.length).toBeLessThanOrEqual(20);
      if (page.nextCursor) {
        await client.query(
          session.token,
          id,
          { filter: {}, cursor: page.nextCursor, pageSize: 20 },
          { schema },
        );
      }
    }
    expect(Date.parse((await client.renew(session.token)).expiresAt)).toBeGreaterThan(0);
    await client.end(session.token, { keepalive: true });
    await expect(client.connectors(session.token)).rejects.toMatchObject({
      code: 'session.expired',
      status: 401,
    });
  });

  it.skipIf(lacks('admin', 'full'))('maps the server’s refusals to codes', async () => {
    const client = createErpClient(baseUrl(), browserFetch);
    const used = await connectTicket('full', (await sharedLink()).linkId);
    await client.redeem(used, WORKSPACE);
    await expect(client.redeem(used, WORKSPACE)).rejects.toMatchObject({ code: 'ticket.invalid' });
    const { token } = await sharedSession('full');
    await expect(client.schema(token, 'noSuchConnector')).rejects.toMatchObject({
      code: 'connector.notFound',
      status: 404,
    });
    const failure = await client
      .query(token, CONNECTORS[0]!, { filter: {}, cursor: null, pageSize: 0 })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ErpError);
    expect(failure).toMatchObject({ code: 'request.invalid', status: 400 });
    expect((failure as ErpError).correlationId).toBeTruthy();
  });

  describe.skipIf(!onMock)('catches malformed answers', () => {
    const fault = (match: string, body: unknown, status = 200) =>
      control('fault', { match, status, body });

    async function caught(promise: Promise<unknown>): Promise<ErpError> {
      const error = await promise.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ErpError);
      expect((error as ErpError).code).toBe('response.invalid');
      return error as ErpError;
    }

    it('in a session, its renewal and the connector list', async () => {
      const client = createErpClient(baseUrl(), browserFetch);
      const link = await sharedLink();
      const good = parseConnectSession(
        (await redeem(await connectTicket('full', link.linkId))).json,
      );
      const { maxExpiresAt, ...noMax } = good;
      void maxExpiresAt;
      await fault('Session/Redeem$', noMax);
      await caught(client.redeem(await connectTicket('full', link.linkId), WORKSPACE));
      await fault('Session/Redeem$', { ...good, token: 'has a space and is long enough' });
      const error = await caught(
        client.redeem(await connectTicket('full', link.linkId), WORKSPACE),
      );
      expect(error.message).not.toContain('has a space');
      await fault('Session/Renew$', { expiresAt: '2026-11-14 10:00' });
      await caught(client.renew(good.token));
      await fault('Connectors$', {
        connectors: [{ id: 'vendors', kind: 'entity', schemaVersion: 'vendors.1', access: 'view' }],
      });
      await caught(client.connectors(good.token));
      expect(() => parseConnectors({ connectors: [{ id: 'vendors' }] })).toThrow(ErpContractError);
    });

    it('in a schema and a page of records', async () => {
      const client = createErpClient(baseUrl(), browserFetch);
      const { token } = await sharedSession('full');
      const schema = await client.schema(token, 'vendors');
      const raw = (await send('GET', connectorRoute('vendors', 'Schema'), { session: token }))
        .json as {
        fields: Record<string, unknown>[];
      };
      const noScale = {
        ...raw,
        fields: raw.fields.map((f) => (f.type === 'decimal' ? { ...f, scale: undefined } : f)),
      };
      await fault('vendors/Schema$', noScale);
      await caught(client.schema(token, 'vendors'));
      expect(() => parseSchema(noScale)).toThrow(ErpContractError);

      const page = (await query(token, 'vendors', { pageSize: 3 })).json as {
        records: { values: Record<string, unknown> }[];
      };
      const asNumber = {
        ...page,
        records: page.records.map((r) => ({ ...r, values: { ...r.values, debitLimit: 15000 } })),
      };
      await fault('vendors/Query$', asNumber);
      const error = await caught(
        client.query(token, 'vendors', { filter: {}, cursor: null, pageSize: 3 }, { schema }),
      );
      expect(error.message).toContain('debitLimit');
      const extra = {
        ...page,
        records: page.records.map((r) => ({ ...r, values: { ...r.values, phone: '0223456789' } })),
      };
      await fault('vendors/Query$', extra);
      await caught(
        client.query(token, 'vendors', { filter: {}, cursor: null, pageSize: 3 }, { schema }),
      );
      await fault('vendors/Query$', { ...page, total: -1 });
      await caught(client.query(token, 'vendors', { filter: {}, cursor: null, pageSize: 3 }));
    });

    it('in an error body, reading the status instead', async () => {
      const client = createErpClient(baseUrl(), browserFetch);
      const { token } = await sharedSession('full');
      await fault('Connectors$', { message: 'No correlation id', errors: [] }, 503);
      const error = await client.connectors(token).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'server', status: 503 });
      expect(() => parseErrorBody({ message: 'x', errors: [] })).toThrow(ErpContractError);
      await control('fault', { match: 'Connectors$', drop: true });
      expect(await client.connectors(token).catch((e: unknown) => e)).toMatchObject({
        code: 'network',
      });
    });
  });
});

describe.skipIf(!onMock)('the mock', () => {
  it('makes tickets without the pop-up, and never shows a token', async () => {
    const link = await sharedLink();
    const made = (await control('connect-ticket', {
      user: 'bob',
      workspaceId: WORKSPACE,
      linkId: link.linkId,
      language: 'ar',
    })) as { ticket: string };
    const answer = await redeem(made.ticket);
    const session: ConnectSession = parseConnectSession(answer.json);
    expect(session).toMatchObject({ language: 'ar', user: { displayName: 'Bob Mansour' } });
    const linkMade = (await control('link-ticket', { user: 'erin' })) as {
      ticket: string;
      url: string;
    };
    expect(linkMade.url.endsWith(`#/erp-link/${linkMade.ticket}`)).toBe(true);
    const dot = parseLinkRedeem((await redeemLink(linkMade.ticket)).json);
    expect(dot).toMatchObject({ company: 'Dot', companyName: 'Dot Foods' });
    const state = await mockState();
    expect(JSON.stringify(state)).not.toContain(session.token);
    expect(state.sessions).toHaveLength(1);
    expect(state.links.map((l) => l.company).sort()).toEqual(['Dot', 'Kit']);
    expect(state.records.customers!.length).toBe(250);
    await control('revoke-link', { linkId: link.linkId });
    refused(await send('GET', ROUTES.connectors, { session: session.token }), 403, 'link.revoked');
    expect((await mockState()).sessions[0]!.live).toBe(false);
  });

  it('marks every record with a word found nowhere else', async () => {
    const state = await mockState();
    const words = [...state.markers.Kit!, ...state.markers.Dot!];
    for (const [id, records] of Object.entries(state.records)) {
      for (const record of records) {
        const name = String(
          record.values[
            id === 'vendors' ? 'vendorName' : id === 'customers' ? 'customerName' : 'itemName'
          ],
        );
        expect(
          words.some((w) => name.includes(w)),
          `${id} ${record.key}`,
        ).toBe(true);
      }
    }
  });

  it('serves the ERP client’s pages', async () => {
    const client = mockClientUrl()!;
    for (const path of [
      '/',
      '/link',
      '/workspace-connect?workspace=w&link=l&state=SSSSSSSSSSSSSSSSSSSSSS&return=web',
    ]) {
      const response = await fetch(client + path);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(response.headers.get('Cross-Origin-Opener-Policy')).toBeNull();
    }
    const page = await (await fetch(`${client}/workspace-connect?state=</script>`)).text();
    expect(page).not.toContain('</script>"');
    // The connect page's calls are its own origin's: CORS lets it reach the ERP client's routes.
    const pre = await send('OPTIONS', ROUTES.connectCreateTicket, {
      origin: client,
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-api-key',
      },
    });
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe(client);
    const workspace = await send('OPTIONS', ROUTES.connectCreateTicket, {
      origin: ORIGIN,
      headers: { 'Access-Control-Request-Method': 'POST' },
    });
    expect(workspace.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('answers faults it is given', async () => {
    const { token } = await sharedSession('full');
    await control('fault', {
      match: 'Connectors$',
      status: 503,
      code: 'rate.limited',
      retryAfter: 3,
      times: 2,
    });
    for (let i = 0; i < 2; i++) {
      const answer = await send('GET', ROUTES.connectors, { session: token });
      expect(answer.status).toBe(503);
      expect(answer.headers.get('Retry-After')).toBe('3');
      expect(code(answer)).toBe('rate.limited');
    }
    expect((await send('GET', ROUTES.connectors, { session: token })).status).toBe(200);
  });
});

// Last: on a real server these spend this machine's allowance for a minute.
describe.skipIf(!rateLimits)('rate limits', () => {
  /** Sends until the server refuses, at most `max` times, and gives the refusal. */
  async function until429(make: () => Promise<Answer>, max: number): Promise<Answer> {
    for (let i = 0; i < max; i++) {
      const answer = await make();
      if (answer.status === 429) return answer;
    }
    throw new Error(`No 429 in ${max} requests.`);
  }

  function checkRefusal(answer: Answer): void {
    refused(answer, 429, 'rate.limited');
    const seconds = Number(answer.headers.get('Retry-After'));
    expect(Number.isInteger(seconds) && seconds >= 1 && seconds <= 60).toBe(true);
    expect(answer.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  }

  it.skipIf(lacks('admin', 'full'))(
    'count tickets and redeems together, leaving a refused ticket usable',
    async () => {
      const link = await sharedLink();
      const ticket = await connectTicket('full', link.linkId);
      if (onMock) await control('limits', { ticketsPerMinute: 2 });
      const limited = (t: string) =>
        send('POST', ROUTES.redeem, { body: { ticket: t, workspaceId: WORKSPACE }, limited: true });
      const refusedRedeem = await until429(
        () => limited(onMock ? 'C'.repeat(43) : 'D'.repeat(43)),
        onMock ? 3 : 400,
      );
      checkRefusal(refusedRedeem);
      if (onMock) {
        refused(await createConnectTicket('full', link.linkId), 429, 'rate.limited');
        refused(await limited(ticket), 429, 'rate.limited');
        await advance(MINUTE);
        expect((await limited(ticket)).status).toBe(200);
      }
    },
  );

  it.skipIf(lacks('admin', 'full'))('count Renew and End together', async () => {
    const session = await openSession('full');
    if (onMock) await control('limits', { sessionPerMinute: 2 });
    const renew = () => send('POST', ROUTES.renew, { session: session.token, limited: true });
    checkRefusal(await until429(renew, onMock ? 3 : 400));
    if (onMock) {
      refused(
        await send('POST', ROUTES.end, { session: session.token, limited: true }),
        429,
        'rate.limited',
      );
      // Other routes are not counted.
      expect((await send('GET', ROUTES.connectors, { session: session.token })).status).toBe(200);
      await advance(MINUTE);
      expect((await send('POST', ROUTES.end, { session: session.token })).status).toBe(204);
    }
  });
});
