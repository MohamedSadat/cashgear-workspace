// db-form-vectors.json (Phase 16): what `readForm` keeps of a stored form for the app and for a
// link, which pages an answer shows (`nextPage`, `previousPage`), and what `checkAnswers` keeps of
// an answer or which problems it names (the C# port gives the same). One database for every case;
// its forms and the answers are hand-written.
import type { FormConfig, FormMode, FormProblem } from '../forms';
import type { QueryContext, Value } from '../types';
import { ALICE, DB, P, TITLE, database, prop, rowId, type VectorDatabase } from './fixtures';

export interface ReadCase {
  name: string;
  mode: FormMode;
  config: unknown;
  expected: FormConfig;
}

export interface AnswerCase {
  name: string;
  form: string;
  mode: FormMode;
  raw: Record<string, unknown>;
  /** Only the pages up to this index are checked (absent: every page). */
  upTo?: number;
  expected:
    | { answer: { title: string; values: Record<string, Value>; pages: number[] } }
    | { problems: FormProblem[] };
}

export interface PageCase {
  name: string;
  form: string;
  raw: Record<string, unknown>;
  /** `next`: the page after this index (-1: the first); `previous`: the page before it. */
  kind: 'next' | 'previous';
  at: number;
  expected: number | null;
}

export interface FormVectors {
  database: VectorDatabase & { workspaceId: string };
  ctx: QueryContext;
  /** Stored forms (`ViewConfig.form`) the answer and page cases name. */
  forms: Record<string, unknown>;
  read: ReadCase[];
  answers: AnswerCase[];
  pages: PageCase[];
}

const WS = '01900000-0000-7000-8000-0000000000ff';
const TIMED = prop('pTime001', 'date', { date: { includeTime: true } }, 'Arrives');
const GONE = prop('pGone001', 'text', { trashedAt: '2026-02-01T00:00:00.000Z' }, 'Old');

const props = [
  TITLE,
  P.text,
  P.number,
  P.date,
  TIMED,
  P.checkbox,
  P.select,
  P.status,
  P.multi,
  P.person,
  P.url,
  P.email,
  P.phone,
  P.files,
  P.relation,
  P.formula,
  P.createdBy,
  P.button,
  GONE,
];

const q = (
  propertyId: string,
  fields: {
    label?: string | null;
    help?: string | null;
    required?: boolean;
    options?: string[] | null;
  } = {},
) => ({
  propertyId,
  label: fields.label ?? null,
  help: fields.help ?? null,
  required: fields.required ?? false,
  options: fields.options ?? null,
});

const page = (
  questions: ReturnType<typeof q>[],
  fields: { title?: string | null; description?: string | null; when?: unknown } = {},
) => ({
  title: fields.title ?? null,
  description: fields.description ?? null,
  questions,
  when: (fields.when ?? null) as FormConfig['pages'][number]['when'],
});

const form = (pages: ReturnType<typeof page>[], fields: Partial<FormConfig> = {}): FormConfig => ({
  title: null,
  description: null,
  pages,
  thanks: null,
  submit: null,
  language: 'en',
  ...fields,
});

const EMPTY = form([]);

const stageIs = (option: string) => ({
  kind: 'group',
  op: 'and',
  children: [{ kind: 'condition', propertyId: P.select.id, operator: 'is', value: option }],
});

/** A one-page form of every type a link asks. */
const simple = {
  title: 'Sign up',
  description: 'Tell us about you',
  pages: [
    {
      questions: [
        { propertyId: 'title', label: 'Your name', required: true },
        { propertyId: P.email.id, required: true, help: 'We write only about this' },
        { propertyId: P.number.id },
        { propertyId: P.select.id, options: ['optTodo1', 'optDone1'] },
        { propertyId: P.multi.id },
        { propertyId: P.checkbox.id, label: 'I agree', required: true },
        { propertyId: P.date.id },
        { propertyId: TIMED.id },
        { propertyId: P.url.id },
        { propertyId: P.phone.id },
        { propertyId: P.text.id },
        { propertyId: P.status.id },
      ],
    },
  ],
  thanks: 'Thank you!',
  submit: 'Send',
  language: 'en',
};

/** Pages shown by the stage chosen on the first. */
const paged = {
  title: 'Request',
  pages: [
    { title: 'Start', questions: [{ propertyId: 'title' }, { propertyId: P.select.id }] },
    {
      title: 'Done',
      when: stageIs('optDone1'),
      questions: [{ propertyId: P.number.id, required: true }],
    },
    { title: 'To do', when: stageIs('optTodo1'), questions: [{ propertyId: P.text.id }] },
    { title: 'Last', questions: [{ propertyId: P.email.id }] },
  ],
};

/** The app asks files, people and related rows; a link does not. */
const members = {
  pages: [
    {
      questions: [
        { propertyId: 'title' },
        { propertyId: P.person.id },
        { propertyId: P.files.id },
        { propertyId: P.relation.id },
      ],
    },
  ],
};

/** Nothing required: an answer with nothing in it is refused all the same. */
const optional = {
  pages: [{ questions: [{ propertyId: P.text.id }, { propertyId: P.checkbox.id }] }],
};

const read: ReadCase[] = [
  { name: 'no form', mode: 'link', config: null, expected: EMPTY },
  { name: 'not an object', mode: 'link', config: { form: 'yes' }, expected: EMPTY },
  { name: 'an empty object', mode: 'app', config: { form: {} }, expected: EMPTY },
  {
    name: 'a form read as written',
    mode: 'link',
    config: { form: simple },
    expected: form(
      [
        page([
          q('title', { label: 'Your name', required: true }),
          q(P.email.id, { required: true, help: 'We write only about this' }),
          q(P.number.id),
          q(P.select.id, { options: ['optTodo1', 'optDone1'] }),
          q(P.multi.id),
          q(P.checkbox.id, { label: 'I agree', required: true }),
          q(P.date.id),
          q(TIMED.id),
          q(P.url.id),
          q(P.phone.id),
          q(P.text.id),
          q(P.status.id),
        ]),
      ],
      {
        title: 'Sign up',
        description: 'Tell us about you',
        thanks: 'Thank you!',
        submit: 'Send',
      },
    ),
  },
  {
    name: 'pages and their conditions',
    mode: 'link',
    config: { form: paged },
    expected: form(
      [
        page([q('title'), q(P.select.id)], { title: 'Start' }),
        page([q(P.number.id, { required: true })], { title: 'Done', when: stageIs('optDone1') }),
        page([q(P.text.id)], { title: 'To do', when: stageIs('optTodo1') }),
        page([q(P.email.id)], { title: 'Last' }),
      ],
      { title: 'Request' },
    ),
  },
  {
    name: 'a link asks no files, people or related rows',
    mode: 'link',
    config: { form: members },
    expected: form([page([q('title')])]),
  },
  {
    name: 'the app asks them',
    mode: 'app',
    config: { form: members },
    expected: form([page([q('title'), q(P.person.id), q(P.files.id), q(P.relation.id)])]),
  },
  {
    name: 'a property asked once, its first question kept',
    mode: 'link',
    config: {
      form: {
        pages: [
          { questions: [{ propertyId: P.text.id, label: 'First' }] },
          { questions: [{ propertyId: P.text.id, label: 'Again' }, { propertyId: P.url.id }] },
        ],
      },
    },
    expected: form([page([q(P.text.id, { label: 'First' })]), page([q(P.url.id)])]),
  },
  {
    name: 'a deleted, missing, computed, created-by or button property is not asked',
    mode: 'app',
    config: {
      form: {
        pages: [
          {
            questions: [
              { propertyId: GONE.id },
              { propertyId: 'pNone001' },
              { propertyId: P.formula.id },
              { propertyId: P.createdBy.id },
              { propertyId: P.button.id },
              { propertyId: 42 },
              'title',
              { propertyId: P.phone.id },
            ],
          },
        ],
      },
    },
    expected: form([page([q(P.phone.id)])]),
  },
  {
    name: "options are the property's own, in its order; none on a text",
    mode: 'link',
    config: {
      form: {
        pages: [
          {
            questions: [
              {
                propertyId: P.select.id,
                options: ['optFive1', 'nope0001', 'optTodo1', 'optTodo1', 7],
              },
              { propertyId: P.multi.id, options: [] },
              { propertyId: P.status.id, options: 'all' },
              { propertyId: P.text.id, options: ['optTodo1'] },
            ],
          },
        ],
      },
    },
    expected: form([
      page([
        q(P.select.id, { options: ['optTodo1', 'optFive1'] }),
        q(P.multi.id, { options: [] }),
        q(P.status.id),
        q(P.text.id),
      ]),
    ]),
  },
  {
    name: 'words are cut to their lengths; an empty one is none',
    mode: 'link',
    config: {
      form: {
        title: 't'.repeat(201),
        description: '',
        thanks: 'x'.repeat(2001),
        submit: 5,
        pages: [
          {
            title: 'p'.repeat(250),
            description: 'd'.repeat(2000),
            questions: [{ propertyId: P.text.id, label: 'l'.repeat(300), help: 'h'.repeat(1001) }],
          },
        ],
      },
    },
    expected: form(
      [
        page([q(P.text.id, { label: 'l'.repeat(200), help: 'h'.repeat(1000) })], {
          title: 'p'.repeat(200),
          description: 'd'.repeat(2000),
        }),
      ],
      { title: 't'.repeat(200), thanks: 'x'.repeat(2000) },
    ),
  },
  {
    name: 'Arabic is kept; any other language is English',
    mode: 'link',
    config: { form: { language: 'ar', pages: [] } },
    expected: form([], { language: 'ar' }),
  },
  {
    name: 'a language not known is English',
    mode: 'link',
    config: { form: { language: 'fr', pages: [] } },
    expected: EMPTY,
  },
  {
    name: 'required is true or nothing',
    mode: 'link',
    config: { form: { pages: [{ questions: [{ propertyId: P.text.id, required: 'yes' }] }] } },
    expected: form([page([q(P.text.id)])]),
  },
  {
    name: 'at most 20 pages',
    mode: 'link',
    config: { form: { pages: Array.from({ length: 25 }, () => ({ questions: [] })) } },
    expected: form(Array.from({ length: 20 }, () => page([]))),
  },
  {
    name: 'a condition that is not a filter group is none',
    mode: 'link',
    config: {
      form: {
        pages: [
          {
            questions: [],
            when: { kind: 'condition', propertyId: P.text.id, operator: 'isEmpty' },
          },
          { questions: [], when: { kind: 'group', op: 'xor', children: [] } },
          {
            questions: [],
            when: {
              kind: 'group',
              op: 'and',
              children: [
                { kind: 'group', op: 'or', children: [{ kind: 'group', op: 'and', children: [] }] },
              ],
            },
          },
          {
            questions: [],
            when: { kind: 'group', op: 'or', children: [{ kind: 'condition', propertyId: 'x' }] },
          },
          { questions: [], when: stageIs('optDone1') },
        ],
      },
    },
    expected: form([
      page([]),
      page([]),
      page([]),
      page([]),
      page([], { when: stageIs('optDone1') }),
    ]),
  },
];

/** 101 text properties asked across two pages: the first 100 are kept. */
const many = Array.from({ length: 101 }, (_, i) =>
  prop(`pMany${String(i).padStart(3, '0')}`, 'text'),
);
read.push({
  name: 'at most 100 questions',
  mode: 'link',
  config: {
    form: {
      pages: [
        { questions: many.slice(0, 60).map((p) => ({ propertyId: p.id })) },
        { questions: many.slice(60).map((p) => ({ propertyId: p.id })) },
      ],
    },
  },
  expected: form([
    page(many.slice(0, 60).map((p) => q(p.id))),
    page(many.slice(60, 100).map((p) => q(p.id))),
  ]),
});

const full = {
  title: 'Sara',
  [P.email.id]: '  sara@example.com ',
  [P.number.id]: '12.5',
  [P.select.id]: 'optDone1',
  [P.multi.id]: ['tagRed01', 'tagAr001', 'tagRed01'],
  [P.checkbox.id]: 'on',
  [P.date.id]: '2026-12-01',
  [TIMED.id]: '2026-12-01T09:30:00Z',
  [P.url.id]: 'https://example.com',
  [P.phone.id]: '+966 50 000 0000',
  [P.text.id]: 'Hello',
  [P.status.id]: 'staProg1',
};

const answers: AnswerCase[] = [
  {
    name: 'every type a link asks, coerced',
    form: 'simple',
    mode: 'link',
    raw: full,
    expected: {
      answer: {
        title: 'Sara',
        values: {
          [P.email.id]: 'sara@example.com',
          [P.number.id]: 12.5,
          [P.select.id]: 'optDone1',
          [P.multi.id]: ['tagRed01', 'tagAr001'],
          [P.checkbox.id]: true,
          [P.date.id]: { start: '2026-12-01' },
          [TIMED.id]: { start: '2026-12-01T09:30:00Z' },
          [P.url.id]: 'https://example.com',
          [P.phone.id]: '+966 50 000 0000',
          [P.text.id]: 'Hello',
          [P.status.id]: 'staProg1',
        },
        pages: [0],
      },
    },
  },
  {
    name: 'Arabic-Indic digits are a number',
    form: 'simple',
    mode: 'link',
    raw: { title: 'سارة', [P.email.id]: 's@x.sa', [P.checkbox.id]: true, [P.number.id]: '١٢٫٥' },
    expected: {
      answer: {
        title: 'سارة',
        values: { [P.email.id]: 's@x.sa', [P.checkbox.id]: true, [P.number.id]: 12.5 },
        pages: [0],
      },
    },
  },
  {
    name: 'required questions not answered, in the order asked',
    form: 'simple',
    mode: 'link',
    raw: { [P.number.id]: '3', [P.checkbox.id]: false },
    expected: {
      problems: [
        { propertyId: 'title', reason: 'answer.required' },
        { propertyId: P.email.id, reason: 'answer.required' },
        { propertyId: P.checkbox.id, reason: 'answer.required' },
      ],
    },
  },
  {
    name: 'only spaces are no answer',
    form: 'simple',
    mode: 'link',
    raw: { title: '   ', [P.email.id]: 'a@b.c', [P.checkbox.id]: 'on' },
    expected: { problems: [{ propertyId: 'title', reason: 'answer.required' }] },
  },
  {
    name: 'an option the question does not show',
    form: 'simple',
    mode: 'link',
    raw: { title: 'A', [P.email.id]: 'a@b.c', [P.checkbox.id]: 'on', [P.select.id]: 'optLate1' },
    expected: { problems: [{ propertyId: P.select.id, reason: 'answer.option' }] },
  },
  {
    name: 'an option by its name is the option',
    form: 'simple',
    mode: 'link',
    raw: { title: 'A', [P.email.id]: 'a@b.c', [P.checkbox.id]: 'on', [P.select.id]: 'Done' },
    expected: {
      answer: {
        title: 'A',
        values: { [P.email.id]: 'a@b.c', [P.select.id]: 'optDone1', [P.checkbox.id]: true },
        pages: [0],
      },
    },
  },
  {
    name: 'no option of the property',
    form: 'simple',
    mode: 'link',
    raw: { title: 'A', [P.email.id]: 'a@b.c', [P.checkbox.id]: 'on', [P.select.id]: 'nope0001' },
    expected: { problems: [{ propertyId: P.select.id, reason: 'answer.invalid' }] },
  },
  {
    name: 'a choice that is no option is refused, never dropped',
    form: 'simple',
    mode: 'link',
    raw: {
      title: 'A',
      [P.email.id]: 'a@b.c',
      [P.checkbox.id]: 'on',
      [P.multi.id]: ['tagRed01', 'junk'],
    },
    expected: { problems: [{ propertyId: P.multi.id, reason: 'answer.invalid' }] },
  },
  {
    name: 'a number that is not one',
    form: 'simple',
    mode: 'link',
    raw: { title: 'A', [P.email.id]: 'a@b.c', [P.checkbox.id]: 'on', [P.number.id]: 'twelve' },
    expected: { problems: [{ propertyId: P.number.id, reason: 'answer.invalid' }] },
  },
  {
    name: 'a date that is not one',
    form: 'simple',
    mode: 'link',
    raw: { title: 'A', [P.email.id]: 'a@b.c', [P.checkbox.id]: 'on', [P.date.id]: '1 December' },
    expected: { problems: [{ propertyId: P.date.id, reason: 'answer.invalid' }] },
  },
  {
    name: 'texts longer than an answer may be',
    form: 'simple',
    mode: 'link',
    raw: {
      title: 'n'.repeat(1001),
      [P.email.id]: 'a@b.c',
      [P.checkbox.id]: 'on',
      [P.text.id]: 'x'.repeat(10_001),
    },
    expected: {
      problems: [
        { propertyId: 'title', reason: 'answer.long' },
        { propertyId: P.text.id, reason: 'answer.long' },
      ],
    },
  },
  {
    name: 'the longest answers are kept',
    form: 'simple',
    mode: 'link',
    raw: {
      title: 'n'.repeat(1000),
      [P.email.id]: 'a@b.c',
      [P.checkbox.id]: 'on',
      [P.text.id]: 'x'.repeat(10_000),
    },
    expected: {
      answer: {
        title: 'n'.repeat(1000),
        values: { [P.email.id]: 'a@b.c', [P.checkbox.id]: true, [P.text.id]: 'x'.repeat(10_000) },
        pages: [0],
      },
    },
  },
  {
    name: 'what is not a question is left out',
    form: 'simple',
    mode: 'link',
    raw: {
      title: 'A',
      [P.email.id]: 'a@b.c',
      [P.checkbox.id]: 'on',
      [P.person.id]: [ALICE],
      [P.formula.id]: 5,
      pNone001: 'x',
      website: 'spam',
    },
    expected: {
      answer: {
        title: 'A',
        values: { [P.email.id]: 'a@b.c', [P.checkbox.id]: true },
        pages: [0],
      },
    },
  },
  {
    name: 'an answer with nothing in it',
    form: 'optional',
    mode: 'link',
    raw: { [P.text.id]: '', [P.checkbox.id]: false },
    expected: { problems: [{ propertyId: null, reason: 'answer.empty' }] },
  },
  {
    name: 'a page shown by the first page: its required question',
    form: 'paged',
    mode: 'link',
    raw: { title: 'Fix it', [P.select.id]: 'optDone1', [P.text.id]: 'never shown' },
    expected: { problems: [{ propertyId: P.number.id, reason: 'answer.required' }] },
  },
  {
    name: 'the pages shown, and the answers of the others left out',
    form: 'paged',
    mode: 'link',
    raw: {
      title: 'Fix it',
      [P.select.id]: 'optDone1',
      [P.number.id]: '3',
      [P.text.id]: 'never shown',
      [P.email.id]: 'me@x.io',
    },
    expected: {
      answer: {
        title: 'Fix it',
        values: { [P.select.id]: 'optDone1', [P.number.id]: 3, [P.email.id]: 'me@x.io' },
        pages: [0, 1, 3],
      },
    },
  },
  {
    name: 'another choice shows the other page',
    form: 'paged',
    mode: 'link',
    raw: { title: 'Plan it', [P.select.id]: 'optTodo1', [P.number.id]: '3', [P.text.id]: 'Soon' },
    expected: {
      answer: {
        title: 'Plan it',
        values: { [P.select.id]: 'optTodo1', [P.text.id]: 'Soon' },
        pages: [0, 2, 3],
      },
    },
  },
  {
    name: 'a refused answer is no value to a condition',
    form: 'paged',
    mode: 'link',
    raw: { title: 'Odd', [P.select.id]: 'nope0001' },
    expected: { problems: [{ propertyId: P.select.id, reason: 'answer.invalid' }] },
  },
  {
    name: 'up to a page: the first page alone, empty and all',
    form: 'paged',
    mode: 'link',
    raw: {},
    upTo: 0,
    expected: { answer: { title: '', values: {}, pages: [0] } },
  },
  {
    name: 'up to the second page shown',
    form: 'paged',
    mode: 'link',
    raw: { [P.select.id]: 'optDone1' },
    upTo: 1,
    expected: { problems: [{ propertyId: P.number.id, reason: 'answer.required' }] },
  },
  {
    name: 'the app keeps people, files and related rows as ids',
    form: 'members',
    mode: 'app',
    raw: {
      title: 'Mine',
      [P.person.id]: [ALICE, ALICE],
      [P.files.id]: rowId(90),
      [P.relation.id]: [rowId(7)],
    },
    expected: {
      answer: {
        title: 'Mine',
        values: { [P.person.id]: [ALICE], [P.files.id]: [rowId(90)], [P.relation.id]: [rowId(7)] },
        pages: [0],
      },
    },
  },
  {
    name: 'a link leaves them out',
    form: 'members',
    mode: 'link',
    raw: { title: 'Mine', [P.person.id]: [ALICE], [P.files.id]: [rowId(90)] },
    expected: { answer: { title: 'Mine', values: {}, pages: [0] } },
  },
];

const pages: PageCase[] = [
  { name: 'the first page', form: 'paged', raw: {}, kind: 'next', at: -1, expected: 0 },
  {
    name: 'nothing chosen: the last page next',
    form: 'paged',
    raw: {},
    kind: 'next',
    at: 0,
    expected: 3,
  },
  {
    name: 'a choice shows its page next',
    form: 'paged',
    raw: { [P.select.id]: 'optTodo1' },
    kind: 'next',
    at: 0,
    expected: 2,
  },
  {
    name: 'after the shown page, the last',
    form: 'paged',
    raw: { [P.select.id]: 'optDone1', [P.number.id]: '5' },
    kind: 'next',
    at: 1,
    expected: 3,
  },
  {
    name: 'the last page has none after it',
    form: 'paged',
    raw: { [P.select.id]: 'optDone1' },
    kind: 'next',
    at: 3,
    expected: null,
  },
  {
    name: 'back from the last to the page shown',
    form: 'paged',
    raw: { [P.select.id]: 'optDone1' },
    kind: 'previous',
    at: 3,
    expected: 1,
  },
  {
    name: 'back from the last with nothing chosen',
    form: 'paged',
    raw: {},
    kind: 'previous',
    at: 3,
    expected: 0,
  },
  {
    name: 'nothing before the first',
    form: 'paged',
    raw: {},
    kind: 'previous',
    at: 0,
    expected: null,
  },
  { name: 'a form of no pages', form: 'none', raw: {}, kind: 'next', at: -1, expected: null },
];

export const formVectors: FormVectors = {
  database: { ...database([...props, ...many], DB), workspaceId: WS },
  ctx: { today: '2026-11-24', offsetMinutes: 180, me: null },
  forms: { simple, paged, members, optional, none: { pages: [] } },
  read,
  answers,
  pages,
};
