// db-csv-vectors.json: parsing, inferring a new database's properties (types and option names
// only: ids are new each time), a cell's text read as a value, and export.
import type { PropertyDef, Value, ViewConfig } from '../types';
import {
  ALICE,
  BOB,
  P,
  SAMI,
  TITLE,
  database,
  option,
  prop,
  row,
  rowId,
  type VectorDatabase,
  type VectorRow,
} from './fixtures';

export type CsvCase =
  | { kind: 'parse'; name: string; text: string; expected: string[][] }
  | {
      kind: 'infer';
      name: string;
      header: string[];
      rows: string[][];
      expected: {
        name: string;
        type: PropertyDef['type'];
        options?: string[];
        includeTime?: boolean;
      }[];
    }
  | { kind: 'textToValue'; name: string; def: PropertyDef; text: string; expected: Value | null }
  | {
      kind: 'export';
      name: string;
      database: VectorDatabase;
      view: { config: Pick<ViewConfig, 'properties'> };
      rows: VectorRow[];
      lookups: {
        people?: Record<string, string>;
        rows?: Record<string, string>;
        files?: Record<string, string>;
      };
      expected: string;
    };

const parse = (name: string, text: string, expected: string[][]): CsvCase => ({
  kind: 'parse',
  name,
  text,
  expected,
});

const parseCases: CsvCase[] = [
  parse('CRLF', 'a,b,c\r\n1,2,3\r\n', [
    ['a', 'b', 'c'],
    ['1', '2', '3'],
  ]),
  parse('LF, no last line break', 'a,b\n1,2', [
    ['a', 'b'],
    ['1', '2'],
  ]),
  parse('a BOM is dropped', '\uFEFFa,b\n1,2', [
    ['a', 'b'],
    ['1', '2'],
  ]),
  parse('quoted separators, quotes and line breaks', '"x, y","say ""hi""","line1\nline2"\n1,2,3', [
    ['x, y', 'say "hi"', 'line1\nline2'],
    ['1', '2', '3'],
  ]),
  parse('semicolons', 'a;b;c\n1;2;3', [
    ['a', 'b', 'c'],
    ['1', '2', '3'],
  ]),
  parse('tabs', 'a\tb\n1\t2', [
    ['a', 'b'],
    ['1', '2'],
  ]),
  parse('a tie goes to the comma', 'a,b;c\n', [['a', 'b;c']]),
  parse('separators in quotes do not count', '"a;b;c",d\n1,2', [
    ['a;b;c', 'd'],
    ['1', '2'],
  ]),
  parse('the most common separator wins', 'a;b;c,d\n', [['a', 'b', 'c,d']]),
  parse('only the first record counts', 'a\tb\tc\n1,2,3', [['a', 'b', 'c'], ['1,2,3']]),
  parse('empty lines are skipped', 'a,b\n\n1,2\n\n', [
    ['a', 'b'],
    ['1', '2'],
  ]),
  parse('a lone CR ends a record', 'a,b\r1,2\r', [
    ['a', 'b'],
    ['1', '2'],
  ]),
  parse('empty fields', 'a,,c\n,,\n', [
    ['a', '', 'c'],
    ['', '', ''],
  ]),
  parse('a trailing separator', 'a,b,\n', [['a', 'b', '']]),
  parse('ragged records stay ragged', 'a,b,c\n1\n1,2,3,4', [
    ['a', 'b', 'c'],
    ['1'],
    ['1', '2', '3', '4'],
  ]),
  parse('a quote inside a field is a character', 'ab"c,d', [['ab"c', 'd']]),
  parse('text after a closing quote is kept', '"ab"c,d', [['abc', 'd']]),
  parse('an unclosed quote runs to the end', '"abc\nd,e', [['abc\nd,e']]),
  parse('a quoted empty field is a record', '""\n', [['']]),
  parse('CRLF inside quotes is kept', '"a\r\nb",c\r\n', [['a\r\nb', 'c']]),
  parse('no separator at all', 'one\ntwo', [['one'], ['two']]),
  parse('Arabic', 'الاسم,المبلغ\nأحمد,١٢', [
    ['الاسم', 'المبلغ'],
    ['أحمد', '١٢'],
  ]),
  parse('nothing', '', []),
  parse('only a BOM', '\uFEFF', []),
];

const inferCases: CsvCase[] = [
  {
    kind: 'infer',
    name: 'every inferred type',
    header: ['Name', 'Amount', 'Done', 'Due', 'Site', 'Mail', 'Stage', 'Notes', 'Empty'],
    rows: [
      ['Alpha', '10', 'yes', '2026-03-01', 'https://a.example', 'a@b.co', 'Open', 'x', ''],
      ['Beta', '1,234.5', 'no', '2026-03-02', 'https://b.example', 'c@d.co', 'Open', 'y', ''],
      ['Gamma', '-3', 'true', '2026-03-03 10:00', 'http://c.example', 'e@f.co', 'Closed', 'z', ''],
      ['Delta', '٤', '0', '2026-03-04', 'HTTPS://D.EXAMPLE', 'g@h.co', 'Closed', 'w', '  '],
    ],
    expected: [
      { name: 'Name', type: 'title' },
      { name: 'Amount', type: 'number' },
      { name: 'Done', type: 'checkbox' },
      { name: 'Due', type: 'date', includeTime: true },
      { name: 'Site', type: 'url' },
      { name: 'Mail', type: 'email' },
      { name: 'Stage', type: 'select', options: ['Open', 'Closed'] },
      { name: 'Notes', type: 'text' },
      { name: 'Empty', type: 'text' },
    ],
  },
  {
    kind: 'infer',
    name: 'a select needs each value used twice on average',
    header: ['N', 'S'],
    rows: [
      ['a', 'red'],
      ['b', 'blue'],
      ['c', 'red'],
    ],
    expected: [
      { name: 'N', type: 'title' },
      { name: 'S', type: 'text' },
    ],
  },
  {
    kind: 'infer',
    name: 'ones and zeros are numbers',
    header: ['N', 'Flag'],
    rows: [
      ['a', '1'],
      ['b', '0'],
      ['c', '1'],
    ],
    expected: [
      { name: 'N', type: 'title' },
      { name: 'Flag', type: 'number' },
    ],
  },
  {
    kind: 'infer',
    name: 'dates without times, and spans',
    header: ['N', 'When'],
    rows: [
      ['a', '2026-01-01'],
      ['b', '2026-01-01 → 2026-01-05'],
    ],
    expected: [
      { name: 'N', type: 'title' },
      { name: 'When', type: 'date', includeTime: false },
    ],
  },
  {
    kind: 'infer',
    name: 'columns past the header and with no name',
    header: ['', '  '],
    rows: [['a', 'b', '3']],
    expected: [
      { name: 'Name', type: 'title' },
      { name: 'Column 2', type: 'text' },
      { name: 'Column 3', type: 'number' },
    ],
  },
  {
    kind: 'infer',
    name: "export's guard taken off header and option names, not off other types",
    header: ['Name', "'=Total", 'Kind', 'Note'],
    rows: [
      ['a', '1', "'-x", "'-5"],
      ['b', '2', "'-x", "'-6"],
      ['c', '3', "'-x", "'-7"],
    ],
    expected: [
      { name: 'Name', type: 'title' },
      { name: '=Total', type: 'number' },
      { name: 'Kind', type: 'select', options: ['-x'] },
      { name: 'Note', type: 'text' },
    ],
  },
  {
    kind: 'infer',
    name: 'a url with a space is text; Arabic options',
    header: ['N', 'Site', 'الحالة'],
    rows: [
      ['a', 'https://a b', 'جديد'],
      ['b', 'https://c', 'جديد'],
    ],
    expected: [
      { name: 'N', type: 'title' },
      { name: 'Site', type: 'text' },
      { name: 'الحالة', type: 'select', options: ['جديد'] },
    ],
  },
];

const RISKY_OPTIONS = [option('optMinus', '-minus'), option('optEqual', '=opt')];
const RISKY_SELECT = prop('pRsk0001', 'select', { options: RISKY_OPTIONS }, '=Stage');
const RISKY_MULTI = prop('pRsk0002', 'multiSelect', { options: RISKY_OPTIONS }, 'Tags');

const ttv = (name: string, def: PropertyDef, text: string, expected: Value | null): CsvCase => ({
  kind: 'textToValue',
  name,
  def,
  text,
  expected,
});

const textCases: CsvCase[] = [
  ttv('title keeps the text', TITLE, '  Name  ', '  Name  '),
  ttv('text, empty', P.text, '', null),
  ttv('number with thousands', P.number, '1,234', 1234),
  ttv('number that does not read', P.number, 'twelve', null),
  ttv('checkbox', P.checkbox, 'Yes', true),
  ttv('checkbox false', P.checkbox, 'false', null),
  ttv('date span as exported', P.date, '2026-03-01 → 2026-03-02', {
    start: '2026-03-01',
    end: '2026-03-02',
  }),
  ttv('select by name', P.select, 'Done', 'optDone1'),
  ttv('select with no such option', P.select, 'Missing', null),
  ttv('multi-select names', P.multi, 'Red, Blue', ['tagRed01', 'tagBlue1']),
  ttv('person from a name is nothing', P.person, 'Alice', null),
  ttv('url trimmed', P.url, ' https://x.example ', 'https://x.example'),
  ttv('email', P.email, 'a@b.co', 'a@b.co'),
  // CSV injection: export's guard taken off text-kind cells, never off numbers
  ttv('a guarded formula loses its quote', P.text, "'=SUM(A1)", '=SUM(A1)'),
  ttv('a guarded minus', P.text, "'-dash", '-dash'),
  ttv('a guarded plus', P.text, "'+1 555", '+1 555'),
  ttv('a guarded at sign', P.text, "'@user", '@user'),
  ttv('a guarded tab', P.text, "'\tTabbed", '\tTabbed'),
  ttv('a guarded carriage return', P.text, "'\rCR", '\rCR'),
  ttv('a guarded run of quotes loses one', P.text, "''=x", "'=x"),
  ttv('a quote before safe text stays', P.text, "'hello", "'hello"),
  ttv('an unguarded formula stays as written', P.text, '=raw', '=raw'),
  ttv('a title loses its guard', TITLE, "'+1 555", '+1 555'),
  ttv('a url loses its guard', P.url, "'=x", '=x'),
  ttv('an option name loses its guard', RISKY_SELECT, "'-minus", 'optMinus'),
  ttv('multi-select names lose their guard', RISKY_MULTI, "'-minus, =opt", [
    'optMinus',
    'optEqual',
  ]),
  ttv('a number is never unguarded', P.number, "'-5", null),
  ttv('a negative number', P.number, '-5', -5),
];

const EXPORT_DB = database([
  TITLE,
  P.text,
  P.number,
  P.date,
  P.checkbox,
  P.select,
  P.multi,
  P.person,
  P.files,
  P.relation,
  P.created,
  P.formula,
  prop('pOld0001', 'text', { trashedAt: '2026-02-01T00:00:00.000Z' }, 'Old'),
]);
const EXPORT_ROWS: VectorRow[] = [
  row(1, {
    title: 'Report, Q1',
    values: {
      pText001: 'He said "hi"',
      pNum0001: 1234.5,
      pDate001: { start: '2026-03-01', end: '2026-03-03' },
      pChk0001: true,
      pSel0001: 'optDone1',
      pMul0001: ['tagRed01', 'tagBlue1'],
      pPer0001: [ALICE, BOB],
      pFil0001: ['asset-1'],
      pRel0001: [rowId(90)],
      pOld0001: 'hidden',
    },
    computed: { pFor0001: 9 },
  }),
  row(2, {
    title: 'تقرير',
    values: {
      pText001: 'line1\nline2',
      pNum0001: 1e21,
      pSel0001: 'optGone1',
      pPer0001: [SAMI],
      pRel0001: [rowId(91)],
    },
    computed: { pFor0001: { error: 'formula.type' } },
  }),
  row(3, { title: 'Template', isTemplate: true }),
  row(4, { title: 'Trashed', trashedAt: '2026-02-01T00:00:00.000Z' }),
];
const LOOKUPS = {
  people: { [ALICE]: 'Alice', [BOB]: 'Bob Smith' },
  rows: { [rowId(90)]: 'Project "X"' },
  files: { 'asset-1': 'plan.pdf' },
};

const exportCases: CsvCase[] = [
  {
    kind: 'export',
    name: 'shown properties in view order, canonical values, quoting',
    database: EXPORT_DB,
    view: {
      config: { properties: { order: ['pNum0001', 'pText001'], hidden: ['pFil0001'], widths: {} } },
    },
    rows: EXPORT_ROWS,
    lookups: LOOKUPS,
    expected:
      '\uFEFFName,Amount,Notes,Due,Done?,Stage,Tags,Owner,Projects,Created,Score\r\n' +
      '"Report, Q1",1234.5,"He said ""hi""",2026-03-01 → 2026-03-03,true,Done,"Red, Blue","Alice, Bob Smith","Project ""X""",2026-01-01T09:00:00Z,9\r\n' +
      `تقرير,1e+21,"line1\nline2",,false,,,${SAMI},${rowId(91)},2026-01-01T09:00:00Z,\r\n`,
  },
  {
    kind: 'export',
    name: 'every property in database order, files by name',
    database: database([TITLE, P.files, prop('pPrice01', 'number', {}, 'Price, "USD"')]),
    view: { config: { properties: { order: [], hidden: [], widths: {} } } },
    rows: [row(1, { title: 'A', values: { pFil0001: ['asset-1', 'asset-2'], pPrice01: 0.5 } })],
    lookups: LOOKUPS,
    expected: '\uFEFFName,Attachments,"Price, ""USD"""\r\nA,"plan.pdf, asset-2",0.5\r\n',
  },
  {
    kind: 'export',
    name: 'no rows: the header only; the title first even if hidden',
    database: database([P.text, TITLE]),
    view: { config: { properties: { order: ['pText001'], hidden: ['title'], widths: {} } } },
    rows: [],
    lookups: {},
    expected: '\uFEFFName,Notes\r\n',
  },
  {
    kind: 'export',
    name: 'CSV injection: risky text guarded with a quote, numbers never',
    database: database([
      TITLE,
      P.text,
      P.number,
      RISKY_SELECT,
      P.person,
      P.relation,
      P.files,
      P.formula,
      prop('pFor0002', 'formula', { formula: { expression: '1' } }, 'Delta'),
    ]),
    view: { config: { properties: { order: [], hidden: [], widths: {} } } },
    rows: [
      row(1, {
        title: '=SUM(A1)',
        values: {
          pText001: '+1 555',
          pNum0001: -5,
          pRsk0001: 'optMinus',
          pPer0001: [ALICE],
          pRel0001: [rowId(90)],
          pFil0001: ['asset-1'],
        },
        computed: { pFor0001: '@x', pFor0002: -3 },
      }),
      row(2, {
        title: "'=already",
        values: { pText001: '\tTabbed', pNum0001: 5, pRsk0001: 'optEqual' },
        computed: { pFor0001: 'safe', pFor0002: 2 },
      }),
      row(3, {
        title: 'plain',
        values: { pText001: '\rCR' },
        computed: { pFor0001: '-1', pFor0002: -0.5 },
      }),
    ],
    lookups: {
      people: { [ALICE]: '@alice' },
      rows: { [rowId(90)]: '-proj' },
      files: { 'asset-1': '=file.xlsx' },
    },
    expected:
      "\uFEFFName,Notes,Amount,'=Stage,Owner,Projects,Attachments,Score,Delta\r\n" +
      "'=SUM(A1),'+1 555,-5,'-minus,'@alice,'-proj,'=file.xlsx,'@x,-3\r\n" +
      "''=already,'\tTabbed,5,'=opt,,,,safe,2\r\n" +
      'plain,"\'\rCR",,,,,,\'-1,-0.5\r\n',
  },
];

export const csvVectors: CsvCase[] = [...parseCases, ...inferCases, ...textCases, ...exportCases];
