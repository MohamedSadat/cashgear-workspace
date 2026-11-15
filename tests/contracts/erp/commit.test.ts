// erp-connect.1's Commit and CommitStatus (Phase 7, docs/INTEGRATIONS.md, "`Commit` and
// `CommitStatus`"), against the mock in `pnpm test` or a real ERP at ERP_BASE_URL (README.md).
// On a real server every commit that writes is undone by another commit before the case ends,
// so the test tenant's records stay as they were.

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
  type WireValue,
} from '../../../packages/erp/src/index';
import {
  ORIGIN,
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

describe('an editable connector', () => {
  it.skipIf(lacks('admin', 'full', 'edit', 'advEdit'))(
    'resolves access and every field’s editing for each user, as the contract’s table says',
    async () => {
      for (const role of ['full', 'edit', 'advEdit'] as const) {
        const { token } = await sharedSession(role);
        const listed = parseConnectors(
          (await send('GET', ROUTES.connectors, { session: token })).json,
        ).connectors;
        const summary = listed.find((c) => c.id === 'vendors')!;
        if (role !== 'full') expect(summary.access, role).toBe('edit');
        for (const other of listed) if (other.id !== 'vendors') expect(other.access).toBe('view');
        const schema = await schemaOf(token, 'vendors');
        const grant = grantOf(summary.access, schema);
        if (role === 'edit') expect(grant).toBe('edit');
        if (role === 'advEdit') expect(grant).toBe('advEdit');
        for (const f of schema.fields) {
          expect(f, `${role} ${f.name}`).toMatchObject(expectedEditing('vendors', f.name, grant));
        }
        expect(schema.maxCommitRecords).toBe(500);
        if (has('customers') && listed.some((c) => c.id === 'customers')) {
          const customers = await schemaOf(token, 'customers');
          expect(customers.maxCommitRecords).toBe(0);
          for (const f of customers.fields) {
            expect(f, f.name).toMatchObject({ editable: false, editReason: 'notEditable' });
          }
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
      // A user with Edit on Vendors has none on the read-only connectors.
      if (has('customers')) {
        const edit = (await sharedSession('edit')).token;
        refused(await commit(edit, valid(true), 'customers'), 403, 'privilege.denied');
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
