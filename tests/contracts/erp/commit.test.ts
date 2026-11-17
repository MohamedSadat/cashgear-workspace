// erp-connect.1's Commit and CommitStatus (Phase 7, docs/INTEGRATIONS.md, "`Commit` and
// `CommitStatus`"), against the mock in `pnpm test` or a real ERP at ERP_BASE_URL (README.md).
// On a real server every commit that writes is undone by another commit before the case ends,
// so the test tenant's records stay as they were. Phase 10 ("Customers and Items on hand
// editable", Track E9 runs these against UnifiedAPI): both connectors' privilege matrix per field,
// every check's code, a conflict from a change in the ERP, idempotency, the audit naming the page,
// an item's shared name and group applied to every row and two values refused, the customer
// list's ownership rule, and nothing of stock written.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ErpDraft,
  ErpError,
  ROUTES,
  commitStatusRoute,
  connectorRoute,
  createErpClient,
  parseCommitResponse,
  parseCommitStatus,
  parseConflictBody,
  parseConnectors,
  parseErrorBody,
  parseQueryResponse,
  type CommitRecord,
  type CommitRequest,
  type ConnectorSchema,
  type ErpRecord,
  type QueryRequest,
  type WireValue,
} from '../../../packages/erp/src/index';
import {
  EDIT_TABLES,
  ORIGIN,
  SCHEMA_VERSIONS,
  SHARED_FIELDS,
  WORKSPACE,
  baseUrl,
  control,
  expectedEditing,
  grantOf,
  has,
  lacks,
  onMock,
  openSession,
  query,
  refused,
  resetMock,
  schemaOf,
  send,
  sharedSession,
  startServer,
  stopServer,
  type Answer,
  type Grant,
  type Role,
} from './harness';
import type { MockAuditRow } from '../../mocks/erp/server.mjs';

const MINUTE = 60_000;
const mockOnly = it.skipIf(!onMock);
if (!onMock) vi.setConfig({ testTimeout: 10 * MINUTE, hookTimeout: 10 * MINUTE });

beforeAll(startServer);
afterAll(stopServer);
beforeEach(resetMock);

const PAGE = '01930000-0000-7000-8000-00000000beef';
const BLOCK = 'Contract0001';
const source = (over: Record<string, unknown> = {}) => ({
  workspaceId: WORKSPACE,
  pageId: PAGE,
  blockId: BLOCK,
  ...over,
});

/** A record's change of `values`, from what it was read with. */
const change = (record: ErpRecord, values: Record<string, WireValue>): CommitRecord => ({
  id: record.id,
  key: record.key,
  version: record.version,
  changes: Object.fromEntries(
    Object.entries(values).map(([f, to]) => [f, { from: record.values[f] ?? null, to }]),
  ),
});

const body = (
  records: readonly CommitRecord[],
  dryRun: boolean,
  over: Record<string, unknown> = {},
): CommitRequest =>
  ({
    commitId: randomUUID(),
    schemaVersion: 'vendors.1',
    dryRun,
    source: source(),
    records,
    ...over,
  }) as CommitRequest;

const commit = (token: string, request: unknown, connector = 'vendors'): Promise<Answer> =>
  send('POST', connectorRoute(connector, 'Commit'), { session: token, body: request });

const status = (token: string, commitId: string, connector = 'vendors'): Promise<Answer> =>
  send('GET', commitStatusRoute(connector, commitId), { session: token });

/** Vendors' first records in account order, and its schema, as `role` sees them. */
async function vendors(
  role: Role,
  pageSize = 20,
): Promise<{ token: string; schema: ConnectorSchema; records: ErpRecord[] }> {
  const { token } = await sharedSession(role);
  const schema = await schemaOf(token, 'vendors');
  const answer = await query(token, 'vendors', {
    pageSize,
    sort: [{ field: 'vendorAccount', direction: 'asc' }],
  });
  expect(answer.status).toBe(200);
  const records = parseQueryResponse(answer.json, { schema, pageSize }).records.filter(
    // The mock's locked record is for its own case.
    (r) => !(onMock && r.key === 'V-1005'),
  );
  return { token, schema, records };
}

/** The record as the ERP has it now. */
async function reread(token: string, schema: ConnectorSchema, id: string): Promise<ErpRecord> {
  const answer = await query(token, 'vendors', {
    pageSize: 200,
    sort: [{ field: 'vendorAccount', direction: 'asc' }],
  });
  const found = parseQueryResponse(answer.json, { schema }).records.find((r) => r.id === id);
  expect(found, `record ${id}`).toBeTruthy();
  return found!;
}

/** On a real server, the record's fields put back as they were read. */
async function restore(
  token: string,
  schema: ConnectorSchema,
  original: ErpRecord,
  fields: readonly string[],
): Promise<void> {
  if (onMock) return;
  const now = await reread(token, schema, original.id);
  const back = Object.fromEntries(fields.map((f) => [f, original.values[f] ?? null]));
  const answer = await commit(token, body([{ ...change(now, back) }], false));
  expect(answer.status, 'the record put back').toBe(200);
}

const unique = () => `cgw-contract ${randomUUID().slice(0, 8)}`;
const VIEWABLE_EDIT = lacks('admin', 'edit');

/**
 * What each role's access is, per connector (track-e8-brief.md's table of test users): the EDIT
 * user edits Vendors and Customers and does not see Items on hand; the ADVEDIT user edits all
 * three, with AdvEdit on Vendors and Customers. Absent: whatever the server says.
 */
const ACCESS: Readonly<Record<'full' | 'edit' | 'advEdit', Readonly<Record<string, Grant>>>> = {
  full: {},
  edit: { vendors: 'edit', customers: 'edit' },
  advEdit: { vendors: 'advEdit', customers: 'advEdit', itemsOnHand: 'edit' },
};

describe('an editable connector', () => {
  it.skipIf(lacks('admin', 'full', 'edit', 'advEdit'))(
    'resolves access and every field’s editing for each user, as the contract’s tables say',
    async () => {
      for (const role of ['full', 'edit', 'advEdit'] as const) {
        const { token } = await sharedSession(role);
        const listed = parseConnectors(
          (await send('GET', ROUTES.connectors, { session: token })).json,
        ).connectors;
        for (const summary of listed) {
          if (!EDIT_TABLES[summary.id] || !has(summary.id)) continue;
          const expected = ACCESS[role][summary.id];
          if (expected) expect(summary.access, `${role} ${summary.id}`).toBe('edit');
          if (onMock && !expected) expect(summary.access, `${role} ${summary.id}`).toBe('view');
          const schema = await schemaOf(token, summary.id);
          const grant = grantOf(summary.access, schema);
          if (expected) expect(grant, `${role} ${summary.id}`).toBe(expected);
          for (const f of schema.fields) {
            expect(f, `${role} ${summary.id}.${f.name}`).toMatchObject(
              expectedEditing(summary.id, f.name, grant),
            );
          }
          // Phase 10: one budget for every editable connector, whoever reads it.
          expect(schema.maxCommitRecords).toBe(500);
        }
        if (onMock && role === 'edit') {
          expect(listed.map((c) => c.id)).not.toContain('itemsOnHand');
        }
      }
    },
  );
});

describe('commits', () => {
  it.skipIf(VIEWABLE_EDIT)('a dry run checks everything and writes nothing', async () => {
    const { token, schema, records } = await vendors('edit');
    const record = records[0]!;
    const address = unique();
    const request = body([change(record, { address })], true);
    const answer = await commit(token, request);
    expect(answer.status).toBe(200);
    const response = parseCommitResponse(answer.json, { request, schema });
    expect(response).toMatchObject({ dryRun: true, committedAt: null });
    expect(response.records[0]!.version).toBe(record.version);
    expect(response.records[0]!.values.address).toBe(address);
    const now = await reread(token, schema, record.id);
    expect(now.version).toBe(record.version);
    expect(now.values.address).toBe(record.values.address ?? null);
    // A dry run stores nothing, so its id is unknown and the real commit may reuse it.
    expect((await status(token, request.commitId)).json).toEqual({ status: 'unknown' });
  });

  it.skipIf(VIEWABLE_EDIT)(
    'a commit writes once; a retry by its id answers the same; another payload under it is refused',
    async () => {
      const { token, schema, records } = await vendors('edit');
      const record = records[1] ?? records[0]!;
      const address = unique();
      const request = body([change(record, { address })], false);
      const first = await commit(token, request);
      expect(first.status).toBe(200);
      const written = parseCommitResponse(first.json, { request, schema });
      try {
        expect(written.dryRun).toBe(false);
        expect(written.committedAt).not.toBeNull();
        expect(written.records[0]!.version).not.toBe(record.version);
        expect(written.records[0]!.values.address).toBe(address);
        const now = await reread(token, schema, record.id);
        expect(now.values.address).toBe(address);
        expect(now.version).toBe(written.records[0]!.version);

        const again = await commit(token, request);
        expect(again.status).toBe(200);
        expect(again.json).toEqual(first.json);
        const asked = await status(token, request.commitId);
        expect(asked.status).toBe(200);
        expect(
          parseCommitStatus(asked.json, { request, schema, commitId: request.commitId }),
        ).toEqual({ status: 'committed', ...written });
        // The same id, upper case, is the same commit.
        expect((await status(token, request.commitId.toUpperCase())).json).toMatchObject({
          status: 'committed',
        });
        const other = { ...request, records: [change(record, { address: unique() })] };
        refused(await commit(token, other), 400, 'commit.reused');
      } finally {
        await restore(token, schema, record, ['address']);
      }
    },
  );

  it.skipIf(lacks('admin', 'full', 'none', 'edit'))(
    'no commit for a user without Edit, by any request, and nothing written',
    async () => {
      const { token, schema, records } = await vendors('full');
      const summary = parseConnectors(
        (await send('GET', ROUTES.connectors, { session: token })).json,
      ).connectors.find((c) => c.id === 'vendors')!;
      // Only a FULL key without Vendors' Edit tells anything here.
      if (summary.access === 'edit') return;
      const record = records[0]!;
      const valid = (dryRun: boolean) => body([change(record, { address: unique() })], dryRun);
      for (const request of [
        valid(true),
        valid(false),
        { ...valid(false), records: [] },
        { ...valid(false), commitId: 'not-a-uuid' },
        { ...valid(false), schemaVersion: 'vendors.0' },
        {},
      ]) {
        refused(await commit(token, request), 403, 'privilege.denied');
      }
      refused(
        await send('POST', connectorRoute('vendors', 'Commit'), { session: token }),
        403,
        'privilege.denied',
      );
      const now = await reread(token, schema, record.id);
      expect(now.version).toBe(record.version);
      // Phase 10: nor on Customers and Items on hand, which this user views without Edit; and a
      // user who may not view one is refused it too.
      for (const id of ['customers', 'itemsOnHand'].filter(has)) {
        refused(await commit(token, valid(true), id), 403, 'privilege.denied');
      }
      if (has('itemsOnHand') && !lacks('edit')) {
        const edit = (await sharedSession('edit')).token;
        refused(await commit(edit, valid(true), 'itemsOnHand'), 403, 'privilege.denied');
      }
      refused(await commit(token, valid(true), 'noSuchConnector'), 404, 'connector.notFound');
      const none = (await sharedSession('none')).token;
      refused(await commit(none, valid(true)), 403, 'privilege.denied');
    },
  );

  it.skipIf(VIEWABLE_EDIT)(
    'checks the request’s shape, then its size, then the commit id, then the schema, in order',
    async () => {
      const { token, records } = await vendors('edit');
      const record = records[0]!;
      const one = [change(record, { address: unique() })];
      const shape = async (request: unknown) =>
        refused(await commit(token, request), 400, 'request.invalid');
      await shape(body(one, true, { commitId: 'not-a-uuid' }));
      await shape(body(one, true, { source: undefined }));
      await shape(body(one, true, { source: source({ workspaceId: 'another-workspace' }) }));
      await shape(body(one, true, { source: source({ pageId: 'not-a-uuid' }) }));
      await shape(body(one, true, { source: source({ blockId: 'short' }) }));
      await shape(body([], true));
      await shape(body([one[0]!, one[0]!], true));
      await shape(body([{ ...one[0]!, changes: {} }], true));
      // A change without its `to`, as no client of this contract sends one.
      const noTo = { ...one[0]!, changes: { address: { from: null } } } as unknown as CommitRecord;
      await shape(body([noTo], true));
      // A null block id is allowed.
      expect(
        (await commit(token, body(one, true, { source: source({ blockId: null }) }))).status,
      ).toBe(200);
      const many = Array.from({ length: 501 }, (_, i) => ({
        id: `cgw-${i}`,
        key: `cgw-${i}`,
        version: 'AAAAAAAAAAE=',
        changes: { address: { from: null, to: 'x' } },
      }));
      // Size after shape, before the stored id and the schema.
      await shape(body(many, true, { commitId: 'not-a-uuid' }));
      refused(
        await commit(token, body(many, true, { schemaVersion: 'vendors.0' })),
        413,
        'batch.tooLarge',
      );
      refused(
        await commit(token, body(one, true, { schemaVersion: 'vendors.0' })),
        400,
        'schema.changed',
      );
    },
  );

  it.skipIf(VIEWABLE_EDIT)(
    'lists every record and field error at once, each with its id, key and field, and writes nothing',
    async () => {
      const { token, schema, records } = await vendors('edit');
      const [a, b, c] = [records[0]!, records[1]!, records[2]!];
      const request = body(
        [
          change(a, {
            vendorName: '',
            bankAccount: 'EG00',
            currency: a.values.currency === 'USD' ? 'EGP' : 'USD',
            noSuchField: 'x',
          }),
          change(b, { mobile: 1234, vendorGroup: 'NOPE', address: 'x'.repeat(151) }),
          { ...change(c, { address: unique() }), version: '' },
          {
            id: '987654321',
            key: 'V-NOPE',
            version: 'AAAAAAAAAAE=',
            changes: { address: { from: null, to: 'x' } },
          },
        ],
        false,
      );
      const answer = await commit(token, request);
      expect(answer.status).toBe(400);
      const errors = parseErrorBody(answer.json).errors;
      const listed = (id: string, code: string, field?: string) =>
        expect(
          errors.some(
            (e) => e.id === id && e.code === code && (field === undefined || e.field === field),
          ),
          `${id} ${field ?? ''} ${code}`,
        ).toBe(true);
      listed(a.id, 'required', 'vendorName');
      listed(a.id, 'field.readOnly', 'bankAccount');
      listed(a.id, 'privilege.denied', 'currency');
      listed(a.id, 'field.readOnly', 'noSuchField');
      listed(b.id, 'type', 'mobile');
      listed(b.id, 'lookup.notFound', 'vendorGroup');
      listed(b.id, 'maxLength', 'address');
      listed(c.id, 'version.missing');
      listed('987654321', 'record.notFound');
      for (const e of errors.filter((e) => e.field !== undefined)) {
        expect(e.key, `${e.id}'s key`).toBe(records.find((r) => r.id === e.id)!.key);
      }
      for (const record of [a, b, c]) {
        expect((await reread(token, schema, record.id)).version).toBe(record.version);
      }
      expect((await status(token, request.commitId)).json).toEqual({ status: 'unknown' });
    },
  );

  it.skipIf(VIEWABLE_EDIT)(
    'answers a conflict with every record changed since it was read, and writes nothing',
    async () => {
      const { token, schema, records } = await vendors('edit');
      const [a, b] = [records[0]!, records[1]!];
      const mobile = `0100${String(Date.now()).slice(-7)}`;
      const first = await commit(token, body([change(a, { mobile })], false));
      expect(first.status).toBe(200);
      try {
        const now = await reread(token, schema, a.id);
        // `a` as read before the first commit: its mobile and tax file, and `b` as read.
        const request = body(
          [
            change(a, { mobile: '01999999999', taxFile: unique().slice(0, 20) }),
            change(b, { taxFile: unique().slice(0, 20) }),
          ],
          false,
        );
        const answer = await commit(token, request);
        expect(answer.status).toBe(409);
        const conflicts = parseConflictBody(answer.json, { request, schema }).conflicts;
        expect(conflicts.map((c) => c.id)).toEqual([a.id]);
        expect(conflicts[0]).toMatchObject({ key: a.key, version: now.version });
        expect(conflicts[0]!.values.mobile).toBe(mobile);
        // The tax file was not changed there, so only the mobile differs from its `from`.
        expect(conflicts[0]!.fields).toEqual(['mobile']);
        expect((await reread(token, schema, b.id)).version).toBe(b.version);
        expect((await reread(token, schema, a.id)).version).toBe(now.version);
        // A dry run checks versions too.
        const dry = await commit(token, { ...request, commitId: randomUUID(), dryRun: true });
        expect(dry.status).toBe(409);
      } finally {
        await restore(token, schema, a, ['mobile']);
      }
    },
  );

  it.skipIf(lacks('admin', 'edit', 'advEdit'))('AdvEdit fields need AdvEdit', async () => {
    const edit = await vendors('edit');
    const record = edit.records[0]!;
    const currency = record.values.currency === 'USD' ? 'EGP' : 'USD';
    const refusedAnswer = await commit(edit.token, body([change(record, { currency })], true));
    expect(refusedAnswer.status).toBe(400);
    expect(parseErrorBody(refusedAnswer.json).errors).toEqual([
      expect.objectContaining({ id: record.id, field: 'currency', code: 'privilege.denied' }),
    ]);
    const adv = await vendors('advEdit');
    const same = adv.records.find((r) => r.id === record.id)!;
    const request = body([change(same, { currency, blocked: !same.values.blocked })], true);
    const answer = await commit(adv.token, request);
    expect(answer.status).toBe(200);
    expect(
      parseCommitResponse(answer.json, { request, schema: adv.schema }).records[0]!.values,
    ).toMatchObject({ currency, blocked: !same.values.blocked });
  });

  it.skipIf(lacks('admin', 'edit', 'other'))(
    'CommitStatus: unknown for ids never written and for another company’s; 400 for a non-UUID',
    async () => {
      const { token } = await sharedSession('edit');
      expect((await status(token, randomUUID())).json).toEqual({ status: 'unknown' });
      refused(await status(token, 'not-a-uuid'), 400, 'request.invalid');
      const { token: theirs } = await openSession('other');
      const { records } = await vendors('edit');
      const request = body([change(records[0]!, { address: unique() })], true);
      expect((await commit(token, request)).status).toBe(200);
      // A dry run is not stored, here or anywhere.
      expect((await status(theirs, request.commitId)).json).toEqual({ status: 'unknown' });
    },
  );

  mockOnly('stores the commit of one company under its own id only', async () => {
    const { token, records } = await vendors('edit');
    const request = body([change(records[0]!, { address: unique() })], false);
    expect((await commit(token, request)).status).toBe(200);
    const { token: theirs } = await openSession('other');
    expect((await status(theirs, request.commitId)).json).toEqual({ status: 'unknown' });
    expect((await status(token, request.commitId)).json).toMatchObject({ status: 'committed' });
  });

  mockOnly('refuses a locked record', async () => {
    const { token } = await sharedSession('edit');
    const schema = await schemaOf(token, 'vendors');
    const answer = await query(token, 'vendors', { filter: { search: 'V-1005' }, pageSize: 5 });
    const locked = parseQueryResponse(answer.json, { schema }).records.find(
      (r) => r.key === 'V-1005',
    )!;
    const refusal = await commit(token, body([change(locked, { address: unique() })], true));
    expect(refusal.status).toBe(400);
    expect(parseErrorBody(refusal.json).errors).toEqual([
      expect.objectContaining({ id: locked.id, key: 'V-1005', code: 'record.locked' }),
    ]);
  });

  mockOnly('audits one row per changed field, naming the page and block it came from', async () => {
    const { token, records } = await vendors('advEdit');
    const record = records[0]!;
    const address = unique();
    const request = body([change(record, { address, blocked: !record.values.blocked })], false);
    expect((await commit(token, request)).status).toBe(200);
    const { audit } = (await control('audit')) as { audit: MockAuditRow[] };
    expect(audit).toHaveLength(2);
    for (const row of audit) {
      expect(row).toMatchObject({
        company: 'Kit',
        connector: 'vendors',
        recordId: record.id,
        key: record.key,
        commitId: request.commitId,
        audience: 'workspace',
        workspaceId: WORKSPACE,
        pageId: PAGE,
        blockId: BLOCK,
        user: 'u106',
      });
    }
    expect(audit.find((r) => r.field === 'address')).toMatchObject({
      before: record.values.address ?? null,
      after: address,
    });
    // A dry run and a refusal audit nothing.
    await commit(token, body([change(record, { address: unique() })], true));
    await commit(token, body([change(record, { vendorName: '' })], false));
    expect(((await control('audit')) as { audit: MockAuditRow[] }).audit).toHaveLength(2);
  });
});

describe('the client and a draft against the server', () => {
  /** Node's fetch sends no Origin: this one sends Workspace's, as a browser would. */
  const browserFetch = (input: string, init: RequestInit) =>
    fetch(input, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Origin: ORIGIN },
    });

  it.skipIf(VIEWABLE_EDIT)(
    'reads a dry run, a refusal per field and a conflict as outcomes, and other refusals as errors',
    async () => {
      const client = createErpClient(baseUrl(), browserFetch);
      const { token, schema, records } = await vendors('edit');
      const record = records[0]!;
      const dry = await client.commit(
        token,
        'vendors',
        body([change(record, { address: unique() })], true),
        {
          schema,
        },
      );
      expect(dry.kind).toBe('done');
      const invalid = await client.commit(
        token,
        'vendors',
        body([change(record, { vendorName: '' })], true),
        {
          schema,
        },
      );
      expect(invalid).toMatchObject({
        kind: 'invalid',
        errors: [expect.objectContaining({ code: 'required' })],
      });
      const stale = { ...change(record, { address: unique() }), version: 'AAAAAAAAAAE=' };
      const conflict = await client.commit(token, 'vendors', body([stale], true), { schema });
      expect(conflict.kind).toBe('conflict');
      const changed = await client
        .commit(
          token,
          'vendors',
          body([change(record, { address: 'x' })], true, { schemaVersion: 'vendors.0' }),
        )
        .catch((e: unknown) => e);
      expect(changed).toBeInstanceOf(ErpError);
      expect(changed).toMatchObject({ code: 'schema.changed', status: 400 });
      const { token: viewer } = await sharedSession('none');
      await expect(
        client.commit(viewer, 'vendors', body([change(record, { address: 'x' })], true)),
      ).rejects.toMatchObject({ code: 'privilege.denied', status: 403 });
    },
  );

  mockOnly('settles a lost answer by CommitStatus and never sends a different commit', async () => {
    const client = createErpClient(baseUrl(), browserFetch);
    const { token, schema, records } = await vendors('edit');
    const record = records[0]!;
    const draft = new ErpDraft(
      'page#block',
      { linkId: 'link', connectorId: 'vendors', source: source() as CommitRequest['source'] },
      { wait: async () => undefined },
    );
    const sent: CommitRequest[] = [];
    const api = {
      commit: (request: CommitRequest, options: { schema: ConnectorSchema }) => {
        sent.push(request);
        return client.commit(token, 'vendors', request, options);
      },
      commitStatus: (
        commitId: string,
        options: { schema: ConnectorSchema; request: CommitRequest },
      ) => client.commitStatus(token, 'vendors', commitId, options),
    };
    const address = unique();
    draft.set(record, 'address', address);
    await draft.review(api, schema);
    expect(draft.phase().kind).toBe('reviewed');
    // The commit goes through, and its answer is lost.
    await control('fault', { match: 'vendors/Commit$', drop: 'after' });
    await draft.commit(api, schema);
    expect(draft.phase()).toMatchObject({ kind: 'committed', changes: 1 });
    // One dry run and one commit, under one id: CommitStatus said it was written.
    expect(sent.map((r) => r.dryRun)).toEqual([true, false]);
    expect(new Set(sent.map((r) => r.commitId)).size).toBe(1);
    const { audit } = (await control('audit')) as { audit: MockAuditRow[] };
    expect(audit).toHaveLength(1);
    expect((await reread(token, schema, record.id)).values.address).toBe(address);

    // A commit refused before it ran (a dropped connection) is sent again under its id.
    const next = await reread(token, schema, record.id);
    draft.set(next, 'address', unique());
    await control('fault', { match: 'vendors/Commit$', drop: true });
    await draft.commit(api, schema);
    expect(draft.phase().kind).toBe('committed');
    const real = sent.filter((r) => !r.dryRun);
    expect(real).toHaveLength(3);
    expect(real[1]!.commitId).toBe(real[2]!.commitId);
    expect(real[1]!.records).toEqual(real[2]!.records);
    expect(((await control('audit')) as { audit: MockAuditRow[] }).audit).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 10: Customers and Items on hand (INTEGRATIONS.md, "Customers and Items on hand editable")

/** A connector's first records in its key's order, and its schema, as `role` sees them. */
async function readAs(
  role: Role,
  connector: string,
  request: Partial<QueryRequest> = {},
): Promise<{ token: string; schema: ConnectorSchema; records: ErpRecord[] }> {
  const { token } = await sharedSession(role);
  const schema = await schemaOf(token, connector);
  const answer = await query(token, connector, {
    pageSize: 50,
    sort: [{ field: schema.keyField, direction: 'asc' }],
    ...request,
  });
  expect(answer.status, `${connector}'s Query`).toBe(200);
  return { token, schema, records: [...parseQueryResponse(answer.json, { schema }).records] };
}

/** Every record of one key, as the ERP has it now for this session. */
async function ofKey(
  token: string,
  connector: string,
  schema: ConnectorSchema,
  key: string,
): Promise<ErpRecord[]> {
  const answer = await query(token, connector, {
    filter: { equals: { [schema.keyField]: key } },
    pageSize: 200,
  });
  expect(answer.status, `${connector} ${key}`).toBe(200);
  return [...parseQueryResponse(answer.json, { schema }).records];
}

/** A commit's body for a connector: its schema version. */
const bodyOf = (
  connector: string,
  records: readonly CommitRecord[],
  dryRun: boolean,
  over: Record<string, unknown> = {},
) => body(records, dryRun, { schemaVersion: SCHEMA_VERSIONS[connector], ...over });

/** An active code of a lookup other than `now`. */
function otherCode(schema: ConnectorSchema, list: string, now: WireValue | undefined): string {
  const item = (schema.lookups[list] ?? []).find((i) => i.active !== false && i.code !== now);
  expect(item, `another active ${list} code`).toBeTruthy();
  return item!.code;
}

/** Expects the errors to hold one for this record's field (or the record) with this code. */
function listed(
  errors: readonly { id?: string; key?: string; field?: string; code: string }[],
  record: Pick<ErpRecord, 'id' | 'key'>,
  errorCode: string,
  field?: string,
) {
  expect(
    errors.some(
      (e) =>
        e.id === record.id &&
        e.key === record.key &&
        e.code === errorCode &&
        (field === undefined || e.field === field),
    ),
    `${record.key} ${field ?? ''} ${errorCode}`,
  ).toBe(true);
}

/** On a real server, a record's fields put back as they were read, through its key. */
async function restoreKeyed(
  token: string,
  connector: string,
  schema: ConnectorSchema,
  original: ErpRecord,
  fields: readonly string[],
): Promise<void> {
  if (onMock) return;
  const now = (await ofKey(token, connector, schema, original.key)).find(
    (r) => r.id === original.id,
  )!;
  const back = Object.fromEntries(fields.map((f) => [f, original.values[f] ?? null]));
  const answer = await commit(token, bodyOf(connector, [change(now, back)], false), connector);
  expect(answer.status, `${original.key} put back`).toBe(200);
}

const NO_CUSTOMERS = !has('customers');
const NO_ITEMS = !has('itemsOnHand');
const time7 = () => String(Date.now()).slice(-7);

describe('Customers commits (Phase 10)', () => {
  /** A valid new value of each field Edit or AdvEdit may change, by the contract's rules. */
  const newValues = (schema: ConnectorSchema, record: ErpRecord): Record<string, WireValue> => ({
    customerName: `${unique()} customer`,
    customerGroup: otherCode(schema, 'customerGroups', record.values.customerGroup),
    mobile: `0100${time7()}`,
    mobile2: `0111${time7()}`,
    payMethod: otherCode(schema, 'paymentModes', record.values.payMethod),
    address: unique(),
    taxFile: unique().slice(0, 20),
    currency: otherCode(schema, 'currencies', record.values.currency),
    priceList: unique().slice(0, 20),
    creditLimit: '1234.50',
    blocked: !record.values.blocked,
  });
  /** A typed value for each field that is never changed through a workspace. */
  const NEVER: Record<string, WireValue> = {
    customerAccount: 'C-CONTRACT',
    nationalId: '29001011234567',
    governorate: 'Nowhere',
    city: 'Nowhere',
    createdBy: 'cgw-contract',
    createdDate: '2026-01-01',
    modifiedBy: 'cgw-contract',
    modifiedDate: '2026-01-01T00:00:00+02:00',
  };
  const levels = EDIT_TABLES.customers!;

  it.skipIf(NO_CUSTOMERS || lacks('admin', 'edit', 'advEdit'))(
    'the privilege matrix per field: Edit’s, AdvEdit’s and those never changed',
    async () => {
      const edit = await readAs('edit', 'customers');
      const record = edit.records[0]!;
      const values = newValues(edit.schema, record);
      const answer = await commit(
        edit.token,
        bodyOf('customers', [change(record, { ...values, ...NEVER })], true),
        'customers',
      );
      expect(answer.status).toBe(400);
      const errors = parseErrorBody(answer.json).errors;
      for (const [name, level] of Object.entries(levels)) {
        const own = errors.filter((e) => e.field === name);
        if (level === 'edit') expect(own, `Edit changes ${name}`).toEqual([]);
        if (level === 'advEdit') listed(errors, record, 'privilege.denied', name);
        // A field the schema does not list for this user (an employee's national ID) is too.
        if (level === null) listed(errors, record, 'field.readOnly', name);
      }
      expect(errors.every((e) => e.field !== undefined)).toBe(true);
      // The same record for the AdvEdit user, read in their own session (their version is of the
      // fields they see): every Edit and AdvEdit field passes; the others never do.
      const adv = await readAs('advEdit', 'customers');
      const same = (await ofKey(adv.token, 'customers', adv.schema, record.key))[0]!;
      const passes = bodyOf('customers', [change(same, newValues(adv.schema, same))], true);
      const passed = await commit(adv.token, passes, 'customers');
      expect(passed.status).toBe(200);
      const answered = parseCommitResponse(passed.json, { request: passes, schema: adv.schema });
      expect(answered.records).toHaveLength(1);
      expect(answered.records[0]!.version).toBe(same.version);
      for (const [name, changed] of Object.entries(passes.records[0]!.changes)) {
        expect(answered.records[0]!.values[name], name).toEqual(changed.to);
      }
      const never = await commit(
        adv.token,
        bodyOf('customers', [change(same, NEVER)], true),
        'customers',
      );
      expect(never.status).toBe(400);
      const refusedFields = parseErrorBody(never.json).errors;
      for (const name of Object.keys(NEVER)) listed(refusedFields, same, 'field.readOnly', name);
    },
  );

  it.skipIf(NO_CUSTOMERS || lacks('admin', 'advEdit'))(
    'checks each changed field’s rules and lists every error at once, writing nothing',
    async () => {
      const { token, schema, records } = await readAs('advEdit', 'customers');
      const [a, b, c] = [records[0]!, records[1]!, records[2]!];
      const inactive = (schema.lookups.customerGroups ?? []).find((i) => i.active === false);
      const request = bodyOf(
        'customers',
        [
          change(a, {
            customerName: '',
            customerGroup: null,
            currency: null,
            blocked: null,
            creditLimit: '-1',
          }),
          change(b, {
            customerName: 'x'.repeat(151),
            address: 'x'.repeat(151),
            mobile: '0'.repeat(51),
            customerGroup: 'NOPE',
            payMethod: 'NOPE',
            creditLimit: '1.234',
          }),
          change(c, {
            creditLimit: 12,
            blocked: 'yes',
            ...(inactive ? { customerGroup: inactive.code } : {}),
          }),
        ],
        false,
      );
      const answer = await commit(token, request, 'customers');
      expect(answer.status).toBe(400);
      const errors = parseErrorBody(answer.json).errors;
      for (const field of ['customerName', 'customerGroup', 'currency', 'blocked']) {
        listed(errors, a, 'required', field);
      }
      listed(errors, a, 'range', 'creditLimit');
      for (const field of ['customerName', 'address', 'mobile']) {
        listed(errors, b, 'maxLength', field);
      }
      listed(errors, b, 'lookup.notFound', 'customerGroup');
      listed(errors, b, 'lookup.notFound', 'payMethod');
      listed(errors, b, 'scale', 'creditLimit');
      listed(errors, c, 'type', 'creditLimit');
      listed(errors, c, 'type', 'blocked');
      if (inactive) listed(errors, c, 'lookup.notFound', 'customerGroup');
      for (const record of [a, b, c]) {
        expect((await ofKey(token, 'customers', schema, record.key))[0]!.version).toBe(
          record.version,
        );
      }
      expect((await status(token, request.commitId, 'customers')).json).toEqual({
        status: 'unknown',
      });
    },
  );

  it.skipIf(NO_CUSTOMERS || lacks('admin', 'advEdit'))(
    'a change made in the ERP since the read is a conflict, and nothing is written',
    async () => {
      const { token, schema, records } = await readAs('advEdit', 'customers');
      const [a, b] = [records[0]!, records[1]!];
      const mobile = `0101${time7()}`;
      const first = await commit(
        token,
        bodyOf('customers', [change(a, { mobile })], false),
        'customers',
      );
      expect(first.status).toBe(200);
      try {
        const now = (await ofKey(token, 'customers', schema, a.key))[0]!;
        expect(now.version, 'a version made from the values read').not.toBe(a.version);
        const request = bodyOf(
          'customers',
          [
            change(a, { mobile: '01999999999', taxFile: unique().slice(0, 20) }),
            change(b, { taxFile: unique().slice(0, 20) }),
          ],
          false,
        );
        const answer = await commit(token, request, 'customers');
        expect(answer.status).toBe(409);
        const conflicts = parseConflictBody(answer.json, { request, schema }).conflicts;
        expect(conflicts.map((c) => c.id)).toEqual([a.id]);
        expect(conflicts[0]).toMatchObject({ key: a.key, version: now.version });
        expect(conflicts[0]!.values.mobile).toBe(mobile);
        expect(conflicts[0]!.fields).toEqual(['mobile']);
        expect((await ofKey(token, 'customers', schema, b.key))[0]!.version).toBe(b.version);
        const dry = await commit(
          token,
          { ...request, commitId: randomUUID(), dryRun: true },
          'customers',
        );
        expect(dry.status).toBe(409);
      } finally {
        await restoreKeyed(token, 'customers', schema, a, ['mobile']);
      }
    },
  );

  it.skipIf(NO_CUSTOMERS || lacks('admin', 'edit'))(
    'a commit writes once, with its stamps; a retry answers the same; another payload is refused',
    async () => {
      const { token, schema, records } = await readAs('edit', 'customers');
      const record = records[0]!;
      const address = unique();
      const request = bodyOf('customers', [change(record, { address })], false);
      const first = await commit(token, request, 'customers');
      expect(first.status).toBe(200);
      try {
        const written = parseCommitResponse(first.json, { request, schema });
        expect(written.records[0]!.values.address).toBe(address);
        expect(written.records[0]!.version).not.toBe(record.version);
        // The customer screen's stamps move, and nothing of the address book.
        if (schema.fields.some((f) => f.name === 'modifiedDate')) {
          expect(written.records[0]!.values.modifiedDate).not.toBe(record.values.modifiedDate);
        }
        for (const field of ['governorate', 'city', 'customerAccount', 'createdBy']) {
          if (field in record.values) {
            expect(written.records[0]!.values[field], field).toEqual(record.values[field]);
          }
        }
        const again = await commit(token, request, 'customers');
        expect(again.json).toEqual(first.json);
        expect(
          parseCommitStatus((await status(token, request.commitId, 'customers')).json, {
            request,
            schema,
            commitId: request.commitId,
          }),
        ).toEqual({ status: 'committed', ...written });
        const other = { ...request, records: [change(record, { address: unique() })] };
        refused(await commit(token, other, 'customers'), 400, 'commit.reused');
      } finally {
        await restoreKeyed(token, 'customers', schema, record, ['address']);
      }
    },
  );

  it.skipIf(NO_CUSTOMERS || lacks('admin', 'full', 'edit'))(
    'the customer list’s ownership rule holds for commits: another’s customer is not found',
    async () => {
      const mine = await readAs('edit', 'customers', { pageSize: 500 });
      const all = await readAs('full', 'customers', { pageSize: 500 });
      const ids = new Set(mine.records.map((r) => r.id));
      const other = all.records.find((r) => !ids.has(r.id));
      if (onMock) {
        expect(other, 'the mock’s EDIT user sees only the customers she made').toBeTruthy();
        for (const r of mine.records) expect(r.values.createdBy).toBe('u105');
      }
      if (!other) return;
      // Sent with a version read by a user who sees it: still not found for this one.
      const answer = await commit(
        mine.token,
        bodyOf('customers', [change(other, { mobile: `0102${time7()}` })], true),
        'customers',
      );
      expect(answer.status).toBe(400);
      expect(parseErrorBody(answer.json).errors).toEqual([
        expect.objectContaining({ id: other.id, key: other.key, code: 'record.notFound' }),
      ]);
      const own = mine.records[0]!;
      const allowed = bodyOf('customers', [change(own, { mobile: `0103${time7()}` })], true);
      expect((await commit(mine.token, allowed, 'customers')).status).toBe(200);
    },
  );

  mockOnly('audits one row per changed field, naming the page and block', async () => {
    const { token, records } = await readAs('advEdit', 'customers');
    const record = records[0]!;
    const request = bodyOf(
      'customers',
      [change(record, { address: unique(), creditLimit: '777.00' })],
      false,
    );
    expect((await commit(token, request, 'customers')).status).toBe(200);
    const { audit } = (await control('audit')) as { audit: MockAuditRow[] };
    expect(audit.map((r) => r.field).sort()).toEqual(['address', 'creditLimit']);
    for (const row of audit) {
      expect(row).toMatchObject({
        connector: 'customers',
        recordId: record.id,
        key: record.key,
        commitId: request.commitId,
        audience: 'workspace',
        workspaceId: WORKSPACE,
        pageId: PAGE,
        blockId: BLOCK,
        user: 'u106',
      });
    }
    expect(audit.find((r) => r.field === 'creditLimit')).toMatchObject({
      before: record.values.creditLimit ?? null,
      after: '777.00',
    });
  });
});

describe('Items on hand commits (Phase 10)', () => {
  /** An item the AdvEdit user sees in two places at least, and every row of it. */
  async function itemInPlaces() {
    const read = await readAs('advEdit', 'itemsOnHand', { pageSize: 200 });
    const counts = new Map<string, number>();
    for (const r of read.records) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
    const key = [...counts].find(([, n]) => n >= 2)?.[0];
    expect(key, 'an item stored in two places').toBeTruthy();
    const rows = await ofKey(read.token, 'itemsOnHand', read.schema, key!);
    return { ...read, key: key!, rows };
  }

  /** On a real server, the item's name put back, through one of its rows. */
  async function restoreItem(token: string, schema: ConnectorSchema, original: ErpRecord) {
    if (onMock) return;
    const now = (await ofKey(token, 'itemsOnHand', schema, original.key))[0]!;
    const back = { itemName: original.values.itemName ?? null };
    const answer = await commit(
      token,
      bodyOf('itemsOnHand', [change(now, back)], false),
      'itemsOnHand',
    );
    expect(answer.status, 'the item put back').toBe(200);
  }

  const STOCK = ['onHandQty', 'onHandValue', 'unit', 'siteId', 'warehouseId', 'locationId'];

  it.skipIf(NO_ITEMS || lacks('admin', 'advEdit'))(
    'a shared field changes every row of its item: the answer holds them all, and stock stays',
    async () => {
      const { token, schema, rows } = await itemInPlaces();
      for (const name of SHARED_FIELDS.itemsOnHand!) {
        expect(
          schema.fields.find((f) => f.name === name),
          name,
        ).toMatchObject({ editable: true, scope: 'key' });
      }
      const name = `${unique()} item`;
      // One row sent: the dry run answers every row of the item, as each would be, as read.
      const dry = bodyOf('itemsOnHand', [change(rows[0]!, { itemName: name })], true);
      const tried = await commit(token, dry, 'itemsOnHand');
      expect(tried.status).toBe(200);
      const would = parseCommitResponse(tried.json, { request: dry, schema });
      expect(would.records.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
      for (const r of would.records) {
        expect(r.values.itemName).toBe(name);
        expect(r.version).toBe(rows.find((x) => x.id === r.id)!.version);
      }
      // Every row sent, one value: written once, every row renamed, its stock as it was.
      const request = bodyOf(
        'itemsOnHand',
        rows.map((r) => change(r, { itemName: name })),
        false,
      );
      const first = await commit(token, request, 'itemsOnHand');
      expect(first.status).toBe(200);
      try {
        const written = parseCommitResponse(first.json, { request, schema });
        expect(written.records).toHaveLength(rows.length);
        const now = await ofKey(token, 'itemsOnHand', schema, rows[0]!.key);
        expect(now.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
        for (const r of now) {
          const before = rows.find((x) => x.id === r.id)!;
          expect(r.values.itemName).toBe(name);
          for (const field of STOCK) {
            if (field in before.values) {
              expect(r.values[field], field).toEqual(before.values[field]);
            }
          }
          expect(r.version).not.toBe(before.version);
        }
        // CommitStatus's stored body holds every row too.
        const stored = parseCommitStatus(
          (await status(token, request.commitId, 'itemsOnHand')).json,
          { request, schema, commitId: request.commitId },
        );
        expect(stored.status).toBe('committed');
        if (stored.status === 'committed') expect(stored.records).toHaveLength(rows.length);
        if (onMock) {
          // One audit row for the item and field, by the first record that changes it.
          const { audit } = (await control('audit')) as { audit: MockAuditRow[] };
          expect(audit).toEqual([
            expect.objectContaining({
              connector: 'itemsOnHand',
              recordId: request.records[0]!.id,
              key: rows[0]!.key,
              field: 'itemName',
              before: rows[0]!.values.itemName,
              after: name,
              pageId: PAGE,
              blockId: BLOCK,
              workspaceId: WORKSPACE,
            }),
          ]);
        }
      } finally {
        await restoreItem(token, schema, rows[0]!);
      }
    },
  );

  it.skipIf(NO_ITEMS || lacks('admin', 'advEdit'))(
    'two rows of one item given different values are refused, each named, and nothing written',
    async () => {
      const { token, schema, rows } = await itemInPlaces();
      const [a, b] = [rows[0]!, rows[1]!];
      const group = otherCode(schema, 'itemGroups', a.values.itemGroup);
      const third = (schema.lookups.itemGroups ?? []).find(
        (i) => i.active !== false && i.code !== group && i.code !== a.values.itemGroup,
      );
      const request = bodyOf(
        'itemsOnHand',
        [
          change(a, { itemName: `${unique()} one`, itemGroup: group }),
          change(b, {
            itemName: `${unique()} two`,
            ...(third ? { itemGroup: third.code } : {}),
          }),
        ],
        false,
      );
      const answer = await commit(token, request, 'itemsOnHand');
      expect(answer.status).toBe(400);
      const errors = parseErrorBody(answer.json).errors;
      listed(errors, a, 'request.invalid', 'itemName');
      listed(errors, b, 'request.invalid', 'itemName');
      if (third) {
        listed(errors, a, 'request.invalid', 'itemGroup');
        listed(errors, b, 'request.invalid', 'itemGroup');
      }
      for (const r of await ofKey(token, 'itemsOnHand', schema, a.key)) {
        expect(r.version).toBe(rows.find((x) => x.id === r.id)!.version);
      }
      // The same value on both is one change of the item.
      const same = `${unique()} same`;
      const dry = bodyOf(
        'itemsOnHand',
        [change(a, { itemName: same }), change(b, { itemName: same })],
        true,
      );
      expect((await commit(token, dry, 'itemsOnHand')).status).toBe(200);
    },
  );

  it.skipIf(NO_ITEMS || lacks('admin', 'advEdit'))(
    'never writes stock or a place, and checks the item’s own rules',
    async () => {
      const { token, schema, rows } = await itemInPlaces();
      const [a, b] = [rows[0]!, rows[1]!];
      const stock = await commit(
        token,
        bodyOf(
          'itemsOnHand',
          [
            change(a, {
              onHandQty: '1.000',
              onHandValue: '1.00',
              unit: 'BOX',
              siteId: 'S-NOPE',
              warehouseId: 'WH-NOPE',
              locationId: 'Z-99',
              itemId: 'ITM-NOPE',
            }),
          ],
          true,
        ),
        'itemsOnHand',
      );
      expect(stock.status).toBe(400);
      const stockErrors = parseErrorBody(stock.json).errors;
      for (const field of [...STOCK, 'itemId']) listed(stockErrors, a, 'field.readOnly', field);
      const rules = await commit(
        token,
        bodyOf(
          'itemsOnHand',
          [
            change(a, { itemName: '', itemGroup: 'NOPE' }),
            change(b, { itemName: '', itemGroup: 'NOPE' }),
          ],
          true,
        ),
        'itemsOnHand',
      );
      expect(rules.status).toBe(400);
      const ruleErrors = parseErrorBody(rules.json).errors;
      listed(ruleErrors, a, 'required', 'itemName');
      listed(ruleErrors, a, 'lookup.notFound', 'itemGroup');
      const inactive = (schema.lookups.itemGroups ?? []).find((i) => i.active === false);
      const long = await commit(
        token,
        bodyOf(
          'itemsOnHand',
          [
            change(a, {
              itemName: 'x'.repeat(151),
              ...(inactive ? { itemGroup: inactive.code } : {}),
            }),
          ],
          true,
        ),
        'itemsOnHand',
      );
      expect(long.status).toBe(400);
      const longErrors = parseErrorBody(long.json).errors;
      listed(longErrors, a, 'maxLength', 'itemName');
      if (inactive) listed(longErrors, a, 'lookup.notFound', 'itemGroup');
    },
  );

  it.skipIf(NO_ITEMS || lacks('admin', 'full'))(
    'a viewer of Items on hand reads its name and group as needing Edit, and cannot commit',
    async () => {
      const { token, schema, records } = await readAs('full', 'itemsOnHand');
      const summary = parseConnectors(
        (await send('GET', ROUTES.connectors, { session: token })).json,
      ).connectors.find((c) => c.id === 'itemsOnHand')!;
      if (summary.access === 'edit') return;
      for (const name of SHARED_FIELDS.itemsOnHand!) {
        expect(
          schema.fields.find((f) => f.name === name),
          name,
        ).toMatchObject({ editable: false, editReason: 'needsEdit', scope: 'key' });
      }
      refused(
        await commit(
          token,
          bodyOf('itemsOnHand', [change(records[0]!, { itemName: unique() })], true),
          'itemsOnHand',
        ),
        403,
        'privilege.denied',
      );
    },
  );

  mockOnly(
    'a stock movement since the read is a conflict with no fields, and nothing is written',
    async () => {
      const { token, schema, rows } = await itemInPlaces();
      const [a, b] = [rows[0]!, rows[1]!];
      // A posting moves the second row's quantity: its version changes, its name does not.
      await control('edit-record', {
        connector: 'itemsOnHand',
        company: 'Kit',
        id: b.id,
        values: { onHandQty: '1.500' },
      });
      const name = `${unique()} moved`;
      const request = bodyOf(
        'itemsOnHand',
        [change(a, { itemName: name }), change(b, { itemName: name })],
        false,
      );
      const answer = await commit(token, request, 'itemsOnHand');
      expect(answer.status).toBe(409);
      const conflicts = parseConflictBody(answer.json, { request, schema }).conflicts;
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({ id: b.id, key: b.key, fields: [] });
      expect(conflicts[0]!.values.onHandQty).toBe('1.500');
      for (const r of await ofKey(token, 'itemsOnHand', schema, a.key)) {
        expect(r.values.itemName).toBe(a.values.itemName);
      }
      expect(((await control('audit')) as { audit: MockAuditRow[] }).audit).toEqual([]);
    },
  );

  mockOnly('a draft applies an item’s name to every row it holds and commits them', async () => {
    const client = createErpClient(baseUrl(), (input: string, init: RequestInit) =>
      fetch(input, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Origin: ORIGIN },
      }),
    );
    const { token, schema, rows } = await itemInPlaces();
    const draft = new ErpDraft(
      'page#block',
      {
        linkId: 'link',
        connectorId: 'itemsOnHand',
        source: source() as CommitRequest['source'],
      },
      { wait: async () => undefined },
    );
    const api = {
      commit: (request: CommitRequest, options: { schema: ConnectorSchema }) =>
        client.commit(token, 'itemsOnHand', request, options),
      commitStatus: (
        commitId: string,
        options: { schema: ConnectorSchema; request: CommitRequest },
      ) => client.commitStatus(token, 'itemsOnHand', commitId, options),
    };
    const name = `${unique()} drafted`;
    // The person changes one row; every row of the item the block holds changes with it.
    expect(draft.apply(schema, rows[0]!, 'itemName', name, { held: rows })).toBe(true);
    expect(
      draft
        .records()
        .map((r) => r.id)
        .sort(),
    ).toEqual(rows.map((r) => r.id).sort());
    await draft.review(api, schema);
    expect(draft.phase().kind).toBe('reviewed');
    await draft.commit(api, schema);
    expect(draft.phase()).toMatchObject({ kind: 'committed', changes: rows.length });
    for (const r of await ofKey(token, 'itemsOnHand', schema, rows[0]!.key)) {
      expect(r.values.itemName).toBe(name);
    }
  });
});
