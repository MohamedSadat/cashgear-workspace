// The mock ERP's data (tests/mocks/erp/server.mjs): two companies in one database, as Kit and Dot
// share ASTDataTest, their users, and three read-only connectors (Vendors as `vendors.1`,
// Customers, Items on hand) with seeded records. Every record's name holds one of `MARKERS`, a
// made-up word found nowhere else, so a test can search a document, a store, the search index or
// a log for ERP data and know that finding nothing means something.

/** The companies, each with Workspace turned on. */
export const COMPANIES = {
  Kit: { name: 'Kit Trading', database: 'ASTDataTest' },
  Dot: { name: 'Dot Foods', database: 'ASTDataTest' },
};

export const CONNECTOR_IDS = ['vendors', 'customers', 'itemsOnHand'];

/**
 * The ERP users the mock client signs in as, each with the API key the ERP client would hold.
 * `connectors` are those the user may view; `hidden` the fields kept from them; `rules` the
 * record rules the ERP applies to them; `admin` whether they may link and revoke.
 */
export const USERS = {
  alice: {
    id: 'u101',
    key: 'mock-alice',
    company: 'Kit',
    displayName: 'Alice Haddad',
    connectors: ['vendors', 'customers', 'itemsOnHand'],
    admin: false,
  },
  bob: {
    id: 'u102',
    key: 'mock-bob',
    company: 'Kit',
    displayName: 'Bob Mansour',
    connectors: ['vendors', 'customers'],
    // Bob sells: he sees his own customers only, and not their credit limits.
    rules: { customers: { salesperson: 'S-BOB' } },
    hidden: { customers: ['creditLimit'] },
    admin: false,
  },
  carol: {
    id: 'u103',
    key: 'mock-carol',
    company: 'Kit',
    displayName: 'Carol Saleh',
    connectors: [],
    admin: false,
  },
  dan: {
    id: 'u104',
    key: 'mock-dan',
    company: 'Kit',
    displayName: 'Dan Fawzy',
    connectors: [],
    admin: true,
  },
  erin: {
    id: 'u201',
    key: 'mock-erin',
    company: 'Dot',
    displayName: 'Erin Nassar',
    connectors: ['vendors', 'customers', 'itemsOnHand'],
    admin: true,
  },
};

/** Made-up words, one in every record's name: Kit's, then Dot's own. */
export const MARKERS = {
  Kit: [
    'Qorvath',
    'Velmorra',
    'Zarkonite',
    'Ombrevique',
    'Brinmoor',
    'Calderune',
    'Ystrelle',
    'Thessaly Quay',
    'زمرّدان',
    'قرنفلون',
    'سندروس',
  ],
  Dot: ['Ferrowyn', 'فيرويـن'],
};

const label = (en, ar) => ({ en, ar });

/** A text, lookup or other field; `search` marks what the ERP's own list searches. */
const field = (name, en, ar, type, extra = {}) => ({
  name,
  label: label(en, ar),
  type,
  filterable: false,
  sortable: false,
  search: false,
  ...extra,
});

export const CONNECTORS = {
  vendors: {
    id: 'vendors',
    kind: 'entity',
    label: label('Vendors', 'الموردون'),
    schemaVersion: 'vendors.1',
    keyField: 'vendorAccount',
    idField: 'recId',
    maxPageSize: 1000,
    maxRecords: 10000,
    maxCommitRecords: 500,
    // vendors.1's fields, in the ERP's list order, with its labels.
    fields: [
      field('vendorAccount', 'Account', 'الحساب', 'text', {
        maxLength: 50,
        filterable: true,
        sortable: true,
        search: true,
      }),
      field('vendorName', 'Name', 'الاسم', 'text', {
        maxLength: 150,
        required: true,
        sortable: true,
        search: true,
      }),
      field('vendorGroup', 'Group', 'المجموعة', 'lookup', {
        lookup: 'vendorGroups',
        required: true,
        filterable: true,
        sortable: true,
        search: true,
      }),
      field('mobile', 'Mobile', 'الجوال', 'text', { maxLength: 50, search: true }),
      field('currency', 'Currency', 'العملة', 'lookup', {
        lookup: 'currencies',
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('payMethod', 'Payment method', 'طريقة الدفع', 'lookup', {
        lookup: 'paymentModes',
        required: true,
        filterable: true,
      }),
      field('address', 'Address', 'العنوان', 'text', { maxLength: 150 }),
      field('taxFile', 'Tax file', 'الملف الضريبي', 'text', { maxLength: 50 }),
      field('blocked', 'Blocked', 'موقوف', 'boolean', { required: true, filterable: true }),
      field('bankAccount', 'Bank account', 'الحساب البنكي', 'text', { maxLength: 50 }),
      field('debitLimit', 'Credit limit', 'حد الائتمان', 'decimal', {
        scale: 2,
        min: '0',
        sortable: true,
      }),
      field('modifiedBy', 'Modified by', 'عدل بواسطة', 'text', { maxLength: 50 }),
      field('modifiedDate', 'Modified', 'تاريخ التعديل', 'dateTime', { sortable: true }),
    ],
    // The ERP's Vendors list also searches the phone, which is never sent.
    searchAlso: ['phone'],
  },
  customers: {
    id: 'customers',
    kind: 'entity',
    label: label('Customers', 'العملاء'),
    schemaVersion: 'customers.1',
    keyField: 'customerAccount',
    idField: 'recId',
    maxPageSize: 500,
    maxRecords: 10000,
    maxCommitRecords: 0,
    fields: [
      field('customerAccount', 'Account', 'الحساب', 'text', {
        maxLength: 50,
        filterable: true,
        sortable: true,
        search: true,
      }),
      field('customerName', 'Name', 'الاسم', 'text', {
        maxLength: 150,
        required: true,
        sortable: true,
        search: true,
      }),
      field('city', 'City', 'المدينة', 'text', {
        maxLength: 80,
        filterable: true,
        sortable: true,
        search: true,
      }),
      field('creditLimit', 'Credit limit', 'حد الائتمان', 'decimal', {
        scale: 2,
        min: '0',
        sortable: true,
      }),
      field('salesperson', 'Salesperson', 'مندوب المبيعات', 'lookup', {
        lookup: 'salespeople',
        filterable: true,
        sortable: true,
      }),
      field('customerGroup', 'Group', 'المجموعة', 'lookup', {
        lookup: 'customerGroups',
        filterable: true,
      }),
      field('blocked', 'Blocked', 'موقوف', 'boolean', { required: true, filterable: true }),
      field('lastInvoiceDate', 'Last invoice', 'آخر فاتورة', 'date', { sortable: true }),
      field('modifiedDate', 'Modified', 'تاريخ التعديل', 'dateTime', { sortable: true }),
    ],
    searchAlso: [],
  },
  itemsOnHand: {
    id: 'itemsOnHand',
    kind: 'entity',
    label: label('Items on hand', 'الأصناف المتاحة'),
    schemaVersion: 'itemsOnHand.1',
    keyField: 'itemId',
    // One record per item, summed over its main warehouse: no surrogate id of its own.
    idField: null,
    maxPageSize: 500,
    maxRecords: 10000,
    maxCommitRecords: 0,
    fields: [
      field('itemId', 'Item', 'الصنف', 'text', {
        maxLength: 30,
        filterable: true,
        sortable: true,
        search: true,
      }),
      field('itemName', 'Name', 'الاسم', 'text', { maxLength: 120, sortable: true, search: true }),
      field('warehouse', 'Warehouse', 'المخزن', 'lookup', {
        lookup: 'warehouses',
        filterable: true,
        sortable: true,
      }),
      field('quantity', 'On hand', 'الكمية المتاحة', 'decimal', { scale: 3, sortable: true }),
      field('unit', 'Unit', 'الوحدة', 'lookup', { lookup: 'units', filterable: true }),
      field('reorderLevel', 'Reorder level', 'حد إعادة الطلب', 'integer', {
        min: 0,
        sortable: true,
      }),
      field('lastMovement', 'Last movement', 'آخر حركة', 'date', { sortable: true }),
    ],
    searchAlso: [],
  },
};

/** Lookup lists per company, one description per item as the ERP's tables hold them. */
export function lookups(company) {
  const kit = company === 'Kit';
  return {
    vendorGroups: [
      { code: 'LOCAL', label: 'محلي' },
      { code: 'IMPORT', label: 'Import' },
      ...(kit
        ? [
            { code: 'SERVICES', label: 'خدمات' },
            { code: 'OLD', label: 'Old suppliers', active: false },
          ]
        : []),
    ],
    currencies: [
      { code: 'EGP', label: 'جنيه مصري' },
      { code: 'USD', label: 'US dollar' },
      { code: 'EUR', label: 'Euro' },
    ],
    paymentModes: [
      { code: 'CASH', label: 'نقدي' },
      { code: 'NET30', label: '30 days' },
      { code: 'NET60', label: 'آجل 60 يوم' },
    ],
    salespeople: kit
      ? [
          { code: 'S-BOB', label: 'Bob Mansour' },
          { code: 'S-NOUR', label: 'نور عادل' },
          { code: 'S-HANY', label: 'Hany Gad' },
          { code: 'S-OLD', label: 'Former representative', active: false },
        ]
      : [{ code: 'S-RANA', label: 'رنا فؤاد' }],
    customerGroups: [
      { code: 'RETAIL', label: 'Retail' },
      { code: 'WHOLESALE', label: 'جملة' },
      { code: 'EXPORT', label: 'Export' },
    ],
    warehouses: kit
      ? [
          { code: 'WH-CAI', label: 'Cairo main' },
          { code: 'WH-ALX', label: 'ميناء الإسكندرية' },
          { code: 'WH-ASW', label: 'Aswan' },
        ]
      : [{ code: 'WH-DOT', label: 'Dot central' }],
    units: [
      { code: 'PCS', label: 'Piece' },
      { code: 'KG', label: 'كيلوجرام' },
      { code: 'BOX', label: 'Box' },
      { code: 'LTR', label: 'Litre' },
    ],
  };
}

/** A small deterministic generator (mulberry32), so every reset seeds the same records. */
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

const pad = (n, width) => String(n).padStart(width, '0');
const money = (cents) => `${Math.floor(cents / 100)}.${pad(cents % 100, 2)}`;
const day = (pick) =>
  `2026-${pad(1 + Math.floor(pick() * 10), 2)}-${pad(1 + Math.floor(pick() * 28), 2)}`;
const stamp = (pick) =>
  `${day(pick)}T${pad(8 + Math.floor(pick() * 9), 2)}:${pad(Math.floor(pick() * 60), 2)}:00+02:00`;
const choose = (pick, list) => list[Math.floor(pick() * list.length)];

const VENDOR_KINDS = ['Trading', 'Supplies', 'Logistics', 'Foods', 'Steel', 'Paper'];
const VENDOR_KINDS_AR = ['للتجارة', 'للتوريدات', 'للنقل', 'للأغذية'];
const CITIES = ['Cairo', 'Giza', 'Alexandria', 'Mansoura', 'Tanta', 'Aswan', 'القاهرة', 'الجيزة'];
const CUSTOMER_KINDS = ['Bakeries', 'Pharmacy', 'Markets', 'Hotels', 'Kitchens', 'Clinics'];
const ITEMS = [
  'olive oil 1 L',
  'steel bolts M8',
  'paper A4',
  'rice 5 kg',
  'cables 2 m',
  'tea 250 g',
];

function vendorRow(company, account, values) {
  return {
    company,
    vendorAccount: account,
    vendorName: '',
    vendorGroup: 'LOCAL',
    mobile: null,
    currency: 'EGP',
    payMethod: 'CASH',
    address: null,
    taxFile: null,
    blocked: false,
    bankAccount: null,
    debitLimit: '0.00',
    modifiedBy: 'seed',
    modifiedDate: '2026-10-30T10:12:00+02:00',
    // Never sent: the ERP's list searches it, Query does not return it.
    phone: null,
    ...values,
  };
}

function vendors(pick) {
  const kit = [
    vendorRow('Kit', 'V-1001', {
      vendorName: 'Qorvath Lantern Trading',
      mobile: '01001234567',
      taxFile: '001-234-567',
      address: '12 Tahrir St, Cairo',
      bankAccount: 'EG380019000500000000263180002',
      debitLimit: '15000.00',
    }),
    vendorRow('Kit', 'V-1002', {
      vendorName: 'مؤسسة زمرّدان للتوريدات',
      vendorGroup: 'IMPORT',
      payMethod: 'NET30',
      currency: 'USD',
      mobile: '01119876543',
      taxFile: '0045',
      address: 'شارع الهرم، الجيزة',
    }),
    vendorRow('Kit', 'V-1003', {
      vendorName: 'Velmorra Supplies',
      blocked: true,
      debitLimit: '2500.50',
      phone: '0223456789',
    }),
    vendorRow('Kit', 'V-1004', {
      vendorName: 'شركة قرنفلون',
      taxFile: '001',
      mobile: '0020123456789',
    }),
    vendorRow('Kit', 'V-1005', {
      vendorName: 'Ombrevique Steel',
      vendorGroup: 'SERVICES',
      payMethod: 'NET60',
      debitLimit: '999999999.99',
    }),
    vendorRow('Kit', 'V-1006', { vendorName: 'Thessaly Quay Logistics', currency: null }),
    vendorRow('Kit', 'V-1007', { vendorName: 'Zarkonite Old Group', vendorGroup: 'OLD' }),
  ];
  for (let n = kit.length + 1; kit.length < 150; n++) {
    const arabic = pick() < 0.3;
    const cents = Math.floor(pick() * 5_000_000);
    kit.push(
      vendorRow('Kit', `V-${pad(2000 + n, 5)}`, {
        vendorName: arabic
          ? `شركة ${choose(pick, MARKERS.Kit.slice(8))} ${choose(pick, VENDOR_KINDS_AR)} ${n}`
          : `${choose(pick, MARKERS.Kit.slice(0, 8))} ${choose(pick, VENDOR_KINDS)} ${n}`,
        vendorGroup: choose(pick, ['LOCAL', 'IMPORT', 'SERVICES']),
        payMethod: choose(pick, ['CASH', 'NET30', 'NET60']),
        currency: choose(pick, ['EGP', 'EGP', 'EGP', 'USD', 'EUR']),
        mobile: pick() < 0.85 ? '01' + pad(Math.floor(pick() * 1e9), 9) : null,
        taxFile: pick() < 0.7 ? pad(Math.floor(pick() * 1e6), 9) : null,
        address: pick() < 0.6 ? `${1 + Math.floor(pick() * 200)} ${choose(pick, CITIES)} Rd` : null,
        blocked: pick() < 0.08,
        debitLimit: money(cents),
        modifiedDate: stamp(pick),
      }),
    );
  }
  const dot = [
    vendorRow('Dot', 'V-1001', { vendorName: 'Ferrowyn Dot Foods', mobile: '01500000001' }),
  ];
  for (let n = 2; dot.length < 12; n++) {
    dot.push(
      vendorRow('Dot', `D-${pad(n, 4)}`, {
        vendorName: `${choose(pick, MARKERS.Dot)} ${choose(pick, VENDOR_KINDS)} ${n}`,
        debitLimit: money(Math.floor(pick() * 1_000_000)),
        modifiedDate: stamp(pick),
      }),
    );
  }
  return interleave(kit, dot, 4411);
}

function customerRow(company, account, values) {
  return {
    company,
    customerAccount: account,
    customerName: '',
    city: null,
    creditLimit: '0.00',
    salesperson: company === 'Kit' ? 'S-NOUR' : 'S-RANA',
    customerGroup: 'RETAIL',
    blocked: false,
    lastInvoiceDate: null,
    modifiedDate: '2026-11-01T09:00:00+02:00',
    ...values,
  };
}

function customers(pick) {
  const kit = [
    customerRow('Kit', 'C-1001', {
      customerName: 'Qorvath Bakeries',
      city: 'Cairo',
      creditLimit: '25000.00',
      salesperson: 'S-BOB',
      lastInvoiceDate: '2026-11-02',
    }),
    customerRow('Kit', 'C-1002', {
      customerName: 'مخابز زمرّدان',
      city: 'الإسكندرية',
      creditLimit: '120000.50',
      customerGroup: 'WHOLESALE',
      lastInvoiceDate: '2026-10-28',
    }),
    customerRow('Kit', 'C-1003', {
      customerName: 'Velmorra Pharmacy',
      city: 'Giza',
      creditLimit: null,
      salesperson: 'S-BOB',
      blocked: true,
    }),
    customerRow('Kit', 'C-1004', {
      customerName: 'Calderune Hotels',
      city: 'Hurghada',
      creditLimit: '9999999.99',
      salesperson: 'S-HANY',
      customerGroup: 'EXPORT',
      lastInvoiceDate: '2026-09-15',
    }),
    customerRow('Kit', 'C-1005', {
      customerName: 'Ystrelle Markets',
      city: 'Mansoura',
      salesperson: 'S-OLD',
      lastInvoiceDate: '2025-12-31',
    }),
  ];
  for (let n = kit.length + 1; kit.length < 240; n++) {
    const arabic = pick() < 0.25;
    kit.push(
      customerRow('Kit', `C-${pad(1000 + n, 4)}`, {
        customerName: arabic
          ? `${choose(pick, ['صيدليات', 'أسواق', 'مطابخ'])} ${choose(pick, MARKERS.Kit.slice(8))} ${n}`
          : `${choose(pick, MARKERS.Kit.slice(0, 8))} ${choose(pick, CUSTOMER_KINDS)} ${n}`,
        city: pick() < 0.9 ? choose(pick, CITIES) : null,
        creditLimit: pick() < 0.9 ? money(Math.floor(pick() * 20_000_000)) : null,
        salesperson: choose(pick, ['S-BOB', 'S-NOUR', 'S-NOUR', 'S-HANY']),
        customerGroup: choose(pick, ['RETAIL', 'WHOLESALE', 'EXPORT']),
        blocked: pick() < 0.05,
        lastInvoiceDate: pick() < 0.8 ? day(pick) : null,
        modifiedDate: stamp(pick),
      }),
    );
  }
  const dot = [];
  for (let n = 1; dot.length < 10; n++) {
    dot.push(
      customerRow('Dot', `DC-${pad(n, 3)}`, {
        customerName: `${choose(pick, MARKERS.Dot)} ${choose(pick, CUSTOMER_KINDS)} ${n}`,
        city: choose(pick, CITIES),
        creditLimit: money(Math.floor(pick() * 1_000_000)),
        lastInvoiceDate: day(pick),
      }),
    );
  }
  return interleave(kit, dot, 7101);
}

function itemRow(company, itemId, values) {
  return {
    company,
    itemId,
    itemName: '',
    warehouse: company === 'Kit' ? 'WH-CAI' : 'WH-DOT',
    quantity: '0.000',
    unit: 'PCS',
    reorderLevel: null,
    lastMovement: null,
    ...values,
  };
}

function items(pick) {
  const kit = [
    itemRow('Kit', 'ITM-0001', {
      itemName: 'Qorvath olive oil 1 L',
      quantity: '1250.500',
      unit: 'LTR',
      reorderLevel: 200,
      lastMovement: '2026-11-10',
    }),
    itemRow('Kit', 'ITM-0002', {
      itemName: 'أرز زمرّدان 5 كجم',
      warehouse: 'WH-ALX',
      unit: 'KG',
      reorderLevel: 50,
      lastMovement: '2026-11-12',
    }),
    itemRow('Kit', 'ITM-0003', {
      itemName: 'Velmorra steel bolts M8',
      quantity: '-12.000',
      lastMovement: '2026-10-01',
    }),
    itemRow('Kit', 'ITM-0004', {
      itemName: 'Brinmoor paper A4',
      warehouse: 'WH-ASW',
      quantity: '340.250',
      unit: 'BOX',
      reorderLevel: 30,
      lastMovement: '2026-08-19',
    }),
  ];
  for (let n = kit.length + 1; kit.length < 90; n++) {
    kit.push(
      itemRow('Kit', `ITM-${pad(n, 4)}`, {
        itemName: `${choose(pick, MARKERS.Kit.slice(0, 8))} ${choose(pick, ITEMS)}`,
        warehouse: choose(pick, ['WH-CAI', 'WH-ALX', 'WH-ASW']),
        quantity: `${Math.floor(pick() * 5000)}.${pad(Math.floor(pick() * 1000), 3)}`,
        unit: choose(pick, ['PCS', 'KG', 'BOX', 'LTR']),
        reorderLevel: pick() < 0.7 ? Math.floor(pick() * 500) : null,
        lastMovement: pick() < 0.9 ? day(pick) : null,
      }),
    );
  }
  const dot = [];
  for (let n = 1; dot.length < 8; n++) {
    dot.push(
      itemRow('Dot', `DOT-${pad(n, 3)}`, {
        itemName: `${choose(pick, MARKERS.Dot)} ${choose(pick, ITEMS)}`,
        quantity: `${Math.floor(pick() * 900)}.000`,
        lastMovement: day(pick),
      }),
    );
  }
  return interleave(kit, dot, null);
}

/** Two companies' rows in one table, interleaved in the id space as they are in the ERP. */
function interleave(kit, dot, firstId) {
  const rows = [];
  let d = 0;
  for (let k = 0; k < kit.length; k++) {
    rows.push(kit[k]);
    if (k % 20 === 3 && d < dot.length) rows.push(dot[d++]);
  }
  while (d < dot.length) rows.push(dot[d++]);
  return rows.map((row, i) => (firstId === null ? row : { recId: String(firstId + i), ...row }));
}

/**
 * Every record by connector, in id order, with its version: one 8-byte counter per database, as
 * SQL Server's `rowversion` is.
 */
export function seedRecords() {
  const pick = random(20261114);
  let counter = 0x1000n;
  const version = () => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(++counter);
    return bytes.toString('base64');
  };
  const out = {};
  for (const [id, rows] of [
    ['vendors', vendors(pick)],
    ['customers', customers(pick)],
    ['itemsOnHand', items(pick)],
  ]) {
    const connector = CONNECTORS[id];
    out[id] = rows.map((row) => ({
      ...row,
      id: connector.idField ? row[connector.idField] : row[connector.keyField],
      version: version(),
    }));
  }
  return out;
}
