// Phase 19: a page that holds every block, inline node and mark of schema version 6, in English or
// in Arabic, with what the shell would resolve for its blocks that are not text. The Word writer's
// round trip, the print view's tests and the writer's vectors (the server's validator) all read it.
// Its ids are fixed, so what is written from it is the same every time.
import type { PageLayout } from '@cgw/workspace/layout';
import type { DocJSON } from '../binding';
import type { OutInput, OutPage } from './model';

/** A 2×1 PNG (red, blue), as a sheet's picture or an image would be. */
export const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGO4Y2NjE3UCAAl7ArMrgipBAAAAAElFTkSuQmCC',
  ),
  (c) => c.charCodeAt(0),
);

export const IDS = {
  image: '01936f6e-0000-7000-8000-00000000a001',
  missing: '01936f6e-0000-7000-8000-00000000a002',
  file: '01936f6e-0000-7000-8000-00000000a003',
  picture: '01936f6e-0000-7000-8000-00000000a004',
  chart: '01936f6e-0000-7000-8000-00000000a005',
  page: '01936f6e-0000-7000-8000-00000000b001',
  child: '01936f6e-0000-7000-8000-00000000b002',
  linked: '01936f6e-0000-7000-8000-00000000b003',
  sub: '01936f6e-0000-7000-8000-00000000b004',
  person: '01936f6e-0000-7000-8000-00000000c001',
} as const;

type Language = 'en' | 'ar';

const WORDS: Record<Language, Record<string, string>> = {
  en: {
    title: 'Quarterly report',
    h1: 'Heading one',
    h2: 'Heading two',
    h3: 'Heading three',
    plain: 'Plain ',
    bold: 'bold',
    italic: 'italic',
    underline: 'underline',
    strike: 'struck',
    code: 'code',
    link: 'a link',
    red: 'red text',
    yellow: 'yellow',
    orange: 'orange',
    see: 'See ',
    on: ' on ',
    by: ' by ',
    nextLine: 'next line',
    a: 'Apples',
    a1: 'Green apples',
    a1a: 'Small ones',
    b: 'Bananas',
    n1: 'Third step',
    n2: 'Fourth step',
    nx: 'A step within',
    n3: 'Fifth step',
    done: 'Done already',
    open: 'Still open',
    inner: 'An item under it',
    quote: 'A quotation that stands apart.',
    callout: 'Mind the step.',
    toggle: 'More, folded',
    insideToggle: 'Inside the toggle.',
    under: 'A paragraph under a paragraph.',
    cellA: 'Region',
    cellB: 'Sales',
    cellC: 'North and South',
    cellD: '120',
    cellE: 'East',
    caption: 'A small picture',
    alt: 'Two squares',
    file: 'Budget.xlsx',
    unknown: 'Text of a block from a later build',
    lastLine: 'The last line.',
    subTitle: 'Notes, a sub-page',
    subText: 'The sub-page’s own text.',
  },
  ar: {
    title: 'تقرير الربع',
    h1: 'العنوان الأول',
    h2: 'العنوان الثاني',
    h3: 'العنوان الثالث',
    plain: 'نص عادي ',
    bold: 'عريض',
    italic: 'مائل',
    underline: 'مسطر',
    strike: 'مشطوب',
    code: 'code',
    link: 'رابط',
    red: 'نص أحمر',
    yellow: 'أصفر',
    orange: 'برتقالي',
    see: 'انظر ',
    on: ' في ',
    by: ' من ',
    nextLine: 'السطر التالي',
    a: 'تفاح',
    a1: 'تفاح أخضر',
    a1a: 'الصغير منه',
    b: 'موز',
    n1: 'الخطوة الثالثة',
    n2: 'الخطوة الرابعة',
    nx: 'خطوة داخلها',
    n3: 'الخطوة الخامسة',
    done: 'تم بالفعل',
    open: 'ما زال مفتوحا',
    inner: 'بند تحته',
    quote: 'اقتباس قائم بذاته.',
    callout: 'انتبه للدرجة.',
    toggle: 'المزيد، مطوي',
    insideToggle: 'داخل القائمة المطوية.',
    under: 'فقرة تحت فقرة.',
    cellA: 'المنطقة',
    cellB: 'المبيعات',
    cellC: 'الشمال والجنوب',
    cellD: '120',
    cellE: 'الشرق',
    caption: 'صورة صغيرة',
    alt: 'مربعان',
    file: 'الميزانية.xlsx',
    unknown: 'نص كتلة من إصدار لاحق',
    lastLine: 'السطر الأخير.',
    subTitle: 'ملاحظات، صفحة فرعية',
    subText: 'نص الصفحة الفرعية.',
  },
};

let blockCount = 0;
const id = (n: number) => `blk${String(n).padStart(9, '0')}`;
const t = (text: string, ...marks: DocJSON['marks'][]): DocJSON => ({
  type: 'text',
  text,
  ...(marks.length ? { marks: marks.flat() as DocJSON['marks'] } : {}),
});
const m = (type: string, attrs?: Record<string, unknown>) => [
  { type, ...(attrs ? { attrs } : {}) },
];
const body = (kind: string, content: DocJSON[], attrs: Record<string, unknown> = {}): DocJSON => ({
  type: 'textBody',
  attrs: { kind, ...attrs },
  ...(content.length ? { content } : {}),
});
const block = (b: DocJSON, children: DocJSON[] = []): DocJSON => ({
  type: 'block',
  attrs: { id: id(++blockCount) },
  content: [b, ...children],
});

/** The page with every block, as a document's JSON (block ids fixed). */
export function everyBlockContent(language: Language): DocJSON {
  blockCount = language === 'en' ? 0 : 500;
  const w = WORDS[language];
  const rtl = language === 'ar';
  return {
    type: 'doc',
    content: [
      block(body('heading', [t(w.h1)], { level: 1 })),
      block({ type: 'tableOfContents' }),
      block(
        body('paragraph', [
          t(w.plain),
          t(w.bold, m('bold')),
          t(' '),
          t(w.italic, m('italic')),
          t(' '),
          t(w.underline, m('underline')),
          t(' '),
          t(w.strike, m('strike')),
          t(' '),
          t(w.code, m('code')),
          t(' '),
          t(w.link, m('link', { href: 'https://example.com/a?b=1&c=2' })),
          t(' '),
          t(w.red, m('textColour', { token: 'red' })),
          t(' '),
          t(w.yellow, m('highlight', { token: 'yellow' })),
          t(' '),
          t(w.orange, m('highlight', { token: 'orange' })),
        ]),
      ),
      block(
        body('paragraph', [
          t(w.see),
          { type: 'pageMention', attrs: { pageId: IDS.linked, blockId: null } },
          t(w.on),
          { type: 'dateMention', attrs: { date: '2026-11-26', end: null } },
          t(w.by),
          { type: 'userMention', attrs: { userId: IDS.person } },
          { type: 'hardBreak' },
          t(w.nextLine),
        ]),
      ),
      block(body('heading', [t(w.h2)], { level: 2 })),
      block(body('bulletItem', [t(w.a)]), [
        block(body('bulletItem', [t(w.a1)]), [block(body('bulletItem', [t(w.a1a)]))]),
      ]),
      block(body('bulletItem', [t(w.b)])),
      block(body('numberedItem', [t(w.n1)], { start: 3 })),
      block(body('numberedItem', [t(w.n2)]), [block(body('numberedItem', [t(w.nx)]))]),
      block(body('numberedItem', [t(w.n3)])),
      block(body('checkItem', [t(w.done)], { checked: true })),
      block(body('checkItem', [t(w.open)], { checked: false }), [
        block(body('checkItem', [t(w.inner)], { checked: false })),
      ]),
      block(body('heading', [t(w.h3)], { level: 3 })),
      block(body('quote', [t(w.quote)])),
      block(body('callout', [t(w.callout)], { icon: '💡', tone: 'warning' })),
      block(body('toggle', [t(w.toggle)]), [block(body('paragraph', [t(w.insideToggle)]))]),
      block(body('paragraph', [t(w.under)]), [block(body('paragraph', [t(w.under)]))]),
      block({
        type: 'codeBlock',
        attrs: { language: 'ts', wrap: false },
        content: [t('const a = 1;\n\n\tconst b = a + 2; // <ok> & "done"')],
      }),
      block({ type: 'divider' }),
      block({
        type: 'table',
        attrs: { headerRow: true, headerColumn: false },
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                attrs: { colspan: 1, rowspan: 1, colwidth: [140] },
                content: [t(w.cellA)],
              },
              {
                type: 'tableCell',
                attrs: { colspan: 1, rowspan: 1, colwidth: [100] },
                content: [t(w.cellB)],
              },
            ],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                attrs: { colspan: 1, rowspan: 2 },
                content: [t(w.cellC, m('bold'))],
              },
              { type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [t(w.cellD)] },
            ],
          },
          {
            type: 'tableRow',
            content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [t('80')] }],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                attrs: { colspan: 2, rowspan: 1, dir: rtl ? 'rtl' : null },
                content: [t(w.cellE)],
              },
            ],
          },
        ],
      }),
      block({
        type: 'image',
        attrs: { assetId: IDS.image, width: 240, align: 'center', alt: w.alt, caption: w.caption },
      }),
      block({
        type: 'image',
        attrs: { assetId: IDS.missing, width: null, align: null, alt: null, caption: null },
      }),
      block({ type: 'file', attrs: { assetId: IDS.file } }),
      block({ type: 'bookmark', attrs: { url: 'https://example.com/bookmark' } }),
      block({ type: 'childPage', attrs: { pageId: IDS.child } }),
      block({ type: 'databaseView', attrs: { databaseId: IDS.page, viewId: null } }),
      block({
        type: 'sheetEmbed',
        attrs: {
          workbookId: IDS.picture,
          sheet: null,
          range: 'A1:B2',
          chartId: null,
          height: null,
        },
      }),
      block({ type: 'erpView', attrs: { linkId: null, connectorId: 'vendors' } }),
      block({ type: 'pluginBlock', attrs: { type: 'cashgear.chart', version: 1, props: '{}' } }),
      block({ type: 'pluginBlock', attrs: { type: 'cashgear.kanban', version: 1, props: '{}' } }),
      block({ type: 'futureBlock', content: [t(w.unknown)] }),
      block(body('paragraph', [t('English, set left to right.')], { dir: 'ltr' })),
      block(body('paragraph', [t('يكتب هذا السطر من اليمين إلى اليسار.')])),
      block(body('paragraph', [t(w.lastLine)])),
    ],
  };
}

/** The ids of the blocks the shell resolved (their places in `everyBlockContent`). */
function resolvedIds(content: DocJSON) {
  const of = (type: string, n = 0) =>
    content.content!.filter((b) => b.content?.[0]?.type === type)[n]?.attrs?.id as string;
  return {
    database: of('databaseView'),
    sheet: of('sheetEmbed'),
    erp: of('erpView'),
    chart: of('pluginBlock', 0),
    kanban: of('pluginBlock', 1),
  };
}

export const LAYOUT: PageLayout = {
  size: 'a4',
  orientation: 'portrait',
  margins: 'normal',
  header: { start: '{title}', center: '', end: '{date}' },
  footer: { start: '', center: '{page} / {pages}', end: '' },
};

/** The whole input: the page, a sub-page, a row's properties, what the shell resolved. */
export function everyBlockInput(language: Language, layout: PageLayout = LAYOUT): OutInput {
  const w = WORDS[language];
  const content = everyBlockContent(language);
  const ids = resolvedIds(content);
  const ar = language === 'ar';
  const page: OutPage = {
    id: IDS.page,
    title: w.title,
    icon: '📊',
    content,
    properties: [
      { name: ar ? 'الحالة' : 'Status', text: ar ? 'قيد العمل' : 'In progress' },
      { name: ar ? 'الموعد' : 'Due', text: '2026-12-01' },
    ],
    blocks: {
      [ids.database]: {
        kind: 'table',
        title: ar ? 'المهام' : 'Tasks',
        columns: ar ? ['المهمة', 'الحالة'] : ['Task', 'Status'],
        rows: ar
          ? [
              ['كتابة التقرير', 'قيد العمل'],
              ['المراجعة', 'قيد العمل'],
              ['الإرسال', 'تم'],
            ]
          : [
              ['Write the report', 'In progress'],
              ['Review it', 'In progress'],
              ['Send it', 'Done'],
            ],
        groups: [
          { name: ar ? 'قيد العمل' : 'In progress', at: 0, count: 2 },
          { name: ar ? 'تم' : 'Done', at: 2, count: 1 },
        ],
        more: 997,
        moreText: ar ? 'و997 صفوف أخرى' : 'And 997 more rows',
      },
      [ids.sheet]: { kind: 'picture', title: ar ? 'الميزانية' : 'Budget', image: IDS.picture },
      [ids.erp]: {
        kind: 'placeholder',
        text: ar
          ? 'Cash Gear ERP: الموردون (بياناته لا تصدر)'
          : 'Cash Gear ERP: Vendors (its data is not exported)',
      },
      [ids.chart]: {
        kind: 'chart',
        title: ar ? 'المهام حسب الحالة' : 'Tasks by status',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="#337EA9"/></svg>',
        image: IDS.chart,
      },
      [ids.kanban]: { kind: 'text', text: ar ? 'لوحة: المهام' : 'Board: Tasks' },
    },
  };
  const sub: OutPage = {
    id: IDS.sub,
    title: w.subTitle,
    icon: null,
    content: { type: 'doc', content: [block(body('paragraph', [t(w.subText)]))] },
    blocks: {},
  };
  const png = { contentType: 'image/png', width: 2, height: 1, bytes: PNG, url: 'blob:picture' };
  return {
    language,
    locale: ar ? 'ar' : 'en-GB',
    date: ar ? '٢٦ نوفمبر ٢٠٢٦' : '26 Nov 2026',
    madeAt: '2026-11-26T10:00:00.000Z',
    layout,
    pages: [page, sub],
    assets: {
      [IDS.image]: { fileName: 'squares.png', ...png },
      [IDS.file]: {
        fileName: w.file,
        contentType: 'application/vnd.ms-excel',
        width: null,
        height: null,
      },
      [IDS.picture]: { fileName: 'budget.png', ...png },
      [IDS.chart]: { fileName: 'chart.png', ...png },
    },
    links: {
      [IDS.linked]: {
        title: ar ? 'خطة السنة' : 'The year’s plan',
        icon: '🗓️',
        href: `https://workspace.example/#/p/${IDS.linked}`,
      },
      [IDS.child]: {
        title: ar ? 'صفحة فرعية' : 'A child page',
        icon: null,
        href: `https://workspace.example/#/p/${IDS.child}`,
      },
    },
    people: { [IDS.person]: ar ? 'سارة' : 'Sara' },
    words: ar
      ? {
          untitled: 'بلا عنوان',
          aPage: 'صفحة',
          someone: 'شخص ما',
          missingFile: 'ملف ليس على هذا الجهاز',
          missingImage: 'صورة ليست على هذا الجهاز',
          noHeadings: 'لا عناوين في هذه الصفحة',
          unknownBlock: 'كتلة لا يعرفها هذا الإصدار',
          contents: 'المحتويات',
        }
      : {
          untitled: 'Untitled',
          aPage: 'A page',
          someone: 'someone',
          missingFile: 'A file not on this device',
          missingImage: 'An image not on this device',
          noHeadings: 'No headings on this page',
          unknownBlock: 'A block this version does not know',
          contents: 'Contents',
        },
  };
}

export const FIXTURE_WORDS = WORDS;
