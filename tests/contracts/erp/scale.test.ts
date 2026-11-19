// Phase 12, Track E10 (INTEGRATIONS.md, "Queries paged in the ERP's database"): queries of 100,000
// records a connector, the large seed's (README.md, "The large seed"; its rule is
// tests/mocks/erp/large.mjs). The suite makes the same records by the same rule and knows by its
// own rules (rules.ts) what every page must hold, so a server that pages in its database answers
// exactly 0.10.0's records in 0.10.0's order: each match once, `total` by count, at most
// `maxRecords` through the cursors, searches ignoring case and no Arabic letter folded.
//
// Against the mock (reset to the large seed) these always run; against another server they run
// with ERP_TEST_KEY_SCALE and ERP_TEST_KEY_SCALE_ADMIN, for a company seeded by the rule.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  parseQueryResponse,
  type ConnectorSchema,
  type ErpRecord,
  type FieldType,
  type QueryResponse,
  type SortKey,
  type WireValue,
} from '../../../packages/erp/src/index';
import { LARGE_COUNT, largeRecords } from '../../mocks/erp/large.mjs';
import {
  control,
  lacks,
  onMock,
  openSession,
  query,
  refused,
  schemaOf,
  startServer,
  stopServer,
} from './harness';
import { dotnetTrim, reference, searchMatch, type RefRecord } from './rules';

const MINUTE = 60_000;
vi.setConfig({ testTimeout: 10 * MINUTE, hookTimeout: 10 * MINUTE });
const mockOnly = it.skipIf(!onMock);

type Id = 'vendors' | 'customers' | 'itemsOnHand';
const IDS: Id[] = ['vendors', 'customers', 'itemsOnHand'];
/** The contract's limits for each entity connector. */
const MAX_RECORDS = 10_000;

/** The rule's records as the scale user reads them: every field, in the connector's own order. */
function referenceOf(id: Id, made: ReturnType<typeof largeRecords>): RefRecord[] {
  if (id === 'vendors') {
    return made.vendors.map((v, rank) => {
      const { recId, phone, ...values } = v;
      return {
        id: recId,
        key: v.vendorAccount,
        values,
        searchTexts: [
          v.vendorAccount,
          v.vendorName as string,
          v.vendorGroup as string,
          v.mobile as string | null,
          phone,
        ],
        rank,
      };
    });
  }
  if (id === 'customers') {
    return made.customers.map((c, rank) => {
      const { recId, searchName, ...values } = c;
      return {
        id: recId,
        key: c.customerAccount,
        values,
        searchTexts: [
          c.customerAccount,
          c.customerName as string,
          searchName,
          c.mobile as string | null,
          c.mobile2 as string | null,
          c.governorate as string | null,
          c.city as string | null,
          c.nationalId as string | null,
        ],
        rank,
      };
    });
  }
  return made.itemsOnHand.map((s, rank) => {
    const { searchName, ...values } = s;
    return {
      id: [s.itemId, s.siteId ?? '', s.warehouseId ?? '', s.locationId ?? ''].join('|'),
      key: s.itemId,
      values,
      searchTexts: [s.itemId, s.itemName as string, searchName],
      rank,
    };
  });
}

/**
 * How a record is told apart in an answer: its key for Vendors and Customers (a server's record
 * ids are its own), its id for Items on hand (`item|site|warehouse|location`, the contract's).
 */
const ident = (id: Id, r: { id: string; key: string }) => (id === 'itemsOnHand' ? r.id : r.key);

/** A value as it can be compared across servers: a date-time's local time, without its offset. */
const comparable = (type: FieldType, value: WireValue | undefined) =>
  type === 'dateTime' && typeof value === 'string' ? value.slice(0, 19) : (value ?? null);

const describeScale = describe.skipIf(lacks('scale', 'scaleAdmin'));

describeScale('queries at 100,000 records a connector (Phase 12, Track E10)', () => {
  let token = '';
  const schemas = {} as Record<Id, ConnectorSchema>;
  const refs = {} as Record<Id, RefRecord[]>;
  const types = {} as Record<Id, Record<string, FieldType>>;

  beforeAll(async () => {
    await startServer();
    // The large seed in place of Kit's records, before any link or session is made.
    if (onMock) await control('reset', { large: true });
    token = (await openSession('scale')).token;
    const made = largeRecords();
    for (const id of IDS) {
      schemas[id] = await schemaOf(token, id);
      refs[id] = referenceOf(id, made);
      types[id] = Object.fromEntries(schemas[id].fields.map((f) => [f.name, f.type]));
    }
  });
  afterAll(stopServer);

  /** Pages of a query from the first, until `maxPages` or the last. */
  async function pages(
    id: Id,
    request: Parameters<typeof query>[2] & { pageSize: number },
    maxPages = 20,
  ): Promise<{ pages: QueryResponse[]; records: ErpRecord[] }> {
    const read: QueryResponse[] = [];
    let cursor: string | null = null;
    do {
      const answer = await query(token, id, { ...request, cursor });
      expect(answer.status, `${id} page ${read.length + 1}`).toBe(200);
      read.push(
        parseQueryResponse(answer.json, { schema: schemas[id], pageSize: request.pageSize }),
      );
      cursor = read.at(-1)!.nextCursor;
    } while (cursor !== null && read.length < maxPages);
    return { pages: read, records: read.flatMap((p) => p.records) };
  }

  /** The answer's records, told apart, are exactly the reference's, in its order. */
  function same(id: Id, got: readonly ErpRecord[], want: readonly RefRecord[], what: string) {
    const answered = got.map((r) => ident(id, r));
    expect(new Set(answered).size, `${what}: each record once`).toBe(answered.length);
    expect(answered, what).toEqual(want.map((r) => ident(id, r)));
  }

  /** What the server must answer for a query, from the reference. */
  const expected = (
    id: Id,
    q: { search?: string; equals?: Record<string, WireValue>; sort?: SortKey[] },
  ) => reference(refs[id], types[id], q);

  it.each(IDS.map((id) => [id]))('%s: holds the rule’s records and values', async (id) => {
    expect(refs[id]).toHaveLength(LARGE_COUNT);
    const first = parseQueryResponse((await query(token, id, { pageSize: 1000 })).json, {
      schema: schemas[id],
    });
    expect(first.total).toBe(LARGE_COUNT);
    const want = refs[id].slice(0, 1000);
    same(id, first.records, want, `${id}'s first page`);
    for (const [i, record] of first.records.entries()) {
      const ref = want[i]!;
      expect(record.key).toBe(ref.key);
      for (const f of schemas[id].fields) {
        expect(comparable(f.type, record.values[f.name]), `${ref.key}.${f.name}`).toEqual(
          comparable(f.type, ref.values[f.name]),
        );
      }
    }
  });

  it.each(IDS.map((id) => [id]))(
    '%s: counts every match, and reads at most maxRecords of them through its cursors',
    async (id) => {
      expect(schemas[id].maxRecords).toBe(MAX_RECORDS);
      const { pages: read, records } = await pages(id, { pageSize: 1000 });
      expect(read).toHaveLength(10);
      for (const page of read) expect(page.total).toBe(LARGE_COUNT);
      // The page that reaches maxRecords answers no cursor, though more match.
      expect(read.at(-1)!.nextCursor).toBeNull();
      same(id, records, refs[id].slice(0, MAX_RECORDS), `${id} to maxRecords`);
    },
  );

  it('stops on the page that reaches maxRecords, mid-page', async () => {
    const { pages: read, records } = await pages('customers', { pageSize: 999 });
    expect(read).toHaveLength(11);
    expect(read.at(-1)!.records).toHaveLength(10);
    expect(read.at(-1)!.nextCursor).toBeNull();
    same('customers', records, refs.customers.slice(0, MAX_RECORDS), 'customers at 999 a page');
  });

  mockOnly('refuses a cursor past maxRecords', async () => {
    const page = parseQueryResponse((await query(token, 'vendors', { pageSize: 10 })).json);
    const moved = async (read: number) =>
      ((await control('cursor', { cursor: page.nextCursor, read })) as { cursor: string }).cursor;
    refused(
      await query(token, 'vendors', { pageSize: 10, cursor: await moved(MAX_RECORDS) }),
      400,
      'request.invalid',
    );
    // One short of it: one record, and no cursor after it.
    const last = parseQueryResponse(
      (await query(token, 'vendors', { pageSize: 10, cursor: await moved(MAX_RECORDS - 1) })).json,
    );
    expect(last.records.map((r) => r.key)).toEqual([refs.vendors[10]!.key]);
    expect(last.nextCursor).toBeNull();
  });

  it.each(IDS.map((id) => [id]))(
    '%s: orders by every sortable field both ways, ties in the connector’s own order',
    async (id) => {
      const sortable = schemas[id].fields.filter((f) => f.sortable);
      expect(sortable.length).toBeGreaterThan(0);
      for (const f of sortable) {
        for (const direction of ['asc', 'desc'] as const) {
          const sort = [{ field: f.name, direction }];
          // Two pages: the second starts where the first's last record left the keyset.
          const { records } = await pages(id, { pageSize: 250, sort }, 2);
          same(
            id,
            records,
            expected(id, { sort }).slice(0, 500),
            `${id} by ${f.name} ${direction}`,
          );
        }
      }
    },
  );

  it.each([
    [
      'vendors',
      [
        { field: 'vendorName', direction: 'desc' },
        { field: 'currency', direction: 'asc' },
        { field: 'debitLimit', direction: 'asc' },
      ],
    ],
    [
      'customers',
      [
        { field: 'customerGroup', direction: 'asc' },
        { field: 'creditLimit', direction: 'desc' },
        { field: 'modifiedDate', direction: 'asc' },
      ],
    ],
    [
      'itemsOnHand',
      [
        { field: 'itemName', direction: 'asc' },
        { field: 'onHandQty', direction: 'desc' },
        { field: 'warehouseId', direction: 'asc' },
      ],
    ],
  ] as [Id, SortKey[]][])('%s: orders by three fields, to maxRecords', async (id, sort) => {
    const { records } = await pages(id, { pageSize: 1000, sort });
    same(id, records, expected(id, { sort }).slice(0, MAX_RECORDS), `${id} by three`);
  });

  /**
   * A search's answer: its total, and its pages (to the end or maxRecords, or the first `maxPages`
   * of 1,000) as the reference.
   */
  async function searched(id: Id, search: string, sort?: SortKey[], maxPages = 20) {
    const want = expected(id, { search, ...(sort ? { sort } : {}) });
    const { pages: read, records } = await pages(
      id,
      { pageSize: 1000, filter: { search }, ...(sort ? { sort } : {}) },
      maxPages,
    );
    expect(read[0]!.total, `${id} "${search}": total`).toBe(want.length);
    same(id, records, want.slice(0, Math.min(MAX_RECORDS, maxPages * 1000)), `${id} "${search}"`);
    for (const r of want) expect(searchMatch(r.searchTexts, dotnetTrim(search)), r.key).toBe(true);
    return want;
  }

  it('searches ignoring case as the ERP’s own lists do, in what they search', async () => {
    // Latin of one word in three cases, an accented capital, padding trimmed.
    const qorvath = await searched('vendors', 'qorvath');
    expect(qorvath.length).toBeGreaterThan(MAX_RECORDS);
    expect(new Set(qorvath.map((r) => String(r.values.vendorName).split(' ')[0]))).toEqual(
      new Set(['Qorvath', 'qorvath', 'QORVATH']),
    );
    expect((await searched('vendors', 'QORVATH Trading')).length).toBe(
      (await searched('vendors', ' qorvath trading ')).length,
    );
    const ebrel = await searched('customers', 'ÉBREL', [
      { field: 'customerName', direction: 'asc' },
    ]);
    expect(new Set(ebrel.map((r) => String(r.values.customerName).split(' ')[0]))).toEqual(
      new Set(['Ébrel', 'ébrel']),
    );
    // A key, a group's code, and what is searched but never sent.
    expect(await searched('vendors', 'VA-01234')).toHaveLength(10);
    expect((await searched('vendors', 'import')).length).toBe(Math.floor(LARGE_COUNT / 3) + 1);
    expect((await searched('vendors', '0220000035')).map((r) => r.key)).toEqual(['VA-000035']);
    expect((await searched('customers', 'alias 000060')).map((r) => r.key)).toEqual(['CA-000060']);
    expect((await searched('itemsOnHand', 'alias 000005')).map((r) => r.id)).toHaveLength(4);
    expect(await searched('customers', 'Ystrelle Nowhere')).toEqual([]);
  });

  it('matches each Arabic letter form only by itself', async () => {
    const pairs: [Id, string, string][] = [
      ['vendors', 'أحمد', 'احمد'],
      ['vendors', 'فاطمة', 'فاطمه'],
      ['vendors', 'مصطفى', 'مصطفي'],
      ['vendors', 'مُحمّد', 'محمد'],
      ['vendors', 'عبـدالله', 'عبدالله'],
      ['customers', 'مؤسسة الشاطئ', 'مؤسسه الشاطي'],
      ['customers', 'الإسكندرية', 'الاسكندرية'],
      ['customers', 'سيدي جابر', 'سيدى جابر'],
      ['itemsOnHand', 'آمنة', 'امنة'],
      ['itemsOnHand', 'إسراء', 'اسراء'],
    ];
    for (const [id, form, other] of pairs) {
      const a = await searched(id, form, undefined, 1);
      const b = await searched(id, other, undefined, 1);
      expect(a.length, `${id} "${form}"`).toBeGreaterThan(0);
      const theirs = new Set(b.map((r) => ident(id, r)));
      expect(
        a.filter((r) => theirs.has(ident(id, r))),
        `"${form}" and "${other}" find none of each other's`,
      ).toEqual([]);
    }
  });

  it.each(IDS.map((id) => [id]))(
    '%s: matches equals on every filterable field, empty as null',
    async (id) => {
      const filterable = schemas[id].fields.filter((f) => f.filterable);
      expect(filterable.length).toBeGreaterThan(0);
      for (const f of filterable) {
        // The value most records hold, and empty.
        const counts = new Map<WireValue, number>();
        for (const r of refs[id]) {
          const v = r.values[f.name] ?? null;
          if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        const common = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
        for (const value of [common, null, ''].filter((v) => v !== undefined) as WireValue[]) {
          if (value === '' && f.type !== 'text' && f.type !== 'lookup') continue;
          const equals = { [f.name]: value };
          const want = expected(id, { equals });
          const answer = parseQueryResponse(
            (await query(token, id, { pageSize: 200, filter: { equals } })).json,
            { schema: schemas[id] },
          );
          expect(answer.total, `${id}.${f.name} = ${JSON.stringify(value)}`).toBe(want.length);
          same(
            id,
            answer.records,
            want.slice(0, 200),
            `${id}.${f.name} = ${JSON.stringify(value)}`,
          );
        }
      }
    },
  );

  // Last: it writes a record, which the rule does not hold.
  mockOnly('keeps its place when a record is written between two pages', async () => {
    const sort: SortKey[] = [{ field: 'vendorName', direction: 'asc' }];
    const want = expected('vendors', { sort });
    const first = parseQueryResponse((await query(token, 'vendors', { pageSize: 100, sort })).json);
    same('vendors', first.records, want.slice(0, 100), 'page 1');
    // A vendor that sorts before every one already read: an offset would read one of them again.
    await control('add-record', {
      connector: 'vendors',
      company: 'Kit',
      values: { vendorAccount: 'VA-999999', vendorName: 'AAA Brinmoor first' },
    });
    const second = parseQueryResponse(
      (await query(token, 'vendors', { pageSize: 100, sort, cursor: first.nextCursor })).json,
    );
    same('vendors', second.records, want.slice(100, 200), 'page 2, after the write');
    expect(second.total).toBe(LARGE_COUNT + 1);
  });
});
