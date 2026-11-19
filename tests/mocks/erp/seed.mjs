// The mock ERP's data (tests/mocks/erp/server.mjs): two companies in one database, as Kit and Dot
// share ASTDataTest, their users, and three connectors (Vendors as `vendors.1`, Customers as
// `customers.1`, Items on hand as `itemsOnHand.1`) with seeded records. Every record's name holds
// one of `MARKERS`, a made-up word found nowhere else, so a test can search a document, a store,
// the search index or a log for ERP data and know that finding nothing means something.
//
// Phase 10: Customers and Items on hand have the real connectors' fields, labels, lookups and
// rules (CashGear's `CustomerConnector.cs` and `ItemsOnHandConnector.cs`, Track E4, with Track E8's
// editing, INTEGRATIONS.md "Customers and Items on hand editable"): a customer list where a user
// whose profile says so sees only the customers they created, the national ID kept from employees,
// one Items on hand record per item and storage place whose name and group belong to the item
// (`scope: 'key'`), and versions made from the values a user sees, as neither CustTable nor
// InvTable nor InvSum has a rowversion.

import { largeRecords } from './large.mjs';

/**
 * The companies, each with Workspace turned on. Phase 12: a report's `today` and `monthStart` are
 * read in the company's time zone.
 */
export const COMPANIES = {
  Kit: { name: 'Kit Trading', database: 'ASTDataTest', timeZone: 'Africa/Cairo' },
  Dot: { name: 'Dot Foods', database: 'ASTDataTest', timeZone: 'Africa/Cairo' },
};

export const CONNECTOR_IDS = ['vendors', 'customers', 'itemsOnHand'];

/**
 * The ERP users the mock client signs in as, each with the API key the ERP client would hold.
 * `connectors` are those the user may view; `hidden` the fields the ERP's field rules keep from
 * them (Customers' national ID from employees, as the customer list's ShowSensitiveData does);
 * `rules` the record rules it applies (Customers' `LoadOwnedRows`: only the customers they
 * created); `admin` whether they may link and revoke; `edit` (Phase 7, Phase 10) a connector's
 * Edit privilege (`edit`) or Edit and AdvEdit (`advEdit`). Phase 12: `roles`, the ERP roles its
 * report pages check (each report lists those it takes, reports.mjs), and `showCost`, whether the
 * Warehouse balance page shows them cost (Exec, or AdvView on unit 4006). Every user's entities
 * are as before.
 */
export const USERS = {
  alice: {
    id: 'u101',
    key: 'mock-alice',
    company: 'Kit',
    displayName: 'Alice Haddad',
    connectors: ['vendors', 'customers', 'itemsOnHand'],
    // An accounts manager: every report, with cost.
    roles: ['accountmgr'],
    showCost: true,
    admin: false,
  },
  bob: {
    id: 'u102',
    key: 'mock-bob',
    company: 'Kit',
    displayName: 'Bob Mansour',
    connectors: ['vendors', 'customers'],
    // Bob sells: an employee who sees only the customers he created, without their national ID.
    rules: { customers: { createdBy: 'u102' } },
    hidden: { customers: ['nationalId'] },
    // Also keeps the warehouse: stock balance, without cost; neither AP aging nor the trial balance.
    roles: ['warehouse'],
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
    roles: ['accountmgr'],
    showCost: true,
    admin: true,
  },
  // Vendors' and Customers' Edit; like Bob, an employee who sees only the customers she created.
  gina: {
    id: 'u105',
    key: 'mock-gina',
    company: 'Kit',
    displayName: 'Gina Wahba',
    connectors: ['vendors', 'customers'],
    rules: { customers: { createdBy: 'u105' } },
    hidden: { customers: ['nationalId'] },
    edit: { vendors: 'edit', customers: 'edit' },
    // Payables: AP aging only.
    roles: ['payable'],
    admin: false,
  },
  // Vendors' and Customers' Edit and AdvEdit, Items' Edit; sees every customer.
  faris: {
    id: 'u106',
    key: 'mock-faris',
    company: 'Kit',
    displayName: 'فارس منير',
    connectors: ['vendors', 'customers', 'itemsOnHand'],
    edit: { vendors: 'advEdit', customers: 'advEdit', itemsOnHand: 'edit' },
    // The warehouse manager: stock balance, with cost.
    roles: ['warehousemgr'],
    showCost: true,
    admin: false,
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

/**
 * A field, as the real connector lists it. `search` marks what the ERP's own list searches; `edit`
 * the privilege a change through a workspace needs (none, `edit` or `advEdit`); `scope: 'key'` a
 * value that belongs to every record of the same key.
 */
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
    // Vendors has a rowversion: one 8-byte counter per database.
    versions: 'rowversion',
    // vendors.1's fields, in the ERP's list order, with its labels. `edit` is the privilege a
    // field needs to be changed (Phase 7, INTEGRATIONS.md): none, Edit or AdvEdit.
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
        edit: 'edit',
      }),
      field('vendorGroup', 'Group', 'المجموعة', 'lookup', {
        lookup: 'vendorGroups',
        required: true,
        filterable: true,
        sortable: true,
        search: true,
        edit: 'edit',
      }),
      field('mobile', 'Mobile', 'الجوال', 'text', { maxLength: 50, search: true, edit: 'edit' }),
      field('currency', 'Currency', 'العملة', 'lookup', {
        lookup: 'currencies',
        required: true,
        filterable: true,
        sortable: true,
        edit: 'advEdit',
      }),
      field('payMethod', 'Payment method', 'طريقة الدفع', 'lookup', {
        lookup: 'paymentModes',
        required: true,
        filterable: true,
        edit: 'edit',
      }),
      field('address', 'Address', 'العنوان', 'text', { maxLength: 150, edit: 'edit' }),
      field('taxFile', 'Tax file', 'الملف الضريبي', 'text', { maxLength: 50, edit: 'edit' }),
      field('blocked', 'Blocked', 'موقوف', 'boolean', {
        required: true,
        filterable: true,
        edit: 'advEdit',
      }),
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
  // customers.1 (CustomerConnector.cs): every field sortable, codes and texts filterable; Track
  // E8's editing (INTEGRATIONS.md's table): Edit for the name, group, mobiles, payment method,
  // address and tax file; AdvEdit for the currency, price list, credit limit and blocked.
  customers: {
    id: 'customers',
    kind: 'entity',
    label: label('Customers', 'العملاء'),
    schemaVersion: 'customers.1',
    keyField: 'customerAccount',
    idField: 'recId',
    maxPageSize: 1000,
    maxRecords: 10000,
    maxCommitRecords: 500,
    versions: 'content',
    // A commit writes CustTable's modified stamps, as the ERP's customer screen does.
    stamps: true,
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
        edit: 'edit',
      }),
      field('customerGroup', 'Group', 'المجموعة', 'lookup', {
        lookup: 'customerGroups',
        required: true,
        filterable: true,
        sortable: true,
        edit: 'edit',
      }),
      field('mobile', 'Mobile', 'الجوال', 'text', {
        maxLength: 50,
        filterable: true,
        sortable: true,
        search: true,
        edit: 'edit',
      }),
      field('mobile2', 'Second mobile', 'الجوال 2', 'text', {
        maxLength: 50,
        filterable: true,
        sortable: true,
        search: true,
        edit: 'edit',
      }),
      field('nationalId', 'National ID', 'الرقم القومي', 'text', {
        maxLength: 50,
        filterable: true,
        sortable: true,
        search: true,
      }),
      field('currency', 'Currency', 'العملة', 'lookup', {
        lookup: 'currencies',
        required: true,
        filterable: true,
        sortable: true,
        edit: 'advEdit',
      }),
      field('payMethod', 'Payment method', 'طريقة الدفع', 'lookup', {
        lookup: 'paymentModes',
        // Track E8: CustTable.PayMethod is required; an empty value is no payment mode.
        required: true,
        filterable: true,
        sortable: true,
        edit: 'edit',
      }),
      field('priceList', 'Price list', 'قائمة الأسعار', 'text', {
        maxLength: 50,
        filterable: true,
        sortable: true,
        edit: 'advEdit',
      }),
      field('governorate', 'Governorate', 'المحافظة', 'text', {
        maxLength: 100,
        filterable: true,
        sortable: true,
        search: true,
      }),
      field('city', 'City', 'المدينة', 'text', {
        maxLength: 100,
        filterable: true,
        sortable: true,
        search: true,
      }),
      field('address', 'Address', 'العنوان', 'text', {
        maxLength: 150,
        sortable: true,
        edit: 'edit',
      }),
      field('taxFile', 'Tax file', 'الملف الضريبي', 'text', {
        maxLength: 50,
        filterable: true,
        sortable: true,
        edit: 'edit',
      }),
      field('creditLimit', 'Credit limit', 'حد الائتمان', 'decimal', {
        scale: 2,
        min: '0',
        // Track E8: CustTable.CreditLimit is a float, exact to 15 significant digits.
        max: '9999999999999.99',
        sortable: true,
        edit: 'advEdit',
      }),
      field('blocked', 'Blocked', 'موقوف', 'boolean', {
        required: true,
        filterable: true,
        sortable: true,
        edit: 'advEdit',
      }),
      field('createdBy', 'Created by', 'أنشئ بواسطة', 'text', {
        maxLength: 50,
        filterable: true,
        sortable: true,
      }),
      field('createdDate', 'Created', 'تاريخ الإنشاء', 'date', {
        filterable: true,
        sortable: true,
      }),
      field('modifiedBy', 'Modified by', 'عدل بواسطة', 'text', {
        maxLength: 50,
        filterable: true,
        sortable: true,
      }),
      field('modifiedDate', 'Modified', 'تاريخ التعديل', 'dateTime', { sortable: true }),
    ],
    // The ERP's customer search also looks in the search name, which is never sent.
    searchAlso: ['searchName'],
  },
  // itemsOnHand.1 (ItemsOnHandConnector.cs): one record per item and storage place, keyed by the
  // item; Track E8: the item's name and group with the Items unit's Edit, each the item's own
  // (`scope: 'key'`); stock never.
  itemsOnHand: {
    id: 'itemsOnHand',
    kind: 'entity',
    label: label('Items on hand', 'أرصدة الأصناف'),
    schemaVersion: 'itemsOnHand.1',
    keyField: 'itemId',
    idField: null,
    maxPageSize: 1000,
    maxRecords: 10000,
    maxCommitRecords: 500,
    versions: 'content',
    stamps: false,
    fields: [
      field('itemId', 'Item ID', 'كود الصنف', 'text', {
        maxLength: 50,
        filterable: true,
        sortable: true,
        search: true,
      }),
      field('itemName', 'Name', 'الاسم', 'text', {
        maxLength: 150,
        required: true,
        sortable: true,
        search: true,
        edit: 'edit',
        scope: 'key',
      }),
      field('unit', 'Unit', 'الوحدة', 'text', { maxLength: 50, filterable: true, sortable: true }),
      field('itemGroup', 'Item group', 'مجموعة الصنف', 'lookup', {
        lookup: 'itemGroups',
        required: true,
        filterable: true,
        sortable: true,
        edit: 'edit',
        scope: 'key',
      }),
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
      field('locationId', 'Location', 'مكان التخزين', 'text', {
        maxLength: 50,
        filterable: true,
        sortable: true,
      }),
      field('onHandQty', 'On hand', 'الرصيد', 'decimal', { scale: 3, sortable: true }),
      field('onHandValue', 'Value', 'القيمة', 'decimal', { scale: 2, sortable: true }),
    ],
    // The item search: id, name and search name.
    searchAlso: ['searchName'],
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
    customerGroups: [
      { code: 'EXPORT', label: 'Export' },
      { code: 'RETAIL', label: 'Retail' },
      { code: 'WHOLESALE', label: 'جملة' },
      ...(kit ? [{ code: 'ZOLD', label: 'Former customers', active: false }] : []),
    ],
    itemGroups: kit
      ? [
          { code: 'FOOD', label: 'Food' },
          { code: 'HARDWARE', label: 'عدد وأدوات' },
          { code: 'PAPER', label: 'Paper' },
          { code: 'ZOLD', label: 'Discontinued', active: false },
        ]
      : [{ code: 'FOOD', label: 'أغذية' }],
    sites: kit
      ? [
          { code: 'S-MAIN', label: 'Main site' },
          { code: 'S-PORT', label: 'الميناء' },
        ]
      : [{ code: 'S-DOT', label: 'Dot site' }],
    warehouses: kit
      ? [
          { code: 'WH-ALX', label: 'ميناء الإسكندرية' },
          { code: 'WH-ASW', label: 'Aswan' },
          { code: 'WH-CAI', label: 'Cairo main' },
        ]
      : [{ code: 'WH-DOT', label: 'Dot central' }],
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
/** Governorates and their cities, as the ERP's address book holds them. */
const PLACES = [
  ['Cairo', 'Nasr City'],
  ['Giza', 'Dokki'],
  ['Alexandria', 'Smouha'],
  ['Dakahlia', 'Mansoura'],
  ['القاهرة', 'مصر الجديدة'],
  ['الإسكندرية', 'سيدي جابر'],
];
const CUSTOMER_KINDS = ['Bakeries', 'Pharmacy', 'Markets', 'Hotels', 'Kitchens', 'Clinics'];
const ITEMS = [
  ['olive oil 1 L', 'FOOD', 'LTR'],
  ['steel bolts M8', 'HARDWARE', 'PCS'],
  ['paper A4', 'PAPER', 'BOX'],
  ['rice 5 kg', 'FOOD', 'KG'],
  ['cables 2 m', 'HARDWARE', 'PCS'],
  ['tea 250 g', 'FOOD', 'BOX'],
];
/** Kit's storage places: site, warehouse, location. */
const PLACES_KIT = [
  ['S-MAIN', 'WH-CAI', 'A-01'],
  ['S-MAIN', 'WH-CAI', 'A-02'],
  ['S-PORT', 'WH-ALX', 'B-01'],
  ['S-MAIN', 'WH-ASW', null],
];
/** Who made Kit's customers: Bob, Gina, Faris, Alice and an ERP user Workspace never sees. */
const MAKERS = ['u102', 'u105', 'u106', 'u101', 'u199'];

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

function vendors(pick, kitVendors = 150, locks = true) {
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
      // Phase 7: locked in the ERP (an open document holds it), so no commit may change it.
      locked: locks,
    }),
    vendorRow('Kit', 'V-1006', { vendorName: 'Thessaly Quay Logistics', currency: null }),
    vendorRow('Kit', 'V-1007', { vendorName: 'Zarkonite Old Group', vendorGroup: 'OLD' }),
  ];
  for (let n = kit.length + 1; kit.length < kitVendors; n++) {
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
  const [governorate, city] = PLACES[0];
  return {
    company,
    customerAccount: account,
    customerName: '',
    // Never sent: the ERP's customer search looks in it.
    searchName: null,
    customerGroup: 'RETAIL',
    mobile: null,
    mobile2: null,
    nationalId: null,
    currency: 'EGP',
    payMethod: 'CASH',
    priceList: null,
    governorate,
    city,
    address: null,
    taxFile: null,
    creditLimit: '0.00',
    blocked: false,
    createdBy: company === 'Kit' ? 'u101' : 'u201',
    createdDate: '2025-06-01',
    modifiedBy: 'seed',
    modifiedDate: '2026-11-01T09:00:00+02:00',
    ...values,
  };
}

function customers(pick, kitCustomers = 240) {
  const kit = [
    customerRow('Kit', 'C-1001', {
      customerName: 'Qorvath Bakeries',
      searchName: 'qorvath bakery',
      mobile: '01001112233',
      nationalId: '28501011234567',
      address: '4 Abbas St, Nasr City',
      taxFile: '310-555-120',
      creditLimit: '25000.00',
      priceList: 'Wholesale 2026',
      createdBy: 'u102',
    }),
    customerRow('Kit', 'C-1002', {
      customerName: 'مخابز زمرّدان',
      governorate: 'الإسكندرية',
      city: 'سيدي جابر',
      mobile: '01223334455',
      mobile2: '0345678901',
      address: 'شارع فؤاد، الإسكندرية',
      creditLimit: '120000.50',
      customerGroup: 'WHOLESALE',
      payMethod: 'NET30',
      createdBy: 'u105',
    }),
    customerRow('Kit', 'C-1003', {
      customerName: 'Velmorra Pharmacy',
      ...placeOf(1),
      creditLimit: null,
      blocked: true,
      createdBy: 'u102',
    }),
    customerRow('Kit', 'C-1004', {
      customerName: 'Calderune Hotels',
      ...placeOf(3),
      currency: 'USD',
      creditLimit: '9999999.99',
      customerGroup: 'EXPORT',
      payMethod: 'NET60',
      createdBy: 'u106',
    }),
    customerRow('Kit', 'C-1005', {
      customerName: 'Ystrelle Markets',
      ...placeOf(2),
      customerGroup: 'ZOLD',
      createdBy: 'u101',
    }),
    customerRow('Kit', 'C-1006', {
      customerName: 'Brinmoor Kitchens',
      mobile: '01509998877',
      createdBy: 'u105',
    }),
  ];
  for (let n = kit.length + 1; kit.length < kitCustomers; n++) {
    const arabic = pick() < 0.25;
    const place = PLACES[Math.floor(pick() * PLACES.length)];
    kit.push(
      customerRow('Kit', `C-${pad(1000 + n, 4)}`, {
        customerName: arabic
          ? `${choose(pick, ['صيدليات', 'أسواق', 'مطابخ'])} ${choose(pick, MARKERS.Kit.slice(8))} ${n}`
          : `${choose(pick, MARKERS.Kit.slice(0, 8))} ${choose(pick, CUSTOMER_KINDS)} ${n}`,
        governorate: place[0],
        city: place[1],
        mobile: pick() < 0.85 ? '01' + pad(Math.floor(pick() * 1e9), 9) : null,
        mobile2: pick() < 0.2 ? '01' + pad(Math.floor(pick() * 1e9), 9) : null,
        nationalId: pick() < 0.5 ? `2${pad(Math.floor(pick() * 1e13), 13)}` : null,
        address: pick() < 0.6 ? `${1 + Math.floor(pick() * 200)} ${place[1]} St` : null,
        taxFile: pick() < 0.4 ? pad(Math.floor(pick() * 1e6), 9) : null,
        creditLimit: pick() < 0.9 ? money(Math.floor(pick() * 20_000_000)) : null,
        customerGroup: choose(pick, ['RETAIL', 'WHOLESALE', 'EXPORT']),
        currency: choose(pick, ['EGP', 'EGP', 'EGP', 'USD', 'EUR']),
        payMethod: choose(pick, ['CASH', 'NET30', 'NET60', null]),
        blocked: pick() < 0.05,
        createdBy: choose(pick, MAKERS),
        createdDate: day(pick),
        modifiedDate: stamp(pick),
      }),
    );
  }
  const dot = [];
  for (let n = 1; dot.length < 10; n++) {
    dot.push(
      customerRow('Dot', `DC-${pad(n, 3)}`, {
        customerName: `${choose(pick, MARKERS.Dot)} ${choose(pick, CUSTOMER_KINDS)} ${n}`,
        ...placeOf(Math.floor(pick() * PLACES.length)),
        creditLimit: money(Math.floor(pick() * 1_000_000)),
        createdDate: day(pick),
      }),
    );
  }
  return interleave(kit, dot, 7101);
}

function placeOf(index) {
  const [governorate, city] = PLACES[index % PLACES.length];
  return { governorate, city };
}

/** An item's stock at one place: the item's own fields copied onto each of its rows. */
function stockRow(company, item, [siteId, warehouseId, locationId], qty, value) {
  return {
    company,
    ...item,
    siteId,
    warehouseId,
    locationId,
    onHandQty: qty,
    onHandValue: value,
  };
}

function itemOf(itemId, itemName, itemGroup, unit, searchName = null) {
  return { itemId, itemName, itemGroup, unit, searchName };
}

function items(pick) {
  const one = itemOf('ITM-0001', 'Qorvath olive oil 1 L', 'FOOD', 'LTR', 'olive oil');
  const two = itemOf('ITM-0002', 'أرز زمرّدان 5 كجم', 'FOOD', 'KG');
  const three = itemOf('ITM-0003', 'Velmorra steel bolts M8', 'HARDWARE', 'PCS');
  const four = itemOf('ITM-0004', 'Brinmoor paper A4', 'PAPER', 'BOX');
  const kit = [
    // One item, three places: its name and group are the item's, on every row.
    stockRow('Kit', one, PLACES_KIT[0], '1250.500', '62525.00'),
    stockRow('Kit', one, PLACES_KIT[2], '80.000', '4000.00'),
    stockRow('Kit', one, PLACES_KIT[3], '12.250', '612.50'),
    stockRow('Kit', two, PLACES_KIT[2], '540.000', '16200.00'),
    // Stock may run below zero; a row is kept while either total is not zero.
    stockRow('Kit', three, PLACES_KIT[0], '-12.000', '0.00'),
    stockRow('Kit', four, PLACES_KIT[1], '340.250', '10207.50'),
    stockRow('Kit', four, PLACES_KIT[3], '15.000', '450.00'),
  ];
  for (let n = 5; n <= 60; n++) {
    const [name, group, unit] = choose(pick, ITEMS);
    const item = itemOf(
      `ITM-${pad(n, 4)}`,
      `${choose(pick, MARKERS.Kit.slice(0, 8))} ${name}`,
      group,
      unit,
    );
    const places = 1 + Math.floor(pick() * 3);
    const start = Math.floor(pick() * PLACES_KIT.length);
    for (let p = 0; p < places; p++) {
      const qty = Math.floor(pick() * 5000);
      kit.push(
        stockRow(
          'Kit',
          item,
          PLACES_KIT[(start + p) % PLACES_KIT.length],
          `${qty}.${pad(Math.floor(pick() * 1000), 3)}`,
          money(qty * (50 + Math.floor(pick() * 5000))),
        ),
      );
    }
  }
  const dot = [];
  for (let n = 1; dot.length < 8; n++) {
    const [name, , unit] = choose(pick, ITEMS);
    const qty = Math.floor(pick() * 900);
    dot.push(
      stockRow(
        'Dot',
        itemOf(`DOT-${pad(n, 3)}`, `${choose(pick, MARKERS.Dot)} ${name}`, 'FOOD', unit),
        ['S-DOT', 'WH-DOT', null],
        `${qty}.000`,
        money(qty * 300),
      ),
    );
  }
  // In the connector's own order (item, site, warehouse, location, ordinal), as the ERP reads it.
  const order = (a, b) => {
    for (const name of ['itemId', 'siteId', 'warehouseId', 'locationId']) {
      const x = a[name] ?? '';
      const y = b[name] ?? '';
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };
  return interleave(kit.sort(order), dot.sort(order), null);
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
 * An Items on hand record's id: the bucket's own key, item, site, warehouse and location, as the
 * stock lookup keys its rows.
 */
export const stockId = (row) =>
  [row.itemId, row.siteId ?? '', row.warehouseId ?? '', row.locationId ?? ''].join('|');

/**
 * Every record by connector, in id order. Vendors' each with its version: one 8-byte counter per
 * database, as SQL Server's `rowversion` is; Customers' and Items on hand's versions are made from
 * the values a user sees when read (server.mjs).
 *
 * `kitVendors` and `kitCustomers`: more of Kit's than the seed's 150 and 240, for the review
 * benches; `locks: false`, no record locked. Phase 12: `large`, Kit's records of the three
 * connectors are the large seed's 100,000 each (large.mjs); Dot's stay as they are.
 */
export function seedRecords({
  kitVendors = 150,
  kitCustomers = 240,
  locks = true,
  large = false,
} = {}) {
  const pick = random(20261114);
  let counter = 0x1000n;
  const version = () => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(++counter);
    return bytes.toString('base64');
  };
  const out = {};
  // Phase 12: the large seed (large.mjs) in place of Kit's records; Dot keeps its own.
  const big = large ? largeRecords() : null;
  for (const [id, made] of [
    ['vendors', vendors(pick, kitVendors, locks)],
    ['customers', customers(pick, kitCustomers)],
    ['itemsOnHand', items(pick)],
  ]) {
    const connector = CONNECTORS[id];
    const rows = big
      ? [
          ...big[id].map((row) => ({ company: 'Kit', ...row })),
          ...made.filter((row) => row.company !== 'Kit'),
        ]
      : made;
    out[id] = rows.map((row) => ({
      ...row,
      id: id === 'itemsOnHand' ? stockId(row) : row[connector.idField],
      ...(connector.versions === 'rowversion' ? { version: version() } : {}),
    }));
  }
  return out;
}
