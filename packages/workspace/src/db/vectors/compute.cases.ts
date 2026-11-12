// db-compute-vectors.json: `computeRow` (rollups over held related rows, then formulas in
// dependency order), `planRelationChange` and `applyRelationEdit`.
//
// computeRow suites: `related(databaseId, rowIds)` is, for a database in `held`, that database and
// its rows in `rows` whose id is asked for; for any other database, null (not held here).
import type { CellValue, PropertyDef, RollupFunction } from '../types';
import type { RelationEdit, RelationPairingChange } from '../relations';
import {
  ALICE,
  BOB,
  DB,
  DB2,
  TITLE,
  database,
  option,
  prop,
  row,
  rowId,
  type VectorDatabase,
  type VectorRow,
} from './fixtures';

export interface ComputeCase {
  name: string;
  row: VectorRow;
  expected: Record<string, CellValue>;
}

export type ComputeSuite =
  | {
      kind: 'computeRow';
      name: string;
      database: VectorDatabase;
      held: VectorDatabase[];
      rows: VectorRow[];
      cases: ComputeCase[];
    }
  | {
      kind: 'relationChange';
      name: string;
      database: VectorDatabase;
      cases: {
        name: string;
        before: Pick<VectorRow, 'id' | 'values'> | null;
        after: Pick<VectorRow, 'id' | 'values'> | null;
        expected: RelationEdit[];
      }[];
    }
  | {
      kind: 'applyRelationEdit';
      name: string;
      cases: {
        name: string;
        current: string[] | null;
        edit: { add: string[]; remove: string[] };
        expected: string[] | null;
      }[];
    }
  | {
      /** `relationTypeChangeEffects(database, before, after, target)`; `target` null: not held. */
      kind: 'relationTypeChange';
      name: string;
      database: VectorDatabase;
      cases: {
        name: string;
        before: PropertyDef;
        after: PropertyDef;
        target: VectorDatabase | null;
        expected: RelationPairingChange[];
      }[];
    };

const DB3 = '01900000-0000-7000-8000-000000000003';
const TRASHED = '2026-02-01T00:00:00.000Z';

const B = database(
  [
    TITLE,
    prop('qNum0001', 'number', {}, 'Hours'),
    prop('qDate001', 'date', {}, 'When'),
    prop('qChk0001', 'checkbox', {}, 'Done'),
    prop(
      'qSel0001',
      'select',
      { options: [option('qOptA01', 'A'), option('qOptB01', 'B')] },
      'Kind',
    ),
    prop(
      'qMul0001',
      'multiSelect',
      { options: [option('qTagX01', 'X'), option('qTagY01', 'Y')] },
      'Tags',
    ),
    prop('qPer0001', 'person', {}, 'Who'),
    prop('qTxt0001', 'text', {}, 'Note'),
    prop('qFor0001', 'formula', { formula: { expression: 'prop("qNum0001") * 10' } }, 'Tenfold'),
    prop('qBad0001', 'formula', { formula: { expression: '1 +' } }, 'Broken'),
    prop('qOld0001', 'number', { trashedAt: TRASHED }, 'Old'),
    prop(
      'pRev0001',
      'relation',
      { relation: { databaseId: DB, reversePropertyId: 'pRel0001' } },
      'Tasks',
    ),
  ],
  DB2,
);

const b = (n: number, fields: Partial<VectorRow>) =>
  row(n, { databaseId: DB2, title: `B${n}`, ...fields });
const B_ROWS: VectorRow[] = [
  b(101, {
    values: {
      qNum0001: 10,
      qDate001: { start: '2026-03-01' },
      qChk0001: true,
      qSel0001: 'qOptA01',
      qMul0001: ['qTagX01', 'qTagY01'],
      qPer0001: [ALICE],
      qTxt0001: 'x',
    },
    computed: { qFor0001: 100 },
  }),
  b(102, {
    values: {
      qNum0001: 20,
      qDate001: { start: '2026-02-15T10:00:00Z' },
      qSel0001: 'qOptA01',
      qMul0001: ['qTagX01'],
      qPer0001: [BOB],
    },
    computed: { qFor0001: 200 },
  }),
  b(103, {
    values: { qChk0001: true, qSel0001: 'qOptB01', qTxt0001: 'y' },
    computed: { qFor0001: { error: 'formula.type' } },
  }),
  b(104, { trashedAt: TRASHED, values: { qNum0001: 1000 }, computed: { qFor0001: 10000 } }),
  b(105, {
    values: {
      qNum0001: 5,
      qDate001: { start: '2026-04-01', end: '2026-04-03' },
      qSel0001: 'qGone01',
    },
    computed: { qFor0001: 50 },
  }),
  b(106, { isTemplate: true, values: { qNum0001: 999 } }),
];

const roll = (
  id: string,
  fn: RollupFunction,
  targetPropertyId: string,
  extra: { relation?: string; trashedAt?: string } = {},
) =>
  prop(
    id,
    'rollup',
    {
      rollup: { relationPropertyId: extra.relation ?? 'pRel0001', targetPropertyId, fn },
      ...(extra.trashedAt ? { trashedAt: extra.trashedAt } : {}),
    },
    id,
  );
const formula = (id: string, expression: string, trashedAt?: string) =>
  prop(id, 'formula', { formula: { expression }, ...(trashedAt ? { trashedAt } : {}) }, id);

const A = database([
  TITLE,
  prop('pNum0001', 'number', {}, 'Amount'),
  prop(
    'pRel0001',
    'relation',
    { relation: { databaseId: DB2, reversePropertyId: 'pRev0001' } },
    'Parts',
  ),
  prop('pRel0003', 'relation', { relation: { databaseId: DB3, reversePropertyId: null } }, 'Far'),
  formula('fOrder01', 'prop("fTot0001") + prop("fNum0001")'),
  roll('rCnt0001', 'count', 'qNum0001'),
  roll('rCntV001', 'countValues', 'qNum0001'),
  roll('rCntM001', 'countValues', 'qMul0001'),
  roll('rUniq001', 'countUnique', 'qSel0001'),
  roll('rUniM001', 'countUnique', 'qMul0001'),
  roll('rEmp0001', 'countEmpty', 'qNum0001'),
  roll('rNEmp001', 'countNotEmpty', 'qNum0001'),
  roll('rPEmp001', 'percentEmpty', 'qNum0001'),
  roll('rPNE0001', 'percentNotEmpty', 'qNum0001'),
  roll('rSum0001', 'sum', 'qNum0001'),
  roll('rAvg0001', 'average', 'qNum0001'),
  roll('rMed0001', 'median', 'qNum0001'),
  roll('rMin0001', 'min', 'qNum0001'),
  roll('rMax0001', 'max', 'qNum0001'),
  roll('rRng0001', 'range', 'qNum0001'),
  roll('rSumF001', 'sum', 'qFor0001'),
  roll('rEarl001', 'earliest', 'qDate001'),
  roll('rLate001', 'latest', 'qDate001'),
  roll('rChk0001', 'checked', 'qChk0001'),
  roll('rUnch001', 'unchecked', 'qChk0001'),
  roll('rPChk001', 'percentChecked', 'qChk0001'),
  roll('rOrS0001', 'showOriginal', 'qSel0001'),
  roll('rOrN0001', 'showOriginal', 'qNum0001'),
  roll('rOrP0001', 'showOriginal', 'qPer0001'),
  roll('rOrD0001', 'showOriginal', 'qDate001'),
  roll('rBadT001', 'sum', 'qTxt0001'),
  roll('rBadE001', 'earliest', 'qNum0001'),
  roll('rBadC001', 'checked', 'qNum0001'),
  roll('rUnk0001', 'sum', 'nothere1'),
  roll('rNotR001', 'sum', 'qNum0001', { relation: 'pNum0001' }),
  roll('rOldT001', 'sum', 'qOld0001'),
  roll('rBrkF001', 'sum', 'qBad0001'),
  roll('rFar0001', 'sum', 'zNum0001', { relation: 'pRel0003' }),
  roll('rGone001', 'count', 'qNum0001', { trashedAt: TRASHED }),
  formula('fTot0001', 'prop("rSum0001") * 2'),
  formula('fNum0001', 'prop("pNum0001") + 1'),
  formula('fCyc0001', 'prop("fCyc0002") + 1'),
  formula('fCyc0002', 'prop("fCyc0001") + 1'),
  formula('fOfCyc01', 'prop("fCyc0001") + 1'),
  formula('fFar0001', 'prop("rFar0001") + 1'),
  formula('fAvgR001', 'round(prop("rAvg0001"), 2)'),
  formula('fErr0001', 'prop("rBadT001") + 1'),
  formula('fGone001', '1', TRASHED),
]);

const STATIC = {
  rBadT001: { error: 'formula.type' },
  rBadE001: { error: 'formula.type' },
  rBadC001: { error: 'formula.type' },
  rUnk0001: { error: 'formula.unknownProperty' },
  rNotR001: { error: 'formula.unknownProperty' },
  rOldT001: { error: 'formula.unknownProperty' },
  rBrkF001: { error: 'formula.syntax' },
  fCyc0001: { error: 'formula.cycle' },
  fCyc0002: { error: 'formula.cycle' },
  fOfCyc01: { error: 'formula.cycle' },
  fErr0001: { error: 'formula.type' },
};

const a = (n: number, values: VectorRow['values'], computed: VectorRow['computed'] = {}) =>
  row(n, { title: `A${n}`, values, computed });

const computeCases: ComputeCase[] = [
  {
    name: 'every rollup function over held rows; trashed, template and missing rows left out',
    row: a(
      1,
      {
        pNum0001: 3,
        pRel0001: [
          rowId(101),
          rowId(102),
          rowId(103),
          rowId(104),
          rowId(105),
          rowId(106),
          rowId(199),
          rowId(101),
        ],
      },
      { rFar0001: 41 },
    ),
    expected: {
      rCnt0001: 4,
      rCntV001: 3,
      rCntM001: 3,
      rUniq001: 2,
      rUniM001: 2,
      rEmp0001: 1,
      rNEmp001: 3,
      rPEmp001: 0.25,
      rPNE0001: 0.75,
      rSum0001: 35,
      rAvg0001: 11.666666666666666,
      rMed0001: 10,
      rMin0001: 5,
      rMax0001: 20,
      rRng0001: 15,
      rSumF001: 350,
      rEarl001: { start: '2026-02-15T10:00:00Z' },
      rLate001: { start: '2026-04-01' },
      rChk0001: 2,
      rUnch001: 2,
      rPChk001: 0.5,
      rOrS0001: ['A', 'A', 'B'],
      rOrN0001: ['10', '20', '5'],
      rOrP0001: [ALICE, BOB],
      rOrD0001: ['2026-03-01', '2026-02-15T10:00:00Z', '2026-04-01 → 2026-04-03'],
      ...STATIC,
      fOrder01: 74,
      fTot0001: 70,
      fNum0001: 4,
      fFar0001: 42,
      fAvgR001: 11.67,
    },
  },
  {
    name: 'two related rows: an even median',
    row: a(2, { pNum0001: 1, pRel0001: [rowId(101), rowId(102)] }),
    expected: {
      rCnt0001: 2,
      rCntV001: 2,
      rCntM001: 3,
      rUniq001: 1,
      rUniM001: 2,
      rEmp0001: 0,
      rNEmp001: 2,
      rPEmp001: 0,
      rPNE0001: 1,
      rSum0001: 30,
      rAvg0001: 15,
      rMed0001: 15,
      rMin0001: 10,
      rMax0001: 20,
      rRng0001: 10,
      rSumF001: 300,
      rEarl001: { start: '2026-02-15T10:00:00Z' },
      rLate001: { start: '2026-03-01' },
      rChk0001: 1,
      rUnch001: 1,
      rPChk001: 0.5,
      rOrS0001: ['A', 'A'],
      rOrN0001: ['10', '20'],
      rOrP0001: [ALICE, BOB],
      rOrD0001: ['2026-03-01', '2026-02-15T10:00:00Z'],
      ...STATIC,
      fOrder01: 62,
      fTot0001: 60,
      fNum0001: 2,
      fFar0001: null,
      fAvgR001: 15,
    },
  },
  {
    name: 'no related rows',
    row: a(3, {}),
    expected: {
      rCnt0001: 0,
      rCntV001: 0,
      rCntM001: 0,
      rUniq001: 0,
      rUniM001: 0,
      rEmp0001: 0,
      rNEmp001: 0,
      rPEmp001: null,
      rPNE0001: null,
      rSum0001: 0,
      rAvg0001: null,
      rMed0001: null,
      rMin0001: null,
      rMax0001: null,
      rRng0001: null,
      rSumF001: 0,
      rEarl001: null,
      rLate001: null,
      rChk0001: 0,
      rUnch001: 0,
      rPChk001: null,
      rOrS0001: null,
      rOrN0001: null,
      rOrP0001: null,
      rOrD0001: null,
      ...STATIC,
      fOrder01: null,
      fTot0001: 0,
      fNum0001: null,
      fFar0001: null,
      fAvgR001: null,
    },
  },
];

const REL = database([
  TITLE,
  prop(
    'pRel0001',
    'relation',
    { relation: { databaseId: DB2, reversePropertyId: 'pRev0001' } },
    'Parts',
  ),
  prop(
    'pRel0002',
    'relation',
    { relation: { databaseId: DB, reversePropertyId: 'pSelR001' } },
    'Blocks',
  ),
  prop(
    'pSelR001',
    'relation',
    { relation: { databaseId: DB, reversePropertyId: 'pRel0002' } },
    'Blocked by',
  ),
  prop('pRel0003', 'relation', { relation: { databaseId: DB3, reversePropertyId: null } }, 'Far'),
  prop(
    'pSym0001',
    'relation',
    { relation: { databaseId: DB, reversePropertyId: 'pSym0001' } },
    'Related',
  ),
  prop(
    'pTrR0001',
    'relation',
    { relation: { databaseId: DB2, reversePropertyId: 'pTrRv001' }, trashedAt: TRASHED },
    'Old',
  ),
]);
const A1 = rowId(1);
const A2 = rowId(2);
const [B1, B2, B3, B4] = [101, 102, 103, 104].map(rowId);
const edit = (
  databaseId: string,
  rowIdOf: string,
  propertyId: string,
  add: string[],
  remove: string[] = [],
): RelationEdit => ({
  databaseId,
  rowId: rowIdOf,
  propertyId,
  add,
  remove,
});
const v = (values: VectorRow['values']) => ({ id: A1, values });

const relationCases = [
  {
    name: 'adds and removes: removed first, in order',
    before: v({ pRel0001: [B1, B2] }),
    after: v({ pRel0001: [B2, B3, B4] }),
    expected: [
      edit(DB2, B1, 'pRev0001', [], [A1]),
      edit(DB2, B3, 'pRev0001', [A1]),
      edit(DB2, B4, 'pRev0001', [A1]),
    ],
  },
  {
    name: 'a new row',
    before: null,
    after: v({ pRel0001: [B1], pRel0002: [A2] }),
    expected: [edit(DB2, B1, 'pRev0001', [A1]), edit(DB, A2, 'pSelR001', [A1])],
  },
  {
    name: 'a removed row',
    before: v({ pRel0001: [B1] }),
    after: null,
    expected: [edit(DB2, B1, 'pRev0001', [], [A1])],
  },
  {
    name: 'no reverse property',
    before: v({}),
    after: v({ pRel0003: [rowId(300)] }),
    expected: [],
  },
  {
    name: 'a deleted relation keeps nothing in step',
    before: v({}),
    after: v({ pTrR0001: [B1] }),
    expected: [],
  },
  {
    name: 'a self-relation with a second property, the row itself included',
    before: v({}),
    after: v({ pRel0002: [A2, A1] }),
    expected: [edit(DB, A2, 'pSelR001', [A1]), edit(DB, A1, 'pSelR001', [A1])],
  },
  {
    name: 'a symmetric self-relation leaves out the row itself',
    before: v({}),
    after: v({ pSym0001: [A2, A1] }),
    expected: [edit(DB, A2, 'pSym0001', [A1])],
  },
  { name: 'unchanged', before: v({ pRel0001: [B1] }), after: v({ pRel0001: [B1] }), expected: [] },
  {
    name: 'both sides of a self-relation changed at once',
    before: v({}),
    after: v({ pRel0002: [A2], pSelR001: [A2] }),
    expected: [edit(DB, A2, 'pSelR001', [A1]), edit(DB, A2, 'pRel0002', [A1])],
  },
  {
    name: 'repeated ids count once',
    before: v({}),
    after: v({ pRel0001: [B1, B1] }),
    expected: [edit(DB2, B1, 'pRev0001', [A1])],
  },
];

const relationDef = (id: string) => REL.properties.find((p) => p.id === id)!;
const PARTS = relationDef('pRel0001');
const asText = (def: PropertyDef): PropertyDef => ({ id: def.id, name: def.name, type: 'text' });
const REV = prop(
  'pRev0001',
  'relation',
  { relation: { databaseId: DB, reversePropertyId: 'pRel0001' } },
  'Tasks',
);
const TARGET = database([TITLE, REV, prop('qNum0001', 'number', {}, 'Hours')], DB2);
const oneWay = (databaseId: string, def: PropertyDef): RelationPairingChange[] => [
  { databaseId, properties: [{ ...def, relation: { ...def.relation!, reversePropertyId: null } }] },
];
const repointed = (databaseId: string, reversePropertyId: string | null): PropertyDef => ({
  ...PARTS,
  relation: { databaseId, reversePropertyId },
});

const typeChangeCases = [
  {
    name: 'changed into text',
    before: PARTS,
    after: asText(PARTS),
    target: TARGET,
    expected: oneWay(DB2, REV),
  },
  {
    name: 'changed into a number, renamed too',
    before: PARTS,
    after: { id: PARTS.id, name: 'Count', type: 'number' as const },
    target: TARGET,
    expected: oneWay(DB2, REV),
  },
  {
    name: 'pointed at another reverse',
    before: PARTS,
    after: repointed(DB2, 'pNew0001'),
    target: TARGET,
    expected: oneWay(DB2, REV),
  },
  {
    name: 'made one-way itself',
    before: PARTS,
    after: repointed(DB2, null),
    target: TARGET,
    expected: oneWay(DB2, REV),
  },
  {
    name: 'pointed at another database',
    before: PARTS,
    after: repointed(DB3, 'pRev0001'),
    target: TARGET,
    expected: oneWay(DB2, REV),
  },
  {
    name: 'still paired, only renamed',
    before: PARTS,
    after: { ...PARTS, name: 'Parts!' },
    target: TARGET,
    expected: [],
  },
  {
    name: 'the target is not held here',
    before: PARTS,
    after: asText(PARTS),
    target: null,
    expected: [],
  },
  {
    name: 'no reverse property',
    before: relationDef('pRel0003'),
    after: asText(relationDef('pRel0003')),
    target: null,
    expected: [],
  },
  {
    name: 'a self-relation: the second property in the same database',
    before: relationDef('pRel0002'),
    after: asText(relationDef('pRel0002')),
    target: REL,
    expected: oneWay(DB, relationDef('pSelR001')),
  },
  {
    name: 'a symmetric self-relation has no other side',
    before: relationDef('pSym0001'),
    after: asText(relationDef('pSym0001')),
    target: REL,
    expected: [],
  },
  {
    name: 'a reverse that points elsewhere is left alone',
    before: PARTS,
    after: asText(PARTS),
    target: database(
      [TITLE, { ...REV, relation: { databaseId: DB3, reversePropertyId: 'pRel0001' } }],
      DB2,
    ),
    expected: [],
  },
  {
    name: 'a reverse that is no longer a relation is left alone',
    before: PARTS,
    after: asText(PARTS),
    target: database([TITLE, prop('pRev0001', 'text', {}, 'Tasks')], DB2),
    expected: [],
  },
  {
    name: 'a reverse the target lacks',
    before: PARTS,
    after: asText(PARTS),
    target: database([TITLE], DB2),
    expected: [],
  },
  {
    name: 'not a relation before',
    before: prop('pNum0001', 'number'),
    after: asText(prop('pNum0001', 'number')),
    target: null,
    expected: [],
  },
];

export const computeVectors: ComputeSuite[] = [
  {
    kind: 'computeRow',
    name: 'rollups and formulas',
    database: A,
    held: [B],
    rows: B_ROWS,
    cases: computeCases,
  },
  { kind: 'relationChange', name: 'reverse-side edits', database: REL, cases: relationCases },
  {
    kind: 'applyRelationEdit',
    name: 'a reverse value after an edit',
    cases: [
      {
        name: 'remove and append',
        current: ['x', 'y'],
        edit: { add: ['z'], remove: ['x'] },
        expected: ['y', 'z'],
      },
      { name: 'onto nothing', current: null, edit: { add: ['a'], remove: [] }, expected: ['a'] },
      { name: 'to nothing', current: ['a'], edit: { add: [], remove: ['a'] }, expected: null },
      { name: 'already there', current: ['a'], edit: { add: ['a'], remove: [] }, expected: ['a'] },
    ],
  },
  {
    kind: 'relationTypeChange',
    name: 'a relation that no longer pairs leaves its reverse one-way',
    database: REL,
    cases: typeChangeCases,
  },
];
