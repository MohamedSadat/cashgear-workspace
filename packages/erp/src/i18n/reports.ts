import type { i18n } from 'i18next';
import { useTranslation } from 'react-i18next';

// Phase 12's words for reports in an ERP block, which the views bring with them (`@cgw/erp/view`,
// loaded with the first ERP block) and merge into the app's instance under `erp` when they first
// draw: the shell's catalogues, which `@cgw/erp/i18n` feeds, are in the initial JavaScript and
// hold none of these (Phase 1's 350 kB budget). Read through `useErpT` like the others, once
// `useReportWords` has run above the reader. Arabic in the style of `ar.ts`.

export const reportsEn = {
  lists: 'Lists',
  reports: 'Reports',
  reportTag: 'Report',
  reportSettings: 'Report settings',
  parameterAll: 'All',
  parameterNotSet: 'Not set',
  parameterChoose: 'Choose…',
  defaultToday: 'Today',
  defaultMonthStart: 'Start of this month',
  parameterNeeded: 'Choose “{{name}}” to see this report.',
  total: 'Total',
  partial: 'Cash Gear ERP stopped this report at a limit of its own, so it is not complete.',
  firstOf:
    'Only the first {{max}} of {{total}} records can be shown here. Narrow the filter to see the others.',
  dateInvalid: 'Not a date this report takes.',
  dateRange: 'Choose a date from 1900 to 9999.',
  dateCalendar: 'Choose a date',
  dateOpen: 'Open the calendar',
  dateClear: 'Clear the date',
  datePrevious: 'Previous month',
  dateNext: 'Next month',
  dateMonthYear: 'Choose the month and year',
  dateYear: 'Choose the year',
  dateToday: 'Today',
  dateClearButton: 'Clear',
  dateSelected: 'Chosen',
  dateUnavailable: 'Not available',
};

export type ReportKey = keyof typeof reportsEn;

export const reportsAr: { readonly [K in ReportKey]: string } = {
  lists: 'القوائم',
  reports: 'التقارير',
  reportTag: 'تقرير',
  reportSettings: 'إعدادات التقرير',
  parameterAll: 'الكل',
  parameterNotSet: 'غير محدد',
  parameterChoose: 'اختر…',
  defaultToday: 'اليوم',
  defaultMonthStart: 'بداية هذا الشهر',
  parameterNeeded: 'اختر «{{name}}» لترى هذا التقرير.',
  total: 'الإجمالي',
  partial: 'أوقف نظام كاش جير هذا التقرير عند حد من حدوده، فهو غير مكتمل.',
  firstOf: 'يُعرض هنا أول {{max}} سجل فقط من {{total}}. ضيّق التصفية لترى البقية.',
  dateInvalid: 'ليس تاريخًا يقبله هذا التقرير.',
  dateRange: 'اختر تاريخًا من 1900 إلى 9999.',
  dateCalendar: 'اختيار تاريخ',
  dateOpen: 'فتح التقويم',
  dateClear: 'مسح التاريخ',
  datePrevious: 'الشهر السابق',
  dateNext: 'الشهر التالي',
  dateMonthYear: 'اختيار الشهر والسنة',
  dateYear: 'اختيار السنة',
  dateToday: 'اليوم',
  dateClearButton: 'مسح',
  dateSelected: 'مختار',
  dateUnavailable: 'غير متاح',
};

const added = new WeakSet<i18n>();

/** Merges the words into the instance under `erp`, once; later calls do nothing. */
export function addReportWords(instance: i18n): void {
  if (added.has(instance)) return;
  added.add(instance);
  instance.addResourceBundle('en', 'translation', { erp: reportsEn }, true, false);
  instance.addResourceBundle('ar', 'translation', { erp: reportsAr }, true, false);
}

/** The words in the app's instance before this render reads them (synchronous, idempotent). */
export function useReportWords(): void {
  const { i18n } = useTranslation();
  addReportWords(i18n);
}
