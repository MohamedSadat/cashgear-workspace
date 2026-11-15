// erp-connect.1's Commit and CommitStatus (Phase 7) on Workspace's side: the guards for each
// answer, and the client's reading of a commit's answers into outcomes and errors.
import { describe, expect, it } from 'vitest';
import { createErpClient } from './client';
import {
  ErpContractError,
  ErpError,
  isBlockId,
  isCommitId,
  parseCommitResponse,
  parseCommitStatus,
  parseConflictBody,
  type CommitRequest,
} from './contract';
import { VENDOR_RECORDS, VENDOR_SCHEMA } from './view/testing';

const [A, B] = VENDOR_RECORDS as [(typeof VENDOR_RECORDS)[0], (typeof VENDOR_RECORDS)[0]];
const ID = '6f1c2b0e-8f34-4a51-9d2e-1b7c3f4e5a60';
const REQUEST: CommitRequest = {
  commitId: ID,
  schemaVersion: 'vendors.1',
  dryRun: false,
  source: {
    workspaceId: '01930000-0000-7000-8000-0000000000aa',
    pageId: '01930000-0000-7000-8000-0000000000bb',
    blockId: 'Blk000000001',
  },
  records: [
    {
      id: A.id,
      key: A.key,
      version: A.version,
      changes: { vendorName: { from: A.values.vendorName!, to: 'Renamed' } },
    },
  ],
};

const saved = (over: Record<string, unknown> = {}) => ({
  commitId: ID,
  dryRun: false,
  committedAt: '2026-11-15T10:00:00+02:00',
  records: [{ ...A, version: 'AAAAAAAAEQA=', values: { ...A.values, vendorName: 'Renamed' } }],
  ...over,
});

const conflict = (over: Record<string, unknown> = {}) => ({
  message: 'Changed.',
  correlationId: 'cid',
  conflicts: [
    {
      id: A.id,
      key: A.key,
      version: 'AAAAAAAAEgA=',
      values: { ...A.values, vendorName: 'Theirs' },
      fields: ['vendorName'],
      modifiedBy: 'Bob Mansour',
      modifiedAt: '2026-11-15T09:00:00Z',
      ...over,
    },
  ],
});

const context = { request: REQUEST, schema: VENDOR_SCHEMA };

describe('the commit guards', () => {
  it('know a commit id and a block id', () => {
    expect(isCommitId(ID)).toBe(true);
    expect(isCommitId(ID.toUpperCase())).toBe(false);
    expect(isCommitId('6f1c2b0e-8f34-1a51-9d2e-1b7c3f4e5a60')).toBe(false);
    expect(isBlockId('Blk000000001')).toBe(true);
    expect(isBlockId('Blk00000000')).toBe(false);
  });

  it('take a commit that answers its request, and refuse one that does not', () => {
    expect(parseCommitResponse(saved(), context).records[0]!.values.vendorName).toBe('Renamed');
    // An id in another case is the same commit.
    expect(() => parseCommitResponse(saved({ commitId: ID.toUpperCase() }), context)).not.toThrow();
    const bad: [string, Record<string, unknown>][] = [
      ['another commit', { commitId: '6f1c2b0e-8f34-4a51-9d2e-1b7c3f4e5a61' }],
      ['a dry run answered for a commit', { dryRun: true, committedAt: null }],
      ['no time for a commit', { committedAt: null }],
      ['another record', { records: [{ ...B }] }],
      ['no record', { records: [] }],
      ['a record twice', { records: [saved().records[0], saved().records[0]] }],
      [
        'a value the schema refuses',
        { records: [{ ...A, values: { ...A.values, debitLimit: 1 } }] },
      ],
      ['a field it does not have', { records: [{ ...A, values: { ...A.values, phone: '1' } }] }],
    ];
    for (const [why, over] of bad) {
      expect(() => parseCommitResponse(saved(over), context), why).toThrow(ErpContractError);
    }
    // A dry run writes nothing: its versions are the ones read.
    const dry = { ...REQUEST, dryRun: true };
    expect(() =>
      parseCommitResponse(saved({ dryRun: true, committedAt: null }), { request: dry }),
    ).toThrow(/version/);
    expect(
      parseCommitResponse(saved({ dryRun: true, committedAt: null, records: [A] }), {
        request: dry,
      }).dryRun,
    ).toBe(true);
  });

  it('read a conflict, naming only fields the commit changes', () => {
    expect(parseConflictBody(conflict(), context).conflicts[0]!.fields).toEqual(['vendorName']);
    expect(parseConflictBody(conflict({ fields: [] }), context).conflicts[0]!.fields).toEqual([]);
    expect(() => parseConflictBody(conflict({ fields: ['mobile'] }), context)).toThrow(
      ErpContractError,
    );
    expect(() => parseConflictBody(conflict({ id: B.id, key: B.key }), context)).toThrow(
      ErpContractError,
    );
    expect(() => parseConflictBody({ ...conflict(), conflicts: [] })).toThrow(ErpContractError);
    expect(() => parseConflictBody(conflict({ version: 'not base64!' }))).toThrow(ErpContractError);
  });

  it('read CommitStatus: unknown, or the stored body of a real commit', () => {
    expect(parseCommitStatus({ status: 'unknown' })).toEqual({ status: 'unknown' });
    expect(
      parseCommitStatus({ status: 'committed', ...saved() }, { ...context, commitId: ID }),
    ).toMatchObject({
      status: 'committed',
      commitId: ID,
    });
    // A dry run is never stored.
    expect(() =>
      parseCommitStatus({ status: 'committed', ...saved({ dryRun: true, committedAt: null }) }),
    ).toThrow(ErpContractError);
    expect(() => parseCommitStatus({ status: 'maybe' })).toThrow(ErpContractError);
    expect(() =>
      parseCommitStatus(
        { status: 'committed', ...saved() },
        { commitId: '6f1c2b0e-8f34-4a51-9d2e-1b7c3f4e5a61' },
      ),
    ).toThrow(ErpContractError);
  });
});

describe('the client’s commit', () => {
  const TOKEN = 'tok_' + 'z'.repeat(40);
  function fake(status: number, body: unknown) {
    const sent: { url: string; init: RequestInit }[] = [];
    const client = createErpClient('http://127.0.0.1:4282', async (url, init) => {
      sent.push({ url, init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': 'cid-1' },
      });
    });
    return { sent, client };
  }

  it('posts the request to the connector’s Commit with the session, and reads it done', async () => {
    const { sent, client } = fake(200, saved());
    const outcome = await client.commit(TOKEN, 'vendors', REQUEST, { schema: VENDOR_SCHEMA });
    expect(outcome).toMatchObject({ kind: 'done', correlationId: 'cid-1' });
    expect(sent[0]!.url).toBe('http://127.0.0.1:4282/api/connect/Connectors/vendors/Commit');
    expect(sent[0]!.init.method).toBe('POST');
    expect((sent[0]!.init.headers as Record<string, string>)['X-Connect-Session']).toBe(TOKEN);
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual(REQUEST);
  });

  it('reads errors that name records as `invalid`, and a conflict as `conflict`', async () => {
    const errors = [{ id: A.id, key: A.key, field: 'vendorName', code: 'required', message: 'x' }];
    const invalid = await fake(400, { message: 'm', correlationId: 'c', errors }).client.commit(
      TOKEN,
      'vendors',
      REQUEST,
    );
    expect(invalid).toEqual({ kind: 'invalid', errors, correlationId: 'cid-1' });
    const clash = await fake(409, conflict()).client.commit(TOKEN, 'vendors', REQUEST, {
      schema: VENDOR_SCHEMA,
    });
    expect(clash).toMatchObject({
      kind: 'conflict',
      conflicts: [{ id: A.id, version: 'AAAAAAAAEgA=' }],
    });
  });

  it('throws a batch’s refusal with its code, and an answer that breaks the contract', async () => {
    const batch = (code: string) => ({
      message: 'm',
      correlationId: 'c',
      errors: [{ code, message: 'm' }],
    });
    for (const code of ['schema.changed', 'commit.reused', 'request.invalid']) {
      await expect(
        fake(400, batch(code)).client.commit(TOKEN, 'vendors', REQUEST),
      ).rejects.toMatchObject({
        code,
        status: 400,
      });
    }
    await expect(
      fake(403, batch('privilege.denied')).client.commit(TOKEN, 'vendors', REQUEST),
    ).rejects.toMatchObject({
      code: 'privilege.denied',
    });
    await expect(
      fake(413, batch('batch.tooLarge')).client.commit(TOKEN, 'vendors', REQUEST),
    ).rejects.toMatchObject({
      code: 'batch.tooLarge',
    });
    // An error naming a record the request did not send, a conflict with none, a 200 for another.
    const stray = {
      message: 'm',
      correlationId: 'c',
      errors: [{ id: 'nope', code: 'required', message: 'm' }],
    };
    for (const [status, body] of [
      [400, stray],
      [409, { ...conflict(), conflicts: [] }],
      [200, saved({ commitId: '6f1c2b0e-8f34-4a51-9d2e-1b7c3f4e5a61' })],
    ] as const) {
      const error = await fake(status, body)
        .client.commit(TOKEN, 'vendors', REQUEST)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ErpError);
      expect(error).toMatchObject({ code: 'response.invalid' });
    }
  });

  it('asks CommitStatus by id, and checks the stored body against the request', async () => {
    const { sent, client } = fake(200, { status: 'committed', ...saved() });
    const status = await client.commitStatus(TOKEN, 'vendors', ID, { request: REQUEST });
    expect(status.status).toBe('committed');
    expect(sent[0]!.url).toBe(
      `http://127.0.0.1:4282/api/connect/Connectors/vendors/CommitStatus/${ID}`,
    );
    expect(sent[0]!.init.method).toBe('GET');
    const other = await fake(200, { status: 'committed', ...saved() })
      .client.commitStatus(TOKEN, 'vendors', ID, { request: { ...REQUEST, records: [] } })
      .catch((e: unknown) => e);
    expect(other).toMatchObject({ code: 'response.invalid' });
  });
});
