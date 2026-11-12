// db-query-vectors.json: filter, sort, group and search, as `queryRows` evaluates them. Suites of
// one database and its rows, each case a query spec and context with the hand-written rows (ids,
// in order) and groups it must give.
import type {
  FilterCondition,
  FilterGroup,
  GroupCount,
  GroupRule,
  QueryContext,
  QuerySpec,
  SortRule,
} from '../types';
import {
  ALICE,
  BOB,
  DB,
  P,
  SAMI,
  STATUS_OPTIONS,
  TITLE,
  database,
  prop,
  row,
  rowId,
  status,
  type VectorDatabase,
  type VectorRow,
} from './fixtures';

export interface QueryCase {
  name: string;
  spec: QuerySpec;
  ctx: QueryContext;
  groupKey?: string;
  expected: { rows: string[]; groups: GroupCount[] | null };
}

export interface QuerySuite {
  name: string;
  database: VectorDatabase;
  rows: VectorRow[];
  cases: QueryCase[];
}

const PEOPLE = { [ALICE]: 'Alice', [BOB]: 'bob', [SAMI]: 'سامي' };
const CTX: QueryContext = { today: '2026-03-01', offsetMinutes: 0, me: ALICE, people: PEOPLE };

const WHEN = prop('pWhen001', 'date', { date: { includeTime: true } }, 'When');
const F_NUMBER = prop(
  'pFor0001',
  'formula',
  { formula: { expression: 'prop("pNum0001") * 2' } },
  'Double',
);
const F_TEXT = prop(
  'pFtx0001',
  'formula',
  { formula: { expression: 'prop("pText001") + "!"' } },
  'Loud',
);
const F_BOOL = prop(
  'pFbo0001',
  'formula',
  { formula: { expression: 'prop("pNum0001") > 2' } },
  'Big',
);
const F_DATE = prop(
  'pFdt0001',
  'formula',
  { formula: { expression: 'prop("pDate001")' } },
  'Due again',
);
const OLD = prop('pOld0001', 'text', { trashedAt: '2026-02-01T00:00:00.000Z' }, 'Old');

const MAIN = database([
  TITLE,
  P.text,
  P.number,
  P.date,
  WHEN,
  P.checkbox,
  P.select,
  P.status,
  P.multi,
  P.person,
  P.files,
  P.relation,
  P.url,
  P.created,
  P.createdBy,
  P.edited,
  P.editedBy,
  F_NUMBER,
  F_TEXT,
  F_BOOL,
  F_DATE,
  P.rollup,
  OLD,
]);

const MAIN_ROWS: VectorRow[] = [
  row(1, {
    title: 'Alpha report',
    orderKey: 'a1',
    createdAt: '2026-01-01T09:00:00.000Z',
    createdBy: ALICE,
    values: {
      pText001: 'Café déjà vu',
      pNum0001: 10,
      pDate001: { start: '2026-03-01' },
      pWhen001: { start: '2026-03-01T22:30:00Z' },
      pChk0001: true,
      pSel0001: 'optDone1',
      pSta0001: 'staDone1',
      pMul0001: ['tagRed01', 'tagBlue1'],
      pPer0001: [ALICE],
      pFil0001: ['asset-f1'],
      pRel0001: [rowId(90)],
      pUrl0001: 'https://a.example',
      pOld0001: 'zzz',
    },
    computed: {
      pFor0001: 20,
      pFtx0001: 'Café déjà vu!',
      pFbo0001: true,
      pFdt0001: { start: '2026-03-01' },
      pRol0001: 5,
    },
  }),
  row(2, {
    title: 'beta',
    orderKey: 'a2',
    createdAt: '2026-01-01T23:30:00.000Z',
    createdBy: BOB,
    values: {
      pText001: 'المَبيعات اليومية',
      pNum0001: 2.5,
      pDate001: { start: '2026-03-05', end: '2026-03-07' },
      pWhen001: { start: '2026-03-02T01:00:00Z' },
      pSel0001: 'optTodo1',
      pSta0001: 'staProg1',
      pMul0001: ['tagBlue1'],
      pPer0001: [BOB, ALICE],
    },
    computed: {
      pFor0001: 5,
      pFtx0001: 'المَبيعات اليومية!',
      pFbo0001: true,
      pFdt0001: { start: '2026-03-05', end: '2026-03-07' },
      pRol0001: { error: 'formula.type' },
    },
  }),
  row(3, {
    title: 'Gamma',
    orderKey: 'a3',
    createdAt: '2026-01-03T00:00:00.000Z',
    createdBy: null,
    values: {
      pNum0001: -1,
      pWhen001: { start: '2026-03-02' },
      pSel0001: 'optGone1',
      pMul0001: ['tagGone1'],
    },
    computed: { pFor0001: -2, pFtx0001: '!', pFbo0001: false, pFdt0001: null, pRol0001: 0 },
  }),
  row(4, {
    title: 'أحمد والمبيعات',
    orderKey: 'a4',
    createdAt: '2025-12-31T23:59:59.000Z',
    createdBy: SAMI,
    values: {
      pText001: 'تقرير',
      pNum0001: 10,
      pDate001: { start: '2026-02-28' },
      pChk0001: true,
      pSel0001: 'optLate1',
      pSta0001: 'staTodo1',
      pMul0001: ['tagAr001', 'tagRed01'],
      pPer0001: [SAMI],
    },
    computed: { pFor0001: 20, pFtx0001: 'تقرير!', pFbo0001: true },
  }),
  row(5, {
    title: '',
    orderKey: 'a5',
    createdAt: '2026-01-02T12:00:00.000Z',
    createdBy: ALICE,
    values: { pDate001: { start: '2026-03-01' }, pSel0001: 'optDone1', pSta0001: 'staDone1' },
    computed: { pFtx0001: '!' },
  }),
  row(6, {
    title: 'Template',
    orderKey: 'a6',
    isTemplate: true,
    values: { pNum0001: 1, pText001: 'cafe' },
  }),
  row(7, {
    title: 'Trashed',
    orderKey: 'a7',
    trashedAt: '2026-02-15T00:00:00.000Z',
    values: { pNum0001: 1, pText001: 'cafe' },
  }),
  row(8, {
    title: 'delta',
    orderKey: 'a1',
    createdAt: '2026-01-01T09:00:00.000Z',
    createdBy: BOB,
    values: {
      pNum0001: 2.5,
      pDate001: { start: '2026-03-31' },
      pSel0001: 'optTodo1',
      pMul0001: ['tagRed01'],
      pPer0001: [ALICE],
    },
    computed: { pFor0001: 5, pFtx0001: '!', pFbo0001: true, pRol0001: 12 },
  }),
];

const ids = (...ns: number[]) => ns.map(rowId);
const ALL = ids(1, 8, 2, 3, 4, 5);

const cond = (
  propertyId: string,
  operator: FilterCondition['operator'],
  value?: FilterCondition['value'],
): FilterCondition =>
  value === undefined
    ? { kind: 'condition', propertyId, operator }
    : { kind: 'condition', propertyId, operator, value };
const and = (...children: (FilterGroup | FilterCondition)[]): FilterGroup => ({
  kind: 'group',
  op: 'and',
  children,
});
const or = (...children: (FilterGroup | FilterCondition)[]): FilterGroup => ({
  kind: 'group',
  op: 'or',
  children,
});
const asc = (propertyId: string): SortRule => ({ propertyId, direction: 'asc' });
const desc = (propertyId: string): SortRule => ({ propertyId, direction: 'desc' });

interface Q {
  filter?: FilterGroup | FilterCondition;
  sorts?: SortRule[];
  group?: GroupRule;
  search?: string;
  ctx?: Partial<QueryContext>;
  groupKey?: string;
}

function q(name: string, query: Q, rows: string[], groups: GroupCount[] | null = null): QueryCase {
  const spec: QuerySpec = {
    filter:
      query.filter === undefined
        ? null
        : query.filter.kind === 'group'
          ? query.filter
          : and(query.filter),
    sorts: query.sorts ?? [],
    group: query.group ?? null,
  };
  if (query.search !== undefined) spec.search = query.search;
  const c: QueryCase = { name, spec, ctx: { ...CTX, ...query.ctx }, expected: { rows, groups } };
  if (query.groupKey !== undefined) c.groupKey = query.groupKey;
  return c;
}

const g = (key: string, count: number): GroupCount => ({ key, count });
const SELECT_GROUPS = [
  g('', 1),
  g('optTodo1', 2),
  g('optDone1', 2),
  g('optLate1', 1),
  g('optFive1', 0),
];

const mainCases: QueryCase[] = [
  q('no filter or sort: order key, then id; no templates or trashed rows', {}, ALL),
  // text
  q('text contains, accents folded', { filter: cond('pText001', 'contains', 'cafe') }, ids(1)),
  q(
    'text contains, Arabic marks folded',
    { filter: cond('pText001', 'contains', 'المبيعات') },
    ids(2),
  ),
  q('text is, case and accents folded', { filter: cond('pText001', 'is', 'CAFÉ DÉJÀ VU') }, ids(1)),
  q(
    'text is not, empty cells pass',
    { filter: cond('pText001', 'isNot', 'cafe deja vu') },
    ids(8, 2, 3, 4, 5),
  ),
  q(
    'text does not contain',
    { filter: cond('pText001', 'doesNotContain', 'a') },
    ids(8, 2, 3, 4, 5),
  ),
  q('text starts with, Arabic', { filter: cond('pText001', 'startsWith', 'تقر') }, ids(4)),
  q('text ends with', { filter: cond('pText001', 'endsWith', 'vu') }, ids(1)),
  q('text is empty', { filter: cond('pText001', 'isEmpty') }, ids(8, 3, 5)),
  q('text is not empty', { filter: cond('pText001', 'isNotEmpty') }, ids(1, 2, 4)),
  q('text with an empty value is ignored', { filter: cond('pText001', 'contains', '') }, ALL),
  q(
    'text with a value that normalises to nothing is ignored',
    { filter: cond('pText001', 'contains', '!!!') },
    ALL,
  ),
  q(
    'title contains, alef and hamza folded',
    { filter: cond('title', 'contains', 'المبيعات') },
    ids(4),
  ),
  q('title is', { filter: cond('title', 'is', 'ALPHA REPORT') }, ids(1)),
  q('url contains', { filter: cond('pUrl0001', 'contains', 'example') }, ids(1)),
  // number
  q('number equals', { filter: cond('pNum0001', 'eq', 10) }, ids(1, 4)),
  q('number not equal, empty cells pass', { filter: cond('pNum0001', 'ne', 10) }, ids(8, 2, 3, 5)),
  q('number greater', { filter: cond('pNum0001', 'gt', 2.5) }, ids(1, 4)),
  q('number at least', { filter: cond('pNum0001', 'ge', 2.5) }, ids(1, 8, 2, 4)),
  q('number less', { filter: cond('pNum0001', 'lt', 0) }, ids(3)),
  q('number at most', { filter: cond('pNum0001', 'le', 2.5) }, ids(8, 2, 3)),
  q('number is empty', { filter: cond('pNum0001', 'isEmpty') }, ids(5)),
  q('number value as text', { filter: cond('pNum0001', 'eq', '10') }, ids(1, 4)),
  q('number value that does not read is ignored', { filter: cond('pNum0001', 'eq', 'x') }, ALL),
  q('number with no value is ignored', { filter: cond('pNum0001', 'gt') }, ALL),
  // date
  q('date is', { filter: cond('pDate001', 'is', { date: '2026-03-01' }) }, ids(1, 5)),
  q('date before today', { filter: cond('pDate001', 'before', { relative: 'today' }) }, ids(4)),
  q(
    'date after today, a span by its start',
    { filter: cond('pDate001', 'after', { relative: 'today' }) },
    ids(8, 2),
  ),
  q(
    'date on or after tomorrow',
    { filter: cond('pDate001', 'onOrAfter', { relative: 'tomorrow' }) },
    ids(8, 2),
  ),
  q(
    'date on or before yesterday',
    { filter: cond('pDate001', 'onOrBefore', { relative: 'yesterday' }) },
    ids(4),
  ),
  q(
    'date is a week from now',
    { filter: cond('pDate001', 'is', { relative: 'oneWeekFromNow' }) },
    [],
  ),
  q(
    'date after a month ago',
    { filter: cond('pDate001', 'after', { relative: 'oneMonthAgo' }) },
    ids(1, 8, 2, 4, 5),
  ),
  q(
    'date before a month from now',
    { filter: cond('pDate001', 'before', { relative: 'oneMonthFromNow' }) },
    ids(1, 8, 2, 4, 5),
  ),
  q(
    'date a week ago, from a month end',
    {
      filter: cond('pDate001', 'is', { relative: 'oneWeekAgo' }),
      ctx: { today: '2026-03-07' },
    },
    ids(4),
  ),
  q(
    'date a month ago clamps the day',
    {
      filter: cond('pDate001', 'is', { relative: 'oneMonthAgo' }),
      ctx: { today: '2026-03-31' },
    },
    ids(4),
  ),
  q('date is empty', { filter: cond('pDate001', 'isEmpty') }, ids(3)),
  q('date value as text', { filter: cond('pDate001', 'is', '2026-03-01') }, ids(1, 5)),
  q(
    'date value that does not read is ignored',
    { filter: cond('pDate001', 'is', { date: 'soon' }) },
    ALL,
  ),
  q(
    'date-time read as a date in UTC',
    { filter: cond('pWhen001', 'is', { date: '2026-03-01' }) },
    ids(1),
  ),
  q(
    'date-time read as a date three hours east',
    {
      filter: cond('pWhen001', 'is', { date: '2026-03-02' }),
      ctx: { offsetMinutes: 180 },
    },
    ids(1, 2, 3),
  ),
  q(
    'date-time read as a date five hours west',
    {
      filter: cond('pWhen001', 'is', { date: '2026-03-01' }),
      ctx: { offsetMinutes: -300 },
    },
    ids(1, 2),
  ),
  q(
    'created time read as a date an hour east',
    {
      filter: cond('pCrt0001', 'is', { date: '2026-01-02' }),
      ctx: { offsetMinutes: 60 },
    },
    ids(2, 5),
  ),
  // checkbox
  q('checkbox is true', { filter: cond('pChk0001', 'is', true) }, ids(1, 4)),
  q('checkbox is false', { filter: cond('pChk0001', 'is', false) }, ids(8, 2, 3, 5)),
  q('checkbox with a text value is ignored', { filter: cond('pChk0001', 'is', 'true') }, ALL),
  q('checkbox is empty does not fit and is ignored', { filter: cond('pChk0001', 'isEmpty') }, ALL),
  // select, status
  q('select is', { filter: cond('pSel0001', 'is', 'optDone1') }, ids(1, 5)),
  q(
    'select is not, empty cells pass',
    { filter: cond('pSel0001', 'isNot', 'optDone1') },
    ids(8, 2, 3, 4),
  ),
  q(
    'select is empty: a deleted option reads as empty',
    { filter: cond('pSel0001', 'isEmpty') },
    ids(3),
  ),
  q('select is a deleted option: nothing', { filter: cond('pSel0001', 'is', 'optGone1') }, []),
  q('status group complete', { filter: cond('pSta0001', 'group', 'complete') }, ids(1, 5)),
  q('status group to do', { filter: cond('pSta0001', 'group', 'todo') }, ids(4)),
  q('status unknown group is ignored', { filter: cond('pSta0001', 'group', 'nope') }, ALL),
  q('status is', { filter: cond('pSta0001', 'is', 'staProg1') }, ids(2)),
  // lists
  q('multi-select contains', { filter: cond('pMul0001', 'contains', 'tagRed01') }, ids(1, 8, 4)),
  q(
    'multi-select does not contain',
    { filter: cond('pMul0001', 'doesNotContain', 'tagRed01') },
    ids(2, 3, 5),
  ),
  q(
    'multi-select is empty: deleted options read as empty',
    { filter: cond('pMul0001', 'isEmpty') },
    ids(3, 5),
  ),
  q('person contains me', { filter: cond('pPer0001', 'contains', { me: true }) }, ids(1, 8, 2)),
  q(
    'person contains me, nobody asking',
    {
      filter: cond('pPer0001', 'contains', { me: true }),
      ctx: { me: null },
    },
    [],
  ),
  q(
    'person does not contain me',
    { filter: cond('pPer0001', 'doesNotContain', { me: true }) },
    ids(3, 4, 5),
  ),
  q('created by contains', { filter: cond('pCrb0001', 'contains', BOB) }, ids(8, 2)),
  q('edited by contains', { filter: cond('pEdb0001', 'contains', ALICE) }, ALL),
  q('files is not empty', { filter: cond('pFil0001', 'isNotEmpty') }, ids(1)),
  q(
    'files contains does not fit and is ignored',
    { filter: cond('pFil0001', 'contains', 'asset-f1') },
    ALL,
  ),
  q('relation is empty', { filter: cond('pRel0001', 'isEmpty') }, ids(8, 2, 3, 4, 5)),
  // formulas and rollups, by the server's results
  q('number formula greater', { filter: cond('pFor0001', 'gt', 10) }, ids(1, 4)),
  q('number formula is empty', { filter: cond('pFor0001', 'isEmpty') }, ids(5)),
  q('boolean formula is true', { filter: cond('pFbo0001', 'is', true) }, ids(1, 8, 2, 4)),
  q('boolean formula is false', { filter: cond('pFbo0001', 'is', false) }, ids(3)),
  q('text formula contains', { filter: cond('pFtx0001', 'contains', 'cafe') }, ids(1)),
  q(
    'date formula is, a span by its start',
    { filter: cond('pFdt0001', 'is', { date: '2026-03-05' }) },
    ids(2),
  ),
  q('rollup at least', { filter: cond('pRol0001', 'ge', 5) }, ids(1, 8)),
  q(
    'rollup is empty: an error reads as empty',
    { filter: cond('pRol0001', 'isEmpty') },
    ids(2, 4, 5),
  ),
  // ignored conditions
  q('a deleted property is ignored', { filter: cond('pOld0001', 'contains', 'zzz') }, ALL),
  q('an unknown property is ignored', { filter: cond('nothere1', 'is', 'x') }, ALL),
  q('an operator that does not fit is ignored', { filter: cond('pText001', 'gt', 5) }, ALL),
  // groups of conditions
  q('and', { filter: and(cond('pNum0001', 'ge', 2.5), cond('pChk0001', 'is', true)) }, ids(1, 4)),
  q('or', { filter: or(cond('pSel0001', 'is', 'optLate1'), cond('pNum0001', 'lt', 0)) }, ids(3, 4)),
  q(
    'or leaves an ignored condition out',
    {
      filter: or(cond('pSel0001', 'is', 'optLate1'), cond('pOld0001', 'contains', 'x')),
    },
    ids(4),
  ),
  q('and with an empty group', { filter: and(cond('pNum0001', 'eq', 10), or()) }, ids(1, 4)),
  q('or of only an empty group matches every row', { filter: or(or()) }, ALL),
  q(
    'nested groups',
    {
      filter: and(
        cond('pChk0001', 'is', true),
        or(cond('pText001', 'contains', 'cafe'), cond('pText001', 'startsWith', 'تق')),
      ),
    },
    ids(1, 4),
  ),
  q('an empty filter matches every row', { filter: and() }, ALL),
  // search
  q('search a word start', { search: 'alp' }, ids(1)),
  q('search every word must start a word', { search: 'rep alp' }, ids(1)),
  q('search inside a word does not match', { search: 'port' }, []),
  q('search Arabic: words start after a prefix only if typed', { search: 'المبيع' }, []),
  q('search Arabic with the prefix', { search: 'والمب' }, ids(4)),
  q('search Arabic alef folded', { search: 'أحمد' }, ids(4)),
  q('search nothing', { search: '' }, ALL),
  q('search with a filter', { search: 'a', filter: cond('pNum0001', 'ge', 0) }, ids(1)),
  // sorts
  q(
    'number ascending, ties by order key, empty last',
    { sorts: [asc('pNum0001')] },
    ids(3, 8, 2, 1, 4, 5),
  ),
  q(
    'number descending, ties still by order key, empty last',
    { sorts: [desc('pNum0001')] },
    ids(1, 4, 8, 2, 3, 5),
  ),
  q(
    'text ascending: ordinal of the normalised text',
    { sorts: [asc('pText001')] },
    ids(1, 2, 4, 8, 3, 5),
  ),
  q('text descending', { sorts: [desc('pText001')] }, ids(4, 2, 1, 8, 3, 5)),
  q('title ascending, empty title last', { sorts: [asc('title')] }, ids(1, 2, 8, 3, 4, 5)),
  q('date ascending', { sorts: [asc('pDate001')] }, ids(4, 1, 5, 2, 8, 3)),
  q('date descending', { sorts: [desc('pDate001')] }, ids(8, 2, 1, 5, 4, 3)),
  q(
    'date-time ascending, a date at its midnight in UTC',
    { sorts: [asc('pWhen001')] },
    ids(1, 3, 2, 8, 4, 5),
  ),
  q(
    'date-time ascending, a date at its midnight three hours east',
    {
      sorts: [asc('pWhen001')],
      ctx: { offsetMinutes: 180 },
    },
    ids(3, 1, 2, 8, 4, 5),
  ),
  q('checkbox ascending: false first', { sorts: [asc('pChk0001')] }, ids(8, 2, 3, 5, 1, 4)),
  q('checkbox descending', { sorts: [desc('pChk0001')] }, ids(1, 4, 8, 2, 3, 5)),
  q(
    'select by option position, deleted option empty',
    { sorts: [asc('pSel0001')] },
    ids(8, 2, 1, 5, 4, 3),
  ),
  q('status by group then position', { sorts: [asc('pSta0001')] }, ids(4, 2, 1, 5, 8, 3)),
  q('multi-select by its option positions', { sorts: [asc('pMul0001')] }, ids(8, 1, 2, 4, 3, 5)),
  q('person by name', { sorts: [asc('pPer0001')] }, ids(1, 8, 2, 4, 3, 5)),
  q('person by name descending', { sorts: [desc('pPer0001')] }, ids(4, 2, 1, 8, 3, 5)),
  q(
    'person by other names',
    {
      sorts: [asc('pPer0001')],
      ctx: { people: { ...PEOPLE, [BOB]: 'Aaron' } },
    },
    ids(2, 1, 8, 4, 3, 5),
  ),
  q('files by count', { sorts: [asc('pFil0001')] }, ids(1, 8, 2, 3, 4, 5)),
  q('created time', { sorts: [asc('pCrt0001')] }, ids(4, 1, 8, 2, 5, 3)),
  q('created by name', { sorts: [asc('pCrb0001')] }, ids(1, 5, 8, 2, 4, 3)),
  q('number formula descending', { sorts: [desc('pFor0001')] }, ids(1, 4, 8, 2, 3, 5)),
  q('rollup ascending, error empty', { sorts: [asc('pRol0001')] }, ids(3, 1, 8, 2, 4, 5)),
  q('boolean formula ascending', { sorts: [asc('pFbo0001')] }, ids(3, 1, 8, 2, 4, 5)),
  q('two rules', { sorts: [desc('pChk0001'), asc('pNum0001')] }, ids(1, 4, 3, 8, 2, 5)),
  q('a rule on a deleted property is skipped', { sorts: [asc('pOld0001')] }, ALL),
  q('a rule on an unknown property is skipped', { sorts: [desc('nothere1')] }, ALL),
  // groups
  q(
    'group by select: every option, no value first',
    { group: { propertyId: 'pSel0001' } },
    ALL,
    SELECT_GROUPS,
  ),
  q(
    'group by select, empty groups hidden',
    {
      group: { propertyId: 'pSel0001', hideEmpty: true },
    },
    ALL,
    [g('', 1), g('optTodo1', 2), g('optDone1', 2), g('optLate1', 1)],
  ),
  q(
    'group by select, groups hidden and their rows left out',
    {
      group: { propertyId: 'pSel0001', hidden: ['optDone1', ''] },
    },
    ids(8, 2, 4),
    [g('optTodo1', 2), g('optLate1', 1), g('optFive1', 0)],
  ),
  q(
    'one group by key',
    { group: { propertyId: 'pSel0001' }, groupKey: 'optDone1' },
    ids(1, 5),
    SELECT_GROUPS,
  ),
  q(
    'the no-value group by key',
    { group: { propertyId: 'pSel0001' }, groupKey: '' },
    ids(3),
    SELECT_GROUPS,
  ),
  q(
    'group by multi-select: a row in every group it holds',
    {
      group: { propertyId: 'pMul0001' },
    },
    ALL,
    [g('', 2), g('tagRed01', 3), g('tagBlue1', 2), g('tagAr001', 1)],
  ),
  q(
    'group by multi-select, one hidden',
    {
      group: { propertyId: 'pMul0001', hidden: ['tagRed01'] },
    },
    ids(1, 2, 3, 4, 5),
    [g('', 2), g('tagBlue1', 2), g('tagAr001', 1)],
  ),
  q('group by checkbox', { group: { propertyId: 'pChk0001' } }, ALL, [g('false', 4), g('true', 2)]),
  q(
    'group by checkbox, false hidden',
    {
      group: { propertyId: 'pChk0001', hidden: ['false'] },
    },
    ids(1, 4),
    [g('true', 2)],
  ),
  q('group by status, def order', { group: { propertyId: 'pSta0001' } }, ALL, [
    g('', 2),
    g('staTodo1', 1),
    g('staProg1', 1),
    g('staDone1', 2),
  ]),
  q('group by person, by name', { group: { propertyId: 'pPer0001' } }, ALL, [
    g('', 2),
    g(ALICE, 3),
    g(BOB, 1),
    g(SAMI, 1),
  ]),
  q(
    'group by person, other names',
    {
      group: { propertyId: 'pPer0001' },
      ctx: { people: { ...PEOPLE, [BOB]: 'Aaron' } },
    },
    ALL,
    [g('', 2), g(BOB, 1), g(ALICE, 3), g(SAMI, 1)],
  ),
  q('group by date, day', { group: { propertyId: 'pDate001', dateBy: 'day' } }, ALL, [
    g('', 1),
    g('2026-02-28', 1),
    g('2026-03-01', 2),
    g('2026-03-05', 1),
    g('2026-03-31', 1),
  ]),
  q('group by date, week: its Monday', { group: { propertyId: 'pDate001', dateBy: 'week' } }, ALL, [
    g('', 1),
    g('2026-02-23', 3),
    g('2026-03-02', 1),
    g('2026-03-30', 1),
  ]),
  q('group by date, month by default', { group: { propertyId: 'pDate001' } }, ALL, [
    g('', 1),
    g('2026-02-01', 1),
    g('2026-03-01', 4),
  ]),
  q('group by date, year', { group: { propertyId: 'pDate001', dateBy: 'year' } }, ALL, [
    g('', 1),
    g('2026-01-01', 5),
  ]),
  q(
    'group by date-time, day, three hours east',
    {
      group: { propertyId: 'pWhen001', dateBy: 'day' },
      ctx: { offsetMinutes: 180 },
    },
    ALL,
    [g('', 3), g('2026-03-02', 3)],
  ),
  q('group by created time, day', { group: { propertyId: 'pCrt0001', dateBy: 'day' } }, ALL, [
    g('', 0),
    g('2025-12-31', 1),
    g('2026-01-01', 3),
    g('2026-01-02', 1),
    g('2026-01-03', 1),
  ]),
  q('group by created by', { group: { propertyId: 'pCrb0001' } }, ALL, [
    g('', 1),
    g(ALICE, 2),
    g(BOB, 2),
    g(SAMI, 1),
  ]),
  q('group on text is ignored', { group: { propertyId: 'pText001' } }, ALL, null),
  q('group on a deleted property is ignored', { group: { propertyId: 'pOld0001' } }, ALL, null),
  q(
    'group counts are over the filtered rows',
    {
      filter: cond('pNum0001', 'ge', 2.5),
      group: { propertyId: 'pSel0001' },
    },
    ids(1, 8, 2, 4),
    [g('', 0), g('optTodo1', 2), g('optDone1', 1), g('optLate1', 1), g('optFive1', 0)],
  ),
  q(
    'group counts over the filtered rows, empty hidden',
    {
      filter: cond('pNum0001', 'ge', 2.5),
      group: { propertyId: 'pSel0001', hideEmpty: true },
    },
    ids(1, 8, 2, 4),
    [g('optTodo1', 2), g('optDone1', 1), g('optLate1', 1)],
  ),
  q(
    'group with a sort keeps the sort',
    {
      sorts: [desc('pNum0001')],
      group: { propertyId: 'pSel0001' },
    },
    ids(1, 4, 8, 2, 3, 5),
    SELECT_GROUPS,
  ),
];

const REORDERED = database([
  TITLE,
  prop(
    'pSta0001',
    'status',
    {
      options: [status('staDone1', 'Done', 'complete'), STATUS_OPTIONS[0], STATUS_OPTIONS[1]],
    },
    'Status',
  ),
]);
const S = (n: number, value?: string) =>
  row(n, { title: `s${n}`, orderKey: `a${n - 20}`, values: value ? { pSta0001: value } : {} });
const STATUS_ROWS = [S(21, 'staDone1'), S(22, 'staTodo1'), S(23, 'staProg1'), S(24)];

const statusCases: QueryCase[] = [
  q(
    'status sorts by group, whatever the def order',
    { sorts: [asc('pSta0001')] },
    ids(22, 23, 21, 24),
  ),
  q('status descending', { sorts: [desc('pSta0001')] }, ids(21, 23, 22, 24)),
  q('status groups in def order', { group: { propertyId: 'pSta0001' } }, ids(21, 22, 23, 24), [
    g('', 1),
    g('staDone1', 1),
    g('staTodo1', 1),
    g('staProg1', 1),
  ]),
  q('status group filter', { filter: cond('pSta0001', 'group', 'inProgress') }, ids(23)),
];

const T = (n: number, title: string) => row(n, { title, orderKey: `a${n - 30}` });
const TEXT_ROWS = [
  T(31, 'b'),
  T(32, 'B'),
  T(33, 'a10'),
  T(34, 'a9'),
  T(35, '١٢'),
  T(36, 'Ä'),
  T(37, 'ـمرحبا'),
];

const textCases: QueryCase[] = [
  q(
    'titles in ordinal order of the normalised text',
    { sorts: [asc('title')] },
    ids(35, 36, 33, 34, 31, 32, 37),
  ),
  q(
    'titles descending, equal ones by order key',
    { sorts: [desc('title')] },
    ids(37, 31, 32, 34, 33, 36, 35),
  ),
  q('title is, after folding', { filter: cond('title', 'is', 'b') }, ids(31, 32)),
  q('title with tatweel', { filter: cond('title', 'is', 'مرحبا') }, ids(37)),
  q('title with Arabic-Indic digits', { filter: cond('title', 'contains', '12') }, ids(35)),
];

export const queryVectors: QuerySuite[] = [
  { name: 'every property type', database: MAIN, rows: MAIN_ROWS, cases: mainCases },
  { name: 'status out of group order', database: REORDERED, rows: STATUS_ROWS, cases: statusCases },
  { name: 'text order', database: database([TITLE]), rows: TEXT_ROWS, cases: textCases },
];

export { DB };
