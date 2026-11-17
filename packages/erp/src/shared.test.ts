// Phase 10 (INTEGRATIONS.md, "A field shared by a key"): `scope` read from a schema, a commit's
// answer holding more records than were sent (every record of a changed key) and nothing else, and
// a draft that changes, takes in, reverts and resolves a shared field on every record of its key,
// so a commit always carries one value per key; AI's proposals for one go the same way.
import { describe, expect, it } from 'vitest';
import {
  ErpContractError,
  keysSharing,
  parseCommitResponse,
  parseSchema,
  scopeOf,
  sharedByKey,
  type CommitConflict,
  type CommitRequest,
  type ErpRecord,
} from './contract';
import { ErpDraft } from './drafts';
import { applyProposals, buildAiRequest } from './view/aiPrepare';
import { ITEM_RECORDS, ITEM_SCHEMA, VENDOR_RECORDS, VENDOR_SCHEMA } from './view/testing';

const [A, B, C, OTHER] = ITEM_RECORDS as [ErpRecord, ErpRecord, ErpRecord, ErpRecord];
const PLACE = {
  linkId: 'link-1',
  connectorId: 'itemsOnHand',
  source: {
    workspaceId: 'ws-1',
    pageId: '01930000-0000-7000-8000-0000000000bb',
    blockId: 'Blk000000001',
  },
};
const ID = '6f1c2b0e-8f34-4a51-9d2e-1b7c3f4e5a60';

const draft = () =>
  new ErpDraft('page#block', PLACE, { newId: () => ID, wait: async () => undefined });

const ids = (d: ErpDraft) =>
  d
    .records()
    .map((r) => r.id)
    .sort();

describe('a schema’s scopes', () => {
  it('reads `key` and `record`, takes an absent one as `record`, and refuses others', () => {
    const wire = JSON.parse(JSON.stringify(ITEM_SCHEMA)) as Record<string, unknown> & {
      fields: Record<string, unknown>[];
    };
    const read = parseSchema(wire);
    expect(read.fields.filter(sharedByKey).map((f) => f.name)).toEqual(['itemName', 'itemGroup']);
    expect(scopeOf(read.fields[0]!)).toBe('record');
    wire.fields[0]!.scope = 'record';
    expect(parseSchema(wire).fields[0]!.scope).toBe('record');
    // An older client's schema, without the attribute: every field its record's own.
    expect(parseSchema(VENDOR_SCHEMA).fields.some(sharedByKey)).toBe(false);
    wire.fields[0]!.scope = 'company';
    expect(() => parseSchema(wire)).toThrow(ErpContractError);
    wire.fields[0]!.scope = null;
    expect(parseSchema(wire).fields[0]!.scope).toBeUndefined();
  });
});

describe('a commit’s answer', () => {
  const request: CommitRequest = {
    commitId: ID,
    schemaVersion: 'itemsOnHand.1',
    dryRun: true,
    source: PLACE.source,
    records: [
      {
        id: A.id,
        key: A.key,
        version: A.version,
        changes: { itemName: { from: A.values.itemName!, to: 'Renamed' } },
      },
    ],
  };
  const as = (r: ErpRecord) => ({ ...r, values: { ...r.values, itemName: 'Renamed' } });

  it('may hold every record of a key whose shared field changed, and no other', () => {
    expect(keysSharing(request, ITEM_SCHEMA)).toEqual(new Set([A.key]));
    const answer = {
      commitId: ID,
      dryRun: true,
      committedAt: null,
      records: [as(A), as(B), as(C)],
    };
    const context = { request, schema: ITEM_SCHEMA };
    expect(parseCommitResponse(answer, context).records).toHaveLength(3);
    // Another item's record, or one missing of those sent, breaks the contract.
    expect(() => parseCommitResponse({ ...answer, records: [as(A), OTHER] }, context)).toThrow(
      ErpContractError,
    );
    expect(() => parseCommitResponse({ ...answer, records: [as(B)] }, context)).toThrow(
      ErpContractError,
    );
    // A field of the record's own changes only the record: nothing else may come back.
    const own: CommitRequest = {
      ...request,
      records: [{ ...request.records[0]!, changes: { onHandQty: { from: '1.000', to: '2.000' } } }],
    };
    expect(keysSharing(own, ITEM_SCHEMA)).toEqual(new Set());
    expect(() => parseCommitResponse(answer, { request: own, schema: ITEM_SCHEMA })).toThrow(
      ErpContractError,
    );
    // Without the schema the scopes are not known: any record of a key sent is taken.
    expect(parseCommitResponse(answer, { request: own }).records).toHaveLength(3);
    // Vendors as before: exactly the records sent.
    const [V] = VENDOR_RECORDS as [ErpRecord];
    const vendor: CommitRequest = {
      ...request,
      schemaVersion: 'vendors.1',
      records: [
        {
          id: V.id,
          key: V.key,
          version: V.version,
          changes: { vendorName: { from: 'a', to: 'b' } },
        },
      ],
    };
    expect(keysSharing(vendor, VENDOR_SCHEMA)).toEqual(new Set());
  });
});

describe('a draft and a shared field', () => {
  it('changes every record of the key the block or the draft holds, and only those', () => {
    const d = draft();
    // The block holds A and B; C was changed on an earlier page.
    d.set(C, 'onHandQty', '1.000');
    expect(d.apply(ITEM_SCHEMA, A, 'itemName', 'Renamed', { held: [A, B, OTHER] })).toBe(true);
    expect(ids(d)).toEqual([A.id, B.id, C.id].sort());
    for (const r of d.records()) {
      expect(r.changes.itemName).toEqual({
        from: A.values.itemName,
        to: 'Renamed',
        byAi: false,
        shared: true,
      });
    }
    // A record's own field stays the record's.
    expect(d.apply(ITEM_SCHEMA, B, 'onHandQty', '9.000', { held: [A, B, C] })).toBe(true);
    expect(d.record(A.id)!.changes.onHandQty).toBeUndefined();
    // Set back to what was read: gone from every row.
    d.apply(ITEM_SCHEMA, B, 'itemName', A.values.itemName!, { held: [A, B, C] });
    expect(ids(d)).toEqual([B.id, C.id].sort());
    expect(d.record(B.id)!.changes.itemName).toBeUndefined();
  });

  it('reverts a shared change on every record of its key', () => {
    const d = draft();
    d.apply(ITEM_SCHEMA, A, 'itemName', 'Renamed', { held: [A, B, C] });
    d.apply(ITEM_SCHEMA, A, 'onHandQty', '2.000', { held: [A, B, C] });
    d.revert(B.id, 'itemName');
    expect(ids(d)).toEqual([A.id]);
    expect(Object.keys(d.record(A.id)!.changes)).toEqual(['onHandQty']);
    d.apply(ITEM_SCHEMA, A, 'itemName', 'Again', { held: [A, B, C] });
    d.revert(A.id);
    expect(d.hasChanges()).toBe(false);
  });

  it('takes in a record of the key read later, while editing only', async () => {
    const d = draft();
    d.apply(ITEM_SCHEMA, A, 'itemName', 'Renamed', { held: [A] });
    expect(d.adopt([B, OTHER])).toBe(true);
    expect(ids(d)).toEqual([A.id, B.id].sort());
    expect(d.record(B.id)!.changes.itemName).toMatchObject({ to: 'Renamed', shared: true });
    // Nothing new: nothing happens. A record already holding the value has nothing to change.
    expect(d.adopt([A, B])).toBe(false);
    expect(d.adopt([{ ...C, values: { ...C.values, itemName: 'Renamed' } }])).toBe(false);
    // A review describes the records it was made of: none taken in while it shows.
    const api = {
      commit: async (request: CommitRequest) => ({
        kind: 'done' as const,
        response: {
          commitId: request.commitId,
          dryRun: true,
          committedAt: null,
          records: [],
        },
        correlationId: null,
      }),
      commitStatus: async () => ({ status: 'unknown' as const }),
    };
    await d.review(api, ITEM_SCHEMA);
    expect(d.phase().kind).toBe('reviewed');
    expect(d.adopt([C])).toBe(false);
  });
});

describe('a draft resolving a 409 on a shared field', () => {
  /** A, B and C renamed; the ERP answers a conflict for A and B, with these fields changed. */
  const conflicted = async (fieldsOf: (r: ErpRecord) => string[]) => {
    const d = draft();
    d.apply(ITEM_SCHEMA, A, 'itemName', 'Mine', { held: [A, B, C] });
    const api = {
      commit: async () => ({
        kind: 'conflict' as const,
        conflicts: [A, B].map((r): CommitConflict => ({
          id: r.id,
          key: r.key,
          version: 'AAAAAAAAQAA=',
          values: { ...r.values, itemName: fieldsOf(r).length ? 'Theirs' : r.values.itemName! },
          fields: fieldsOf(r),
          modifiedBy: null,
          modifiedAt: null,
        })),
        correlationId: null,
      }),
      commitStatus: async () => ({ status: 'unknown' as const }),
    };
    await d.review(api, ITEM_SCHEMA);
    expect(d.phase().kind).toBe('conflict');
    return d;
  };

  it('takes one choice for the key: theirs drops the change from every row, C included', async () => {
    const d = await conflicted(() => ['itemName']);
    // A choice for A alone is the key's.
    expect(d.resolve(new Map([[A.id, new Map([['itemName', 'theirs' as const]])]]))).toBe(true);
    expect(d.hasChanges()).toBe(false);
  });

  it('keeps mine on every row, each on its new version', async () => {
    const d = await conflicted(() => ['itemName']);
    expect(d.resolve(new Map([[B.id, new Map([['itemName', 'mine' as const]])]]))).toBe(true);
    expect(ids(d)).toEqual([A.id, B.id, C.id].sort());
    expect(d.record(A.id)!.version).toBe('AAAAAAAAQAA=');
    expect(d.record(A.id)!.changes.itemName).toMatchObject({ from: 'Theirs', to: 'Mine' });
    // C was not in conflict: its change and version are as they were.
    expect(d.record(C.id)!.version).toBe(C.version);
  });

  it('needs no choice where the conflict changed no field of the commit (a stock movement)', async () => {
    const d = await conflicted(() => []);
    expect(d.resolve(new Map())).toBe(true);
    expect(ids(d)).toEqual([A.id, B.id, C.id].sort());
    expect(d.record(B.id)!.version).toBe('AAAAAAAAQAA=');
  });
});

describe('AI and a shared field', () => {
  it('marks it in the request, and a proposal changes every row of its item on screen', () => {
    const request = buildAiRequest('Rename the oil', ITEM_SCHEMA, ITEM_RECORDS, 'en');
    expect(request.fields.map((f) => [f.name, f.scope])).toEqual([
      ['itemName', 'key'],
      ['itemGroup', 'key'],
    ]);
    const d = draft();
    const result = applyProposals(
      d,
      [
        { id: A.id, field: 'itemName', to: 'First' },
        // A second value for the same item: the last proposal wins, as for one record's field.
        { id: C.id, field: 'itemName', to: 'Olive oil, one litre' },
        { id: OTHER.id, field: 'itemGroup', to: 'PAPER' },
      ],
      ITEM_RECORDS,
      ITEM_SCHEMA,
    );
    expect(result).toEqual({ applied: 2, skipped: 0 });
    for (const id of [A.id, B.id, C.id]) {
      expect(d.record(id)!.changes.itemName).toMatchObject({
        to: 'Olive oil, one litre',
        byAi: true,
        shared: true,
      });
    }
    expect(d.record(OTHER.id)!.changes.itemGroup).toMatchObject({ to: 'PAPER', byAi: true });
  });
});
