// Settings → Offline's words for the rows' documents a pinned database holds (Phase 12, M12.4): a
// section of the catalogue loaded with Settings, not with the app (`i18n/sections.ts`);
// `OfflineSettings` adds it before it draws. The numbers come formatted for the language.
import { section, type Strings } from '../i18n/sections';

export const offlineRowsEn = {
  progress:
    '{{held}} of {{total}} row pages in the databases kept offline are on this device; {{toFetch}} still to fetch.',
  progressDone: 'All {{total}} row pages in the databases kept offline are on this device.',
};

const offlineRowsAr: Strings<typeof offlineRowsEn> = {
  progress:
    '{{held}} من {{total}} من صفحات الصفوف في قواعد البيانات المتاحة دون اتصال على هذا الجهاز، وبقي {{toFetch}} للجلب.',
  progressDone: 'كل صفحات الصفوف في قواعد البيانات المتاحة دون اتصال ({{total}}) على هذا الجهاز.',
};

export const offlineRowsWords = section('offlineRows', offlineRowsEn, offlineRowsAr);
