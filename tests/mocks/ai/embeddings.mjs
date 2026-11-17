// The mock of Voyage AI's embeddings API (Phase 10): deterministic vectors from a small concept
// lexicon, so search by meaning can be tested without the real provider. Each concept is a group of
// English and Arabic words (and their synonyms) that share one dimension; any other word lands on a
// hashed dimension of its own, weighted less; common words are dropped. A vector is the concepts and
// words a text holds, normalised, then quantised to int8 as Voyage's `output_dtype: "int8"` is. So a
// question that shares no word with a page but shares its concepts scores high (about 0.6 to 0.95), in
// English, in Arabic and across the two, and an unrelated page about 0.
//
// The concepts (a word in any of its listed forms; Arabic is compared without diacritics, tatweel,
// the article, a leading و and a pronoun's ending, with أ إ آ as ا, ى as ي and ة as ه):
//   refund      refund, refunds, refunded, reimburse, reimbursed, reimbursement, repay, repayment,
//               استرداد, استرجاع, تعويض, مسترد, يسترد, استرد
//   customer    customer, customers, client, clients, buyer, buyers, shopper, عميل, عملاء, زبون, زبائن, مشتري
//   return      return, returns, returned, إرجاع, ارجاع, مرتجع, مرتجعات
//   money       money, cash, payment, payments, paid, pay, funds, مال, أموال, نقود, دفع, مدفوعات
//   invoice     invoice, invoices, invoiced, bill, bills, billing, فاتورة, فواتير
//   vacation    vacation, vacations, holiday, holidays, leave, إجازة, إجازات, عطلة, عطل
//   employee    employee, employees, staff, worker, workers, personnel, موظف, موظفين, موظفون, عامل, عمال
//   schedule    schedule, schedules, calendar, timetable, agenda, جدول, جداول, مواعيد, تقويم
//   meeting     meeting, meetings, conference, gathering, اجتماع, اجتماعات, لقاء, مؤتمر
//   shipping    shipping, shipment, shipments, delivery, deliveries, courier, شحن, شحنة, توصيل, تسليم
//   warehouse   warehouse, warehouses, storehouse, depot, stockroom, مستودع, مستودعات, مخزن, مخازن
//   inventory   inventory, stock, stocks, supplies, مخزون, بضاعة, بضائع
//   price       price, prices, pricing, cost, costs, tariff, سعر, أسعار, تكلفة, ثمن
//   discount    discount, discounts, rebate, markdown, sale, خصم, خصومات, تخفيض, تخفيضات
//   contract    contract, contracts, agreement, agreements, عقد, عقود, اتفاقية, اتفاقيات
//   password    password, passwords, passcode, credentials, كلمة, مرور, سر
//   security    security, secure, safety, protection, أمان, أمن, حماية
//   tax         tax, taxes, vat, duty, ضريبة, ضرائب
//   salary      salary, salaries, wage, wages, payroll, راتب, رواتب, أجر, أجور
//   hiring      hiring, hire, hired, recruit, recruitment, recruiting, onboarding, توظيف, تعيين
//   complaint   complaint, complaints, grievance, dissatisfied, شكوى, شكاوى
//   travel      travel, trip, trips, journey, flight, flights, سفر, رحلة, رحلات, طيران
//   budget      budget, budgets, forecast, spending, ميزانية, موازنة
//   supplier    supplier, suppliers, vendor, vendors, provider, مورد, موردين, موردون
//   report      report, reports, summary, analysis, تقرير, تقارير, ملخص
//   damage      damage, damaged, broken, defect, defective, faulty, تلف, تالف, معيب, عيب
//   policy      policy, policies, rule, rules, guideline, guidelines, سياسة, سياسات, قواعد
//   food        food, lunch, dinner, meal, meals, cafeteria, طعام, غداء, عشاء, وجبة, وجبات
//   parking     parking, car, cars, garage, موقف, مواقف, سيارة, سيارات
//   training    training, course, courses, workshop, lesson, تدريب, دورة, دورات, ورشة

import { createHash } from 'node:crypto';

export const DIMENSIONS = 1024;
export const MODELS = ['voyage-4', 'voyage-4-large', 'voyage-4-lite'];
/** The weight of a word that is no concept's, on its own hashed dimension. */
const OTHER = 0.35;

const CONCEPTS = [
  [
    'refund',
    'refund refunds refunded reimburse reimbursed reimbursement repay repayment استرداد استرجاع تعويض مسترد يسترد استرد',
  ],
  [
    'customer',
    'customer customers client clients buyer buyers shopper عميل عملاء زبون زبائن مشتري',
  ],
  ['return', 'return returns returned إرجاع ارجاع مرتجع مرتجعات'],
  ['money', 'money cash payment payments paid pay funds مال أموال نقود دفع مدفوعات'],
  ['invoice', 'invoice invoices invoiced bill bills billing فاتورة فواتير'],
  ['vacation', 'vacation vacations holiday holidays leave إجازة إجازات عطلة عطل'],
  ['employee', 'employee employees staff worker workers personnel موظف موظفين موظفون عامل عمال'],
  ['schedule', 'schedule schedules calendar timetable agenda جدول جداول مواعيد تقويم'],
  ['meeting', 'meeting meetings conference gathering اجتماع اجتماعات لقاء مؤتمر'],
  ['shipping', 'shipping shipment shipments delivery deliveries courier شحن شحنة توصيل تسليم'],
  ['warehouse', 'warehouse warehouses storehouse depot stockroom مستودع مستودعات مخزن مخازن'],
  ['inventory', 'inventory stock stocks supplies مخزون بضاعة بضائع'],
  ['price', 'price prices pricing cost costs tariff سعر أسعار تكلفة ثمن'],
  ['discount', 'discount discounts rebate markdown sale خصم خصومات تخفيض تخفيضات'],
  ['contract', 'contract contracts agreement agreements عقد عقود اتفاقية اتفاقيات'],
  ['password', 'password passwords passcode credentials كلمة مرور سر'],
  ['security', 'security secure safety protection أمان أمن حماية'],
  ['tax', 'tax taxes vat duty ضريبة ضرائب'],
  ['salary', 'salary salaries wage wages payroll راتب رواتب أجر أجور'],
  ['hiring', 'hiring hire hired recruit recruitment recruiting onboarding توظيف تعيين'],
  ['complaint', 'complaint complaints grievance dissatisfied شكوى شكاوى'],
  ['travel', 'travel trip trips journey flight flights سفر رحلة رحلات طيران'],
  ['budget', 'budget budgets forecast spending ميزانية موازنة'],
  ['supplier', 'supplier suppliers vendor vendors provider مورد موردين موردون'],
  ['report', 'report reports summary analysis تقرير تقارير ملخص'],
  ['damage', 'damage damaged broken defect defective faulty تلف تالف معيب عيب'],
  ['policy', 'policy policies rule rules guideline guidelines سياسة سياسات قواعد'],
  ['food', 'food lunch dinner meal meals cafeteria طعام غداء عشاء وجبة وجبات'],
  ['parking', 'parking car cars garage موقف مواقف سيارة سيارات'],
  ['training', 'training course courses workshop lesson تدريب دورة دورات ورشة'],
];

const STOP = new Set(
  (
    'a an the and or of to in on at for from by with without is are was were be been being do does did ' +
    'how what when where who whom which why can could should would may might must will shall i me my we ' +
    'our you your he she it its they them their this that these those there here as if then than so not ' +
    'no yes any some all each get got about into over under after before again more most very just also ' +
    'في من على إلى الى عن مع هل ما ماذا متى أين اين كيف لماذا هذا هذه ذلك تلك التي الذي هو هي هم نحن أنا ' +
    'انا أنت انت كل بعض أو او ثم لا نعم قد كان كانت يكون عند بعد قبل حتى إذا اذا لكن'
  )
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => normalise(w)),
);

/** A word as compared: lower case; Arabic without marks, the article or a leading و; English stemmed lightly. */
export function normalise(word) {
  let w = word.toLowerCase().normalize('NFKC');
  if (/\p{Script=Arabic}/u.test(w)) {
    w = w
      .replace(/[\u064B-\u065F\u0670\u0640]/gu, '')
      .replace(/[\u0622\u0623\u0625\u0671]/gu, '\u0627')
      .replace(/\u0649/gu, '\u064A')
      .replace(/\u0629/gu, '\u0647')
      .replace(/\u0624/gu, '\u0648')
      .replace(/\u0626/gu, '\u064A');
    if (w.length > 3 && w.startsWith('\u0648')) w = w.slice(1);
    for (const prefix of [
      '\u0628\u0627\u0644',
      '\u0644\u0644',
      '\u0643\u0627\u0644',
      '\u0641\u0627\u0644',
      '\u0627\u0644',
    ])
      if (w.length > prefix.length + 2 && w.startsWith(prefix)) {
        w = w.slice(prefix.length);
        break;
      }
    // A pronoun's ending (ها, هم, كم, نا, ه): the word without it.
    for (const suffix of ['هم', 'كم', 'نا', 'ها', 'ه'])
      if (w.length > suffix.length + 2 && w.endsWith(suffix)) {
        w = w.slice(0, -suffix.length);
        break;
      }
    return w;
  }
  w = w.replace(/'s$/, '');
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

const LEXICON = new Map();
CONCEPTS.forEach(([, words], index) => {
  for (const word of words.split(/\s+/)) LEXICON.set(normalise(word), index);
});

/** The concept a word belongs to (its dimension), or null. */
export function conceptOf(word) {
  const index = LEXICON.get(normalise(word));
  return index === undefined ? null : CONCEPTS[index][0];
}

function hashed(word) {
  const digest = createHash('sha256').update(word).digest();
  return 256 + (digest.readUInt32BE(0) % (DIMENSIONS - 256));
}

/** A text's vector as floats (normalised), before quantisation. */
export function embedFloat(text) {
  const vector = new Float64Array(DIMENSIONS);
  const words = String(text).match(/[\p{L}\p{N}']+/gu) ?? [];
  for (const raw of words) {
    const word = normalise(raw);
    if (word.length === 0 || STOP.has(word)) continue;
    const concept = LEXICON.get(word);
    if (concept !== undefined) vector[concept] = 1;
    else vector[hashed(word)] = Math.max(vector[hashed(word)], OTHER);
  }
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIMENSIONS; i++) vector[i] /= norm;
  return vector;
}

/** The vector as Voyage gives an int8 one: each value times 127, rounded, within -128..127. */
export function embedInt8(text) {
  return Array.from(embedFloat(text), (v) => Math.max(-128, Math.min(127, Math.round(v * 127))));
}

/** Cosine similarity of two texts' quantised vectors, as the server scores them (for tests). */
export function similarity(a, b) {
  const x = embedInt8(a);
  const y = embedInt8(b);
  let dot = 0;
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < DIMENSIONS; i++) {
    dot += x[i] * y[i];
    nx += x[i] * x[i];
    ny += y[i] * y[i];
  }
  return nx === 0 || ny === 0 ? 0 : dot / Math.sqrt(nx * ny);
}

/** Voyage counts tokens; the mock, a quarter of the characters. */
export const tokensOf = (text) => Math.max(1, Math.ceil(String(text).length / 4));
