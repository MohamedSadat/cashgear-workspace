// The Arabic of `tasks-en.ts` (Phase 17): exactly the same keys.
import type { tasksEn } from './tasks-en';

type Strings<T> = { readonly [K in keyof T]: string };

export const tasksAr: Strings<typeof tasksEn> = {
  title: 'المهام',
  subItems: 'المهام الفرعية',
  subItemsHelp: 'يُدرج الجدول المهام الفرعية لكل صف تحته، حتى خمسة مستويات.',
  dependencies: 'الاعتماديات',
  dependenciesHelp: 'يرسم المخطط الزمني سهمًا من كل صف إلى الصفوف التي يعيقها.',
  by: 'حسب',
  off: 'إيقاف',
  newSubItems: 'جديد: الأصل والمهام الفرعية',
  newDependencies: 'جديد: معاق بواسطة ويعيق',
  parent: 'الأصل',
  children: 'المهام الفرعية',
  blockedBy: 'معاق بواسطة',
  blocking: 'يعيق',
  pair: '{{name}} و{{reverse}}',
  shift: 'نقل تواريخ صف ينقل الصفوف التي يعيقها بالعدد نفسه من الأيام',
  expand: 'إظهار المهام الفرعية لـ{{title}}',
  collapse: 'إخفاء المهام الفرعية لـ{{title}}',
  count: 'المهام الفرعية: {{number}}',
  context: 'ظاهر لأجل مهمة فرعية مطابقة',
  moved: 'نُقلت الصفوف التي يعيقها أيضًا: {{number}}.',
};
