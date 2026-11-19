import { describe, expect, it } from 'vitest';
import {
  ErpContractError,
  ErpError,
  connectorRoute,
  connectorsRoute,
  isDecimal,
  isIsoDate,
  isIsoDateTime,
  isParameterDate,
  isToken,
  isVersion,
  kindOf,
  parseConnectCreateTicket,
  parseConnectSession,
  parseConnectors,
  parseErrorBody,
  parseLinkCreateTicket,
  parseLinkRedeem,
  parseQueryResponse,
  parseRenew,
  parseSchema,
  readConnectMessage,
  recordProblems,
  type ConnectorSchema,
} from './contract';

const TICKET = 'A'.repeat(42) + '_';
const TOKEN = 'tok_' + 'x'.repeat(40);

/** The guard's refusal of `value`: its path, checked to say nothing of what was sent. */
function refusal(read: () => unknown, sent?: string): ErpContractError {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(ErpContractError);
    const e = error as ErpContractError;
    if (sent !== undefined) expect(e.message).not.toContain(sent);
    return e;
  }
  throw new Error('Expected a refusal.');
}

const session = () => ({
  token: TOKEN,
  expiresAt: '2026-11-14T10:30:00Z',
  maxExpiresAt: '2026-11-14T20:00:00Z',
  linkId: 'lnk-1',
  company: 'Kit',
  companyName: 'Kit Trading',
  user: { id: 'u101', displayName: 'Alice Haddad' },
  language: 'en',
});

const schema = (): Record<string, unknown> => ({
  id: 'vendors',
  schemaVersion: 'vendors.1',
  keyField: 'vendorAccount',
  idField: 'recId',
  maxPageSize: 1000,
  maxRecords: 10000,
  maxCommitRecords: 500,
  fields: [
    {
      name: 'vendorAccount',
      label: { en: 'Account', ar: 'الحساب' },
      type: 'text',
      editable: false,
      editReason: 'notEditable',
      maxLength: 50,
      filterable: true,
      sortable: true,
    },
    {
      name: 'vendorGroup',
      label: { en: 'Group', ar: 'المجموعة' },
      type: 'lookup',
      lookup: 'vendorGroups',
      editable: false,
      editReason: 'notEditable',
      filterable: true,
      sortable: true,
    },
    {
      name: 'debitLimit',
      label: { en: 'Credit limit', ar: 'حد الائتمان' },
      type: 'decimal',
      scale: 2,
      min: '0',
      editable: false,
      editReason: 'notEditable',
      filterable: false,
      sortable: true,
    },
    {
      name: 'blocked',
      label: { en: 'Blocked', ar: 'موقوف' },
      type: 'boolean',
      editable: false,
      editReason: 'notEditable',
      filterable: true,
      sortable: false,
    },
    {
      name: 'opened',
      label: { en: 'Opened', ar: 'تاريخ الفتح' },
      type: 'date',
      editable: false,
      editReason: 'notEditable',
      filterable: false,
      sortable: true,
    },
    {
      name: 'modifiedDate',
      label: { en: 'Modified', ar: 'تاريخ التعديل' },
      type: 'dateTime',
      editable: false,
      editReason: 'notEditable',
      filterable: false,
      sortable: true,
    },
    {
      name: 'lines',
      label: { en: 'Lines', ar: 'البنود' },
      type: 'integer',
      editable: false,
      editReason: 'notEditable',
      filterable: false,
      sortable: false,
    },
  ],
  lookups: {
    vendorGroups: [
      { code: 'LOCAL', label: 'محلي' },
      { code: 'OLD', label: 'Old suppliers', active: false },
    ],
  },
});

const values = () => ({
  vendorAccount: 'V-1001',
  vendorGroup: 'LOCAL',
  debitLimit: '15000.00',
  blocked: false,
  opened: '2019-03-01',
  modifiedDate: '2026-10-30T10:12:00+02:00',
  lines: 4,
});

const record = (over: Record<string, unknown> = {}) => ({
  id: '4411',
  key: 'V-1001',
  version: 'AAAAAAAAB9E=',
  values: values(),
  ...over,
});

function withField(index: number, change: Record<string, unknown>): Record<string, unknown> {
  const s = schema();
  const fields = [...(s.fields as Record<string, unknown>[])];
  fields[index] = { ...fields[index], ...change };
  return { ...s, fields };
}

describe('values', () => {
  it('reads date-times with a zone only', () => {
    expect(isIsoDateTime('2026-11-14T10:00:05Z')).toBe(true);
    expect(isIsoDateTime('2026-11-14T10:00:05.1234567+02:00')).toBe(true);
    expect(isIsoDateTime('2026-11-14T10:00:05')).toBe(false);
    expect(isIsoDateTime('2026-11-14 10:00:05Z')).toBe(false);
  });

  it('reads dates that exist', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('0012-01-31')).toBe(true);
    expect(isIsoDate('2026-1-31')).toBe(false);
  });

  it('reads decimals at a scale', () => {
    expect(isDecimal('15000.00', 2)).toBe(true);
    expect(isDecimal('-3', 0)).toBe(true);
    expect(isDecimal('1.234', 2)).toBe(false);
    expect(isDecimal('01', 2)).toBe(false);
    expect(isDecimal('1e3', 2)).toBe(false);
    expect(isDecimal('.5', 2)).toBe(false);
  });

  it('reads canonical base64 versions and header-safe tokens', () => {
    expect(isVersion('AAAAAAAAB9E=')).toBe(true);
    expect(isVersion('AAAAAAAAB9E')).toBe(false);
    expect(isVersion('')).toBe(false);
    expect(isToken(TOKEN)).toBe(true);
    expect(isToken('short')).toBe(false);
    expect(isToken('x'.repeat(30) + '\r\nX-Evil: 1')).toBe(false);
    expect(isToken('x'.repeat(30) + ' y')).toBe(false);
  });

  it('puts connector ids in routes encoded', () => {
    expect(connectorRoute('itemsOnHand', 'Query')).toBe('api/connect/Connectors/itemsOnHand/Query');
    expect(connectorRoute('a/b', 'Schema')).toBe('api/connect/Connectors/a%2Fb/Schema');
  });
});

describe('links', () => {
  it('reads the link ticket from its address', () => {
    const url = `http://127.0.0.1:5273/#/erp-link/${TICKET}`;
    expect(parseLinkCreateTicket({ url })).toEqual({ url, ticket: TICKET });
  });

  it('refuses a link address that is not Workspace with a ticket', () => {
    expect(refusal(() => parseLinkCreateTicket({ url: 'http://x/#/erp-link/short' })).path).toBe(
      '$.url#ticket',
    );
    expect(refusal(() => parseLinkCreateTicket({ url: `http://x/?t=${TICKET}` })).path).toBe(
      '$.url',
    );
    expect(
      refusal(() => parseLinkCreateTicket({ url: `javascript:#/erp-link/${TICKET}` })).path,
    ).toBe('$.url');
    expect(refusal(() => parseLinkCreateTicket({})).path).toBe('$.url');
  });

  it('reads a redeemed link', () => {
    expect(parseLinkRedeem({ linkId: 'l1', company: 'Kit', companyName: 'Kit Trading' })).toEqual({
      linkId: 'l1',
      company: 'Kit',
      companyName: 'Kit Trading',
    });
    expect(
      refusal(() => parseLinkRedeem({ linkId: '', company: 'Kit', companyName: 'K' })).path,
    ).toBe('$.linkId');
    expect(refusal(() => parseLinkRedeem({ linkId: 'l', company: 'Kit' })).path).toBe(
      '$.companyName',
    );
    expect(refusal(() => parseLinkRedeem([])).path).toBe('$');
  });

  it('reads a connect ticket of 43 base64url characters', () => {
    expect(parseConnectCreateTicket({ ticket: TICKET })).toEqual({ ticket: TICKET });
    expect(refusal(() => parseConnectCreateTicket({ ticket: TICKET + 'A' })).path).toBe('$.ticket');
    expect(refusal(() => parseConnectCreateTicket({ ticket: 'A'.repeat(42) + '+' })).path).toBe(
      '$.ticket',
    );
  });
});

describe('sessions', () => {
  it('reads a session', () => {
    expect(parseConnectSession(session())).toEqual(session());
  });

  it.each([
    ['token', { token: 'short' }, '$.token'],
    ['token with a line break', { token: 'x'.repeat(30) + '\n' }, '$.token'],
    ['expiry without a zone', { expiresAt: '2026-11-14T10:30:00' }, '$.expiresAt'],
    ['expiry past the maximum', { expiresAt: '2026-11-14T21:00:00Z' }, '$.expiresAt'],
    ['maximum', { maxExpiresAt: undefined }, '$.maxExpiresAt'],
    ['link', { linkId: '' }, '$.linkId'],
    ['company', { company: 3 }, '$.company'],
    ['company name', { companyName: '' }, '$.companyName'],
    ['user', { user: 'alice' }, '$.user'],
    ['user id', { user: { displayName: 'A' } }, '$.user.id'],
    ['display name', { user: { id: 'u', displayName: null } }, '$.user.displayName'],
    ['language', { language: 'fr' }, '$.language'],
  ])('refuses a session with a bad %s', (_, change, path) => {
    const e = refusal(() => parseConnectSession({ ...session(), ...change }), TOKEN);
    expect(e.path).toBe(path);
  });

  it('never quotes the token it refuses', () => {
    const secret = 'tok_secret_' + 'q'.repeat(30) + '\n';
    const e = refusal(() => parseConnectSession({ ...session(), token: secret }), 'tok_secret');
    expect(e.message).toContain('a string of');
  });

  it('reads a renewal', () => {
    expect(parseRenew({ expiresAt: '2026-11-14T10:35:00+02:00' })).toEqual({
      expiresAt: '2026-11-14T10:35:00+02:00',
    });
    expect(refusal(() => parseRenew({ expiresAt: 'soon' })).path).toBe('$.expiresAt');
    expect(refusal(() => parseRenew(null)).path).toBe('$');
  });
});

describe('connectors', () => {
  const summary = () => ({
    id: 'vendors',
    kind: 'entity',
    label: { en: 'Vendors', ar: 'الموردون' },
    schemaVersion: 'vendors.1',
    access: 'view',
  });

  it('reads the list, ignoring properties it does not know', () => {
    expect(parseConnectors({ connectors: [{ ...summary(), extra: 1 }], more: true })).toEqual({
      connectors: [summary()],
    });
    expect(parseConnectors({ connectors: [] })).toEqual({ connectors: [] });
  });

  it.each([
    ['list', { connectors: null }, '$.connectors'],
    ['id', { connectors: [{ ...summary(), id: 'a b' }] }, '$.connectors[0].id'],
    ['kind', { connectors: [{ ...summary(), kind: 'view' }] }, '$.connectors[0].kind'],
    ['label', { connectors: [{ ...summary(), label: 'Vendors' }] }, '$.connectors[0].label'],
    [
      'Arabic label',
      { connectors: [{ ...summary(), label: { en: 'Vendors', ar: '' } }] },
      '$.connectors[0].label.ar',
    ],
    [
      'schema version',
      { connectors: [{ ...summary(), schemaVersion: '' }] },
      '$.connectors[0].schemaVersion',
    ],
    ['access', { connectors: [{ ...summary(), access: 'admin' }] }, '$.connectors[0].access'],
    ['repeated id', { connectors: [summary(), summary()] }, '$.connectors'],
  ])('refuses a bad %s', (_, value, path) => {
    expect(refusal(() => parseConnectors(value)).path).toBe(path);
  });
});

describe('schemas', () => {
  it('reads a schema, a null id field and a report’s parameters', () => {
    const read = parseSchema(schema());
    expect(read.fields.map((f) => f.name)).toEqual([
      'vendorAccount',
      'vendorGroup',
      'debitLimit',
      'blocked',
      'opened',
      'modifiedDate',
      'lines',
    ]);
    expect(read.fields[2]).toMatchObject({ scale: 2, min: '0', filterable: false, sortable: true });
    expect(read.lookups.vendorGroups![1]).toEqual({
      code: 'OLD',
      label: 'Old suppliers',
      active: false,
    });
    expect(parseSchema({ ...schema(), idField: null }).idField).toBeNull();
    const report = parseSchema({
      ...schema(),
      parameters: [
        { name: 'asOf', label: { en: 'As of', ar: 'في' }, type: 'date', required: true },
      ],
    });
    expect(report.parameters).toHaveLength(1);
  });

  it.each([
    ['id', { id: '' }, '$.id'],
    ['schema version', { schemaVersion: 1 }, '$.schemaVersion'],
    ['key field not a field', { keyField: 'nope' }, '$.keyField'],
    ['key field of the wrong type', { keyField: 'debitLimit' }, '$.keyField'],
    ['id field sent as a field', { idField: 'vendorAccount' }, '$.idField'],
    ['page size', { maxPageSize: 0 }, '$.maxPageSize'],
    ['records', { maxRecords: 1.5 }, '$.maxRecords'],
    ['commit records', { maxCommitRecords: -1 }, '$.maxCommitRecords'],
    ['field list', { fields: {} }, '$.fields'],
    ['empty field list', { fields: [] }, '$.fields'],
    ['lookups', { lookups: [] }, '$.lookups'],
    [
      'repeated lookup code',
      {
        lookups: {
          vendorGroups: [
            { code: 'A', label: 'a' },
            { code: 'A', label: 'b' },
          ],
        },
      },
      '$.lookups.vendorGroups',
    ],
    [
      'lookup label',
      { lookups: { vendorGroups: [{ code: 'A', label: { en: 'a' } }] } },
      '$.lookups.vendorGroups[0].label',
    ],
    ['lookup name', { lookups: { 'bad name': [] } }, '$.lookups.bad name'],
    [
      'parameters',
      { parameters: [{ name: 'x', label: { en: 'X', ar: 'س' }, type: 'date' }] },
      '$.parameters[0].required',
    ],
  ])('refuses a bad %s', (_, change, path) => {
    expect(refusal(() => parseSchema({ ...schema(), ...change })).path).toBe(path);
  });

  it.each([
    ['name', 0, { name: '__proto__' }, '$.fields[0].name'],
    ['label', 0, { label: { en: 'Account' } }, '$.fields[0].label.ar'],
    ['type', 0, { type: 'money' }, '$.fields[0].type'],
    ['editable', 0, { editable: 'no' }, '$.fields[0].editable'],
    [
      'reason on an editable field',
      0,
      { editable: true, editReason: 'notEditable' },
      '$.fields[0].editReason',
    ],
    ['read-only field without a reason', 0, { editReason: undefined }, '$.fields[0].editReason'],
    ['reason', 0, { editReason: 'because' }, '$.fields[0].editReason'],
    ['length', 0, { maxLength: 0 }, '$.fields[0].maxLength'],
    ['required', 0, { required: 'yes' }, '$.fields[0].required'],
    ['bound on text', 0, { min: 'a' }, '$.fields[0].min'],
    ['lookup without a list', 1, { lookup: 'groups' }, '$.fields[1].lookup'],
    ['decimal without a scale', 2, { scale: undefined }, '$.fields[2].scale'],
    ['decimal bound as a number', 2, { min: 0 }, '$.fields[2].min'],
    ['date bound', 4, { max: '2026-02-30' }, '$.fields[4].max'],
    ['integer bound', 6, { max: '9' }, '$.fields[6].max'],
    ['filterable', 3, { filterable: undefined }, '$.fields[3].filterable'],
    ['sortable', 3, { sortable: 1 }, '$.fields[3].sortable'],
  ])('refuses a field with a bad %s', (_, index, change, path) => {
    expect(refusal(() => parseSchema(withField(index, change))).path).toBe(path);
  });

  it('refuses repeated field names', () => {
    const s = schema();
    const fields = s.fields as unknown[];
    expect(refusal(() => parseSchema({ ...s, fields: [...fields, fields[1]] })).path).toBe(
      '$.fields',
    );
  });
});

describe('queries', () => {
  const read = () => parseSchema(schema()) as ConnectorSchema;

  it('reads a page, and checks it against the schema when given', () => {
    const answer = { records: [record()], nextCursor: 'c1', total: 3 };
    expect(parseQueryResponse(answer, { schema: read(), pageSize: 1 })).toEqual(answer);
    expect(parseQueryResponse({ records: [], nextCursor: null, total: 0 })).toEqual({
      records: [],
      nextCursor: null,
      total: 0,
    });
  });

  it.each([
    ['records', { records: {} }, '$.records'],
    ['record id', { records: [record({ id: '' })] }, '$.records[0].id'],
    ['record key', { records: [record({ key: null })] }, '$.records[0].key'],
    ['version', { records: [record({ version: 'not base64!' })] }, '$.records[0].version'],
    ['values', { records: [record({ values: [] })] }, '$.records[0].values'],
    [
      'value that is no wire value',
      { records: [record({ values: { ...values(), lines: { n: 4 } } })] },
      '$.records[0].values.lines',
    ],
    ['repeated ids', { records: [record(), record()] }, '$.records'],
    ['cursor', { nextCursor: '' }, '$.nextCursor'],
    ['total', { total: -1 }, '$.total'],
    ['total below the records sent', { total: 0 }, '$.total'],
  ])('refuses a bad %s', (_, change, path) => {
    const answer = { records: [record()], nextCursor: null, total: 1, ...change };
    expect(refusal(() => parseQueryResponse(answer)).path).toBe(path);
  });

  it('refuses more records than the page size', () => {
    const answer = { records: [record(), record({ id: '2' })], nextCursor: null, total: 2 };
    expect(refusal(() => parseQueryResponse(answer, { pageSize: 1 })).path).toBe('$.records');
  });

  it.each([
    ['decimal as a number', { debitLimit: 15000 }, 'debitLimit'],
    ['decimal past its scale', { debitLimit: '1.234' }, 'debitLimit'],
    ['date with a time', { opened: '2019-03-01T00:00:00Z' }, 'opened'],
    ['date-time without a zone', { modifiedDate: '2026-10-30T10:12:00' }, 'modifiedDate'],
    ['boolean as a number', { blocked: 0 }, 'blocked'],
    ['integer with a fraction', { lines: 4.5 }, 'lines'],
    ['lookup as a number', { vendorGroup: 7 }, 'vendorGroup'],
    ['text as a boolean', { vendorAccount: true }, 'vendorAccount'],
    ['field not in the schema', { secret: 'x' }, 'secret'],
    ['key that differs', { vendorAccount: 'V-9999' }, 'vendorAccount'],
  ])('catches a %s', (_, change, fieldName) => {
    const answer = {
      records: [record({ values: { ...values(), ...change } })],
      nextCursor: null,
      total: 1,
    };
    const e = refusal(() => parseQueryResponse(answer, { schema: read() }), '15000');
    expect(e.path).toBe(`$.records[0].values.${fieldName}`);
  });

  it('catches a missing field, and one not asked for', () => {
    const { blocked, ...rest } = values();
    void blocked;
    expect(recordProblems(read(), { key: 'V-1001', values: rest })).toEqual(['blocked: missing']);
    expect(
      recordProblems(read(), { key: 'V-1001', values: values() }, ['vendorAccount', 'debitLimit']),
    ).toEqual([
      'vendorGroup: not asked for',
      'blocked: not asked for',
      'opened: not asked for',
      'modifiedDate: not asked for',
      'lines: not asked for',
    ]);
    expect(
      recordProblems(read(), { key: 'V-1001', values: { debitLimit: null } }, ['debitLimit']),
    ).toEqual([]);
  });

  it('takes null for any field', () => {
    const empty = Object.fromEntries(Object.keys(values()).map((k) => [k, null]));
    expect(
      recordProblems(read(), { key: 'V-1001', values: { ...empty, vendorAccount: 'V-1001' } }),
    ).toEqual([]);
  });
});

// Phase 12 (INTEGRATIONS.md, "Reports"): a report's schema, its parameters and its answers.
describe('reports', () => {
  const report = (): Record<string, unknown> => ({
    id: 'apAging',
    kind: 'report',
    schemaVersion: 'apAging.1',
    keyField: 'vendorAccount',
    idField: null,
    maxPageSize: 1000,
    maxRecords: 10000,
    maxCommitRecords: 0,
    fields: [
      {
        name: 'vendorAccount',
        label: { en: 'Vendor account', ar: 'حساب المورد' },
        type: 'text',
        editable: false,
        editReason: 'notEditable',
        filterable: false,
        sortable: true,
      },
      {
        name: 'balance',
        label: { en: 'Balance', ar: 'الرصيد' },
        type: 'decimal',
        scale: 2,
        total: 'sum',
        editable: false,
        editReason: 'notEditable',
        filterable: false,
        sortable: true,
      },
      {
        name: 'band0',
        label: { en: 'Not due', ar: 'غير مستحق' },
        type: 'decimal',
        scale: 2,
        total: 'sum',
        editable: false,
        editReason: 'notEditable',
        filterable: false,
        sortable: true,
      },
      {
        name: 'openItems',
        label: { en: 'Open items', ar: 'البنود المفتوحة' },
        type: 'integer',
        editable: false,
        editReason: 'notEditable',
        filterable: false,
        sortable: true,
      },
    ],
    lookups: { vendorGroups: [{ code: 'LOCAL', label: 'محلي' }] },
    parameters: [
      {
        name: 'asOf',
        label: { en: 'As of', ar: 'حتى تاريخ' },
        type: 'date',
        required: true,
        default: 'today',
      },
      {
        name: 'ageBy',
        label: { en: 'Aged by', ar: 'العمر حسب' },
        type: 'choice',
        required: false,
        options: [
          { value: 'dueDate', label: { en: 'Due date', ar: 'تاريخ الاستحقاق' } },
          { value: 'invoiceDate', label: { en: 'Invoice date', ar: 'تاريخ الفاتورة' } },
        ],
        default: 'dueDate',
      },
      {
        name: 'vendorGroup',
        label: { en: 'Vendor group', ar: 'مجموعة الموردين' },
        type: 'lookup',
        required: false,
        lookup: 'vendorGroups',
        default: null,
      },
      {
        name: 'includeZero',
        label: { en: 'Include zero', ar: 'إظهار الصفري' },
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
  });
  const withParameter = (index: number, change: Record<string, unknown>) => {
    const s = report();
    const parameters = [...(s.parameters as Record<string, unknown>[])];
    parameters[index] = { ...parameters[index], ...change };
    return { ...s, parameters };
  };

  it('reads a report’s schema: its kind, totals and parameters of every type', () => {
    const read = parseSchema(report());
    expect(read.kind).toBe('report');
    expect(kindOf(read)).toBe('report');
    expect(kindOf(parseSchema(schema()))).toBe('entity');
    expect(read.fields.map((f) => f.total ?? null)).toEqual([null, 'sum', 'sum', null]);
    const [asOf, ageBy, group, zero] = read.parameters!;
    expect(asOf).toEqual({
      name: 'asOf',
      label: { en: 'As of', ar: 'حتى تاريخ' },
      type: 'date',
      required: true,
      default: 'today',
    });
    expect(ageBy).toMatchObject({ type: 'choice', default: 'dueDate' });
    expect(ageBy!.options!.map((o) => o.value)).toEqual(['dueDate', 'invoiceDate']);
    // A null default is no default.
    expect(group).toEqual({
      name: 'vendorGroup',
      label: { en: 'Vendor group', ar: 'مجموعة الموردين' },
      type: 'lookup',
      required: false,
      lookup: 'vendorGroups',
    });
    expect(zero).toMatchObject({ type: 'boolean', default: false });
    for (const fallback of ['monthStart', '2026-10-31', '1900-01-01', '9999-12-31']) {
      expect(parseSchema(withParameter(0, { default: fallback })).parameters![0]!.default).toBe(
        fallback,
      );
    }
  });

  it.each([
    ['kind', { kind: 'dashboard' }, '$.kind'],
    ['commit records on a report', { maxCommitRecords: 500 }, '$.maxCommitRecords'],
  ])('refuses a bad %s', (_, change, path) => {
    expect(refusal(() => parseSchema({ ...report(), ...change })).path).toBe(path);
  });

  it('refuses a parameter named twice', () => {
    const s = report();
    const parameters = s.parameters as unknown[];
    expect(
      refusal(() => parseSchema({ ...s, parameters: [...parameters, parameters[0]] })).path,
    ).toBe('$.parameters');
  });

  it.each([
    ['type', 0, { type: 'month' }, '$.parameters[0].type'],
    ['date default', 0, { default: 'yesterday' }, '$.parameters[0].default'],
    ['date default before 1900', 0, { default: '1899-12-31' }, '$.parameters[0].default'],
    ['date default that does not exist', 0, { default: '2026-02-30' }, '$.parameters[0].default'],
    ['choice without options', 1, { options: undefined }, '$.parameters[1].options'],
    ['choice with no option', 1, { options: [] }, '$.parameters[1].options'],
    [
      'choice with a repeated value',
      1,
      {
        options: [
          { value: 'a', label: { en: 'A', ar: 'أ' } },
          { value: 'a', label: { en: 'B', ar: 'ب' } },
        ],
      },
      '$.parameters[1].options',
    ],
    [
      'option label',
      1,
      { options: [{ value: 'a', label: 'A' }] },
      '$.parameters[1].options[0].label',
    ],
    ['choice default not an option', 1, { default: 'weekly' }, '$.parameters[1].default'],
    ['lookup without a list', 2, { lookup: 'groups' }, '$.parameters[2].lookup'],
    ['lookup default', 2, { default: 7 }, '$.parameters[2].default'],
    ['boolean default', 3, { default: 'false' }, '$.parameters[3].default'],
    ['name', 3, { name: 'include zero' }, '$.parameters[3].name'],
  ])('refuses a parameter with a bad %s', (_, index, change, path) => {
    expect(refusal(() => parseSchema(withParameter(index, change))).path).toBe(path);
  });

  it('refuses an editable field on a report, and a total that is not a sum of numbers', () => {
    const s = report();
    const fields = [...(s.fields as Record<string, unknown>[])];
    const edited = [
      fields[0],
      { ...fields[1], editable: true, editReason: undefined },
      ...fields.slice(2),
    ];
    expect(refusal(() => parseSchema({ ...s, fields: edited })).path).toBe('$.fields[1].editable');
    const text = [{ ...fields[0], total: 'sum' }, ...fields.slice(1)];
    expect(refusal(() => parseSchema({ ...s, fields: text })).path).toBe('$.fields[0].total');
    const average = [fields[0], { ...fields[1], total: 'average' }, ...fields.slice(2)];
    expect(refusal(() => parseSchema({ ...s, fields: average })).path).toBe('$.fields[1].total');
  });

  const page = (over: Record<string, unknown> = {}) => ({
    records: [
      {
        id: 'V-1001',
        key: 'V-1001',
        version: 'AAAAAAAAB9E=',
        values: { vendorAccount: 'V-1001', balance: '1100.00', band0: '500.00', openItems: 2 },
      },
    ],
    nextCursor: null,
    total: 1,
    ...over,
  });

  it('reads a report’s totals, labels and whether it was cut short', () => {
    const read = parseSchema(report());
    const answer = page({
      totals: { balance: '1100.00', band0: '500.00' },
      labels: { band0: { en: '0–30 days', ar: 'من 0 إلى 30 يومًا' } },
      partial: true,
    });
    expect(parseQueryResponse(answer, { schema: read })).toEqual(answer);
    // A report's answer without them, or with nulls, has none.
    expect(parseQueryResponse(page({ partial: null, totals: null }), { schema: read })).toEqual(
      page(),
    );
  });

  it.each([
    ['total the schema does not total', { totals: { openItems: 2 } }, '$.totals.openItems'],
    ['total of no field', { totals: { noSuch: '1.00' } }, '$.totals.noSuch'],
    ['total as a number', { totals: { balance: 1100 } }, '$.totals.balance'],
    ['total past its scale', { totals: { balance: '1.005' } }, '$.totals.balance'],
    ['totals that are no object', { totals: ['1.00'] }, '$.totals'],
    ['label without Arabic', { labels: { band0: { en: 'Not due' } } }, '$.labels.band0.ar'],
    ['label of no field', { labels: { noSuch: { en: 'x', ar: 'س' } } }, '$.labels.noSuch'],
    ['partial', { partial: 'yes' }, '$.partial'],
  ])('refuses a %s', (_, change, path) => {
    const read = parseSchema(report());
    expect(refusal(() => parseQueryResponse(page(change), { schema: read })).path).toBe(path);
  });

  it('asks for the kinds it knows, and reads only those', () => {
    expect(connectorsRoute(['entity', 'report'])).toBe(
      'api/connect/Connectors?kinds=entity,report',
    );
    expect(connectorsRoute(null)).toBe('api/connect/Connectors');
    const summary = (id: string, kind: string) => ({
      id,
      kind,
      label: { en: id, ar: 'س' },
      schemaVersion: `${id}.1`,
      access: 'view',
    });
    const listed = { connectors: [summary('vendors', 'entity'), summary('apAging', 'report')] };
    expect(parseConnectors(listed, ['entity', 'report']).connectors).toHaveLength(2);
    expect(refusal(() => parseConnectors(listed, null)).path).toBe('$.connectors[1].kind');
    expect(refusal(() => parseConnectors(listed, ['report'])).path).toBe('$.connectors[0].kind');
  });

  it('takes dates from 1900 to 9999 as a parameter', () => {
    for (const ok of ['1900-01-01', '2026-10-31', '9999-12-31']) {
      expect(isParameterDate(ok)).toBe(true);
    }
    for (const no of ['1899-12-31', '2026-02-30', '26-10-31', 20261031, null]) {
      expect(isParameterDate(no)).toBe(false);
    }
  });
});

describe('error bodies', () => {
  const body = () => ({
    message: 'Your session has ended.',
    correlationId: 'c-1',
    errors: [{ code: 'session.expired', message: 'Ended.' }],
  });

  it('reads an error body with field errors', () => {
    expect(parseErrorBody(body())).toEqual(body());
    const field = {
      id: '4411',
      key: 'V-1001',
      field: 'vendorName',
      code: 'required',
      message: 'x',
    };
    expect(parseErrorBody({ ...body(), errors: [field] }).errors[0]).toEqual(field);
  });

  it.each([
    ['message', { message: null }, '$.message'],
    ['correlation id', { correlationId: '' }, '$.correlationId'],
    ['errors', { errors: {} }, '$.errors'],
    ['code', { errors: [{ message: 'x' }] }, '$.errors[0].code'],
    ['error message', { errors: [{ code: 'x' }] }, '$.errors[0].message'],
    ['record id', { errors: [{ id: 4411, code: 'x', message: 'x' }] }, '$.errors[0].id'],
  ])('refuses a bad %s', (_, change, path) => {
    expect(refusal(() => parseErrorBody({ ...body(), ...change })).path).toBe(path);
  });
});

describe('the pop-up message', () => {
  const state = 'S'.repeat(22);

  it('gives the ticket only with the right type, state and ticket', () => {
    expect(readConnectMessage({ type: 'cgw-erp-connect', ticket: TICKET, state }, state)).toBe(
      TICKET,
    );
    expect(readConnectMessage({ type: 'cgw-erp-link', ticket: TICKET, state }, state)).toBeNull();
    expect(
      readConnectMessage({ type: 'cgw-erp-connect', ticket: TICKET, state: 'x' }, state),
    ).toBeNull();
    expect(
      readConnectMessage({ type: 'cgw-erp-connect', ticket: 'short', state }, state),
    ).toBeNull();
    expect(readConnectMessage('cgw-erp-connect', state)).toBeNull();
    expect(readConnectMessage(null, state)).toBeNull();
  });
});

describe('ErpError', () => {
  it('says its code and status, and nothing else', () => {
    const e = new ErpError('link.revoked', {
      status: 403,
      correlationId: 'c-9',
      retryAfterMs: null,
    });
    expect(e.message).toBe('Cash Gear ERP: link.revoked (403)');
    expect(e).toMatchObject({ code: 'link.revoked', status: 403, correlationId: 'c-9' });
    expect(new ErpError('network').status).toBeNull();
  });
});
