// An ERP view block's settings, read leniently from its attributes, and the query they make; how
// values read. No DOM.
import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatDecimal } from './format';
import type { ConnectorSchema } from '../contract';
import {
  filterText,
  parametersText,
  parseConditionValue,
  planQuery,
  readSettings,
  type ViewSettings,
} from './settings';
import { AP_SCHEMA, EMPTY_ATTRS, SCHEMA } from './testing';

const settings = (over: Partial<ViewSettings> = {}): ViewSettings => ({
  fields: null,
  search: '',
  equals: {},
  sort: [],
  pageSize: null,
  parameters: {},
  ...over,
});

describe('the block settings', () => {
  it('read what parses and ignore the rest', () => {
    expect(readSettings(EMPTY_ATTRS)).toEqual(settings());
    expect(
      readSettings({
        ...EMPTY_ATTRS,
        fields: '["a","a","__proto__x","9bad",3,"b"]',
        filter: '{"search":"x","equals":{"c":"1","d":{"no":1},"__proto__":1,"e":null}}',
        sort: '[{"field":"a","direction":"asc"},{"field":"a","direction":"desc"},{"field":"b","direction":"up"},{"field":"c","direction":"desc"},{"field":"d","direction":"asc"},{"field":"e","direction":"asc"}]',
        pageSize: 25,
      }),
    ).toEqual(
      settings({
        fields: ['a', 'b'],
        search: 'x',
        equals: { c: '1', e: null },
        sort: [
          { field: 'a', direction: 'asc' },
          { field: 'c', direction: 'desc' },
          { field: 'd', direction: 'asc' },
        ],
        pageSize: 25,
      }),
    );
    for (const bad of ['{', 'null', '"x"', '[]', '{"equals":[1]}'])
      expect(readSettings({ ...EMPTY_ATTRS, fields: bad, filter: bad, sort: bad })).toEqual(
        settings(),
      );
    expect(readSettings({ ...EMPTY_ATTRS, pageSize: -3 }).pageSize).toBeNull();
    expect(readSettings({ ...EMPTY_ATTRS, pageSize: 2.5 }).pageSize).toBeNull();
  });

  it('write a filter only when there is one', () => {
    expect(filterText('  ', {})).toBeNull();
    expect(filterText(' Qor ', {})).toBe('{"search":"Qor"}');
    expect(filterText('', { blocked: false })).toBe('{"equals":{"blocked":false}}');
  });

  it('plan the reader’s query: hidden fields left out, the page size cut', () => {
    expect(planQuery(SCHEMA, settings())).toMatchObject({
      kind: 'query',
      request: { filter: {}, pageSize: 50 },
      hidden: 0,
    });
    const plan = planQuery(
      SCHEMA,
      settings({
        fields: ['customerName', 'secret', 'creditLimit'],
        sort: [
          { field: 'secret', direction: 'asc' },
          { field: 'visits', direction: 'asc' },
          { field: 'customerName', direction: 'desc' },
        ],
        search: ' Q ',
        equals: { salesperson: 'S-BOB' },
        pageSize: 5000,
      }),
    );
    expect(plan).toEqual({
      kind: 'query',
      request: {
        filter: { search: 'Q', equals: { salesperson: 'S-BOB' } },
        fields: ['customerName', 'creditLimit'],
        sort: [{ field: 'customerName', direction: 'desc' }],
        pageSize: 500,
      },
      columns: [SCHEMA.fields[1], SCHEMA.fields[2]],
      // `secret` twice (a field, a sort) and `visits`, which cannot be sorted by.
      hidden: 3,
    });
    expect(planQuery(SCHEMA, settings({ fields: ['secret'] }))).toEqual({ kind: 'noField' });
    expect(planQuery(SCHEMA, settings({ equals: { secret: 1 } }))).toEqual({
      kind: 'filterDenied',
    });
    expect(planQuery(SCHEMA, settings({ equals: { customerName: 'x' } }))).toEqual({
      kind: 'filterNotFilterable',
    });
  });

  it('read a typed condition by its field’s type', () => {
    const f = (name: string) => SCHEMA.fields.find((x) => x.name === name)!;
    expect(parseConditionValue(f('customerAccount'), '')).toBeUndefined();
    expect(parseConditionValue(f('customerAccount'), 'C-1')).toBe('C-1');
    expect(parseConditionValue(f('visits'), ' 12 ')).toBe(12);
    expect(parseConditionValue(f('visits'), '1.5')).toBeUndefined();
    expect(parseConditionValue(f('creditLimit'), '10.25')).toBe('10.25');
    expect(parseConditionValue(f('creditLimit'), '10.255')).toBeUndefined();
    expect(parseConditionValue(f('blocked'), 'true')).toBe(true);
    expect(parseConditionValue(f('blocked'), '')).toBeNull();
    expect(parseConditionValue(f('lastInvoiceDate'), '2026-02-30')).toBeUndefined();
    expect(parseConditionValue(f('salesperson'), '')).toBeNull();
  });
});

describe('a report’s parameters (Phase 12)', () => {
  const p = (name: string) => AP_SCHEMA.parameters!.find((x) => x.name === name)!;

  it('read what parses: names, and values that are text, true or false, or null', () => {
    expect(readSettings(EMPTY_ATTRS).parameters).toEqual({});
    expect(
      readSettings({
        ...EMPTY_ATTRS,
        parameters:
          '{"asOf":"2026-10-31","ageBy":"invoiceDate","includeZero":true,"vendorGroup":null,"n":3,"o":{"a":1},"9bad":"x","__proto__":"y","gone":"kept"}',
      }).parameters,
    ).toEqual({
      asOf: '2026-10-31',
      ageBy: 'invoiceDate',
      includeZero: true,
      vendorGroup: null,
      gone: 'kept',
    });
    for (const bad of ['{', 'null', '"x"', '[1]', '3'])
      expect(readSettings({ ...EMPTY_ATTRS, parameters: bad }).parameters).toEqual({});
  });

  it('send a report its parameters, {} for every default, and an entity none', () => {
    expect(planQuery(AP_SCHEMA, settings())).toMatchObject({
      kind: 'query',
      request: { filter: {}, parameters: {}, pageSize: 50 },
    });
    // Only names the report lists, each with a value its type takes; the rest take the default.
    const plan = planQuery(
      AP_SCHEMA,
      settings({
        parameters: {
          asOf: '2026-10-31',
          ageBy: 'invoiceDate',
          vendorGroup: 'IMPORT',
          includeZero: true,
          gone: 'x',
        },
      }),
    );
    expect(plan.kind === 'query' && plan.request.parameters).toEqual({
      asOf: '2026-10-31',
      ageBy: 'invoiceDate',
      vendorGroup: 'IMPORT',
      includeZero: true,
    });
    const wrong = planQuery(
      AP_SCHEMA,
      settings({
        parameters: { asOf: '1899-12-31', ageBy: 'weekday', vendorGroup: true, includeZero: 'yes' },
      }),
    );
    expect(wrong.kind === 'query' && wrong.request.parameters).toEqual({});
    expect(
      planQuery(AP_SCHEMA, settings({ parameters: { asOf: '2026-02-30', vendorGroup: null } })),
    ).toMatchObject({ request: { parameters: { vendorGroup: null } } });
    // An entity's query never carries parameters, whatever the block holds.
    const entity = planQuery(SCHEMA, settings({ parameters: { asOf: '2026-10-31' } }));
    expect(entity.kind === 'query' && 'parameters' in entity.request).toBe(false);
  });

  it('ask nothing while a required parameter has neither a value nor a default', () => {
    const schema: ConnectorSchema = {
      ...AP_SCHEMA,
      parameters: [{ ...p('asOf'), default: undefined }, p('ageBy')],
    };
    expect(planQuery(schema, settings())).toEqual({
      kind: 'parameterNeeded',
      parameter: schema.parameters![0],
    });
    // A null is no value for a required one.
    expect(planQuery(schema, settings({ parameters: { asOf: null } })).kind).toBe(
      'parameterNeeded',
    );
    expect(planQuery(schema, settings({ parameters: { asOf: '2026-11-01' } }))).toMatchObject({
      kind: 'query',
      request: { parameters: { asOf: '2026-11-01' } },
    });
  });

  it('write what differs from the default, and keep names the report does not list', () => {
    expect(parametersText({}, p('asOf'), '2026-10-31')).toBe('{"asOf":"2026-10-31"}');
    expect(parametersText({ asOf: '2026-10-31' }, p('asOf'), undefined)).toBeNull();
    expect(parametersText({}, p('ageBy'), 'dueDate')).toBeNull();
    expect(parametersText({ ageBy: 'invoiceDate', gone: 1 as never }, p('ageBy'), 'dueDate')).toBe(
      '{"gone":1}',
    );
    expect(parametersText({}, p('includeZero'), false)).toBeNull();
    expect(parametersText({}, p('includeZero'), true)).toBe('{"includeZero":true}');
    // A lookup without a default: "All" is its default, so it is not held.
    expect(parametersText({ vendorGroup: 'LOCAL' }, p('vendorGroup'), null)).toBeNull();
    expect(parametersText({}, { ...p('vendorGroup'), default: 'LOCAL' }, null)).toBe(
      '{"vendorGroup":null}',
    );
  });
});

describe('values', () => {
  it('keep every digit of a decimal, grouped as the language groups', () => {
    expect(formatDecimal('15000.50', 'en')).toBe('15,000.50');
    expect(formatDecimal('-0.75', 'en')).toBe('-0.75');
    expect(formatDecimal('-0.00', 'en')).toBe('0.00');
    expect(formatDecimal('12345678901234567890.123456789', 'en')).toBe(
      '12,345,678,901,234,567,890.123456789',
    );
    expect(formatDecimal('not a number', 'en')).toBe('not a number');
    // Whatever digits and separators the language uses, the digits are all there.
    const arabic = formatDecimal('15000.50', 'ar');
    const western = arabic.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
    expect(western.replace(/[^0-9]/g, '')).toBe('1500050');
  });

  it('show dates as dates and date-times at the ERP’s clock with the offset', () => {
    expect(formatDate('2026-03-05', 'en')).toBe('Mar 5, 2026');
    expect(formatDateTime('2026-11-14T10:05:00+02:00', 'en')).toEqual({
      when: 'Nov 14, 2026, 10:05 AM',
      offset: 'UTC+02:00',
    });
    expect(formatDateTime('2026-11-14T23:59:59.1234567Z', 'en')).toEqual({
      when: 'Nov 14, 2026, 11:59 PM',
      offset: 'UTC',
    });
  });
});
