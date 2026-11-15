// Pending changes to ERP records (INTEGRATIONS.md, "Level 2: editable ERP blocks"): held per
// block in the tab's memory only, never in the document, a store, a log or a URL. "Review
// changes" is a dry run of exactly what Commit would send; Commit sends it with one `commitId`
// per attempt, the same on every retry, and a lost answer is settled by `CommitStatus` before
// anything is sent again. While an outcome is unknown the changes cannot be edited, so the
// payload under that id never changes. A conflict (409) is resolved per field by the person:
// keep theirs, or keep their own on the record's new version. Nothing here grants anything: the
// ERP checks every privilege and value, and these local checks are only a courtesy.
import type { CommitOutcome } from './client';
import {
  ErpError,
  isDecimal,
  valueProblem,
  type ApiError,
  type CommitConflict,
  type CommitErrorCode,
  type CommitRequest,
  type CommitResponse,
  type CommitSource,
  type CommitStatusResponse,
  type ConnectorSchema,
  type ErpRecord,
  type FieldSchema,
  type WireValue,
} from './contract';

export interface DraftChange {
  /** The value the record was read with. */
  readonly from: WireValue;
  readonly to: WireValue;
  /** Prepared by AI (`@cgw/erp/ai`), not typed by the person. */
  readonly byAi: boolean;
}

export interface DraftRecord {
  readonly id: string;
  readonly key: string;
  /** The version the changes are based on. */
  readonly version: string;
  /** The values it was read with, of the fields the block showed. */
  readonly values: Readonly<Record<string, WireValue>>;
  readonly changes: Readonly<Record<string, DraftChange>>;
}

/** Which data a draft changes, and where in Workspace, for the ERP's audit. */
export interface DraftPlace {
  /** Workspace's `ErpLinks` id. */
  readonly linkId: string;
  readonly connectorId: string;
  readonly source: CommitSource;
}

export type CommitAuditOutcome = 'committed' | 'conflict' | 'refused' | 'unknown' | 'failed';

/** What Workspace's API records of a real commit attempt (`erp-commits`): never a value. */
export interface ErpCommitAudit {
  readonly pageId: string;
  readonly blockId: string | null;
  readonly linkId: string;
  readonly connectorId: string;
  readonly commitId: string;
  readonly outcome: CommitAuditOutcome;
  readonly records: number;
  readonly fields: number;
}

export type DraftPhase =
  | { readonly kind: 'editing' }
  /** The dry run is out. */
  | { readonly kind: 'reviewing' }
  /** The dry run passed: `response` is what Commit would write. */
  | {
      readonly kind: 'reviewed';
      readonly request: CommitRequest;
      readonly response: CommitResponse;
    }
  /** The ERP refused records or fields (400): every error. Nothing was written. */
  | {
      readonly kind: 'invalid';
      readonly request: CommitRequest;
      readonly errors: readonly ApiError[];
      readonly dryRun: boolean;
    }
  /** Records changed in the ERP since they were read (409). Nothing was written. */
  | {
      readonly kind: 'conflict';
      readonly request: CommitRequest;
      readonly conflicts: readonly CommitConflict[];
    }
  /** The commit is out, or `CommitStatus` is being asked about it (`checking`). */
  | {
      readonly kind: 'committing';
      readonly request: CommitRequest;
      readonly attempt: number;
      readonly checking: boolean;
    }
  /**
   * Whether the commit was written is not known: no answer and no `CommitStatus`. `reconnect`:
   * the session ended, so `CommitStatus` is asked once the person connects again.
   */
  | {
      readonly kind: 'unknown';
      readonly request: CommitRequest;
      readonly error: ErpError;
      readonly reconnect: boolean;
    }
  | { readonly kind: 'committed'; readonly response: CommitResponse; readonly changes: number }
  /** Refused as a whole (a privilege, the schema changed, too many records). Nothing written. */
  | { readonly kind: 'failed'; readonly error: ErpError; readonly during: 'review' | 'commit' };

/** What a draft commits through: the block's link and connector in the tab's sessions. */
export interface DraftCommitApi {
  commit(
    request: CommitRequest,
    options: { readonly schema: ConnectorSchema; readonly signal?: AbortSignal },
  ): Promise<CommitOutcome>;
  commitStatus(
    commitId: string,
    options: { readonly schema: ConnectorSchema; readonly request: CommitRequest },
  ): Promise<CommitStatusResponse>;
}

export interface DraftOptions {
  /** Makes a `commitId`: a UUID v4 in lower case. */
  readonly newId?: () => string;
  /** Waits between retries; tests pass one that does not. */
  readonly wait?: (ms: number) => Promise<void>;
  /** Records each real commit attempt's end at Workspace (`erp-commits`). */
  readonly audit?: (entry: ErpCommitAudit) => void;
}

/** A commit with no answer is sent again under its id at most this many times. */
export const COMMIT_RETRIES = 3;

const defaultId = () => globalThis.crypto.randomUUID().toLowerCase();
const defaultWait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** `""` and `null` are equal for text and lookups, as the ERP takes them. */
export function sameValue(a: WireValue | undefined, b: WireValue | undefined): boolean {
  const x = a === '' || a === undefined ? null : a;
  const y = b === '' || b === undefined ? null : b;
  return x === y;
}

/** Sorted keys at every level: the payload a `commitId` stands for. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** An answer that may have been written: `CommitStatus` settles it. */
const outcomeUnknown = (e: ErpError) =>
  e.code === 'network' ||
  e.code === 'server' ||
  e.code === 'rate.limited' ||
  e.code === 'response.invalid' ||
  e.code === 'aborted';

export class ErpDraft {
  readonly key: string;
  readonly place: DraftPlace;
  readonly #newId: () => string;
  readonly #wait: (ms: number) => Promise<void>;
  readonly #audit: ((entry: ErpCommitAudit) => void) | undefined;
  #records = new Map<string, DraftRecord>();
  #list: readonly DraftRecord[] = [];
  #phase: DraftPhase = { kind: 'editing' };
  #attempt: { commitId: string; payload: string } | null = null;
  #busy = false;
  #rev = 0;
  readonly #listeners = new Set<() => void>();

  constructor(key: string, place: DraftPlace, options: DraftOptions = {}) {
    this.key = key;
    this.place = place;
    this.#newId = options.newId ?? defaultId;
    this.#wait = options.wait ?? defaultWait;
    this.#audit = options.audit;
  }

  /** Rises with every change: a stable snapshot for `useSyncExternalStore`. */
  rev = (): number => this.#rev;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  /** The changed records, in the order they were first changed. */
  records(): readonly DraftRecord[] {
    return this.#list;
  }

  record(id: string): DraftRecord | undefined {
    return this.#records.get(id);
  }

  phase(): DraftPhase {
    return this.#phase;
  }

  /** Changed fields, over every record. */
  changeCount(): number {
    let n = 0;
    for (const record of this.#records.values()) n += Object.keys(record.changes).length;
    return n;
  }

  hasChanges(): boolean {
    return this.#records.size > 0;
  }

  /** Whether leaving would lose something: changes, or a commit whose outcome is not known. */
  pending(): boolean {
    return this.hasChanges() || this.#phase.kind === 'committing' || this.#phase.kind === 'unknown';
  }

  /** While a review or commit is out, or an outcome unknown, the changes are not edited. */
  locked(): boolean {
    const kind = this.#phase.kind;
    return kind === 'reviewing' || kind === 'committing' || kind === 'unknown';
  }

  /**
   * Sets a field of a record as read to `to`; a value equal to the one read drops the change.
   * False when the draft is locked.
   */
  set(
    record: Pick<ErpRecord, 'id' | 'key' | 'version' | 'values'>,
    field: string,
    to: WireValue,
    byAi = false,
  ): boolean {
    if (this.locked()) return false;
    const existing = this.#records.get(record.id);
    const values = { ...(existing?.values ?? record.values) };
    if (!Object.prototype.hasOwnProperty.call(values, field)) {
      values[field] = record.values[field] ?? null;
    }
    const changes = { ...existing?.changes };
    const from = values[field] ?? null;
    if (sameValue(from, to)) delete changes[field];
    else changes[field] = { from, to, byAi };
    const next: DraftRecord = {
      id: record.id,
      key: existing?.key ?? record.key,
      version: existing?.version ?? record.version,
      values,
      changes,
    };
    this.#put(next);
    this.#edited();
    return true;
  }

  /** Drops a field's change, or every change of the record. */
  revert(id: string, field?: string): boolean {
    if (this.locked()) return false;
    const existing = this.#records.get(id);
    if (!existing) return true;
    if (field === undefined) this.#put({ ...existing, changes: {} });
    else {
      const changes = { ...existing.changes };
      delete changes[field];
      this.#put({ ...existing, changes });
    }
    this.#edited();
    return true;
  }

  /** Drops every change. Not while a commit is out (its outcome would be lost track of). */
  discard(): boolean {
    if (this.#busy) return false;
    this.#records.clear();
    this.#list = [];
    this.#attempt = null;
    this.#phase = { kind: 'editing' };
    this.#emit();
    return true;
  }

  /** Leaves a review, a refusal, a conflict or a success for editing again. */
  back(): void {
    if (this.#busy || this.#phase.kind === 'unknown') return;
    if (this.#phase.kind === 'editing') return;
    this.#phase = { kind: 'editing' };
    this.#emit();
  }

  /** "Review changes": a dry run of exactly what Commit would send. */
  async review(api: DraftCommitApi, schema: ConnectorSchema): Promise<void> {
    if (this.#busy || this.locked() || !this.hasChanges()) return;
    const request = this.#request(schema.schemaVersion, true);
    this.#busy = true;
    this.#phase = { kind: 'reviewing' };
    this.#emit();
    try {
      const outcome = await api.commit(request, { schema });
      if (outcome.kind === 'done') {
        this.#phase = { kind: 'reviewed', request, response: outcome.response };
      } else if (outcome.kind === 'invalid') {
        this.#phase = { kind: 'invalid', request, errors: outcome.errors, dryRun: true };
      } else {
        this.#phase = { kind: 'conflict', request, conflicts: outcome.conflicts };
      }
    } catch (error) {
      const e = asErpError(error);
      this.#phase =
        e.code === 'aborted' ? { kind: 'editing' } : { kind: 'failed', error: e, during: 'review' };
    } finally {
      this.#busy = false;
      this.#emit();
    }
  }

  /** "Commit": the changes as reviewed, under the review's id unless they changed since. */
  async commit(api: DraftCommitApi, schema: ConnectorSchema): Promise<void> {
    if (this.#busy || this.locked() || !this.hasChanges()) return;
    await this.#send(api, schema, this.#request(schema.schemaVersion, false), false);
  }

  /** An unknown outcome, asked again: `CommitStatus` first, then the same request. */
  async resume(api: DraftCommitApi, schema: ConnectorSchema): Promise<void> {
    const phase = this.#phase;
    if (this.#busy || phase.kind !== 'unknown') return;
    await this.#send(api, schema, phase.request, true);
  }

  /**
   * A conflict resolved: for each conflicting record, each changed field `mine` (kept, on the
   * record's new version) or `theirs` (dropped). A field the ERP did not change keeps the
   * person's value unless told otherwise. False, changing nothing, while any field the ERP did
   * change has no choice.
   */
  resolve(choices: ReadonlyMap<string, ReadonlyMap<string, 'mine' | 'theirs'>>): boolean {
    const phase = this.#phase;
    if (phase.kind !== 'conflict' || this.#busy) return false;
    const next: DraftRecord[] = [];
    for (const conflict of phase.conflicts) {
      const record = this.#records.get(conflict.id);
      if (!record) continue;
      const chosen = choices.get(conflict.id);
      const changes: Record<string, DraftChange> = {};
      for (const [field, change] of Object.entries(record.changes)) {
        const choice = chosen?.get(field) ?? (conflict.fields.includes(field) ? undefined : 'mine');
        if (choice === undefined) return false;
        if (choice === 'theirs') continue;
        const now = Object.prototype.hasOwnProperty.call(conflict.values, field)
          ? (conflict.values[field] ?? null)
          : change.from;
        if (sameValue(now, change.to)) continue;
        changes[field] = { from: now, to: change.to, byAi: change.byAi };
      }
      next.push({
        ...record,
        version: conflict.version,
        values: { ...record.values, ...conflict.values },
        changes,
      });
    }
    for (const record of next) this.#put(record);
    this.#attempt = null;
    this.#phase = { kind: 'editing' };
    this.#emit();
    return true;
  }

  // -------------------------------------------------------------------------------------------

  async #send(
    api: DraftCommitApi,
    schema: ConnectorSchema,
    request: CommitRequest,
    statusFirst: boolean,
  ): Promise<void> {
    this.#busy = true;
    let checkFirst = statusFirst;
    let lastError: ErpError | null = null;
    // Whether CommitStatus last said nothing was written under the id.
    let notWritten = false;
    try {
      // Sends 0 to COMMIT_RETRIES; after a lost answer, CommitStatus first, once more at the end.
      for (let attempt = 0; ; attempt++) {
        if (checkFirst) {
          if (lastError) await this.#wait(retryDelay(lastError, attempt));
          this.#phase = { kind: 'committing', request, attempt, checking: true };
          this.#emit();
          try {
            const status = await api.commitStatus(request.commitId, { schema, request });
            if (status.status === 'committed') return this.#committed(request, status);
            notWritten = true;
          } catch (error) {
            const e = asErpError(error);
            if (e.code === 'session.expired' || e.code === 'link.revoked') {
              return this.#unknown(request, e, e.code === 'session.expired');
            }
            notWritten = false;
            lastError = e;
          }
        }
        if (attempt > COMMIT_RETRIES) break;
        this.#phase = { kind: 'committing', request, attempt, checking: false };
        this.#emit();
        let outcome: CommitOutcome;
        try {
          outcome = await api.commit(request, { schema });
        } catch (error) {
          const e = asErpError(error);
          if (outcomeUnknown(e)) {
            lastError = e;
            notWritten = false;
            checkFirst = true;
            continue;
          }
          if (e.code === 'session.expired' || e.code === 'link.revoked') {
            // A browser can send a POST again by itself: CommitStatus once connected again.
            return this.#unknown(request, e, e.code === 'session.expired');
          }
          // Refused as a whole, before anything was written.
          if (e.code === 'commit.reused') this.#attempt = null;
          this.#phase = { kind: 'failed', error: e, during: 'commit' };
          this.#report(request, 'refused');
          return;
        }
        if (outcome.kind === 'done') return this.#committed(request, outcome.response);
        if (outcome.kind === 'conflict') {
          this.#phase = { kind: 'conflict', request, conflicts: outcome.conflicts };
          this.#report(request, 'conflict');
          return;
        }
        this.#phase = { kind: 'invalid', request, errors: outcome.errors, dryRun: false };
        this.#report(request, 'refused');
        return;
      }
      this.#phase = {
        kind: 'unknown',
        request,
        error: lastError ?? new ErpError('network'),
        reconnect: false,
      };
      // CommitStatus said nothing was written under the id: it failed. Else no one knows.
      this.#report(request, notWritten ? 'failed' : 'unknown');
    } finally {
      this.#busy = false;
      this.#emit();
    }
  }

  #committed(request: CommitRequest, response: CommitResponse): void {
    const changes = request.records.reduce((n, r) => n + Object.keys(r.changes).length, 0);
    this.#records.clear();
    this.#list = [];
    this.#attempt = null;
    this.#phase = {
      kind: 'committed',
      response: {
        commitId: response.commitId,
        dryRun: response.dryRun,
        committedAt: response.committedAt,
        records: response.records,
      },
      changes,
    };
    this.#report(request, 'committed');
  }

  #unknown(request: CommitRequest, error: ErpError, reconnect: boolean): void {
    this.#phase = { kind: 'unknown', request, error, reconnect };
    this.#report(request, 'unknown');
  }

  #report(request: CommitRequest, outcome: CommitAuditOutcome): void {
    if (!this.#audit) return;
    try {
      this.#audit({
        pageId: this.place.source.pageId,
        blockId: this.place.source.blockId,
        linkId: this.place.linkId,
        connectorId: this.place.connectorId,
        commitId: request.commitId,
        outcome,
        records: request.records.length,
        fields: request.records.reduce((n, r) => n + Object.keys(r.changes).length, 0),
      });
    } catch {
      // Workspace's record of the attempt is best effort; the ERP's audit is the authority.
    }
  }

  /** The request for the changes now, under the last attempt's id when they are the same. */
  #request(schemaVersion: string, dryRun: boolean): CommitRequest {
    const records = [...this.#records.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r) => ({
        id: r.id,
        key: r.key,
        version: r.version,
        changes: Object.fromEntries(
          Object.entries(r.changes).map(([field, c]) => [field, { from: c.from, to: c.to }]),
        ),
      }));
    const payload = canonical({ schemaVersion, source: this.place.source, records });
    if (!this.#attempt || this.#attempt.payload !== payload) {
      this.#attempt = { commitId: this.#newId(), payload };
    }
    return {
      commitId: this.#attempt.commitId,
      schemaVersion,
      dryRun,
      source: this.place.source,
      records,
    };
  }

  #put(record: DraftRecord): void {
    if (Object.keys(record.changes).length === 0) this.#records.delete(record.id);
    else this.#records.set(record.id, record);
    this.#list = [...this.#records.values()];
  }

  /** After an edit, a review or result no longer describes the changes. */
  #edited(): void {
    if (this.#phase.kind !== 'editing') this.#phase = { kind: 'editing' };
    this.#emit();
  }

  #emit(): void {
    this.#rev++;
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}

function asErpError(error: unknown): ErpError {
  return error instanceof ErpError ? error : new ErpError('network', { detail: 'unexpected' });
}

function retryDelay(error: ErpError, attempt: number): number {
  if (error.retryAfterMs !== null) return Math.min(error.retryAfterMs, 60_000);
  return Math.min(8_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

/** The tab's drafts, one per block (`pageId#blockId`), in memory only. */
export class ErpDrafts {
  readonly #drafts = new Map<string, { draft: ErpDraft; off: () => void }>();
  readonly #listeners = new Set<() => void>();
  readonly #options: DraftOptions;
  #rev = 0;

  constructor(options: DraftOptions = {}) {
    this.#options = options;
  }

  static key(pageId: string, blockId: string): string {
    return `${pageId}#${blockId}`;
  }

  rev = (): number => this.#rev;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  /**
   * The block's draft, made when there is none. A draft for other data (the block was pointed
   * at another connector meanwhile) is replaced when it holds nothing, and kept otherwise, for
   * the block to offer to discard.
   */
  get(key: string, place: DraftPlace, audit?: (entry: ErpCommitAudit) => void): ErpDraft {
    const held = this.#drafts.get(key);
    if (held) {
      const same =
        held.draft.place.linkId === place.linkId &&
        held.draft.place.connectorId === place.connectorId &&
        held.draft.place.source.workspaceId === place.source.workspaceId;
      if (same || held.draft.pending()) return held.draft;
      held.off();
    }
    const draft = new ErpDraft(key, place, {
      ...this.#options,
      ...(audit ? { audit } : {}),
    });
    const off = draft.subscribe(() => this.#emit());
    this.#drafts.set(key, { draft, off });
    this.#emit();
    return draft;
  }

  peek(key: string): ErpDraft | undefined {
    return this.#drafts.get(key)?.draft;
  }

  /** Drafts holding changes or a commit whose outcome is not known. */
  pending(): ErpDraft[] {
    return [...this.#drafts.values()].map((h) => h.draft).filter((d) => d.pending());
  }

  pendingOn(pageId: string): boolean {
    const prefix = `${pageId}#`;
    return this.pending().some((d) => d.key.startsWith(prefix));
  }

  /** The page was left: its drafts are dropped (a commit still out finishes and forgets). */
  discardPage(pageId: string): void {
    const prefix = `${pageId}#`;
    for (const [key, held] of [...this.#drafts]) {
      if (!key.startsWith(prefix)) continue;
      if (held.draft.discard()) {
        held.off();
        this.#drafts.delete(key);
      }
    }
    this.#emit();
  }

  /** Everything, as the account changes or the app closes. */
  clear(): void {
    for (const held of this.#drafts.values()) {
      held.draft.discard();
      held.off();
    }
    this.#drafts.clear();
    this.#emit();
  }

  #emit(): void {
    this.#rev++;
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The local checks: a courtesy before the ERP's own, never a permission

/**
 * What the ERP would say of a change to `field` (its code), or null when it looks right. Only
 * changed fields are checked, so a record may keep an old inactive code.
 */
export function localProblem(
  field: FieldSchema,
  schema: ConnectorSchema,
  value: WireValue,
): CommitErrorCode | null {
  if (!field.editable) return 'field.readOnly';
  if (value === null || value === '') return field.required ? 'required' : null;
  if (field.type === 'decimal' && typeof value === 'string' && isDecimal(value, 64)) {
    if (!isDecimal(value, field.scale ?? 0)) return 'scale';
  } else if (valueProblem(field, value) !== null) return 'type';
  if (field.maxLength !== undefined && typeof value === 'string' && value.length > field.maxLength)
    return 'maxLength';
  if (outOfRange(field, value)) return 'range';
  if (field.type === 'lookup') {
    const items = field.lookup ? schema.lookups[field.lookup] : undefined;
    const item = items?.find((i) => i.code === value);
    if (!item || item.active === false) return 'lookup.notFound';
  }
  return null;
}

function outOfRange(field: FieldSchema, value: WireValue): boolean {
  const below = (bound: string | number | undefined, sign: 1 | -1) => {
    if (bound === undefined) return false;
    const order = compareBound(field, value, bound);
    return order !== null && order * sign < 0;
  };
  return below(field.min, 1) || below(field.max, -1);
}

/** `value` against a bound: negative when smaller, null when they cannot be compared. */
function compareBound(field: FieldSchema, value: WireValue, bound: string | number): number | null {
  if (field.type === 'integer' && typeof value === 'number' && typeof bound === 'number') {
    return value - bound;
  }
  if (field.type === 'date' && typeof value === 'string' && typeof bound === 'string') {
    return value < bound ? -1 : value > bound ? 1 : 0;
  }
  if (field.type === 'decimal' && typeof value === 'string' && typeof bound === 'string') {
    return compareDecimals(value, bound);
  }
  return null;
}

function compareDecimals(a: string, b: string): number {
  const parse = (text: string) => {
    const negative = text.startsWith('-');
    const [whole, fraction = ''] = text.replace('-', '').split('.');
    return { negative, whole: whole!, fraction };
  };
  const x = parse(a);
  const y = parse(b);
  const width = Math.max(x.fraction.length, y.fraction.length);
  const big = (p: ReturnType<typeof parse>) =>
    BigInt(p.whole + p.fraction.padEnd(width, '0')) * (p.negative ? -1n : 1n);
  const d = big(x) - big(y);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/** Arabic-Indic digits and separators as ASCII, grouping dropped: what a person types. */
function asciiNumber(text: string): string {
  let out = '';
  for (const ch of text.trim()) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    // The Arabic decimal separator.
    else if (code === 0x066b) out += '.';
    // The Arabic thousands separator, a comma, a space.
    else if (code === 0x066c || ch === ',' || ch === ' ') continue;
    // The minus sign.
    else if (code === 0x2212) out += '-';
    else out += ch;
  }
  return out;
}

export type ParsedInput =
  | { readonly ok: true; readonly value: WireValue }
  | { readonly ok: false; readonly problem: 'type' | 'scale' };

/** What a person typed into a cell's editor, as the wire value it stands for. */
export function parseInput(field: FieldSchema, text: string): ParsedInput {
  if (field.type === 'text') return { ok: true, value: text === '' ? null : text };
  if (text.trim() === '') return { ok: true, value: null };
  switch (field.type) {
    case 'lookup':
    case 'date':
    case 'dateTime':
      return { ok: true, value: text };
    case 'boolean':
      return text === 'true' || text === 'false'
        ? { ok: true, value: text === 'true' }
        : { ok: false, problem: 'type' };
    case 'integer': {
      const n = asciiNumber(text);
      return /^-?\d{1,15}$/.test(n) && Number.isSafeInteger(Number(n))
        ? { ok: true, value: Number(n) }
        : { ok: false, problem: 'type' };
    }
    case 'decimal': {
      let n = asciiNumber(text);
      if (n.startsWith('.')) n = `0${n}`;
      if (n.startsWith('-.')) n = `-0${n.slice(1)}`;
      n = n.replace(/^(-?)0+(?=\d)/, '$1');
      if (!isDecimal(n, 64)) return { ok: false, problem: 'type' };
      return isDecimal(n, field.scale ?? 0)
        ? { ok: true, value: n }
        : { ok: false, problem: 'scale' };
    }
  }
}
