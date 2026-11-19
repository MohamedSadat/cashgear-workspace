// The large seed (Phase 12, Track E10; tests/contracts/erp/README.md, "The large seed"): 100,000
// records a connector, made by one rule from each record's number `n` (1 to 100,000) with whole
// arithmetic and fixed lists, so UnifiedAPI's LocalDB can be seeded with exactly the same records.
// The mock serves it after `POST /__mock/reset {large: true}` (or `--large`), in place of Kit's
// usual records; the contract suite builds it too, to know what every answer must hold.
//
// Everything is plain data: no randomness, no dates from a clock, only BMP characters. The values
// are the ones `Query` sends (empty is null; decimals as strings at the field's scale; date-times
// the ERP host's local time with its offset, here `+02:00`).

/** Records a connector. */
export const LARGE_COUNT = 100_000;

/**
 * 28 first words: Latin with case variants (`Qorvath`, `qorvath`, `QORVATH`; `Ébrel`, `ébrel`),
 * and Arabic in pairs that differ by one letter form only: alef with and without hamza, alef
 * madda, taa marbuta and haa, alef maqsura and yaa, diacritics, hamza on waw and yaa, tatweel.
 */
export const NAMES = [
  'Qorvath',
  'qorvath',
  'QORVATH',
  'Velmorra',
  'velmorra',
  'Zarkonite',
  'Ombrevique',
  'Brinmoor',
  'Calderune',
  'Ystrelle',
  'Thessaly Quay',
  'Lumivar',
  'Ébrel',
  'ébrel',
  'أحمد',
  'احمد',
  'إسراء',
  'آمنة',
  'فاطمة',
  'فاطمه',
  'مصطفى',
  'مصطفي',
  'مُحمّد',
  'محمد',
  'مؤسسة الشاطئ',
  'مؤسسه الشاطي',
  'عبـدالله',
  'عبدالله',
];

/** Second words, by connector. */
export const VENDOR_KINDS = ['Trading', 'Supplies', 'Logistics', 'للتجارة', 'للتوريدات', 'Foods'];
export const CUSTOMER_KINDS = ['Bakeries', 'Pharmacy', 'Markets', 'صيدليات', 'أسواق', 'Hotels'];
export const ITEM_KINDS = [
  'olive oil 1 L',
  'steel bolts M8',
  'paper A4',
  'أرز 5 كجم',
  'شاي 250 جم',
  'cables 2 m',
];

/** Governorate and city pairs: Latin, Arabic, and Arabic without its hamza and with alef maqsura. */
export const PLACES = [
  ['Cairo', 'Nasr City'],
  ['Giza', 'Dokki'],
  ['Alexandria', 'Smouha'],
  ['القاهرة', 'مصر الجديدة'],
  ['الإسكندرية', 'سيدي جابر'],
  ['الاسكندرية', 'سيدى جابر'],
];

/** Storage places in the order Items on hand reads them (site, warehouse, location, ordinal). */
export const STORAGE = [
  ['S-MAIN', 'WH-ASW', null],
  ['S-MAIN', 'WH-CAI', 'A-01'],
  ['S-MAIN', 'WH-CAI', 'A-02'],
  ['S-PORT', 'WH-ALX', 'B-01'],
];

/** Who made each customer, by `n % 5`: Bob, Gina, Faris, Alice and an ERP user nobody here is. */
export const MAKERS = ['u102', 'u105', 'u106', 'u101', 'u199'];

const pad = (value, width) => String(value).padStart(width, '0');
const div = (a, b) => Math.floor(a / b);

/** A whole number of cents (or thousandths, `scale` 3) as the decimal string `Query` sends. */
function decimal(units, scale) {
  const negative = units < 0;
  const digits = pad(Math.abs(units), scale + 1);
  return `${negative ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** A date-time on 2026's noon hour: `2026-MM-DDT12:mm:00+02:00`. */
const noon = (month, day, minute) =>
  `2026-${pad(month, 2)}-${pad(day, 2)}T12:${pad(minute, 2)}:00+02:00`;

/**
 * Vendor `n`: its record id is `1000000 + n` (the ERP's `RecId`, the order with no sort), every
 * other value from `n`. `phone` is searched and never sent.
 */
export function largeVendor(n) {
  return {
    recId: String(1_000_000 + n),
    vendorAccount: `VA-${pad(n, 6)}`,
    vendorName: `${NAMES[n % 28]} ${VENDOR_KINDS[div(n, 28) % 6]}`,
    vendorGroup: ['LOCAL', 'IMPORT', 'SERVICES'][n % 3],
    mobile: n % 10 === 0 ? null : `010${pad((n * 7919) % 100_000_000, 8)}`,
    currency: n % 17 === 0 ? null : ['EGP', 'USD', 'EUR'][div(n, 3) % 3],
    payMethod: ['CASH', 'NET30', 'NET60'][div(n, 9) % 3],
    address: n % 4 === 0 ? null : `${(n % 200) + 1} Main St`,
    taxFile: n % 5 === 0 ? pad(n, 9) : null,
    blocked: n % 13 === 0,
    bankAccount: null,
    // The ERP's `DebitLimit` is NOT NULL: a vendor with none is 0.00 (Track E10).
    debitLimit: n % 11 === 0 ? '0.00' : decimal(((n * 37) % 2000) * 5050, 2),
    modifiedBy: 'seed',
    modifiedDate: noon(1 + (n % 12), 1 + (div(n, 12) % 28), div(n, 336) % 60),
    phone: n % 7 === 0 ? `022${pad(n, 7)}` : null,
  };
}

/**
 * Customer `n`: record id `2000000 + n`, account `CA-` and six digits (the order with no sort,
 * the same as the database's collation orders them). `searchName` is searched and never sent.
 */
export function largeCustomer(n) {
  const [governorate, city] = PLACES[n % 6];
  return {
    recId: String(2_000_000 + n),
    customerAccount: `CA-${pad(n, 6)}`,
    customerName: `${NAMES[(n * 5) % 28]} ${CUSTOMER_KINDS[div(n, 28) % 6]}`,
    searchName: n % 6 === 0 ? `alias ${pad(n, 6)}` : null,
    customerGroup: ['RETAIL', 'WHOLESALE', 'EXPORT'][n % 3],
    mobile: n % 10 === 0 ? null : `011${pad((n * 104_729) % 100_000_000, 8)}`,
    mobile2: n % 5 === 0 ? `012${pad(n, 8)}` : null,
    nationalId: n % 2 === 0 ? `2${pad(n * 1013, 13)}` : null,
    currency: n % 19 === 0 ? null : ['EGP', 'USD', 'EUR'][div(n, 3) % 3],
    payMethod: n % 23 === 0 ? null : ['CASH', 'NET30', 'NET60'][div(n, 9) % 3],
    priceList: [null, 'Retail', 'retail', 'Wholesale 2026'][n % 4],
    governorate,
    city: n % 9 === 0 ? null : city,
    address: n % 4 === 0 ? null : `${(n % 200) + 1} Main St`,
    taxFile: n % 7 === 0 ? pad(n * 3, 9) : null,
    creditLimit: n % 10 === 0 ? null : decimal(((n * 53) % 3000) * 3333, 2),
    blocked: n % 20 === 0,
    createdBy: MAKERS[n % 5],
    createdDate: `2025-${pad(1 + (n % 12), 2)}-${pad(1 + (div(n, 12) % 28), 2)}`,
    modifiedBy: ['seed', 'Seed', 'u101'][n % 3],
    modifiedDate: noon(1 + (div(n, 7) % 12), 1 + (n % 28), div(n, 97) % 60),
  };
}

/**
 * Items on hand's record `n`: item `i = floor((n - 1) / 4) + 1` (25,000 items) at storage place
 * `(n - 1) % 4` of `STORAGE`, so `n`'s order is the connector's own. The item's name and group
 * are the item's, on each of its four rows. No record has both its quantity and value at 0.
 */
export function largeStock(n) {
  const i = div(n - 1, 4) + 1;
  const [siteId, warehouseId, locationId] = STORAGE[(n - 1) % 4];
  const milli = (n % 31 === 0 ? -1 : 1) * (((n * 7) % 2000) + 1) * 250;
  return {
    itemId: `IT-${pad(i, 6)}`,
    itemName: `${NAMES[(i * 3) % 28]} ${ITEM_KINDS[div(i, 28) % 6]}`,
    itemGroup: ['FOOD', 'HARDWARE', 'PAPER'][i % 3],
    unit: ['LTR', 'PCS', 'BOX', 'KG'][i % 4],
    siteId,
    warehouseId,
    locationId,
    onHandQty: decimal(milli, 3),
    onHandValue: decimal(milli > 0 ? (milli * (50 + (i % 50))) / 10 : 0, 2),
    searchName: i % 5 === 0 ? `alias ${pad(i, 6)}` : null,
  };
}

/** Every record of the rule, by connector, in `n`'s order. */
export function largeRecords(count = LARGE_COUNT) {
  const out = { vendors: [], customers: [], itemsOnHand: [] };
  for (let n = 1; n <= count; n++) {
    out.vendors.push(largeVendor(n));
    out.customers.push(largeCustomer(n));
    out.itemsOnHand.push(largeStock(n));
  }
  return out;
}
