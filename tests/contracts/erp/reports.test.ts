// Phase 12, Track E11 (INTEGRATIONS.md, "Reports (Phase 12, Track E11)"): the three read-only
// report connectors, AP aging by vendor, stock balance on a date and a trial balance. Listed only
// when `Connectors?kinds=` names reports; each schema as the contract's tables give it; every
// parameter's checks and defaults; totals over every match whatever the page; AP aging's labels
// by `ageBy`; the cost field rule; each role's access; `Commit` refused. Against the mock the
// mock-only cases also check exact answers from its seeded ledgers (README.md, "Reports").

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectorRoute,
  commitStatusRoute,
  createErpClient,
  parseErrorBody,
  parseQueryResponse,
  type ConnectorSchema,
  type ErpRecord,
  type Localized,
  type QueryResponse,
  type SortKey,
  type WireValue,
} from '../../../packages/erp/src/index';
import {
  ORIGIN,
  baseUrl,
  connectTicket,
  control,
  lacks,
  listed,
  onMock,
  openSession,
  query,
  refused,
  resetMock,
  schemaOf,
  send,
  sharedLink,
  sharedSession,
  startServer,
  stopServer,
  WORKSPACE,
  type Answer,
  type Role,
} from './harness';
import { decimalOrder, textOrder, valueOrder } from './rules';

const MINUTE = 60_000;
const mockOnly = it.skipIf(!onMock);
if (!onMock) vi.setConfig({ testTimeout: 10 * MINUTE, hookTimeout: 10 * MINUTE });

beforeAll(startServer);
afterAll(stopServer);
beforeEach(resetMock);

const REPORTS = ['apAging', 'stockBalance', 'trialBalance'] as const;
type Report = (typeof REPORTS)[number];

// ---------------------------------------------------------------------------------------------
// The contract's tables

const l = (en: string, ar: string): Localized => ({ en, ar });

interface FieldRow {
  readonly name: string;
  readonly type: string;
  readonly label?: Localized;
  readonly total?: boolean;
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly lookup?: string;
}
interface ParameterRow {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly default: string | boolean | null;
  readonly label: Localized;
  readonly options?: readonly string[];
  /** The options' Arabic labels where the contract gives them. */
  readonly optionsAr?: readonly string[];
  readonly lookup?: string;
}

const BANDS_DUE = [
  l('Not due', 'غير مستحق'),
  l('1–30 days', 'من 1 إلى 30 يومًا'),
  l('31–60 days', 'من 31 إلى 60 يومًا'),
  l('61–90 days', 'من 61 إلى 90 يومًا'),
  l('Over 90 days', 'أكثر من 90 يومًا'),
];
const BANDS_INVOICE = [
  l('0–30 days', 'من 0 إلى 30 يومًا'),
  l('31–60 days', 'من 31 إلى 60 يومًا'),
  l('61–90 days', 'من 61 إلى 90 يومًا'),
  l('91–120 days', 'من 91 إلى 120 يومًا'),
  l('Over 120 days', 'أكثر من 120 يومًا'),
];

const TABLES: Record<
  Report,
  { keyField: string; schemaVersion: string; parameters: ParameterRow[]; fields: FieldRow[] }
> = {
  apAging: {
    keyField: 'vendorAccount',
    schemaVersion: 'apAging.1',
    parameters: [
      {
        name: 'asOf',
        type: 'date',
        required: true,
        default: 'today',
        label: l('As of', 'حتى تاريخ'),
      },
      {
        name: 'ageBy',
        type: 'choice',
        required: false,
        default: 'dueDate',
        label: l('Aged by', 'العمر حسب'),
        options: ['dueDate', 'invoiceDate'],
        optionsAr: ['تاريخ الاستحقاق', 'تاريخ الفاتورة'],
      },
      {
        name: 'basis',
        type: 'choice',
        required: false,
        default: 'oldestFirst',
        label: l('Basis', 'الأساس'),
        options: ['oldestFirst', 'openItems'],
        optionsAr: ['الأقدم أولًا', 'البنود المفتوحة'],
      },
      {
        name: 'vendorGroup',
        type: 'lookup',
        required: false,
        default: null,
        label: l('Vendor group', 'مجموعة الموردين'),
        lookup: 'vendorGroups',
      },
    ],
    fields: [
      {
        name: 'vendorAccount',
        type: 'text',
        label: l('Vendor account', 'حساب المورد'),
        sortable: true,
      },
      { name: 'vendorName', type: 'text', label: l('Vendor', 'المورد'), sortable: true },
      {
        name: 'vendorGroup',
        type: 'lookup',
        label: l('Group', 'المجموعة'),
        filterable: true,
        sortable: true,
        lookup: 'vendorGroups',
      },
      {
        name: 'balance',
        type: 'decimal',
        label: l('Balance', 'الرصيد'),
        total: true,
        sortable: true,
      },
      ...BANDS_DUE.map((label, i) => ({
        name: `band${i}`,
        type: 'decimal',
        label,
        total: true,
        sortable: true,
      })),
      {
        name: 'unapplied',
        type: 'decimal',
        label: l('Unapplied', 'غير مخصص'),
        total: true,
        sortable: true,
      },
      {
        name: 'overdue',
        type: 'decimal',
        label: l('Overdue', 'متأخر السداد'),
        total: true,
        sortable: true,
      },
      {
        name: 'openItems',
        type: 'integer',
        label: l('Open items', 'البنود المفتوحة'),
        sortable: true,
      },
      {
        name: 'oldestDays',
        type: 'integer',
        label: l('Oldest, days', 'الأقدم بالأيام'),
        sortable: true,
      },
      { name: 'lastInvoice', type: 'date', label: l('Last invoice', 'آخر فاتورة'), sortable: true },
      { name: 'lastPayment', type: 'date', label: l('Last payment', 'آخر دفعة'), sortable: true },
      {
        name: 'lastPaymentAmount',
        type: 'decimal',
        label: l('Last payment amount', 'مبلغ آخر دفعة'),
        sortable: true,
      },
    ],
  },
  stockBalance: {
    keyField: 'itemId',
    schemaVersion: 'stockBalance.1',
    parameters: [
      {
        name: 'asOf',
        type: 'date',
        required: true,
        default: 'today',
        label: l('As of', 'حتى تاريخ'),
      },
      {
        name: 'siteId',
        type: 'lookup',
        required: false,
        default: null,
        label: l('Site', 'الموقع'),
        lookup: 'sites',
      },
      {
        name: 'warehouseId',
        type: 'lookup',
        required: false,
        default: null,
        label: l('Warehouse', 'المخزن'),
        lookup: 'warehouses',
      },
      {
        name: 'includeZero',
        type: 'boolean',
        required: false,
        default: false,
        label: l('Include zero balances', 'إظهار الأرصدة الصفرية'),
      },
    ],
    fields: [
      { name: 'itemId', type: 'text', label: l('Item', 'الصنف'), sortable: true },
      { name: 'itemName', type: 'text', label: l('Item name', 'اسم الصنف'), sortable: true },
      { name: 'unit', type: 'text', label: l('Unit', 'الوحدة'), sortable: true },
      {
        name: 'categoryId',
        type: 'text',
        label: l('Category', 'الفئة'),
        filterable: true,
        sortable: true,
      },
      {
        name: 'siteId',
        type: 'lookup',
        label: l('Site', 'الموقع'),
        filterable: true,
        sortable: true,
        lookup: 'sites',
      },
      {
        name: 'warehouseId',
        type: 'lookup',
        label: l('Warehouse', 'المخزن'),
        filterable: true,
        sortable: true,
        lookup: 'warehouses',
      },
      { name: 'locationId', type: 'text', label: l('Location', 'المكان'), sortable: true },
      {
        name: 'quantity',
        type: 'decimal',
        label: l('Quantity', 'الكمية'),
        total: true,
        sortable: true,
      },
      { name: 'cost', type: 'decimal', label: l('Cost', 'التكلفة'), total: true, sortable: true },
      { name: 'unitCost', type: 'decimal', label: l('Unit cost', 'تكلفة الوحدة'), sortable: true },
      {
        name: 'salesValue',
        type: 'decimal',
        label: l('Sales value', 'قيمة البيع'),
        total: true,
        sortable: true,
      },
    ],
  },
  trialBalance: {
    keyField: 'accountId',
    schemaVersion: 'trialBalance.1',
    parameters: [
      {
        name: 'dateFrom',
        type: 'date',
        required: true,
        default: 'monthStart',
        label: l('From', 'من'),
      },
      { name: 'dateTo', type: 'date', required: true, default: 'today', label: l('To', 'إلى') },
      {
        name: 'statement',
        type: 'choice',
        required: false,
        default: 'profitLoss',
        label: l('Statement', 'القائمة'),
        options: ['profitLoss', 'balanceSheet'],
        optionsAr: ['الأرباح والخسائر', 'الميزانية العمومية'],
      },
    ],
    fields: [
      { name: 'accountId', type: 'text', label: l('Account', 'الحساب'), sortable: true },
      { name: 'accountName', type: 'text', label: l('Account name', 'اسم الحساب'), sortable: true },
      {
        name: 'accountType',
        type: 'text',
        label: l('Type', 'النوع'),
        filterable: true,
        sortable: true,
      },
      {
        name: 'accountGroup',
        type: 'text',
        label: l('Group', 'المجموعة'),
        filterable: true,
        sortable: true,
      },
      {
        name: 'category',
        type: 'text',
        label: l('Category', 'التصنيف'),
        filterable: true,
        sortable: true,
      },
      {
        name: 'balance',
        type: 'decimal',
        label: l('Movement', 'الحركة'),
        total: true,
        sortable: true,
      },
      { name: 'share', type: 'decimal', label: l('Share', 'النسبة'), sortable: true },
    ],
  },
};

/** Who may view each report (README.md, "Reports"): the pages' roles given to the test users. */
const ACCESS: Record<Report, { may: Role[]; mayNot: Role[] }> = {
  apAging: { may: ['full', 'edit', 'other'], mayNot: ['limited', 'none', 'advEdit'] },
  stockBalance: { may: ['full', 'limited', 'advEdit', 'other'], mayNot: ['edit', 'none'] },
  trialBalance: { may: ['full', 'other'], mayNot: ['limited', 'edit', 'none', 'advEdit'] },
};

// ---------------------------------------------------------------------------------------------
// Helpers

const token = async (role: Role = 'full') => (await sharedSession(role)).token;

/** A report's query: `parameters` as given (none at all when `undefined` is passed explicitly). */
function report(
  t: string,
  id: Report,
  parameters: Record<string, unknown> | undefined,
  request: Parameters<typeof query>[2] = {},
): Promise<Answer> {
  return query(t, id, {
    pageSize: 1000,
    ...request,
    ...(parameters ? { parameters } : {}),
  } as never);
}

/** Every page of a report's query. */
async function allOf(
  t: string,
  id: Report,
  schema: ConnectorSchema,
  parameters: Record<string, unknown>,
  request: { pageSize?: number; sort?: SortKey[]; filter?: object; fields?: string[] } = {},
): Promise<{ pages: QueryResponse[]; records: ErpRecord[] }> {
  const pages: QueryResponse[] = [];
  let cursor: string | null = null;
  do {
    const answer = await report(t, id, parameters, { ...request, cursor } as never);
    expect(answer.status, `${id} page ${pages.length + 1}`).toBe(200);
    pages.push(parseQueryResponse(answer.json, { schema, fields: request.fields }));
    cursor = pages.at(-1)!.nextCursor;
  } while (cursor !== null && pages.length < 500);
  return { pages, records: pages.flatMap((p) => p.records) };
}

/** A decimal sum, exactly, at `scale` places. */
function sum(values: readonly WireValue[], scale: number): string {
  let total = 0n;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const text = String(v);
    const negative = text.startsWith('-');
    const [whole, fraction = ''] = text.replace('-', '').split('.');
    const units = BigInt(whole + fraction.padEnd(scale, '0').slice(0, scale));
    total += negative ? -units : units;
  }
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, '0');
  const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return negative ? `-${text}` : text;
}

const scaleOf = (text: string) => (text.includes('.') ? text.length - text.indexOf('.') - 1 : 0);

/** The calendar days around today in UTC: the company's today is one of them. */
function aroundToday(): string[] {
  const now = Date.now();
  return [-1, 0, 1].map((d) => new Date(now + d * 86_400_000).toISOString().slice(0, 10));
}

function errorsOf(answer: Answer): { field?: string; code: string }[] {
  return parseErrorBody(answer.json).errors.map((e) => ({
    ...(e.field ? { field: e.field } : {}),
    code: e.code,
  }));
}

// ---------------------------------------------------------------------------------------------

describe('listing reports', () => {
  it.skipIf(lacks('admin', 'full', 'limited', 'none', 'edit'))(
    'lists them only when kinds names reports, as kind report',
    async () => {
      const full = await token('full');
      const without = await listed(full, null);
      expect(without.every((c) => c.kind === 'entity')).toBe(true);
      expect(await listed(full, 'entity')).toEqual(without);
      const both = await listed(full, 'entity,report');
      expect(both.filter((c) => c.kind === 'entity')).toEqual(without);
      const reports = both.filter((c) => c.kind === 'report');
      expect(reports.map((c) => c.id).sort()).toEqual([...REPORTS].sort());
      for (const c of reports) {
        expect(c.schemaVersion).toBe(TABLES[c.id as Report].schemaVersion);
        expect(c.access).toBe('view');
      }
      expect((await listed(full, 'report')).map((c) => c.id).sort()).toEqual([...REPORTS].sort());
      const ids = async (role: Role) =>
        (await listed(await token(role), 'entity,report'))
          .filter((c) => c.kind === 'report')
          .map((c) => c.id)
          .sort();
      expect(await ids('limited')).toEqual(['stockBalance']);
      expect(await ids('edit')).toEqual(['apAging']);
      expect(await ids('none')).toEqual([]);
    },
  );

  mockOnly('lists the reports after the entities, leaving out kinds it does not know', async () => {
    const full = await token('full');
    expect((await listed(full, 'entity,report')).map((c) => c.id)).toEqual([
      'vendors',
      'customers',
      'itemsOnHand',
      'apAging',
      'stockBalance',
      'trialBalance',
    ]);
    expect((await listed(full, 'report,dashboard')).map((c) => c.id)).toEqual([...REPORTS]);
    const labels = Object.fromEntries((await listed(full, 'report')).map((c) => [c.id, c.label]));
    expect(labels).toEqual({
      apAging: l('AP aging by vendor', 'أعمار ديون الموردين'),
      stockBalance: l('Stock balance on a date', 'رصيد المخزون في تاريخ'),
      trialBalance: l('Trial balance', 'ميزان المراجعة'),
    });
  });
});

describe.each(REPORTS.map((id) => [id]))('%s', (id: Report) => {
  const table = TABLES[id];

  it.skipIf(lacks('admin', 'full'))('has the contract’s schema, read-only', async () => {
    const schema = await schemaOf(await token('full'), id);
    expect(schema.kind).toBe('report');
    expect(schema.schemaVersion).toBe(table.schemaVersion);
    expect(schema.keyField).toBe(table.keyField);
    expect(schema.maxPageSize).toBe(1000);
    expect(schema.maxRecords).toBe(10_000);
    expect(schema.maxCommitRecords).toBe(0);
    expect(schema.fields.map((f) => f.name)).toEqual(table.fields.map((f) => f.name));
    for (const [i, f] of schema.fields.entries()) {
      const want = table.fields[i]!;
      expect(
        {
          type: f.type,
          editable: f.editable,
          editReason: f.editReason,
          total: f.total ?? null,
          filterable: f.filterable,
          sortable: f.sortable,
          lookup: f.lookup ?? null,
        },
        f.name,
      ).toEqual({
        type: want.type,
        editable: false,
        editReason: 'notEditable',
        total: want.total ? 'sum' : null,
        filterable: want.filterable ?? false,
        sortable: want.sortable ?? false,
        lookup: want.lookup ?? null,
      });
      if (want.label) expect(f.label, f.name).toEqual(want.label);
    }
    expect((schema.parameters ?? []).map((p) => p.name)).toEqual(
      table.parameters.map((p) => p.name),
    );
    for (const [i, p] of (schema.parameters ?? []).entries()) {
      const want = table.parameters[i]!;
      expect(
        {
          type: p.type,
          required: p.required,
          default: p.default ?? null,
          label: p.label,
          lookup: p.lookup ?? null,
          options: p.options?.map((o) => o.value) ?? null,
        },
        p.name,
      ).toEqual({
        type: want.type,
        required: want.required,
        default: want.default,
        label: want.label,
        lookup: want.lookup ?? null,
        options: want.options ?? null,
      });
      if (want.optionsAr) expect(p.options!.map((o) => o.label.ar)).toEqual(want.optionsAr);
      if (p.lookup) expect(schema.lookups[p.lookup], p.name).toBeDefined();
    }
  });

  it.skipIf(lacks('admin', 'full'))(
    'answers rows with an id, its key and a version, in the report’s own order',
    async () => {
      const t = await token('full');
      const schema = await schemaOf(t, id);
      const { records } = await allOf(t, id, schema, {});
      for (const r of records) {
        expect(r.key, r.id).toBe(String(r.values[table.keyField]));
        if (id === 'stockBalance') {
          const v = r.values;
          expect(r.id).toBe(
            [v.itemId, v.siteId ?? '', v.warehouseId ?? '', v.locationId ?? ''].join('|'),
          );
        } else expect(r.id).toBe(r.key);
      }
      for (let i = 1; i < records.length; i++) {
        const [a, b] = [records[i - 1]!.values, records[i]!.values];
        if (id === 'stockBalance') {
          const ka = [a.itemId, a.siteId, a.warehouseId, a.locationId].map((x) => x ?? '');
          const kb = [b.itemId, b.siteId, b.warehouseId, b.locationId].map((x) => x ?? '');
          const order = ka.map((x, j) => (x === kb[j] ? 0 : x < kb[j]! ? -1 : 1)).find((x) => x);
          expect(order, `${records[i]!.id} after ${records[i - 1]!.id}`).toBe(-1);
        } else {
          const order = decimalOrder(String(a.balance), String(b.balance));
          expect(order, `${records[i]!.key}'s balance`).toBeGreaterThanOrEqual(0);
          if (order === 0 && id === 'apAging') {
            expect(textOrder(String(a.vendorName), String(b.vendorName))).toBeLessThanOrEqual(0);
          }
        }
      }
    },
  );

  it.skipIf(lacks('admin', 'full'))('refuses a query without parameters', async () => {
    const t = await token('full');
    // An older build's query: no `parameters` at all.
    refused(await report(t, id, undefined), 400, 'request.invalid');
    refused(
      await send('POST', connectorRoute(id, 'Query'), {
        session: t,
        body: { filter: {}, cursor: null, pageSize: 10, parameters: [] },
      }),
      400,
      'request.invalid',
    );
    expect((await report(t, id, {})).status).toBe(200);
  });

  it.skipIf(lacks('admin', 'full'))(
    'takes each absent parameter’s default, `null` as absent',
    async () => {
      const t = await token('full');
      const schema = await schemaOf(t, id);
      const shown = async (parameters: Record<string, unknown>) => {
        const { pages, records } = await allOf(t, id, schema, parameters);
        return { records: records.map((r) => [r.id, r.values]), totals: pages[0]!.totals };
      };
      const defaults = await shown({});
      const nulls = await shown(Object.fromEntries(table.parameters.map((p) => [p.name, null])));
      expect(nulls).toEqual(defaults);
      // Every default written out: one of the days around today is the company's today.
      const explicit = await Promise.all(
        aroundToday().map((today) =>
          shown(
            Object.fromEntries(
              table.parameters.map((p) => [
                p.name,
                p.default === 'today'
                  ? today
                  : p.default === 'monthStart'
                    ? `${today.slice(0, 8)}01`
                    : p.default,
              ]),
            ),
          ),
        ),
      );
      expect(explicit).toContainEqual(defaults);
    },
  );

  it.skipIf(lacks('admin', 'full'))(
    'lists every wrong parameter, each by its name, and runs none',
    async () => {
      const t = await token('full');
      const wrong: Record<string, unknown> = { noSuchParameter: 1 };
      const expected = [{ field: 'parameters.noSuchParameter', code: 'request.invalid' }];
      for (const p of table.parameters) {
        const [value, code] =
          p.type === 'date'
            ? ['2026-02-30', 'type']
            : p.type === 'choice'
              ? ['notAnOption', 'type']
              : p.type === 'lookup'
                ? ['NO-SUCH-CODE', 'lookup.notFound']
                : ['yes', 'type'];
        wrong[p.name] = value;
        expected.push({ field: `parameters.${p.name}`, code });
      }
      const answer = await report(t, id, wrong);
      expect(answer.status).toBe(400);
      expect(errorsOf(answer).sort((a, b) => a.field!.localeCompare(b.field!))).toEqual(
        expected.sort((a, b) => a.field.localeCompare(b.field)),
      );
      // Each kind alone, and a date out of range.
      const date = table.parameters.find((p) => p.type === 'date')!.name;
      for (const [value, code] of [
        ['1899-12-31', 'range'],
        ['2026-13-01', 'type'],
        ['31/10/2026', 'type'],
        [20261031, 'type'],
      ] as const) {
        const one = await report(t, id, { [date]: value });
        expect(one.status, `${date} ${value}`).toBe(400);
        expect(errorsOf(one)).toEqual([{ field: `parameters.${date}`, code }]);
      }
    },
  );

  it.skipIf(lacks('admin', 'full'))(
    'totals every summed field over every match, the same on every page',
    async () => {
      const t = await token('full');
      const schema = await schemaOf(t, id);
      const summed = schema.fields.filter((f) => f.total === 'sum');
      expect(summed.map((f) => f.name)).toEqual(
        table.fields.filter((f) => f.total).map((f) => f.name),
      );
      const check = async (request: { filter?: object; fields?: string[] }) => {
        const { pages, records } = await allOf(t, id, schema, {}, { ...request, pageSize: 3 });
        const named = request.fields ?? schema.fields.map((f) => f.name);
        for (const page of pages) {
          expect(page.totals, 'totals on every page').toEqual(pages[0]!.totals);
          expect(page.total).toBe(records.length);
        }
        const totals = pages[0]!.totals ?? {};
        expect(Object.keys(totals).sort()).toEqual(
          summed
            .map((f) => f.name)
            .filter((n) => named.includes(n))
            .sort(),
        );
        for (const [name, value] of Object.entries(totals)) {
          const scale = scaleOf(String(value));
          expect(value, name).toBe(
            sum(
              records.map((r) => r.values[name]!),
              scale,
            ),
          );
        }
        return records;
      };
      const all = await check({});
      // Over a filter's matches only, and the fields asked for.
      const first = all[0];
      if (first) {
        const search = String(first.key).slice(0, 4);
        const found = await check({ filter: { search } });
        expect(found.length).toBeLessThanOrEqual(all.length);
        await check({ fields: [table.keyField, summed[0]!.name] });
      }
    },
  );

  it.skipIf(lacks('admin', 'full'))(
    'pages, sorts, filters and searches its rows as an entity’s, each row once',
    async () => {
      const t = await token('full');
      const schema = await schemaOf(t, id);
      const whole = (await allOf(t, id, schema, {})).records;
      const paged = await allOf(t, id, schema, {}, { pageSize: 2 });
      expect(paged.records.map((r) => r.id)).toEqual(whole.map((r) => r.id));
      for (const f of schema.fields.filter((x) => x.sortable).slice(0, 4)) {
        for (const direction of ['asc', 'desc'] as const) {
          const { records } = await allOf(
            t,
            id,
            schema,
            {},
            { sort: [{ field: f.name, direction }] },
          );
          expect(new Set(records.map((r) => r.id))).toEqual(new Set(whole.map((r) => r.id)));
          for (let i = 1; i < records.length; i++) {
            const order = valueOrder(
              f.type,
              records[i - 1]!.values[f.name],
              records[i]!.values[f.name],
            );
            expect(direction === 'asc' ? order <= 0 : order >= 0, `${f.name} ${direction}`).toBe(
              true,
            );
          }
        }
      }
      const filterable = schema.fields.find((f) => f.filterable);
      const value = whole.map((r) => r.values[filterable!.name]).find((v) => v !== null);
      if (value !== undefined) {
        const { records } = await allOf(
          t,
          id,
          schema,
          {},
          {
            filter: { equals: { [filterable!.name]: value } },
          },
        );
        expect(records.length).toBe(
          whole.filter((r) => r.values[filterable!.name] === value).length,
        );
      }
      // Another query's cursor: other parameters are another query.
      const page = parseQueryResponse((await report(t, id, {}, { pageSize: 1 })).json);
      if (page.nextCursor) {
        const other = table.parameters.find((p) => p.type === 'date')!.name;
        refused(
          await report(t, id, { [other]: '2025-01-31' }, { pageSize: 1, cursor: page.nextCursor }),
          400,
          'request.invalid',
        );
      }
    },
  );

  it.skipIf(lacks('admin', 'full', 'limited', 'none', 'edit', 'advEdit', 'other'))(
    'is the ERP page’s own: its roles may view it, no one else',
    async () => {
      for (const role of ACCESS[id].may) {
        const t = await token(role);
        expect((await send('GET', connectorRoute(id, 'Schema'), { session: t })).status, role).toBe(
          200,
        );
        expect((await report(t, id, {})).status, role).toBe(200);
      }
      for (const role of ACCESS[id].mayNot) {
        const t = await token(role);
        refused(
          await send('GET', connectorRoute(id, 'Schema'), { session: t }),
          403,
          'privilege.denied',
        );
        refused(await report(t, id, {}), 403, 'privilege.denied');
      }
    },
  );

  it.skipIf(lacks('admin', 'full'))('commits nothing, by any request', async () => {
    const t = await token('full');
    const summary = (await listed(t, 'report')).find((c) => c.id === id)!;
    expect(summary.access).toBe('view');
    for (const dryRun of [true, false]) {
      refused(
        await send('POST', connectorRoute(id, 'Commit'), {
          session: t,
          body: {
            commitId: crypto.randomUUID(),
            schemaVersion: table.schemaVersion,
            dryRun,
            source: { workspaceId: WORKSPACE, pageId: crypto.randomUUID(), blockId: null },
            records: [
              { id: 'x', key: 'x', version: 'AAAAAAAAAAE=', changes: { x: { from: null, to: 1 } } },
            ],
          },
        }),
        403,
        'privilege.denied',
      );
    }
    const status = await send('GET', commitStatusRoute(id, crypto.randomUUID()), { session: t });
    expect(status.status).toBe(200);
    expect(status.json).toEqual({ status: 'unknown' });
  });
});

describe('AP aging by vendor', () => {
  it.skipIf(lacks('admin', 'full'))('labels its bands by the date it ages by', async () => {
    const t = await token('full');
    const schema = await schemaOf(t, 'apAging');
    expect(
      [0, 1, 2, 3, 4].map((i) => schema.fields.find((f) => f.name === `band${i}`)!.label),
    ).toEqual(BANDS_DUE);
    const labels = async (parameters: Record<string, unknown>) =>
      parseQueryResponse((await report(t, 'apAging', parameters, { pageSize: 5 })).json, { schema })
        .labels;
    const bands = (made: Record<string, Localized> | undefined) =>
      [0, 1, 2, 3, 4].map((i) => made?.[`band${i}`]);
    expect(bands(await labels({}))).toEqual(BANDS_DUE);
    expect(bands(await labels({ ageBy: 'dueDate' }))).toEqual(BANDS_DUE);
    expect(bands(await labels({ ageBy: 'invoiceDate' }))).toEqual(BANDS_INVOICE);
  });

  it.skipIf(lacks('admin', 'full'))(
    'leaves nothing unapplied on the oldest-first basis, and filters by group',
    async () => {
      const t = await token('full');
      const schema = await schemaOf(t, 'apAging');
      const { records } = await allOf(t, 'apAging', schema, { basis: 'oldestFirst' });
      for (const r of records) expect(decimalOrder(String(r.values.unapplied), '0'), r.key).toBe(0);
      const group = records.map((r) => r.values.vendorGroup).find((g) => g !== null);
      if (group) {
        const grouped = await allOf(t, 'apAging', schema, { vendorGroup: group });
        expect(grouped.records.length).toBeGreaterThan(0);
        for (const r of grouped.records) expect(r.values.vendorGroup).toBe(group);
      }
    },
  );

  mockOnly('ages as the mock’s ledger says, on each basis and date', async () => {
    const t = await token('full');
    const schema = await schemaOf(t, 'apAging');
    const row = async (key: string, parameters: Record<string, unknown>) =>
      (await allOf(t, 'apAging', schema, parameters)).records.find((r) => r.key === key)?.values;
    const asOf = '2026-10-31';
    expect(await row('V-1001', { asOf })).toEqual({
      vendorAccount: 'V-1001',
      vendorName: 'Qorvath Lantern Trading',
      vendorGroup: 'LOCAL',
      balance: '1100.00',
      band0: '500.00',
      band1: '0.00',
      band2: '0.00',
      band3: '600.00',
      band4: '0.00',
      unapplied: '0.00',
      overdue: '600.00',
      openItems: 2,
      oldestDays: 61,
      lastInvoice: '2026-10-01',
      lastPayment: '2026-10-15',
      lastPaymentAmount: '100.00',
    });
    expect(await row('V-1001', { asOf, basis: 'openItems' })).toMatchObject({
      balance: '1100.00',
      band0: '500.00',
      band3: '700.00',
      unapplied: '100.00',
      overdue: '700.00',
      openItems: 2,
    });
    expect(await row('V-1001', { asOf, ageBy: 'invoiceDate' })).toMatchObject({
      band0: '500.00',
      band3: '600.00',
      oldestDays: 91,
      overdue: '600.00',
    });
    expect(await row('V-1003', { asOf })).toMatchObject({
      balance: '750.25',
      band4: '750.25',
      oldestDays: 214,
      lastPayment: null,
      lastPaymentAmount: null,
    });
    // Paid in full by then; open before its payment.
    expect(await row('V-1002', { asOf })).toBeUndefined();
    expect(await row('V-1002', { asOf: '2026-07-01' })).toMatchObject({
      balance: '2000.00',
      band0: '2000.00',
      lastPayment: null,
    });
    expect(await row('V-1004', { asOf })).toBeUndefined();
    // A group no longer active is no choice, though a vendor may still be in it.
    expect(await row('V-1007', { asOf })).toMatchObject({ vendorGroup: 'OLD', band1: '120.00' });
    const old = await report(t, 'apAging', { vendorGroup: 'OLD' });
    expect(errorsOf(old)).toEqual([{ field: 'parameters.vendorGroup', code: 'lookup.notFound' }]);
  });

  mockOnly('never answers another company’s ledger', async () => {
    const theirs = await openSession('other');
    const schema = await schemaOf(theirs.token, 'apAging');
    const { records } = await allOf(theirs.token, 'apAging', schema, { asOf: '2026-10-31' });
    expect(records.map((r) => [r.key, r.values.vendorName])).toEqual([
      ['V-1001', 'Ferrowyn Dot Foods'],
    ]);
  });
});

describe('stock balance on a date', () => {
  it.skipIf(lacks('admin', 'full', 'limited'))(
    'keeps cost from a user the ERP’s page does not show it to',
    async () => {
      const limited = await token('limited');
      const schema = await schemaOf(limited, 'stockBalance');
      const names = schema.fields.map((f) => f.name);
      expect(names).not.toContain('cost');
      expect(names).not.toContain('unitCost');
      const { pages, records } = await allOf(limited, 'stockBalance', schema, {});
      for (const r of records) {
        expect(r.values).not.toHaveProperty('cost');
        expect(r.values).not.toHaveProperty('unitCost');
      }
      expect(pages[0]!.totals).not.toHaveProperty('cost');
      refused(
        await report(limited, 'stockBalance', {}, { fields: ['itemId', 'cost'] }),
        400,
        'request.invalid',
      );
      refused(
        await report(limited, 'stockBalance', {}, { sort: [{ field: 'cost', direction: 'asc' }] }),
        400,
        'request.invalid',
      );
      const full = await schemaOf(await token('full'), 'stockBalance');
      expect(full.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['cost', 'unitCost']));
    },
  );

  it.skipIf(lacks('admin', 'full'))(
    'shows places at zero only when asked, and filters by site and warehouse',
    async () => {
      const t = await token('full');
      const schema = await schemaOf(t, 'stockBalance');
      const zero = (r: ErpRecord) =>
        decimalOrder(String(r.values.quantity), '0') === 0 &&
        decimalOrder(String(r.values.cost), '0') === 0;
      const without = (await allOf(t, 'stockBalance', schema, {})).records;
      const withZero = (await allOf(t, 'stockBalance', schema, { includeZero: true })).records;
      expect(without.some(zero)).toBe(false);
      expect(new Set(withZero.map((r) => r.id))).toEqual(
        new Set([...without.map((r) => r.id), ...withZero.filter(zero).map((r) => r.id)]),
      );
      const site = without.map((r) => r.values.siteId).find((v) => v !== null);
      if (site) {
        const at = (await allOf(t, 'stockBalance', schema, { siteId: site })).records;
        expect(at.length).toBeGreaterThan(0);
        for (const r of at) expect(r.values.siteId).toBe(site);
      }
      const warehouse = without.map((r) => r.values.warehouseId).find((v) => v !== null);
      if (warehouse) {
        const at = (await allOf(t, 'stockBalance', schema, { warehouseId: warehouse })).records;
        for (const r of at) expect(r.values.warehouseId).toBe(warehouse);
      }
    },
  );

  mockOnly('balances as the mock’s ledger says, active items only', async () => {
    const t = await token('full');
    const schema = await schemaOf(t, 'stockBalance');
    const rows = async (parameters: Record<string, unknown>) =>
      Object.fromEntries(
        (await allOf(t, 'stockBalance', schema, parameters)).records.map((r) => [r.id, r.values]),
      );
    const october = await rows({ asOf: '2026-10-31' });
    expect(october['ITM-0001|S-MAIN|WH-CAI|A-01']).toEqual({
      itemId: 'ITM-0001',
      itemName: 'Qorvath olive oil 1 L',
      unit: 'LTR',
      categoryId: 'CAT-FOOD',
      siteId: 'S-MAIN',
      warehouseId: 'WH-CAI',
      locationId: 'A-01',
      quantity: '1250.500',
      cost: '62525.00',
      unitCost: '50.0000',
      salesValue: '81282.50',
    });
    expect(october['ITM-0001|S-PORT|WH-ALX|B-01']).toMatchObject({
      quantity: '80.000',
      salesValue: '5200.00',
    });
    expect(october['ITM-0002|S-PORT|WH-ALX|B-01']).toMatchObject({
      quantity: '540.000',
      unitCost: '30.0000',
      salesValue: '8100.00',
    });
    expect(october['ITM-0003|S-MAIN|WH-CAI|A-01']).toMatchObject({
      quantity: '-12.000',
      cost: '0.00',
      unitCost: '0.0000',
      salesValue: '-210.00',
    });
    // Moved out by then: a place at zero.
    expect(october['ITM-0001|S-MAIN|WH-ASW|']).toBeUndefined();
    expect(
      (await rows({ asOf: '2026-10-31', includeZero: true }))['ITM-0001|S-MAIN|WH-ASW|'],
    ).toMatchObject({
      quantity: '0.000',
      cost: '0.00',
      unitCost: null,
      salesValue: '0.00',
    });
    expect((await rows({ asOf: '2026-11-15' }))['ITM-0001|S-MAIN|WH-CAI|A-01']).toMatchObject({
      quantity: '1150.500',
      cost: '57525.00',
    });
    // Before any movement: nothing.
    expect(Object.keys(await rows({ asOf: '2025-12-31' }))).toEqual([]);
    // An inactive item is never shown.
    expect(
      Object.keys(await rows({ includeZero: true })).some((k) => k.startsWith('ITM-0099')),
    ).toBe(false);
  });

  mockOnly('says when the service’s own cap cut it short', async () => {
    const t = await token('full');
    const schema = await schemaOf(t, 'stockBalance');
    const all = parseQueryResponse((await report(t, 'stockBalance', {})).json, { schema });
    expect(all.partial ?? false).toBe(false);
    await control('report-limits', { stockPlaces: 3 });
    const cut = parseQueryResponse((await report(t, 'stockBalance', {})).json, { schema });
    expect(cut.partial).toBe(true);
    expect(cut.total).toBe(3);
    expect(cut.records.map((r) => r.id)).toEqual(all.records.slice(0, 3).map((r) => r.id));
  });
});

describe('trial balance', () => {
  it.skipIf(lacks('admin', 'full'))(
    'refuses a period that ends before it starts, and splits its statements',
    async () => {
      const t = await token('full');
      const schema = await schemaOf(t, 'trialBalance');
      const late = await report(t, 'trialBalance', {
        dateFrom: '2026-10-31',
        dateTo: '2026-10-01',
      });
      expect(late.status).toBe(400);
      expect(errorsOf(late)).toEqual([{ field: 'parameters.dateTo', code: 'range' }]);
      const period = { dateFrom: '2026-01-01', dateTo: '2026-12-31' };
      const pl = (await allOf(t, 'trialBalance', schema, { ...period, statement: 'profitLoss' }))
        .records;
      const bs = (await allOf(t, 'trialBalance', schema, { ...period, statement: 'balanceSheet' }))
        .records;
      const ids = new Set(pl.map((r) => r.id));
      for (const r of bs) expect(ids.has(r.id), r.id).toBe(false);
    },
  );

  mockOnly('sums each account’s movement in the period, with its share', async () => {
    const t = await token('full');
    const schema = await schemaOf(t, 'trialBalance');
    const october = { dateFrom: '2026-10-01', dateTo: '2026-10-31' };
    const shown = async (statement: string) => {
      const { pages, records } = await allOf(t, 'trialBalance', schema, { ...october, statement });
      return {
        rows: records.map((r) => [r.key, r.values.balance, r.values.share]),
        totals: pages[0]!.totals,
      };
    };
    expect(await shown('profitLoss')).toEqual({
      rows: [
        ['5101', '9000.00', '-450.00'],
        ['6101', '2500.00', '-125.00'],
        ['6201', '1000.00', '-50.00'],
        ['4201', '500.00', '-25.00'],
        ['4101', '-15000.00', '750.00'],
      ],
      totals: { balance: '-2000.00' },
    });
    expect(await shown('balanceSheet')).toEqual({
      rows: [
        ['1101', '6500.00', '500.00'],
        ['1201', '5000.00', '384.62'],
        ['2101', '-1200.00', '-92.31'],
        ['1301', '-9000.00', '-692.31'],
      ],
      totals: { balance: '1300.00' },
    });
  });
});

describe('the client and reports', () => {
  /** Node's fetch sends no Origin: this one sends Workspace's, as a browser would. */
  const browserFetch = (input: string, init: RequestInit) =>
    fetch(input, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Origin: ORIGIN },
    });

  it.skipIf(lacks('admin', 'full'))(
    'lists, reads and checks every report with its parameters',
    async () => {
      const client = createErpClient(baseUrl(), browserFetch);
      const session = await client.redeem(
        await connectTicket('full', (await sharedLink()).linkId),
        WORKSPACE,
      );
      const reports = (await client.connectors(session.token)).filter((c) => c.kind === 'report');
      expect(reports.map((c) => c.id).sort()).toEqual([...REPORTS].sort());
      expect(
        (await client.connectors(session.token, { kinds: null })).some((c) => c.kind === 'report'),
      ).toBe(false);
      for (const { id } of reports) {
        const schema = await client.schema(session.token, id);
        expect(schema.kind).toBe('report');
        const page = await client.query(
          session.token,
          id,
          { filter: {}, cursor: null, pageSize: 50, parameters: {} },
          { schema },
        );
        expect(page.totals).toBeDefined();
      }
      await client.end(session.token);
    },
  );

  mockOnly('catches a report answer that breaks the contract', async () => {
    const client = createErpClient(baseUrl(), browserFetch);
    const { token: t } = await sharedSession('full');
    const schema = await client.schema(t, 'apAging');
    const good = (await report(t, 'apAging', {}, { pageSize: 3 })).json as Record<string, unknown>;
    const bad = async (body: unknown) => {
      await control('fault', { match: 'apAging/Query$', status: 200, body });
      const error = await client
        .query(t, 'apAging', { filter: {}, cursor: null, pageSize: 3, parameters: {} }, { schema })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'response.invalid' });
    };
    await bad({ ...good, totals: { vendorName: '1.00' } });
    await bad({ ...good, totals: { balance: 1100 } });
    await bad({ ...good, labels: { band0: { en: 'Not due' } } });
    await bad({ ...good, labels: { noSuchField: l('x', 'x') } });
    await bad({ ...good, partial: 'yes' });
    const raw = (await send('GET', connectorRoute('apAging', 'Schema'), { session: t })).json as {
      fields: Record<string, unknown>[];
    };
    await control('fault', {
      match: 'apAging/Schema$',
      status: 200,
      body: {
        ...raw,
        fields: raw.fields.map((f, i) =>
          i === 0 ? { ...f, editable: true, editReason: null } : f,
        ),
      },
    });
    expect(await client.schema(t, 'apAging').catch((e: unknown) => e)).toMatchObject({
      code: 'response.invalid',
    });
  });
});
