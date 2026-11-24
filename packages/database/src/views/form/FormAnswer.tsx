// A form answered in the app (Phase 16, M16.1): its pages one at a time, each page's answers
// checked by the form rules (`checkAnswers`, the server's too) before the next page shown by the
// conditions, then the answer given to `onSubmit` (a row added through the outbox, offline too).
// Every question type the app asks: text, numbers, options, dates, a checkbox, links, people,
// files and related rows. The editor's preview draws the same.
import { CgButton } from '@cashgear/ui';
import { checkAnswers, nextPage, previousPage } from '@cgw/workspace/forms';
import type { Id } from '@cgw/workspace';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  DatabaseRecord,
  FormAnswer as Answer,
  FormConfig,
  FormProblem,
  FormQuestion,
  PropertyDef,
  PropertyId,
} from '../../core';
import { useDatabaseContext } from '../../context';
import type { RowRef } from '../../host';
import { propertyOf } from '../../model/properties';
import { useFormT, type FormT } from './words';

export interface FormAnswerProps {
  database: DatabaseRecord;
  form: FormConfig;
  /** The form's title as shown (its own, else the view's name). */
  title: string;
  /** Read only: the person cannot add rows here (the form is drawn, nothing is sent). */
  disabled: boolean;
  onSubmit(answer: Answer): Promise<void>;
}

type Raw = Record<PropertyId, unknown>;

/** A date and time typed on this device as the UTC instant a date property holds. */
function instant(local: string): string | null {
  if (!local) return null;
  const at = new Date(local);
  return Number.isNaN(at.getTime()) ? local : at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The other way: an instant as a `datetime-local` input shows it on this device. */
function localOf(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function Paragraphs({ text, className }: { text: string; className?: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((part, i) => (
        <p key={i} className={className} dir="auto">
          {part}
        </p>
      ))}
    </>
  );
}

interface QuestionProps {
  def: PropertyDef;
  question: FormQuestion;
  value: unknown;
  problem: string | undefined;
  disabled: boolean;
  onChange(value: unknown): void;
  ft: FormT;
}

function Question({ def, question, value, problem, disabled, onChange, ft }: QuestionProps) {
  const { host } = useDatabaseContext();
  const id = useId();
  const label = question.label || def.name;
  const notes: ReactNode[] = [];
  const described: string[] = [];
  if (question.help) {
    described.push(`${id}-help`);
    notes.push(
      <p key="help" id={`${id}-help`} className="cgw-db-form-help" dir="auto">
        {question.help}
      </p>,
    );
  }
  if (problem) {
    described.push(`${id}-error`);
    notes.push(
      <p key="error" id={`${id}-error`} className="cgw-db-form-error">
        {ft(`answer.problems.${problem}`)}
      </p>,
    );
  }
  const common = {
    id,
    disabled,
    'aria-required': question.required || undefined,
    'aria-invalid': problem ? true : undefined,
    'aria-describedby': described.length ? described.join(' ') : undefined,
  } as const;
  const mark = question.required ? (
    <span className="cgw-db-form-mark" aria-hidden="true">
      *
    </span>
  ) : null;
  const options =
    def.type === 'select' || def.type === 'multiSelect' || def.type === 'status'
      ? (def.options ?? []).filter((o) => !question.options || question.options.includes(o.id))
      : [];

  if (def.type === 'checkbox')
    return (
      <div className="cgw-db-form-question" data-question={def.id}>
        {notes}
        <label className="cgw-db-form-check">
          <input
            type="checkbox"
            {...common}
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span dir="auto">{label}</span>
          {mark}
        </label>
      </div>
    );

  if (def.type === 'multiSelect' || def.type === 'person') {
    const chosen = Array.isArray(value) ? (value as string[]) : [];
    const choices =
      def.type === 'person'
        ? host.people().map((p) => ({ id: p.id, name: p.name }))
        : options.map((o) => ({ id: o.id, name: o.name }));
    return (
      <fieldset
        className="cgw-db-form-question"
        data-question={def.id}
        aria-describedby={common['aria-describedby']}
        aria-invalid={common['aria-invalid']}
      >
        <legend dir="auto">
          {label}
          {mark}
        </legend>
        {notes}
        {choices.map((choice) => (
          <label key={choice.id} className="cgw-db-form-check">
            <input
              type="checkbox"
              disabled={disabled}
              checked={chosen.includes(choice.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...chosen, choice.id]
                    : chosen.filter((c) => c !== choice.id),
                )
              }
            />
            <span dir="auto">{choice.name}</span>
          </label>
        ))}
      </fieldset>
    );
  }

  let control: ReactNode;
  switch (def.type) {
    case 'select':
    case 'status':
      control = (
        <select
          className="cgw-select"
          {...common}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">{ft('answer.choose')}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
      break;
    case 'text':
      control = (
        <textarea
          className="cgw-text-input cgw-db-form-area"
          rows={4}
          dir="auto"
          {...common}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
      );
      break;
    case 'date':
      control = def.date?.includeTime ? (
        <input
          type="datetime-local"
          className="cgw-text-input"
          {...common}
          value={localOf(value)}
          onChange={(event) => onChange(instant(event.target.value))}
        />
      ) : (
        <input
          type="date"
          className="cgw-text-input"
          {...common}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value || null)}
        />
      );
      break;
    case 'files':
      control = (
        <Files value={value} disabled={disabled} onChange={onChange} common={common} ft={ft} />
      );
      break;
    case 'relation':
      control = (
        <Related
          def={def}
          value={value}
          disabled={disabled}
          onChange={onChange}
          common={common}
          ft={ft}
        />
      );
      break;
    default: {
      const type =
        def.type === 'email'
          ? 'email'
          : def.type === 'url'
            ? 'url'
            : def.type === 'phone'
              ? 'tel'
              : 'text';
      control = (
        <input
          type={type}
          className="cgw-text-input"
          dir={def.type === 'title' ? 'auto' : undefined}
          inputMode={def.type === 'number' ? 'decimal' : undefined}
          {...common}
          value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    }
  }
  return (
    <div className="cgw-db-form-question" data-question={def.id}>
      <label htmlFor={id} dir="auto">
        {label}
        {mark}
      </label>
      {notes}
      {control}
    </div>
  );
}

interface PartProps {
  value: unknown;
  disabled: boolean;
  onChange(value: unknown): void;
  common: { id: string; 'aria-describedby'?: string };
  ft: FormT;
}

/** Files: picked and kept on the device (uploaded with the row), listed with a way to take one off. */
function Files({ value, disabled, onChange, common, ft }: PartProps) {
  const { host } = useDatabaseContext();
  const ids = Array.isArray(value) ? (value as Id[]) : [];
  const assets = host.assets;
  return (
    <div className="cgw-db-form-files">
      <CgButton
        id={common.id}
        appearance="outline"
        size="small"
        disabled={disabled || !assets}
        aria-describedby={common['aria-describedby']}
        onClick={async () => {
          if (!assets) return;
          const files = await assets.pick([]);
          const stored: Id[] = [];
          for (const file of files) {
            const kept = await assets.store(file);
            if (kept) stored.push(kept.assetId);
          }
          if (stored.length) onChange([...ids, ...stored]);
        }}
      >
        {ft('answer.addFiles')}
      </CgButton>
      {ids.length ? (
        <ul className="cgw-db-form-chosen">
          {ids.map((id) => {
            const name = assets?.info(id)?.fileName ?? id;
            return (
              <li key={id}>
                <span dir="auto">{name}</span>
                <button
                  type="button"
                  className="cgw-text-button"
                  disabled={disabled}
                  onClick={() => onChange(ids.filter((i) => i !== id))}
                >
                  {ft('answer.removeFile', { name })}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** Related rows: found by their titles in the related database, chosen, listed. */
function Related({ def, value, disabled, onChange, common, ft }: PartProps & { def: PropertyDef }) {
  const { host } = useDatabaseContext();
  const ids = Array.isArray(value) ? (value as Id[]) : [];
  const target = def.relation?.databaseId ?? null;
  const targetName = (target && host.pageTitle(target)) || def.name;
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<RowRef[]>([]);
  useEffect(() => {
    if (!target || !query.trim()) {
      setFound([]);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      host
        .searchRows(target, query, { limit: 8, signal: abort.signal })
        .then(setFound, () => setFound([]));
    }, 200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [host, target, query]);
  return (
    <div className="cgw-db-form-related">
      <input
        type="search"
        className="cgw-text-input"
        dir="auto"
        {...common}
        disabled={disabled || !target}
        aria-label={ft('answer.search', { name: targetName })}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {found.length ? (
        <ul className="cgw-db-form-found">
          {found
            .filter((r) => !ids.includes(r.id))
            .map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="cgw-text-button"
                  onClick={() => {
                    onChange([...ids, r.id]);
                    setQuery('');
                  }}
                >
                  {ft('answer.add', { name: r.title || r.id })}
                </button>
              </li>
            ))}
        </ul>
      ) : null}
      {ids.length ? (
        <ul className="cgw-db-form-chosen">
          {ids.map((id) => {
            const name = host.pageTitle(id) || id;
            return (
              <li key={id}>
                <span dir="auto">{name}</span>
                <button
                  type="button"
                  className="cgw-text-button"
                  disabled={disabled}
                  onClick={() => onChange(ids.filter((i) => i !== id))}
                >
                  {ft('answer.removeRow', { name })}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export function FormAnswer({ database, form, title, disabled, onSubmit }: FormAnswerProps) {
  const { host } = useDatabaseContext();
  const { ft } = useFormT();
  const ctx = useMemo(() => host.queryContext(), [host]);
  const [raw, setRaw] = useState<Raw>({});
  const [page, setPage] = useState<number | null>(() => nextPage(form, database, {}, ctx, -1));
  const [problems, setProblems] = useState<FormProblem[]>([]);
  const [done, setDone] = useState(false);
  const [sending, setSending] = useState(false);
  const summary = useRef<HTMLDivElement>(null);

  // The form changed under it (its questions edited): a page it no longer has is the first again.
  const current = page === null ? null : form.pages[page];
  useEffect(() => {
    if (page !== null && !form.pages[page]) setPage(nextPage(form, database, raw, ctx, -1));
    if (page === null && form.pages.length) setPage(nextPage(form, database, raw, ctx, -1));
  }, [form, database, raw, ctx, page]);
  useEffect(() => {
    if (problems.length) summary.current?.focus();
  }, [problems]);

  if (done)
    return (
      <div className="cgw-db-form-answer cgw-db-form-done" role="status">
        <h2 className="cgw-db-form-title" dir="auto">
          {title}
        </h2>
        <Paragraphs text={form.thanks || ft('answer.thanks')} />
        <CgButton
          appearance="outline"
          onClick={() => {
            setRaw({});
            setProblems([]);
            setPage(nextPage(form, database, {}, ctx, -1));
            setDone(false);
          }}
        >
          {ft('answer.again')}
        </CgButton>
      </div>
    );

  if (page === null || !current)
    return (
      <div className="cgw-db-form-answer">
        <h2 className="cgw-db-form-title" dir="auto">
          {title}
        </h2>
        <p className="cgw-db-form-note">{ft('answer.nothing')}</p>
      </div>
    );

  const shown = current.questions
    .map((question) => ({ question, def: propertyOf(database, question.propertyId) }))
    .filter((q): q is { question: FormQuestion; def: PropertyDef } => !!q.def && !q.def.trashedAt);
  const problemOf = new Map(problems.map((p) => [p.propertyId, p.reason] as const));
  const previous = previousPage(form, database, raw, ctx, page);
  const last = nextPage(form, database, raw, ctx, page) === null;

  const go = async () => {
    const check = checkAnswers(form, database, raw, ctx, last ? Infinity : page);
    if (!check.ok) {
      // The first page that asks a question refused (an earlier one, when a hidden answer is).
      const refused = new Set(check.problems.map((p) => p.propertyId));
      const at = form.pages.findIndex(
        (p, i) => i <= page && p.questions.some((q) => refused.has(q.propertyId)),
      );
      if (at >= 0 && at !== page) setPage(at);
      setProblems(check.problems);
      return;
    }
    setProblems([]);
    if (!last) {
      setPage(nextPage(form, database, raw, ctx, page));
      return;
    }
    setSending(true);
    try {
      await onSubmit(check.answer);
      setDone(true);
    } finally {
      setSending(false);
    }
  };

  const labelOf = (propertyId: PropertyId | null) => {
    const question = form.pages
      .flatMap((p) => p.questions)
      .find((q) => q.propertyId === propertyId);
    return question?.label || (propertyId && propertyOf(database, propertyId)?.name) || '';
  };

  return (
    <form
      className="cgw-db-form-answer"
      aria-label={title}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && !sending) void go();
      }}
    >
      <h2 className="cgw-db-form-title" dir="auto">
        {title}
      </h2>
      {form.description ? (
        <Paragraphs text={form.description} className="cgw-db-form-note" />
      ) : null}
      {disabled ? <p className="cgw-db-form-note">{ft('answer.cannot')}</p> : null}
      {current.title ? (
        <h3 className="cgw-db-form-page-title" dir="auto">
          {current.title}
        </h3>
      ) : null}
      {current.description ? <Paragraphs text={current.description} /> : null}
      {problems.length ? (
        <div className="cgw-db-form-problems" role="alert" tabIndex={-1} ref={summary}>
          <p>{ft('answer.check')}</p>
          <ul>
            {problems.map((p) => (
              <li key={`${p.propertyId}:${p.reason}`}>
                {p.propertyId ? `${labelOf(p.propertyId)}: ` : ''}
                {ft(`answer.problems.${p.reason}`)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {shown.some((q) => q.question.required) ? (
        <p className="cgw-db-form-note">{ft('answer.requiredNote')}</p>
      ) : null}
      {shown.map(({ question, def }) => (
        <Question
          key={def.id}
          def={def}
          question={question}
          value={raw[def.id]}
          problem={problemOf.get(def.id)}
          disabled={disabled}
          ft={ft}
          onChange={(value) => setRaw((r) => ({ ...r, [def.id]: value }))}
        />
      ))}
      <div className="cgw-db-form-actions">
        {previous !== null ? (
          <CgButton
            appearance="outline"
            disabled={sending}
            onClick={() => {
              setProblems([]);
              setPage(previous);
            }}
          >
            {ft('answer.back')}
          </CgButton>
        ) : null}
        <CgButton type="submit" intent="primary" disabled={disabled || sending}>
          {sending
            ? ft('answer.sending')
            : last
              ? form.submit || ft('answer.submit')
              : ft('answer.next')}
        </CgButton>
      </div>
    </form>
  );
}
