// Forms (Phase 16; DATA_MODEL.md, Forms): a form view's questions, its pages and their conditions,
// read from `ViewConfig.form` (`readForm`), which pages an answer shows (`shownPages`, `nextPage`,
// `previousPage`), and the check every answer passes on the device and again on the server
// (`checkAnswers`; the C# port is server/src/Cgw.Core/Forms/FormRules.cs). The two are held together
// by packages/workspace/vectors/db-form-vectors.json. No React, no DOM; this entry is
// `@cgw/workspace/forms`, loaded with the form view, so the app's initial JavaScript holds none of it.
import type { RowRecord } from '../types';
import { isOptionId, isPropertyId } from './ids';
import { matchesFilter } from './query';
import {
  TITLE_PROPERTY,
  type DatabaseRecord,
  type FilterCondition,
  type FilterGroup,
  type OptionId,
  type PropertyDef,
  type PropertyId,
  type PropertyType,
  type QueryContext,
  type Value,
  type ViewConfig,
} from './types';
import { coerceValue, isEmptyValue } from './values';

/** Pages a form holds at most, questions in all its pages, and the lengths of its words. */
export const MAX_FORM_PAGES = 20;
export const MAX_FORM_QUESTIONS = 100;
/** A form's title, its button's words, a page's title, a question's label. */
export const MAX_FORM_LABEL = 200;
/** A question's help. */
export const MAX_FORM_HELP = 1000;
/** A form's or a page's description, the thank-you text. */
export const MAX_FORM_TEXT = 2000;
/** One text answer (a title answer: 1,000, the most a title holds). */
export const MAX_ANSWER_TEXT = 10_000;
export const MAX_ANSWER_TITLE = 1000;
/** A link's answer as posted, at most (the API's and the Sites process's limit). */
export const MAX_ANSWER_BYTES = 65_536;
/** A link's answers an address may give a form: a minute's and a day's (DECISIONS.md, 2026-11-24). */
export const ANSWERS_PER_MINUTE = 10;
export const ANSWERS_PER_DAY = 100;

export type FormLanguage = 'en' | 'ar';

/** Who answers: a member in the app, or anyone by the form's link (no session). */
export type FormMode = 'app' | 'link';

/** What a link may ask: values a person types or picks, nothing that needs a session to show. */
export const LINK_QUESTION_TYPES: readonly PropertyType[] = [
  'title',
  'text',
  'number',
  'select',
  'multiSelect',
  'status',
  'date',
  'checkbox',
  'url',
  'email',
  'phone',
];
/** What the app may ask besides: files (an upload), people and related rows (a session shows them). */
export const APP_QUESTION_TYPES: readonly PropertyType[] = [
  ...LINK_QUESTION_TYPES,
  'person',
  'files',
  'relation',
];

const OPTION_TYPES = new Set<PropertyType>(['select', 'multiSelect', 'status']);
const TEXT_TYPES = new Set<PropertyType>(['title', 'text', 'url', 'email', 'phone']);

export interface FormQuestion {
  propertyId: PropertyId;
  /** Null: the property's name. */
  label: string | null;
  help: string | null;
  required: boolean;
  /**
   * Select, multi-select and status: the options it shows, in the property's order (null: every
   * option the property has). Null for every other type.
   */
  options: OptionId[] | null;
}

export interface FormPage {
  title: string | null;
  description: string | null;
  questions: FormQuestion[];
  /**
   * Shown only when the answers on the pages shown before it match, in `queryRows`' filter
   * language (a property not asked before it reads as empty); null: always shown.
   */
  when: FilterGroup | null;
}

/** A form as it is drawn and checked (`readForm`): every field present. */
export interface FormConfig {
  /** Null: the view's name. */
  title: string | null;
  description: string | null;
  pages: FormPage[];
  /** Null: the app's own words ("Thank you…"). */
  thanks: string | null;
  /** The button's words on the last page; null: "Submit". */
  submit: string | null;
  /** The words and direction of the link's pages (the app shows a form in its own language). */
  language: FormLanguage;
}

/** `ViewConfig.form` as stored: what an editor wrote; read by `readForm`, never trusted as is. */
export type StoredForm = Partial<
  Omit<FormConfig, 'pages'> & {
    pages: Partial<Omit<FormPage, 'questions'> & { questions: Partial<FormQuestion>[] }>[];
  }
>;

export const EMPTY_FORM: FormConfig = Object.freeze({
  title: null,
  description: null,
  pages: [],
  thanks: null,
  submit: null,
  language: 'en',
}) as FormConfig;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Text cut to `max` UTF-16 units; anything else, or an empty text, is null. */
function words(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length > max ? value.slice(0, max) : value;
}

const live = (db: DatabaseRecord, id: unknown): PropertyDef | undefined =>
  typeof id === 'string' ? db.properties.find((p) => p.id === id && !p.trashedAt) : undefined;

/** The question types a mode may ask. */
export const questionTypes = (mode: FormMode): readonly PropertyType[] =>
  mode === 'link' ? LINK_QUESTION_TYPES : APP_QUESTION_TYPES;

/** A filter group's shape (at most two levels and 50 children each), or null. */
function readGroup(value: unknown, depth = 1): FilterGroup | null {
  if (!isObject(value) || value.kind !== 'group') return null;
  if (value.op !== 'and' && value.op !== 'or') return null;
  if (!Array.isArray(value.children) || value.children.length > 50) return null;
  const children: (FilterGroup | FilterCondition)[] = [];
  for (const child of value.children as unknown[]) {
    if (isObject(child) && child.kind === 'group') {
      if (depth >= 2) return null;
      const group = readGroup(child, depth + 1);
      if (!group) return null;
      children.push(group);
      continue;
    }
    if (!isObject(child) || child.kind !== 'condition' || !isPropertyId(child.propertyId))
      return null;
    if (typeof child.operator !== 'string') return null;
    const condition: FilterCondition = {
      kind: 'condition',
      propertyId: child.propertyId,
      operator: child.operator as FilterCondition['operator'],
    };
    if (child.value !== undefined) condition.value = child.value as FilterCondition['value'];
    children.push(condition);
  }
  return { kind: 'group', op: value.op, children };
}

/**
 * A view's form as it is drawn and checked: at most 20 pages and 100 questions; a question only of
 * a live property of a type the mode asks (a link asks no files, people or related rows), each
 * property once (the first); its options only the property's own, in the property's order; words
 * cut to their lengths; a page's condition only a filter group's shape (else none). Nothing else of
 * the stored form is kept.
 */
export function readForm(
  config: Pick<ViewConfig, 'form'> | null | undefined,
  db: DatabaseRecord,
  mode: FormMode,
): FormConfig {
  const value: unknown = config?.form;
  if (!isObject(value)) return EMPTY_FORM;
  const allowed = new Set(questionTypes(mode));
  const seen = new Set<PropertyId>();
  const pages: FormPage[] = [];
  const given = Array.isArray(value.pages) ? (value.pages as unknown[]) : [];
  for (const raw of given) {
    if (pages.length >= MAX_FORM_PAGES) break;
    if (!isObject(raw)) continue;
    const questions: FormQuestion[] = [];
    for (const q of Array.isArray(raw.questions) ? (raw.questions as unknown[]) : []) {
      if (seen.size >= MAX_FORM_QUESTIONS) break;
      if (!isObject(q)) continue;
      const def = live(db, q.propertyId);
      if (!def || seen.has(def.id)) continue;
      // A question the mode cannot ask is not asked, and its property is still taken.
      seen.add(def.id);
      if (!allowed.has(def.type)) continue;
      let options: OptionId[] | null = null;
      if (OPTION_TYPES.has(def.type) && Array.isArray(q.options)) {
        const wanted = new Set((q.options as unknown[]).filter(isOptionId));
        options = (def.options ?? []).map((o) => o.id).filter((id) => wanted.has(id));
      }
      questions.push({
        propertyId: def.id,
        label: words(q.label, MAX_FORM_LABEL),
        help: words(q.help, MAX_FORM_HELP),
        required: q.required === true,
        options,
      });
    }
    pages.push({
      title: words(raw.title, MAX_FORM_LABEL),
      description: words(raw.description, MAX_FORM_TEXT),
      questions,
      when: readGroup(raw.when),
    });
  }
  return {
    title: words(value.title, MAX_FORM_LABEL),
    description: words(value.description, MAX_FORM_TEXT),
    pages,
    thanks: words(value.thanks, MAX_FORM_TEXT),
    submit: words(value.submit, MAX_FORM_LABEL),
    language: value.language === 'ar' ? 'ar' : 'en',
  };
}

/** A row holding the answers given so far, the title among them, for a page's condition. */
function answersRow(db: DatabaseRecord, values: Record<PropertyId, Value>): RowRecord {
  const { [TITLE_PROPERTY]: title, ...rest } = values;
  return {
    id: '',
    workspaceId: db.workspaceId,
    sectionId: '',
    parentPageId: db.id,
    orderKey: 'a0',
    kind: 'row',
    title: typeof title === 'string' ? title : '',
    icon: null,
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 1,
    createdAt: '',
    updatedAt: '',
    trashedAt: null,
    trashRootId: null,
    databaseId: db.id,
    values: rest,
    versions: {},
    computed: {},
    computedVersion: null,
    createdBy: null,
    updatedBy: null,
  };
}

export type ProblemReason =
  /** A required question on a page shown has no answer. */
  | 'answer.required'
  /** An answer that is not a value of its property (a number that is not one, an unknown option). */
  | 'answer.invalid'
  /** An option the question does not show. */
  | 'answer.option'
  /** A text longer than an answer may be. */
  | 'answer.long'
  /** Nothing answered at all. */
  | 'answer.empty';

export interface FormProblem {
  /** The question's property; null for the answer as a whole (`answer.empty`). */
  propertyId: PropertyId | null;
  reason: ProblemReason;
}

/** One question's answer: its value, nothing (not answered), or why it is refused. */
function answerOf(
  def: PropertyDef,
  question: FormQuestion,
  raw: unknown,
): { value: Value | undefined; problem: ProblemReason | null } {
  if (isEmptyValue(raw) || (def.type === 'checkbox' && raw === false))
    return { value: undefined, problem: question.required ? 'answer.required' : null };
  let value: Value | undefined;
  if (def.type === 'multiSelect') {
    // Each choice on its own: one that is no option of the property is refused, never dropped.
    const ids: OptionId[] = [];
    for (const part of Array.isArray(raw) ? (raw as unknown[]) : [raw]) {
      const id = coerceValue({ ...def, type: 'select' }, part);
      if (typeof id !== 'string') return { value: undefined, problem: 'answer.invalid' };
      if (!ids.includes(id)) ids.push(id);
    }
    value = ids.length ? ids : undefined;
  } else value = coerceValue(def, raw);
  if (value === undefined || isEmptyValue(value))
    return { value: undefined, problem: 'answer.invalid' };
  if (question.options && OPTION_TYPES.has(def.type)) {
    const chosen = Array.isArray(value) ? (value as string[]) : [value as string];
    if (chosen.some((id) => !question.options!.includes(id)))
      return { value: undefined, problem: 'answer.option' };
  }
  if (TEXT_TYPES.has(def.type) && typeof value === 'string') {
    const max = def.type === 'title' ? MAX_ANSWER_TITLE : MAX_ANSWER_TEXT;
    if (value.length > max) return { value: undefined, problem: 'answer.long' };
  }
  return { value, problem: null };
}

interface Walk {
  /** Pages shown, by index, in order. */
  shown: number[];
  values: Record<PropertyId, Value>;
  problems: FormProblem[];
}

/**
 * The pages an answer shows and their answers, in order: a page is shown when its condition matches
 * the answers on the pages shown before it (each read as `answerOf` reads it; a refused one is no
 * value); `upTo` stops after that page.
 */
function walk(
  form: FormConfig,
  db: DatabaseRecord,
  raw: Readonly<Record<PropertyId, unknown>>,
  ctx: QueryContext,
  upTo = Infinity,
): Walk {
  const shown: number[] = [];
  const values: Record<PropertyId, Value> = {};
  const problems: FormProblem[] = [];
  for (let i = 0; i < form.pages.length && i <= upTo; i++) {
    const page = form.pages[i];
    if (page.when && !matchesFilter(db, answersRow(db, values), page.when, ctx)) continue;
    shown.push(i);
    for (const question of page.questions) {
      const def = live(db, question.propertyId);
      if (!def) continue;
      const { value, problem } = answerOf(def, question, raw[question.propertyId]);
      if (problem) problems.push({ propertyId: def.id, reason: problem });
      if (value !== undefined) values[def.id] = value;
    }
  }
  return { shown, values, problems };
}

/** The pages an answer shows, by index, in order. */
export function shownPages(
  form: FormConfig,
  db: DatabaseRecord,
  raw: Readonly<Record<PropertyId, unknown>>,
  ctx: QueryContext,
): number[] {
  return walk(form, db, raw, ctx).shown;
}

/**
 * The page shown after `after` (an index; -1 for the first), or null when `after` is the last: it
 * depends only on the answers on the pages shown up to `after`.
 */
export function nextPage(
  form: FormConfig,
  db: DatabaseRecord,
  raw: Readonly<Record<PropertyId, unknown>>,
  ctx: QueryContext,
  after: number,
): number | null {
  return walk(form, db, raw, ctx).shown.find((i) => i > after) ?? null;
}

/** The page shown before `before`, or null when none is. */
export function previousPage(
  form: FormConfig,
  db: DatabaseRecord,
  raw: Readonly<Record<PropertyId, unknown>>,
  ctx: QueryContext,
  before: number,
): number | null {
  const earlier = walk(form, db, raw, ctx).shown.filter((i) => i < before);
  return earlier.length ? earlier[earlier.length - 1] : null;
}

/** An answer kept: the row's title and values, and the pages it showed. */
export interface FormAnswer {
  title: string;
  values: Record<PropertyId, Value>;
  pages: number[];
}

export type FormCheck = { ok: true; answer: FormAnswer } | { ok: false; problems: FormProblem[] };

/**
 * An answer checked (the pages up to `upTo`, an index; every page by default): each question on a
 * page shown coerced to its property's type by the shared coercion; a required one answered; an
 * option one the question shows; a text no longer than an answer may be; questions of pages not
 * shown, and anything that is not a question, left out. Refused with every problem in the order
 * of the questions; a whole answer with nothing in it is refused too (`answer.empty`).
 */
export function checkAnswers(
  form: FormConfig,
  db: DatabaseRecord,
  raw: Readonly<Record<PropertyId, unknown>>,
  ctx: QueryContext,
  upTo = Infinity,
): FormCheck {
  const { shown, values, problems } = walk(form, db, raw, ctx, upTo);
  if (problems.length) return { ok: false, problems };
  if (upTo === Infinity && Object.keys(values).length === 0)
    return { ok: false, problems: [{ propertyId: null, reason: 'answer.empty' }] };
  const { [TITLE_PROPERTY]: title, ...rest } = values;
  return {
    ok: true,
    answer: { title: typeof title === 'string' ? title : '', values: rest, pages: shown },
  };
}

/** Every question of a form, in order, with its page. */
export function formQuestions(form: FormConfig): { page: number; question: FormQuestion }[] {
  return form.pages.flatMap((page, index) =>
    page.questions.map((question) => ({ page: index, question })),
  );
}
