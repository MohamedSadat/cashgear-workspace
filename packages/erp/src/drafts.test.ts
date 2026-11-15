// Pending changes to ERP records (Phase 7): a draft reviews exactly what Commit would send, sends
// one commit id per attempt and the same on every retry, settles a lost answer by CommitStatus
// before anything is sent again, never changes a payload whose outcome is unknown, resolves a
// conflict per field, and reports each attempt's end to Workspace's audit without a value.
import { describe, expect, it } from 'vitest';
import type { CommitOutcome } from './client';
import {
  ErpError,
  type CommitRequest,
  type CommitResponse,
  type CommitStatusResponse,
  type ConnectorSchema,
  type ErpRecord,
} from './contract';
import {
  COMMIT_RETRIES,
  ErpDraft,
  ErpDrafts,
  localProblem,
  parseInput,
  type DraftCommitApi,
  type ErpCommitAudit,
} from './drafts';
import { VENDOR_RECORDS, VENDOR_SCHEMA } from './view/testing';

const SCHEMA: ConnectorSchema = VENDOR_SCHEMA;
const [A, B] = VENDOR_RECORDS as [ErpRecord, ErpRecord];
const PLACE = {
  linkId: 'link-1',
  connectorId: 'vendors',
  source: {
    workspaceId: 'ws-1',
    pageId: '01930000-0000-7000-8000-0000000000bb',
    blockId: 'Blk000000001',
  },
};

/** A scripted ERP: each call takes the next answer of its kind, else writes like the ERP. */
class Script implements DraftCommitApi {
  readonly sent: CommitRequest[] = [];
  readonly asked: string[] = [];
  readonly commits: (CommitOutcome | ErpError | 'write')[] = [];
  readonly statuses: (CommitStatusResponse | ErpError | 'stored')[] = [];
  readonly stored = new Map<string, CommitResponse>();

  respond(request: CommitRequest): CommitResponse {
    return {
      commitId: request.commitId,
      dryRun: request.dryRun,
      committedAt: request.dryRun ? null : '2026-11-15T10:00:00Z',
      records: request.records.map((r) => ({
        id: r.id,
        key: r.key,
        version: request.dryRun ? r.version : 'AAAAAAAAEQA=',
        values: Object.fromEntries(Object.entries(r.changes).map(([f, c]) => [f, c.to])),
      })),
    };
  }

  commit = async (request: CommitRequest): Promise<CommitOutcome> => {
    this.sent.push(request);
    const next = this.commits.shift() ?? 'write';
    if (next instanceof ErpError) throw next;
    if (next !== 'write') return next;
    const response = this.respond(request);
    if (!request.dryRun) this.stored.set(request.commitId, response);
    return { kind: 'done', response, correlationId: 'c' };
  };

  commitStatus = async (commitId: string): Promise<CommitStatusResponse> => {
    this.asked.push(commitId);
    const next = this.statuses.shift() ?? 'stored';
    if (next instanceof ErpError) throw next;
    if (next !== 'stored') return next;
    const stored = this.stored.get(commitId);
    return stored ? { status: 'committed', ...stored } : { status: 'unknown' };
  };
}

let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

function setup() {
  const audits: ErpCommitAudit[] = [];
  const draft = new ErpDraft('page#block', PLACE, {
    newId,
    wait: async () => undefined,
    audit: (entry) => void audits.push(entry),
  });
  return { draft, audits, api: new Script() };
}

const lost = () => new ErpError('network', { detail: 'no answer' });

describe('a draft', () => {
  it('holds changes against what was read, and drops one set back', () => {
    const { draft } = setup();
    expect(draft.set(A, 'vendorName', 'Qorvath Lanterns')).toBe(true);
    draft.set(A, 'vendorGroup', 'IMPORT');
    draft.set(B, 'vendorName', 'Velmorra');
    expect(draft.changeCount()).toBe(3);
    expect(draft.record(A.id)!.changes.vendorName).toEqual({
      from: A.values.vendorName,
      to: 'Qorvath Lanterns',
      byAi: false,
    });
    // Back to the value read: no change.
    draft.set(A, 'vendorName', A.values.vendorName!);
    expect(draft.changeCount()).toBe(2);
    draft.revert(B.id);
    expect(draft.records().map((r) => r.id)).toEqual([A.id]);
    // `""` and null are the same for text.
    draft.set(B, 'currency', 'USD');
    expect(draft.hasChanges()).toBe(true);
    expect(draft.discard()).toBe(true);
    expect(draft.pending()).toBe(false);
  });

  it('reviews by a dry run of exactly what Commit sends, under the same id', async () => {
    const { draft, api, audits } = setup();
    draft.set(A, 'vendorName', 'Qorvath Lanterns');
    await draft.review(api, SCHEMA);
    expect(draft.phase().kind).toBe('reviewed');
    await draft.commit(api, SCHEMA);
    expect(draft.phase()).toMatchObject({ kind: 'committed', changes: 1 });
    expect(api.sent.map((r) => r.dryRun)).toEqual([true, false]);
    expect(api.sent[0]!.commitId).toBe(api.sent[1]!.commitId);
    expect({ ...api.sent[0], dryRun: false }).toEqual(api.sent[1]);
    expect(api.sent[1]).toMatchObject({
      schemaVersion: 'vendors.1',
      source: PLACE.source,
      records: [
        {
          id: A.id,
          key: A.key,
          version: A.version,
          changes: { vendorName: { from: A.values.vendorName, to: 'Qorvath Lanterns' } },
        },
      ],
    });
    expect(draft.hasChanges()).toBe(false);
    expect(audits).toEqual([
      {
        pageId: PLACE.source.pageId,
        blockId: PLACE.source.blockId,
        linkId: 'link-1',
        connectorId: 'vendors',
        commitId: api.sent[1]!.commitId,
        outcome: 'committed',
        records: 1,
        fields: 1,
      },
    ]);
    // Nothing in Workspace's audit holds a value.
    expect(JSON.stringify(audits)).not.toContain('Qorvath');
  });

  it('takes a new id when the changes differ from what was reviewed', async () => {
    const { draft, api } = setup();
    draft.set(A, 'vendorName', 'One');
    await draft.review(api, SCHEMA);
    draft.set(A, 'vendorName', 'Two');
    expect(draft.phase().kind).toBe('editing');
    await draft.review(api, SCHEMA);
    expect(api.sent[0]!.commitId).not.toBe(api.sent[1]!.commitId);
    // Back to what an earlier id stood for: still a new attempt's id, never one used for others.
    draft.set(A, 'vendorName', 'One');
    await draft.review(api, SCHEMA);
    expect(new Set(api.sent.map((r) => r.commitId)).size).toBe(3);
  });

  it('settles a lost answer by CommitStatus, and sends nothing again once it was written', async () => {
    const { draft, api, audits } = setup();
    draft.set(A, 'vendorName', 'Lost');
    // Written, and the answer lost.
    api.commit = (async (request: CommitRequest) => {
      api.sent.push(request);
      api.stored.set(request.commitId, api.respond(request));
      throw lost();
    }) as Script['commit'];
    await draft.commit(api, SCHEMA);
    expect(draft.phase().kind).toBe('committed');
    expect(api.sent).toHaveLength(1);
    expect(api.asked).toEqual([api.sent[0]!.commitId]);
    expect(audits.map((a) => a.outcome)).toEqual(['committed']);
  });

  it('sends the same request again, at most three times, then says the outcome is unknown', async () => {
    const { draft, api, audits } = setup();
    draft.set(A, 'vendorName', 'Busy');
    for (let i = 0; i <= COMMIT_RETRIES; i++) {
      api.commits.push(new ErpError('server', { status: 503, retryAfterMs: 1000 }));
    }
    await draft.commit(api, SCHEMA);
    const phase = draft.phase();
    expect(phase).toMatchObject({ kind: 'unknown', reconnect: false });
    expect(api.sent).toHaveLength(COMMIT_RETRIES + 1);
    expect(new Set(api.sent.map((r) => r.commitId)).size).toBe(1);
    expect(new Set(api.sent.map((r) => JSON.stringify(r))).size).toBe(1);
    // CommitStatus after every lost answer: nothing was written under the id.
    expect(api.asked).toHaveLength(COMMIT_RETRIES + 1);
    expect(audits.map((a) => a.outcome)).toEqual(['failed']);
    // While it is unknown, the changes cannot be edited, so the payload under the id never changes.
    expect(draft.set(A, 'vendorName', 'Other')).toBe(false);
    expect(draft.locked()).toBe(true);
    expect(draft.pending()).toBe(true);
    // "Try again": CommitStatus first, then the same request.
    await draft.resume(api, SCHEMA);
    expect(draft.phase().kind).toBe('committed');
    expect(api.sent.at(-1)).toEqual(api.sent[0]);
    expect(audits.map((a) => a.outcome)).toEqual(['failed', 'committed']);
  });

  it('says unknown, not failed, when CommitStatus could not be asked either', async () => {
    const { draft, api, audits } = setup();
    draft.set(A, 'vendorName', 'Gone');
    for (let i = 0; i <= COMMIT_RETRIES; i++) api.commits.push(lost());
    for (let i = 0; i <= COMMIT_RETRIES + 1; i++) api.statuses.push(lost());
    await draft.commit(api, SCHEMA);
    expect(draft.phase().kind).toBe('unknown');
    expect(audits.map((a) => a.outcome)).toEqual(['unknown']);
  });

  it('asks CommitStatus once connected again after the session ended mid-commit', async () => {
    const { draft, api } = setup();
    draft.set(A, 'vendorName', 'Expired');
    api.commit = (async (request: CommitRequest) => {
      api.sent.push(request);
      api.stored.set(request.commitId, api.respond(request));
      throw new ErpError('session.expired', { status: 401 });
    }) as Script['commit'];
    await draft.commit(api, SCHEMA);
    expect(draft.phase()).toMatchObject({ kind: 'unknown', reconnect: true });
    expect(api.asked).toEqual([]);
    await draft.resume(api, SCHEMA);
    expect(draft.phase().kind).toBe('committed');
    expect(api.sent).toHaveLength(1);
  });

  it('keeps the changes when the ERP refuses fields or the whole commit', async () => {
    const { draft, api, audits } = setup();
    draft.set(A, 'vendorName', '');
    api.commits.push({
      kind: 'invalid',
      errors: [{ id: A.id, key: A.key, field: 'vendorName', code: 'required', message: 'x' }],
      correlationId: 'c',
    });
    await draft.review(api, SCHEMA);
    expect(draft.phase()).toMatchObject({ kind: 'invalid', dryRun: true });
    expect(draft.hasChanges()).toBe(true);
    // Dry runs are not attempts: nothing is reported.
    expect(audits).toEqual([]);
    draft.back();
    api.commits.push(new ErpError('privilege.denied', { status: 403 }));
    await draft.commit(api, SCHEMA);
    expect(draft.phase()).toMatchObject({ kind: 'failed', during: 'commit' });
    expect(draft.hasChanges()).toBe(true);
    expect(audits.map((a) => a.outcome)).toEqual(['refused']);
  });

  it('resolves a conflict per field, on the record’s new version, and asks for every choice', async () => {
    const { draft, api } = setup();
    draft.set(A, 'vendorName', 'Mine');
    draft.set(A, 'vendorGroup', 'IMPORT');
    draft.set(B, 'vendorName', 'Mine too');
    const conflict = {
      id: A.id,
      key: A.key,
      version: 'AAAAAAAAEgA=',
      values: { ...A.values, vendorName: 'Theirs' },
      fields: ['vendorName'],
      modifiedBy: 'Bob',
      modifiedAt: '2026-11-15T09:00:00Z',
    };
    api.commits.push({ kind: 'conflict', conflicts: [conflict], correlationId: 'c' });
    await draft.review(api, SCHEMA);
    expect(draft.phase().kind).toBe('conflict');
    // The group was not changed there, but the name was: it needs a choice.
    expect(draft.resolve(new Map())).toBe(false);
    expect(draft.phase().kind).toBe('conflict');
    expect(draft.resolve(new Map([[A.id, new Map([['vendorName', 'mine' as const]])]]))).toBe(true);
    const rebased = draft.record(A.id)!;
    expect(rebased.version).toBe(conflict.version);
    expect(rebased.changes.vendorName).toMatchObject({ from: 'Theirs', to: 'Mine' });
    expect(rebased.changes.vendorGroup).toMatchObject({ from: 'LOCAL', to: 'IMPORT' });
    expect(draft.record(B.id)!.version).toBe(B.version);
    // Theirs drops the change; a record with none left leaves the draft.
    api.commits.push({ kind: 'conflict', conflicts: [conflict], correlationId: 'c' });
    await draft.review(api, SCHEMA);
    draft.resolve(
      new Map([
        [
          A.id,
          new Map([
            ['vendorName', 'theirs' as const],
            ['vendorGroup', 'theirs' as const],
          ]),
        ],
      ]),
    );
    expect(draft.record(A.id)).toBeUndefined();
    expect(draft.changeCount()).toBe(1);
  });

  it('is not discarded while a commit is out', async () => {
    const { draft, api } = setup();
    draft.set(A, 'vendorName', 'Slow');
    let release!: () => void;
    api.commit = (async (request: CommitRequest) => {
      api.sent.push(request);
      await new Promise<void>((done) => (release = done));
      return { kind: 'done', response: api.respond(request), correlationId: 'c' };
    }) as Script['commit'];
    const out = draft.commit(api, SCHEMA);
    await Promise.resolve();
    expect(draft.phase().kind).toBe('committing');
    expect(draft.discard()).toBe(false);
    expect(draft.set(A, 'vendorName', 'Other')).toBe(false);
    release();
    await out;
    expect(draft.phase().kind).toBe('committed');
  });
});

describe('the tab’s drafts', () => {
  it('keeps one draft per block, and tells which pages hold changes', () => {
    const drafts = new ErpDrafts();
    const key = ErpDrafts.key('page-1', 'Blk000000001');
    const draft = drafts.get(key, PLACE);
    expect(drafts.get(key, PLACE)).toBe(draft);
    expect(drafts.pendingOn('page-1')).toBe(false);
    draft.set(A, 'vendorName', 'x');
    expect(drafts.pendingOn('page-1')).toBe(true);
    expect(drafts.pendingOn('page-2')).toBe(false);
    // The block pointed at other data meanwhile: the pending draft is kept, to be offered away.
    const other = { ...PLACE, connectorId: 'customers' };
    expect(drafts.get(key, other)).toBe(draft);
    drafts.discardPage('page-1');
    expect(drafts.pending()).toEqual([]);
    expect(drafts.peek(key)).toBeUndefined();
    // An empty draft for other data is replaced.
    const empty = drafts.get(key, PLACE);
    expect(drafts.get(key, other)).not.toBe(empty);
  });
});

describe('the local checks', () => {
  const f = (name: string) => SCHEMA.fields.find((x) => x.name === name)!;

  it('say what the ERP would, as a courtesy only', () => {
    expect(localProblem(f('vendorName'), SCHEMA, '')).toBe('required');
    expect(localProblem(f('vendorName'), SCHEMA, 'x'.repeat(151))).toBe('maxLength');
    expect(localProblem(f('vendorName'), SCHEMA, 'Fine')).toBeNull();
    expect(localProblem(f('vendorGroup'), SCHEMA, 'NOPE')).toBe('lookup.notFound');
    // An inactive code may stay on a record, but no change may choose it.
    expect(localProblem(f('vendorGroup'), SCHEMA, 'OLD')).toBe('lookup.notFound');
    expect(localProblem(f('vendorGroup'), SCHEMA, 'IMPORT')).toBeNull();
    expect(localProblem(f('debitLimit'), SCHEMA, '1.00')).toBe('field.readOnly');
    const decimal = { ...f('debitLimit'), editable: true, min: '0' };
    expect(localProblem(decimal, SCHEMA, '1.005')).toBe('scale');
    expect(localProblem(decimal, SCHEMA, '-1.00')).toBe('range');
    expect(localProblem(decimal, SCHEMA, 'abc')).toBe('type');
    expect(localProblem(decimal, SCHEMA, '12.50')).toBeNull();
  });

  it('read what a person types, Arabic-Indic digits included', () => {
    const decimal = { ...f('debitLimit'), editable: true };
    expect(parseInput(decimal, '١٢٣٫٥')).toEqual({ ok: true, value: '123.5' });
    expect(parseInput(decimal, '1,250.75')).toEqual({ ok: true, value: '1250.75' });
    expect(parseInput(decimal, '.5')).toEqual({ ok: true, value: '0.5' });
    expect(parseInput(decimal, '1.234')).toEqual({ ok: false, problem: 'scale' });
    expect(parseInput(decimal, 'ten')).toEqual({ ok: false, problem: 'type' });
    expect(parseInput(decimal, '')).toEqual({ ok: true, value: null });
    const integer = { ...decimal, type: 'integer' as const };
    expect(parseInput(integer, '٤٢')).toEqual({ ok: true, value: 42 });
    expect(parseInput(integer, '4.2')).toEqual({ ok: false, problem: 'type' });
    expect(parseInput(f('blocked'), 'true')).toEqual({ ok: true, value: true });
    expect(parseInput(f('vendorName'), '')).toEqual({ ok: true, value: null });
    expect(parseInput(f('vendorName'), '  spaced  ')).toEqual({ ok: true, value: '  spaced  ' });
  });
});
