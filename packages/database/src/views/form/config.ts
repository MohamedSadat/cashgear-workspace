// A form view's settings (Phase 16): its form as stored (`ViewConfig.form`), written back with the
// view's `properties` following its questions (their properties shown in order, every other hidden),
// so an older build's table shows what the form asks. The form is read by `readForm`
// (`@cgw/workspace/forms`), never as stored.
import { APP_QUESTION_TYPES, readForm } from '@cgw/workspace/forms';
import {
  TITLE_PROPERTY,
  type DatabaseRecord,
  type FormConfig,
  type FormMode,
  type FormPage,
  type FormQuestion,
  type PropertyDef,
  type PropertyId,
  type StoredForm,
  type ViewConfig,
  type ViewRecord,
} from '../../core';
import { liveProperties } from '../../model/properties';
import { emptyConfig } from '../../model/viewConfig';

/** The view's form, read as the app (or a link) asks it. */
export const formOf = (
  view: Pick<ViewRecord, 'config'>,
  db: DatabaseRecord,
  mode: FormMode = 'app',
) => readForm(view.config, db, mode);

/** What a form may ask in the app: the live properties of the types it asks, the title first. */
export const askable = (db: DatabaseRecord): PropertyDef[] =>
  liveProperties(db).filter((p) => APP_QUESTION_TYPES.includes(p.type));

/** The properties a form's questions ask, in order. */
export const askedIds = (form: FormConfig): PropertyId[] =>
  form.pages.flatMap((p) => p.questions.map((q) => q.propertyId));

export const newQuestion = (propertyId: PropertyId, required = false): FormQuestion => ({
  propertyId,
  label: null,
  help: null,
  required,
  options: null,
});

export const newPage = (questions: FormQuestion[] = []): FormPage => ({
  title: null,
  description: null,
  questions,
  when: null,
});

/** A new form: one page asking the title (required), then every other property it may ask. */
export function defaultForm(db: DatabaseRecord, language: 'en' | 'ar' = 'en'): FormConfig {
  const questions = askable(db).map((p) => newQuestion(p.id, p.id === TITLE_PROPERTY));
  return {
    title: null,
    description: null,
    pages: [newPage(questions.slice(0, 100))],
    thanks: null,
    submit: null,
    language,
  };
}

/** The view's `properties` for its form: its questions shown in order, every other hidden. */
export function formProperties(db: DatabaseRecord, form: FormConfig): ViewConfig['properties'] {
  const order = askedIds(form);
  const asked = new Set(order);
  return {
    order: order.includes(TITLE_PROPERTY) ? order : [TITLE_PROPERTY, ...order],
    hidden: db.properties
      .filter((p) => !asked.has(p.id) && p.id !== TITLE_PROPERTY)
      .map((p) => p.id),
    widths: {},
  };
}

/** The form as it is stored: every field written, empty words as null. */
export function storedForm(form: FormConfig): StoredForm {
  return {
    title: form.title || null,
    description: form.description || null,
    pages: form.pages.map((p) => ({
      title: p.title || null,
      description: p.description || null,
      questions: p.questions.map((q) => ({
        propertyId: q.propertyId,
        label: q.label || null,
        help: q.help || null,
        required: q.required,
        options: q.options,
      })),
      when: p.when,
    })),
    thanks: form.thanks || null,
    submit: form.submit || null,
    language: form.language,
  };
}

/** A view's config holding the form, its properties following the questions. */
export const withForm = (db: DatabaseRecord, config: ViewConfig, form: FormConfig): ViewConfig => ({
  ...config,
  properties: formProperties(db, form),
  form: storedForm(form),
});

/** A new form view's config. */
export const defaultFormConfig = (db: DatabaseRecord, language: 'en' | 'ar' = 'en'): ViewConfig =>
  withForm(db, emptyConfig('form'), defaultForm(db, language));
