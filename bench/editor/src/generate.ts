// The document generator for spikes S5 and S6 (and later bench/): Arabic, English or mixed text,
// a mix of block kinds, any size. Output is ProseMirror JSON for the `kind` schema.
import type { JSONContent } from '@tiptap/core';
import { seeded, type Random } from './commands';

export type Language = 'en' | 'ar' | 'mixed';

const ENGLISH =
  'the quarterly report shows revenue growth across every region while costs stayed flat and the team shipped three releases on time'.split(
    ' ',
  );
const ARABIC =
  'يظهر التقرير الربعي نمو الإيرادات في جميع المناطق بينما بقيت التكاليف ثابتة وأصدر الفريق ثلاثة إصدارات في موعدها'.split(
    ' ',
  );
const ENGLISH_IN_ARABIC = ['Cash Gear', 'ERP', 'Q4', 'PDF', 'invoice #1042', 'API'];

function sentence(random: Random, language: Language, words: number): string {
  const out: string[] = [];
  const arabic = language === 'ar' || (language === 'mixed' && random() < 0.5);
  for (let i = 0; i < words; i++) {
    if (arabic && language === 'mixed' && random() < 0.12)
      out.push(ENGLISH_IN_ARABIC[Math.floor(random() * ENGLISH_IN_ARABIC.length)]);
    else {
      const list = arabic ? ARABIC : ENGLISH;
      out.push(list[Math.floor(random() * list.length)]);
    }
  }
  return out.join(' ') + (arabic ? '.' : '.');
}

let counter = 0;
const id = () => `g${String(counter++).padStart(11, '0')}`;

function text(random: Random, language: Language, kind: string, words: number): JSONContent {
  const value = sentence(random, language, words);
  const marked = random() < 0.25;
  const split = Math.floor(value.length / 3);
  const content: JSONContent[] = marked
    ? [
        { type: 'text', text: value.slice(0, split) },
        { type: 'text', text: value.slice(split, split * 2), marks: [{ type: 'bold' }] },
        { type: 'text', text: value.slice(split * 2) },
      ]
    : [{ type: 'text', text: value }];
  const attrs: Record<string, unknown> = { kind };
  if (kind === 'heading') attrs.level = 1 + Math.floor(random() * 3);
  if (kind === 'checkItem') attrs.checked = random() < 0.3;
  return { type: 'textBody', attrs, content };
}

function block(body: JSONContent, children: JSONContent[] = []): JSONContent {
  return { type: 'block', attrs: { id: id() }, content: [body, ...children] };
}

/** `count` top-level blocks: mostly paragraphs, some headings, lists, checklists, quotes, code. */
export function generateBlocks(count: number, language: Language, seed = 1): JSONContent {
  const random = seeded(seed);
  counter = 0;
  const blocks: JSONContent[] = [];
  for (let i = 0; i < count; i++) {
    const roll = random();
    if (roll < 0.55)
      blocks.push(block(text(random, language, 'paragraph', 12 + Math.floor(random() * 30))));
    else if (roll < 0.63)
      blocks.push(block(text(random, language, 'heading', 3 + Math.floor(random() * 5))));
    else if (roll < 0.78) {
      const kind = random() < 0.5 ? 'bulletItem' : 'numberedItem';
      // A list item with a nested item, as lists nest in this schema.
      const child = random() < 0.3 ? [block(text(random, language, kind, 6))] : [];
      blocks.push(block(text(random, language, kind, 6 + Math.floor(random() * 10)), child));
    } else if (roll < 0.86)
      blocks.push(block(text(random, language, 'checkItem', 5 + Math.floor(random() * 8))));
    else if (roll < 0.92)
      blocks.push(block(text(random, language, 'quote', 10 + Math.floor(random() * 20))));
    else if (roll < 0.96)
      blocks.push(
        block({
          type: 'codeBlock',
          attrs: { language: 'sql' },
          content: [{ type: 'text', text: 'select id, total from invoices where total > 100;' }],
        }),
      );
    else blocks.push(block({ type: 'divider' }));
  }
  return { type: 'doc', content: blocks };
}

/** The fixed document spike S5's checklist runs on. */
export function rtlChecklistDoc(): JSONContent {
  counter = 0;
  const t = (kind: string, value: string, attrs: Record<string, unknown> = {}): JSONContent => ({
    type: 'textBody',
    attrs: { kind, ...attrs },
    content: value ? [{ type: 'text', text: value }] : [],
  });
  const cell = (value: string): JSONContent => ({
    type: 'tableCell',
    content: [{ type: 'text', text: value }],
  });
  return {
    type: 'doc',
    content: [
      block(t('heading', 'تقرير المبيعات الربعي', { level: 1 })),
      block(t('paragraph', 'هذه فقرة عربية كاملة تصف نتائج الربع الأخير.')),
      block(t('paragraph', 'This paragraph is English and should run left to right.')),
      block(t('paragraph', 'فقرة مختلطة تذكر Cash Gear ERP ورقم الفاتورة 1042 في وسطها.')),
      block(t('bulletItem', 'البند الأول في القائمة'), [block(t('bulletItem', 'بند فرعي متداخل'))]),
      block(t('bulletItem', 'البند الثاني')),
      block(t('numberedItem', 'الخطوة الأولى')),
      block(t('numberedItem', 'الخطوة الثانية')),
      block(t('checkItem', 'مهمة لم تنته بعد', { checked: false })),
      block({
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('العميل'), cell('المبلغ'), cell('الحالة')] },
          { type: 'tableRow', content: [cell('شركة النور'), cell('1500'), cell('مدفوع')] },
        ],
      }),
      block(t('paragraph', 'ثم فقرة عربية أخيرة للتحقق من حركة المؤشر.')),
      block(t('paragraph', '')),
    ],
  };
}
