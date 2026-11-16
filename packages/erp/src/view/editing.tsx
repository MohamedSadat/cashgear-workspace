// Changing ERP data in a block (Phase 7, INTEGRATIONS.md, "Level 2: editable ERP blocks"): the
// cells' editors, the bar with the count and "Review changes", the review screen (every field's
// old and new value and every error the ERP gave), the conflict screen (theirs beside the
// person's, per field), and "Prepare changes with AI". What is changed lives in the block's draft
// (`ErpDraft`), in memory only; the ERP decides what may be changed and checks every value.
import { CgButton } from '@cashgear/ui';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { ErpAiAssist } from '../ai';
import type {
  ApiError,
  CommitConflict,
  ConnectorSchema,
  ErpError,
  ErpRecord,
  FieldSchema,
  Language,
  WireValue,
} from '../contract';
import {
  localProblem,
  parseInput,
  type DraftCommitApi,
  type DraftPhase,
  type ErpDraft,
} from '../drafts';
import { useErpT, type ErpKey, type ErpT } from '../i18n';
import { AI_MAX_INSTRUCTION, applyProposals, buildAiRequest } from './aiPrepare';
import { cellText } from './format';
import { errorText } from './Message';
import { CellBody } from './RecordsTable';
import { labelOf } from './settings';

const PROBLEM_KEYS: Readonly<Record<string, ErpKey>> = {
  required: 'problemRequired',
  maxLength: 'problemMaxLength',
  type: 'problemType',
  range: 'problemRange',
  scale: 'problemScale',
  'lookup.notFound': 'problemLookup',
  'field.readOnly': 'problemReadOnly',
  'privilege.denied': 'problemPrivilege',
  'record.notFound': 'problemNotFound',
  'record.locked': 'problemLocked',
  'version.missing': 'problemVersion',
};

/** What an ERP error code on a field or record says; the ERP's own message is never shown. */
export const problemText = (t: ErpT, code: string) => t(PROBLEM_KEYS[code] ?? 'problemOther');

/** A value as words, for labels and the review: a boolean as yes or no, empty as "empty". */
export function plainValue(
  field: FieldSchema | undefined,
  value: WireValue | undefined,
  schema: ConnectorSchema,
  locale: string,
  t: ErpT,
): string {
  if (value === null || value === undefined || value === '') return t('emptyCell');
  if (!field) return String(value);
  const shown = cellText(field, value, schema, locale);
  switch (shown.kind) {
    case 'empty':
      return t('emptyCell');
    case 'boolean':
      return t(shown.value ? 'yes' : 'no');
    case 'dateTime':
      return `${shown.when} ${shown.offset}`;
    case 'text':
      return shown.text;
  }
}

const formatTime = (iso: string | null, locale: string) =>
  iso
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(iso),
      )
    : '';

// ---------------------------------------------------------------------------------------------
// A cell

export function EditableCell({
  field,
  record,
  schema,
  draft,
  locale,
  language,
  disabled,
  numeric,
}: {
  field: FieldSchema;
  record: ErpRecord;
  schema: ConnectorSchema;
  draft: ErpDraft;
  locale: string;
  language: Language;
  disabled: boolean;
  numeric: boolean;
}) {
  const { t } = useErpT();
  const [editing, setEditing] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      button.current?.focus();
    }
  }, [editing]);
  const change = draft.record(record.id)?.changes[field.name];
  const value = change ? change.to : (record.values[field.name] ?? null);
  const label = labelOf(field, language);
  const className =
    [numeric ? 'cgw-erp-num' : '', change ? 'cgw-erp-changed' : ''].filter(Boolean).join(' ') ||
    undefined;
  if (editing && !disabled) {
    return (
      <td className={className} data-field={field.name}>
        <CellEditor
          field={field}
          schema={schema}
          value={value}
          label={label}
          onDone={(next) => {
            refocus.current = true;
            setEditing(false);
            if (next !== undefined) draft.set(record, field.name, next);
          }}
        />
      </td>
    );
  }
  return (
    <td
      className={className}
      data-field={field.name}
      data-changed={change ? (change.byAi ? 'ai' : 'person') : undefined}
      title={
        change
          ? t('wasValue', { value: plainValue(field, change.from, schema, locale, t) })
          : undefined
      }
    >
      <button
        ref={button}
        type="button"
        className="cgw-erp-cell"
        disabled={disabled}
        aria-label={t('editCell', {
          field: label,
          value: plainValue(field, value, schema, locale, t),
        })}
        onClick={() => setEditing(true)}
      >
        <CellBody field={field} value={value} schema={schema} locale={locale} />
      </button>
      {change && (
        <span className="cgw-erp-hidden">{` ${t(change.byAi ? 'changedByAi' : 'changed')}`}</span>
      )}
    </td>
  );
}

function CellEditor({
  field,
  schema,
  value,
  label,
  onDone,
}: {
  field: FieldSchema;
  schema: ConnectorSchema;
  value: WireValue;
  label: string;
  /** The new value, or undefined when the person left it as it was. */
  onDone: (next: WireValue | undefined) => void;
}) {
  const { t } = useErpT();
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const problemId = `${id}-problem`;
  const finish = (raw: string): boolean => {
    const parsed = parseInput(field, raw);
    if (!parsed.ok) {
      setProblem(problemText(t, parsed.problem));
      return false;
    }
    const code = localProblem(field, schema, parsed.value);
    if (code) {
      setProblem(problemText(t, code));
      return false;
    }
    onDone(parsed.value);
    return true;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onDone(undefined);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      finish(event.currentTarget.value);
    }
  };
  const common = {
    id,
    className: 'cgw-erp-input cgw-erp-cell-input',
    'aria-label': t('cellEditor', { field: label }),
    'aria-invalid': problem ? true : undefined,
    'aria-describedby': problem ? problemId : undefined,
    autoFocus: true,
    onKeyDown,
  } as const;
  let control;
  if (field.type === 'lookup' || field.type === 'boolean') {
    const current = value === null ? '' : String(value);
    const options =
      field.type === 'boolean'
        ? [
            { code: 'true', label: t('yes'), inactive: false },
            { code: 'false', label: t('no'), inactive: false },
          ]
        : (field.lookup ? (schema.lookups[field.lookup] ?? []) : []).map((item) => ({
            code: item.code,
            label: item.label || item.code,
            inactive: item.active === false,
          }));
    const known = current === '' || options.some((o) => o.code === current);
    control = (
      <select
        {...common}
        defaultValue={current}
        onChange={(event) => finish(event.currentTarget.value)}
        onBlur={() => onDone(undefined)}
      >
        {(!field.required || current === '') && <option value="">{t('emptyValue')}</option>}
        {!known && (
          <option value={current} disabled>
            {current}
          </option>
        )}
        {options.map((o) => (
          <option key={o.code} value={o.code} disabled={o.inactive}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <input
        {...common}
        type={field.type === 'date' ? 'date' : 'text'}
        inputMode={
          field.type === 'integer' ? 'numeric' : field.type === 'decimal' ? 'decimal' : undefined
        }
        dir={field.type === 'text' ? 'auto' : 'ltr'}
        defaultValue={value === null ? '' : String(value)}
        maxLength={field.type === 'text' ? field.maxLength : undefined}
        // Leaving the editor keeps a valid value; an invalid one stays, with what is wrong.
        onBlur={(event) => void finish(event.currentTarget.value)}
      />
    );
  }
  return (
    <span className="cgw-erp-cell-edit">
      {control}
      {problem && (
        <span id={problemId} className="cgw-erp-invalid" role="alert">
          {problem}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// The bar

export function EditBar({
  draft,
  schema,
  api,
  aiOpen,
  onAi,
}: {
  draft: ErpDraft;
  schema: ConnectorSchema;
  api: DraftCommitApi;
  aiOpen: boolean;
  /** Opens "Prepare changes with AI"; absent when the shell offers no AI. */
  onAi?: () => void;
}) {
  const { t, locale } = useErpT();
  const phase = draft.phase();
  const count = draft.changeCount();
  const tooMany = draft.records().length > schema.maxCommitRecords;
  const locked = draft.locked();
  return (
    <div
      className="cgw-erp-editbar"
      role="group"
      aria-label={t('editing')}
      data-testid="erp-editbar"
    >
      <span className="cgw-erp-muted" data-testid="erp-change-count">
        {count ? t('changesCount', { count }) : t('noChanges')}
      </span>
      <CgButton
        intent="primary"
        size="small"
        disabled={!count || locked || tooMany}
        onClick={() => void draft.review(api, schema)}
      >
        {t('reviewChanges')}
      </CgButton>
      <CgButton
        appearance="ghost"
        size="small"
        disabled={!count || locked}
        onClick={() => void draft.discard()}
      >
        {t('discardChanges')}
      </CgButton>
      {onAi && (
        <CgButton
          appearance={aiOpen ? 'soft' : 'ghost'}
          intent={aiOpen ? 'primary' : undefined}
          size="small"
          aria-expanded={aiOpen}
          disabled={locked}
          onClick={onAi}
        >
          {t('aiPrepare')}
        </CgButton>
      )}
      {tooMany && (
        <span className="cgw-erp-note">
          {t('tooManyChanges', { max: schema.maxCommitRecords })}
        </span>
      )}
      {phase.kind === 'committed' && (
        <span role="status" className="cgw-erp-done" data-testid="erp-committed">
          {t('committed', {
            time: formatTime(phase.response.committedAt, locale),
            count: phase.changes,
          })}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The review

/** Whether the phase is shown on the review screen in place of the table. */
export const reviewing = (phase: DraftPhase) =>
  phase.kind === 'reviewing' ||
  phase.kind === 'reviewed' ||
  phase.kind === 'invalid' ||
  phase.kind === 'committing' ||
  phase.kind === 'unknown' ||
  phase.kind === 'failed';

function failText(t: ErpT, error: ErpError, max: number): string {
  switch (error.code) {
    case 'privilege.denied':
      return t('commitNoPrivilege');
    case 'schema.changed':
      return t('commitSchemaChanged');
    case 'batch.tooLarge':
      return t('commitTooMany', { max });
    case 'commit.reused':
    case 'request.invalid':
      return t('commitRefused');
    default:
      return errorText(t, error, { context: 'read' });
  }
}

interface Row {
  readonly id: string;
  readonly key: string;
  readonly field: string;
  readonly from: WireValue;
  readonly to: WireValue;
}

export function ReviewPanel({
  draft,
  schema,
  api,
  language,
}: {
  draft: ErpDraft;
  schema: ConnectorSchema;
  api: DraftCommitApi;
  language: Language;
}) {
  const { t, locale } = useErpT();
  const heading = useId();
  const phase = draft.phase();
  const request = 'request' in phase ? phase.request : null;
  const rows: Row[] = request
    ? request.records.flatMap((r) =>
        Object.entries(r.changes).map(([field, c]) => ({ id: r.id, key: r.key, field, ...c })),
      )
    : draft.records().flatMap((r) =>
        Object.entries(r.changes).map(([field, c]) => ({
          id: r.id,
          key: r.key,
          field,
          from: c.from,
          to: c.to,
        })),
      );
  const errors: readonly ApiError[] = phase.kind === 'invalid' ? phase.errors : [];
  const byField = new Map<string, string[]>();
  const byRecord = new Map<string, string[]>();
  for (const e of errors) {
    if (e.id === undefined) continue;
    const at = e.field === undefined ? byRecord : byField;
    const slot = e.field === undefined ? e.id : `${e.field}|${e.id}`;
    at.set(slot, [...(at.get(slot) ?? []), e.code]);
  }
  const saved =
    phase.kind === 'reviewed' ? new Map(phase.response.records.map((r) => [r.id, r.values])) : null;
  const fields = new Map(schema.fields.map((f) => [f.name, f]));
  const busy = phase.kind === 'reviewing' || phase.kind === 'committing';
  const count = rows.length;

  let title = t('reviewTitle');
  let intro: string | null = null;
  if (phase.kind === 'reviewing') title = t('reviewChecking');
  else if (phase.kind === 'reviewed') intro = t('reviewIntro');
  else if (phase.kind === 'invalid') intro = t('reviewInvalid');
  else if (phase.kind === 'committing') title = t(phase.checking ? 'checkingCommit' : 'committing');
  else if (phase.kind === 'unknown')
    intro = t(phase.reconnect ? 'commitUnknownReconnect' : 'commitUnknown');
  else if (phase.kind === 'failed') intro = failText(t, phase.error, schema.maxCommitRecords);
  const reference =
    phase.kind === 'failed' || phase.kind === 'unknown' ? phase.error.correlationId : null;

  return (
    <section
      className="cgw-erp-review"
      aria-labelledby={heading}
      aria-busy={busy || undefined}
      data-testid="erp-review"
      data-phase={phase.kind}
    >
      <h3 id={heading} className="cgw-erp-review-title">
        {title}
      </h3>
      {intro && (
        <p className={phase.kind === 'reviewed' ? 'cgw-erp-muted' : 'cgw-erp-note'} role="status">
          {intro}
        </p>
      )}
      {reference && (
        <p className="cgw-erp-muted cgw-erp-reference">{t('reference', { id: reference })}</p>
      )}
      <div className="cgw-erp-scroll" role="group" tabIndex={0} aria-labelledby={heading}>
        <table className="cgw-erp-table cgw-erp-review-table" data-testid="erp-review-table">
          <thead>
            <tr>
              <th scope="col">{t('columnRecord')}</th>
              <th scope="col">{t('columnField')}</th>
              <th scope="col">{t('columnBefore')}</th>
              <th scope="col">{t('columnAfter')}</th>
              {errors.length > 0 && <th scope="col">{t('columnProblem')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const field = fields.get(row.field);
              const after = saved?.get(row.id)?.[row.field];
              const codes = [
                ...(byField.get(`${row.field}|${row.id}`) ?? []),
                ...(byRecord.get(row.id) ?? []),
              ];
              const byAi = draft.record(row.id)?.changes[row.field]?.byAi;
              return (
                <tr
                  key={`${row.field}|${row.id}`}
                  data-key={row.key}
                  data-field={row.field}
                  data-problem={codes[0]}
                >
                  <th scope="row">
                    <span dir="auto">{row.key}</span>
                  </th>
                  <td>
                    <span dir="auto">{field ? labelOf(field, language) : row.field}</span>
                    {byAi && <span className="cgw-erp-tag">{` ${t('changedByAi')}`}</span>}
                  </td>
                  <td>
                    <span dir="auto">{plainValue(field, row.from, schema, locale, t)}</span>
                  </td>
                  <td>
                    <span dir="auto">
                      {plainValue(field, after !== undefined ? after : row.to, schema, locale, t)}
                    </span>
                  </td>
                  {errors.length > 0 && (
                    <td className={codes.length ? 'cgw-erp-invalid' : undefined}>
                      {codes.map((code) => problemText(t, code)).join(' ')}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="cgw-erp-actions">
        {phase.kind === 'reviewed' && (
          <CgButton intent="primary" onClick={() => void draft.commit(api, schema)}>
            {t('commitChanges', { count })}
          </CgButton>
        )}
        {phase.kind === 'unknown' && !phase.reconnect && (
          <CgButton intent="primary" onClick={() => void draft.resume(api, schema)}>
            {t('retry')}
          </CgButton>
        )}
        {(phase.kind === 'reviewed' || phase.kind === 'invalid' || phase.kind === 'failed') && (
          <CgButton appearance="outline" onClick={() => draft.back()}>
            {t('backToEditing')}
          </CgButton>
        )}
        {phase.kind === 'unknown' && (
          <CgButton appearance="ghost" onClick={() => void draft.discard()}>
            {t('discardChanges')}
          </CgButton>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// A conflict

type Choices = Map<string, Map<string, 'mine' | 'theirs'>>;

export function ConflictPanel({
  draft,
  schema,
  language,
}: {
  draft: ErpDraft;
  schema: ConnectorSchema;
  language: Language;
}) {
  const { t, locale } = useErpT();
  const heading = useId();
  const names = useId();
  const [choices, setChoices] = useState<Choices>(() => new Map());
  const phase = draft.phase();
  if (phase.kind !== 'conflict') return null;
  const fields = new Map(schema.fields.map((f) => [f.name, f]));
  const choose = (id: string, field: string, choice: 'mine' | 'theirs') =>
    setChoices((now) => {
      const next: Choices = new Map(now);
      next.set(id, new Map(next.get(id)).set(field, choice));
      return next;
    });
  const needed = (c: CommitConflict) =>
    Object.keys(draft.record(c.id)?.changes ?? {}).filter((f) => c.fields.includes(f));
  const complete = phase.conflicts.every((c) => needed(c).every((f) => choices.get(c.id)?.has(f)));
  const allTheirs = () => {
    const all: Choices = new Map();
    for (const c of phase.conflicts) {
      all.set(
        c.id,
        new Map(Object.keys(draft.record(c.id)?.changes ?? {}).map((f) => [f, 'theirs' as const])),
      );
    }
    draft.resolve(all);
  };
  return (
    <section
      className="cgw-erp-review cgw-erp-conflicts"
      aria-labelledby={heading}
      data-testid="erp-conflicts"
    >
      <h3 id={heading} className="cgw-erp-review-title">
        {t('conflictTitle')}
      </h3>
      <p className="cgw-erp-note" role="status">
        {t('conflictIntro')}
      </p>
      {phase.conflicts.map((c, ci) => {
        const record = draft.record(c.id);
        if (!record) return null;
        return (
          <fieldset key={c.id} className="cgw-erp-conflict" data-key={c.key}>
            <legend>
              <span dir="auto">{t('conflictRecord', { key: c.key })}</span>
              {c.modifiedBy && (
                <span className="cgw-erp-muted">
                  {' '}
                  {t('conflictBy', {
                    name: c.modifiedBy,
                    time: formatTime(c.modifiedAt, locale),
                  })}
                </span>
              )}
            </legend>
            <table className="cgw-erp-table">
              <thead>
                <tr>
                  <th scope="col">{t('columnField')}</th>
                  <th scope="col">{t('columnYours')}</th>
                  <th scope="col">{t('columnTheirs')}</th>
                  <th scope="col">{t('columnKeep')}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(record.changes).map(([name, change], fi) => {
                  const field = fields.get(name);
                  const label = field ? labelOf(field, language) : name;
                  const theirs = Object.prototype.hasOwnProperty.call(c.values, name)
                    ? c.values[name]
                    : change.from;
                  const choice = choices.get(c.id)?.get(name);
                  const group = `${names}-${ci}-${fi}`;
                  return (
                    <tr key={name} data-field={name}>
                      <th scope="row">
                        <span dir="auto">{label}</span>
                      </th>
                      <td>
                        <span dir="auto">{plainValue(field, change.to, schema, locale, t)}</span>
                      </td>
                      <td>
                        <span dir="auto">{plainValue(field, theirs, schema, locale, t)}</span>
                      </td>
                      <td>
                        {c.fields.includes(name) ? (
                          <span
                            role="radiogroup"
                            className="cgw-erp-choice"
                            aria-label={t('keepChoice', { field: label })}
                          >
                            <label>
                              <input
                                type="radio"
                                name={group}
                                value="mine"
                                checked={choice === 'mine'}
                                onChange={() => choose(c.id, name, 'mine')}
                              />{' '}
                              {t('keepMine')}
                            </label>
                            <label>
                              <input
                                type="radio"
                                name={group}
                                value="theirs"
                                checked={choice === 'theirs'}
                                onChange={() => choose(c.id, name, 'theirs')}
                              />{' '}
                              {t('keepTheirs')}
                            </label>
                          </span>
                        ) : (
                          <span className="cgw-erp-muted">{t('conflictUnchanged')}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </fieldset>
        );
      })}
      <div className="cgw-erp-actions">
        <CgButton intent="primary" disabled={!complete} onClick={() => void draft.resolve(choices)}>
          {t('applyChoices')}
        </CgButton>
        <CgButton appearance="outline" onClick={allTheirs}>
          {t('takeAllTheirs')}
        </CgButton>
        <CgButton appearance="ghost" onClick={() => draft.back()}>
          {t('backToEditing')}
        </CgButton>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// AI

type AiState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly controller: AbortController }
  | { readonly kind: 'done'; readonly applied: number; readonly skipped: number }
  | { readonly kind: 'failed' };

export function AiPreparePanel({
  ai,
  draft,
  schema,
  records,
  language,
  onClose,
  onPrepared,
}: {
  ai: ErpAiAssist;
  draft: ErpDraft;
  schema: ConnectorSchema;
  /** The records on screen, as read. */
  records: readonly ErpRecord[];
  language: Language;
  onClose: () => void;
  /** Proposals landed in the pending list: the cells open for review. */
  onPrepared: () => void;
}) {
  const { t } = useErpT();
  const id = useId();
  const [text, setText] = useState('');
  const [state, setState] = useState<AiState>({ kind: 'idle' });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const busy = state.kind === 'busy';
  const run = async () => {
    const current = new AbortController();
    controller.current = current;
    setState({ kind: 'busy', controller: current });
    try {
      const proposals = await ai.prepare(buildAiRequest(text, schema, records, language), {
        signal: current.signal,
      });
      if (current.signal.aborted) return;
      const { applied, skipped } = applyProposals(draft, proposals, records, schema);
      setState({ kind: 'done', applied, skipped });
      if (applied) onPrepared();
    } catch {
      if (current.signal.aborted) setState({ kind: 'idle' });
      else setState({ kind: 'failed' });
    } finally {
      if (controller.current === current) controller.current = null;
    }
  };
  const status =
    state.kind === 'busy'
      ? t('aiPreparing')
      : state.kind === 'failed'
        ? t('aiFailed')
        : state.kind === 'done'
          ? [
              state.applied ? t('aiPrepared', { count: state.applied }) : t('aiNone'),
              state.skipped ? t('aiSkipped', { count: state.skipped }) : '',
            ]
              .filter(Boolean)
              .join(' ')
          : '';
  return (
    <div className="cgw-erp-panel cgw-erp-ai" data-testid="erp-ai">
      <label htmlFor={id}>{t('aiInstruction')}</label>
      <textarea
        id={id}
        className="cgw-erp-input cgw-erp-textarea"
        rows={3}
        dir="auto"
        maxLength={AI_MAX_INSTRUCTION}
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
      />
      <p className="cgw-erp-muted">{t('aiNote')}</p>
      <div className="cgw-erp-actions">
        <CgButton
          intent="primary"
          size="small"
          disabled={busy || !text.trim() || draft.locked() || records.length === 0}
          onClick={() => void run()}
        >
          {t('aiRun')}
        </CgButton>
        <CgButton
          appearance="ghost"
          size="small"
          onClick={() => (busy ? controller.current?.abort() : onClose())}
        >
          {busy ? t('cancel') : t('close')}
        </CgButton>
      </div>
      <p className="cgw-erp-muted" role="status" data-testid="erp-ai-status">
        {status}
      </p>
    </div>
  );
}
