// The mock ERP's report connectors (Phase 12, INTEGRATIONS.md, "Reports (Phase 12, Track E11)"):
// AP aging by vendor, stock balance on a date and a trial balance, each computed for every query
// from seeded ledgers and the query's parameters, with the fields, labels, parameters, defaults,
// totals and access rules the contract gives them. Read-only: they commit nothing.
//
// The rules the mock computes by (where the contract leaves a choice; tests/contracts/erp/README.md
// says the same):
// - AP aging: invoices dated and payments made up to `asOf`. `oldestFirst` applies every payment
//   to the open invoices oldest first (invoice date, then id), so `unapplied` is 0; `openItems`
//   applies a payment to the invoice it settles, and one that settles none (or is more than the
//   invoice's rest) is `unapplied`. An invoice with something left is open; its age is `asOf`
//   less its due date (`dueDate`: not due at 0 days or fewer, then 1–30, 31–60, 61–90, over 90)
//   or its invoice date (`invoiceDate`: 0–30, 31–60, 61–90, 91–120, over 120). `balance` is the
//   open items less `unapplied`; `overdue` the open items past their due date; `oldestDays` the
//   oldest open item's age by `ageBy`. A vendor is a row when anything is open or unapplied.
// - Stock balance: a place (item, site, warehouse, location) is a row once it has a movement up
//   to `asOf`; with `includeZero` off, places whose quantity and cost are both 0 are left out.
//   `unitCost` is cost over quantity at 4 places (half away from zero), null at quantity 0;
//   `salesValue` the quantity at the item's price, at 2 places. Inactive items are never shown.
//   The places are read in order up to the service's cap (200,000; `/__mock/report-limits`),
//   and `partial` says when more were left.
// - Trial balance: each account of the statement with lines from `dateFrom` to `dateTo`;
//   `balance` their sum, `share` 100 × balance over the rows' total at 2 places (null when the
//   total is 0).

import { compareDecimal, compareText, decimalOf, ordinal } from './rules.mjs';

const label = (en, ar) => ({ en, ar });

/** A report's field: read-only, as every report field is; `total: 'sum'` where the contract says. */
const field = (name, en, ar, type, extra = {}) => ({
  name,
  label: label(en, ar),
  type,
  filterable: false,
  sortable: false,
  search: false,
  ...extra,
});

/** AP aging's bands, by the date `ageBy` names. */
export const BAND_LABELS = {
  dueDate: [
    label('Not due', 'غير مستحق'),
    label('1–30 days', 'من 1 إلى 30 يومًا'),
    label('31–60 days', 'من 31 إلى 60 يومًا'),
    label('61–90 days', 'من 61 إلى 90 يومًا'),
    label('Over 90 days', 'أكثر من 90 يومًا'),
  ],
  invoiceDate: [
    label('0–30 days', 'من 0 إلى 30 يومًا'),
    label('31–60 days', 'من 31 إلى 60 يومًا'),
    label('61–90 days', 'من 61 إلى 90 يومًا'),
    label('91–120 days', 'من 91 إلى 120 يومًا'),
    label('Over 120 days', 'أكثر من 120 يومًا'),
  ],
};

const money = (name, en, ar, extra = {}) =>
  field(name, en, ar, 'decimal', { scale: 2, sortable: true, total: 'sum', ...extra });

export const REPORTS = {
  apAging: {
    id: 'apAging',
    kind: 'report',
    label: label('AP aging by vendor', 'أعمار ديون الموردين'),
    schemaVersion: 'apAging.1',
    keyField: 'vendorAccount',
    idField: null,
    maxPageSize: 1000,
    maxRecords: 10000,
    maxCommitRecords: 0,
    versions: 'content',
    // The ERP's AP aging page's roles.
    roles: ['admin', 'owner', 'accountmgr', 'payable', 'account', 'tax'],
    parameters: [
      {
        name: 'asOf',
        label: label('As of', 'حتى تاريخ'),
        type: 'date',
        required: true,
        default: 'today',
      },
      {
        name: 'ageBy',
        label: label('Aged by', 'العمر حسب'),
        type: 'choice',
        required: false,
        options: [
          { value: 'dueDate', label: label('Due date', 'تاريخ الاستحقاق') },
          { value: 'invoiceDate', label: label('Invoice date', 'تاريخ الفاتورة') },
        ],
        default: 'dueDate',
      },
      {
        name: 'basis',
        label: label('Basis', 'الأساس'),
        type: 'choice',
        required: false,
        options: [
          { value: 'oldestFirst', label: label('Oldest first', 'الأقدم أولًا') },
          { value: 'openItems', label: label('Open items', 'البنود المفتوحة') },
        ],
        default: 'oldestFirst',
      },
      {
        name: 'vendorGroup',
        label: label('Vendor group', 'مجموعة الموردين'),
        type: 'lookup',
        required: false,
        lookup: 'vendorGroups',
        default: null,
      },
    ],
    fields: [
      field('vendorAccount', 'Vendor account', 'حساب المورد', 'text', {
        sortable: true,
        search: true,
      }),
      field('vendorName', 'Vendor', 'المورد', 'text', { sortable: true, search: true }),
      field('vendorGroup', 'Group', 'المجموعة', 'lookup', {
        lookup: 'vendorGroups',
        filterable: true,
        sortable: true,
      }),
      money('balance', 'Balance', 'الرصيد'),
      ...BAND_LABELS.dueDate.map((l, i) => money(`band${i}`, l.en, l.ar)),
      money('unapplied', 'Unapplied', 'غير مخصص'),
      money('overdue', 'Overdue', 'متأخر السداد'),
      field('openItems', 'Open items', 'البنود المفتوحة', 'integer', { sortable: true }),
      field('oldestDays', 'Oldest, days', 'الأقدم بالأيام', 'integer', { sortable: true }),
      field('lastInvoice', 'Last invoice', 'آخر فاتورة', 'date', { sortable: true }),
      field('lastPayment', 'Last payment', 'آخر دفعة', 'date', { sortable: true }),
      field('lastPaymentAmount', 'Last payment amount', 'مبلغ آخر دفعة', 'decimal', {
        scale: 2,
        sortable: true,
      }),
    ],
    searchAlso: [],
  },
  stockBalance: {
    id: 'stockBalance',
    kind: 'report',
    label: label('Stock balance on a date', 'رصيد المخزون في تاريخ'),
    schemaVersion: 'stockBalance.1',
    keyField: 'itemId',
    idField: null,
    maxPageSize: 1000,
    maxRecords: 10000,
    maxCommitRecords: 0,
    versions: 'content',
    // The ERP's Warehouse balance page's roles; cost only for whom the page shows it.
    roles: [
      'admin',
      'owner',
      'warehouse',
      'warehousemgr',
      'account',
      'purch',
      'oper',
      'accountmgr',
      'prod',
      'plan',
      'tax',
    ],
    costFields: ['cost', 'unitCost'],
    parameters: [
      {
        name: 'asOf',
        label: label('As of', 'حتى تاريخ'),
        type: 'date',
        required: true,
        default: 'today',
      },
      {
        name: 'siteId',
        label: label('Site', 'الموقع'),
        type: 'lookup',
        required: false,
        lookup: 'sites',
        default: null,
      },
      {
        name: 'warehouseId',
        label: label('Warehouse', 'المخزن'),
        type: 'lookup',
        required: false,
        lookup: 'warehouses',
        default: null,
      },
      {
        name: 'includeZero',
        label: label('Include zero balances', 'إظهار الأرصدة الصفرية'),
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
    fields: [
      field('itemId', 'Item', 'الصنف', 'text', { sortable: true, search: true }),
      field('itemName', 'Item name', 'اسم الصنف', 'text', { sortable: true, search: true }),
      field('unit', 'Unit', 'الوحدة', 'text', { sortable: true }),
      field('categoryId', 'Category', 'الفئة', 'text', { filterable: true, sortable: true }),
      field('siteId', 'Site', 'الموقع', 'lookup', {
        lookup: 'sites',
        filterable: true,
        sortable: true,
      }),
      field('warehouseId', 'Warehouse', 'المخزن', 'lookup', {
        lookup: 'warehouses',
        filterable: true,
        sortable: true,
      }),
      field('locationId', 'Location', 'المكان', 'text', { sortable: true }),
      field('quantity', 'Quantity', 'الكمية', 'decimal', {
        scale: 3,
        sortable: true,
        total: 'sum',
      }),
      money('cost', 'Cost', 'التكلفة'),
      field('unitCost', 'Unit cost', 'تكلفة الوحدة', 'decimal', { scale: 4, sortable: true }),
      money('salesValue', 'Sales value', 'قيمة البيع'),
    ],
    searchAlso: [],
  },
  trialBalance: {
    id: 'trialBalance',
    kind: 'report',
    label: label('Trial balance', 'ميزان المراجعة'),
    schemaVersion: 'trialBalance.1',
    keyField: 'accountId',
    idField: null,
    maxPageSize: 1000,
    maxRecords: 10000,
    maxCommitRecords: 0,
    versions: 'content',
    // The ERP's Trial balance page's roles.
    roles: ['admin', 'owner', 'accountmgr', 'dev'],
    parameters: [
      {
        name: 'dateFrom',
        label: label('From', 'من'),
        type: 'date',
        required: true,
        default: 'monthStart',
      },
      {
        name: 'dateTo',
        label: label('To', 'إلى'),
        type: 'date',
        required: true,
        default: 'today',
        // Not in the schema: a `dateTo` before `dateFrom` is `range`.
        after: 'dateFrom',
      },
      {
        name: 'statement',
        label: label('Statement', 'القائمة'),
        type: 'choice',
        required: false,
        options: [
          { value: 'profitLoss', label: label('Profit and loss', 'الأرباح والخسائر') },
          { value: 'balanceSheet', label: label('Balance sheet', 'الميزانية العمومية') },
        ],
        default: 'profitLoss',
      },
    ],
    fields: [
      field('accountId', 'Account', 'الحساب', 'text', { sortable: true, search: true }),
      field('accountName', 'Account name', 'اسم الحساب', 'text', {
        sortable: true,
        search: true,
      }),
      field('accountType', 'Type', 'النوع', 'text', { filterable: true, sortable: true }),
      field('accountGroup', 'Group', 'المجموعة', 'text', { filterable: true, sortable: true }),
      field('category', 'Category', 'التصنيف', 'text', { filterable: true, sortable: true }),
      money('balance', 'Movement', 'الحركة'),
      field('share', 'Share', 'النسبة', 'decimal', { scale: 2, sortable: true }),
    ],
    searchAlso: [],
  },
};

export const REPORT_IDS = ['apAging', 'stockBalance', 'trialBalance'];

/** The service's own cap on stock places (Warehouse balance), before `partial`. */
export const STOCK_PLACES_CAP = 200_000;

// ---------------------------------------------------------------------------------------------
// Dates and amounts

const DAY = 86_400_000;
const pad = (n, width) => String(n).padStart(width, '0');
const dayNumber = (date) => Date.parse(`${date}T00:00:00Z`) / DAY;
const dateOf = (number) => new Date(number * DAY).toISOString().slice(0, 10);
const addDays = (date, days) => dateOf(dayNumber(date) + days);
const daysBetween = (from, to) => dayNumber(to) - dayNumber(from);

/** `12.50` as cents (or thousandths at `scale` 3). */
export function unitsOf(text, scale) {
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const n = Number(whole) * 10 ** scale + Number(fraction.padEnd(scale, '0').slice(0, scale));
  return negative ? -n : n;
}

/** `a / b` at `scale` places, half away from zero, as a decimal string (BigInt: exact). */
function divide(a, b, scale) {
  const negative = a < 0n !== b < 0n && a !== 0n;
  const x = a < 0n ? -a : a;
  const y = b < 0n ? -b : b;
  const scaledUp = x * 10n ** BigInt(scale) * 2n;
  const q = (scaledUp / y + 1n) / 2n;
  return decimalOf(negative ? -q : q, scale);
}

/** A small deterministic generator (mulberry32), as seed.mjs's. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Ledgers

const TERMS = { CASH: 0, NET30: 30, NET60: 60 };

/**
 * The AP ledger: invoices `{company, vendor, id, date, due, cents}` and payments
 * `{company, vendor, id, date, cents, settles}`. Kit's first vendors are written out (the suite
 * checks their exact aging), the others made by a generator.
 */
function apLedger(vendors) {
  const invoices = [];
  const payments = [];
  const invoice = (company, vendor, id, date, due, amount) =>
    invoices.push({ company, vendor, id, date, due, cents: unitsOf(amount, 2) });
  const payment = (company, vendor, id, date, amount, settles = null) =>
    payments.push({ company, vendor, id, date, cents: unitsOf(amount, 2), settles });

  // V-1001: two invoices open by 2026-10-31 and one after it; one payment settles the first,
  // one settles nothing.
  invoice('Kit', 'V-1001', 'PI-1001-1', '2026-08-01', '2026-08-31', '1000.00');
  invoice('Kit', 'V-1001', 'PI-1001-2', '2026-10-01', '2026-10-31', '500.00');
  invoice('Kit', 'V-1001', 'PI-1001-3', '2026-11-05', '2026-12-05', '250.50');
  payment('Kit', 'V-1001', 'PP-1001-1', '2026-09-10', '300.00', 'PI-1001-1');
  payment('Kit', 'V-1001', 'PP-1001-2', '2026-10-15', '100.00');
  // V-1002: paid in full in July, so no row after it.
  invoice('Kit', 'V-1002', 'PI-1002-1', '2026-06-15', '2026-07-15', '2000.00');
  payment('Kit', 'V-1002', 'PP-1002-1', '2026-07-20', '2000.00', 'PI-1002-1');
  // V-1003: long overdue.
  invoice('Kit', 'V-1003', 'PI-1003-1', '2026-03-01', '2026-03-31', '750.25');
  // V-1004: nothing. V-1007 (an inactive group): open.
  invoice('Kit', 'V-1007', 'PI-1007-1', '2026-09-20', '2026-10-20', '120.00');
  // Dot's.
  invoice('Dot', 'V-1001', 'PI-D1001-1', '2026-09-01', '2026-09-01', '999.99');

  const pick = random(20261119);
  const kit = vendors.filter((v) => v.company === 'Kit').slice(7);
  for (const vendor of kit) {
    const count = Math.floor(pick() * 4);
    const made = [];
    for (let j = 1; j <= count; j++) {
      const date = addDays('2026-01-01', Math.floor(pick() * 300));
      const due = addDays(date, TERMS[vendor.payMethod] ?? 0);
      const cents = 1000 + Math.floor(pick() * 499_000);
      const id = `PI-${vendor.vendorAccount}-${j}`;
      invoices.push({ company: 'Kit', vendor: vendor.vendorAccount, id, date, due, cents });
      made.push({ id, date, rest: cents });
    }
    const paid = made.length ? Math.floor(pick() * 3) : 0;
    for (let j = 1; j <= paid; j++) {
      const target = made[Math.floor(pick() * made.length)];
      const cents = Math.floor(pick() * target.rest);
      if (cents <= 0) continue;
      target.rest -= cents;
      payments.push({
        company: 'Kit',
        vendor: vendor.vendorAccount,
        id: `PP-${vendor.vendorAccount}-${j}`,
        date: addDays(target.date, 1 + Math.floor(pick() * 40)),
        cents,
        settles: pick() < 0.7 ? target.id : null,
      });
    }
  }
  return { invoices, payments };
}

/**
 * The stock ledger: items `{company, itemId, itemName, unit, categoryId, price, active}` and
 * movements `{company, itemId, siteId, warehouseId, locationId, date, milli, cents}`.
 */
function stockLedger(stock) {
  const items = new Map();
  for (const row of stock) {
    const key = `${row.company}|${row.itemId}`;
    if (items.has(key)) continue;
    items.set(key, {
      company: row.company,
      itemId: row.itemId,
      itemName: row.itemName,
      unit: row.unit,
      categoryId: `CAT-${row.itemGroup}`,
      // The price a unit, in cents: from the item's number.
      price: 1000 + (Number(row.itemId.replace(/\D/g, '')) % 50) * 250,
      active: true,
    });
  }
  // ITM-0001's price is written out, for the suite's exact case.
  if (items.has('Kit|ITM-0001')) items.get('Kit|ITM-0001').price = 6500;
  items.set('Kit|ITM-0099', {
    company: 'Kit',
    itemId: 'ITM-0099',
    itemName: 'Ystrelle lamp, discontinued',
    unit: 'PCS',
    categoryId: 'CAT-HARDWARE',
    price: 4000,
    active: false,
  });
  const moves = [];
  const move = (company, itemId, [siteId, warehouseId, locationId], date, qty, cost) =>
    moves.push({
      company,
      itemId,
      siteId,
      warehouseId,
      locationId,
      date,
      milli: unitsOf(qty, 3),
      cents: unitsOf(cost, 2),
    });
  const CAI1 = ['S-MAIN', 'WH-CAI', 'A-01'];
  const ALX = ['S-PORT', 'WH-ALX', 'B-01'];
  const ASW = ['S-MAIN', 'WH-ASW', null];
  move('Kit', 'ITM-0001', CAI1, '2026-01-10', '1000.000', '50000.00');
  move('Kit', 'ITM-0001', CAI1, '2026-06-01', '250.500', '12525.00');
  move('Kit', 'ITM-0001', CAI1, '2026-11-10', '-100.000', '-5000.00');
  move('Kit', 'ITM-0001', ALX, '2026-02-01', '80.000', '4000.00');
  move('Kit', 'ITM-0001', ASW, '2026-03-01', '12.250', '612.50');
  move('Kit', 'ITM-0001', ASW, '2026-09-30', '-12.250', '-612.50');
  move('Kit', 'ITM-0002', ALX, '2026-04-01', '540.000', '16200.00');
  move('Kit', 'ITM-0003', CAI1, '2026-05-01', '-12.000', '0.00');
  move('Kit', 'ITM-0099', CAI1, '2026-01-01', '5.000', '50.00');
  // The other items' places, as Items on hand holds them, from a receipt in the year's first
  // months and, for some, an issue later.
  const pick = random(20261120);
  for (const row of stock) {
    if (row.company === 'Kit' && ['ITM-0001', 'ITM-0002', 'ITM-0003'].includes(row.itemId))
      continue;
    const place = [row.siteId, row.warehouseId, row.locationId];
    const qty = unitsOf(row.onHandQty, 3);
    const cents = unitsOf(row.onHandValue, 2);
    const date = addDays('2026-01-05', Math.floor(pick() * 150));
    moves.push({
      company: row.company,
      itemId: row.itemId,
      siteId: place[0],
      warehouseId: place[1],
      locationId: place[2],
      date,
      milli: qty,
      cents,
    });
    if (pick() < 0.3 && qty > 0) {
      const out = Math.floor(qty / 3);
      moves.push({
        company: row.company,
        itemId: row.itemId,
        siteId: place[0],
        warehouseId: place[1],
        locationId: place[2],
        date: addDays(date, 30 + Math.floor(pick() * 120)),
        milli: -out,
        cents: -Math.round((cents * out) / qty),
      });
    }
  }
  return { items, moves };
}

/** The general ledger: a chart `{company, accountId, …, statement}` and lines `{date, cents}`. */
function generalLedger() {
  const accounts = [];
  const lines = [];
  const account = (company, accountId, name, accountType, accountGroup, category) =>
    accounts.push({
      company,
      accountId,
      accountName: name,
      accountType,
      accountGroup,
      category,
      statement: ['Asset', 'Liability', 'Equity'].includes(accountType)
        ? 'balanceSheet'
        : 'profitLoss',
    });
  const line = (company, accountId, date, amount) =>
    lines.push({ company, accountId, date, cents: unitsOf(amount, 2) });
  account('Kit', '1101', 'Qorvath cash box', 'Asset', 'Current assets', 'Cash');
  account('Kit', '1201', 'Velmorra customers', 'Asset', 'Current assets', 'Receivables');
  account('Kit', '1301', 'Zarkonite inventory', 'Asset', 'Current assets', 'Inventory');
  account('Kit', '2101', 'Ombrevique vendors', 'Liability', 'Current liabilities', 'Payables');
  account('Kit', '3101', 'Brinmoor capital', 'Equity', 'Equity', 'Capital');
  account('Kit', '4101', 'مبيعات زمرّدان', 'Revenue', 'Revenue', 'Sales');
  account('Kit', '4201', 'Calderune sales returns', 'Revenue', 'Revenue', 'Sales');
  account('Kit', '5101', 'Ystrelle cost of goods sold', 'Expense', 'Cost of sales', 'COGS');
  account('Kit', '6101', 'رواتب قرنفلون', 'Expense', 'Operating expenses', 'Staff');
  account('Kit', '6201', 'Thessaly Quay rent', 'Expense', 'Operating expenses', 'Premises');
  account('Kit', '6301', 'سندروس utilities', 'Expense', 'Operating expenses', 'Premises');
  account('Dot', '4101', 'Ferrowyn sales', 'Revenue', 'Revenue', 'Sales');

  line('Kit', '4101', '2026-09-10', '-8000.00');
  line('Kit', '4101', '2026-10-05', '-10000.00');
  line('Kit', '4101', '2026-10-20', '-5000.00');
  line('Kit', '4201', '2026-10-21', '500.00');
  line('Kit', '5101', '2026-09-10', '4800.00');
  line('Kit', '5101', '2026-10-05', '6000.00');
  line('Kit', '5101', '2026-10-20', '3000.00');
  line('Kit', '6101', '2026-10-31', '2500.00');
  line('Kit', '6201', '2026-10-01', '1000.00');
  line('Kit', '6301', '2026-11-02', '300.00');
  line('Kit', '1101', '2026-10-05', '10000.00');
  line('Kit', '1101', '2026-10-01', '-1000.00');
  line('Kit', '1101', '2026-10-31', '-2500.00');
  line('Kit', '1201', '2026-10-20', '5000.00');
  line('Kit', '1301', '2026-10-05', '-6000.00');
  line('Kit', '1301', '2026-10-20', '-3000.00');
  line('Kit', '2101', '2026-10-15', '-1200.00');
  line('Kit', '3101', '2026-01-01', '-50000.00');
  line('Dot', '4101', '2026-10-12', '-4321.00');
  return { accounts, lines };
}

/** Every ledger the reports read, from the seed's records. */
export function seedLedgers(records) {
  return {
    ap: apLedger(records.vendors),
    stock: stockLedger(records.itemsOnHand),
    gl: generalLedger(),
  };
}

// ---------------------------------------------------------------------------------------------
// The reports

/** A report's rows' own order: what a query with no sort gives, and its ties' order. */
export function reportOrder(id) {
  switch (id) {
    case 'apAging':
      return (a, b) =>
        -compareDecimal(a.balance, b.balance) ||
        compareText(a.vendorName ?? '', b.vendorName ?? '') ||
        ordinal(a.vendorAccount, b.vendorAccount);
    case 'stockBalance':
      return (a, b) =>
        ordinal(a.itemId, b.itemId) ||
        ordinal(a.siteId ?? '', b.siteId ?? '') ||
        ordinal(a.warehouseId ?? '', b.warehouseId ?? '') ||
        ordinal(a.locationId ?? '', b.locationId ?? '');
    default:
      return (a, b) => -compareDecimal(a.balance, b.balance) || ordinal(a.accountId, b.accountId);
  }
}

function apAging({ ledgers, records, company, params }) {
  const { asOf, ageBy, basis, vendorGroup } = params;
  const vendors = new Map(
    records.vendors.filter((v) => v.company === company).map((v) => [v.vendorAccount, v]),
  );
  const rows = [];
  const byVendor = new Map();
  for (const inv of ledgers.ap.invoices) {
    if (inv.company !== company || inv.date > asOf) continue;
    const entry = byVendor.get(inv.vendor) ?? { invoices: [], payments: [] };
    entry.invoices.push(inv);
    byVendor.set(inv.vendor, entry);
  }
  for (const pay of ledgers.ap.payments) {
    if (pay.company !== company || pay.date > asOf) continue;
    const entry = byVendor.get(pay.vendor) ?? { invoices: [], payments: [] };
    entry.payments.push(pay);
    byVendor.set(pay.vendor, entry);
  }
  for (const [account, { invoices, payments }] of byVendor) {
    const vendor = vendors.get(account);
    if (!vendor) continue;
    if (vendorGroup !== null && vendor.vendorGroup !== vendorGroup) continue;
    const open = [...invoices]
      .sort((a, b) => ordinal(a.date, b.date) || ordinal(a.id, b.id))
      .map((inv) => ({ ...inv, rest: inv.cents }));
    let unapplied = 0;
    if (basis === 'oldestFirst') {
      let left = payments.reduce((sum, p) => sum + p.cents, 0);
      for (const item of open) {
        const take = Math.min(item.rest, left);
        item.rest -= take;
        left -= take;
      }
      // Paid beyond every invoice: owed back, shown as a negative amount not yet due.
      if (left > 0) open.push({ id: '', date: asOf, due: asOf, cents: 0, rest: -left });
    } else {
      for (const pay of payments) {
        const item = pay.settles ? open.find((i) => i.id === pay.settles) : undefined;
        const take = item ? Math.min(item.rest, pay.cents) : 0;
        if (item) item.rest -= take;
        unapplied += pay.cents - take;
      }
    }
    const items = open.filter((i) => i.rest !== 0);
    if (items.length === 0 && unapplied === 0) continue;
    const bands = [0, 0, 0, 0, 0];
    let overdue = 0;
    let oldest = null;
    for (const item of items) {
      const age = daysBetween(ageBy === 'dueDate' ? item.due : item.date, asOf);
      const band =
        ageBy === 'dueDate'
          ? age <= 0
            ? 0
            : age <= 30
              ? 1
              : age <= 60
                ? 2
                : age <= 90
                  ? 3
                  : 4
          : age <= 30
            ? 0
            : age <= 60
              ? 1
              : age <= 90
                ? 2
                : age <= 120
                  ? 3
                  : 4;
      bands[band] += item.rest;
      if (item.due < asOf) overdue += item.rest;
      if (item.rest > 0 && (oldest === null || age > oldest)) oldest = age;
    }
    const sum = bands.reduce((a, b) => a + b, 0);
    const last = [...payments].sort((a, b) => ordinal(b.date, a.date) || ordinal(b.id, a.id))[0];
    const lastInvoice = invoices.reduce(
      (max, i) => (max === null || i.date > max ? i.date : max),
      null,
    );
    const values = {
      vendorAccount: account,
      vendorName: vendor.vendorName,
      vendorGroup: vendor.vendorGroup,
      balance: decimalOf(sum - unapplied, 2),
      band0: decimalOf(bands[0], 2),
      band1: decimalOf(bands[1], 2),
      band2: decimalOf(bands[2], 2),
      band3: decimalOf(bands[3], 2),
      band4: decimalOf(bands[4], 2),
      unapplied: decimalOf(unapplied, 2),
      overdue: decimalOf(overdue, 2),
      openItems: items.filter((i) => i.rest > 0).length,
      oldestDays: oldest,
      lastInvoice,
      lastPayment: last?.date ?? null,
      lastPaymentAmount: last ? decimalOf(last.cents, 2) : null,
    };
    rows.push({ id: account, key: account, values });
  }
  const labels = Object.fromEntries(BAND_LABELS[ageBy].map((l, i) => [`band${i}`, l]));
  return { rows, labels };
}

function stockBalance({ ledgers, company, params, limits }) {
  const { asOf, siteId, warehouseId, includeZero } = params;
  const places = new Map();
  for (const m of ledgers.stock.moves) {
    if (m.company !== company || m.date > asOf) continue;
    if (siteId !== null && m.siteId !== siteId) continue;
    if (warehouseId !== null && m.warehouseId !== warehouseId) continue;
    const item = ledgers.stock.items.get(`${company}|${m.itemId}`);
    if (!item?.active) continue;
    const id = [m.itemId, m.siteId ?? '', m.warehouseId ?? '', m.locationId ?? ''].join('|');
    const place = places.get(id) ?? { id, item, m, milli: 0, cents: 0 };
    place.milli += m.milli;
    place.cents += m.cents;
    places.set(id, place);
  }
  const order = reportOrder('stockBalance');
  const all = [...places.values()]
    .filter((p) => includeZero || p.milli !== 0 || p.cents !== 0)
    .map((p) => ({
      id: p.id,
      key: p.item.itemId,
      values: {
        itemId: p.item.itemId,
        itemName: p.item.itemName,
        unit: p.item.unit,
        categoryId: p.item.categoryId,
        siteId: p.m.siteId,
        warehouseId: p.m.warehouseId,
        locationId: p.m.locationId,
        quantity: decimalOf(p.milli, 3),
        cost: decimalOf(p.cents, 2),
        unitCost: p.milli === 0 ? null : divide(BigInt(p.cents) * 10n, BigInt(p.milli), 4),
        // Thousandths of a unit at cents a unit: cents, rounded.
        salesValue: decimalOf(BigInt(divide(BigInt(p.milli) * BigInt(p.item.price), 1000n, 0)), 2),
      },
    }))
    .sort((a, b) => order(a.values, b.values));
  const cap = limits.stockPlaces;
  return all.length > cap ? { rows: all.slice(0, cap), partial: true } : { rows: all };
}

function trialBalance({ ledgers, company, params }) {
  const { dateFrom, dateTo, statement } = params;
  const sums = new Map();
  for (const l of ledgers.gl.lines) {
    if (l.company !== company || l.date < dateFrom || l.date > dateTo) continue;
    sums.set(l.accountId, (sums.get(l.accountId) ?? 0) + l.cents);
  }
  const accounts = ledgers.gl.accounts.filter(
    (a) => a.company === company && a.statement === statement && sums.has(a.accountId),
  );
  const total = accounts.reduce((sum, a) => sum + sums.get(a.accountId), 0);
  const rows = accounts.map((a) => {
    const cents = sums.get(a.accountId);
    return {
      id: a.accountId,
      key: a.accountId,
      values: {
        accountId: a.accountId,
        accountName: a.accountName,
        accountType: a.accountType,
        accountGroup: a.accountGroup,
        category: a.category,
        balance: decimalOf(cents, 2),
        share: total === 0 ? null : divide(BigInt(cents) * 100n, BigInt(total), 2),
      },
    };
  });
  return { rows };
}

/**
 * A report's rows for its resolved parameters, in its own order, each `{id, key, values}` with
 * every field (the server cuts what a user may not see); with `labels` and `partial` where the
 * report gives them.
 */
export function runReport(id, context) {
  const made =
    id === 'apAging'
      ? apAging(context)
      : id === 'stockBalance'
        ? stockBalance(context)
        : trialBalance(context);
  const order = reportOrder(id);
  return { ...made, rows: [...made.rows].sort((a, b) => order(a.values, b.values)) };
}

/** `today` and `monthStart` in a time zone, at `now` (ms). */
export function datesIn(timeZone, now) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
  return { today, monthStart: `${today.slice(0, 8)}01` };
}

export { addDays, pad };
