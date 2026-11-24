// A form's questions edited (Phase 16, M16.1): its title and description, its pages (each with a
// title, a description and the condition that shows it, over the questions asked before it) and
// their questions in order (the library's `CgSortableList`), each with its label, help, whether it
// is required and the options it shows; the thank-you text, the last button's words and the link's
// language. Words are written when a field is left, a switch at once; every change is the view's
// `view.upsert`, its properties following the questions.
import { CgButton, CgCheckBox, CgSortableList } from '@cashgear/ui';
import { useId, type ReactNode } from 'react';
import {
  LINK_QUESTION_TYPES,
  MAX_FORM_HELP,
  MAX_FORM_LABEL,
  MAX_FORM_PAGES,
  MAX_FORM_TEXT,
} from '@cgw/workspace/forms';
import {
  TITLE_PROPERTY,
  type DatabaseRecord,
  type FilterGroup,
  type FormConfig,
  type FormPage,
  type FormQuestion,
  type PropertyDef,
} from '../../core';
import { propertyOf } from '../../model/properties';
import { FilterEditor } from '../../toolbar/FilterEditor';
import { askable, askedIds, newPage, newQuestion } from './config';
import { useFormT, type FormT } from './words';

export interface FormBuilderProps {
  database: DatabaseRecord;
  form: FormConfig;
  onChange(form: FormConfig): void;
}

const EMPTY_GROUP: FilterGroup = { kind: 'group', op: 'and', children: [] };

/** A text field written when it is left (each key is not an operation). */
function Words({
  label,
  value,
  max,
  long,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string | null;
  max: number;
  long?: boolean;
  placeholder?: string;
  onCommit(value: string | null): void;
}) {
  const id = useId();
  const commit = (text: string) => {
    const next = text.trim() ? text : null;
    if (next !== value) onCommit(next);
  };
  return (
    <div className="cgw-db-form-field">
      <label className="cgw-label" htmlFor={id}>
        {label}
      </label>
      {long ? (
        <textarea
          id={id}
          key={value ?? ''}
          className="cgw-text-input cgw-db-form-area"
          rows={3}
          dir="auto"
          maxLength={max}
          placeholder={placeholder}
          defaultValue={value ?? ''}
          onBlur={(event) => commit(event.target.value)}
        />
      ) : (
        <input
          id={id}
          key={value ?? ''}
          className="cgw-text-input"
          dir="auto"
          maxLength={max}
          placeholder={placeholder}
          defaultValue={value ?? ''}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit(event.currentTarget.value);
            }
          }}
        />
      )}
    </div>
  );
}

function QuestionEditor({
  def,
  question,
  onChange,
  onRemove,
  ft,
}: {
  def: PropertyDef;
  question: FormQuestion;
  onChange(question: FormQuestion): void;
  onRemove(): void;
  ft: FormT;
}) {
  const options =
    def.type === 'select' || def.type === 'multiSelect' || def.type === 'status'
      ? (def.options ?? [])
      : null;
  const appOnly = !LINK_QUESTION_TYPES.includes(def.type);
  return (
    <fieldset className="cgw-db-form-edit-question" data-question={def.id}>
      <legend dir="auto">{def.name}</legend>
      <Words
        label={ft('builder.label')}
        value={question.label}
        max={MAX_FORM_LABEL}
        placeholder={def.name}
        onCommit={(label) => onChange({ ...question, label })}
      />
      <Words
        label={ft('builder.help')}
        value={question.help}
        max={MAX_FORM_HELP}
        onCommit={(help) => onChange({ ...question, help })}
      />
      <CgCheckBox
        label={ft('builder.required')}
        checked={question.required}
        onCheckedChange={(on) => onChange({ ...question, required: on === true })}
      />
      {options ? (
        <fieldset className="cgw-db-form-options">
          <legend>{ft('builder.options')}</legend>
          {options.map((o) => {
            const shown = !question.options || question.options.includes(o.id);
            return (
              <CgCheckBox
                key={o.id}
                label={o.name}
                checked={shown}
                onCheckedChange={(on) => {
                  const now = question.options ?? options.map((x) => x.id);
                  const next = on === true ? [...now, o.id] : now.filter((id) => id !== o.id);
                  // Every option shown is the same as none named: the property's later ones too.
                  onChange({
                    ...question,
                    options:
                      next.length === options.length
                        ? null
                        : options.map((x) => x.id).filter((id) => next.includes(id)),
                  });
                }}
              />
            );
          })}
        </fieldset>
      ) : null}
      {appOnly ? <p className="cgw-db-form-note">{ft('builder.appOnly')}</p> : null}
      <CgButton appearance="ghost" intent="danger" size="small" onClick={onRemove}>
        {ft('builder.remove', { name: question.label || def.name })}
      </CgButton>
    </fieldset>
  );
}

function PageEditor({
  database,
  form,
  index,
  onChange,
  ft,
}: {
  database: DatabaseRecord;
  form: FormConfig;
  index: number;
  onChange(form: FormConfig): void;
  ft: FormT;
}) {
  const page = form.pages[index];
  const setPage = (next: FormPage) =>
    onChange({ ...form, pages: form.pages.map((p, i) => (i === index ? next : p)) });
  const asked = new Set(askedIds(form));
  const free = askable(database).filter((p) => !asked.has(p.id));
  // A condition reads the questions asked before this page.
  const earlier = new Set(
    form.pages.slice(0, index).flatMap((p) => p.questions.map((q) => q.propertyId)),
  );
  const conditionDb = {
    ...database,
    properties: database.properties.filter((p) => earlier.has(p.id)),
  };
  const number = index + 1;
  const items = page.questions.flatMap((question) => {
    const def = propertyOf(database, question.propertyId);
    return def && !def.trashedAt ? [{ question, def }] : [];
  });
  let condition: ReactNode;
  if (index === 0) condition = null;
  else if (!earlier.size)
    condition = <p className="cgw-db-form-note">{ft('builder.conditionNone')}</p>;
  else if (!page.when)
    condition = (
      <CgButton
        appearance="ghost"
        size="small"
        onClick={() => setPage({ ...page, when: EMPTY_GROUP })}
      >
        {ft('builder.conditionAdd')}
      </CgButton>
    );
  else
    condition = (
      <div className="cgw-db-form-condition">
        <p className="cgw-label">{ft('builder.condition')}</p>
        <FilterEditor
          database={conditionDb}
          filter={page.when}
          editable
          onChange={(when) => setPage({ ...page, when: when ?? EMPTY_GROUP })}
        />
        <CgButton appearance="ghost" size="small" onClick={() => setPage({ ...page, when: null })}>
          {ft('builder.conditionClear')}
        </CgButton>
      </div>
    );
  return (
    <section
      className="cgw-db-form-edit-page"
      aria-label={ft('builder.page', { number })}
      data-form-page={index}
    >
      <div className="cgw-db-form-page-head">
        <h3>{ft('builder.page', { number })}</h3>
        {form.pages.length > 1 ? (
          <CgButton
            appearance="ghost"
            intent="danger"
            size="small"
            onClick={() => onChange({ ...form, pages: form.pages.filter((_, i) => i !== index) })}
          >
            {ft('builder.removePage', { number })}
          </CgButton>
        ) : null}
      </div>
      <Words
        label={ft('builder.pageTitle')}
        value={page.title}
        max={MAX_FORM_LABEL}
        onCommit={(title) => setPage({ ...page, title })}
      />
      <Words
        label={ft('builder.pageDescription')}
        value={page.description}
        max={MAX_FORM_TEXT}
        long
        onCommit={(description) => setPage({ ...page, description })}
      />
      {condition}
      {items.length ? (
        <CgSortableList
          className="cgw-db-form-questions"
          label={ft('builder.questions', { number })}
          items={items}
          getKey={(item) => item.def.id}
          handleLabel={(item) => ft('builder.move', { name: item.question.label || item.def.name })}
          onMove={(key, to) => {
            const list = [...page.questions];
            const from = list.findIndex((q) => q.propertyId === key);
            const [moved] = list.splice(from, 1);
            list.splice(to, 0, moved);
            setPage({ ...page, questions: list });
          }}
          renderItem={(item) => (
            <QuestionEditor
              def={item.def}
              question={item.question}
              ft={ft}
              onChange={(question) =>
                setPage({
                  ...page,
                  questions: page.questions.map((q) =>
                    q.propertyId === question.propertyId ? question : q,
                  ),
                })
              }
              onRemove={() =>
                setPage({
                  ...page,
                  questions: page.questions.filter((q) => q.propertyId !== item.def.id),
                })
              }
            />
          )}
        />
      ) : (
        <p className="cgw-db-form-note">{ft('builder.empty')}</p>
      )}
      {free.length ? (
        <label className="cgw-db-form-add">
          <span>{ft('builder.add')}</span>
          <select
            className="cgw-select"
            value=""
            onChange={(event) => {
              const id = event.target.value;
              if (id)
                setPage({
                  ...page,
                  questions: [...page.questions, newQuestion(id, id === TITLE_PROPERTY)],
                });
            }}
          >
            <option value="">{ft('answer.choose')}</option>
            {free.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="cgw-db-form-note">{ft('builder.addNone')}</p>
      )}
    </section>
  );
}

export function FormBuilder({ database, form, onChange }: FormBuilderProps) {
  const { ft } = useFormT();
  return (
    <div className="cgw-db-form-builder">
      <section className="cgw-db-form-edit-part" aria-label={ft('builder.form')}>
        <Words
          label={ft('builder.title')}
          value={form.title}
          max={MAX_FORM_LABEL}
          onCommit={(title) => onChange({ ...form, title })}
        />
        <Words
          label={ft('builder.description')}
          value={form.description}
          max={MAX_FORM_TEXT}
          long
          onCommit={(description) => onChange({ ...form, description })}
        />
      </section>
      {form.pages.map((_, index) => (
        <PageEditor
          key={index}
          database={database}
          form={form}
          index={index}
          onChange={onChange}
          ft={ft}
        />
      ))}
      {form.pages.length < MAX_FORM_PAGES ? (
        <CgButton
          appearance="outline"
          size="small"
          onClick={() => onChange({ ...form, pages: [...form.pages, newPage()] })}
        >
          {ft('builder.addPage')}
        </CgButton>
      ) : null}
      <section className="cgw-db-form-edit-part" aria-label={ft('builder.after')}>
        <h3>{ft('builder.after')}</h3>
        <Words
          label={ft('builder.thanks')}
          value={form.thanks}
          max={MAX_FORM_TEXT}
          long
          placeholder={ft('answer.thanks')}
          onCommit={(thanks) => onChange({ ...form, thanks })}
        />
        <Words
          label={ft('builder.submit')}
          value={form.submit}
          max={MAX_FORM_LABEL}
          placeholder={ft('answer.submit')}
          onCommit={(submit) => onChange({ ...form, submit })}
        />
        <label className="cgw-db-form-field">
          <span className="cgw-label">{ft('builder.language')}</span>
          <select
            className="cgw-select"
            value={form.language}
            onChange={(event) =>
              onChange({ ...form, language: event.target.value === 'ar' ? 'ar' : 'en' })
            }
          >
            <option value="en">{ft('builder.english')}</option>
            <option value="ar" lang="ar">
              {ft('builder.arabic')}
            </option>
          </select>
        </label>
      </section>
    </div>
  );
}
