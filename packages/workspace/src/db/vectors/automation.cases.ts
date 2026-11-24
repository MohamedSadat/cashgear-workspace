// db-automation-vectors.json (Phase 15): what `checkAutomation` keeps of a rule or why it refuses
// it (the reason the C# port gives too), and which changes of a row `changeStarts` reads as
// starting a trigger. One database for every case; its rules are hand-written, as are the answers.
import type { AutomationRecord, RowChange } from '../automations';
import type { QueryContext } from '../types';
import {
  ALICE,
  BOB,
  DB,
  DB2,
  TITLE,
  database,
  option,
  prop,
  status,
  type VectorDatabase,
} from './fixtures';

export interface CheckCase {
  name: string;
  rule: unknown;
  /** The rule as kept, or the reason it is refused. */
  expected: { rule: AutomationRecord } | { reason: string };
}

export interface StartCase {
  name: string;
  trigger: unknown;
  change: RowChange;
  expected: boolean;
}

export interface AutomationVectors {
  database: VectorDatabase & { workspaceId: string };
  ctx: QueryContext;
  check: CheckCase[];
  starts: StartCase[];
}

const WS = '01900000-0000-7000-8000-0000000000ff';
const RULE = '01900000-0000-7000-8000-00000000a001';
const HOOK = '01900000-0000-7000-8000-00000000b001';
const TEMPLATE = '01900000-0000-7000-8000-00000000c001';
const GROUP = '01900000-0000-7000-8000-00000000d001';

const STATUS = prop(
  'pStat001',
  'status',
  {
    options: [
      status('sTodo001', 'To do', 'todo'),
      status('sDoin001', 'Doing', 'inProgress'),
      status('sDone001', 'Done', 'complete'),
    ],
  },
  'Status',
);
const props = [
  TITLE,
  STATUS,
  prop('pDate001', 'date', {}, 'Due'),
  prop('pWhen001', 'date', { date: { includeTime: true } }, 'When'),
  prop('pPers001', 'person', {}, 'Owner'),
  prop('pNum0001', 'number', {}, 'Points'),
  prop('pRel0001', 'relation', { relation: { databaseId: DB2, reversePropertyId: null } }, 'Tasks'),
  prop('pBtn0001', 'button', { button: { label: 'Approve' } }, 'Approve'),
  prop('pForm001', 'formula', { formula: { expression: 'prop("pNum0001") * 2' } }, 'Double'),
  prop('pText001', 'text', {}, 'Notes'),
  prop('pGone001', 'text', { trashedAt: '2026-02-01T00:00:00.000Z' }, 'Old'),
  prop('pMade001', 'createdTime', {}, 'Created'),
  prop('pTick001', 'checkbox', {}, 'Done?'),
  prop('pTags001', 'multiSelect', { options: [option('tRed0001', 'Red')] }, 'Tags'),
];

const base = {
  id: RULE,
  workspaceId: WS,
  databaseId: DB,
  name: 'Close it',
  enabled: true,
  authorId: null,
  version: 0,
  createdAt: '',
  updatedAt: '',
};

/** A rule as given (its own fields over the base). */
const given = (fields: Record<string, unknown>) => ({ ...base, conditions: null, ...fields });

/** The same rule as `checkAutomation` keeps it. */
const kept = (fields: Partial<AutomationRecord>): { rule: AutomationRecord } => ({
  rule: {
    ...base,
    conditions: null,
    trigger: { kind: 'rowAdded' },
    steps: [],
    ...fields,
  } as AutomationRecord,
});

const refused = (reason: string) => ({ reason });

const SET_DONE = { kind: 'set', values: { pStat001: 'sDone001' } };
const SET_DONE_KEPT = { kind: 'set' as const, values: { pStat001: 'sDone001' }, when: null };
const big = 'x'.repeat(1000);

const check: CheckCase[] = [
  {
    name: 'a row added sets its status',
    rule: given({ trigger: { kind: 'rowAdded' }, steps: [SET_DONE] }),
    expected: kept({ trigger: { kind: 'rowAdded' }, steps: [SET_DONE_KEPT] }),
  },
  {
    name: 'a status changed from To do to Done tells two people, once each',
    rule: given({
      trigger: {
        kind: 'propertyChanged',
        propertyId: 'pStat001',
        from: { operator: 'is', value: 'sTodo001' },
        to: { operator: 'is', value: 'sDone001' },
      },
      steps: [{ kind: 'notify', people: [ALICE, BOB, ALICE], message: 'Done' }],
    }),
    expected: kept({
      trigger: {
        kind: 'propertyChanged',
        propertyId: 'pStat001',
        from: { operator: 'is', value: 'sTodo001' },
        to: { operator: 'is', value: 'sDone001' },
      },
      steps: [
        {
          kind: 'notify',
          people: [ALICE, BOB],
          groups: [],
          personProperties: [],
          message: 'Done',
          when: null,
        },
      ],
    }),
  },
  {
    name: 'any property changed calls a webhook with two properties',
    rule: given({
      trigger: { kind: 'propertyChanged', propertyId: null },
      steps: [{ kind: 'webhook', webhookId: HOOK, properties: ['title', 'pStat001', 'title'] }],
    }),
    expected: kept({
      trigger: { kind: 'propertyChanged', propertyId: null, from: null, to: null },
      steps: [{ kind: 'webhook', webhookId: HOOK, properties: ['title', 'pStat001'], when: null }],
    }),
  },
  {
    name: 'an hour before a day is reached, a row is added to another database (its values unread)',
    rule: given({
      trigger: { kind: 'date', propertyId: 'pDate001', offsetMinutes: -60, at: '08:30' },
      steps: [
        {
          kind: 'addRow',
          databaseId: DB2,
          templateId: TEMPLATE,
          values: { title: 'Follow up', pZzzz001: { dynamic: 'row' } },
        },
      ],
    }),
    expected: kept({
      trigger: { kind: 'date', propertyId: 'pDate001', offsetMinutes: -60, at: '08:30' },
      steps: [
        {
          kind: 'addRow',
          databaseId: DB2,
          templateId: TEMPLATE,
          values: { title: 'Follow up', pZzzz001: { dynamic: 'row' } },
          when: null,
        },
      ],
    }),
  },
  {
    name: 'a created time reached, with no time of day given',
    rule: given({
      trigger: { kind: 'date', propertyId: 'pMade001', offsetMinutes: 1440 },
      steps: [SET_DONE],
    }),
    expected: kept({
      trigger: { kind: 'date', propertyId: 'pMade001', offsetMinutes: 1440, at: null },
      steps: [SET_DONE_KEPT],
    }),
  },
  {
    name: 'every Monday a row is added here, due in a week',
    rule: given({
      trigger: { kind: 'schedule', every: 'week', at: '09:00', weekday: 1 },
      steps: [
        {
          kind: 'addRow',
          databaseId: DB,
          templateId: null,
          values: { pDate001: { dynamic: 'now', days: 7 } },
        },
      ],
    }),
    expected: kept({
      trigger: { kind: 'schedule', every: 'week', at: '09:00', weekday: 1, day: null },
      steps: [
        {
          kind: 'addRow',
          databaseId: DB,
          templateId: null,
          values: { pDate001: { dynamic: 'now', days: 7 } },
          when: null,
        },
      ],
    }),
  },
  {
    name: 'every month on the 31st, a group is told',
    rule: given({
      trigger: { kind: 'schedule', every: 'month', at: '23:59', day: 31, weekday: 3 },
      steps: [{ kind: 'notify', groups: [GROUP], message: 'Month end' }],
    }),
    expected: kept({
      trigger: { kind: 'schedule', every: 'month', at: '23:59', weekday: null, day: 31 },
      steps: [
        {
          kind: 'notify',
          people: [],
          groups: [GROUP],
          personProperties: [],
          message: 'Month end',
          when: null,
        },
      ],
    }),
  },
  {
    name: 'a button sets its owner to whoever pressed it, under conditions, and a step under its own',
    rule: given({
      trigger: { kind: 'button', propertyId: 'pBtn0001' },
      conditions: {
        kind: 'group',
        op: 'and',
        children: [
          { kind: 'condition', propertyId: 'pStat001', operator: 'isNot', value: 'sDone001' },
        ],
      },
      steps: [
        {
          kind: 'set',
          values: { pPers001: { dynamic: 'actor' }, pText001: null, title: 'Approved' },
        },
        {
          kind: 'notify',
          personProperties: ['pPers001'],
          message: '',
          when: {
            kind: 'group',
            op: 'or',
            children: [
              { kind: 'condition', propertyId: 'pNum0001', operator: 'gt', value: 10 },
              {
                kind: 'group',
                op: 'and',
                children: [
                  {
                    kind: 'condition',
                    propertyId: 'pDate001',
                    operator: 'before',
                    value: { relative: 'today' },
                  },
                ],
              },
            ],
          },
        },
      ],
    }),
    expected: kept({
      trigger: { kind: 'button', propertyId: 'pBtn0001' },
      conditions: {
        kind: 'group',
        op: 'and',
        children: [
          { kind: 'condition', propertyId: 'pStat001', operator: 'isNot', value: 'sDone001' },
        ],
      },
      steps: [
        {
          kind: 'set',
          values: { pPers001: { dynamic: 'actor' }, pText001: null, title: 'Approved' },
          when: null,
        },
        {
          kind: 'notify',
          people: [],
          groups: [],
          personProperties: ['pPers001'],
          message: '',
          when: {
            kind: 'group',
            op: 'or',
            children: [
              { kind: 'condition', propertyId: 'pNum0001', operator: 'gt', value: 10 },
              {
                kind: 'group',
                op: 'and',
                children: [
                  {
                    kind: 'condition',
                    propertyId: 'pDate001',
                    operator: 'before',
                    value: { relative: 'today' },
                  },
                ],
              },
            ],
          },
        },
      ],
    }),
  },
  {
    name: 'values of every stored kind, and a date span',
    rule: given({
      trigger: { kind: 'rowAdded' },
      enabled: false,
      steps: [
        {
          kind: 'set',
          values: {
            pNum0001: 3.5,
            pTick001: true,
            pTags001: ['tRed0001'],
            pWhen001: { start: '2026-03-01T10:00:00Z', end: null },
            pDate001: { start: '2026-03-01', end: '2026-03-04' },
          },
        },
      ],
    }),
    expected: kept({
      enabled: false,
      trigger: { kind: 'rowAdded' },
      steps: [
        {
          kind: 'set',
          values: {
            pNum0001: 3.5,
            pTick001: true,
            pTags001: ['tRed0001'],
            pWhen001: { start: '2026-03-01T10:00:00Z' },
            pDate001: { start: '2026-03-01', end: '2026-03-04' },
          },
          when: null,
        },
      ],
    }),
  },
  // Refused ------------------------------------------------------------------------------------
  { name: 'not an object', rule: 'rule', expected: refused('rule') },
  {
    name: 'another database',
    rule: given({ databaseId: DB2, trigger: { kind: 'rowAdded' }, steps: [SET_DONE] }),
    expected: refused('rule'),
  },
  {
    name: 'no id',
    rule: given({ id: 'r1', trigger: { kind: 'rowAdded' }, steps: [SET_DONE] }),
    expected: refused('rule'),
  },
  {
    name: 'on or off is a boolean',
    rule: given({ enabled: 1, trigger: { kind: 'rowAdded' }, steps: [SET_DONE] }),
    expected: refused('rule'),
  },
  {
    name: 'a name too long',
    rule: given({ name: 'n'.repeat(201), trigger: { kind: 'rowAdded' }, steps: [SET_DONE] }),
    expected: refused('name'),
  },
  { name: 'no trigger', rule: given({ steps: [SET_DONE] }), expected: refused('trigger') },
  {
    name: 'a trigger of no kind known',
    rule: given({ trigger: { kind: 'rowTrashed' }, steps: [SET_DONE] }),
    expected: refused('trigger'),
  },
  {
    name: 'a change of a formula is not watched',
    rule: given({
      trigger: { kind: 'propertyChanged', propertyId: 'pForm001' },
      steps: [SET_DONE],
    }),
    expected: refused('trigger.property'),
  },
  {
    name: 'a change of a deleted property is not watched',
    rule: given({
      trigger: { kind: 'propertyChanged', propertyId: 'pGone001' },
      steps: [SET_DONE],
    }),
    expected: refused('trigger.property'),
  },
  {
    name: 'from and to need their property',
    rule: given({
      trigger: { kind: 'propertyChanged', propertyId: null, to: { operator: 'isNotEmpty' } },
      steps: [SET_DONE],
    }),
    expected: refused('trigger'),
  },
  {
    name: 'a to of no operator known',
    rule: given({
      trigger: { kind: 'propertyChanged', propertyId: 'pStat001', to: { operator: 'was' } },
      steps: [SET_DONE],
    }),
    expected: refused('trigger'),
  },
  {
    name: 'a date trigger on text',
    rule: given({
      trigger: { kind: 'date', propertyId: 'pText001', offsetMinutes: 0 },
      steps: [SET_DONE],
    }),
    expected: refused('trigger.property'),
  },
  {
    name: 'an offset past 30 days',
    rule: given({
      trigger: { kind: 'date', propertyId: 'pDate001', offsetMinutes: 43201 },
      steps: [SET_DONE],
    }),
    expected: refused('trigger'),
  },
  {
    name: 'an offset of part of a minute',
    rule: given({
      trigger: { kind: 'date', propertyId: 'pDate001', offsetMinutes: 1.5 },
      steps: [SET_DONE],
    }),
    expected: refused('trigger'),
  },
  {
    name: 'a time of day past midnight',
    rule: given({
      trigger: { kind: 'date', propertyId: 'pDate001', offsetMinutes: 0, at: '24:00' },
      steps: [SET_DONE],
    }),
    expected: refused('trigger'),
  },
  {
    name: 'a weekly schedule with no day',
    rule: given({
      trigger: { kind: 'schedule', every: 'week', at: '09:00' },
      steps: [{ kind: 'notify', people: [ALICE], message: '' }],
    }),
    expected: refused('trigger'),
  },
  {
    name: 'a monthly schedule on day 0',
    rule: given({
      trigger: { kind: 'schedule', every: 'month', at: '09:00', day: 0 },
      steps: [{ kind: 'notify', people: [ALICE], message: '' }],
    }),
    expected: refused('trigger'),
  },
  {
    name: 'a yearly schedule',
    rule: given({
      trigger: { kind: 'schedule', every: 'year', at: '09:00' },
      steps: [{ kind: 'notify', people: [ALICE], message: '' }],
    }),
    expected: refused('trigger'),
  },
  {
    name: 'a button trigger on text',
    rule: given({ trigger: { kind: 'button', propertyId: 'pText001' }, steps: [SET_DONE] }),
    expected: refused('trigger.property'),
  },
  {
    name: 'conditions on a schedule',
    rule: given({
      trigger: { kind: 'schedule', every: 'day', at: '09:00' },
      conditions: { kind: 'group', op: 'and', children: [] },
      steps: [{ kind: 'notify', people: [ALICE], message: '' }],
    }),
    expected: refused('conditions'),
  },
  {
    name: 'conditions of no join known',
    rule: given({
      trigger: { kind: 'rowAdded' },
      conditions: { kind: 'group', op: 'xor', children: [] },
      steps: [SET_DONE],
    }),
    expected: refused('conditions'),
  },
  {
    name: 'conditions three levels deep',
    rule: given({
      trigger: { kind: 'rowAdded' },
      conditions: {
        kind: 'group',
        op: 'and',
        children: [
          { kind: 'group', op: 'or', children: [{ kind: 'group', op: 'and', children: [] }] },
        ],
      },
      steps: [SET_DONE],
    }),
    expected: refused('conditions'),
  },
  {
    name: 'no steps',
    rule: given({ trigger: { kind: 'rowAdded' }, steps: [] }),
    expected: refused('steps'),
  },
  {
    name: 'twenty-one steps',
    rule: given({
      trigger: { kind: 'rowAdded' },
      steps: Array.from({ length: 21 }, () => SET_DONE),
    }),
    expected: refused('steps'),
  },
  {
    name: 'a step of no kind known',
    rule: given({ trigger: { kind: 'rowAdded' }, steps: [{ kind: 'erpCommit' }] }),
    expected: refused('step.kind'),
  },
  {
    name: 'a schedule sets no row',
    rule: given({ trigger: { kind: 'schedule', every: 'day', at: '09:00' }, steps: [SET_DONE] }),
    expected: refused('step.kind'),
  },
  {
    name: 'a step under conditions on a schedule',
    rule: given({
      trigger: { kind: 'schedule', every: 'day', at: '09:00' },
      steps: [
        {
          kind: 'notify',
          people: [ALICE],
          message: '',
          when: { kind: 'group', op: 'and', children: [] },
        },
      ],
    }),
    expected: refused('step.when'),
  },
  {
    name: 'a set of nothing',
    rule: given({ trigger: { kind: 'rowAdded' }, steps: [{ kind: 'set', values: {} }] }),
    expected: refused('step.values'),
  },
  {
    name: 'a set of a formula',
    rule: given({
      trigger: { kind: 'rowAdded' },
      steps: [{ kind: 'set', values: { pForm001: 2 } }],
    }),
    expected: refused('step.values'),
  },
  {
    name: 'a set of a created time',
    rule: given({
      trigger: { kind: 'rowAdded' },
      steps: [{ kind: 'set', values: { pMade001: { dynamic: 'now' } } }],
    }),
    expected: refused('step.values'),
  },
  {
    name: 'a set of a property not there',
    rule: given({
      trigger: { kind: 'rowAdded' },
      steps: [{ kind: 'set', values: { pNone001: 'x' } }],
    }),
    expected: refused('step.values'),
  },
  {
    name: 'a set of a deleted property',
    rule: given({
      trigger: { kind: 'rowAdded' },
      steps: [{ kind: 'set', values: { pGone001: 'x' } }],
    }),
    expected: refused('step.values'),
  },
  {
    name: 'fifty-one values',
    rule: given({
      trigger: { kind: 'rowAdded' },
      steps: [
        {
          kind: 'addRow',
          databaseId: DB2,
          templateId: null,
          values: Object.fromEntries(
            Array.from({ length: 51 }, (_, i) => [`pV${String(i).padStart(6, '0')}`, 'x']),
          ),
        },
      ],
    }),
    expected: refused('step.values'),
  },
  {
    name: '"now" into a number',
    rule: given({
      trigger: { kind: 'rowAdded' },
      steps: [{ kind: 'set', values: { pNum0001: { dynamic: 'now' } } }],
    }),
    expected: refused('step.value'),
  },
  {
    name: '"who started it" into text',
    rule: given({
      trigger: { kind: 'rowAdded' },
      steps: [{ kind: 'set', values: { pText001: { dynamic: 'actor' } } }],
    }),
    expected: refused('step.value'),
  },
  {
    name: '"this row" on a schedule',
    rule: given({
      trigger: { kind: 'schedule', every: 'day', at: '09:00' },
      steps: [
        {
          kind: 'addRow',
          databaseId: DB2,
          templateId: null,
          values: { pRel0002: { dynamic: 'row' } },
        },
      ],
    }),
    expected: refused('step.value'),
  },
  {
    name: 'a value of no kind known',
    rule: given({
      trigger: { kind: 'rowAdded' },
      steps: [{ kind: 'set', values: { pText001: { dynamic: 'erp' } } }],
    }),
    expected: refused('step.value'),
  },
  {
    name: 'a title that is not text',
    rule: given({ trigger: { kind: 'rowAdded' }, steps: [{ kind: 'set', values: { title: 5 } }] }),
    expected: refused('step.value'),
  },
  {
    name: 'a notice to nobody',
    rule: given({ trigger: { kind: 'rowAdded' }, steps: [{ kind: 'notify', message: 'Hello' }] }),
    expected: refused('step.recipients'),
  },
  {
    name: 'a notice to the people of a text property',
    rule: given({
      trigger: { kind: 'rowAdded' },
      steps: [{ kind: 'notify', personProperties: ['pText001'], message: '' }],
    }),
    expected: refused('step.recipients'),
  },
  {
    name: 'a notice to a person who is not an id',
    rule: given({
      trigger: { kind: 'rowAdded' },
      steps: [{ kind: 'notify', people: ['alice'], message: '' }],
    }),
    expected: refused('step.recipients'),
  },
  {
    name: 'a notice too long',
    rule: given({
      trigger: { kind: 'rowAdded' },
      steps: [{ kind: 'notify', people: [ALICE], message: 'm'.repeat(1001) }],
    }),
    expected: refused('step.message'),
  },
  {
    name: 'a webhook not named',
    rule: given({
      trigger: { kind: 'rowAdded' },
      steps: [{ kind: 'webhook', webhookId: 'hook', properties: [] }],
    }),
    expected: refused('step.webhook'),
  },
  {
    name: 'a webhook sending a deleted property',
    rule: given({
      trigger: { kind: 'rowAdded' },
      steps: [{ kind: 'webhook', webhookId: HOOK, properties: ['pGone001'] }],
    }),
    expected: refused('step.webhook'),
  },
  {
    name: 'a new row in no database',
    rule: given({
      trigger: { kind: 'rowAdded' },
      steps: [{ kind: 'addRow', databaseId: 'db', templateId: null, values: {} }],
    }),
    expected: refused('step.database'),
  },
  {
    name: 'a rule too large',
    rule: given({
      trigger: { kind: 'rowAdded' },
      steps: Array.from({ length: 3 }, () => ({
        kind: 'addRow',
        databaseId: DB2,
        templateId: null,
        values: Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [`pV${String(i).padStart(6, '0')}`, big]),
        ),
      })),
    }),
    expected: refused('size'),
  },
];

const added: RowChange = { kind: 'added', changed: [], before: {}, after: {} };
const changed = (
  ids: string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): RowChange => ({ kind: 'changed', changed: ids, before, after }) as RowChange;
const watch = (propertyId: string | null, sides: Record<string, unknown> = {}) => ({
  kind: 'propertyChanged',
  propertyId,
  ...sides,
});

const starts: StartCase[] = [
  {
    name: 'a row added starts rowAdded',
    trigger: { kind: 'rowAdded' },
    change: added,
    expected: true,
  },
  {
    name: 'a change does not start rowAdded',
    trigger: { kind: 'rowAdded' },
    change: changed(['pStat001'], {}, { pStat001: 'sDone001' }),
    expected: false,
  },
  {
    name: 'any property: a status changed',
    trigger: watch(null),
    change: changed(['pStat001'], { pStat001: 'sTodo001' }, { pStat001: 'sDone001' }),
    expected: true,
  },
  {
    name: 'any property: the title changed',
    trigger: watch(null),
    change: changed(['title'], { title: 'a' }, { title: 'b' }),
    expected: true,
  },
  {
    name: 'any property: a formula moved, nothing else',
    trigger: watch(null),
    change: changed(['pForm001'], {}, {}),
    expected: false,
  },
  {
    name: 'any property: a deleted property changed',
    trigger: watch(null),
    change: changed(['pGone001'], {}, { pGone001: 'x' }),
    expected: false,
  },
  { name: 'any property: a row added', trigger: watch(null), change: added, expected: false },
  {
    name: 'status to Done: To do to Done',
    trigger: watch('pStat001', { to: { operator: 'is', value: 'sDone001' } }),
    change: changed(['pStat001'], { pStat001: 'sTodo001' }, { pStat001: 'sDone001' }),
    expected: true,
  },
  {
    name: 'status to Done: Done to To do',
    trigger: watch('pStat001', { to: { operator: 'is', value: 'sDone001' } }),
    change: changed(['pStat001'], { pStat001: 'sDone001' }, { pStat001: 'sTodo001' }),
    expected: false,
  },
  {
    name: 'status from To do to Done: Doing to Done',
    trigger: watch('pStat001', {
      from: { operator: 'is', value: 'sTodo001' },
      to: { operator: 'is', value: 'sDone001' },
    }),
    change: changed(['pStat001'], { pStat001: 'sDoin001' }, { pStat001: 'sDone001' }),
    expected: false,
  },
  {
    name: 'status from To do: To do to Doing',
    trigger: watch('pStat001', { from: { operator: 'is', value: 'sTodo001' } }),
    change: changed(['pStat001'], { pStat001: 'sTodo001' }, { pStat001: 'sDoin001' }),
    expected: true,
  },
  {
    name: 'status into its complete group',
    trigger: watch('pStat001', { to: { operator: 'group', value: 'complete' } }),
    change: changed(['pStat001'], { pStat001: 'sDoin001' }, { pStat001: 'sDone001' }),
    expected: true,
  },
  {
    name: 'status cleared, to empty',
    trigger: watch('pStat001', { to: { operator: 'isEmpty' } }),
    change: changed(['pStat001'], { pStat001: 'sDoin001' }, {}),
    expected: true,
  },
  {
    name: 'points to more than 10: 12',
    trigger: watch('pNum0001', { to: { operator: 'gt', value: 10 } }),
    change: changed(['pNum0001'], { pNum0001: 4 }, { pNum0001: 12 }),
    expected: true,
  },
  {
    name: 'points to more than 10: 5',
    trigger: watch('pNum0001', { to: { operator: 'gt', value: 10 } }),
    change: changed(['pNum0001'], { pNum0001: 4 }, { pNum0001: 5 }),
    expected: false,
  },
  {
    name: 'a title changed to one holding "urgent", in any case',
    trigger: watch('title', { to: { operator: 'contains', value: 'URGENT' } }),
    change: changed(['title'], { title: 'Fix' }, { title: 'Fix, urgent' }),
    expected: true,
  },
  {
    name: 'a checkbox ticked',
    trigger: watch('pTick001', { to: { operator: 'is', value: true } }),
    change: changed(['pTick001'], {}, { pTick001: true }),
    expected: true,
  },
  {
    name: 'a checkbox cleared, to ticked',
    trigger: watch('pTick001', { to: { operator: 'is', value: true } }),
    change: changed(['pTick001'], { pTick001: true }, {}),
    expected: false,
  },
  {
    name: 'a tag added, to holding Red',
    trigger: watch('pTags001', { to: { operator: 'contains', value: 'tRed0001' } }),
    change: changed(['pTags001'], {}, { pTags001: ['tRed0001'] }),
    expected: true,
  },
  {
    name: 'a due day changed to before today',
    trigger: watch('pDate001', { to: { operator: 'before', value: { relative: 'today' } } }),
    change: changed(['pDate001'], {}, { pDate001: { start: '2026-02-27' } }),
    expected: true,
  },
  {
    name: 'an owner changed to me',
    trigger: watch('pPers001', { to: { operator: 'contains', value: { me: true } } }),
    change: changed(['pPers001'], { pPers001: [BOB] }, { pPers001: [ALICE] }),
    expected: true,
  },
  {
    name: 'an operator that does not fit the type passes',
    trigger: watch('pText001', { to: { operator: 'gt', value: 3 } }),
    change: changed(['pText001'], {}, { pText001: 'x' }),
    expected: true,
  },
  {
    name: 'another property changed',
    trigger: watch('pStat001'),
    change: changed(['pNum0001'], {}, { pNum0001: 1 }),
    expected: false,
  },
  {
    name: 'a watched property deleted since',
    trigger: watch('pGone001'),
    change: changed(['pGone001'], {}, { pGone001: 'x' }),
    expected: false,
  },
  {
    name: 'its button pressed',
    trigger: { kind: 'button', propertyId: 'pBtn0001' },
    change: { kind: 'button', changed: [], before: {}, after: {}, propertyId: 'pBtn0001' },
    expected: true,
  },
  {
    name: 'another button pressed',
    trigger: { kind: 'button', propertyId: 'pBtn0001' },
    change: { kind: 'button', changed: [], before: {}, after: {}, propertyId: 'pBtn0002' },
    expected: false,
  },
  {
    name: 'a press is no change',
    trigger: watch(null),
    change: { kind: 'button', changed: [], before: {}, after: {}, propertyId: 'pBtn0001' },
    expected: false,
  },
  {
    name: 'a date is reached by time only',
    trigger: { kind: 'date', propertyId: 'pDate001', offsetMinutes: 0 },
    change: changed(['pDate001'], {}, { pDate001: { start: '2026-03-01' } }),
    expected: false,
  },
  {
    name: 'a schedule is reached by time only',
    trigger: { kind: 'schedule', every: 'day', at: '09:00' },
    change: added,
    expected: false,
  },
];

export const automationVectors: AutomationVectors = {
  database: { ...database(props), workspaceId: WS },
  ctx: { today: '2026-03-01', offsetMinutes: 0, me: ALICE },
  check,
  starts,
};
