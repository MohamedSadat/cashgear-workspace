// The table's Arabic words for a screen reader (Phase 12): the same keys as `grid-en.ts`; its type
// checks them. Merged with them the first time a table draws (`table/words.ts`).
import type { gridEn } from './grid-en';

type Strings<T> = { readonly [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };

export const gridAr: Strings<typeof gridEn> = {
  editing: 'تحرير: {{property}}، {{title}}.',
  saved: 'حُفظ: {{property}}، {{title}}.',
  cancelled: 'أُلغي التحرير: {{property}}، {{title}}.',
  newRow: 'صف جديد: اضغط Enter لإضافة صف.',
  newRowIn: 'صف جديد في {{name}}: اضغط Enter لإضافة صف.',
};
