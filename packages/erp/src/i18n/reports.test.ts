// Phase 12's report words, which the views bring with them: both languages hold the same keys with
// the same placeholders, none taken from the main catalogue, and merged once into an instance.
import { describe, expect, it } from 'vitest';
import { ar } from './ar';
import { en } from './en';
import { createErpI18n } from './index';
import { addReportWords, reportsAr, reportsEn } from './reports';

const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

describe('the report words', () => {
  it('hold the same keys and placeholders in both languages, none of the main catalogue’s', () => {
    expect(Object.keys(reportsAr).sort()).toEqual(Object.keys(reportsEn).sort());
    for (const [key, text] of Object.entries(reportsEn)) {
      const arabic = reportsAr[key as keyof typeof reportsEn];
      expect(text.trim(), key).not.toBe('');
      expect(arabic.trim(), key).not.toBe('');
      expect(placeholders(arabic), key).toEqual(placeholders(text));
      expect(Object.keys(en.erp), key).not.toContain(key);
      expect(Object.keys(ar.erp), key).not.toContain(key);
    }
  });

  it('merge into an instance under erp, beside its words, once', () => {
    const i18n = createErpI18n('ar');
    expect(i18n.t('erp.reports')).toBe('erp.reports');
    addReportWords(i18n);
    addReportWords(i18n);
    expect(i18n.t('erp.reports')).toBe(reportsAr.reports);
    expect(i18n.t('erp.connect')).toBe(ar.erp.connect);
    void i18n.changeLanguage('en');
    expect(i18n.t('erp.total')).toBe('Total');
  });
});
