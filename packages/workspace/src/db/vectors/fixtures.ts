// Builders for the shared vectors' inputs (vectors.test.ts writes them to
// packages/workspace/vectors/db-*.json). Rows and databases carry only the fields the rules read,
// all of them written out, so the C# port needs no defaults.
import { createHash } from 'node:crypto';
import type { RowRecord } from '../../types';
import type {
  DatabaseRecord,
  OptionColour,
  PropertyDef,
  PropertyType,
  SelectOption,
  StatusGroup,
  StatusOption,
  Value,
  CellValue,
} from '../types';

/** A row as the vectors hold it. */
export type VectorRow = Pick<
  RowRecord,
  | 'id'
  | 'databaseId'
  | 'title'
  | 'orderKey'
  | 'isTemplate'
  | 'trashedAt'
  | 'createdAt'
  | 'updatedAt'
  | 'createdBy'
  | 'updatedBy'
  | 'values'
  | 'computed'
>;

export type VectorDatabase = Pick<DatabaseRecord, 'id' | 'properties' | 'version'>;

export const DB = '01900000-0000-7000-8000-000000000001';
export const DB2 = '01900000-0000-7000-8000-000000000002';
export const ALICE = '01900000-0000-7000-8000-0000000000a1';
export const BOB = '01900000-0000-7000-8000-0000000000b0';
export const SAMI = '01900000-0000-7000-8000-0000000000c5';

/** Row ids `r1`.. as UUIDs (`rowId(1)`). */
export const rowId = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;

export function database(properties: PropertyDef[], id = DB, version = 1): VectorDatabase {
  return { id, properties, version };
}

export function row(n: number, fields: Partial<VectorRow> = {}): VectorRow {
  return {
    id: rowId(n),
    databaseId: DB,
    title: '',
    orderKey: `a${n}`,
    isTemplate: false,
    trashedAt: null,
    createdAt: '2026-01-01T09:00:00.000Z',
    updatedAt: '2026-01-02T10:30:00.000Z',
    createdBy: ALICE,
    updatedBy: ALICE,
    values: {},
    computed: {},
    ...fields,
  };
}

export const prop = (
  id: string,
  type: PropertyType,
  extra: Partial<PropertyDef> = {},
  name: string = id,
): PropertyDef => ({ id, name, type, ...extra });

export const TITLE: PropertyDef = { id: 'title', name: 'Name', type: 'title' };

export const option = (
  id: string,
  name: string,
  colour: OptionColour = 'default',
): SelectOption => ({
  id,
  name,
  colour,
});

export const status = (id: string, name: string, group: StatusGroup): StatusOption => ({
  id,
  name,
  colour: 'default',
  group,
});

/** What the vectors write for no value. */
export const none = null;

/** An independent derivation of `derivedOption`, on Node's SHA-256, to check the vectors by. */
export function expectedOption(
  databaseId: string,
  propertyId: string,
  name: string,
  attempt = 0,
): { id: string; colour: OptionColour } {
  const digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const colours: OptionColour[] = [
    'gray',
    'brown',
    'orange',
    'yellow',
    'green',
    'blue',
    'purple',
    'pink',
    'red',
  ];
  const input = [databaseId, propertyId, name, ...(attempt ? [String(attempt)] : [])].join(
    '\u0000',
  );
  const hash = createHash('sha256').update(Buffer.from(input, 'utf8')).digest();
  let id = '';
  for (let i = 0; i < 8; i++) id += digits[hash[i] % 62];
  return { id, colour: colours[hash[8] % 9] };
}

export type Json = Value | CellValue | null | Json[] | { [key: string]: Json | undefined };

// The properties most vectors use.
export const SELECT_OPTIONS = [
  option('optTodo1', 'To do', 'gray'),
  option('optDone1', 'Done', 'green'),
  option('optLate1', 'متأخر', 'red'),
  option('optFive1', '5'),
];
export const STATUS_OPTIONS = [
  status('staTodo1', 'Not started', 'todo'),
  status('staProg1', 'In progress', 'inProgress'),
  status('staDone1', 'Done', 'complete'),
];
export const MULTI_OPTIONS = [
  option('tagRed01', 'Red', 'red'),
  option('tagBlue1', 'Blue', 'blue'),
  option('tagAr001', 'أحمر', 'red'),
];
export const P = {
  text: prop('pText001', 'text', {}, 'Notes'),
  number: prop('pNum0001', 'number', { number: { format: 'number', decimals: null } }, 'Amount'),
  date: prop('pDate001', 'date', { date: { includeTime: false } }, 'Due'),
  checkbox: prop('pChk0001', 'checkbox', {}, 'Done?'),
  select: prop('pSel0001', 'select', { options: SELECT_OPTIONS }, 'Stage'),
  status: prop('pSta0001', 'status', { options: STATUS_OPTIONS }, 'Status'),
  multi: prop('pMul0001', 'multiSelect', { options: MULTI_OPTIONS }, 'Tags'),
  person: prop('pPer0001', 'person', {}, 'Owner'),
  url: prop('pUrl0001', 'url', {}, 'Link'),
  email: prop('pEml0001', 'email', {}, 'Email'),
  phone: prop('pPho0001', 'phone', {}, 'Phone'),
  files: prop('pFil0001', 'files', {}, 'Attachments'),
  relation: prop(
    'pRel0001',
    'relation',
    { relation: { databaseId: DB2, reversePropertyId: 'pRev0001' } },
    'Projects',
  ),
  link: prop(
    'pRel0002',
    'relation',
    { relation: { databaseId: DB, reversePropertyId: null } },
    'Links',
  ),
  formula: prop('pFor0001', 'formula', { formula: { expression: '1' } }, 'Score'),
  rollup: prop(
    'pRol0001',
    'rollup',
    { rollup: { relationPropertyId: 'pRel0001', targetPropertyId: 'qNum0001', fn: 'sum' } },
    'Total',
  ),
  created: prop('pCrt0001', 'createdTime', {}, 'Created'),
  createdBy: prop('pCrb0001', 'createdBy', {}, 'Created by'),
  edited: prop('pEdt0001', 'lastEditedTime', {}, 'Edited'),
  editedBy: prop('pEdb0001', 'lastEditedBy', {}, 'Edited by'),
} satisfies Record<string, PropertyDef>;
